#!/usr/bin/env python3
"""Read Sina printer notifications over IMAP without modifying mailbox state."""

from __future__ import annotations

import argparse
import getpass
import imaplib
import json
import os
import re
import ssl
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from email import policy
from email.header import decode_header, make_header
from email.message import Message
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_ENV = Path(os.environ.get("PRINTER_ENV_FILE", PROJECT_ROOT / "config/mail.env"))
DEFAULT_TIMEZONE = "Asia/Shanghai"
FETCH_BATCH_SIZE = 20
MAX_MESSAGE_BYTES = 512 * 1024


class TextExtractor(HTMLParser):
    """Convert simple notification HTML into readable text."""

    BLOCK_TAGS = {"br", "div", "p", "li", "tr", "table", "h1", "h2", "h3"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\xa0", " ")
        lines = [re.sub(r"[ \t]+", " ", line).strip() for line in value.splitlines()]
        return "\n".join(line for line in lines if line)


@dataclass(frozen=True)
class MailRecord:
    uid: str
    subject: str
    sender: str
    recipient: str
    message_date: str
    internal_date: str
    text: str


@dataclass(frozen=True)
class PrinterState:
    uid: str
    timestamp: str
    model: str
    serial: str
    consumables: str | None
    service_parts: str | None
    fault: str | None
    billing_meter: str | None


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key] = value
    return values


def decode_text(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except (LookupError, UnicodeDecodeError):
        return value


def imap_host(username: str, configured_url: str) -> str:
    domain = username.rsplit("@", 1)[-1].lower()
    hosts = {
        "sina.com": "imap.sina.com",
        "sina.cn": "imap.sina.cn",
        "vip.sina.com": "imap.vip.sina.com",
        "vip.sina.cn": "imap.vip.sina.cn",
    }
    if domain in hosts:
        return hosts[domain]

    parsed = urlparse(configured_url if "://" in configured_url else f"//{configured_url}")
    host = parsed.hostname or configured_url.split("/", 1)[0]
    if host.startswith("imap."):
        return host
    raise ValueError(f"Cannot derive Sina IMAP server for account domain {domain!r}")


def message_text(message: Message) -> str:
    plain_parts: list[str] = []
    html_parts: list[str] = []
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_disposition() == "attachment":
            continue
        content_type = part.get_content_type()
        if content_type not in {"text/plain", "text/html"}:
            continue
        try:
            content = part.get_content()
        except (LookupError, UnicodeDecodeError):
            payload = part.get_payload(decode=True) or b""
            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        if not isinstance(content, str):
            continue
        if content_type == "text/plain":
            plain_parts.append(content)
        else:
            html_parts.append(content)

    text = "\n".join(plain_parts).strip()
    if text:
        return re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n"))
    parser = TextExtractor()
    parser.feed("\n".join(html_parts))
    return parser.text()


def parse_internal_date(fetch_metadata: bytes) -> datetime | None:
    match = re.search(rb'INTERNALDATE "([^"]+)"', fetch_metadata)
    if not match:
        return None
    try:
        return datetime.strptime(match.group(1).decode("ascii"), "%d-%b-%Y %H:%M:%S %z")
    except ValueError:
        return None


def parse_header_date(message: Message) -> datetime | None:
    value = message.get("Date")
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=ZoneInfo(DEFAULT_TIMEZONE))
    return parsed


def extract_labeled_value(text: str, labels: tuple[str, ...]) -> str:
    label_pattern = "|".join(re.escape(label) for label in labels)
    match = re.search(rf"(?mi)^(?:{label_pattern})[ \t]*\n[ \t]*([^\r\n]+)", text)
    return match.group(1).strip() if match else ""


def normalize_section_text(value: str) -> str:
    parts: list[str] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("Please be advised that this email may contain confidential information"):
            break
        if re.fullmatch(r"=+", line):
            continue
        if line.startswith("<") and parts:
            parts.append(f"     {line}")
        else:
            parts.append(line)
    return "".join(parts)


def parse_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^[ \t]*\[([^\]]+)\][ \t]*$", text))
    sections: dict[str, list[str]] = {
        "consumables": [],
        "service_parts": [],
        "fault": [],
        "billing_meter": [],
    }
    for index, match in enumerate(matches):
        name = match.group(1).strip().lower()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        content = normalize_section_text(text[match.end() : end])
        if not content:
            continue
        if name in {"耗材", "消耗品", "consumables", "supplies"}:
            category = "consumables"
        elif any(term in name for term in ("服务部件", "更换部件", "service part", "replacement part")):
            category = "service_parts"
        elif any(term in name for term in ("计费器", "计数器", "billing meter", "meter count")):
            category = "billing_meter"
        elif any(term in name for term in ("故障", "fault", "trouble", "error")):
            category = "fault"
        else:
            category = "fault"
        sections[category].append(content)
    return {key: "".join(values) for key, values in sections.items() if values}


def parse_printer_state(record: MailRecord) -> PrinterState | None:
    model = extract_labeled_value(record.text, ("产品名称", "Product Model", "Product Name"))
    serial = extract_labeled_value(record.text, ("序列号", "机身编号", "Serial Number"))
    if not model or not serial:
        return None
    sections = parse_sections(record.text)
    return PrinterState(
        uid=record.uid,
        timestamp=record.message_date or record.internal_date,
        model=model,
        serial=serial,
        consumables=sections.get("consumables"),
        service_parts=sections.get("service_parts"),
        fault=sections.get("fault"),
        billing_meter=sections.get("billing_meter"),
    )


def batched(values: list[bytes], size: int) -> list[list[bytes]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def fetch_for_range(
    env_path: Path,
    start_date: date,
    end_date: date,
    timezone_name: str,
    password_override: str | None = None,
) -> tuple[str, list[MailRecord]]:
    if end_date < start_date:
        raise ValueError("end_date must not be earlier than start_date")

    env = parse_env(env_path)
    username = env.get("sina_username", "")
    password = (
        password_override
        or env.get("sina_imap_authorization_code", "")
        or env.get("sina_password", "")
    )
    configured_url = env.get("sina_url", "")
    if not username or not password:
        raise ValueError("A Sina username and IMAP authorization code are required")

    host = imap_host(username, configured_url)
    timezone = ZoneInfo(timezone_name)
    # Search exact calendar partitions, then enforce the requested Shanghai
    # date range again after parsing each message header.
    search_start = start_date
    search_end = end_date + timedelta(days=1)
    criteria = (
        "SINCE",
        search_start.strftime("%d-%b-%Y"),
        "BEFORE",
        search_end.strftime("%d-%b-%Y"),
    )

    records: list[MailRecord] = []
    context = ssl.create_default_context()
    with imaplib.IMAP4_SSL(host, 993, ssl_context=context, timeout=30) as mailbox:
        mailbox.login(username, password)
        status, _ = mailbox.select("INBOX", readonly=True)
        if status != "OK":
            raise RuntimeError("Unable to open INBOX in read-only mode")
        status, data = mailbox.uid("SEARCH", None, *criteria)
        if status != "OK":
            raise RuntimeError("IMAP search failed")

        uid_values = (data[0] or b"").split()
        print(
            f"IMAP search for {start_date.isoformat()} through {end_date.isoformat()} "
            f"returned {len(uid_values)} message(s); fetching in batches.",
            flush=True,
        )
        for batch_number, uid_batch in enumerate(batched(uid_values, FETCH_BATCH_SIZE), start=1):
            uid_set = b",".join(uid_batch)
            fetch_item = f"(UID INTERNALDATE BODY.PEEK[]<0.{MAX_MESSAGE_BYTES}>)"
            status, payload = mailbox.uid("FETCH", uid_set, fetch_item)
            if status != "OK" or not payload:
                continue
            for item in payload:
                if not isinstance(item, tuple):
                    continue
                metadata, raw_message = item
                uid_match = re.search(rb"\bUID (\d+)\b", metadata)
                if not uid_match or not raw_message:
                    continue
                message = BytesParser(policy=policy.default).parsebytes(raw_message)
                internal_dt = parse_internal_date(metadata)
                header_dt = parse_header_date(message)
                effective_dt = header_dt or internal_dt
                if effective_dt is None:
                    continue
                effective_date = effective_dt.astimezone(timezone).date()
                if effective_date < start_date or effective_date > end_date:
                    continue
                records.append(
                    MailRecord(
                        uid=uid_match.group(1).decode("ascii"),
                        subject=decode_text(message.get("Subject")),
                        sender=decode_text(message.get("From")),
                        recipient=decode_text(message.get("To")),
                        message_date=header_dt.astimezone(timezone).isoformat() if header_dt else "",
                        internal_date=internal_dt.astimezone(timezone).isoformat() if internal_dt else "",
                        text=message_text(message),
                    )
                )
            print(f"Fetched batch {batch_number}.", flush=True)

    records.sort(key=lambda item: item.message_date or item.internal_date, reverse=True)
    return host, records


def fetch_for_date(
    env_path: Path,
    target_date: date,
    timezone_name: str,
    password_override: str | None = None,
) -> tuple[str, list[MailRecord]]:
    return fetch_for_range(
        env_path,
        target_date,
        target_date,
        timezone_name,
        password_override,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV)
    parser.add_argument("--date", help="Mailbox date in YYYY-MM-DD; defaults to yesterday")
    parser.add_argument("--timezone", default=DEFAULT_TIMEZONE)
    parser.add_argument("--input-json", type=Path, help="Parse a previously extracted mail JSON file")
    parser.add_argument("--output", type=Path, help="Write extracted messages as UTF-8 JSON")
    parser.add_argument(
        "--normalized-output",
        type=Path,
        help="Write parsed printer states as UTF-8 JSON",
    )
    parser.add_argument(
        "--prompt-password",
        action="store_true",
        help="Prompt for a temporary IMAP authorization code instead of using sina_password",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    timezone = ZoneInfo(args.timezone)
    target_date = date.fromisoformat(args.date) if args.date else datetime.now(timezone).date() - timedelta(days=1)
    if args.input_json:
        raw_records = json.loads(args.input_json.read_text(encoding="utf-8"))
        records = [MailRecord(**record) for record in raw_records]
        host = "saved JSON extract"
    else:
        password_override = getpass.getpass("Sina IMAP authorization code: ") if args.prompt_password else None
        host, records = fetch_for_date(args.env_file, target_date, args.timezone, password_override)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps([asdict(record) for record in records], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    printer_states = [state for record in records if (state := parse_printer_state(record)) is not None]
    if args.normalized_output:
        args.normalized_output.parent.mkdir(parents=True, exist_ok=True)
        args.normalized_output.write_text(
            json.dumps([asdict(state) for state in printer_states], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    print(f"Connected to {host}; found {len(records)} message(s) dated {target_date.isoformat()}.")
    print(f"Parsed {len(printer_states)} printer notification(s).")
    if args.output:
        print(f"Extracted messages written to {args.output}.")
    if args.normalized_output:
        print(f"Normalized printer states written to {args.normalized_output}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

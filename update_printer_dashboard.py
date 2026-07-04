#!/usr/bin/env python3
"""Backfill printer mail history and atomically publish dashboard data."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

from retrieve_printer_mail import MailRecord, fetch_for_range, parse_printer_state


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = PROJECT_ROOT / "dashboard_config.json"
DAILY_REPORT_SCHEMA_VERSION = 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--from", dest="start_date", help="First date to refresh (YYYY-MM-DD)")
    parser.add_argument("--to", dest="end_date", help="Last date to refresh (YYYY-MM-DD)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Refetch every date in the selected range instead of gaps and recent overlap",
    )
    parser.add_argument(
        "--rebuild-only",
        action="store_true",
        help="Validate saved history and rebuild dashboard data without contacting IMAP",
    )
    return parser.parse_args()


def resolve_path(value: str, base: Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def manifest_path(path: Path) -> str:
    resolved = path.expanduser().resolve()
    try:
        return resolved.relative_to(PROJECT_ROOT).as_posix()
    except ValueError:
        return resolved.name


def load_config(path: Path) -> dict[str, Any]:
    config_path = path.expanduser().resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    base = config_path.parent
    config.setdefault("daily_reports_dir", "data/daily_reports")
    config.setdefault("daily_report_builder", "printer_email_report.mjs")
    data_root = os.environ.get("PRINTER_DATA_ROOT")
    if data_root:
        config["history_dir"] = str(Path(data_root) / "daily")
        config["runs_dir"] = str(Path(data_root) / "runs")
        config["revisions_dir"] = str(Path(data_root) / "revisions")
        config["daily_reports_dir"] = str(Path(data_root) / "daily_reports")
    path_overrides = {
        "env_file": "PRINTER_ENV_FILE",
        "mapping_path": "PRINTER_MAPPING_PATH",
        "dashboard_builder": "PRINTER_DASHBOARD_BUILDER",
        "dashboard_output": "PRINTER_DASHBOARD_OUTPUT",
        "daily_reports_dir": "PRINTER_DAILY_REPORTS_DIR",
        "daily_report_builder": "PRINTER_DAILY_REPORT_BUILDER",
    }
    for key, environment_name in path_overrides.items():
        if os.environ.get(environment_name):
            config[key] = os.environ[environment_name]
    scalar_overrides = {
        "start_date": "PRINTER_START_DATE",
        "timezone": "PRINTER_TIMEZONE",
        "node_bin": "PRINTER_NODE_BIN",
    }
    for key, environment_name in scalar_overrides.items():
        if os.environ.get(environment_name):
            config[key] = os.environ[environment_name]
    for key in (
        "env_file",
        "mapping_path",
        "history_dir",
        "runs_dir",
        "revisions_dir",
        "dashboard_builder",
        "dashboard_output",
        "daily_reports_dir",
        "daily_report_builder",
    ):
        config[key] = resolve_path(config[key], base)
    config["config_path"] = config_path
    return config


def inclusive_dates(start: date, end: date) -> list[date]:
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def contiguous_ranges(values: Iterable[date]) -> list[tuple[date, date]]:
    ordered = sorted(set(values))
    if not ordered:
        return []
    ranges: list[tuple[date, date]] = []
    start = previous = ordered[0]
    for current in ordered[1:]:
        if current != previous + timedelta(days=1):
            ranges.append((start, previous))
            start = current
        previous = current
    ranges.append((start, previous))
    return ranges


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_write(path: Path, payload: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.chmod(mode)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write(path, json_bytes(value))


@contextlib.contextmanager
def update_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another printer dashboard update is already running") from exc
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def xlsx_cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{namespace}t"))
    value_node = cell.find(f"{namespace}v")
    if value_node is None or value_node.text is None:
        return ""
    if cell_type == "s":
        return shared_strings[int(value_node.text)]
    return value_node.text


def xlsx_column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        raise ValueError(f"Invalid XLSX cell reference: {reference}")
    index = 0
    for character in match.group(1):
        index = index * 26 + ord(character) - ord("A") + 1
    return index - 1


def read_xlsx_rows(path: Path) -> list[list[str]]:
    main_namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    document_relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    package_relationships = "http://schemas.openxmlformats.org/package/2006/relationships"
    ns = {"main": main_namespace, "rel": package_relationships}

    with zipfile.ZipFile(path) as workbook:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in workbook.namelist():
            shared_root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
            for item in shared_root.findall("main:si", ns):
                shared_strings.append(
                    "".join(node.text or "" for node in item.iter(f"{{{main_namespace}}}t"))
                )

        workbook_root = ET.fromstring(workbook.read("xl/workbook.xml"))
        first_sheet = workbook_root.find("main:sheets/main:sheet", ns)
        if first_sheet is None:
            raise ValueError(f"No worksheet found in {path}")
        relationship_id = first_sheet.attrib[f"{{{document_relationships}}}id"]
        relationships_root = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
        target = ""
        for relationship in relationships_root.findall("rel:Relationship", ns):
            if relationship.attrib.get("Id") == relationship_id:
                target = relationship.attrib.get("Target", "")
                break
        if not target:
            raise ValueError(f"Cannot resolve first worksheet in {path}")
        sheet_member = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        sheet_root = ET.fromstring(workbook.read(sheet_member))

        rows: list[list[str]] = []
        for row in sheet_root.findall(".//main:sheetData/main:row", ns):
            values = ["", "", ""]
            for cell in row.findall("main:c", ns):
                column = xlsx_column_index(cell.attrib.get("r", ""))
                if column < len(values):
                    values[column] = xlsx_cell_value(cell, shared_strings)
            rows.append(values)
        return rows


def export_mapping_snapshot(source: Path, output: Path) -> dict[str, Any]:
    rows = read_xlsx_rows(source)
    data_rows = rows[1:] if rows else []
    payload = {
        "source": source.name,
        "source_sha256": sha256_file(source),
        "rows": data_rows,
    }
    atomic_write_json(output, payload)
    return {
        "source": manifest_path(source),
        "rows": len(data_rows),
        "source_sha256": payload["source_sha256"],
        "snapshot": str(output),
        "snapshot_sha256": sha256_file(output),
    }


def archive_and_write(
    path: Path,
    value: Any,
    revisions_dir: Path,
    partition_date: date,
    run_id: str,
) -> bool:
    payload = json_bytes(value)
    if path.exists():
        current = path.read_bytes()
        if current == payload:
            return False
        revision_path = revisions_dir / partition_date.isoformat() / f"{run_id}-{path.name}"
        atomic_write(revision_path, current)
    atomic_write(path, payload)
    return True


def record_date(record: MailRecord, timezone: ZoneInfo) -> date:
    timestamp = record.message_date or record.internal_date
    if not timestamp:
        raise ValueError(f"Mail UID {record.uid} has no usable timestamp")
    return datetime.fromisoformat(timestamp).astimezone(timezone).date()


def write_partitions(
    records: list[MailRecord],
    start: date,
    end: date,
    timezone: ZoneInfo,
    history_dir: Path,
    revisions_dir: Path,
    run_id: str,
) -> list[dict[str, Any]]:
    by_date = {partition_date: [] for partition_date in inclusive_dates(start, end)}
    for record in records:
        partition_date = record_date(record, timezone)
        if partition_date in by_date:
            by_date[partition_date].append(record)

    results: list[dict[str, Any]] = []
    for partition_date, partition_records in by_date.items():
        partition_records.sort(
            key=lambda item: item.message_date or item.internal_date,
            reverse=True,
        )
        states = []
        unparsed_uids: list[str] = []
        for record in partition_records:
            state = parse_printer_state(record)
            if state is None:
                unparsed_uids.append(record.uid)
            else:
                states.append(state)

        date_text = partition_date.isoformat()
        mail_path = history_dir / f"mail-{date_text}.json"
        state_path = history_dir / f"printer-states-{date_text}.json"
        mail_changed = archive_and_write(
            mail_path,
            [asdict(record) for record in partition_records],
            revisions_dir,
            partition_date,
            run_id,
        )
        states_changed = archive_and_write(
            state_path,
            [asdict(state) for state in states],
            revisions_dir,
            partition_date,
            run_id,
        )
        results.append(
            {
                "date": date_text,
                "mail": len(partition_records),
                "states": len(states),
                "unparsed_uids": unparsed_uids,
                "changed": mail_changed or states_changed,
            }
        )
    return results


def read_json_array(path: Path) -> list[dict[str, Any]]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError(f"Expected a JSON array in {path}")
    return value


def validate_history(history_dir: Path, start: date, end: date) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    daily: list[dict[str, Any]] = []
    all_uids: dict[str, str] = {}
    total_mail = 0
    total_states = 0

    for partition_date in inclusive_dates(start, end):
        date_text = partition_date.isoformat()
        mail_path = history_dir / f"mail-{date_text}.json"
        state_path = history_dir / f"printer-states-{date_text}.json"
        if not mail_path.exists() or not state_path.exists():
            errors.append(f"Missing daily partition for {date_text}")
            continue
        try:
            mail = read_json_array(mail_path)
            states = read_json_array(state_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"Invalid partition {date_text}: {exc}")
            continue

        mail_uids = [str(record.get("uid", "")) for record in mail]
        state_uids = [str(record.get("uid", "")) for record in states]
        if len(mail_uids) != len(set(mail_uids)):
            errors.append(f"Duplicate mail UID inside {date_text}")
        if len(state_uids) != len(set(state_uids)):
            errors.append(f"Duplicate printer-state UID inside {date_text}")
        if not set(state_uids).issubset(set(mail_uids)):
            errors.append(f"Printer state without source mail in {date_text}")
        for uid in mail_uids:
            if uid in all_uids and all_uids[uid] != date_text:
                errors.append(f"Mail UID {uid} appears in both {all_uids[uid]} and {date_text}")
            all_uids[uid] = date_text
        for state in states:
            if not str(state.get("timestamp", "")).startswith(date_text):
                errors.append(f"Printer-state timestamp outside partition {date_text}")
                break

        total_mail += len(mail)
        total_states += len(states)
        daily.append(
            {
                "date": date_text,
                "mail": len(mail),
                "states": len(states),
                "mail_sha256": sha256_file(mail_path),
                "states_sha256": sha256_file(state_path),
            }
        )

    parse_rate = total_states / total_mail if total_mail else 1.0
    return (
        {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "days": (end - start).days + 1,
            "mail": total_mail,
            "states": total_states,
            "parse_rate": parse_rate,
            "daily": daily,
        },
        errors,
    )


def find_node(configured: str | None) -> str:
    candidates = [configured, shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise FileNotFoundError("Node.js is required to rebuild dashboard/data.js")


def rebuild_dashboard(config: dict[str, Any], mapping_json: Path) -> dict[str, Any]:
    node = find_node(config.get("node_bin"))
    command = [
        node,
        str(config["dashboard_builder"]),
        str(config["history_dir"]),
        str(mapping_json),
        str(config["dashboard_output"]),
    ]
    result = subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    dashboard = json.loads(result.stdout)
    dashboard["outputPath"] = manifest_path(config["dashboard_output"])
    return dashboard


def daily_report_is_current(
    manifest_path: Path,
    output_path: Path,
    expected_inputs: dict[str, Any],
) -> bool:
    if not manifest_path.is_file() or not output_path.is_file():
        return False
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema_version") != DAILY_REPORT_SCHEMA_VERSION:
            return False
        if manifest.get("inputs") != expected_inputs:
            return False
        return manifest.get("output", {}).get("sha256") == sha256_file(output_path)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def generate_daily_reports(
    config: dict[str, Any],
    start: date,
    end: date,
    run_id: str,
    mapping: dict[str, Any],
) -> dict[str, Any]:
    node = find_node(config.get("node_bin"))
    builder: Path = config["daily_report_builder"]
    reports_dir: Path = config["daily_reports_dir"]
    history_dir: Path = config["history_dir"]
    revisions_dir = reports_dir / "revisions"
    builder_sha256 = sha256_file(builder)
    generated: list[dict[str, Any]] = []
    skipped: list[str] = []
    reports_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.chmod(0o700)

    for report_date in inclusive_dates(start, end):
        date_text = report_date.isoformat()
        mail_path = history_dir / f"mail-{date_text}.json"
        states_path = history_dir / f"printer-states-{date_text}.json"
        report_dir = reports_dir / date_text
        output_path = report_dir / f"打印机信息汇总-{date_text}.xlsx"
        manifest_path = report_dir / "manifest.json"
        expected_inputs = {
            "mail_sha256": sha256_file(mail_path),
            "states_sha256": sha256_file(states_path),
            "mapping_sha256": mapping["source_sha256"],
            "builder_sha256": builder_sha256,
        }
        if daily_report_is_current(manifest_path, output_path, expected_inputs):
            skipped.append(date_text)
            print(f"Daily XLSX {date_text}: current", file=sys.stderr, flush=True)
            continue

        report_dir.mkdir(parents=True, exist_ok=True)
        report_dir.chmod(0o700)
        temporary_path = report_dir / f".{output_path.stem}.{run_id}.tmp.xlsx"
        status_output_path = report_dir / f"打印机状态-{date_text}-00001.xlsx"
        environment = os.environ.copy()
        environment["PRINTER_ARCHIVE_MODE"] = "1"
        environment["PRINTER_COMBINED_OUTPUT_PATH"] = str(temporary_path)
        command = [
            node,
            str(builder),
            date_text,
            str(states_path),
            str(config["mapping_path"]),
            str(status_output_path),
        ]
        try:
            result = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                env=environment,
                check=True,
                capture_output=True,
                text=True,
            )
            report_result = json.loads(result.stdout.strip().splitlines()[-1])
            mail_count = len(read_json_array(mail_path))
            states_count = len(read_json_array(states_path))
            if report_result["comparisonRows"] != states_count:
                raise RuntimeError(
                    f"Daily XLSX {date_text} has {report_result['comparisonRows']} comparison "
                    f"rows for {states_count} parsed states"
                )
            formula_scan = report_result["combinedFormulaErrorScan"]
            if "matched 0 entries" not in formula_scan:
                raise RuntimeError(f"Daily XLSX {date_text} contains formula errors")
            if output_path.exists():
                revision_dir = revisions_dir / date_text
                revision_dir.mkdir(parents=True, exist_ok=True)
                revision_dir.chmod(0o700)
                shutil.copy2(output_path, revision_dir / f"{run_id}-{output_path.name}")
                if manifest_path.exists():
                    shutil.copy2(manifest_path, revision_dir / f"{run_id}-manifest.json")
            os.replace(temporary_path, output_path)
            output_path.chmod(0o600)
        finally:
            temporary_path.unlink(missing_ok=True)

        report_manifest = {
            "schema_version": DAILY_REPORT_SCHEMA_VERSION,
            "date": date_text,
            "run_id": run_id,
            "generated_at": datetime.now(ZoneInfo(config["timezone"])).isoformat(),
            "inputs": expected_inputs,
            "source": {
                "mail_path": manifest_path(mail_path),
                "states_path": manifest_path(states_path),
                "mapping_path": manifest_path(config["mapping_path"]),
            },
            "workbook": {
                "source_messages": mail_count,
                "parsed_states": states_count,
                "comparison_rows": report_result["comparisonRows"],
                "status_rows": report_result["outputRows"],
                "unique_serials": report_result["uniqueSerials"],
                "missing_serials": report_result["missingSerials"],
                "missing_locations": report_result["missingLocations"],
                "mapping_duplicates": report_result["mappingDuplicates"],
                "sheets": report_result["combinedSheets"],
                "formula_error_scan": formula_scan,
            },
            "output": {
                "path": manifest_path(output_path),
                "sha256": sha256_file(output_path),
                "size_bytes": output_path.stat().st_size,
            },
        }
        atomic_write_json(manifest_path, report_manifest)
        generated.append(
            {
                "date": date_text,
                "path": manifest_path(output_path),
                "mail": mail_count,
                "status_rows": report_result["outputRows"],
                "sha256": report_manifest["output"]["sha256"],
            }
        )
        print(f"Daily XLSX {date_text}: generated", file=sys.stderr, flush=True)

    return {
        "directory": manifest_path(reports_dir),
        "dates": len(inclusive_dates(start, end)),
        "generated": generated,
        "skipped": skipped,
    }


def selected_fetch_dates(
    history_dir: Path,
    start: date,
    end: date,
    overlap_days: int,
    force: bool,
    explicit_range: bool,
) -> list[date]:
    expected = inclusive_dates(start, end)
    if force or explicit_range:
        return expected
    missing = [
        value
        for value in expected
        if not (history_dir / f"mail-{value.isoformat()}.json").exists()
        or not (history_dir / f"printer-states-{value.isoformat()}.json").exists()
    ]
    overlap_start = max(start, end - timedelta(days=max(1, overlap_days) - 1))
    return sorted(set(missing + inclusive_dates(overlap_start, end)))


def fetch_with_retries(
    config: dict[str, Any],
    start: date,
    end: date,
) -> tuple[str, list[MailRecord]]:
    attempts = max(1, int(config.get("fetch_retries", 3)))
    for attempt in range(1, attempts + 1):
        try:
            return fetch_for_range(
                config["env_file"],
                start,
                end,
                config["timezone"],
            )
        except Exception:
            if attempt == attempts:
                raise
            time.sleep(2**attempt)
    raise RuntimeError("Unreachable retry state")


def run(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(args.config)
    timezone = ZoneInfo(config["timezone"])
    today = datetime.now(timezone).date()
    start = date.fromisoformat(args.start_date or config["start_date"])
    end = date.fromisoformat(args.end_date) if args.end_date else today - timedelta(days=1)
    if end < start:
        raise ValueError("The selected end date is earlier than the start date")

    run_started = datetime.now(timezone)
    run_id = run_started.strftime("%Y%m%dT%H%M%S%z")
    history_dir: Path = config["history_dir"]
    runs_dir: Path = config["runs_dir"]
    revisions_dir: Path = config["revisions_dir"]
    explicit_range = bool(args.start_date or args.end_date)
    fetched_partitions: list[dict[str, Any]] = []
    fetch_ranges: list[dict[str, str]] = []

    if not args.rebuild_only:
        fetch_dates = selected_fetch_dates(
            history_dir,
            start,
            end,
            int(config.get("refresh_overlap_days", 3)),
            args.force,
            explicit_range,
        )
        ranges = contiguous_ranges(fetch_dates)
        if len(fetch_dates) > 7:
            ranges = [(value, value) for value in fetch_dates]
        fetch_ranges = [
            {"start": range_start.isoformat(), "end": range_end.isoformat()}
            for range_start, range_end in ranges
        ]
        workers = min(max(1, int(config.get("backfill_workers", 3))), len(ranges) or 1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(fetch_with_retries, config, range_start, range_end): (
                    range_start,
                    range_end,
                )
                for range_start, range_end in ranges
            }
            for future in concurrent.futures.as_completed(futures):
                range_start, range_end = futures[future]
                host, records = future.result()
                fetched_partitions.extend(
                    write_partitions(
                        records,
                        range_start,
                        range_end,
                        timezone,
                        history_dir,
                        revisions_dir,
                        run_id,
                    )
                )
        fetched_partitions.sort(key=lambda item: item["date"])
    else:
        host = "saved history"

    validation, errors = validate_history(history_dir, start, end)
    minimum_parse_rate = float(config.get("minimum_parse_rate", 0.98))
    if validation["parse_rate"] < minimum_parse_rate:
        errors.append(
            f"Parse rate {validation['parse_rate']:.2%} is below {minimum_parse_rate:.2%}"
        )
    if errors:
        raise RuntimeError("; ".join(errors[:20]))

    mapping_json = history_dir.parent / "mapping.json"
    mapping = export_mapping_snapshot(config["mapping_path"], mapping_json)
    daily_reports = generate_daily_reports(config, start, end, run_id, mapping)
    dashboard = rebuild_dashboard(config, mapping_json)
    completed = datetime.now(timezone)
    manifest = {
        "run_id": run_id,
        "status": "success",
        "started_at": run_started.isoformat(),
        "completed_at": completed.isoformat(),
        "source": host,
        "timezone": config["timezone"],
        "fetch_ranges": fetch_ranges,
        "fetched_partitions": fetched_partitions,
        "validation": validation,
        "mapping": mapping,
        "daily_reports": daily_reports,
        "dashboard": dashboard,
    }
    runs_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_json(runs_dir / f"{run_id}.json", manifest)
    atomic_write_json(history_dir.parent / "latest-run.json", manifest)
    (history_dir.parent / "last-failed-run.json").unlink(missing_ok=True)
    return manifest


def main() -> int:
    args = parse_args()
    try:
        lock_config = load_config(args.config)
        with update_lock(lock_config["history_dir"].parent / "update.lock"):
            result = run(args)
    except Exception as exc:
        try:
            config = load_config(args.config)
            failure = {
                "status": "failed",
                "failed_at": datetime.now(ZoneInfo(config["timezone"])).isoformat(),
                "error": str(exc),
            }
            atomic_write_json(config["history_dir"].parent / "last-failed-run.json", failure)
        except Exception:
            pass
        raise
    print(
        json.dumps(
            {
                "run_id": result["run_id"],
                "range": result["validation"]["start"] + " to " + result["validation"]["end"],
                "mail": result["validation"]["mail"],
                "states": result["validation"]["states"],
                "parse_rate": result["validation"]["parse_rate"],
                "daily_reports": result["daily_reports"],
                "dashboard": result["dashboard"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

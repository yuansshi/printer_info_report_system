from __future__ import annotations

import json
import os
import unittest
import zipfile
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from update_printer_dashboard import (
    contiguous_ranges,
    load_config,
    selected_fetch_dates,
    update_lock,
    validate_history,
    read_xlsx_rows,
)


class DashboardUpdateTests(unittest.TestCase):
    def test_contiguous_ranges_splits_gaps(self) -> None:
        values = [date(2026, 6, 1), date(2026, 6, 2), date(2026, 6, 5)]
        self.assertEqual(
            contiguous_ranges(values),
            [(date(2026, 6, 1), date(2026, 6, 2)), (date(2026, 6, 5), date(2026, 6, 5))],
        )

    def test_daily_selection_includes_missing_and_overlap(self) -> None:
        with TemporaryDirectory() as directory:
            history = Path(directory)
            for value in (date(2026, 6, 1), date(2026, 6, 3), date(2026, 6, 4), date(2026, 6, 5)):
                text = value.isoformat()
                (history / f"mail-{text}.json").write_text("[]", encoding="utf-8")
                (history / f"printer-states-{text}.json").write_text("[]", encoding="utf-8")
            selected = selected_fetch_dates(
                history,
                date(2026, 6, 1),
                date(2026, 6, 5),
                overlap_days=2,
                force=False,
                explicit_range=False,
            )
            self.assertEqual(selected, [date(2026, 6, 2), date(2026, 6, 4), date(2026, 6, 5)])

    def test_history_validation_reconciles_mail_and_states(self) -> None:
        with TemporaryDirectory() as directory:
            history = Path(directory)
            mail = [{"uid": "1"}]
            states = [{"uid": "1", "timestamp": "2026-06-01T10:00:00+08:00"}]
            (history / "mail-2026-06-01.json").write_text(json.dumps(mail), encoding="utf-8")
            (history / "printer-states-2026-06-01.json").write_text(
                json.dumps(states), encoding="utf-8"
            )
            summary, errors = validate_history(history, date(2026, 6, 1), date(2026, 6, 1))
            self.assertEqual(errors, [])
            self.assertEqual(summary["mail"], 1)
            self.assertEqual(summary["states"], 1)
            self.assertEqual(summary["parse_rate"], 1.0)

    def test_update_lock_rejects_concurrent_run(self) -> None:
        with TemporaryDirectory() as directory:
            lock_path = Path(directory) / "update.lock"
            with update_lock(lock_path):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    with update_lock(lock_path):
                        pass

    def test_xlsx_mapping_reader_preserves_text_and_numeric_cells(self) -> None:
        with TemporaryDirectory() as directory:
            workbook_path = Path(directory) / "mapping.xlsx"
            with zipfile.ZipFile(workbook_path, "w") as workbook:
                workbook.writestr(
                    "xl/workbook.xml",
                    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
                )
                workbook.writestr(
                    "xl/_rels/workbook.xml.rels",
                    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
                )
                workbook.writestr(
                    "xl/sharedStrings.xml",
                    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>客户</t></si><si><t>位置</t></si></sst>',
                )
                workbook.writestr(
                    "xl/worksheets/sheet1.xml",
                    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>123456</v></c><c r="C1" t="s"><v>1</v></c></row></sheetData></worksheet>',
                )
            self.assertEqual(read_xlsx_rows(workbook_path), [["客户", "123456", "位置"]])

    def test_remote_environment_overrides_runtime_paths(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps(
                    {
                        "start_date": "2026-06-01",
                        "timezone": "Asia/Shanghai",
                        "env_file": "mail.env",
                        "mapping_path": "mapping.xlsx",
                        "history_dir": "history/daily",
                        "runs_dir": "history/runs",
                        "revisions_dir": "history/revisions",
                        "dashboard_builder": "dashboard/build_data.mjs",
                        "dashboard_output": "dashboard/data.js",
                    }
                ),
                encoding="utf-8",
            )
            data_root = root / "remote-history"
            output = root / "www" / "data.js"
            with mock.patch.dict(
                os.environ,
                {
                    "PRINTER_DATA_ROOT": str(data_root),
                    "PRINTER_DASHBOARD_OUTPUT": str(output),
                },
            ):
                config = load_config(config_path)
            self.assertEqual(config["history_dir"], data_root / "daily")
            self.assertEqual(config["runs_dir"], data_root / "runs")
            self.assertEqual(config["dashboard_output"], output)


if __name__ == "__main__":
    unittest.main()

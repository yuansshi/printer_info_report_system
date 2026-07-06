from __future__ import annotations

import hashlib
import json
import os
import unittest
import zipfile
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
from unittest import mock

from update_printer_dashboard import (
    DAILY_REPORT_SCHEMA_VERSION,
    contiguous_ranges,
    daily_report_is_current,
    generate_daily_reports,
    load_config,
    manifest_path,
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
            self.assertEqual(config["daily_reports_dir"], data_root / "daily_reports")
            self.assertEqual(config["dashboard_output"], output)

    def test_daily_report_manifest_detects_changed_output(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "report.xlsx"
            manifest = root / "manifest.json"
            inputs = {
                "mail_sha256": "mail",
                "states_sha256": "states",
                "mapping_sha256": "mapping",
                "builder_sha256": "builder",
            }
            output.write_bytes(b"workbook")
            manifest.write_text(
                json.dumps(
                    {
                        "schema_version": DAILY_REPORT_SCHEMA_VERSION,
                        "inputs": inputs,
                        "output": {"sha256": hashlib.sha256(b"workbook").hexdigest()},
                    }
                ),
                encoding="utf-8",
            )
            self.assertTrue(daily_report_is_current(manifest, output, inputs))

            output.write_bytes(b"changed")
            self.assertFalse(daily_report_is_current(manifest, output, inputs))

    def test_generate_daily_report_writes_manifest_for_new_output(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            history = root / "history"
            reports = root / "reports"
            history.mkdir()
            report_date = date(2026, 7, 4)
            date_text = report_date.isoformat()
            (history / f"mail-{date_text}.json").write_text("[]", encoding="utf-8")
            (history / f"printer-states-{date_text}.json").write_text("[]", encoding="utf-8")
            builder = root / "builder.mjs"
            mapping_path = root / "mapping.xlsx"
            builder.write_text("// test builder\n", encoding="utf-8")
            mapping_path.write_bytes(b"mapping")
            config = {
                "node_bin": None,
                "daily_report_builder": builder,
                "daily_reports_dir": reports,
                "history_dir": history,
                "mapping_path": mapping_path,
                "timezone": "Asia/Shanghai",
            }

            def fake_run(*_args: object, **kwargs: object) -> SimpleNamespace:
                environment = kwargs["env"]
                Path(environment["PRINTER_COMBINED_OUTPUT_PATH"]).write_bytes(b"xlsx")
                result = {
                    "comparisonRows": 0,
                    "outputRows": 0,
                    "uniqueSerials": 0,
                    "missingSerials": 0,
                    "missingLocations": 0,
                    "mappingDuplicates": 0,
                    "combinedSheets": ["mapping", "comparison", "status"],
                    "combinedFormulaErrorScan": "matched 0 entries",
                }
                return SimpleNamespace(stdout=json.dumps(result))

            with mock.patch("update_printer_dashboard.find_node", return_value="node"), mock.patch(
                "update_printer_dashboard.subprocess.run", side_effect=fake_run
            ):
                result = generate_daily_reports(
                    config,
                    report_date,
                    report_date,
                    "test-run",
                    {"source_sha256": "mapping-sha"},
                )

            report_manifest = json.loads(
                (reports / date_text / "manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["generated"][0]["date"], date_text)
            self.assertEqual(
                report_manifest["source"]["mail_path"],
                Path(history / f"mail-{date_text}.json").name,
            )

    def test_manifest_path_is_portable(self) -> None:
        project_file = Path(__file__).resolve()
        self.assertEqual(manifest_path(project_file), "tests/test_update_printer_dashboard.py")
        self.assertEqual(manifest_path(Path("/tmp/external-mapping.xlsx")), "external-mapping.xlsx")


if __name__ == "__main__":
    unittest.main()

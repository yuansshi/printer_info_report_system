#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
MAPPING="${2:-${PRINTER_MAPPING_PATH:-$ROOT/config/客户名称机身编号映射表.xlsx}}"

if [[ $# -ge 1 ]]; then
  REPORT_DATE="$1"
else
  REPORT_DATE="$(python3 -c 'from datetime import datetime, timedelta; from zoneinfo import ZoneInfo; print((datetime.now(ZoneInfo("Asia/Shanghai")).date() - timedelta(days=1)).isoformat())')"
fi

ANALYSIS_DIR="$ROOT/workbook_analysis"
OUTPUT_DIR="$ROOT/outputs/printer_email_${REPORT_DATE}"
RAW_JSON="$ANALYSIS_DIR/mail-${REPORT_DATE}.json"
STATES_JSON="$ANALYSIS_DIR/printer-states-${REPORT_DATE}.json"
OUTPUT_XLSX="$OUTPUT_DIR/打印机状态-${REPORT_DATE}-00001.xlsx"

mkdir -p "$ANALYSIS_DIR" "$OUTPUT_DIR"

python3 "$ROOT/retrieve_printer_mail.py" \
  --prompt-password \
  --date "$REPORT_DATE" \
  --output "$RAW_JSON" \
  --normalized-output "$STATES_JSON"

"$NODE" "$ROOT/printer_email_report.mjs" \
  "$REPORT_DATE" \
  "$STATES_JSON" \
  "$MAPPING" \
  "$OUTPUT_XLSX"

printf 'Created %s\n' "$OUTPUT_XLSX"

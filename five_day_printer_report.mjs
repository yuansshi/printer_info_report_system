import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const workspace = path.dirname(fileURLToPath(import.meta.url));
const dates = ["2026-06-28", "2026-06-29", "2026-06-30", "2026-07-01", "2026-07-02"];
const rangeLabel = `${dates[0]}_to_${dates.at(-1)}`;
const sourceDir = path.join(workspace, "workbook_analysis", `five_day_${rangeLabel}`);
const outputDir = path.join(workspace, "outputs", `five_day_printer_report_${rangeLabel}`);
const previewDir = path.join(workspace, "workbook_analysis", `five_day_report_previews_${rangeLabel}`);
const outputPath = path.join(outputDir, `打印机五日报告-${dates[0]}至${dates.at(-1)}.xlsx`);
const validationPath = path.join(outputDir, "validation.json");
const mappingPath = path.resolve(
  process.env.PRINTER_MAPPING_PATH ?? path.join(workspace, "config/客户名称机身编号映射表.xlsx"),
);

const statusHeaders = [
  "日期",
  "客户名称",
  "位置",
  "机器型号",
  "机身编号（Serial Number、序列号）",
  "耗材（消耗品,Consumables）",
  "服务部件（更换部件,Service Parts)",
  "故障（Fault）",
  "计费器（计数器,Billing Meter",
];

const summaryHeaders = [
  "最后更新时间",
  "客户名称",
  "位置",
  "机器型号",
  "机身编号",
  "最新耗材状态",
  "最新服务部件",
  "最新故障",
  "最新计费器",
  "5日通知数",
  "活跃天数",
  "状态数",
];

const colors = {
  header: "#C4D79B",
  headerBorder: "#4F5B36",
  darkGreen: "#40502A",
  paleGreen: "#EAF1DD",
  paleBlue: "#DCE6F1",
  paleGold: "#FFF2CC",
  paleRed: "#FCE4D6",
  text: "#1F2933",
  muted: "#5B6573",
  line: "#D6D9DC",
  white: "#FFFFFF",
};

function normalizeSerial(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\.0+$/, "");
}

function canonicalCell(value) {
  return value === null || value === undefined ? "" : value;
}

function excelSerialFromIso(timestamp) {
  const match = String(timestamp).match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/,
  );
  if (!match) throw new Error(`Unsupported timestamp: ${timestamp}`);
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const milliseconds = Number(`0.${fraction || "0"}`) * 1000;
  return (
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    ) /
      86_400_000 +
    25_569
  );
}

function stateKey(row) {
  return JSON.stringify(row.slice(1).map(canonicalCell));
}

function latestDistinctStates(rows) {
  const latestByState = new Map();
  for (const row of rows) {
    const key = stateKey(row);
    const current = latestByState.get(key);
    if (!current || Number(current[0]) < Number(row[0])) latestByState.set(key, row);
  }
  return [...latestByState.values()].sort((left, right) => Number(right[0]) - Number(left[0]));
}

function buildMapping(mappingRows) {
  const candidatesBySerial = new Map();
  for (const [customerValue, serialValue, locationValue] of mappingRows) {
    const serial = normalizeSerial(serialValue);
    if (!serial) continue;
    const candidates = candidatesBySerial.get(serial) ?? [];
    candidates.push({
      customer: String(customerValue ?? "").trim(),
      location: String(locationValue ?? "").trim(),
    });
    candidatesBySerial.set(serial, candidates);
  }

  const selected = new Map();
  const duplicates = [];
  for (const [serial, candidates] of candidatesBySerial) {
    const ranked = candidates
      .map((candidate, index) => ({
        ...candidate,
        index,
        score: Number(Boolean(candidate.customer)) + Number(Boolean(candidate.location)),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    selected.set(serial, ranked[0]);
    if (candidates.length > 1) duplicates.push({ serial, candidates, selected: ranked[0] });
  }
  return { selected, duplicates };
}

function mapPrinterStates(states, mapping, reportDate) {
  const missingSerials = new Set();
  const missingLocations = new Set();
  const rawRows = states
    .filter((state) => String(state.timestamp).startsWith(reportDate))
    .map((state) => {
      const serial = normalizeSerial(state.serial);
      const mapped = mapping.get(serial);
      if (!mapped) missingSerials.add(serial);
      if (mapped && !mapped.location) missingLocations.add(serial);
      return [
        excelSerialFromIso(state.timestamp),
        mapped?.customer || "暂无对应客户，请添加到映射表中",
        mapped?.location || "暂无对应机器位置，请添加到映射表中",
        String(state.model ?? "").trim(),
        serial,
        state.consumables || null,
        state.service_parts || null,
        state.fault || null,
        state.billing_meter || null,
      ];
    })
    .sort((left, right) => Number(right[0]) - Number(left[0]));

  return {
    rawRows,
    reportRows: latestDistinctStates(rawRows),
    missingSerials: [...missingSerials].sort(),
    missingLocations: [...missingLocations].sort(),
  };
}

function buildDeviceSummary(dayResults) {
  const devices = new Map();
  for (const day of dayResults) {
    for (const row of day.rawRows) {
      const serial = normalizeSerial(row[4]);
      const current = devices.get(serial) ?? {
        latestRow: row,
        notifications: 0,
        days: new Set(),
        states: new Set(),
      };
      current.notifications += 1;
      current.days.add(day.date);
      current.states.add(JSON.stringify(row.slice(5).map(canonicalCell)));
      if (Number(row[0]) > Number(current.latestRow[0])) current.latestRow = row;
      devices.set(serial, current);
    }
  }

  return [...devices.values()]
    .map((device) => [
      ...device.latestRow,
      device.notifications,
      device.days.size,
      device.states.size,
    ])
    .sort((left, right) => Number(right[0]) - Number(left[0]));
}

function applyBaseFont(sheet, range) {
  sheet.getRange(range).format.font = { typeface: "宋体", fontSize: 11, color: colors.text };
}

function addStatusSheet(workbook, sheetName, rows, tableName) {
  const sheet = workbook.worksheets.add(sheetName);
  const lastRow = Math.max(rows.length + 1, 2);
  const usedRange = `A1:I${lastRow}`;
  sheet.showGridLines = false;

  sheet.getRange("A1:I1").values = [statusHeaders];
  if (rows.length) sheet.getRange(`A2:I${rows.length + 1}`).values = rows;

  const table = sheet.tables.add(`A1:I${rows.length + 1}`, true, tableName);
  table.style = "TableStyleLight1";
  table.showFilterButton = true;

  applyBaseFont(sheet, usedRange);
  const header = sheet.getRange("A1:I1");
  header.format = {
    fill: colors.header,
    font: { typeface: "宋体", fontSize: 11, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.headerBorder },
  };
  header.format.rowHeightPx = 42;

  if (rows.length) {
    const body = sheet.getRange(`A2:I${rows.length + 1}`);
    body.format.fill = colors.white;
    body.format.wrapText = true;
    body.format.verticalAlignment = "center";
    sheet.getRange(`A2:A${rows.length + 1}`).format.numberFormat = "m/d/yy h:mm";
    sheet.getRange(`A2:A${rows.length + 1}`).format.horizontalAlignment = "right";
    sheet.getRange(`B2:D${rows.length + 1}`).format.horizontalAlignment = "left";
    sheet.getRange(`E2:E${rows.length + 1}`).format.numberFormat = "@";
    sheet.getRange(`E2:E${rows.length + 1}`).format.horizontalAlignment = "center";
    sheet.getRange(`F2:I${rows.length + 1}`).format.horizontalAlignment = "left";
    body.format.autofitRows();
  }

  const widths = [150, 105, 145, 145, 175, 215, 220, 215, 220];
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidthPx = width;
  });
  sheet.freezePanes.freezeRows(1);
  return { sheet, usedRange, lastRow: rows.length + 1 };
}

function addSummarySheet(workbook, rows) {
  const sheet = workbook.worksheets.add("信息汇总");
  const lastRow = rows.length + 1;
  const usedRange = `A1:L${lastRow}`;
  sheet.showGridLines = false;
  sheet.getRange("A1:L1").values = [summaryHeaders];
  if (rows.length) sheet.getRange(`A2:L${lastRow}`).values = rows;

  const table = sheet.tables.add(usedRange, true, "FiveDayDeviceSummary");
  table.style = "TableStyleLight1";
  table.showFilterButton = true;

  applyBaseFont(sheet, usedRange);
  const header = sheet.getRange("A1:L1");
  header.format = {
    fill: colors.header,
    font: { typeface: "宋体", fontSize: 11, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.headerBorder },
  };
  header.format.rowHeightPx = 42;

  if (rows.length) {
    const body = sheet.getRange(`A2:L${lastRow}`);
    body.format.fill = colors.white;
    body.format.verticalAlignment = "center";
    body.format.wrapText = true;
    sheet.getRange(`A2:A${lastRow}`).format.numberFormat = "m/d/yy h:mm";
    sheet.getRange(`A2:A${lastRow}`).format.horizontalAlignment = "right";
    sheet.getRange(`B2:D${lastRow}`).format.horizontalAlignment = "left";
    sheet.getRange(`E2:E${lastRow}`).format.numberFormat = "@";
    sheet.getRange(`E2:E${lastRow}`).format.horizontalAlignment = "center";
    sheet.getRange(`F2:I${lastRow}`).format.horizontalAlignment = "left";
    sheet.getRange(`J2:L${lastRow}`).format.numberFormat = "#,##0";
    sheet.getRange(`J2:L${lastRow}`).format.horizontalAlignment = "right";
    body.format.autofitRows();
  }

  const widths = [155, 110, 150, 145, 110, 210, 205, 210, 205, 90, 80, 80];
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidthPx = width;
  });
  sheet.freezePanes.freezeRows(1);
  return { sheet, usedRange, lastRow };
}

function styleKpi(sheet, labelRange, valueRange, label, formula, fill, numberFormat = "#,##0") {
  sheet.getRange(labelRange).merge();
  sheet.getRange(valueRange).merge();
  const labelCell = sheet.getRange(labelRange.split(":")[0]);
  const valueCell = sheet.getRange(valueRange.split(":")[0]);
  labelCell.values = [[label]];
  valueCell.formulas = [[formula]];
  sheet.getRange(labelRange).format = {
    fill,
    font: { typeface: "宋体", fontSize: 10, color: colors.muted },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: colors.line },
  };
  sheet.getRange(valueRange).format = {
    fill,
    font: { typeface: "宋体", fontSize: 20, bold: true, color: colors.text },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    numberFormat,
    borders: { preset: "outside", style: "thin", color: colors.line },
  };
}

function addAnalysisSheet(workbook, dayMetrics, deviceSummary, analysis) {
  const sheet = workbook.worksheets.add("分析");
  sheet.showGridLines = false;
  applyBaseFont(sheet, "A1:N45");

  sheet.getRange("A1:N1").merge();
  sheet.getRange("A1").values = [[`打印机邮件状态分析（${dates[0]} 至 ${dates.at(-1)}）`]];
  sheet.getRange("A1:N1").format = {
    fill: colors.darkGreen,
    font: { typeface: "宋体", fontSize: 16, bold: true, color: colors.white },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange("A1:N1").format.rowHeightPx = 34;

  sheet.getRange("A2:N2").merge();
  sheet.getRange("A2").values = [[
    "范围：5 个完整自然日；日报页按状态去重，信息汇总页按设备保留最新状态。数据来源：新浪邮箱只读 IMAP。",
  ]];
  sheet.getRange("A2:N2").format = {
    fill: colors.white,
    font: { typeface: "宋体", fontSize: 10, color: colors.muted },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };

  const summaryLastRow = deviceSummary.length + 1;
  styleKpi(sheet, "A3:C3", "A4:C5", "有效打印机通知", "=SUM(C8:C12)", colors.paleGreen);
  styleKpi(
    sheet,
    "D3:F3",
    "D4:F5",
    "唯一设备",
    `=COUNTA('信息汇总'!$A$2:$A$${summaryLastRow})`,
    colors.paleBlue,
  );
  styleKpi(sheet, "G3:I3", "G4:I5", "日报状态记录", "=SUM(D8:D12)", colors.paleGold);
  styleKpi(sheet, "J3:L3", "J4:L5", "有效解析率", "=SUM(C8:C12)/SUM(B8:B12)", colors.paleRed, "0.0%");

  const dailyHeaders = [
    "日期",
    "邮箱邮件",
    "有效通知",
    "日报状态",
    "唯一设备",
    "耗材通知",
    "故障通知",
    "计费器通知",
    "缺位置设备",
  ];
  const dailyRows = dayMetrics.map((item) => [
    item.date,
    item.mailboxMessages,
    item.validNotifications,
    item.reportStates,
    item.uniqueDevices,
    item.consumableNotifications,
    item.faultNotifications,
    item.billingNotifications,
    item.missingLocationDevices,
  ]);
  sheet.getRange("A7:I7").values = [dailyHeaders];
  sheet.getRange("A8:I12").values = dailyRows;
  sheet.getRange("A7:I7").format = {
    fill: colors.header,
    font: { typeface: "宋体", fontSize: 10, bold: true, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.headerBorder },
  };
  sheet.getRange("A8:I12").format = {
    fill: colors.white,
    font: { typeface: "宋体", fontSize: 10, color: colors.text },
    horizontalAlignment: "right",
    verticalAlignment: "center",
    borders: { preset: "inside", style: "thin", color: colors.line },
  };
  sheet.getRange("A8:A12").format.horizontalAlignment = "center";
  sheet.getRange("B8:I12").format.numberFormat = "#,##0";

  const topRows = analysis.topDevices.slice(0, 10).map((item) => [
    item.serial,
    item.notifications,
    item.customer,
    item.states,
  ]);
  sheet.getRange("J7:M7").values = [["机身编号", "通知数", "客户", "状态数"]];
  sheet.getRange(`J8:M${topRows.length + 7}`).values = topRows;
  sheet.getRange("J7:M7").format = {
    fill: colors.header,
    font: { typeface: "宋体", fontSize: 10, bold: true, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    borders: { preset: "all", style: "thin", color: colors.headerBorder },
  };
  sheet.getRange(`J8:M${topRows.length + 7}`).format = {
    fill: colors.white,
    font: { typeface: "宋体", fontSize: 10, color: colors.text },
    verticalAlignment: "center",
    borders: { preset: "inside", style: "thin", color: colors.line },
  };
  sheet.getRange(`J8:J${topRows.length + 7}`).format.numberFormat = "@";
  sheet.getRange(`J8:J${topRows.length + 7}`).format.horizontalAlignment = "center";
  sheet.getRange(`K8:K${topRows.length + 7}`).format.horizontalAlignment = "right";
  sheet.getRange(`K8:K${topRows.length + 7}`).format.numberFormat = "#,##0";
  sheet.getRange(`L8:L${topRows.length + 7}`).format.horizontalAlignment = "left";
  sheet.getRange(`M8:M${topRows.length + 7}`).format.horizontalAlignment = "right";
  sheet.getRange(`M8:M${topRows.length + 7}`).format.numberFormat = "#,##0";

  const trendChart = sheet.charts.add("line", sheet.getRange("A7:D12"));
  trendChart.title = "每日邮件量与去重后状态数";
  trendChart.titleTextStyle.fontSize = 12;
  trendChart.hasLegend = true;
  trendChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };
  trendChart.yAxis = { numberFormatCode: "#,##0", min: 0 };
  trendChart.setPosition("A15", "H29");

  const rankingChart = sheet.charts.add("bar", sheet.getRange("J7:K13"));
  rankingChart.title = "通知最多的设备（前 6）";
  rankingChart.titleTextStyle.fontSize = 12;
  rankingChart.hasLegend = false;
  rankingChart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } };
  rankingChart.yAxis = { numberFormatCode: "#,##0", min: 0 };
  rankingChart.setPosition("I15", "N29");

  sheet.getRange("A32:H32").merge();
  sheet.getRange("A32").values = [["关键结论"]];
  sheet.getRange("A32:H32").format = {
    fill: colors.darkGreen,
    font: { typeface: "宋体", fontSize: 11, bold: true, color: colors.white },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  analysis.findings.forEach((finding, index) => {
    const row = 33 + index;
    sheet.getRange(`A${row}:H${row}`).merge();
    sheet.getRange(`A${row}`).values = [[`${index + 1}. ${finding}`]];
    sheet.getRange(`A${row}:H${row}`).format = {
      fill: index % 2 === 0 ? colors.white : "#F7F9F4",
      font: { typeface: "宋体", fontSize: 10, color: colors.text },
      horizontalAlignment: "left",
      verticalAlignment: "center",
      wrapText: true,
      borders: { preset: "inside", style: "thin", color: colors.line },
    };
    sheet.getRange(`A${row}:H${row}`).format.rowHeightPx = 42;
  });

  const qualityStart = 37;
  sheet.getRange(`J${qualityStart}:N${qualityStart}`).merge();
  sheet.getRange(`J${qualityStart}`).values = [["数据质量与待办"]];
  sheet.getRange(`J${qualityStart}:N${qualityStart}`).format = {
    fill: colors.darkGreen,
    font: { typeface: "宋体", fontSize: 11, bold: true, color: colors.white },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange(`J${qualityStart + 1}:N${qualityStart + 1}`).values = [[
    "检查项",
    "结果",
    "受影响设备",
    "判断",
    "建议",
  ]];
  sheet.getRange(`J${qualityStart + 2}:N${qualityStart + 6}`).values = analysis.qualityRows;
  sheet.getRange(`J${qualityStart + 1}:N${qualityStart + 1}`).format = {
    fill: colors.header,
    font: { typeface: "宋体", fontSize: 10, bold: true, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: colors.headerBorder },
  };
  sheet.getRange(`J${qualityStart + 2}:N${qualityStart + 6}`).format = {
    fill: colors.white,
    font: { typeface: "宋体", fontSize: 9, color: colors.text },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "inside", style: "thin", color: colors.line },
  };
  sheet.getRange(`J${qualityStart + 2}:N${qualityStart + 6}`).format.rowHeightPx = 48;

  const widths = [100, 82, 82, 82, 82, 82, 82, 82, 88, 95, 78, 120, 76, 190];
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, 45, 1).format.columnWidthPx = width;
  });
  sheet.getRange("A2:N45").format.wrapText = true;
  sheet.freezePanes.freezeRows(2);
  return { sheet, usedRange: "A1:N43" };
}

function buildAnalysis(dayResults, mailByDate, deviceSummary, mappingDuplicates) {
  const dayMetrics = dayResults.map((day) => ({
    date: day.date,
    mailboxMessages: mailByDate.get(day.date).length,
    validNotifications: day.rawRows.length,
    reportStates: day.reportRows.length,
    uniqueDevices: new Set(day.rawRows.map((row) => normalizeSerial(row[4]))).size,
    consumableNotifications: day.rawRows.filter((row) => canonicalCell(row[5]) !== "").length,
    servicePartNotifications: day.rawRows.filter((row) => canonicalCell(row[6]) !== "").length,
    faultNotifications: day.rawRows.filter((row) => canonicalCell(row[7]) !== "").length,
    billingNotifications: day.rawRows.filter((row) => canonicalCell(row[8]) !== "").length,
    missingLocationDevices: day.missingLocations.length,
  }));

  const allRawRows = dayResults.flatMap((day) => day.rawRows);
  const totalMailbox = dayMetrics.reduce((sum, item) => sum + item.mailboxMessages, 0);
  const totalValid = dayMetrics.reduce((sum, item) => sum + item.validNotifications, 0);
  const totalReportStates = dayMetrics.reduce((sum, item) => sum + item.reportStates, 0);
  const excluded = totalMailbox - totalValid;
  const parseRate = totalMailbox ? totalValid / totalMailbox : 0;
  const compressionRate = totalValid ? 1 - totalReportStates / totalValid : 0;
  const peakDay = [...dayMetrics].sort((a, b) => b.validNotifications - a.validNotifications)[0];
  const missingSerials = [...new Set(dayResults.flatMap((day) => day.missingSerials))].sort();
  const missingLocations = [...new Set(dayResults.flatMap((day) => day.missingLocations))].sort();
  const faultSerials = [...new Set(allRawRows.filter((row) => canonicalCell(row[7]) !== "").map((row) => normalizeSerial(row[4])))].sort();
  const billingCount = allRawRows.filter((row) => canonicalCell(row[8]) !== "").length;
  const billingSerials = [
    ...new Set(
      allRawRows
        .filter((row) => canonicalCell(row[8]) !== "")
        .map((row) => normalizeSerial(row[4])),
    ),
  ].sort();
  const servicePartCount = allRawRows.filter((row) => canonicalCell(row[6]) !== "").length;

  const topDevices = deviceSummary
    .map((row) => ({
      serial: normalizeSerial(row[4]),
      customer: String(row[1] ?? ""),
      notifications: Number(row[9]),
      states: Number(row[11]),
    }))
    .sort((left, right) => right.notifications - left.notifications || right.states - left.states);

  const findings = [
    `5 天邮箱共收到 ${totalMailbox} 封邮件，其中 ${totalValid} 封成功解析为打印机通知，有效解析率 ${(parseRate * 100).toFixed(1)}%；${excluded} 封不符合当前打印机通知结构。`,
    `${peakDay.date} 通知量最高，共 ${peakDay.validNotifications} 条；五日报表合计保留 ${totalReportStates} 条不同状态，重复通知压缩率 ${(compressionRate * 100).toFixed(1)}%。`,
    `五日覆盖 ${deviceSummary.length} 台设备；通知最多的是 ${topDevices[0].serial}（${topDevices[0].customer}），共 ${topDevices[0].notifications} 条、${topDevices[0].states} 种状态。`,
    `有 ${faultSerials.length} 台设备出现故障字段；缺少位置映射的设备有 ${missingLocations.length} 台${missingLocations.length ? `：${missingLocations.slice(0, 6).join("、")}${missingLocations.length > 6 ? " 等" : ""}` : ""}。`,
    billingCount
      ? `计费器字段共提取到 ${billingCount} 条，覆盖 ${billingSerials.length} 台设备；邮件只标识计费器[1]-[5]，尚不能在没有型号定义的情况下可靠映射为黑白、彩色、复印和扫描。`
      : "五日内计费器字段仍为 0 条，因此本报告无法计算黑白、彩色、复印和扫描张数。",
  ];

  const qualityRows = [
    ["未匹配机身编号", missingSerials.length, missingSerials.join("、") || "无", missingSerials.length ? "需处理" : "通过", "新增或修正映射表记录"],
    ["缺少位置", missingLocations.length, missingLocations.length ? `${missingLocations.length} 台（详见信息汇总）` : "无", missingLocations.length ? "需补充" : "通过", "补齐设备安装位置"],
    ["重复机身编号", mappingDuplicates.length, mappingDuplicates.map((item) => item.serial).join("、") || "无", mappingDuplicates.length ? "需确认" : "通过", "每个机身编号只保留一条有效映射"],
    ["未解析邮箱", excluded, "非打印机通知或格式不同", excluded ? "复核" : "通过", "抽查原邮件，确认是否需要新增解析模板"],
    [
      "计费器数据",
      billingCount,
      billingSerials.length ? `${billingSerials.length} 台（详见日报计费器列）` : "无",
      billingCount ? "原始值可用" : "缺失",
      billingCount ? "按具体型号确认计费器[1]-[5]含义后再拆分黑白/彩色/复印/扫描" : "确认设备是否启用计费器邮件上报",
    ],
  ];

  return {
    dayMetrics,
    topDevices,
    findings,
    qualityRows,
    totals: {
      totalMailbox,
      totalValid,
      totalReportStates,
      excluded,
      parseRate,
      compressionRate,
      uniqueDevices: deviceSummary.length,
      faultDevices: faultSerials.length,
      missingSerials,
      missingLocations,
      billingCount,
      billingDevices: billingSerials.length,
      servicePartCount,
    },
  };
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const mappingWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(mappingPath));
const mappingRows = mappingWorkbook.worksheets.getItem("Sheet1").getUsedRange().values.slice(1);
const { selected: mapping, duplicates: mappingDuplicates } = buildMapping(mappingRows);

const dayResults = [];
const mailByDate = new Map();
for (const date of dates) {
  const states = JSON.parse(
    await fs.readFile(path.join(sourceDir, `printer-states-${date}.json`), "utf8"),
  );
  const mail = JSON.parse(await fs.readFile(path.join(sourceDir, `mail-${date}.json`), "utf8"));
  mailByDate.set(date, mail);
  dayResults.push({ date, ...mapPrinterStates(states, mapping, date) });
}

const deviceSummary = buildDeviceSummary(dayResults);
const analysis = buildAnalysis(dayResults, mailByDate, deviceSummary, mappingDuplicates);
const workbook = Workbook.create();
const sheetResults = [];

dayResults.forEach((day, index) => {
  sheetResults.push({
    name: day.date,
    ...addStatusSheet(workbook, day.date, day.reportRows, `DailyStatus${index + 1}`),
  });
});
sheetResults.push({ name: "信息汇总", ...addSummarySheet(workbook, deviceSummary) });
sheetResults.push({
  name: "分析",
  ...addAnalysisSheet(workbook, analysis.dayMetrics, deviceSummary, analysis),
});

const inspections = {};
for (const item of sheetResults) {
  const check = await workbook.inspect({
    kind: "table",
    sheetId: item.name,
    range: item.usedRange,
    maxChars: 3500,
    tableMaxRows: item.name === "分析" ? 14 : 8,
    tableMaxCols: item.name === "分析" ? 14 : 12,
    tableMaxCellChars: 120,
  });
  inspections[item.name] = check.ndjson;
}

const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "five-day workbook formula error scan",
});

for (const item of sheetResults) {
  const range = item.name === "分析" ? "A1:N43" : item.name === "信息汇总" ? "A1:L20" : "A1:I20";
  const preview = await workbook.render({
    sheetName: item.name,
    range,
    scale: 1,
    format: "png",
  });
  await fs.writeFile(
    path.join(previewDir, `${item.name.replaceAll("/", "-")}.png`),
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
await fs.rm(`${outputPath}.inspect.ndjson`, { force: true });

const validation = {
  dateRange: { start: dates[0], end: dates.at(-1), dates },
  outputPath,
  sheets: sheetResults.map((item) => ({ name: item.name, usedRange: item.usedRange })),
  daily: analysis.dayMetrics,
  totals: analysis.totals,
  mappingDuplicates,
  formulaErrorScan: formulaErrors.ndjson,
  inspections,
};
await fs.writeFile(validationPath, JSON.stringify(validation, null, 2), "utf8");

console.log(JSON.stringify(validation, null, 2));

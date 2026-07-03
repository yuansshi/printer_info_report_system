import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const workspace = path.dirname(fileURLToPath(import.meta.url));
const targetDate = process.argv[2] ?? "2026-07-02";
const mappingPath = path.resolve(
  process.argv[4] ?? process.env.PRINTER_MAPPING_PATH ?? path.join(workspace, "config/客户名称机身编号映射表.xlsx"),
);
const comparisonPath = path.resolve(
  process.env.PRINTER_COMPARISON_PATH ?? path.join(workspace, "config/对比文件.xlsx"),
);
const expectedPath = path.resolve(
  process.env.PRINTER_REFERENCE_STATUS_PATH ??
    path.join(workspace, "config/打印机状态-2026-06-20-00001.xlsx"),
);
const statesPath = path.resolve(
  process.argv[3] ?? path.join(workspace, `workbook_analysis/printer-states-${targetDate}.json`),
);
const outputPath = path.resolve(
  process.argv[5] ??
    path.join(workspace, `outputs/printer_email_${targetDate}/打印机状态-${targetDate}-00001.xlsx`),
);
const outputDir = path.dirname(outputPath);
const previewPath = path.join(workspace, `workbook_analysis/打印机状态-${targetDate}-preview.png`);
const validationPath = path.join(workspace, `workbook_analysis/final-validation-${targetDate}.json`);
const combinedOutputPath = path.join(outputDir, `打印机信息汇总-${targetDate}.xlsx`);
const combinedPreviewPaths = {
  mapping: path.join(workspace, `workbook_analysis/combined-mapping-${targetDate}.png`),
  comparison: path.join(workspace, `workbook_analysis/combined-comparison-${targetDate}.png`),
  status: path.join(workspace, `workbook_analysis/combined-status-${targetDate}.png`),
};

const headers = [
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

async function importWorkbook(inputPath) {
  const input = await FileBlob.load(inputPath);
  return SpreadsheetFile.importXlsx(input);
}

function canonicalCell(value) {
  return value === null || value === undefined ? "" : value;
}

function normalizeSerial(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\.0+$/, "");
}

function stateKey(row) {
  return JSON.stringify(row.slice(1).map(canonicalCell));
}

function latestDistinctStates(rows, excelDateSerial = null) {
  const latestByState = new Map();
  for (const row of rows) {
    const timestamp = Number(row[0]);
    if (!Number.isFinite(timestamp)) continue;
    if (excelDateSerial !== null && Math.floor(timestamp) !== excelDateSerial) continue;
    const key = stateKey(row);
    const current = latestByState.get(key);
    if (!current || Number(current[0]) < timestamp) latestByState.set(key, row);
  }
  return [...latestByState.values()].sort((left, right) => Number(right[0]) - Number(left[0]));
}

function rowsEqual(left, right) {
  return JSON.stringify(left.map(row => row.map(canonicalCell))) ===
    JSON.stringify(right.map(row => row.map(canonicalCell)));
}

function comparableCell(value, columnIndex) {
  if (columnIndex === 4) return normalizeSerial(value);
  return String(canonicalCell(value));
}

function rowMatchKey(row) {
  const timestampSecond = Math.round(Number(row[0]) * 86_400);
  return `${timestampSecond}|${normalizeSerial(row[4])}`;
}

function compareRowSets(expectedRows, actualRows) {
  const actualBuckets = new Map();
  actualRows.forEach((row, index) => {
    const key = rowMatchKey(row);
    const bucket = actualBuckets.get(key) ?? [];
    bucket.push({ row, index });
    actualBuckets.set(key, bucket);
  });

  const cellDifferences = [];
  const unmatchedExpected = [];
  let matchedRows = 0;
  for (const expected of expectedRows) {
    const key = rowMatchKey(expected);
    const bucket = actualBuckets.get(key) ?? [];
    if (!bucket.length) {
      unmatchedExpected.push({ timestamp: expected[0], serial: normalizeSerial(expected[4]) });
      continue;
    }

    let bestIndex = 0;
    let bestDifferenceCount = Number.POSITIVE_INFINITY;
    for (let candidateIndex = 0; candidateIndex < bucket.length; candidateIndex += 1) {
      let differenceCount = 0;
      for (let columnIndex = 1; columnIndex < headers.length; columnIndex += 1) {
        if (
          comparableCell(expected[columnIndex], columnIndex) !==
          comparableCell(bucket[candidateIndex].row[columnIndex], columnIndex)
        ) {
          differenceCount += 1;
        }
      }
      if (differenceCount < bestDifferenceCount) {
        bestDifferenceCount = differenceCount;
        bestIndex = candidateIndex;
      }
    }

    const [matched] = bucket.splice(bestIndex, 1);
    matchedRows += 1;
    for (let columnIndex = 1; columnIndex < headers.length; columnIndex += 1) {
      const expectedValue = comparableCell(expected[columnIndex], columnIndex);
      const actualValue = comparableCell(matched.row[columnIndex], columnIndex);
      if (expectedValue !== actualValue) {
        cellDifferences.push({
          timestamp: expected[0],
          serial: normalizeSerial(expected[4]),
          column: headers[columnIndex],
          expected: expectedValue,
          actual: actualValue,
        });
      }
    }
  }

  const unmatchedActual = [];
  for (const bucket of actualBuckets.values()) {
    for (const item of bucket) {
      unmatchedActual.push({ timestamp: item.row[0], serial: normalizeSerial(item.row[4]) });
    }
  }

  return {
    expectedRows: expectedRows.length,
    actualRows: actualRows.length,
    matchedRows,
    rowsWithCellDifferences: new Set(
      cellDifferences.map(item => `${item.timestamp}|${item.serial}`),
    ).size,
    cellDifferenceCount: cellDifferences.length,
    cellDifferences,
    unmatchedExpected,
    unmatchedActual,
    exactMatch:
      cellDifferences.length === 0 &&
      unmatchedExpected.length === 0 &&
      unmatchedActual.length === 0,
  };
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

function buildMapping(mappingRows) {
  const candidatesBySerial = new Map();
  for (const [customerValue, serialValue, locationValue] of mappingRows) {
    const serial = normalizeSerial(serialValue);
    if (!serial) continue;
    const candidate = {
      customer: String(customerValue ?? "").trim(),
      location: String(locationValue ?? "").trim(),
    };
    const candidates = candidatesBySerial.get(serial) ?? [];
    candidates.push(candidate);
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
  const rawRows = states.filter(state => String(state.timestamp).startsWith(reportDate)).map(state => {
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
  });
  rawRows.sort((left, right) => Number(right[0]) - Number(left[0]));
  return {
    rawRows,
    rows: latestDistinctStates(rawRows),
    missingSerials: [...missingSerials].sort(),
    missingLocations: [...missingLocations].sort(),
  };
}

async function validateReferenceTransformation() {
  const comparisonWorkbook = await importWorkbook(comparisonPath);
  const expectedWorkbook = await importWorkbook(expectedPath);
  const comparisonRows = comparisonWorkbook.worksheets.getItem("Sheet1").getRange("A2:I66").values;
  const expectedRows = expectedWorkbook.worksheets.getItem("Sheet1").getRange("A2:I12").values;
  const transformedRows = latestDistinctStates(comparisonRows, 46193);
  return {
    inputRows: comparisonRows.length,
    transformedRows: transformedRows.length,
    expectedRows: expectedRows.length,
    exactMatch: rowsEqual(transformedRows, expectedRows),
  };
}

async function validateCurrentRunAgainstJune20References(mappedRows) {
  if (targetDate !== "2026-06-20") return null;

  const comparisonWorkbook = await importWorkbook(comparisonPath);
  const expectedWorkbook = await importWorkbook(expectedPath);
  const suppliedComparisonRows = comparisonWorkbook.worksheets
    .getItem("Sheet1")
    .getRange("A2:I66").values;
  const suppliedStatusRows = expectedWorkbook.worksheets
    .getItem("Sheet1")
    .getRange("A2:I12").values;
  const cutoff = Math.max(...suppliedStatusRows.map(row => Number(row[0])));
  const daySerial = Math.floor(cutoff);
  const suppliedWindowRows = suppliedComparisonRows.filter(
    row => Math.floor(Number(row[0])) === daySerial && Number(row[0]) <= cutoff,
  );
  const generatedWindowRows = mappedRows.rawRows.filter(
    row => Math.floor(Number(row[0])) === daySerial && Number(row[0]) <= cutoff,
  );
  const generatedWindowStatusRows = latestDistinctStates(generatedWindowRows, daySerial);
  const rawComparison = compareRowSets(suppliedWindowRows, generatedWindowRows);
  const statusComparison = compareRowSets(suppliedStatusRows, generatedWindowStatusRows);
  const fullDayStatusComparison = compareRowSets(suppliedStatusRows, mappedRows.rows);
  const differencesByColumn = {};
  for (const item of statusComparison.cellDifferences) {
    differencesByColumn[item.column] = (differencesByColumn[item.column] ?? 0) + 1;
  }

  return {
    referenceCutoffExcelSerial: cutoff,
    referenceCutoffLocal: new Date((cutoff - 25_569) * 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " "),
    suppliedComparisonWorkbookRows: suppliedComparisonRows.length,
    suppliedJune20RowsThroughCutoff: suppliedWindowRows.length,
    generatedJune20RowsThroughCutoff: generatedWindowRows.length,
    generatedFullDayRows: mappedRows.rawRows.length,
    generatedFullDayStatusRows: mappedRows.rows.length,
    suppliedStatusRows: suppliedStatusRows.length,
    generatedStatusRowsThroughCutoff: generatedWindowStatusRows.length,
    rawComparison,
    statusComparison,
    fullDayStatusComparison,
    statusDifferencesByColumn: differencesByColumn,
  };
}

function addStatusSheet(workbook, sheetName, rows, tableName) {
  const sheet = workbook.worksheets.add(sheetName);
  const lastRow = rows.length + 1;
  const usedRange = `A1:I${lastRow}`;

  sheet.getRange("A1:I1").values = [headers];
  if (rows.length) sheet.getRange(`A2:I${lastRow}`).values = rows;

  const table = sheet.tables.add(usedRange, true, tableName);
  table.style = "TableStyleLight1";
  table.showFilterButton = true;

  const header = sheet.getRange("A1:I1");
  header.format = {
    fill: "#C4D79B",
    font: { name: "宋体", size: 11, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: "#4F5B36" },
  };
  header.format.rowHeightPx = 42;

  if (rows.length) {
    const body = sheet.getRange(`A2:I${lastRow}`);
    body.format.fill = "#FFFFFF";
    body.format.font = { name: "宋体", size: 11 };
    body.format.wrapText = true;
    body.format.verticalAlignment = "center";
    sheet.getRange(`A2:A${lastRow}`).format.numberFormat = "m/d/yy h:mm";
    sheet.getRange(`A2:A${lastRow}`).format.horizontalAlignment = "right";
    sheet.getRange(`B2:D${lastRow}`).format.horizontalAlignment = "left";
    sheet.getRange(`E2:E${lastRow}`).format.numberFormat = "@";
    sheet.getRange(`E2:E${lastRow}`).format.horizontalAlignment = "center";
    sheet.getRange(`F2:I${lastRow}`).format.horizontalAlignment = "left";
  }

  const columnWidths = [160, 105, 135, 145, 175, 205, 235, 205, 235];
  for (let index = 0; index < columnWidths.length; index += 1) {
    sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidthPx = columnWidths[index];
  }
  if (rows.length) sheet.getRange(`A2:I${lastRow}`).format.autofitRows();
  sheet.freezePanes.freezeRows(1);

  return { sheet, usedRange };
}

function addMappingSheet(workbook, sheetName, rows) {
  const sheet = workbook.worksheets.add(sheetName);
  const lastRow = rows.length;
  const usedRange = `A1:C${lastRow}`;

  sheet.getRange(usedRange).values = rows;
  const table = sheet.tables.add(usedRange, true, "MappingTable");
  table.style = "TableStyleLight1";
  table.showFilterButton = true;

  const header = sheet.getRange("A1:C1");
  header.format = {
    fill: "#C4D79B",
    font: { name: "宋体", size: 11, color: "#000000" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: false,
    borders: { preset: "all", style: "thin", color: "#4F5B36" },
  };
  header.format.rowHeightPx = 24;

  if (lastRow > 1) {
    const body = sheet.getRange(`A2:C${lastRow}`);
    body.format.fill = "#FFFFFF";
    body.format.font = { name: "宋体", size: 11 };
    body.format.horizontalAlignment = "center";
    body.format.verticalAlignment = "center";
    body.format.wrapText = false;
    sheet.getRange(`B2:B${lastRow}`).format.numberFormat = "0";
    body.format.autofitRows();
  }

  const columnWidths = [180, 150, 190];
  for (let index = 0; index < columnWidths.length; index += 1) {
    sheet.getRangeByIndexes(0, index, lastRow, 1).format.columnWidthPx = columnWidths[index];
  }
  sheet.freezePanes.freezeRows(1);

  return { sheet, usedRange };
}

async function buildWorkbook(rows) {
  const workbook = Workbook.create();
  const { sheet, usedRange } = addStatusSheet(workbook, "Sheet1", rows, "PrinterStatusTable");
  return { workbook, sheet, usedRange };
}

async function buildCombinedWorkbook(mappingRows, comparisonRows, statusRows) {
  const workbook = Workbook.create();
  const mappingSheetName = path.basename(mappingPath, ".xlsx");
  const comparisonSheetName = path.basename(comparisonPath, ".xlsx");
  const statusSheetName = path.basename(outputPath, ".xlsx");

  const mappingResult = addMappingSheet(workbook, mappingSheetName, mappingRows);
  const comparisonResult = addStatusSheet(
    workbook,
    comparisonSheetName,
    comparisonRows,
    "ComparisonTable",
  );
  const statusResult = addStatusSheet(workbook, statusSheetName, statusRows, "StatusTable");

  return {
    workbook,
    sheets: {
      mapping: { name: mappingSheetName, ...mappingResult },
      comparison: { name: comparisonSheetName, ...comparisonResult },
      status: { name: statusSheetName, ...statusResult },
    },
  };
}

await fs.mkdir(outputDir, { recursive: true });

const mappingWorkbook = await importWorkbook(mappingPath);
const mappingAllRows = mappingWorkbook.worksheets.getItem("Sheet1").getRange("A1:C113").values;
const mappingRows = mappingAllRows.slice(1);
const { selected: mapping, duplicates: mappingDuplicates } = buildMapping(mappingRows);
const states = JSON.parse(await fs.readFile(statesPath, "utf8"));
const statesForDate = states.filter(state => String(state.timestamp).startsWith(targetDate));
const mapped = mapPrinterStates(statesForDate, mapping, targetDate);
const referenceValidation = await validateReferenceTransformation();
const june20ComparisonValidation = await validateCurrentRunAgainstJune20References(mapped);
if (!referenceValidation.exactMatch) throw new Error("Reference deduplication validation failed");

const { workbook, usedRange } = await buildWorkbook(mapped.rows);
const tableCheck = await workbook.inspect({
  kind: "table",
  sheetId: "Sheet1",
  range: usedRange,
  maxChars: 7000,
  tableMaxRows: 15,
  tableMaxCols: 9,
  tableMaxCellChars: 160,
});
const formulaErrors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "final formula error scan",
});

const preview = await workbook.render({
  sheetName: "Sheet1",
  autoCrop: "all",
  scale: 1,
  format: "png",
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
await fs.rm(`${outputPath}.inspect.ndjson`, { force: true });

const combined = await buildCombinedWorkbook(mappingAllRows, mapped.rawRows, mapped.rows);
const combinedChecks = {};
for (const [key, item] of Object.entries(combined.sheets)) {
  const check = await combined.workbook.inspect({
    kind: "table",
    sheetId: item.name,
    range: item.usedRange,
    maxChars: 2500,
    tableMaxRows: 4,
    tableMaxCols: key === "mapping" ? 3 : 9,
    tableMaxCellChars: 120,
  });
  combinedChecks[key] = check.ndjson;
}
const combinedFormulaErrors = await combined.workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "combined workbook formula error scan",
});

const combinedPreviewSpecs = {
  mapping: "A1:C25",
  comparison: "A1:I20",
  status: "A1:I20",
};
for (const [key, item] of Object.entries(combined.sheets)) {
  const preview = await combined.workbook.render({
    sheetName: item.name,
    range: combinedPreviewSpecs[key],
    scale: 1,
    format: "png",
  });
  await fs.writeFile(
    combinedPreviewPaths[key],
    new Uint8Array(await preview.arrayBuffer()),
  );
}

const combinedOutput = await SpreadsheetFile.exportXlsx(combined.workbook);
await combinedOutput.save(combinedOutputPath);
await fs.rm(`${combinedOutputPath}.inspect.ndjson`, { force: true });

const validation = {
  reportDate: targetDate,
  sourceMessages: statesForDate.length,
  comparisonRows: mapped.rawRows.length,
  outputRows: mapped.rows.length,
  uniqueSerials: new Set(statesForDate.map(state => normalizeSerial(state.serial))).size,
  missingSerials: mapped.missingSerials,
  missingLocations: mapped.missingLocations,
  mappingDuplicates,
  referenceDeduplication: referenceValidation,
  june20ComparisonValidation,
  formulaErrorScan: formulaErrors.ndjson,
  combinedFormulaErrorScan: combinedFormulaErrors.ndjson,
  outputPath,
  combinedOutputPath,
  combinedSheets: Object.fromEntries(
    Object.entries(combined.sheets).map(([key, item]) => [key, item.name]),
  ),
};
await fs.writeFile(validationPath, JSON.stringify(validation, null, 2), "utf8");

console.log(tableCheck.ndjson);
console.log(JSON.stringify(combinedChecks, null, 2));
console.log(JSON.stringify(validation, null, 2));

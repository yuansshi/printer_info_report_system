import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const sourceDir = path.resolve(
  process.argv[2] ?? path.join(workspace, "data/printer_history/daily"),
);
const mappingPath = path.resolve(
  process.argv[3] ?? path.join(workspace, "data/printer_history/mapping.json"),
);
const outputPath = path.resolve(process.argv[4] ?? path.join(workspace, "dashboard/data.js"));

function normalizeSerial(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().replace(/\.0+$/, "");
}

function text(value) {
  return String(value ?? "").trim();
}

function buildMapping(rows) {
  const candidatesBySerial = new Map();
  for (const [customerValue, serialValue, locationValue] of rows) {
    const serial = normalizeSerial(serialValue);
    if (!serial) continue;
    const candidates = candidatesBySerial.get(serial) ?? [];
    candidates.push({ customer: text(customerValue), location: text(locationValue) });
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
    if (candidates.length > 1) {
      duplicates.push({ serial, candidates, selected: ranked[0] });
    }
  }
  return { selected, duplicates };
}

function parseCounters(value) {
  const counters = {};
  const pattern = /(?:计费器|计数器|meter)\s*\[(\d+)\]\s*([\d,]+)/gi;
  for (const match of text(value).matchAll(pattern)) {
    counters[match[1]] = Number(match[2].replaceAll(",", ""));
  }
  return counters;
}

function severityFor(event) {
  const combined = [event.consumables, event.serviceParts, event.fault].filter(Boolean).join(" ");
  if (/现在更换|需要更换|未安装|replace now|replace immediately|not installed/i.test(combined)) {
    return "critical";
  }
  if (event.fault) return "high";
  if (event.consumables || event.serviceParts || event.mappingStatus !== "ok") return "warning";
  if (event.billingMeter) return "info";
  return "normal";
}

function stateSignature(event) {
  return JSON.stringify([
    event.customer,
    event.location,
    event.model,
    event.serial,
    event.consumables,
    event.serviceParts,
    event.fault,
    event.billingMeter,
  ]);
}

function latestDistinct(events) {
  const latest = new Map();
  for (const event of events) {
    const key = stateSignature(event);
    const current = latest.get(key);
    if (!current || current.timestamp < event.timestamp) latest.set(key, event);
  }
  return [...latest.values()].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function alertSummary(event) {
  const parts = [];
  if (event.consumables) parts.push(event.consumables);
  if (event.serviceParts) parts.push(event.serviceParts);
  if (event.fault) parts.push(event.fault);
  if (event.mappingStatus === "unknown") parts.push("机身编号未加入映射表");
  if (event.mappingStatus === "missing-location") parts.push("设备位置缺失");
  return parts.join(" · ") || "状态通知";
}

function eventKinds(event) {
  const kinds = [];
  if (event.consumables) kinds.push("consumable");
  if (event.serviceParts) kinds.push("service");
  if (event.fault) kinds.push("fault");
  if (event.billingMeter) kinds.push("meter");
  if (event.mappingStatus !== "ok") kinds.push("mapping");
  if (!kinds.length) kinds.push("status");
  return kinds;
}

const sourceFiles = (await fs.readdir(sourceDir))
  .filter((name) => /^printer-states-\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .sort();
if (!sourceFiles.length) throw new Error(`No printer state JSON files found in ${sourceDir}`);

const dates = sourceFiles.map((name) => name.match(/(\d{4}-\d{2}-\d{2})/)[1]);
const mappingPayload = JSON.parse(await fs.readFile(mappingPath, "utf8"));
const mappingRows = Array.isArray(mappingPayload) ? mappingPayload : mappingPayload.rows;
if (!Array.isArray(mappingRows)) throw new Error(`Invalid mapping JSON in ${mappingPath}`);
const { selected: mapping, duplicates } = buildMapping(mappingRows);

const events = [];
const daily = [];
const dailyDistinctEvents = [];
for (const date of dates) {
  const states = JSON.parse(
    await fs.readFile(path.join(sourceDir, `printer-states-${date}.json`), "utf8"),
  );
  const mailPath = path.join(sourceDir, `mail-${date}.json`);
  const mail = JSON.parse(await fs.readFile(mailPath, "utf8"));
  const dateEvents = states
    .filter((state) => text(state.timestamp).startsWith(date))
    .map((state) => {
      const serial = normalizeSerial(state.serial);
      const mapped = mapping.get(serial);
      const mappingStatus = !mapped ? "unknown" : mapped.location ? "ok" : "missing-location";
      const event = {
        eventKey: `${date}:${state.uid}`,
        uid: text(state.uid),
        date,
        timestamp: text(state.timestamp),
        serial,
        model: text(state.model),
        customer: mapped?.customer || "未映射客户",
        location: mapped?.location || "未配置位置",
        mappingStatus,
        consumables: text(state.consumables),
        serviceParts: text(state.service_parts),
        fault: text(state.fault),
        billingMeter: text(state.billing_meter),
      };
      event.counters = parseCounters(event.billingMeter);
      event.kinds = eventKinds(event);
      event.severity = severityFor(event);
      event.stateSignature = stateSignature(event);
      return event;
    })
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  events.push(...dateEvents);
  const distinct = latestDistinct(dateEvents);
  dailyDistinctEvents.push(...distinct);
  daily.push({
    date,
    mailboxMessages: mail.length,
    notifications: dateEvents.length,
    distinctStates: distinct.length,
    uniqueDevices: new Set(dateEvents.map((event) => event.serial)).size,
    consumableNotifications: dateEvents.filter((event) => event.consumables).length,
    serviceNotifications: dateEvents.filter((event) => event.serviceParts).length,
    faultNotifications: dateEvents.filter((event) => event.fault).length,
    meterNotifications: dateEvents.filter((event) => event.billingMeter).length,
    mappingIssueDevices: new Set(
      dateEvents.filter((event) => event.mappingStatus !== "ok").map((event) => event.serial),
    ).size,
  });
}

events.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
dailyDistinctEvents.sort((left, right) => right.timestamp.localeCompare(left.timestamp));

const devicesBySerial = new Map();
for (const event of events) {
  const device = devicesBySerial.get(event.serial) ?? {
    serial: event.serial,
    customer: event.customer,
    location: event.location,
    model: event.model,
    mappingStatus: event.mappingStatus,
    latestEvent: event,
    latestMeterEvent: null,
    notifications: 0,
    activeDates: new Set(),
    states: new Set(),
    faultEvents: 0,
    consumableEvents: 0,
    serviceEvents: 0,
    meterEvents: 0,
  };
  device.notifications += 1;
  device.activeDates.add(event.date);
  device.states.add(event.stateSignature);
  if (event.fault) device.faultEvents += 1;
  if (event.consumables) device.consumableEvents += 1;
  if (event.serviceParts) device.serviceEvents += 1;
  if (event.billingMeter) {
    device.meterEvents += 1;
    if (!device.latestMeterEvent || device.latestMeterEvent.timestamp < event.timestamp) {
      device.latestMeterEvent = event;
    }
  }
  if (device.latestEvent.timestamp < event.timestamp) device.latestEvent = event;
  devicesBySerial.set(event.serial, device);
}

const devices = [...devicesBySerial.values()]
  .map((device) => ({
    serial: device.serial,
    customer: device.customer,
    location: device.location,
    model: device.model,
    mappingStatus: device.mappingStatus,
    latestEventKey: device.latestEvent.eventKey,
    latestTimestamp: device.latestEvent.timestamp,
    latestMeterEventKey: device.latestMeterEvent?.eventKey ?? "",
    notifications: device.notifications,
    activeDays: device.activeDates.size,
    distinctStates: device.states.size,
    faultEvents: device.faultEvents,
    consumableEvents: device.consumableEvents,
    serviceEvents: device.serviceEvents,
    meterEvents: device.meterEvents,
  }))
  .sort((left, right) => right.latestTimestamp.localeCompare(left.latestTimestamp));

const alertEvents = dailyDistinctEvents.filter(
  (event) =>
    event.consumables || event.serviceParts || event.fault || event.mappingStatus !== "ok",
);
const alerts = alertEvents.map((event) => ({
  eventKey: event.eventKey,
  date: event.date,
  timestamp: event.timestamp,
  serial: event.serial,
  customer: event.customer,
  location: event.location,
  model: event.model,
  severity: event.severity,
  kinds: event.kinds,
  summary: alertSummary(event),
}));

const meterRecords = events
  .filter((event) => event.billingMeter)
  .map((event) => ({
    eventKey: event.eventKey,
    date: event.date,
    timestamp: event.timestamp,
    serial: event.serial,
    customer: event.customer,
    location: event.location,
    model: event.model,
    counters: event.counters,
    raw: event.billingMeter,
  }));

const customers = [...new Set(events.map((event) => event.customer))].sort((a, b) =>
  a.localeCompare(b, "zh-CN"),
);
const unknownSerials = [...new Set(events.filter((event) => event.mappingStatus === "unknown").map((event) => event.serial))].sort();
const missingLocationSerials = [...new Set(events.filter((event) => event.mappingStatus === "missing-location").map((event) => event.serial))].sort();

const payload = {
  metadata: {
    title: "Printer Operations",
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    range: { start: dates[0], end: dates.at(-1), dates },
    latestCompleteDate: dates.at(-1),
    calendar: { day: "Asia/Shanghai", weekStartsOn: "Monday", month: "calendar" },
    source: "Sina IMAP read-only daily partitions",
    version: 2,
  },
  totals: {
    mailboxMessages: daily.reduce((sum, item) => sum + item.mailboxMessages, 0),
    notifications: events.length,
    distinctDailyStates: daily.reduce((sum, item) => sum + item.distinctStates, 0),
    devices: devices.length,
    alerts: alerts.length,
    faultDevices: new Set(events.filter((event) => event.fault).map((event) => event.serial)).size,
    meterRecords: meterRecords.length,
    meterDevices: new Set(meterRecords.map((record) => record.serial)).size,
  },
  daily,
  customers,
  devices,
  events,
  alerts,
  meterRecords,
  quality: {
    unknownSerials,
    missingLocationSerials,
    duplicateMappings: duplicates,
    counterSemantics: "unmapped",
  },
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const temporaryOutputPath = `${outputPath}.tmp-${process.pid}`;
await fs.writeFile(
  temporaryOutputPath,
  `window.PRINTER_DASHBOARD_DATA = ${JSON.stringify(payload, null, 2)};\n`,
  "utf8",
);
await fs.rename(temporaryOutputPath, outputPath);

console.log(
  JSON.stringify(
    {
      outputPath,
      dates,
      days: dates.length,
      notifications: payload.totals.notifications,
      devices: payload.totals.devices,
      alerts: payload.totals.alerts,
      meterRecords: payload.totals.meterRecords,
      unknownSerials,
      missingLocationSerials,
      duplicateMappings: duplicates.map((item) => item.serial),
    },
    null,
    2,
  ),
);

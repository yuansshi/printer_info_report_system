(() => {
  "use strict";

  const DATA = window.PRINTER_DASHBOARD_DATA;
  if (!DATA) {
    document.body.innerHTML = '<div class="empty-state">未找到 dashboard/data.js，请先运行数据生成脚本。</div>';
    return;
  }

  const severityRank = { normal: 0, info: 1, warning: 2, high: 3, critical: 4 };
  const viewTitles = {
    overview: "打印机状态总览",
    devices: "设备状态",
    alerts: "状态与告警",
    meters: "计费器覆盖",
    quality: "数据质量",
  };
  const statusLabels = {
    normal: "正常",
    info: "信息",
    warning: "关注",
    high: "故障",
    critical: "紧急",
  };
  const kindLabels = {
    consumable: "耗材",
    service: "服务部件",
    fault: "故障",
    meter: "计费器",
    mapping: "映射",
    status: "状态",
  };

  const state = {
    view: "overview",
    date: "all",
    customer: "all",
    status: "all",
    query: "",
    deviceSort: "latest",
    granularity: "day",
  };

  const elements = {
    pageTitle: document.querySelector("#page-title"),
    pageContext: document.querySelector("#page-context"),
    dateFilter: document.querySelector("#date-filter"),
    customerFilter: document.querySelector("#customer-filter"),
    statusFilter: document.querySelector("#status-filter"),
    searchInput: document.querySelector("#search-input"),
    kpiGrid: document.querySelector("#kpi-grid"),
    trendChart: document.querySelector("#trend-chart"),
    trendTitle: document.querySelector("#trend-title"),
    trendSubtitle: document.querySelector("#trend-subtitle"),
    customerBars: document.querySelector("#customer-bars"),
    overviewAlerts: document.querySelector("#overview-alerts"),
    overviewAlertCount: document.querySelector("#overview-alert-count"),
    qualitySummary: document.querySelector("#quality-summary"),
    deviceTableBody: document.querySelector("#device-table-body"),
    deviceTableCount: document.querySelector("#device-table-count"),
    alertTableBody: document.querySelector("#alert-table-body"),
    alertTableCount: document.querySelector("#alert-table-count"),
    meterKpis: document.querySelector("#meter-kpis"),
    meterTableBody: document.querySelector("#meter-table-body"),
    meterTableCount: document.querySelector("#meter-table-count"),
    qualityGrid: document.querySelector("#quality-grid"),
    qualityDeviceBody: document.querySelector("#quality-device-body"),
    drawer: document.querySelector("#device-drawer"),
    drawerBackdrop: document.querySelector("#drawer-backdrop"),
    drawerTitle: document.querySelector("#drawer-title"),
    drawerSubtitle: document.querySelector("#drawer-subtitle"),
    drawerContent: document.querySelector("#drawer-content"),
    toast: document.querySelector("#toast"),
    sidebarFreshness: document.querySelector("#sidebar-freshness"),
    sourceMethodology: document.querySelector("#source-methodology"),
  };

  const numberFormat = new Intl.NumberFormat("zh-CN");
  const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: DATA.metadata.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const generatedAtFormat = new Intl.DateTimeFormat("zh-CN", {
    timeZone: DATA.metadata.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatNumber(value) {
    return numberFormat.format(Number(value) || 0);
  }

  function formatDateTime(value) {
    if (!value) return "--";
    return dateTimeFormat.format(new Date(value)).replace("/", "-");
  }

  function refreshIcons() {
    if (window.lucide?.createIcons) {
      window.lucide.createIcons();
      document.body.classList.add("lucide-ready");
    }
  }

  function statusBadge(severity) {
    const safe = statusLabels[severity] ? severity : "normal";
    return `<span class="status-badge status-${safe}">${statusLabels[safe]}</span>`;
  }

  function typeBadges(kinds) {
    return [...new Set(kinds)]
      .map((kind) => `<span class="type-badge">${escapeHtml(kindLabels[kind] ?? kind)}</span>`)
      .join("");
  }

  function eventMatchesStatus(event) {
    switch (state.status) {
      case "critical":
        return event.severity === "critical" || event.severity === "high";
      case "consumable":
        return Boolean(event.consumables);
      case "fault":
        return Boolean(event.fault);
      case "meter":
        return Boolean(event.billingMeter);
      case "mapping":
        return event.mappingStatus !== "ok";
      default:
        return true;
    }
  }

  function filteredEvents(options = {}) {
    const query = state.query.trim().toLocaleLowerCase("zh-CN");
    return DATA.events.filter((event) => {
      if (state.date !== "all" && event.date !== state.date) return false;
      if (state.customer !== "all" && event.customer !== state.customer) return false;
      if (!options.ignoreStatus && !eventMatchesStatus(event)) return false;
      if (!query) return true;
      return [
        event.serial,
        event.customer,
        event.location,
        event.model,
        event.consumables,
        event.serviceParts,
        event.fault,
      ]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(query);
    });
  }

  function aggregateDevices(events) {
    const grouped = new Map();
    for (const event of events) {
      const current = grouped.get(event.serial) ?? {
        serial: event.serial,
        customer: event.customer,
        location: event.location,
        model: event.model,
        mappingStatus: event.mappingStatus,
        latest: event,
        latestMeter: null,
        notifications: 0,
        activeDates: new Set(),
        stateKeys: new Set(),
        kinds: new Set(),
        severity: "normal",
      };
      current.notifications += 1;
      current.activeDates.add(event.date);
      current.stateKeys.add(`${event.date}|${event.stateSignature}`);
      event.kinds.forEach((kind) => current.kinds.add(kind));
      if (severityRank[event.severity] > severityRank[current.severity]) current.severity = event.severity;
      if (event.timestamp > current.latest.timestamp) current.latest = event;
      if (event.billingMeter && (!current.latestMeter || event.timestamp > current.latestMeter.timestamp)) {
        current.latestMeter = event;
      }
      grouped.set(event.serial, current);
    }
    return [...grouped.values()].map((device) => ({
      ...device,
      activeDays: device.activeDates.size,
      distinctStates: device.stateKeys.size,
      kinds: [...device.kinds],
    }));
  }

  function filteredAlerts(events) {
    const keys = new Set(events.map((event) => event.eventKey));
    return DATA.alerts
      .filter((alert) => keys.has(alert.eventKey))
      .sort(
        (left, right) =>
          severityRank[right.severity] - severityRank[left.severity] ||
          right.timestamp.localeCompare(left.timestamp),
      );
  }

  function distinctStateCount(events) {
    return new Set(events.map((event) => `${event.date}|${event.stateSignature}`)).size;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function periodDescriptor(dateText, granularity) {
    if (granularity === "month") {
      const key = dateText.slice(0, 7);
      return { key, label: key, detail: `${key} 自然月` };
    }
    if (granularity === "week") {
      const value = new Date(`${dateText}T00:00:00Z`);
      const offset = (value.getUTCDay() + 6) % 7;
      value.setUTCDate(value.getUTCDate() - offset);
      const start = isoDate(value);
      value.setUTCDate(value.getUTCDate() + 6);
      const end = isoDate(value);
      return { key: start, label: `${start.slice(5)} 周`, detail: `${start} 至 ${end}` };
    }
    return { key: dateText, label: dateText.slice(5), detail: dateText };
  }

  function trendSeries(events) {
    const dates = state.date === "all" ? DATA.metadata.range.dates : [state.date];
    const buckets = new Map();
    dates.forEach((date) => {
      const descriptor = periodDescriptor(date, state.granularity);
      if (!buckets.has(descriptor.key)) buckets.set(descriptor.key, { ...descriptor, events: [] });
    });
    events.forEach((event) => {
      const descriptor = periodDescriptor(event.date, state.granularity);
      const bucket = buckets.get(descriptor.key) ?? { ...descriptor, events: [] };
      bucket.events.push(event);
      buckets.set(descriptor.key, bucket);
    });
    return [...buckets.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((bucket) => ({
        ...bucket,
        notifications: bucket.events.length,
        states: distinctStateCount(bucket.events),
      }));
  }

  function metricCard({ label, value, detail, icon, tone = "" }) {
    return `
      <article class="metric">
        <div>
          <div class="metric-label">${escapeHtml(label)}</div>
          <div class="metric-value">${escapeHtml(value)}</div>
          <div class="metric-detail">${escapeHtml(detail)}</div>
        </div>
        <div class="metric-icon ${tone}">
          <span class="fallback-symbol" aria-hidden="true">●</span>
          <i data-lucide="${icon}"></i>
        </div>
      </article>`;
  }

  function renderKpis(events, devices, alerts) {
    const attentionDevices = devices.filter((device) => severityRank[device.severity] >= 2).length;
    elements.kpiGrid.innerHTML = [
      metricCard({
        label: "观察设备",
        value: formatNumber(devices.length),
        detail: `${new Set(events.map((event) => event.customer)).size} 个客户`,
        icon: "printer",
      }),
      metricCard({
        label: "通知记录",
        value: formatNumber(events.length),
        detail: `${distinctStateCount(events)} 条不同状态`,
        icon: "mail",
        tone: "blue",
      }),
      metricCard({
        label: "需关注设备",
        value: formatNumber(attentionDevices),
        detail: `${alerts.length} 条状态与映射事件`,
        icon: "triangle-alert",
        tone: "red",
      }),
      metricCard({
        label: "计费器覆盖",
        value: formatNumber(new Set(events.filter((event) => event.billingMeter).map((event) => event.serial)).size),
        detail: `${events.filter((event) => event.billingMeter).length} 条原始快照`,
        icon: "gauge",
        tone: "amber",
      }),
    ].join("");
  }

  function renderTrend(events) {
    const labels = {
      day: ["每日通知与状态变化", "按上海自然日统计"],
      week: ["每周通知与状态变化", "周一至周日，末周可能不完整"],
      month: ["每月通知与状态变化", "按自然月统计"],
    };
    const [title, subtitle] = labels[state.granularity];
    elements.trendTitle.textContent = title;
    elements.trendSubtitle.textContent = subtitle;
    const series = trendSeries(events);
    const width = 760;
    const height = 250;
    const padding = { top: 22, right: 24, bottom: 40, left: 48 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(1, ...series.flatMap((item) => [item.notifications, item.states]));
    const yMax = Math.ceil(maxValue / 10) * 10;
    const xAt = (index) =>
      series.length === 1
        ? padding.left + innerWidth / 2
        : padding.left + (innerWidth * index) / (series.length - 1);
    const yAt = (value) => padding.top + innerHeight - (value / yMax) * innerHeight;
    const pathFor = (key) =>
      series
        .map((item, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(item[key]).toFixed(1)}`)
        .join(" ");

    const grid = Array.from({ length: 5 }, (_, index) => {
      const value = (yMax * index) / 4;
      const y = yAt(value);
      return `<line class="chart-grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}"></line>
        <text class="chart-axis-label" x="${padding.left - 10}" y="${y + 3}" text-anchor="end">${Math.round(value)}</text>`;
    }).join("");
    const labelEvery = Math.max(1, Math.ceil(series.length / 7));
    const xLabels = series
      .map(
        (item, index) =>
          index % labelEvery === 0 || index === series.length - 1
            ? `<text class="chart-axis-label" x="${xAt(index)}" y="${height - 12}" text-anchor="middle">${escapeHtml(item.label)}</text>`
            : "",
      )
      .join("");
    const dotRadius = series.length > 14 ? 2.6 : 4;
    const dots = series
      .map(
        (item, index) =>
          `<circle class="chart-event-dot" cx="${xAt(index)}" cy="${yAt(item.notifications)}" r="${dotRadius}"><title>${item.detail}: ${item.notifications} 条通知</title></circle>
           <circle class="chart-state-dot" cx="${xAt(index)}" cy="${yAt(item.states)}" r="${dotRadius}"><title>${item.detail}: ${item.states} 条状态</title></circle>`,
      )
      .join("");

    elements.trendChart.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        ${grid}
        ${xLabels}
        <path class="chart-event-line" d="${pathFor("notifications")}"></path>
        <path class="chart-state-line" d="${pathFor("states")}"></path>
        ${dots}
      </svg>`;
    elements.trendChart.setAttribute(
      "aria-label",
      series.map((item) => `${item.detail} 通知 ${item.notifications}，状态 ${item.states}`).join("；"),
    );
  }

  function renderCustomerBars(events) {
    const counts = new Map();
    events.forEach((event) => counts.set(event.customer, (counts.get(event.customer) ?? 0) + 1));
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (!rows.length) {
      elements.customerBars.innerHTML = '<div class="empty-state">当前筛选无客户数据</div>';
      return;
    }
    const max = rows[0][1];
    elements.customerBars.innerHTML = rows
      .map(
        ([customer, count]) => `
          <div class="bar-row">
            <div class="bar-label"><span>${escapeHtml(customer)}</span><strong>${formatNumber(count)}</strong></div>
            <div class="bar-track"><div class="bar-value" style="width:${Math.max(4, (count / max) * 100)}%"></div></div>
          </div>`,
      )
      .join("");
  }

  function renderOverviewAlerts(alerts) {
    const selected = alerts.slice(0, 5);
    elements.overviewAlertCount.textContent = `${alerts.length} 条匹配事件`;
    if (!selected.length) {
      elements.overviewAlerts.innerHTML = '<div class="empty-state">当前筛选没有告警或映射问题</div>';
      return;
    }
    elements.overviewAlerts.innerHTML = selected
      .map(
        (alert) => `
          <div class="alert-item">
            ${statusBadge(alert.severity)}
            <button class="device-link alert-device" type="button" data-serial="${escapeHtml(alert.serial)}">${escapeHtml(alert.serial)} · ${escapeHtml(alert.customer)}</button>
            <div class="alert-summary" title="${escapeHtml(alert.summary)}">${escapeHtml(alert.summary)}</div>
            <div class="alert-time">${formatDateTime(alert.timestamp)}</div>
          </div>`,
      )
      .join("");
  }

  function qualityLine({ title, detail, count, ok = false }) {
    return `
      <div class="quality-line">
        <div class="quality-icon ${ok ? "ok" : ""}">
          <i data-lucide="${ok ? "check" : "alert-circle"}"></i>
        </div>
        <div><div class="quality-title">${escapeHtml(title)}</div><div class="quality-detail">${escapeHtml(detail)}</div></div>
        <div class="quality-count">${formatNumber(count)}</div>
      </div>`;
  }

  function renderQualitySummary() {
    elements.qualitySummary.innerHTML = [
      qualityLine({
        title: "未知机身编号",
        detail: DATA.quality.unknownSerials.join("、") || "所有设备均已匹配",
        count: DATA.quality.unknownSerials.length,
        ok: DATA.quality.unknownSerials.length === 0,
      }),
      qualityLine({
        title: "缺少安装位置",
        detail: DATA.quality.missingLocationSerials.slice(0, 4).join("、") || "位置完整",
        count: DATA.quality.missingLocationSerials.length,
        ok: DATA.quality.missingLocationSerials.length === 0,
      }),
      qualityLine({
        title: "重复映射",
        detail: DATA.quality.duplicateMappings.map((item) => item.serial).join("、") || "主键唯一",
        count: DATA.quality.duplicateMappings.length,
        ok: DATA.quality.duplicateMappings.length === 0,
      }),
      qualityLine({
        title: "邮件解析",
        detail: `${DATA.totals.notifications}/${DATA.totals.mailboxMessages} 条`,
        count: DATA.totals.mailboxMessages - DATA.totals.notifications,
        ok: DATA.totals.notifications === DATA.totals.mailboxMessages,
      }),
    ].join("");
  }

  function sortDevices(devices) {
    const sorted = [...devices];
    if (state.deviceSort === "notifications") {
      return sorted.sort((a, b) => b.notifications - a.notifications || a.serial.localeCompare(b.serial));
    }
    if (state.deviceSort === "serial") return sorted.sort((a, b) => a.serial.localeCompare(b.serial));
    return sorted.sort((a, b) => b.latest.timestamp.localeCompare(a.latest.timestamp));
  }

  function renderDeviceTable(devices) {
    const sorted = sortDevices(devices);
    elements.deviceTableCount.textContent = `${sorted.length} 台设备`;
    if (!sorted.length) {
      elements.deviceTableBody.innerHTML = '<tr><td colspan="8"><div class="empty-state">当前筛选没有设备</div></td></tr>';
      return;
    }
    elements.deviceTableBody.innerHTML = sorted
      .map(
        (device) => `
          <tr>
            <td>${statusBadge(device.severity)}</td>
            <td><button class="device-link" type="button" data-serial="${escapeHtml(device.serial)}">${escapeHtml(device.serial)}</button></td>
            <td><div class="cell-primary">${escapeHtml(device.customer)}</div><div class="cell-secondary">${escapeHtml(device.location)}</div></td>
            <td>${escapeHtml(device.model)}</td>
            <td>${formatDateTime(device.latest.timestamp)}</td>
            <td class="numeric">${formatNumber(device.notifications)}</td>
            <td class="numeric">${formatNumber(device.distinctStates)}</td>
            <td>${typeBadges(device.kinds)}</td>
          </tr>`,
      )
      .join("");
  }

  function renderAlertTable(alerts) {
    const displayedAlerts = alerts.slice(0, 150);
    elements.alertTableCount.textContent =
      displayedAlerts.length < alerts.length
        ? `显示 ${displayedAlerts.length} / 共 ${alerts.length} 条事件`
        : `${alerts.length} 条事件`;
    if (!alerts.length) {
      elements.alertTableBody.innerHTML = '<tr><td colspan="6"><div class="empty-state">当前筛选没有事件</div></td></tr>';
      return;
    }
    elements.alertTableBody.innerHTML = displayedAlerts
      .map(
        (alert) => `
          <tr>
            <td>${statusBadge(alert.severity)}</td>
            <td>${formatDateTime(alert.timestamp)}</td>
            <td><button class="device-link" type="button" data-serial="${escapeHtml(alert.serial)}">${escapeHtml(alert.serial)}</button><div class="cell-secondary">${escapeHtml(alert.model)}</div></td>
            <td><div class="cell-primary">${escapeHtml(alert.customer)}</div><div class="cell-secondary">${escapeHtml(alert.location)}</div></td>
            <td>${typeBadges(alert.kinds)}</td>
            <td title="${escapeHtml(alert.summary)}">${escapeHtml(alert.summary)}</td>
          </tr>`,
      )
      .join("");
  }

  function filteredMeterRecords(events) {
    const eventKeys = new Set(events.map((event) => event.eventKey));
    const latestBySerial = new Map();
    DATA.meterRecords
      .filter((record) => eventKeys.has(record.eventKey))
      .forEach((record) => {
        const current = latestBySerial.get(record.serial);
        if (!current || current.timestamp < record.timestamp) latestBySerial.set(record.serial, record);
      });
    return [...latestBySerial.values()].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }

  function renderMeters(events) {
    const records = filteredMeterRecords(events);
    const allMatchingRecords = DATA.meterRecords.filter((record) =>
      new Set(events.map((event) => event.eventKey)).has(record.eventKey),
    );
    const models = new Set(records.map((record) => record.model));
    elements.meterKpis.innerHTML = [
      metricCard({ label: "计费器设备", value: formatNumber(records.length), detail: "每台保留最新快照", icon: "printer", tone: "blue" }),
      metricCard({ label: "原始快照", value: formatNumber(allMatchingRecords.length), detail: "当前筛选范围", icon: "database", tone: "amber" }),
      metricCard({ label: "涉及型号", value: formatNumber(models.size), detail: "需要逐型号定义", icon: "layers", tone: "" }),
    ].join("");
    elements.meterTableCount.textContent = `${records.length} 台设备有计费器快照`;
    if (!records.length) {
      elements.meterTableBody.innerHTML = '<tr><td colspan="10"><div class="empty-state">当前筛选没有计费器数据</div></td></tr>';
      return;
    }
    elements.meterTableBody.innerHTML = records
      .map(
        (record) => `
          <tr>
            <td>${formatDateTime(record.timestamp)}</td>
            <td><button class="device-link" type="button" data-serial="${escapeHtml(record.serial)}">${escapeHtml(record.serial)}</button></td>
            <td>${escapeHtml(record.customer)}</td>
            <td>${escapeHtml(record.model)}</td>
            ${[1, 2, 3, 4, 5].map((index) => `<td class="numeric">${record.counters[index] === undefined ? "--" : formatNumber(record.counters[index])}</td>`).join("")}
            <td><span class="status-badge status-warning">待定义</span></td>
          </tr>`,
      )
      .join("");
  }

  function qualityCard(title, value, detail, tone = "") {
    return `<article class="quality-card ${tone}"><h2>${escapeHtml(title)}</h2><div class="quality-card-value">${escapeHtml(value)}</div><p>${escapeHtml(detail)}</p></article>`;
  }

  function renderQuality(devices) {
    elements.qualityGrid.innerHTML = [
      qualityCard("未知机身编号", formatNumber(DATA.quality.unknownSerials.length), DATA.quality.unknownSerials.join("、") || "所有设备均已匹配", DATA.quality.unknownSerials.length ? "danger" : "ok"),
      qualityCard("缺少安装位置", formatNumber(DATA.quality.missingLocationSerials.length), "需要补充客户现场安装位置", DATA.quality.missingLocationSerials.length ? "" : "ok"),
      qualityCard("重复映射", formatNumber(DATA.quality.duplicateMappings.length), DATA.quality.duplicateMappings.map((item) => item.serial).join("、") || "映射主键唯一", DATA.quality.duplicateMappings.length ? "" : "ok"),
      qualityCard("计费器定义", "待完成", `${DATA.totals.meterDevices} 台设备存在原始值`, ""),
    ].join("");

    const issueSerials = new Set([
      ...DATA.quality.unknownSerials,
      ...DATA.quality.missingLocationSerials,
    ]);
    const issueDevices = devices.filter((device) => issueSerials.has(device.serial));
    if (!issueDevices.length) {
      elements.qualityDeviceBody.innerHTML = '<tr><td colspan="6"><div class="empty-state">当前筛选没有映射问题设备</div></td></tr>';
      return;
    }
    elements.qualityDeviceBody.innerHTML = issueDevices
      .sort((a, b) => a.serial.localeCompare(b.serial))
      .map(
        (device) => `
          <tr>
            <td>${device.mappingStatus === "unknown" ? '<span class="status-badge status-critical">未映射</span>' : '<span class="status-badge status-warning">缺位置</span>'}</td>
            <td><button class="device-link" type="button" data-serial="${escapeHtml(device.serial)}">${escapeHtml(device.serial)}</button></td>
            <td>${escapeHtml(device.customer)}</td>
            <td>${escapeHtml(device.location)}</td>
            <td>${escapeHtml(device.model)}</td>
            <td>${formatDateTime(device.latest.timestamp)}</td>
          </tr>`,
      )
      .join("");
  }

  function eventSummary(event) {
    const values = [event.consumables, event.serviceParts, event.fault, event.billingMeter].filter(Boolean);
    if (event.mappingStatus === "unknown") values.push("机身编号未映射");
    if (event.mappingStatus === "missing-location") values.push("安装位置缺失");
    return values.join(" · ") || "常规状态通知";
  }

  function openDevice(serial) {
    const dateEvents = DATA.events.filter(
      (event) => event.serial === serial && (state.date === "all" || event.date === state.date),
    );
    const events = dateEvents.length ? dateEvents : DATA.events.filter((event) => event.serial === serial);
    if (!events.length) return;
    const latest = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    const aggregate = aggregateDevices(events)[0];
    const latestMeter = [...events]
      .filter((event) => event.billingMeter)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    elements.drawerTitle.textContent = `${serial} · ${latest.model}`;
    elements.drawerSubtitle.textContent = `${latest.customer} / ${latest.location}`;

    const statusBlocks = [
      ["耗材", latest.consumables],
      ["服务部件", latest.serviceParts],
      ["故障", latest.fault],
      ["计费器", latest.billingMeter],
    ]
      .filter(([, value]) => value)
      .map(
        ([label, value]) => `<div class="status-block"><div class="status-block-label">${label}</div><div class="status-block-value">${escapeHtml(value)}</div></div>`,
      )
      .join("");

    const meterDetails = latestMeter
      ? `<div class="detail-grid">${[1, 2, 3, 4, 5]
          .map(
            (index) => `<div class="detail-item"><div class="detail-label">计费器 [${index}]</div><div class="detail-value">${latestMeter.counters[index] === undefined ? "--" : formatNumber(latestMeter.counters[index])}</div></div>`,
          )
          .join("")}</div>`
      : '<div class="cell-secondary">当前范围没有计费器快照</div>';

    const timeline = [...events]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 10)
      .map(
        (event) => `<div class="timeline-item"><div class="timeline-time">${formatDateTime(event.timestamp)}</div><div class="timeline-text">${escapeHtml(eventSummary(event))}</div></div>`,
      )
      .join("");

    elements.drawerContent.innerHTML = `
      <section class="drawer-section">
        <div class="detail-grid">
          <div class="detail-item"><div class="detail-label">状态级别</div><div class="detail-value">${statusBadge(aggregate.severity)}</div></div>
          <div class="detail-item"><div class="detail-label">最近观察</div><div class="detail-value">${formatDateTime(latest.timestamp)}</div></div>
          <div class="detail-item"><div class="detail-label">通知记录</div><div class="detail-value">${formatNumber(aggregate.notifications)}</div></div>
          <div class="detail-item"><div class="detail-label">不同状态</div><div class="detail-value">${formatNumber(aggregate.distinctStates)}</div></div>
        </div>
      </section>
      <section class="drawer-section"><h3>最新状态</h3>${statusBlocks || '<div class="cell-secondary">最新通知没有状态字段</div>'}</section>
      <section class="drawer-section"><h3>最新计费器</h3>${meterDetails}</section>
      <section class="drawer-section"><h3>最近事件</h3><div class="timeline">${timeline}</div></section>`;

    elements.drawer.removeAttribute("aria-hidden");
    elements.drawer.classList.add("is-open");
    elements.drawerBackdrop.hidden = false;
    refreshIcons();
  }

  function closeDrawer() {
    elements.drawer.classList.remove("is-open");
    elements.drawer.setAttribute("aria-hidden", "true");
    elements.drawerBackdrop.hidden = true;
  }

  function switchView(view) {
    if (!viewTitles[view]) return;
    state.view = view;
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === view);
    });
    document.querySelectorAll(".page-view").forEach((page) => {
      page.classList.toggle("is-active", page.dataset.page === view);
    });
    elements.pageTitle.textContent = viewTitles[view];
    window.location.hash = view;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    clearTimeout(showToast.timeout);
    showToast.timeout = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
  }

  function exportCsv() {
    const devices = sortDevices(aggregateDevices(filteredEvents()));
    if (!devices.length) {
      showToast("当前筛选没有可导出的设备");
      return;
    }
    const rows = [
      ["机身编号", "客户", "位置", "型号", "最近时间", "通知数", "状态数", "级别", "观察项"],
      ...devices.map((device) => [
        device.serial,
        device.customer,
        device.location,
        device.model,
        device.latest.timestamp,
        device.notifications,
        device.distinctStates,
        statusLabels[device.severity],
        device.kinds.map((kind) => kindLabels[kind] ?? kind).join("/"),
      ]),
    ];
    const csv = rows
      .map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `printer-devices-${state.date === "all" ? `${DATA.metadata.range.start}-to-${DATA.metadata.range.end}` : state.date}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`已导出 ${devices.length} 台设备`);
  }

  function render() {
    const events = filteredEvents();
    const devices = aggregateDevices(events);
    const alerts = filteredAlerts(events);
    elements.pageContext.textContent = `${events.length} 条通知 · ${devices.length} 台设备 · ${state.date === "all" ? `${DATA.metadata.range.start} 至 ${DATA.metadata.range.end}` : state.date}`;
    renderKpis(events, devices, alerts);
    renderTrend(events);
    renderCustomerBars(events);
    renderOverviewAlerts(alerts);
    renderQualitySummary();
    renderDeviceTable(devices);
    renderAlertTable(alerts);
    renderMeters(events);
    renderQuality(aggregateDevices(filteredEvents({ ignoreStatus: true })));
    document.querySelector("#nav-device-count").textContent = devices.length;
    document.querySelector("#nav-alert-count").textContent = alerts.length;
    refreshIcons();
  }

  function populateFilters() {
    elements.dateFilter.innerHTML = [
      `<option value="all">${DATA.metadata.range.start} 至 ${DATA.metadata.range.end.slice(5)}</option>`,
      ...DATA.metadata.range.dates.map((date) => `<option value="${date}">${date}</option>`),
    ].join("");
    elements.customerFilter.innerHTML = [
      '<option value="all">全部客户</option>',
      ...DATA.customers.map((customer) => `<option value="${escapeHtml(customer)}">${escapeHtml(customer)}</option>`),
    ].join("");
    document.querySelector("#sidebar-range").textContent = `${DATA.metadata.range.start} — ${DATA.metadata.range.end}`;
    elements.sidebarFreshness.textContent = `最后完整日 ${DATA.metadata.latestCompleteDate ?? DATA.metadata.range.end}`;
    elements.sourceMethodology.textContent = `Sina IMAP 只读日分区；上海自然日；周一至周日；${DATA.metadata.range.start} 至 ${DATA.metadata.range.end}；快照生成于 ${generatedAtFormat.format(new Date(DATA.metadata.generatedAt))}`;
  }

  function bindEvents() {
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    elements.dateFilter.addEventListener("change", (event) => {
      state.date = event.target.value;
      render();
    });
    elements.customerFilter.addEventListener("change", (event) => {
      state.customer = event.target.value;
      render();
    });
    elements.statusFilter.addEventListener("change", (event) => {
      state.status = event.target.value;
      render();
    });
    let searchTimer;
    elements.searchInput.addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = event.target.value;
        render();
      }, 120);
    });
    document.querySelector("#reset-filters").addEventListener("click", () => {
      state.date = "all";
      state.customer = "all";
      state.status = "all";
      state.query = "";
      elements.dateFilter.value = "all";
      elements.customerFilter.value = "all";
      elements.statusFilter.value = "all";
      elements.searchInput.value = "";
      render();
    });
    document.querySelector("#refresh-button").addEventListener("click", () => window.location.reload());
    document.querySelector("#export-button").addEventListener("click", exportCsv);
    document.querySelectorAll("[data-sort]").forEach((button) => {
      button.addEventListener("click", () => {
        state.deviceSort = button.dataset.sort;
        document.querySelectorAll("[data-sort]").forEach((item) => item.classList.toggle("is-active", item === button));
        renderDeviceTable(aggregateDevices(filteredEvents()));
      });
    });
    document.querySelectorAll("[data-granularity]").forEach((button) => {
      button.addEventListener("click", () => {
        state.granularity = button.dataset.granularity;
        document.querySelectorAll("[data-granularity]").forEach((item) => {
          item.classList.toggle("is-active", item === button);
        });
        renderTrend(filteredEvents());
      });
    });
    document.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-serial]");
      if (trigger) openDevice(trigger.dataset.serial);
    });
    document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
    elements.drawerBackdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
    });
  }

  populateFilters();
  bindEvents();
  const requestedView = window.location.hash.slice(1);
  if (viewTitles[requestedView]) switchView(requestedView);
  render();
  refreshIcons();
  window.addEventListener("load", refreshIcons);
  setTimeout(refreshIcons, 1000);
})();

"use strict";
/* ------------------------------------------------------------------
 * API endpoints in ONE place.
 * ------------------------------------------------------------------ */
const ENDPOINTS = {
  dashboard: "/api/dashboard",
  serviceStatus: "/api/servicestatus",
  recent: (limit) => `/api/dashboard/recent?limit=${encodeURIComponent(limit)}`,
  projects: "/api/projects",
  packages: "/api/packages",
  packageTypes: "/api/packagetypes",
  serviceItems: "/api/serviceitems",
  schedules: "/api/schedules",
  activeSchedules: "/api/schedules?active=true",
  serviceRecords: "/api/servicerecords",
  pvDataTypes: "/api/pvdatatypes",
  pvAttributes: "/api/pvattributes",
  pvLog: "/api/pvlog",
  technicians: "/api/technicians",
  // --- Firmware / device tracking ---
  manufacturers: "/api/manufacturers",
  devices: "/api/devices",
  deviceTypes: "/api/devicetypes",
  checkTypes: "/api/checktypes",
  versionSources: "/api/versionsources",
  versionLogs: "/api/versionlogs",
  packageDevices: "/api/packagedevices"
};

const state = {
  dashboard: null,
  statuses: [],
  recent: [],
  readings: [],
  currentView: "dashboard",
  currentSystem: "projects",
  loading: false,
  recentFilters: {
    projectId: "",
    packageId: "",
    serviceItemId: "",
    sort: "date_desc"
  },
  readingsFilters: {
    projectId: "",
    packageId: "",
    attributeId: "",
    sort: "date_desc"
  }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  alert: $("#globalAlert"),
  toast: $("#toast"),
  connectionDot: $("#connectionDot"),
  connectionText: $("#connectionText"),
  lastUpdated: $("#lastUpdated"),
  refreshButton: $("#refreshButton"),
  pageTitle: $("#pageTitle"),
  pageSubtitle: $("#pageSubtitle"),
  sidebar: $("#sidebar"),
  sidebarBackdrop: $("#sidebarBackdrop"),
  menuButton: $("#menuButton"),
  statusFilter: $("#statusFilter"),
  statusSearch: $("#statusSearch"),
  recentLimit: $("#recentLimit"),
  recentProjectFilter: $("#recentProjectFilter"),
  recentPackageFilter: $("#recentPackageFilter"),
  recentServiceItemFilter: $("#recentServiceItemFilter"),
  recentSort: $("#recentSort"),
  readingsProjectFilter: $("#readingsProjectFilter"),
  readingsPackageFilter: $("#readingsPackageFilter"),
  readingsAttributeFilter: $("#readingsAttributeFilter"),
  readingsSort: $("#readingsSort"),
  systemSelect: $("#systemSelect"),
  systemsFilterRow: $("#systemsFilterRow"),
  sysManufacturerFilter: $("#sysManufacturerFilter"),
  sysDeviceFilter: $("#sysDeviceFilter"),
  sysProjectFilter: $("#sysProjectFilter"),
  sysPackageFilter: $("#sysPackageFilter"),
  sysDeviceTypeFilter: $("#sysDeviceTypeFilter")
};

const viewMetadata = {
  dashboard: ["Dashboard", "Package maintenance overview"],
  maintenance: ["Service Status", "Current maintenance condition for every active schedule"],
  recent: ["Recent Service", "Completed package maintenance records"],
  readings: ["Readings", "Logged process value readings"],
  systems: ["Systems", "Projects, packages, service items, schedules, process values and firmware tracking"]
};

/* ---------------- Helpers ---------------- */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "Not set";
  const dateOnly = String(value).slice(0, 10);
  const [year, month, day] = dateOnly.split("-").map(Number);
  if (!year || !month || !day) return escapeHtml(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit"
  }).format(new Date(year, month - 1, day));
}

function formatDateTime(value) {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function formatNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : fallback;
}

function itemsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function statusLabel(status) {
  return (
    {
      OVERDUE: "Overdue",
      DUE_SOON: "Due soon",
      OK: "On schedule",
      NOT_SET: "Not set"
    }[status] || status
  );
}

function statusBadge(status) {
  const safeStatus = ["OVERDUE", "DUE_SOON", "OK", "NOT_SET"].includes(status)
    ? status
    : "NOT_SET";
  return `<span class="status-badge ${safeStatus}">${escapeHtml(statusLabel(safeStatus))}</span>`;
}

/* Combines a package's name with optional type/tag into a two-line cell. */
function packageCell(name, typeName, tag) {
  const meta = [typeName, tag].filter(Boolean).join(" · ");
  return `<strong>${escapeHtml(name ?? "–")}</strong>${
    meta ? `<br><small>${escapeHtml(meta)}</small>` : ""
  }`;
}

/* Renders a pv_log "value" for display, appending the unit when numeric. */
function formatPvValue(value, dataTypeName, unit) {
  if (value === null || value === undefined) return "–";
  if (dataTypeName === "boolean") return value ? "Yes" : "No";
  if (dataTypeName === "numeric") {
    return unit ? `${formatNumber(value)} ${escapeHtml(unit)}` : formatNumber(value);
  }
  return escapeHtml(String(value));
}

/* Renders a technician's name as a clickable link that opens the
 * Contact Details popup. Returns "–" if no id/name is available. */
function contactLink(id, name) {
  if (!id || !name) return "–";
  return `<button type="button" class="contact-link" data-tech-id="${id}">${escapeHtml(name)}</button>`;
}

/* Builds a sorted list of unique {id, name} options from a set of items,
 * given the property names that hold the id and the display name. */
function uniqueOptions(items, idKey, nameKey) {
  const seen = new Map();
  items.forEach((item) => {
    const id = item[idKey];
    if (id !== null && id !== undefined && !seen.has(id)) {
      seen.set(id, item[nameKey] ?? `#${id}`);
    }
  });
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/* Rebuilds a filter <select>'s options while preserving the current
 * selection if it is still a valid option afterwards. */
function refreshFilterOptions(selectEl, placeholderLabel, options) {
  const previousValue = selectEl.value;
  selectEl.innerHTML =
    `<option value="">${escapeHtml(placeholderLabel)}</option>` +
    options.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join("");
  const stillValid = [...selectEl.options].some((opt) => opt.value === previousValue);
  selectEl.value = stillValid ? previousValue : "";
}

async function apiFetch(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const message =
      payload?.error || payload?.message || `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

/* Generic POST helper for the create forms. */
async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  const result = (response.headers.get("content-type") || "").includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    throw new Error(
      result?.error || result?.message || `Request failed with status ${response.status}`
    );
  }
  return result;
}

/* Populate a <select> with projects. Returns the loaded projects. */
async function fillProjectSelect(selectId) {
  const projects = itemsOf(await apiFetch(ENDPOINTS.projects));
  $(selectId).innerHTML =
    '<option value="">Select project</option>' +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  return projects;
}

/* Fill a package <select> with packages belonging to the given project. */
async function fillPackagesForProject(projectId, selectId) {
  const select = $(selectId);
  if (!projectId) {
    select.innerHTML = '<option value="">Select project first</option>';
    select.disabled = true;
    return [];
  }
  const packages = itemsOf(await apiFetch(ENDPOINTS.packages)).filter(
    (pkg) => Number(pkg.project_id) === Number(projectId)
  );
  if (!packages.length) {
    select.innerHTML = '<option value="">No packages in this project</option>';
    select.disabled = true;
    return [];
  }
  select.innerHTML =
    '<option value="">Select package</option>' +
    packages
      .map(
        (pkg) =>
          `<option value="${pkg.id}">${escapeHtml(pkg.name)}${
            pkg.package_tag ? " (" + escapeHtml(pkg.package_tag) + ")" : ""
          }</option>`
      )
      .join("");
  select.disabled = false;
  return packages;
}

/* Populate a <select> with technicians (used by the firmware tracker
 * forms — contacts, installed-by, confirmed-by — as well as the
 * "Performed By" field on Add Record and Add Reading). */
async function fillTechnicianSelect(selectId, placeholder = "None") {
  const technicians = itemsOf(await apiFetch(ENDPOINTS.technicians + "?active=true"));
  $(selectId).innerHTML =
    `<option value="">${escapeHtml(placeholder)}</option>` +
    technicians.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  return technicians;
}

/* ---------------- UI state ---------------- */
function setConnection(isOnline) {
  elements.connectionDot.classList.toggle("online", isOnline);
  elements.connectionDot.classList.toggle("offline", !isOnline);
  elements.connectionText.textContent = isOnline ? "API connected" : "API unavailable";
}

function showAlert(message) {
  elements.alert.textContent = message;
  elements.alert.classList.remove("hidden");
}

function clearAlert() {
  elements.alert.classList.add("hidden");
  elements.alert.textContent = "";
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("hidden"), 3200);
}

function setView(view) {
  state.currentView = view;
  $$("[data-view-panel]").forEach((panel) =>
    panel.classList.toggle("hidden", panel.dataset.viewPanel !== view)
  );
  $$(".nav-item").forEach((item) =>
    item.classList.toggle("active", item.dataset.view === view)
  );
  const [title, subtitle] = viewMetadata[view] || ["", ""];
  elements.pageTitle.textContent = title;
  elements.pageSubtitle.textContent = subtitle;
  closeSidebar();
}

function openSidebar() {
  elements.sidebar.classList.add("open");
  elements.sidebarBackdrop.classList.remove("hidden");
  elements.menuButton.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  elements.sidebar.classList.remove("open");
  elements.sidebarBackdrop.classList.add("hidden");
  elements.menuButton.setAttribute("aria-expanded", "false");
}

/* ---------------- Dashboard rendering ---------------- */
function renderDashboard(summary) {
  const map = {
    metricOverdue: summary.overdueItems,
    metricDueSoon: summary.dueSoonItems,
    metricOk: summary.okItems,
    metricNotSet: summary.notSetItems,
    activeProjects: summary.activeProjects,
    activePackages: summary.activePackages,
    activeServiceItems: summary.activeServiceItems,
    activeSchedules: summary.activeSchedules,
    serviceRecords: summary.serviceRecords,
    attachments: summary.attachments
  };
  Object.entries(map).forEach(([id, value]) => {
    const el = $(`#${id}`);
    if (el) el.textContent = formatNumber(value);
  });
}

function renderNextDue() {
  const host = $("#nextDueList");
  const items = state.statuses
    .filter((item) => item.next_due_date)
    .sort((a, b) => String(a.next_due_date).localeCompare(String(b.next_due_date)))
    .slice(0, 5);
  if (!items.length) {
    host.innerHTML = '<div class="empty-state">No calculated due dates available.</div>';
    return;
  }
  host.innerHTML = items
    .map(
      (item) => `
    <div class="due-item">
      <div>
        <strong>${escapeHtml(item.service_item_name)}</strong>
        <span>${escapeHtml(item.project_name)} · ${escapeHtml(item.package_name)}</span>
      </div>
      <div class="due-date">
        ${statusBadge(item.status)}
        <span>${formatDate(item.next_due_date)}</span>
      </div>
    </div>
  `
    )
    .join("");
}

function renderStatusTable() {
  const status = elements.statusFilter.value;
  const search = elements.statusSearch.value.trim().toLowerCase();
  const items = state.statuses.filter((item) => {
    const statusMatch = status === "ALL" || item.status === status;
    const haystack = [item.project_name, item.package_name, item.package_tag, item.service_item_name]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return statusMatch && (!search || haystack.includes(search));
  });
  const body = $("#statusTableBody");
  const empty = $("#statusEmpty");
  body.innerHTML = items
    .map(
      (item) => `
    <tr>
      <td>${statusBadge(item.status)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${packageCell(item.package_name, item.package_type_name, item.package_tag)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${formatDate(item.last_service_date)}</td>
      <td>${formatDate(item.next_due_date)}</td>
      <td>${item.days_remaining == null ? "–" : formatNumber(item.days_remaining)}</td>
      <td>${hoursRemainingCell(item)}</td>
      <td>${item.interval_days == null ? "–" : formatNumber(item.interval_days) + " days"}${
        item.track_running_hours && item.interval_running_hours
          ? `<br><small>${formatNumber(item.interval_running_hours)} hrs</small>`
          : ""
      }</td>
    </tr>
  `
    )
    .join("");
  empty.classList.toggle("hidden", items.length > 0);
  $("#statusCount").textContent = `${items.length} schedule${items.length === 1 ? "" : "s"}`;
}

/* Renders the "Hours" column cell for the Service Status table. */
function hoursRemainingCell(item) {
  if (!item.track_running_hours || item.interval_running_hours == null) return "–";
  if (item.hours_remaining == null) return `<small>No hours data</small>`;
  const usedText =
    item.hours_used != null ? `${formatNumber(Math.round(item.hours_used))} used` : "";
  return `${formatNumber(Math.round(item.hours_remaining))}${
    usedText ? `<br><small>${usedText}</small>` : ""
  }`;
}

/* ---------------- Recent Service: rows, filters, sort ---------------- */
/* NOTE: "Performed By" is a technician_id foreign key end-to-end. The
 * API (dashboard.js /recent and servicerecords.js) returns the joined
 * name as "technician_name" — NOT "performed_by". */
function recentRows(items) {
  return items
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${packageCell(item.package_name, item.package_type_name, item.package_tag)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${escapeHtml(item.technician_name || "–")}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
      <td>${formatNumber(item.attachment_count)}</td>
    </tr>
  `
    )
    .join("");
}

function renderDashboardRecent() {
  const dashboardBody = $("#dashboardRecentBody");
  dashboardBody.innerHTML = state.recent
    .slice(0, 5)
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${packageCell(item.package_name, item.package_type_name, item.package_tag)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${escapeHtml(item.technician_name || "–")}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
    </tr>
  `
    )
    .join("");
  $("#dashboardRecentEmpty").classList.toggle("hidden", state.recent.length > 0);
}

function populateRecentFilterOptions() {
  refreshFilterOptions(
    elements.recentProjectFilter,
    "All projects",
    uniqueOptions(state.recent, "project_id", "project_name")
  );
  refreshFilterOptions(
    elements.recentPackageFilter,
    "All packages",
    uniqueOptions(state.recent, "package_id", "package_name")
  );
  refreshFilterOptions(
    elements.recentServiceItemFilter,
    "All service items",
    uniqueOptions(state.recent, "service_item_id", "service_item_name")
  );
}

function applyRecentFilters() {
  const projectId = elements.recentProjectFilter.value;
  const packageId = elements.recentPackageFilter.value;
  const serviceItemId = elements.recentServiceItemFilter.value;
  const sort = elements.recentSort.value;
  state.recentFilters = { projectId, packageId, serviceItemId, sort };
  let items = state.recent.filter((item) => {
    if (projectId && String(item.project_id) !== projectId) return false;
    if (packageId && String(item.package_id) !== packageId) return false;
    if (serviceItemId && String(item.service_item_id) !== serviceItemId) return false;
    return true;
  });
  items = items.slice().sort((a, b) => {
    const dateA = a.service_date ?? "";
    const dateB = b.service_date ?? "";
    return sort === "date_asc" ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });
  $("#recentTableBody").innerHTML = recentRows(items);
  $("#recentEmpty").classList.toggle("hidden", items.length > 0);
  $("#recentCount").textContent = `${items.length} of ${state.recent.length} record${
    state.recent.length === 1 ? "" : "s"
  }`;
}

async function loadRecent() {
  const limit = Number(elements.recentLimit.value || 20);
  const data = await apiFetch(ENDPOINTS.recent(limit));
  state.recent = itemsOf(data);
  renderDashboardRecent();
  populateRecentFilterOptions();
  applyRecentFilters();
}

/* ---------------- Readings: rows, filters, sort ---------------- */
/* NOTE: "Performed By" is a technician_id foreign key end-to-end. The
 * API (pvlog.js) returns the joined name as "technician_name" — NOT
 * "performed_by". */
function readingRows(items) {
  return items
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.reading_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${packageCell(item.package_name, null, item.package_tag)}</td>
      <td>${escapeHtml(item.attribute_name ?? "–")}</td>
      <td>${formatPvValue(item.value, item.data_type_name, item.unit)}</td>
      <td>${escapeHtml(item.technician_name || "–")}</td>
      <td>${formatDateTime(item.created_at)}</td>
    </tr>
  `
    )
    .join("");
}

function populateReadingsFilterOptions() {
  refreshFilterOptions(
    elements.readingsProjectFilter,
    "All projects",
    uniqueOptions(state.readings, "project_id", "project_name")
  );
  refreshFilterOptions(
    elements.readingsPackageFilter,
    "All packages",
    uniqueOptions(state.readings, "package_id", "package_name")
  );
  refreshFilterOptions(
    elements.readingsAttributeFilter,
    "All process values",
    uniqueOptions(state.readings, "pv_attribute_id", "attribute_name")
  );
}

function applyReadingsFilters() {
  const projectId = elements.readingsProjectFilter.value;
  const packageId = elements.readingsPackageFilter.value;
  const attributeId = elements.readingsAttributeFilter.value;
  const sort = elements.readingsSort.value;
  state.readingsFilters = { projectId, packageId, attributeId, sort };
  let items = state.readings.filter((item) => {
    if (projectId && String(item.project_id) !== projectId) return false;
    if (packageId && String(item.package_id) !== packageId) return false;
    if (attributeId && String(item.pv_attribute_id) !== attributeId) return false;
    return true;
  });
  items = items.slice().sort((a, b) => {
    const dateA = a.reading_date ?? "";
    const dateB = b.reading_date ?? "";
    return sort === "date_asc" ? dateA.localeCompare(dateB) : dateB.localeCompare(dateA);
  });
  $("#readingsTableBody").innerHTML = readingRows(items);
  $("#readingsEmpty").classList.toggle("hidden", items.length > 0);
  $("#readingsListCount").textContent = `${items.length} of ${state.readings.length} reading${
    state.readings.length === 1 ? "" : "s"
  }`;
}

async function loadReadings() {
  const data = await apiFetch(ENDPOINTS.pvLog);
  state.readings = itemsOf(data);
  const el = $("#readingsCount");
  if (el) el.textContent = formatNumber(data.count ?? state.readings.length);
  populateReadingsFilterOptions();
  applyReadingsFilters();
}

async function loadAll({ notify = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = "Refreshing...";
  clearAlert();
  try {
    const [dashboard, statusData] = await Promise.all([
      apiFetch(ENDPOINTS.dashboard),
      apiFetch(ENDPOINTS.serviceStatus)
    ]);
    state.dashboard = dashboard;
    state.statuses = itemsOf(statusData);
    await loadRecent();
    await loadReadings();
    renderDashboard(dashboard);
    renderNextDue();
    renderStatusTable();
    setConnection(true);
    elements.lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date())}`;
    if (notify) showToast("Dashboard updated");
  } catch (error) {
    console.error(error);
    setConnection(false);
    showAlert(`Unable to load maintenance data: ${error.message}`);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = "Refresh";
  }
}

/* ---------------------------------------------------------------
 * Systems views (single dispatcher)
 * ------------------------------------------------------------- */
function renderSystemsTable(title, subtitle, headHtml, rows) {
  $("#systemTitle").textContent = title;
  const subtitleEl = $("#systemSubtitle");
  if (subtitleEl) subtitleEl.textContent = subtitle;
  $("#systemsHead").innerHTML = headHtml;
  $("#systemsBody").innerHTML = rows;
  const empty = $("#systemsEmpty");
  if (empty) empty.classList.toggle("hidden", rows.trim().length > 0);
}

async function loadProjectsView() {
  const projects = itemsOf(await apiFetch(ENDPOINTS.projects));
  renderSystemsTable(
    "Projects",
    "Project master data",
    `<tr><th>ID</th><th>Code</th><th>Name</th><th>Customer</th><th>Contact 1</th><th>Contact 2</th><th>Eureka Resp. 1</th><th>Eureka Resp. 2</th><th>Active</th></tr>`,
    projects
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.code ?? "–")}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.customer ?? "–")}</td>
        <td>${contactLink(p.customer_contact1_id, p.customer_contact1_name)}</td>
        <td>${contactLink(p.customer_contact2_id, p.customer_contact2_name)}</td>
        <td>${contactLink(p.eureka_responsible_1_id, p.eureka_responsible_1_name)}</td>
        <td>${contactLink(p.eureka_responsible_2_id, p.eureka_responsible_2_name)}</td>
        <td>${p.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadPackagesView() {
  const packages = itemsOf(await apiFetch(ENDPOINTS.packages));
  renderSystemsTable(
    "Packages",
    "Package master data (gensets, pumps and other equipment)",
    `<tr><th>ID</th><th>Name</th><th>Package Tag</th><th>Serial Number</th><th>Project</th><th>Type</th><th>Active</th></tr>`,
    packages
      .map(
        (pkg) => `
      <tr>
        <td>${escapeHtml(pkg.id)}</td>
        <td>${escapeHtml(pkg.name)}</td>
        <td>${escapeHtml(pkg.package_tag ?? "–")}</td>
        <td>${escapeHtml(pkg.serial_number ?? "–")}</td>
        <td>${escapeHtml(pkg.project_name ?? "–")}</td>
        <td>${escapeHtml(pkg.package_type_name ?? "–")}</td>
        <td>${pkg.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadPackageTypesView() {
  const types = itemsOf(await apiFetch(ENDPOINTS.packageTypes));
  renderSystemsTable(
    "Package Types",
    "Categories of packages (Genset, Pump, ...)",
    `<tr><th>ID</th><th>Name</th><th>Active</th></tr>`,
    types
      .map(
        (t) => `
      <tr>
        <td>${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td>${t.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadServiceItemsView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.serviceItems));
  renderSystemsTable(
    "Service Items",
    "Maintenance task catalogue",
    `<tr><th>ID</th><th>Name</th><th>Description</th><th>Active</th></tr>`,
    items
      .map(
        (i) => `
      <tr>
        <td>${escapeHtml(i.id)}</td>
        <td>${escapeHtml(i.name)}</td>
        <td>${escapeHtml(i.description ?? "–")}</td>
        <td>${i.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

function trackFlag(on) {
  return on ? "Yes" : "–";
}

async function loadSchedulesView() {
  const schedules = itemsOf(await apiFetch(ENDPOINTS.activeSchedules));
  renderSystemsTable(
    "Active Schedules",
    "Package maintenance schedules",
    `<tr><th>ID</th><th>Project</th><th>Package</th><th>Service Item</th><th>Start Date</th><th>Interval (days)</th><th>Interval (hours)</th><th>Warning (days)</th><th>Warning (hours)</th><th>Track Days</th><th>Track Hours</th><th>Active</th></tr>`,
    schedules
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.id)}</td>
        <td>${escapeHtml(s.project_name ?? "–")}</td>
        <td>${packageCell(s.package_name, s.package_type_name, s.package_tag)}</td>
        <td>${escapeHtml(s.service_item_name ?? "–")}</td>
        <td>${formatDate(s.schedule_start_date)}</td>
        <td>${s.interval_days == null ? "–" : formatNumber(s.interval_days)}</td>
        <td>${s.interval_running_hours == null ? "–" : formatNumber(s.interval_running_hours)}</td>
        <td>${s.warning_days == null ? "–" : formatNumber(s.warning_days)}</td>
        <td>${s.warning_hours == null ? "–" : formatNumber(s.warning_hours)}</td>
        <td>${trackFlag(s.track_days)}</td>
        <td>${trackFlag(s.track_running_hours)}</td>
        <td>${s.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadPvAttributesView() {
  const attributes = itemsOf(await apiFetch(ENDPOINTS.pvAttributes));
  renderSystemsTable(
    "Process Values",
    "Loggable process values (available to any package)",
    `<tr><th>ID</th><th>Name</th><th>Data Type</th><th>Unit</th><th>Description</th><th>Active</th></tr>`,
    attributes
      .map(
        (a) => `
      <tr>
        <td>${escapeHtml(a.id)}</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.data_type_name ?? "–")}</td>
        <td>${escapeHtml(a.unit ?? "–")}</td>
        <td>${escapeHtml(a.description ?? "–")}</td>
        <td>${a.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

/* ---------------- Firmware / device tracking system views ---------------- */
async function loadManufacturersView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.manufacturers));
  renderSystemsTable(
    "Manufacturers",
    "Equipment manufacturers and their contacts",
    `<tr><th>ID</th><th>Name</th><th>Website</th><th>Contact 1</th><th>Eureka Responsible 1</th><th>Devices</th><th>Active</th></tr>`,
    items
      .map(
        (m) => `
      <tr>
        <td>${escapeHtml(m.id)}</td>
        <td>${escapeHtml(m.name)}</td>
        <td>${
          m.website
            ? `<a href="${escapeHtml(m.website)}" target="_blank" rel="noopener">${escapeHtml(m.website)}</a>`
            : "–"
        }</td>
        <td>${contactLink(m.contact1_id, m.contact1_name)}</td>
        <td>${contactLink(m.eureka_responsible_1_id, m.eureka_responsible_1_name)}</td>
        <td>${formatNumber(m.device_count)}</td>
        <td>${m.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadDevicesView() {
  const manufacturerId = elements.sysManufacturerFilter ? elements.sysManufacturerFilter.value : "";
  const query = manufacturerId ? `?manufacturer_id=${encodeURIComponent(manufacturerId)}` : "";
  const items = itemsOf(await apiFetch(ENDPOINTS.devices + query));
  renderSystemsTable(
    "Devices",
    "Device catalog (manufacturer, model, hardware version)",
    `<tr><th>ID</th><th>Manufacturer</th><th>Device Type</th><th>Name</th><th>Order Number</th><th>Hardware Version</th><th>Active</th></tr>`,
    items
      .map(
        (d) => `
      <tr>
        <td>${escapeHtml(d.id)}</td>
        <td>${escapeHtml(d.manufacturer_name)}</td>
        <td>${escapeHtml(d.device_type_name)}</td>
        <td>${escapeHtml(d.name)}</td>
        <td>${escapeHtml(d.order_number ?? "–")}</td>
        <td>${escapeHtml(d.hardware_version ?? "–")}</td>
        <td>${d.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadDeviceTypesView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.deviceTypes));
  renderSystemsTable(
    "Device Types",
    "Device categories (Device, Software)",
    `<tr><th>ID</th><th>Name</th><th>Active</th></tr>`,
    items
      .map(
        (t) => `<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.name)}</td><td>${
          t.active ? "Yes" : "No"
        }</td></tr>`
      )
      .join("")
  );
}

async function loadCheckTypesView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.checkTypes));
  renderSystemsTable(
    "Check Types",
    "Firmware / EOL / EOS check categories",
    `<tr><th>ID</th><th>Name</th></tr>`,
    items.map((t) => `<tr><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.name)}</td></tr>`).join("")
  );
}

async function loadVersionSourcesView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.versionSources));
  renderSystemsTable(
    "Version Sources",
    "Where firmware / lifecycle findings came from",
    `<tr><th>ID</th><th>Name</th><th>Active</th></tr>`,
    items
      .map(
        (s) => `<tr><td>${escapeHtml(s.id)}</td><td>${escapeHtml(s.name)}</td><td>${
          s.active ? "Yes" : "No"
        }</td></tr>`
      )
      .join("")
  );
}

async function loadTechniciansView() {
  const items = itemsOf(await apiFetch(ENDPOINTS.technicians));
  renderSystemsTable(
    "Technicians",
    "People who perform service, verification and confirmation work",
    `<tr><th>ID</th><th>Name</th><th>Title</th><th>Company</th><th>Phone</th><th>Email</th><th>Active</th></tr>`,
    items
      .map(
        (t) => `
      <tr>
        <td>${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td>${escapeHtml(t.title ?? "–")}</td>
        <td>${escapeHtml(t.company_name ?? "–")}</td>
        <td>${escapeHtml(t.phone ?? "–")}</td>
        <td>${escapeHtml(t.email ?? "–")}</td>
        <td>${t.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadVersionLogsView() {
  const manufacturerId = elements.sysManufacturerFilter ? elements.sysManufacturerFilter.value : "";
  const deviceId = elements.sysDeviceFilter ? elements.sysDeviceFilter.value : "";
  const params = [];
  if (manufacturerId) params.push(`manufacturer_id=${encodeURIComponent(manufacturerId)}`);
  if (deviceId) params.push(`device_id=${encodeURIComponent(deviceId)}`);
  const query = params.length ? `?${params.join("&")}` : "";
  const items = itemsOf(await apiFetch(ENDPOINTS.versionLogs + query));
  renderSystemsTable(
    "Version Logs",
    "Confirmed firmware / EOL / EOS records",
    `<tr><th>ID</th><th>Manufacturer</th><th>Device</th><th>Check Type</th><th>Version</th><th>Release Date</th><th>EOL Date</th><th>EOS Date</th><th>Confirmed By</th><th>Latest</th></tr>`,
    items
      .map(
        (v) => `
      <tr>
        <td>${escapeHtml(v.id)}</td>
        <td>${escapeHtml(v.manufacturer_name)}</td>
        <td>${escapeHtml(v.device_name)}</td>
        <td>${escapeHtml(v.check_type_name)}</td>
        <td>${escapeHtml(v.version ?? "–")}</td>
        <td>${formatDate(v.release_date)}</td>
        <td>${formatDate(v.eol_date)}</td>
        <td>${formatDate(v.eos_date)}</td>
        <td>${contactLink(v.confirmed_by_id, v.confirmed_by_name)}</td>
        <td>${v.is_approved_latest ? "Yes" : "–"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadPackageDevicesView() {
  const projectId = elements.sysProjectFilter ? elements.sysProjectFilter.value : "";
  const packageId = elements.sysPackageFilter ? elements.sysPackageFilter.value : "";
  const deviceTypeId = elements.sysDeviceTypeFilter ? elements.sysDeviceTypeFilter.value : "";
  const params = [];
  if (projectId) params.push(`project_id=${encodeURIComponent(projectId)}`);
  if (packageId) params.push(`package_id=${encodeURIComponent(packageId)}`);
  if (deviceTypeId) params.push(`device_type_id=${encodeURIComponent(deviceTypeId)}`);
  const query = params.length ? `?${params.join("&")}` : "";
  const items = itemsOf(await apiFetch(ENDPOINTS.packageDevices + query));
  renderSystemsTable(
    "Package Devices",
    "Devices installed on packages, with confirmed firmware version",
    `<tr><th>ID</th><th>Project</th><th>Package</th><th>Tag</th><th>Manufacturer</th><th>Device</th><th>Type</th><th>Serial</th><th>Firmware</th><th>Spare</th><th>Active</th></tr>`,
    items
      .map(
        (pd) => `
      <tr>
        <td>${escapeHtml(pd.id)}</td>
        <td>${escapeHtml(pd.project_name)}</td>
        <td>${packageCell(pd.package_name, null, pd.package_tag)}</td>
        <td>${escapeHtml(pd.tag_name)}</td>
        <td>${escapeHtml(pd.manufacturer_name)}</td>
        <td>${escapeHtml(pd.device_name)}</td>
        <td>${escapeHtml(pd.device_type_name)}</td>
        <td>${escapeHtml(pd.serial_number ?? "–")}</td>
        <td>${escapeHtml(pd.firmware_version ?? "–")}${
          pd.firmware_is_latest ? " <small>(latest)</small>" : ""
        }</td>
        <td>${pd.is_spare_part ? "Yes" : "–"}</td>
        <td>${pd.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

const systemLoaders = {
  projects: loadProjectsView,
  packages: loadPackagesView,
  packagetypes: loadPackageTypesView,
  serviceitems: loadServiceItemsView,
  schedules: loadSchedulesView,
  pvattributes: loadPvAttributesView,
  // --- Firmware / device tracking ---
  manufacturers: loadManufacturersView,
  devices: loadDevicesView,
  devicetypes: loadDeviceTypesView,
  checktypes: loadCheckTypesView,
  versionsources: loadVersionSourcesView,
  versionlogs: loadVersionLogsView,
  technicians: loadTechniciansView,
  packagedevices: loadPackageDevicesView
};

/* Which of the 5 systems filter controls are visible per category. */
const FILTER_VISIBILITY = {
  devices: ["manufacturer"],
  versionlogs: ["manufacturer", "device"],
  packagedevices: ["project", "package", "devicetype"]
};

async function refreshDeviceFilterOptions() {
  const manufacturerId = elements.sysManufacturerFilter.value;
  const query = manufacturerId ? `?manufacturer_id=${encodeURIComponent(manufacturerId)}` : "";
  const devices = itemsOf(await apiFetch(ENDPOINTS.devices + query));
  const previousValue = elements.sysDeviceFilter.value;
  elements.sysDeviceFilter.innerHTML =
    '<option value="">All devices</option>' +
    devices
      .map(
        (d) =>
          `<option value="${d.id}">${escapeHtml(
            `${d.manufacturer_name} - ${d.name} (${d.hardware_version})`
          )}</option>`
      )
      .join("");
  if ([...elements.sysDeviceFilter.options].some((o) => o.value === previousValue)) {
    elements.sysDeviceFilter.value = previousValue;
  }
}

async function refreshPackageFilterOptions() {
  const projectId = elements.sysProjectFilter.value;
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  const packages = itemsOf(await apiFetch(ENDPOINTS.packages + query));
  const previousValue = elements.sysPackageFilter.value;
  elements.sysPackageFilter.innerHTML =
    '<option value="">All packages</option>' +
    packages
      .map(
        (p) =>
          `<option value="${p.id}">${escapeHtml(
            (p.project_name ? p.project_name + " · " : "") + p.name
          )}</option>`
      )
      .join("");
  if ([...elements.sysPackageFilter.options].some((o) => o.value === previousValue)) {
    elements.sysPackageFilter.value = previousValue;
  }
}

/* Shows/hides and (lazily) populates the Systems filter controls for
 * the given category, before its loader is invoked. */
async function populateSystemsFilters(categoryKey) {
  const visible = FILTER_VISIBILITY[categoryKey] || [];
  $$(".sys-filter").forEach((el) => {
    el.classList.toggle("hidden", !visible.includes(el.dataset.filterKind));
  });
  if (elements.systemsFilterRow) {
    elements.systemsFilterRow.classList.toggle("hidden", visible.length === 0);
  }
  if (visible.includes("manufacturer") && elements.sysManufacturerFilter.dataset.loaded !== "true") {
    const manufacturers = itemsOf(await apiFetch(ENDPOINTS.manufacturers + "?active=true"));
    elements.sysManufacturerFilter.innerHTML =
      '<option value="">All manufacturers</option>' +
      manufacturers.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
    elements.sysManufacturerFilter.dataset.loaded = "true";
  }
  if (visible.includes("device")) {
    await refreshDeviceFilterOptions();
  }
  if (visible.includes("project") && elements.sysProjectFilter.dataset.loaded !== "true") {
    const projects = itemsOf(await apiFetch(ENDPOINTS.projects));
    elements.sysProjectFilter.innerHTML =
      '<option value="">All projects</option>' +
      projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    elements.sysProjectFilter.dataset.loaded = "true";
  }
  if (visible.includes("package")) {
    await refreshPackageFilterOptions();
  }
  if (visible.includes("devicetype") && elements.sysDeviceTypeFilter.dataset.loaded !== "true") {
    const types = itemsOf(await apiFetch(ENDPOINTS.deviceTypes));
    elements.sysDeviceTypeFilter.innerHTML =
      '<option value="">All device types</option>' +
      types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    elements.sysDeviceTypeFilter.dataset.loaded = "true";
  }
}

async function showSystem(systemKey) {
  const loader = systemLoaders[systemKey];
  if (!loader) return;
  state.currentSystem = systemKey;
  updateAddButton(systemKey);
  if (elements.systemSelect) elements.systemSelect.value = systemKey;
  const addPackageButton = $("#addPackageButton");
  if (addPackageButton) addPackageButton.classList.toggle("hidden", systemKey !== "packages");
  try {
    await populateSystemsFilters(systemKey);
    await loader();
    setView("systems");
  } catch (error) {
    showAlert(`Unable to load ${systemKey}: ${error.message}`);
  }
}

async function reloadCurrentSystem() {
  const loader = systemLoaders[state.currentSystem];
  if (!loader) return;
  try {
    await loader();
  } catch (error) {
    showAlert(`Unable to load ${state.currentSystem}: ${error.message}`);
  }
}

/* ---------------- Contact Details popup (click a technician name) ---------------- */
const contactModal = $("#contactModal");
async function openContactModal(technicianId) {
  const body = $("#contactModalBody");
  body.innerHTML = '<div class="empty-state">Loading contact details...</div>';
  contactModal.classList.remove("hidden");
  try {
    const tech = await apiFetch(`${ENDPOINTS.technicians}/${encodeURIComponent(technicianId)}`);
    $("#contactModalTitle").textContent = tech.name || "Contact Details";
    const rows = [
      ["Title", tech.title],
      ["Company", tech.company_name],
      ["Phone", tech.phone],
      ["Email", tech.email],
      ["Notes", tech.notes]
    ];
    body.innerHTML = `
      <dl class="contact-details">
        ${rows
          .map(
            ([label, value]) => `
          <div class="contact-details-row">
            <dt>${escapeHtml(label)}</dt>
            <dd>${
              label === "Email" && value
                ? `<a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a>`
                : label === "Phone" && value
                ? `<a href="tel:${escapeHtml(value)}">${escapeHtml(value)}</a>`
                : escapeHtml(value ?? "–")
            }</dd>
          </div>`
          )
          .join("")}
      </dl>
    `;
  } catch (error) {
    body.innerHTML = `<div class="empty-state">Unable to load contact details: ${escapeHtml(
      error.message
    )}</div>`;
  }
}
function closeContactModal() {
  contactModal.classList.add("hidden");
}

/* ---------------- Add Service Record (cascading) ---------------- */
const recordModal = $("#recordModal");
const recordForm = $("#recordForm");
const recordCache = { packages: [], schedules: [] };
async function openRecordModal() {
  recordForm.reset();
  $("#recDate").value = new Date().toISOString().slice(0, 10);
  const packageSelect = $("#recPackage");
  const scheduleSelect = $("#recSchedule");
  packageSelect.innerHTML = '<option value="">Select project first</option>';
  packageSelect.disabled = true;
  scheduleSelect.innerHTML = '<option value="">Select package first</option>';
  scheduleSelect.disabled = true;
  try {
    await Promise.all([
      fillProjectSelect("#recProject"),
      fillTechnicianSelect("#recPerformedBy", "Not specified")
    ]);
    recordModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the record form: ${error.message}`);
  }
}
function closeRecordModal() {
  recordModal.classList.add("hidden");
}
async function onRecordProjectChange() {
  const projectId = Number($("#recProject").value);
  const scheduleSelect = $("#recSchedule");
  scheduleSelect.innerHTML = '<option value="">Select package first</option>';
  scheduleSelect.disabled = true;
  try {
    recordCache.packages = await fillPackagesForProject(projectId, "#recPackage");
  } catch (error) {
    showAlert(`Unable to load packages: ${error.message}`);
  }
}
async function onRecordPackageChange() {
  const packageId = Number($("#recPackage").value);
  const scheduleSelect = $("#recSchedule");
  if (!packageId) {
    scheduleSelect.innerHTML = '<option value="">Select package first</option>';
    scheduleSelect.disabled = true;
    return;
  }
  try {
    const scheduleData = await apiFetch(ENDPOINTS.activeSchedules);
    recordCache.schedules = itemsOf(scheduleData).filter(
      (s) => Number(s.package_id) === packageId
    );
    if (!recordCache.schedules.length) {
      scheduleSelect.innerHTML = '<option value="">No schedules for this package</option>';
      scheduleSelect.disabled = true;
      return;
    }
    scheduleSelect.innerHTML =
      '<option value="">Select service schedule</option>' +
      recordCache.schedules
        .map(
          (s) =>
            `<option value="${s.id}">${escapeHtml(s.service_item_name ?? "Service")}${
              s.interval_days ? " — every " + s.interval_days + " days" : ""
            }</option>`
        )
        .join("");
    scheduleSelect.disabled = false;
  } catch (error) {
    showAlert(`Unable to load schedules: ${error.message}`);
  }
}
async function submitRecord(event) {
  event.preventDefault();
  const saveButton = $("#recordSave");
  const scheduleId = Number($("#recSchedule").value);
  const serviceDate = $("#recDate").value;
  if (!scheduleId) {
    showAlert("Project, package and service schedule are required.");
    return;
  }
  if (!serviceDate) {
    showAlert("Service date is required.");
    return;
  }
  const payload = {
    service_schedule_id: scheduleId,
    service_date: serviceDate,
    technician_id: $("#recPerformedBy").value || null,
    work_order_number: $("#recWorkOrder").value.trim() || null,
    remarks: $("#recRemarks").value.trim() || null
  };
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.serviceRecords, payload);
    closeRecordModal();
    showToast("Service record added");
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save record: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save record";
  }
}

/* ---------------- Add Package ---------------- */
const packageModal = $("#packageModal");
const packageForm = $("#packageForm");
async function openPackageModal() {
  packageForm.reset();
  try {
    await Promise.all([
      fillProjectSelect("#packageProject"),
      (async () => {
        const types = itemsOf(await apiFetch(ENDPOINTS.packageTypes + "?active=true"));
        $("#packageType").innerHTML =
          '<option value="">Select package type</option>' +
          types.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
      })()
    ]);
    packageModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the package form: ${error.message}`);
  }
}
function closePackageModal() {
  packageModal.classList.add("hidden");
}
async function submitPackage(event) {
  event.preventDefault();
  const saveButton = $("#packageSave");
  const payload = {
    project_id: Number($("#packageProject").value),
    package_type_id: Number($("#packageType").value),
    name: $("#packageName").value.trim(),
    package_tag: $("#packageTag").value.trim() || null,
    serial_number: $("#packageSerial").value.trim() || null
  };
  if (!payload.project_id || !payload.package_type_id || !payload.name) {
    showAlert("Project, package type and package name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.packages, payload);
    closePackageModal();
    showToast("Package added");
    await loadPackagesView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save package: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save package";
  }
}

/* ---------------- Add Package Type ---------------- */
const packageTypeModal = $("#packageTypeModal");
const packageTypeForm = $("#packageTypeForm");
function openPackageTypeModal() {
  packageTypeForm.reset();
  packageTypeModal.classList.remove("hidden");
  $("#packageTypeName").focus();
}
function closePackageTypeModal() {
  packageTypeModal.classList.add("hidden");
}
async function submitPackageType(event) {
  event.preventDefault();
  const saveButton = $("#packageTypeSave");
  const payload = { name: $("#packageTypeName").value.trim() };
  if (!payload.name) {
    showAlert("Package type name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.packageTypes, payload);
    closePackageTypeModal();
    showToast("Package type added");
    await loadPackageTypesView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save package type: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save package type";
  }
}

/* ---------------- Add Project ---------------- */
const projectModal = $("#projectModal");
const projectForm = $("#projectForm");
async function openProjectModal() {
  projectForm.reset();
  try {
    await Promise.all([
      fillTechnicianSelect("#projContact1", "None"),
      fillTechnicianSelect("#projContact2", "None"),
      fillTechnicianSelect("#projEureka1", "None"),
      fillTechnicianSelect("#projEureka2", "None")
    ]);
    projectModal.classList.remove("hidden");
    $("#projCode").focus();
  } catch (error) {
    showAlert(`Unable to open the project form: ${error.message}`);
  }
}
function closeProjectModal() {
  projectModal.classList.add("hidden");
}
async function submitProject(event) {
  event.preventDefault();
  const saveButton = $("#projectSave");
  const payload = {
    code: $("#projCode").value.trim(),
    name: $("#projName").value.trim(),
    customer: $("#projCustomer").value.trim() || null,
    customer_contact1_id: $("#projContact1").value || null,
    customer_contact2_id: $("#projContact2").value || null,
    eureka_responsible_1_id: $("#projEureka1").value || null,
    eureka_responsible_2_id: $("#projEureka2").value || null,
    notes: $("#projNotes").value.trim() || null
  };
  if (!payload.code || !payload.name) {
    showAlert("Code and name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.projects, payload);
    closeProjectModal();
    showToast("Project added");
    await loadProjectsView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save project: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save project";
  }
}

/* ---------------- Add Service Item ---------------- */
const serviceItemModal = $("#serviceItemModal");
const serviceItemForm = $("#serviceItemForm");
function openServiceItemModal() {
  serviceItemForm.reset();
  serviceItemModal.classList.remove("hidden");
  $("#svcItemName").focus();
}
function closeServiceItemModal() {
  serviceItemModal.classList.add("hidden");
}
async function submitServiceItem(event) {
  event.preventDefault();
  const saveButton = $("#serviceItemSave");
  const payload = {
    name: $("#svcItemName").value.trim(),
    description: $("#svcItemDescription").value.trim() || null
  };
  if (!payload.name) {
    showAlert("Service item name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.serviceItems, payload);
    closeServiceItemModal();
    showToast("Service item added");
    await loadServiceItemsView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save service item: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save service item";
  }
}

/* ---------------- Add Schedule (cascading) ---------------- */
const scheduleModal = $("#scheduleModal");
const scheduleForm = $("#scheduleForm");
const scheduleCache = { packages: [] };
async function openScheduleModal() {
  scheduleForm.reset();
  $("#schedIntervalDays").value = 180;
  $("#schedIntervalHours").value = 250;
  $("#schedWarning").value = 14;
  $("#schedWarningHours").value = 120;
  const trackDays = $("#schedTrackDays");
  const trackHours = $("#schedTrackHours");
  if (trackDays) trackDays.checked = true;
  if (trackHours) trackHours.checked = true;
  $("#schedStartDate").value = new Date().toISOString().slice(0, 10);
  const packageSelect = $("#schedPackage");
  packageSelect.innerHTML = '<option value="">Select project first</option>';
  packageSelect.disabled = true;
  try {
    const [, itemData] = await Promise.all([
      fillProjectSelect("#schedProject"),
      apiFetch(ENDPOINTS.serviceItems + "?active=true")
    ]);
    $("#schedServiceItem").innerHTML =
      '<option value="">Select service item</option>' +
      itemsOf(itemData)
        .map((i) => `<option value="${i.id}">${escapeHtml(i.name)}</option>`)
        .join("");
    scheduleModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the schedule form: ${error.message}`);
  }
}
function closeScheduleModal() {
  scheduleModal.classList.add("hidden");
}
async function onScheduleProjectChange() {
  const projectId = Number($("#schedProject").value);
  try {
    scheduleCache.packages = await fillPackagesForProject(projectId, "#schedPackage");
  } catch (error) {
    showAlert(`Unable to load packages: ${error.message}`);
  }
}
async function submitSchedule(event) {
  event.preventDefault();
  const saveButton = $("#scheduleSave");
  const intervalDaysRaw = $("#schedIntervalDays").value;
  const intervalHoursRaw = $("#schedIntervalHours") ? $("#schedIntervalHours").value : "";
  const warningHoursRaw = $("#schedWarningHours") ? $("#schedWarningHours").value : "";
  const payload = {
    package_id: Number($("#schedPackage").value),
    service_item_id: Number($("#schedServiceItem").value),
    interval_days: intervalDaysRaw === "" ? null : Number(intervalDaysRaw),
    interval_running_hours: intervalHoursRaw === "" ? null : Number(intervalHoursRaw),
    warning_days: $("#schedWarning").value === "" ? 14 : Number($("#schedWarning").value),
    warning_hours: warningHoursRaw === "" ? 120 : Number(warningHoursRaw),
    track_days: $("#schedTrackDays") ? $("#schedTrackDays").checked : true,
    track_running_hours: $("#schedTrackHours") ? $("#schedTrackHours").checked : true,
    schedule_start_date: $("#schedStartDate").value,
    notes: $("#schedNotes").value.trim() || null
  };
  if (!payload.package_id || !payload.service_item_id) {
    showAlert("Project, package and service item are required.");
    return;
  }
  if (payload.interval_days != null && payload.interval_days <= 0) {
    showAlert("Interval (days) must be a positive number when provided.");
    return;
  }
  if (payload.interval_running_hours != null && payload.interval_running_hours <= 0) {
    showAlert("Interval (running hours) must be a positive number when provided.");
    return;
  }
  if (payload.interval_days != null && payload.warning_days > payload.interval_days) {
    showAlert("Warning days cannot exceed the interval (days).");
    return;
  }
  if (payload.interval_running_hours != null && payload.warning_hours > payload.interval_running_hours) {
    showAlert("Warning (running hours) cannot exceed the interval (running hours).");
    return;
  }
  if (!payload.schedule_start_date) {
    showAlert("Start date is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.schedules, payload);
    closeScheduleModal();
    showToast("Schedule added");
    await loadSchedulesView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save schedule: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save schedule";
  }
}

/* ---------------- Add Process Value (pv_attributes) ----------------
 * pv_attributes are global — no package type selection needed. */
const pvAttributeModal = $("#pvAttributeModal");
const pvAttributeForm = $("#pvAttributeForm");
async function openPvAttributeModal() {
  pvAttributeForm.reset();
  try {
    const dataTypes = await apiFetch(ENDPOINTS.pvDataTypes);
    $("#pvAttrDataType").innerHTML =
      '<option value="">Select data type</option>' +
      itemsOf(dataTypes)
        .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
        .join("");
    pvAttributeModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the process value form: ${error.message}`);
  }
}
function closePvAttributeModal() {
  pvAttributeModal.classList.add("hidden");
}
async function submitPvAttribute(event) {
  event.preventDefault();
  const saveButton = $("#pvAttributeSave");
  const payload = {
    data_type_id: Number($("#pvAttrDataType").value),
    name: $("#pvAttrName").value.trim(),
    unit: $("#pvAttrUnit").value.trim() || null,
    description: $("#pvAttrDescription").value.trim() || null
  };
  if (!payload.data_type_id || !payload.name) {
    showAlert("Data type and name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.pvAttributes, payload);
    closePvAttributeModal();
    showToast("Process value added");
    await loadPvAttributesView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save process value: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save process value";
  }
}

/* ---------------- Add Reading (cascading, dynamic value input) ----------------
 * pv_attributes are global, so the process-value dropdown no longer
 * depends on which package's type was selected — every active process
 * value is available regardless of package. */
const readingModal = $("#readingModal");
const readingForm = $("#readingForm");
const readingCache = { packages: [], attributes: [] };
async function openReadingModal() {
  readingForm.reset();
  $("#rdReadingDate").value = new Date().toISOString().slice(0, 10);
  const packageSelect = $("#rdPackage");
  const attributeSelect = $("#rdAttribute");
  packageSelect.innerHTML = '<option value="">Select project first</option>';
  packageSelect.disabled = true;
  attributeSelect.innerHTML = '<option value="">Select package first</option>';
  attributeSelect.disabled = true;
  resetReadingValueField();
  try {
    await Promise.all([
      fillProjectSelect("#rdProject"),
      fillTechnicianSelect("#rdPerformedBy", "Not specified")
    ]);
    readingModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the reading form: ${error.message}`);
  }
}
function closeReadingModal() {
  readingModal.classList.add("hidden");
}
function resetReadingValueField(message = "Select a process value first") {
  $("#rdValueField").innerHTML = `
    <label for="rdValueInput" id="rdValueLabel">Value <em>*</em></label>
    <input id="rdValueInput" type="text" disabled placeholder="${escapeHtml(message)}" />
  `;
}
async function onReadingProjectChange() {
  const projectId = Number($("#rdProject").value);
  const attributeSelect = $("#rdAttribute");
  attributeSelect.innerHTML = '<option value="">Select package first</option>';
  attributeSelect.disabled = true;
  resetReadingValueField();
  try {
    readingCache.packages = await fillPackagesForProject(projectId, "#rdPackage");
  } catch (error) {
    showAlert(`Unable to load packages: ${error.message}`);
  }
}
async function onReadingPackageChange() {
  const packageId = Number($("#rdPackage").value);
  const attributeSelect = $("#rdAttribute");
  resetReadingValueField();
  if (!packageId) {
    attributeSelect.innerHTML = '<option value="">Select package first</option>';
    attributeSelect.disabled = true;
    return;
  }
  try {
    const data = await apiFetch(`${ENDPOINTS.pvAttributes}?active=true`);
    readingCache.attributes = itemsOf(data);
    if (!readingCache.attributes.length) {
      attributeSelect.innerHTML = '<option value="">No process values defined yet</option>';
      attributeSelect.disabled = true;
      return;
    }
    attributeSelect.innerHTML =
      '<option value="">Select process value</option>' +
      readingCache.attributes
        .map(
          (a) =>
            `<option value="${a.id}">${escapeHtml(a.name)}${
              a.unit ? " (" + escapeHtml(a.unit) + ")" : ""
            }</option>`
        )
        .join("");
    attributeSelect.disabled = false;
  } catch (error) {
    showAlert(`Unable to load process values: ${error.message}`);
  }
}
function onReadingAttributeChange() {
  const attributeId = Number($("#rdAttribute").value);
  if (!attributeId) {
    resetReadingValueField();
    return;
  }
  const attribute = readingCache.attributes.find((a) => Number(a.id) === attributeId);
  if (!attribute) {
    resetReadingValueField();
    return;
  }
  const labelText = attribute.unit ? `Value (${attribute.unit}) ` : "Value ";
  let inputHtml;
  if (attribute.data_type_name === "boolean") {
    inputHtml = `
      <select id="rdValueInput" required>
        <option value="">Select...</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    `;
  } else if (attribute.data_type_name === "numeric") {
    inputHtml = `<input id="rdValueInput" type="number" step="any" required placeholder="e.g. 1250.5" />`;
  } else {
    inputHtml = `<input id="rdValueInput" type="text" required placeholder="Enter a value" />`;
  }
  $("#rdValueField").innerHTML = `
    <label for="rdValueInput" id="rdValueLabel">${escapeHtml(labelText)}<em>*</em></label>
    ${inputHtml}
  `;
}
async function submitReading(event) {
  event.preventDefault();
  const saveButton = $("#readingSave");
  const packageId = Number($("#rdPackage").value);
  const attributeId = Number($("#rdAttribute").value);
  const readingDate = $("#rdReadingDate").value;
  const valueInput = $("#rdValueInput");
  const rawValue = valueInput ? valueInput.value : "";
  if (!packageId) {
    showAlert("Project and package are required.");
    return;
  }
  if (!attributeId) {
    showAlert("Process value is required.");
    return;
  }
  if (!readingDate) {
    showAlert("Reading date is required.");
    return;
  }
  if (rawValue === "" || rawValue === undefined) {
    showAlert("A value is required.");
    return;
  }
  const attribute = readingCache.attributes.find((a) => Number(a.id) === attributeId);
  let value;
  if (attribute && attribute.data_type_name === "boolean") {
    if (rawValue !== "true" && rawValue !== "false") {
      showAlert("Select Yes or No for this process value.");
      return;
    }
    value = rawValue === "true";
  } else if (attribute && attribute.data_type_name === "numeric") {
    value = Number(rawValue);
    if (!Number.isFinite(value)) {
      showAlert("Enter a valid number for this process value.");
      return;
    }
  } else {
    value = rawValue;
  }
  const payload = {
    package_id: packageId,
    pv_attribute_id: attributeId,
    value,
    reading_date: readingDate,
    technician_id: $("#rdPerformedBy").value || null,
    notes: $("#rdNotes").value.trim() || null
  };
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.pvLog, payload);
    closeReadingModal();
    showToast("Reading added");
    await loadReadings();
  } catch (error) {
    showAlert(`Unable to save reading: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save reading";
  }
}

/* ---------------- Add Manufacturer ---------------- */
const manufacturerModal = $("#manufacturerModal");
const manufacturerForm = $("#manufacturerForm");
async function openManufacturerModal() {
  manufacturerForm.reset();
  try {
    await Promise.all([
      fillTechnicianSelect("#mfrContact1", "None"),
      fillTechnicianSelect("#mfrContact2", "None"),
      fillTechnicianSelect("#mfrEureka1", "None"),
      fillTechnicianSelect("#mfrEureka2", "None")
    ]);
    manufacturerModal.classList.remove("hidden");
    $("#mfrName").focus();
  } catch (error) {
    showAlert(`Unable to open the manufacturer form: ${error.message}`);
  }
}
function closeManufacturerModal() {
  manufacturerModal.classList.add("hidden");
}
async function submitManufacturer(event) {
  event.preventDefault();
  const saveButton = $("#manufacturerSave");
  const payload = {
    name: $("#mfrName").value.trim(),
    website: $("#mfrWebsite").value.trim() || null,
    notes: $("#mfrNotes").value.trim() || null,
    contact1_id: $("#mfrContact1").value || null,
    contact2_id: $("#mfrContact2").value || null,
    eureka_responsible_1_id: $("#mfrEureka1").value || null,
    eureka_responsible_2_id: $("#mfrEureka2").value || null
  };
  if (!payload.name) {
    showAlert("Manufacturer name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.manufacturers, payload);
    closeManufacturerModal();
    showToast("Manufacturer added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save manufacturer: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save manufacturer";
  }
}

/* ---------------- Add Device Type ---------------- */
const deviceTypeModal = $("#deviceTypeModal");
const deviceTypeForm = $("#deviceTypeForm");
function openDeviceTypeModal() {
  deviceTypeForm.reset();
  deviceTypeModal.classList.remove("hidden");
  $("#deviceTypeName").focus();
}
function closeDeviceTypeModal() {
  deviceTypeModal.classList.add("hidden");
}
async function submitDeviceType(event) {
  event.preventDefault();
  const saveButton = $("#deviceTypeSave");
  const payload = { name: $("#deviceTypeName").value.trim() };
  if (!payload.name) {
    showAlert("Device type name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.deviceTypes, payload);
    closeDeviceTypeModal();
    showToast("Device type added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save device type: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save device type";
  }
}

/* ---------------- Add Check Type ---------------- */
const checkTypeModal = $("#checkTypeModal");
const checkTypeForm = $("#checkTypeForm");
function openCheckTypeModal() {
  checkTypeForm.reset();
  checkTypeModal.classList.remove("hidden");
  $("#checkTypeName").focus();
}
function closeCheckTypeModal() {
  checkTypeModal.classList.add("hidden");
}
async function submitCheckType(event) {
  event.preventDefault();
  const saveButton = $("#checkTypeSave");
  const payload = { name: $("#checkTypeName").value.trim() };
  if (!payload.name) {
    showAlert("Check type name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.checkTypes, payload);
    closeCheckTypeModal();
    showToast("Check type added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save check type: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save check type";
  }
}

/* ---------------- Add Version Source ---------------- */
const versionSourceModal = $("#versionSourceModal");
const versionSourceForm = $("#versionSourceForm");
function openVersionSourceModal() {
  versionSourceForm.reset();
  versionSourceModal.classList.remove("hidden");
  $("#versionSourceName").focus();
}
function closeVersionSourceModal() {
  versionSourceModal.classList.add("hidden");
}
async function submitVersionSource(event) {
  event.preventDefault();
  const saveButton = $("#versionSourceSave");
  const payload = { name: $("#versionSourceName").value.trim() };
  if (!payload.name) {
    showAlert("Version source name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.versionSources, payload);
    closeVersionSourceModal();
    showToast("Version source added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save version source: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save version source";
  }
}

/* ---------------- Add Technician ---------------- */
const technicianModal = $("#technicianModal");
const technicianForm = $("#technicianForm");
function openTechnicianModal() {
  technicianForm.reset();
  technicianModal.classList.remove("hidden");
  $("#techName").focus();
}
function closeTechnicianModal() {
  technicianModal.classList.add("hidden");
}
async function submitTechnician(event) {
  event.preventDefault();
  const saveButton = $("#technicianSave");
  const payload = {
    name: $("#techName").value.trim(),
    title: $("#techTitle").value.trim() || null,
    company_name: $("#techCompany").value.trim() || null,
    phone: $("#techPhone").value.trim() || null,
    email: $("#techEmail").value.trim() || null,
    notes: $("#techNotes").value.trim() || null
  };
  if (!payload.name) {
    showAlert("Technician name is required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.technicians, payload);
    closeTechnicianModal();
    showToast("Technician added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save technician: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save technician";
  }
}

/* ---------------- Add Device ---------------- */
const deviceModal = $("#deviceModal");
const deviceForm = $("#deviceForm");
async function openDeviceModal() {
  deviceForm.reset();
  $("#devHardwareVersion").value = "X";
  try {
    const [manufacturers, deviceTypes] = await Promise.all([
      apiFetch(ENDPOINTS.manufacturers + "?active=true"),
      apiFetch(ENDPOINTS.deviceTypes + "?active=true")
    ]);
    $("#devManufacturer").innerHTML =
      '<option value="">Select manufacturer</option>' +
      itemsOf(manufacturers).map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
    $("#devDeviceType").innerHTML =
      '<option value="">Select device type</option>' +
      itemsOf(deviceTypes).map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    deviceModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the device form: ${error.message}`);
  }
}
function closeDeviceModal() {
  deviceModal.classList.add("hidden");
}
async function submitDevice(event) {
  event.preventDefault();
  const saveButton = $("#deviceSave");
  const payload = {
    manufacturer_id: Number($("#devManufacturer").value),
    device_type_id: Number($("#devDeviceType").value),
    name: $("#devName").value.trim(),
    order_number: $("#devOrderNumber").value.trim() || null,
    hardware_version: $("#devHardwareVersion").value.trim() || "X"
  };
  if (!payload.manufacturer_id || !payload.device_type_id || !payload.name) {
    showAlert("Manufacturer, device type and name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.devices, payload);
    closeDeviceModal();
    showToast("Device added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save device: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save device";
  }
}

/* ---------------- Add Version Log ---------------- */
const versionLogModal = $("#versionLogModal");
const versionLogForm = $("#versionLogForm");
async function openVersionLogModal() {
  versionLogForm.reset();
  const latest = $("#vlIsApprovedLatest");
  if (latest) latest.checked = false;
  try {
    const [devices, checkTypes] = await Promise.all([
      apiFetch(ENDPOINTS.devices + "?active=true"),
      apiFetch(ENDPOINTS.checkTypes),
      fillTechnicianSelect("#vlConfirmedBy", "Not yet confirmed")
    ]);
    $("#vlDevice").innerHTML =
      '<option value="">Select device</option>' +
      itemsOf(devices)
        .map(
          (d) =>
            `<option value="${d.id}">${escapeHtml(
              `${d.manufacturer_name} - ${d.name} (${d.hardware_version})`
            )}</option>`
        )
        .join("");
    $("#vlCheckType").innerHTML =
      '<option value="">Select check type</option>' +
      itemsOf(checkTypes).map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    versionLogModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the version log form: ${error.message}`);
  }
}
function closeVersionLogModal() {
  versionLogModal.classList.add("hidden");
}
async function submitVersionLog(event) {
  event.preventDefault();
  const saveButton = $("#versionLogSave");
  const payload = {
    device_id: Number($("#vlDevice").value),
    check_type_id: Number($("#vlCheckType").value),
    version: $("#vlVersion").value.trim() || null,
    release_date: $("#vlReleaseDate").value || null,
    eos_date: $("#vlEosDate").value || null,
    eol_date: $("#vlEolDate").value || null,
    confirmed_by_id: $("#vlConfirmedBy").value || null,
    confirm_date: $("#vlConfirmDate").value || null,
    is_approved_latest: $("#vlIsApprovedLatest").checked,
    notes: $("#vlNotes").value.trim() || null
  };
  if (!payload.device_id || !payload.check_type_id) {
    showAlert("Device and check type are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.versionLogs, payload);
    closeVersionLogModal();
    showToast("Version log added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save version log: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save version log";
  }
}

/* ---------------- Add Package Device ---------------- */
const packageDeviceModal = $("#packageDeviceModal");
const packageDeviceForm = $("#packageDeviceForm");
const packageDeviceCache = { packages: [], versionLogs: [] };
async function openPackageDeviceModal() {
  packageDeviceForm.reset();
  const spare = $("#pdIsSparePart");
  if (spare) spare.checked = false;
  const packageSelect = $("#pdPackage");
  packageSelect.innerHTML = '<option value="">Select project first</option>';
  packageSelect.disabled = true;
  resetFirmwareVersionLogField();
  try {
    await Promise.all([
      fillProjectSelect("#pdProject"),
      (async () => {
        const devices = itemsOf(await apiFetch(ENDPOINTS.devices + "?active=true"));
        $("#pdDevice").innerHTML =
          '<option value="">Select device</option>' +
          devices
            .map(
              (d) =>
                `<option value="${d.id}">${escapeHtml(
                  `${d.manufacturer_name} - ${d.name} (${d.hardware_version})`
                )}</option>`
            )
            .join("");
      })(),
      fillTechnicianSelect("#pdInstalledBy", "None"),
      fillTechnicianSelect("#pdFirmwareInstalledBy", "None")
    ]);
    packageDeviceModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the package device form: ${error.message}`);
  }
}
function closePackageDeviceModal() {
  packageDeviceModal.classList.add("hidden");
}
function resetFirmwareVersionLogField(message = "Select a device first") {
  const select = $("#pdFirmwareVersionLog");
  if (!select) return;
  select.innerHTML = `<option value="">${escapeHtml(message)}</option>`;
  select.disabled = true;
}
async function onPackageDeviceProjectChange() {
  const projectId = Number($("#pdProject").value);
  try {
    packageDeviceCache.packages = await fillPackagesForProject(projectId, "#pdPackage");
  } catch (error) {
    showAlert(`Unable to load packages: ${error.message}`);
  }
}
async function onPackageDeviceDeviceChange() {
  const deviceId = Number($("#pdDevice").value);
  const select = $("#pdFirmwareVersionLog");
  if (!deviceId) {
    resetFirmwareVersionLogField();
    return;
  }
  try {
    const data = await apiFetch(`${ENDPOINTS.versionLogs}?device_id=${encodeURIComponent(deviceId)}`);
    packageDeviceCache.versionLogs = itemsOf(data);
    if (!packageDeviceCache.versionLogs.length) {
      select.innerHTML = '<option value="">No confirmed versions for this device yet</option>';
      select.disabled = true;
      return;
    }
    select.innerHTML =
      '<option value="">None</option>' +
      packageDeviceCache.versionLogs
        .map((v) => {
          const label = `${v.check_type_name}: ${v.version ?? "(no version)"}${
            v.is_approved_latest ? " — latest" : ""
          }`;
          return `<option value="${v.id}">${escapeHtml(label)}</option>`;
        })
        .join("");
    select.disabled = false;
  } catch (error) {
    showAlert(`Unable to load version logs for this device: ${error.message}`);
  }
}
async function submitPackageDevice(event) {
  event.preventDefault();
  const saveButton = $("#packageDeviceSave");
  const payload = {
    package_id: Number($("#pdPackage").value),
    device_id: Number($("#pdDevice").value),
    tag_name: $("#pdTagName").value.trim(),
    serial_number: $("#pdSerialNumber").value.trim() || null,
    is_spare_part: $("#pdIsSparePart").checked,
    install_date: $("#pdInstallDate").value || null,
    installed_by_id: $("#pdInstalledBy").value || null,
    firmware_install_date: $("#pdFirmwareInstallDate").value || null,
    firmware_installed_by_id: $("#pdFirmwareInstalledBy").value || null,
    firmware_version_log_id: $("#pdFirmwareVersionLog").value || null,
    notes: $("#pdNotes").value.trim() || null
  };
  if (!payload.package_id || !payload.device_id || !payload.tag_name) {
    showAlert("Project, package, device and tag name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.packageDevices, payload);
    closePackageDeviceModal();
    showToast("Package device added");
    await reloadCurrentSystem();
  } catch (error) {
    showAlert(`Unable to save package device: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save package device";
  }
}

/* ---------------- Add button dispatcher (Systems categories only) ---------------- */
function updateAddButton(systemKey) {
  const btn = $("#addSystemButton");
  if (!btn) return;
  const map = {
    projects: { label: "+ Add Project", open: openProjectModal },
    packagetypes: { label: "+ Add Package Type", open: openPackageTypeModal },
    serviceitems: { label: "+ Add Service Item", open: openServiceItemModal },
    schedules: { label: "+ Add Schedule", open: openScheduleModal },
    pvattributes: { label: "+ Add Process Value", open: openPvAttributeModal },
    manufacturers: { label: "+ Add Manufacturer", open: openManufacturerModal },
    devices: { label: "+ Add Device", open: openDeviceModal },
    devicetypes: { label: "+ Add Device Type", open: openDeviceTypeModal },
    checktypes: { label: "+ Add Check Type", open: openCheckTypeModal },
    versionsources: { label: "+ Add Version Source", open: openVersionSourceModal },
    versionlogs: { label: "+ Add Version Log", open: openVersionLogModal },
    technicians: { label: "+ Add Technician", open: openTechnicianModal },
    packagedevices: { label: "+ Add Package Device", open: openPackageDeviceModal }
  };
  const cfg = map[systemKey];
  if (cfg) {
    btn.textContent = cfg.label;
    btn.classList.remove("hidden");
    btn.onclick = cfg.open;
  } else {
    btn.classList.add("hidden");
    btn.onclick = null;
  }
}

/* ---------------- Events ---------------- */
function bindEvents() {
  $$(".nav-item").forEach((item) =>
    item.addEventListener("click", () => {
      const view = item.dataset.view;
      if (view === "systems") {
        showSystem(state.currentSystem || "projects");
      } else {
        setView(view);
      }
    })
  );
  $$("[data-go-view]").forEach((item) =>
    item.addEventListener("click", () => setView(item.dataset.goView))
  );
  $$("[data-status-filter]").forEach((card) =>
    card.addEventListener("click", () => {
      elements.statusFilter.value = card.dataset.statusFilter;
      renderStatusTable();
      setView("maintenance");
    })
  );
  $$("[data-system-view]").forEach((item) =>
    item.addEventListener("click", () => showSystem(item.dataset.systemView))
  );
  if (elements.systemSelect) {
    elements.systemSelect.addEventListener("change", () =>
      showSystem(elements.systemSelect.value)
    );
  }
  elements.statusFilter.addEventListener("change", renderStatusTable);
  elements.statusSearch.addEventListener("input", renderStatusTable);
  elements.recentLimit.addEventListener("change", async () => {
    try {
      await loadRecent();
    } catch (error) {
      showAlert(`Unable to load recent records: ${error.message}`);
    }
  });
  elements.recentProjectFilter.addEventListener("change", applyRecentFilters);
  elements.recentPackageFilter.addEventListener("change", applyRecentFilters);
  elements.recentServiceItemFilter.addEventListener("change", applyRecentFilters);
  elements.recentSort.addEventListener("change", applyRecentFilters);
  $("#addReadingButton").addEventListener("click", openReadingModal);
  elements.readingsProjectFilter.addEventListener("change", applyReadingsFilters);
  elements.readingsPackageFilter.addEventListener("change", applyReadingsFilters);
  elements.readingsAttributeFilter.addEventListener("change", applyReadingsFilters);
  elements.readingsSort.addEventListener("change", applyReadingsFilters);
  elements.refreshButton.addEventListener("click", () => loadAll({ notify: true }));
  if (elements.sysManufacturerFilter) {
    elements.sysManufacturerFilter.addEventListener("change", async () => {
      if (state.currentSystem === "versionlogs") {
        await refreshDeviceFilterOptions();
      }
      await reloadCurrentSystem();
    });
  }
  if (elements.sysDeviceFilter) {
    elements.sysDeviceFilter.addEventListener("change", reloadCurrentSystem);
  }
  if (elements.sysProjectFilter) {
    elements.sysProjectFilter.addEventListener("change", async () => {
      await refreshPackageFilterOptions();
      await reloadCurrentSystem();
    });
  }
  if (elements.sysPackageFilter) {
    elements.sysPackageFilter.addEventListener("change", reloadCurrentSystem);
  }
  if (elements.sysDeviceTypeFilter) {
    elements.sysDeviceTypeFilter.addEventListener("change", reloadCurrentSystem);
  }
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest(".contact-link");
    if (trigger) {
      const techId = trigger.dataset.techId;
      if (techId) openContactModal(techId);
    }
  });
  $("#contactModalClose").addEventListener("click", closeContactModal);
  contactModal.addEventListener("click", (event) => {
    if (event.target === contactModal) closeContactModal();
  });
  $("#addRecordButton").addEventListener("click", openRecordModal);
  $("#recordModalClose").addEventListener("click", closeRecordModal);
  $("#recordCancel").addEventListener("click", closeRecordModal);
  recordForm.addEventListener("submit", submitRecord);
  recordModal.addEventListener("click", (event) => {
    if (event.target === recordModal) closeRecordModal();
  });
  $("#recProject").addEventListener("change", onRecordProjectChange);
  $("#recPackage").addEventListener("change", onRecordPackageChange);
  $("#projectModalClose").addEventListener("click", closeProjectModal);
  $("#projectCancel").addEventListener("click", closeProjectModal);
  projectForm.addEventListener("submit", submitProject);
  projectModal.addEventListener("click", (event) => {
    if (event.target === projectModal) closeProjectModal();
  });
  $("#addPackageButton").addEventListener("click", openPackageModal);
  $("#packageModalClose").addEventListener("click", closePackageModal);
  $("#packageCancel").addEventListener("click", closePackageModal);
  packageForm.addEventListener("submit", submitPackage);
  packageModal.addEventListener("click", (event) => {
    if (event.target === packageModal) closePackageModal();
  });
  $("#packageTypeModalClose").addEventListener("click", closePackageTypeModal);
  $("#packageTypeCancel").addEventListener("click", closePackageTypeModal);
  packageTypeForm.addEventListener("submit", submitPackageType);
  packageTypeModal.addEventListener("click", (event) => {
    if (event.target === packageTypeModal) closePackageTypeModal();
  });
  $("#serviceItemModalClose").addEventListener("click", closeServiceItemModal);
  $("#serviceItemCancel").addEventListener("click", closeServiceItemModal);
  serviceItemForm.addEventListener("submit", submitServiceItem);
  serviceItemModal.addEventListener("click", (event) => {
    if (event.target === serviceItemModal) closeServiceItemModal();
  });
  $("#scheduleModalClose").addEventListener("click", closeScheduleModal);
  $("#scheduleCancel").addEventListener("click", closeScheduleModal);
  scheduleForm.addEventListener("submit", submitSchedule);
  scheduleModal.addEventListener("click", (event) => {
    if (event.target === scheduleModal) closeScheduleModal();
  });
  $("#schedProject").addEventListener("change", onScheduleProjectChange);
  $("#pvAttributeModalClose").addEventListener("click", closePvAttributeModal);
  $("#pvAttributeCancel").addEventListener("click", closePvAttributeModal);
  pvAttributeForm.addEventListener("submit", submitPvAttribute);
  pvAttributeModal.addEventListener("click", (event) => {
    if (event.target === pvAttributeModal) closePvAttributeModal();
  });
  $("#readingModalClose").addEventListener("click", closeReadingModal);
  $("#readingCancel").addEventListener("click", closeReadingModal);
  readingForm.addEventListener("submit", submitReading);
  readingModal.addEventListener("click", (event) => {
    if (event.target === readingModal) closeReadingModal();
  });
  $("#rdProject").addEventListener("change", onReadingProjectChange);
  $("#rdPackage").addEventListener("change", onReadingPackageChange);
  $("#rdAttribute").addEventListener("change", onReadingAttributeChange);
  $("#manufacturerModalClose").addEventListener("click", closeManufacturerModal);
  $("#manufacturerCancel").addEventListener("click", closeManufacturerModal);
  manufacturerForm.addEventListener("submit", submitManufacturer);
  manufacturerModal.addEventListener("click", (event) => {
    if (event.target === manufacturerModal) closeManufacturerModal();
  });
  $("#deviceTypeModalClose").addEventListener("click", closeDeviceTypeModal);
  $("#deviceTypeCancel").addEventListener("click", closeDeviceTypeModal);
  deviceTypeForm.addEventListener("submit", submitDeviceType);
  deviceTypeModal.addEventListener("click", (event) => {
    if (event.target === deviceTypeModal) closeDeviceTypeModal();
  });
  $("#checkTypeModalClose").addEventListener("click", closeCheckTypeModal);
  $("#checkTypeCancel").addEventListener("click", closeCheckTypeModal);
  checkTypeForm.addEventListener("submit", submitCheckType);
  checkTypeModal.addEventListener("click", (event) => {
    if (event.target === checkTypeModal) closeCheckTypeModal();
  });
  $("#versionSourceModalClose").addEventListener("click", closeVersionSourceModal);
  $("#versionSourceCancel").addEventListener("click", closeVersionSourceModal);
  versionSourceForm.addEventListener("submit", submitVersionSource);
  versionSourceModal.addEventListener("click", (event) => {
    if (event.target === versionSourceModal) closeVersionSourceModal();
  });
  $("#technicianModalClose").addEventListener("click", closeTechnicianModal);
  $("#technicianCancel").addEventListener("click", closeTechnicianModal);
  technicianForm.addEventListener("submit", submitTechnician);
  technicianModal.addEventListener("click", (event) => {
    if (event.target === technicianModal) closeTechnicianModal();
  });
  $("#deviceModalClose").addEventListener("click", closeDeviceModal);
  $("#deviceCancel").addEventListener("click", closeDeviceModal);
  deviceForm.addEventListener("submit", submitDevice);
  deviceModal.addEventListener("click", (event) => {
    if (event.target === deviceModal) closeDeviceModal();
  });
  $("#versionLogModalClose").addEventListener("click", closeVersionLogModal);
  $("#versionLogCancel").addEventListener("click", closeVersionLogModal);
  versionLogForm.addEventListener("submit", submitVersionLog);
  versionLogModal.addEventListener("click", (event) => {
    if (event.target === versionLogModal) closeVersionLogModal();
  });
  $("#packageDeviceModalClose").addEventListener("click", closePackageDeviceModal);
  $("#packageDeviceCancel").addEventListener("click", closePackageDeviceModal);
  packageDeviceForm.addEventListener("submit", submitPackageDevice);
  packageDeviceModal.addEventListener("click", (event) => {
    if (event.target === packageDeviceModal) closePackageDeviceModal();
  });
  $("#pdProject").addEventListener("change", onPackageDeviceProjectChange);
  $("#pdDevice").addEventListener("change", onPackageDeviceDeviceChange);
  elements.menuButton.addEventListener("click", () =>
    elements.sidebar.classList.contains("open") ? closeSidebar() : openSidebar()
  );
  elements.sidebarBackdrop.addEventListener("click", closeSidebar);
  window.addEventListener("online", () => loadAll({ notify: true }));
  window.addEventListener("offline", () => {
    setConnection(false);
    showAlert("The browser is offline. Previously loaded information remains visible.");
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("/service-worker.js");
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  registerServiceWorker();
  loadAll();
});

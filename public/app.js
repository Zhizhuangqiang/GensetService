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
  technicians: "/api/technicians"
};

const state = {
  dashboard: null,
  statuses: [],
  recent: [],
  currentView: "dashboard",
  currentSystem: "projects",
  loading: false,
  recentFilters: {
    projectId: "",
    packageId: "",
    serviceItemId: "",
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
  systemSelect: $("#systemSelect")
};

const viewMetadata = {
  dashboard: ["Dashboard", "Package maintenance overview"],
  maintenance: ["Service Status", "Current maintenance condition for every active schedule"],
  recent: ["Recent Service", "Completed package maintenance records"],
  systems: ["Systems", "Projects, packages, service items, schedules, process values and technicians"]
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

/* Renders "Name" or "Name · Company" for a technician reference on a
 * record/reading row. Falls back to a dash when no technician is set. */
function technicianCell(name, company) {
  if (!name) return "–";
  return company
    ? `${escapeHtml(name)}<br><small>${escapeHtml(company)}</small>`
    : escapeHtml(name);
}

/* Label used inside <option> elements: "Name — Company" when a company
 * is on file, otherwise just "Name". */
function technicianOptionLabel(t) {
  return t.company_name ? `${t.name} — ${t.company_name}` : t.name;
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

/* Populate a <select> with active technicians, shown as "Name — Company".
 * Always includes a blank "no technician" option since technician_id is
 * optional on both service records and readings. */
async function fillTechnicianSelect(selectId) {
  const technicians = itemsOf(await apiFetch(ENDPOINTS.technicians + "?active=true"));
  $(selectId).innerHTML =
    '<option value="">Select technician</option>' +
    technicians
      .map((t) => `<option value="${t.id}">${escapeHtml(technicianOptionLabel(t))}</option>`)
      .join("");
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
      <td>${formatNumber(item.interval_days)} days${
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

/* ---------------- Recent Service: rows, filters, sort ---------------- */
function recentRows(items) {
  return items
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${packageCell(item.package_name, item.package_type_name, item.package_tag)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${technicianCell(item.technician_name, item.technician_company)}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
      <td>${formatNumber(item.attachment_count)}</td>
    </tr>
  `
    )
    .join("");
}

/* Dashboard mini-widget: always shows the latest 5 from the raw fetch,
 * unaffected by the Recent Service page's filters/sort. */
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
      <td>${technicianCell(item.technician_name, item.technician_company)}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
    </tr>
  `
    )
    .join("");
  $("#dashboardRecentEmpty").classList.toggle("hidden", state.recent.length > 0);
}

/* Rebuilds the Project / Package / Service Item filter dropdowns from
 * whatever records are currently loaded (the batch defined by the
 * "Number of records" selector), preserving the user's current
 * selections where still valid. */
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

/* Applies the Project / Package / Service Item filters and the date
 * sort order to the loaded batch, then renders the main Recent Service
 * table. This never re-fetches — it only re-slices/sorts state.recent. */
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

async function loadReadingsCount() {
  try {
    const data = await apiFetch(ENDPOINTS.pvLog);
    const el = $("#readingsCount");
    if (el) el.textContent = formatNumber(data.count ?? itemsOf(data).length);
  } catch (error) {
    // Non-fatal for the dashboard; leave the count as-is.
    console.warn("Readings count unavailable", error);
  }
}

async function loadTechniciansCount() {
  try {
    const data = await apiFetch(ENDPOINTS.technicians);
    const el = $("#techniciansCount");
    if (el) el.textContent = formatNumber(data.count ?? itemsOf(data).length);
  } catch (error) {
    console.warn("Technicians count unavailable", error);
  }
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
    renderDashboard(dashboard);
    renderNextDue();
    renderStatusTable();
    loadReadingsCount();
    loadTechniciansCount();
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
    `<tr><th>ID</th><th>Code</th><th>Name</th><th>Active</th></tr>`,
    projects
      .map(
        (p) => `
      <tr>
        <td>${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.code ?? "–")}</td>
        <td>${escapeHtml(p.name)}</td>
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
    `<tr><th>ID</th><th>Project</th><th>Package</th><th>Service Item</th><th>Start Date</th><th>Interval (days)</th><th>Interval (hours)</th><th>Warning (days)</th><th>Track Days</th><th>Track Hours</th><th>Active</th></tr>`,
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
    "Loggable readings defined per package type",
    `<tr><th>ID</th><th>Package Type</th><th>Name</th><th>Data Type</th><th>Unit</th><th>Description</th><th>Active</th></tr>`,
    attributes
      .map(
        (a) => `
      <tr>
        <td>${escapeHtml(a.id)}</td>
        <td>${escapeHtml(a.package_type_name ?? "–")}</td>
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

async function loadReadingsView() {
  const readings = itemsOf(await apiFetch(ENDPOINTS.pvLog));
  renderSystemsTable(
    "Readings",
    "Logged process value readings",
    `<tr><th>ID</th><th>Project</th><th>Package</th><th>Process Value</th><th>Value</th><th>Reading Date</th><th>Technician</th><th>Recorded</th></tr>`,
    readings
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.id)}</td>
        <td>${escapeHtml(r.project_name ?? "–")}</td>
        <td>${packageCell(r.package_name, null, r.package_tag)}</td>
        <td>${escapeHtml(r.attribute_name ?? "–")}</td>
        <td>${formatPvValue(r.value, r.data_type_name, r.unit)}</td>
        <td>${formatDate(r.reading_date)}</td>
        <td>${technicianCell(r.technician_name, r.technician_company)}</td>
        <td>${formatDateTime(r.created_at)}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadTechniciansView() {
  const technicians = itemsOf(await apiFetch(ENDPOINTS.technicians));
  renderSystemsTable(
    "Technicians",
    "People who perform service work and record readings",
    `<tr><th>ID</th><th>Name</th><th>Title</th><th>Company</th><th>Phone</th><th>Email</th><th>Active</th></tr>`,
    technicians
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

const systemLoaders = {
  projects: loadProjectsView,
  packages: loadPackagesView,
  packagetypes: loadPackageTypesView,
  serviceitems: loadServiceItemsView,
  schedules: loadSchedulesView,
  pvattributes: loadPvAttributesView,
  readings: loadReadingsView,
  technicians: loadTechniciansView
};

async function showSystem(systemKey) {
  const loader = systemLoaders[systemKey];
  if (!loader) return;
  state.currentSystem = systemKey;
  updateAddButton(systemKey);
  if (elements.systemSelect) elements.systemSelect.value = systemKey;
  const addPackageButton = $("#addPackageButton");
  if (addPackageButton) addPackageButton.classList.toggle("hidden", systemKey !== "packages");
  try {
    await loader();
    setView("systems");
  } catch (error) {
    showAlert(`Unable to load ${systemKey}: ${error.message}`);
  }
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
      fillTechnicianSelect("#recTechnician")
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
  const technicianValue = $("#recTechnician").value;
  const payload = {
    service_schedule_id: scheduleId,
    service_date: serviceDate,
    technician_id: technicianValue ? Number(technicianValue) : null,
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
    showToast("Package type added — Running Hours tracking configured automatically");
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

function openProjectModal() {
  projectForm.reset();
  projectModal.classList.remove("hidden");
  $("#projCode").focus();
}

function closeProjectModal() {
  projectModal.classList.add("hidden");
}

async function submitProject(event) {
  event.preventDefault();
  const saveButton = $("#projectSave");
  const payload = {
    code: $("#projCode").value.trim(),
    name: $("#projName").value.trim()
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
  $("#schedWarning").value = 30;
  const trackDays = $("#schedTrackDays");
  const trackHours = $("#schedTrackHours");
  if (trackDays) trackDays.checked = true;
  if (trackHours) trackHours.checked = false;
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
  const intervalHoursRaw = $("#schedIntervalHours") ? $("#schedIntervalHours").value : "";
  const payload = {
    package_id: Number($("#schedPackage").value),
    service_item_id: Number($("#schedServiceItem").value),
    interval_days: Number($("#schedIntervalDays").value),
    interval_running_hours: intervalHoursRaw === "" ? null : Number(intervalHoursRaw),
    warning_days: $("#schedWarning").value === "" ? 30 : Number($("#schedWarning").value),
    track_days: $("#schedTrackDays") ? $("#schedTrackDays").checked : true,
    track_running_hours: $("#schedTrackHours") ? $("#schedTrackHours").checked : false,
    schedule_start_date: $("#schedStartDate").value,
    notes: $("#schedNotes").value.trim() || null
  };
  if (!payload.package_id || !payload.service_item_id) {
    showAlert("Project, package and service item are required.");
    return;
  }
  if (!payload.interval_days || payload.interval_days <= 0) {
    showAlert("Interval (days) must be a positive number.");
    return;
  }
  if (payload.interval_running_hours != null && payload.interval_running_hours <= 0) {
    showAlert("Interval (running hours) must be a positive number when provided.");
    return;
  }
  if (payload.warning_days > payload.interval_days) {
    showAlert("Warning days cannot exceed the interval (days).");
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

/* ---------------- Add Process Value (pv_attributes) ---------------- */
const pvAttributeModal = $("#pvAttributeModal");
const pvAttributeForm = $("#pvAttributeForm");

async function openPvAttributeModal() {
  pvAttributeForm.reset();
  try {
    const [types, dataTypes] = await Promise.all([
      apiFetch(ENDPOINTS.packageTypes + "?active=true"),
      apiFetch(ENDPOINTS.pvDataTypes)
    ]);
    $("#pvAttrPackageType").innerHTML =
      '<option value="">Select package type</option>' +
      itemsOf(types).map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
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
    package_type_id: Number($("#pvAttrPackageType").value),
    data_type_id: Number($("#pvAttrDataType").value),
    name: $("#pvAttrName").value.trim(),
    unit: $("#pvAttrUnit").value.trim() || null,
    description: $("#pvAttrDescription").value.trim() || null
  };
  if (!payload.package_type_id || !payload.data_type_id || !payload.name) {
    showAlert("Package type, data type and name are required.");
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

/* ---------------- Add Reading (cascading, dynamic value input) ---------------- */
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
      fillTechnicianSelect("#rdTechnician")
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
  const selectedPackage = readingCache.packages.find((pkg) => Number(pkg.id) === packageId);
  const packageTypeId = selectedPackage ? selectedPackage.package_type_id : null;
  if (!packageTypeId) {
    attributeSelect.innerHTML = '<option value="">Unable to determine package type</option>';
    attributeSelect.disabled = true;
    return;
  }
  try {
    const data = await apiFetch(
      `${ENDPOINTS.pvAttributes}?package_type_id=${encodeURIComponent(packageTypeId)}&active=true`
    );
    readingCache.attributes = itemsOf(data);
    if (!readingCache.attributes.length) {
      attributeSelect.innerHTML = '<option value="">No process values defined for this package type</option>';
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

  const technicianValue = $("#rdTechnician").value;
  const payload = {
    package_id: packageId,
    pv_attribute_id: attributeId,
    value,
    reading_date: readingDate,
    technician_id: technicianValue ? Number(technicianValue) : null,
    notes: $("#rdNotes").value.trim() || null
  };

  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.pvLog, payload);
    closeReadingModal();
    showToast("Reading added");
    await loadReadingsView();
    await loadReadingsCount();
  } catch (error) {
    showAlert(`Unable to save reading: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save reading";
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
    await loadTechniciansView();
    await loadTechniciansCount();
  } catch (error) {
    showAlert(`Unable to save technician: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save technician";
  }
}

/* ---------------- Add button dispatcher ---------------- */
// Packages uses its own separate button (#addPackageButton), toggled in showSystem.
function updateAddButton(systemKey) {
  const btn = $("#addSystemButton");
  if (!btn) return;
  const map = {
    projects: { label: "+ Add Project", open: openProjectModal },
    packagetypes: { label: "+ Add Package Type", open: openPackageTypeModal },
    serviceitems: { label: "+ Add Service Item", open: openServiceItemModal },
    schedules: { label: "+ Add Schedule", open: openScheduleModal },
    pvattributes: { label: "+ Add Process Value", open: openPvAttributeModal },
    readings: { label: "+ Add Reading", open: openReadingModal },
    technicians: { label: "+ Add Technician", open: openTechnicianModal }
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
  // Recent Service filters + sort (client-side, no re-fetch)
  elements.recentProjectFilter.addEventListener("change", applyRecentFilters);
  elements.recentPackageFilter.addEventListener("change", applyRecentFilters);
  elements.recentServiceItemFilter.addEventListener("change", applyRecentFilters);
  elements.recentSort.addEventListener("change", applyRecentFilters);

  elements.refreshButton.addEventListener("click", () => loadAll({ notify: true }));

  // Add Service Record modal
  $("#addRecordButton").addEventListener("click", openRecordModal);
  $("#recordModalClose").addEventListener("click", closeRecordModal);
  $("#recordCancel").addEventListener("click", closeRecordModal);
  recordForm.addEventListener("submit", submitRecord);
  recordModal.addEventListener("click", (event) => {
    if (event.target === recordModal) closeRecordModal();
  });
  $("#recProject").addEventListener("change", onRecordProjectChange);
  $("#recPackage").addEventListener("change", onRecordPackageChange);

  // Add Project modal
  $("#projectModalClose").addEventListener("click", closeProjectModal);
  $("#projectCancel").addEventListener("click", closeProjectModal);
  projectForm.addEventListener("submit", submitProject);
  projectModal.addEventListener("click", (event) => {
    if (event.target === projectModal) closeProjectModal();
  });

  // Add Package modal
  $("#addPackageButton").addEventListener("click", openPackageModal);
  $("#packageModalClose").addEventListener("click", closePackageModal);
  $("#packageCancel").addEventListener("click", closePackageModal);
  packageForm.addEventListener("submit", submitPackage);
  packageModal.addEventListener("click", (event) => {
    if (event.target === packageModal) closePackageModal();
  });

  // Add Package Type modal
  $("#packageTypeModalClose").addEventListener("click", closePackageTypeModal);
  $("#packageTypeCancel").addEventListener("click", closePackageTypeModal);
  packageTypeForm.addEventListener("submit", submitPackageType);
  packageTypeModal.addEventListener("click", (event) => {
    if (event.target === packageTypeModal) closePackageTypeModal();
  });

  // Add Service Item modal
  $("#serviceItemModalClose").addEventListener("click", closeServiceItemModal);
  $("#serviceItemCancel").addEventListener("click", closeServiceItemModal);
  serviceItemForm.addEventListener("submit", submitServiceItem);
  serviceItemModal.addEventListener("click", (event) => {
    if (event.target === serviceItemModal) closeServiceItemModal();
  });

  // Add Schedule modal
  $("#scheduleModalClose").addEventListener("click", closeScheduleModal);
  $("#scheduleCancel").addEventListener("click", closeScheduleModal);
  scheduleForm.addEventListener("submit", submitSchedule);
  scheduleModal.addEventListener("click", (event) => {
    if (event.target === scheduleModal) closeScheduleModal();
  });
  $("#schedProject").addEventListener("change", onScheduleProjectChange);

  // Add Process Value modal
  $("#pvAttributeModalClose").addEventListener("click", closePvAttributeModal);
  $("#pvAttributeCancel").addEventListener("click", closePvAttributeModal);
  pvAttributeForm.addEventListener("submit", submitPvAttribute);
  pvAttributeModal.addEventListener("click", (event) => {
    if (event.target === pvAttributeModal) closePvAttributeModal();
  });

  // Add Reading modal
  $("#readingModalClose").addEventListener("click", closeReadingModal);
  $("#readingCancel").addEventListener("click", closeReadingModal);
  readingForm.addEventListener("submit", submitReading);
  readingModal.addEventListener("click", (event) => {
    if (event.target === readingModal) closeReadingModal();
  });
  $("#rdProject").addEventListener("change", onReadingProjectChange);
  $("#rdPackage").addEventListener("change", onReadingPackageChange);
  $("#rdAttribute").addEventListener("change", onReadingAttributeChange);

  // Add Technician modal
  $("#technicianModalClose").addEventListener("click", closeTechnicianModal);
  $("#technicianCancel").addEventListener("click", closeTechnicianModal);
  technicianForm.addEventListener("submit", submitTechnician);
  technicianModal.addEventListener("click", (event) => {
    if (event.target === technicianModal) closeTechnicianModal();
  });

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

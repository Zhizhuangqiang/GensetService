"use strict";
/* ------------------------------------------------------------------
 * API endpoints in ONE place.
 * ------------------------------------------------------------------ */
const ENDPOINTS = {
  dashboard: "/api/dashboard",
  serviceStatus: "/api/servicestatus",
  recent: (limit) => `/api/dashboard/recent?limit=${encodeURIComponent(limit)}`,
  projects: "/api/projects",
  gensets: "/api/gensets",
  serviceItems: "/api/serviceitems",
  schedules: "/api/schedules",
  activeSchedules: "/api/schedules?active=true",
  serviceRecords: "/api/servicerecords",
  engineHours: "/api/enginehours"
};

const state = {
  dashboard: null,
  statuses: [],
  recent: [],
  currentView: "dashboard",
  currentSystem: "projects",
  loading: false,
  // Raw (unfiltered) datasets for the systems views that support filtering.
  systemsRaw: {
    gensets: [],
    schedules: [],
    enginehours: []
  },
  // Full genset directory (id, project_id, project_name, name, equipment_tag),
  // used to build the cascading Project -> Genset filter dropdowns.
  gensetDirectory: [],
  gensetDirectoryLoaded: false,
  // Current filter selections for the Systems view.
  systemsFilter: {
    projectId: "",
    gensetId: ""
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
  systemSelect: $("#systemSelect"),
  systemsFilterRow: $("#systemsFilterRow"),
  systemsFilterProjectWrap: $("#systemsFilterProjectWrap"),
  systemsFilterGensetWrap: $("#systemsFilterGensetWrap"),
  systemsFilterProject: $("#systemsFilterProject"),
  systemsFilterGenset: $("#systemsFilterGenset")
};

const viewMetadata = {
  dashboard: ["Dashboard", "Genset maintenance overview"],
  maintenance: ["Service Status", "Current maintenance condition for every active schedule"],
  recent: ["Recent Service", "Completed genset maintenance records"],
  systems: ["Systems", "Projects, gensets, service items and schedules"]
};

/* Which categories show which filter controls in the Systems view. */
const SYSTEMS_FILTER_CONFIG = {
  projects: { project: false, genset: false },
  serviceitems: { project: false, genset: false },
  gensets: { project: true, genset: false },
  schedules: { project: true, genset: true },
  enginehours: { project: true, genset: true }
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

/* Fill a genset <select> with gensets in the given project. */
async function fillGensetsForProject(projectId, selectId) {
  const select = $(selectId);
  if (!projectId) {
    select.innerHTML = '<option value="">Select project first</option>';
    select.disabled = true;
    return [];
  }
  const gensets = itemsOf(await apiFetch(ENDPOINTS.gensets)).filter(
    (g) => Number(g.project_id) === Number(projectId)
  );
  if (!gensets.length) {
    select.innerHTML = '<option value="">No gensets in this project</option>';
    select.disabled = true;
    return [];
  }
  select.innerHTML =
    '<option value="">Select genset</option>' +
    gensets
      .map(
        (g) =>
          `<option value="${g.id}">${escapeHtml(g.name)}${
            g.equipment_tag ? " (" + escapeHtml(g.equipment_tag) + ")" : ""
          }</option>`
      )
      .join("");
  select.disabled = false;
  return gensets;
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
    activeGensets: summary.activeGensets,
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
        <span>${escapeHtml(item.project_name)} · ${escapeHtml(item.genset_name)}</span>
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
    const haystack = [item.project_name, item.genset_name, item.equipment_tag, item.service_item_name]
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
      <td><strong>${escapeHtml(item.genset_name)}</strong>${
        item.equipment_tag ? `<br><small>${escapeHtml(item.equipment_tag)}</small>` : ""
      }</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${formatDate(item.last_service_date)}</td>
      <td>${formatDate(item.next_due_date)}</td>
      <td>${item.days_remaining == null ? "–" : formatNumber(item.days_remaining)}</td>
      <td>${formatNumber(item.interval_days ?? item.period_days)} days</td>
    </tr>
  `
    )
    .join("");
  empty.classList.toggle("hidden", items.length > 0);
  $("#statusCount").textContent = `${items.length} schedule${items.length === 1 ? "" : "s"}`;
}

function recentRows(items) {
  return items
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${escapeHtml(item.genset_name)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${escapeHtml(item.performed_by || "–")}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
      <td>${formatNumber(item.attachment_count)}</td>
    </tr>
  `
    )
    .join("");
}

function renderRecent() {
  const fullBody = $("#recentTableBody");
  const dashboardBody = $("#dashboardRecentBody");
  fullBody.innerHTML = recentRows(state.recent);
  dashboardBody.innerHTML = state.recent
    .slice(0, 5)
    .map(
      (item) => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${escapeHtml(item.genset_name)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${escapeHtml(item.performed_by || "–")}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
    </tr>
  `
    )
    .join("");
  $("#recentEmpty").classList.toggle("hidden", state.recent.length > 0);
  $("#dashboardRecentEmpty").classList.toggle("hidden", state.recent.length > 0);
}

async function loadRecent() {
  const limit = Number(elements.recentLimit.value || 20);
  const data = await apiFetch(ENDPOINTS.recent(limit));
  state.recent = itemsOf(data);
  renderRecent();
}

async function loadEngineHoursCount() {
  try {
    const data = await apiFetch(ENDPOINTS.engineHours);
    const el = $("#engineHoursCount");
    if (el) el.textContent = formatNumber(data.count ?? itemsOf(data).length);
  } catch (error) {
    console.warn("Engine hours count unavailable", error);
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
    loadEngineHoursCount();
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
 * Genset directory (cached) — used to build the Project -> Genset
 * cascading filter dropdowns in the Systems view.
 * ------------------------------------------------------------- */
async function ensureGensetDirectory(force = false) {
  if (state.gensetDirectoryLoaded && !force) return state.gensetDirectory;
  state.gensetDirectory = itemsOf(await apiFetch(ENDPOINTS.gensets));
  state.gensetDirectoryLoaded = true;
  return state.gensetDirectory;
}

function directoryProjects() {
  const seen = new Map();
  state.gensetDirectory.forEach((g) => {
    if (g.project_id != null && !seen.has(Number(g.project_id))) {
      seen.set(Number(g.project_id), g.project_name ?? `Project ${g.project_id}`);
    }
  });
  return [...seen.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function directoryGensetsForProject(projectId) {
  const list = projectId
    ? state.gensetDirectory.filter((g) => Number(g.project_id) === Number(projectId))
    : state.gensetDirectory.slice();
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------
 * Systems view filter row: configure visibility + populate options
 * for the currently selected category.
 * ------------------------------------------------------------- */
function populateFilterProjectOptions() {
  const projects = directoryProjects();
  elements.systemsFilterProject.innerHTML =
    '<option value="">All projects</option>' +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}

function populateFilterGensetOptions(projectId) {
  const gensets = directoryGensetsForProject(projectId);
  elements.systemsFilterGenset.innerHTML =
    '<option value="">All gensets</option>' +
    gensets
      .map(
        (g) =>
          `<option value="${g.id}">${escapeHtml(g.name)}${
            g.equipment_tag ? " (" + escapeHtml(g.equipment_tag) + ")" : ""
          }${!projectId ? " — " + escapeHtml(g.project_name ?? "") : ""}</option>`
      )
      .join("");
}

async function configureSystemsFilters(systemKey) {
  const config = SYSTEMS_FILTER_CONFIG[systemKey] || { project: false, genset: false };

  // reset filter selections whenever the category changes
  state.systemsFilter = { projectId: "", gensetId: "" };

  if (!config.project && !config.genset) {
    elements.systemsFilterRow.classList.add("hidden");
    return;
  }

  await ensureGensetDirectory();

  elements.systemsFilterRow.classList.remove("hidden");
  elements.systemsFilterProjectWrap.classList.toggle("hidden", !config.project);
  elements.systemsFilterGensetWrap.classList.toggle("hidden", !config.genset);

  if (config.project) {
    populateFilterProjectOptions();
    elements.systemsFilterProject.value = "";
  }
  if (config.genset) {
    populateFilterGensetOptions("");
    elements.systemsFilterGenset.value = "";
  }
}

/* Re-render the currently visible systems table using the cached raw
 * dataset and the current filter selections (no re-fetch needed). */
function applySystemsFilters() {
  const key = state.currentSystem;
  const { projectId, gensetId } = state.systemsFilter;

  if (key === "gensets") {
    const rows = state.systemsRaw.gensets.filter((g) => {
      if (gensetId && Number(g.id) !== Number(gensetId)) return false;
      if (projectId && Number(g.project_id) !== Number(projectId)) return false;
      return true;
    });
    renderGensetsTable(rows);
    return;
  }

  if (key === "schedules") {
    const rows = state.systemsRaw.schedules.filter((s) =>
      rowMatchesGensetAndProject(s, projectId, gensetId)
    );
    renderSchedulesTable(rows);
    return;
  }

  if (key === "enginehours") {
    const rows = state.systemsRaw.enginehours.filter((r) =>
      rowMatchesGensetAndProject(r, projectId, gensetId)
    );
    renderEngineHoursTable(rows);
  }
}

/* Match a schedule/engine-hours row against the selected project/genset
 * filters. Prefers explicit genset_id/project_id on the row; falls back
 * to matching by genset name + equipment tag (scoped within the already
 * project-filtered directory) when those ids are not present. */
function rowMatchesGensetAndProject(row, projectId, gensetId) {
  if (gensetId) {
    if (row.genset_id != null) {
      return Number(row.genset_id) === Number(gensetId);
    }
    const gensetEntry = state.gensetDirectory.find((g) => Number(g.id) === Number(gensetId));
    if (gensetEntry) {
      return (
        row.genset_name === gensetEntry.name &&
        (row.equipment_tag ?? null) === (gensetEntry.equipment_tag ?? null)
      );
    }
    return true;
  }

  if (projectId) {
    if (row.project_id != null) {
      return Number(row.project_id) === Number(projectId);
    }
    if (row.genset_id != null) {
      const gensetEntry = state.gensetDirectory.find((g) => Number(g.id) === Number(row.genset_id));
      if (gensetEntry) return Number(gensetEntry.project_id) === Number(projectId);
    }
    const projectEntry = directoryProjects().find((p) => Number(p.id) === Number(projectId));
    if (projectEntry) return row.project_name === projectEntry.name;
  }

  return true;
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

function renderGensetsTable(gensets) {
  renderSystemsTable(
    "Gensets",
    `Generator set master data (${gensets.length} shown)`,
    `<tr><th>ID</th><th>Name</th><th>Equipment Tag</th><th>Project</th><th>Active</th></tr>`,
    gensets
      .map(
        (g) => `
      <tr>
        <td>${escapeHtml(g.id)}</td>
        <td>${escapeHtml(g.name)}</td>
        <td>${escapeHtml(g.equipment_tag ?? "–")}</td>
        <td>${escapeHtml(g.project_name ?? "–")}</td>
        <td>${g.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadGensetsView() {
  const gensets = itemsOf(await apiFetch(ENDPOINTS.gensets));
  state.systemsRaw.gensets = gensets;
  // keep the directory fresh too, since it powers the filter dropdowns
  state.gensetDirectory = gensets;
  state.gensetDirectoryLoaded = true;
  applySystemsFilters();
}

function renderSchedulesTable(schedules) {
  renderSystemsTable(
    "Active Schedules",
    `Genset maintenance schedules (${schedules.length} shown)`,
    `<tr><th>ID</th><th>Project</th><th>Genset</th><th>Service Item</th><th>Start Date</th><th>Interval (days)</th><th>Warning (days)</th><th>Active</th></tr>`,
    schedules
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.id)}</td>
        <td>${escapeHtml(s.project_name ?? "–")}</td>
        <td><strong>${escapeHtml(s.genset_name ?? "–")}</strong>${
          s.equipment_tag ? `<br><small>${escapeHtml(s.equipment_tag)}</small>` : ""
        }</td>
        <td>${escapeHtml(s.service_item_name ?? "–")}</td>
        <td>${formatDate(s.schedule_start_date)}</td>
        <td>${formatNumber(s.interval_days ?? s.period_days)}</td>
        <td>${formatNumber(s.warning_days)}</td>
        <td>${s.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadSchedulesView() {
  const schedules = itemsOf(await apiFetch(ENDPOINTS.activeSchedules));
  state.systemsRaw.schedules = schedules;
  applySystemsFilters();
}

function renderEngineHoursTable(readings) {
  renderSystemsTable(
    "Engine Hours",
    `Genset engine-hour readings (${readings.length} shown)`,
    `<tr><th>ID</th><th>Project</th><th>Genset</th><th>Reading Date</th><th>Hours</th><th>Recorded</th></tr>`,
    readings
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.id)}</td>
        <td>${escapeHtml(r.project_name ?? "–")}</td>
        <td><strong>${escapeHtml(r.genset_name ?? "–")}</strong>${
          r.equipment_tag ? `<br><small>${escapeHtml(r.equipment_tag)}</small>` : ""
        }</td>
        <td>${formatDate(r.reading_date)}</td>
        <td>${formatNumber(r.hours)}</td>
        <td>${formatDateTime(r.created_at)}</td>
      </tr>`
      )
      .join("")
  );
}

async function loadEngineHoursView() {
  const readings = itemsOf(await apiFetch(ENDPOINTS.engineHours));
  state.systemsRaw.enginehours = readings;
  applySystemsFilters();
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

const systemLoaders = {
  projects: loadProjectsView,
  gensets: loadGensetsView,
  serviceitems: loadServiceItemsView,
  schedules: loadSchedulesView,
  enginehours: loadEngineHoursView
};

async function showSystem(systemKey) {
  const loader = systemLoaders[systemKey];
  if (!loader) return;
  state.currentSystem = systemKey;
  updateAddButton(systemKey);
  if (elements.systemSelect) elements.systemSelect.value = systemKey;
  const addGensetButton = $("#addGensetButton");
  if (addGensetButton) addGensetButton.classList.toggle("hidden", systemKey !== "gensets");
  try {
    await configureSystemsFilters(systemKey);
    await loader();
    setView("systems");
  } catch (error) {
    showAlert(`Unable to load ${systemKey}: ${error.message}`);
  }
}

/* ---------------- Systems filter events ---------------- */
async function onSystemsFilterProjectChange() {
  const projectId = elements.systemsFilterProject.value;
  state.systemsFilter.projectId = projectId;
  state.systemsFilter.gensetId = "";

  const config = SYSTEMS_FILTER_CONFIG[state.currentSystem] || {};
  if (config.genset) {
    populateFilterGensetOptions(projectId);
    elements.systemsFilterGenset.value = "";
  }
  applySystemsFilters();
}

function onSystemsFilterGensetChange() {
  state.systemsFilter.gensetId = elements.systemsFilterGenset.value;
  applySystemsFilters();
}

/* ---------------- Add Service Record (cascading) ---------------- */
const recordModal = $("#recordModal");
const recordForm = $("#recordForm");
const recordCache = { gensets: [], schedules: [] };

async function openRecordModal() {
  recordForm.reset();
  $("#recDate").value = new Date().toISOString().slice(0, 10);
  const gensetSelect = $("#recGenset");
  const scheduleSelect = $("#recSchedule");
  gensetSelect.innerHTML = '<option value="">Select project first</option>';
  gensetSelect.disabled = true;
  scheduleSelect.innerHTML = '<option value="">Select genset first</option>';
  scheduleSelect.disabled = true;
  try {
    await fillProjectSelect("#recProject");
    recordModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the record form: ${error.message}`);
  }
}

function closeRecordModal() {
  recordModal.classList.add("hidden");
}

async function onProjectChange() {
  const projectId = Number($("#recProject").value);
  const scheduleSelect = $("#recSchedule");
  scheduleSelect.innerHTML = '<option value="">Select genset first</option>';
  scheduleSelect.disabled = true;
  try {
    recordCache.gensets = await fillGensetsForProject(projectId, "#recGenset");
  } catch (error) {
    showAlert(`Unable to load gensets: ${error.message}`);
  }
}

async function onGensetChange() {
  const gensetId = Number($("#recGenset").value);
  const scheduleSelect = $("#recSchedule");
  if (!gensetId) {
    scheduleSelect.innerHTML = '<option value="">Select genset first</option>';
    scheduleSelect.disabled = true;
    return;
  }
  try {
    const scheduleData = await apiFetch(ENDPOINTS.activeSchedules);
    recordCache.schedules = itemsOf(scheduleData).filter(
      (s) => Number(s.genset_id) === gensetId
    );
    if (!recordCache.schedules.length) {
      scheduleSelect.innerHTML = '<option value="">No schedules for this genset</option>';
      scheduleSelect.disabled = true;
      return;
    }
    scheduleSelect.innerHTML =
      '<option value="">Select service schedule</option>' +
      recordCache.schedules
        .map(
          (s) =>
            `<option value="${s.id}">${escapeHtml(s.service_item_name ?? "Service")}${
              (s.interval_days ?? s.period_days)
                ? " — every " + (s.interval_days ?? s.period_days) + " days"
                : ""
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
    showAlert("Project, genset and service schedule are required.");
    return;
  }
  if (!serviceDate) {
    showAlert("Service date is required.");
    return;
  }
  const payload = {
    service_schedule_id: scheduleId,
    service_date: serviceDate,
    performed_by: $("#recPerformedBy").value.trim() || null,
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

/* ---------------- Add Genset ---------------- */
const gensetModal = $("#gensetModal");
const gensetForm = $("#gensetForm");

async function openGensetModal() {
  gensetForm.reset();
  try {
    await fillProjectSelect("#gensetProject");
    gensetModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the genset form: ${error.message}`);
  }
}

function closeGensetModal() {
  gensetModal.classList.add("hidden");
}

async function submitGenset(event) {
  event.preventDefault();
  const saveButton = $("#gensetSave");
  const payload = {
    project_id: Number($("#gensetProject").value),
    name: $("#gensetName").value.trim(),
    equipment_tag: $("#gensetTag").value.trim() || null,
    serial_number: $("#gensetSerial").value.trim() || null
  };
  if (!payload.project_id || !payload.name) {
    showAlert("Project and genset name are required.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.gensets, payload);
    closeGensetModal();
    showToast("Genset added");
    await ensureGensetDirectory(true);
    await loadGensetsView();
    await loadAll({ notify: false });
  } catch (error) {
    showAlert(`Unable to save genset: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save genset";
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
const scheduleCache = { gensets: [] };

async function openScheduleModal() {
  scheduleForm.reset();
  $("#schedWarning").value = 30;
  const trackDays = $("#schedTrackDays");
  const trackHours = $("#schedTrackHours");
  if (trackDays) trackDays.checked = true;
  if (trackHours) trackHours.checked = false;
  $("#schedStartDate").value = new Date().toISOString().slice(0, 10);
  const gensetSelect = $("#schedGenset");
  gensetSelect.innerHTML = '<option value="">Select project first</option>';
  gensetSelect.disabled = true;
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
    scheduleCache.gensets = await fillGensetsForProject(projectId, "#schedGenset");
  } catch (error) {
    showAlert(`Unable to load gensets: ${error.message}`);
  }
}

async function submitSchedule(event) {
  event.preventDefault();
  const saveButton = $("#scheduleSave");
  const intervalHoursRaw = $("#schedIntervalHours") ? $("#schedIntervalHours").value : "";
  const payload = {
    genset_id: Number($("#schedGenset").value),
    service_item_id: Number($("#schedServiceItem").value),
    interval_days: Number($("#schedIntervalDays").value),
    interval_running_hours: intervalHoursRaw === "" ? null : Number(intervalHoursRaw),
    warning_days: $("#schedWarning").value === "" ? 30 : Number($("#schedWarning").value),
    track_days: $("#schedTrackDays") ? $("#schedTrackDays").checked : true,
    track_running_hours: $("#schedTrackHours") ? $("#schedTrackHours").checked : false,
    schedule_start_date: $("#schedStartDate").value,
    notes: $("#schedNotes").value.trim() || null
  };
  if (!payload.genset_id || !payload.service_item_id) {
    showAlert("Project, genset and service item are required.");
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

/* ---------------- Add Engine Hours (cascading) ---------------- */
const engineHoursModal = $("#engineHoursModal");
const engineHoursForm = $("#engineHoursForm");

async function openEngineHoursModal() {
  engineHoursForm.reset();
  $("#ehReadingDate").value = new Date().toISOString().slice(0, 10);
  const gensetSelect = $("#ehGenset");
  gensetSelect.innerHTML = '<option value="">Select project first</option>';
  gensetSelect.disabled = true;
  try {
    await fillProjectSelect("#ehProject");
    engineHoursModal.classList.remove("hidden");
  } catch (error) {
    showAlert(`Unable to open the engine hours form: ${error.message}`);
  }
}

function closeEngineHoursModal() {
  engineHoursModal.classList.add("hidden");
}

async function onEngineHoursProjectChange() {
  const projectId = Number($("#ehProject").value);
  try {
    await fillGensetsForProject(projectId, "#ehGenset");
  } catch (error) {
    showAlert(`Unable to load gensets: ${error.message}`);
  }
}

async function submitEngineHours(event) {
  event.preventDefault();
  const saveButton = $("#engineHoursSave");
  const payload = {
    genset_id: Number($("#ehGenset").value),
    reading_date: $("#ehReadingDate").value,
    hours: $("#ehHours").value === "" ? null : Number($("#ehHours").value)
  };
  if (!payload.genset_id) {
    showAlert("Project and genset are required.");
    return;
  }
  if (!payload.reading_date) {
    showAlert("Reading date is required.");
    return;
  }
  if (payload.hours == null || !Number.isFinite(payload.hours) || payload.hours < 0) {
    showAlert("Engine hours must be zero or greater.");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";
  try {
    await apiPost(ENDPOINTS.engineHours, payload);
    closeEngineHoursModal();
    showToast("Engine hours reading added");
    await loadEngineHoursView();
    await loadEngineHoursCount();
  } catch (error) {
    showAlert(`Unable to save engine hours: ${error.message}`);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save reading";
  }
}

/* ---------------- Add button dispatcher ---------------- */
// Gensets uses its own separate button (#addGensetButton), toggled in showSystem.
function updateAddButton(systemKey) {
  const btn = $("#addSystemButton");
  if (!btn) return;
  const map = {
    projects: { label: "+ Add Project", open: openProjectModal },
    serviceitems: { label: "+ Add Service Item", open: openServiceItemModal },
    schedules: { label: "+ Add Schedule", open: openScheduleModal },
    enginehours: { label: "+ Add Engine Hours", open: openEngineHoursModal }
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
  elements.refreshButton.addEventListener("click", () => loadAll({ notify: true }));

  // Systems filter row (Project / Genset cascading filters)
  elements.systemsFilterProject.addEventListener("change", onSystemsFilterProjectChange);
  elements.systemsFilterGenset.addEventListener("change", onSystemsFilterGensetChange);

  // Add Service Record modal
  $("#addRecordButton").addEventListener("click", openRecordModal);
  $("#recordModalClose").addEventListener("click", closeRecordModal);
  $("#recordCancel").addEventListener("click", closeRecordModal);
  recordForm.addEventListener("submit", submitRecord);
  recordModal.addEventListener("click", (event) => {
    if (event.target === recordModal) closeRecordModal();
  });
  $("#recProject").addEventListener("change", onProjectChange);
  $("#recGenset").addEventListener("change", onGensetChange);

  // Add Project modal
  $("#projectModalClose").addEventListener("click", closeProjectModal);
  $("#projectCancel").addEventListener("click", closeProjectModal);
  projectForm.addEventListener("submit", submitProject);
  projectModal.addEventListener("click", (event) => {
    if (event.target === projectModal) closeProjectModal();
  });

  // Add Genset modal
  $("#addGensetButton").addEventListener("click", openGensetModal);
  $("#gensetModalClose").addEventListener("click", closeGensetModal);
  $("#gensetCancel").addEventListener("click", closeGensetModal);
  gensetForm.addEventListener("submit", submitGenset);
  gensetModal.addEventListener("click", (event) => {
    if (event.target === gensetModal) closeGensetModal();
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

  // Add Engine Hours modal
  $("#engineHoursModalClose").addEventListener("click", closeEngineHoursModal);
  $("#engineHoursCancel").addEventListener("click", closeEngineHoursModal);
  engineHoursForm.addEventListener("submit", submitEngineHours);
  engineHoursModal.addEventListener("click", (event) => {
    if (event.target === engineHoursModal) closeEngineHoursModal();
  });
  $("#ehProject").addEventListener("change", onEngineHoursProjectChange);

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

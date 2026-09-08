"use strict";

const state = {
  dashboard: null,
  statuses: [],
  recent: [],
  currentView: "dashboard",
  currentSystem: "projects",
  loading: false
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
  systemSelect: $("#systemSelect")
};

// FIX 1: added the missing comma after "recent" and included the "systems" entry.
const viewMetadata = {
  dashboard: ["Dashboard", "Genset maintenance overview"],
  maintenance: ["Service Status", "Current maintenance condition for every active schedule"],
  recent: ["Recent Service", "Completed genset maintenance records"],
  systems: ["Systems", "Projects, gensets, service items and schedules"]
};

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

function formatNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : fallback;
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
  // Guard so a missing metadata entry never aborts navigation.
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
      <td>${formatNumber(item.period_days)} days</td>
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
      <td>${item.engine_hours == null ? "–" : formatNumber(item.engine_hours)}</td>
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
  const data = await apiFetch(`/api/dashboard/recent?limit=${encodeURIComponent(limit)}`);
  state.recent = Array.isArray(data.items) ? data.items : [];
  renderRecent();
}

async function loadAll({ notify = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = "Refreshing...";
  clearAlert();
  try {
    const [dashboard, statusData] = await Promise.all([
      apiFetch("/api/dashboard"),
      // FIX 5: keep the endpoint your backend actually serves.
      // If your route is hyphenated, change this to "/api/service-status".
      apiFetch("/api/servicestatus")
    ]);
    state.dashboard = dashboard;
    state.statuses = Array.isArray(statusData.items) ? statusData.items : [];
    await loadRecent();
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
 * Systems views
 * FIX 3 & 4: a single dispatcher loads each dataset, all four
 * categories are wired, and the Systems tab loads data by default.
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

function itemsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function loadProjectsView() {
  const projects = itemsOf(await apiFetch("/api/projects"));
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

async function loadGensetsView() {
  const gensets = itemsOf(await apiFetch("/api/gensets"));
  renderSystemsTable(
    "Gensets",
    "Generator set master data",
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

async function loadServiceItemsView() {
  const items = itemsOf(await apiFetch("/api/service-items"));
  renderSystemsTable(
    "Service Items",
    "Maintenance activity definitions",
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

async function loadSchedulesView() {
  const schedules = itemsOf(await apiFetch("/api/schedules"));
  renderSystemsTable(
    "Active Schedules",
    "Genset maintenance schedules",
    `<tr><th>ID</th><th>Genset</th><th>Service Item</th><th>Period (days)</th><th>Warning (days)</th><th>Active</th></tr>`,
    schedules
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.id)}</td>
        <td>${escapeHtml(s.genset_name ?? "–")}</td>
        <td>${escapeHtml(s.service_item_name ?? "–")}</td>
        <td>${formatNumber(s.period_days)}</td>
        <td>${formatNumber(s.warning_days)}</td>
        <td>${s.active ? "Yes" : "No"}</td>
      </tr>`
      )
      .join("")
  );
}

const systemLoaders = {
  projects: loadProjectsView,
  gensets: loadGensetsView,
  serviceitems: loadServiceItemsView,
  schedules: loadSchedulesView
};

async function showSystem(systemKey) {
  const loader = systemLoaders[systemKey];
  if (!loader) return;
  state.currentSystem = systemKey;
  if (elements.systemSelect) elements.systemSelect.value = systemKey;
  try {
    await loader(); // fill the table first
    setView("systems"); // then reveal the panel
  } catch (error) {
    showAlert(`Unable to load ${systemKey.replace("-", " ")}: ${error.message}`);
  }
}

function bindEvents() {
  // Sidebar navigation. The Systems tab loads data instead of an empty table.
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

  // System Overview links on the dashboard.
  $$("[data-system-view]").forEach((item) =>
    item.addEventListener("click", () => showSystem(item.dataset.systemView))
  );

  // Category selector inside the Systems view.
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

async function loadServiceItemsView() {
  const data = await apiFetch("/api/serviceitems");
  $("#systemTitle").textContent = "Service Items";
  $("#systemSubtitle").textContent = "Maintenance task catalogue";
  $("#systemsHead").innerHTML =
    `<tr><th>ID</th><th>Name</th><th>Description</th><th>Active</th></tr>`;
  $("#systemsBody").innerHTML = (data.items || []).map(i => `
    <tr>
      <td>${i.id}</td>
      <td>${escapeHtml(i.name)}</td>
      <td>${escapeHtml(i.description ?? "")}</td>
      <td>${i.active}</td>
    </tr>`).join("");
}

async function loadSchedulesView() {
  const data = await apiFetch("/api/schedules?active=true");
  $("#systemTitle").textContent = "Active Schedules";
  $("#systemSubtitle").textContent = "Maintenance schedules per genset";
  $("#systemsHead").innerHTML =
    `<tr><th>ID</th><th>Project</th><th>Genset</th><th>Service Item</th><th>Start Date</th><th>Period</th><th>Warning</th></tr>`;
  $("#systemsBody").innerHTML = (data.items || []).map(s => `
    <tr>
      <td>${s.id}</td>
      <td>${escapeHtml(s.project_name ?? "")}</td>
      <td><strong>${escapeHtml(s.genset_name ?? "")}</strong>${
        s.equipment_tag ? `<br><small>${escapeHtml(s.equipment_tag)}</small>` : ""}</td>
      <td>${escapeHtml(s.service_item_name ?? "")}</td>
      <td>${formatDate(s.schedule_start_date)}</td>
      <td>${formatNumber(s.period_days)} days</td>
      <td>${formatNumber(s.warning_days)} days</td>
    </tr>`).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  registerServiceWorker();
  loadAll();
});

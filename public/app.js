"use strict";

const state = {
    dashboard: null,
    statuses: [],
    recent: [],
    currentView: "dashboard",
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
    recentLimit: $("#recentLimit")
};

const viewMetadata = {
    dashboard: ["Dashboard", "Genset maintenance overview"],
    maintenance: ["Service Status", "Current maintenance condition for every active schedule"],
    recent: ["Recent Service", "Completed genset maintenance records"]
	systems: ["Systems","Projects, gensets, service items and schedules"]
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
    if (!value)
        return "Not set";
    const dateOnly = String(value).slice(0, 10);
    const [year, month, day] = dateOnly.split("-").map(Number);
    if (!year || !month || !day)
        return escapeHtml(value);
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
    return ({
        OVERDUE: "Overdue",
        DUE_SOON: "Due soon",
        OK: "On schedule",
        NOT_SET: "Not set"
    })[status] || status;
}

function statusBadge(status) {
    const safeStatus = ["OVERDUE", "DUE_SOON", "OK", "NOT_SET"].includes(status) ? status : "NOT_SET";
    return `<span class="status-badge ${safeStatus}">${escapeHtml(statusLabel(safeStatus))}</span>`;
}

async function apiFetch(url) {
    const response = await fetch(url, {
        headers: {
            Accept: "application/json"
        }
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
        const message = payload?.error || payload?.message || `Request failed with status ${response.status}`;
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
    $$('[data-view-panel]').forEach(panel => panel.classList.toggle("hidden", panel.dataset.viewPanel !== view));
    $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === view));
    const [title, subtitle] = viewMetadata[view];
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
        $(`#${id}`).textContent = formatNumber(value);
    });
}

function renderNextDue() {
    const host = $("#nextDueList");
    const items = state.statuses
        .filter(item => item.next_due_date)
        .sort((a, b) => String(a.next_due_date).localeCompare(String(b.next_due_date)))
        .slice(0, 5);

    if (!items.length) {
        host.innerHTML = '<div class="empty-state">No calculated due dates available.</div>';
        return;
    }

    host.innerHTML = items.map(item => `
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
  `).join("");
}

function renderStatusTable() {
    const status = elements.statusFilter.value;
    const search = elements.statusSearch.value.trim().toLowerCase();
    const items = state.statuses.filter(item => {
        const statusMatch = status === "ALL" || item.status === status;
        const haystack = [item.project_name, item.genset_name, item.equipment_tag, item.service_item_name]
        .filter(Boolean).join(" ").toLowerCase();
        return statusMatch && (!search || haystack.includes(search));
    });

    const body = $("#statusTableBody");
    const empty = $("#statusEmpty");
    body.innerHTML = items.map(item => `
    <tr>
      <td>${statusBadge(item.status)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td><strong>${escapeHtml(item.genset_name)}</strong>${item.equipment_tag ? `<br><small>${escapeHtml(item.equipment_tag)}</small>` : ""}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${formatDate(item.last_service_date)}</td>
      <td>${formatDate(item.next_due_date)}</td>
      <td>${item.days_remaining == null ? "–" : formatNumber(item.days_remaining)}</td>
      <td>${formatNumber(item.period_days)} days</td>
    </tr>
  `).join("");
    empty.classList.toggle("hidden", items.length > 0);
    $("#statusCount").textContent = `${items.length} schedule${items.length === 1 ? "" : "s"}`;
}

function recentRows(items) {
    return items.map(item => `
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
  `).join("");
}

function renderRecent() {
    const fullBody = $("#recentTableBody");
    const dashboardBody = $("#dashboardRecentBody");
    fullBody.innerHTML = recentRows(state.recent);
    dashboardBody.innerHTML = state.recent.slice(0, 5).map(item => `
    <tr>
      <td>${formatDate(item.service_date)}</td>
      <td>${escapeHtml(item.project_name)}</td>
      <td>${escapeHtml(item.genset_name)}</td>
      <td>${escapeHtml(item.service_item_name)}</td>
      <td>${escapeHtml(item.performed_by || "–")}</td>
      <td>${escapeHtml(item.work_order_number || "–")}</td>
    </tr>
  `).join("");
    $("#recentEmpty").classList.toggle("hidden", state.recent.length > 0);
    $("#dashboardRecentEmpty").classList.toggle("hidden", state.recent.length > 0);
}

async function loadRecent() {
    const limit = Number(elements.recentLimit.value || 20);
    const data = await apiFetch(`/api/dashboard/recent?limit=${encodeURIComponent(limit)}`);
    state.recent = Array.isArray(data.items) ? data.items : [];
    renderRecent();
}

async function loadAll({
    notify = false
} = {}) {
    if (state.loading)
        return;
    state.loading = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = "Refreshing...";
    clearAlert();

    try {
        const [dashboard, statusData] = await Promise.all([
                    apiFetch("/api/dashboard"),
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
        if (notify)
            showToast("Dashboard updated");
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

async function loadProjectsView() {

    const response =
        await fetch("/api/projects");

    const data =
        await response.json();

    document.getElementById(
        "systemTitle").textContent = "Projects";

    document.getElementById(
        "systemsHead").innerHTML = `
        <tr>
            <th>ID</th>
            <th>Code</th>
            <th>Name</th>
            <th>Active</th>
        </tr>
    `;

    document.getElementById(
        "systemsBody").innerHTML =
        data.items.map(project => `
            <tr>
                <td>${project.id}</td>
                <td>${project.code ?? ""}</td>
                <td>${project.name}</td>
                <td>${project.active}</td>
            </tr>
        `).join("");

    setView("systems");
}

async function loadGensetsView() {

    const response =
        await fetch("/api/gensets");

    const data =
        await response.json();

    document.getElementById(
        "systemTitle").textContent = "Gensets";

    document.getElementById(
        "systemsHead").innerHTML = `
        <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Equipment Tag</th>
            <th>Project</th>
        </tr>
    `;

    document.getElementById(
        "systemsBody").innerHTML =
        data.items.map(g => `
            <tr>
                <td>${g.id}</td>
                <td>${g.name}</td>
                <td>${g.equipment_tag ?? ""}</td>
                <td>${g.project_name ?? ""}</td>
            </tr>
        `).join("");

    setView("systems");
}

function bindEvents() {
    $$(".nav-item").forEach(item => item.addEventListener("click", () => setView(item.dataset.view)));
    $$('[data-go-view]').forEach(item => item.addEventListener("click", () => setView(item.dataset.goView)));
    $$('[data-status-filter]').forEach(card => card.addEventListener("click", () => {
            elements.statusFilter.value = card.dataset.statusFilter;
            renderStatusTable();
            setView("maintenance");
        }));
    elements.statusFilter.addEventListener("change", renderStatusTable);
    elements.statusSearch.addEventListener("input", renderStatusTable);
    elements.recentLimit.addEventListener("change", async() => {
        try {
            await loadRecent();
        } catch (error) {
            showAlert(`Unable to load recent records: ${error.message}`);
        }
    });
    elements.refreshButton.addEventListener("click", () => loadAll({
            notify: true
        }));
    elements.menuButton.addEventListener("click", () => elements.sidebar.classList.contains("open") ? closeSidebar() : openSidebar());
    elements.sidebarBackdrop.addEventListener("click", closeSidebar);
    window.addEventListener("online", () => loadAll({
            notify: true
        }));
    window.addEventListener("offline", () => {
        setConnection(false);
        showAlert("The browser is offline. Previously loaded information remains visible.");
    });
    document.querySelectorAll("[data-system-view]")
    .forEach(item => {

        item.addEventListener("click", () => {

            switch (
                item.dataset.systemView) {

            case "projects":
                loadProjectsView();
                break;

            case "gensets":
                loadGensetsView();
                break;
            }
        });
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
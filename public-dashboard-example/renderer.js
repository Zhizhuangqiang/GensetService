const API_BASE_URL = "https://YOUR-RENDER-SERVICE.onrender.com";

async function getJson(path) {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`API request failed: ${response.status}`);
  return response.json();
}

async function loadDashboard() {
  const status = document.getElementById("api-status");
  try {
    status.textContent = "Loading…";
    const [kpis, upcoming, overdue, recent] = await Promise.all([
      getJson("/api/dashboard"),
      getJson("/api/dashboard/upcoming?days=30"),
      getJson("/api/dashboard/overdue"),
      getJson("/api/dashboard/recent?limit=20"),
    ]);

    const values = {
      "projects-kpi": kpis.activeProjects,
      "gensets-kpi": kpis.activeGensets,
      "items-kpi": kpis.activeServiceItems,
      "schedules-kpi": kpis.activeSchedules,
      "records-kpi": kpis.serviceRecords,
      "overdue-kpi": kpis.overdueInitialDates,
      "due-kpi": kpis.dueWithin30Days,
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value ?? 0;
    });

    window.maintenanceDashboardData = { kpis, upcoming, overdue, recent };
    status.textContent = "Connected";
  } catch (error) {
    console.error(error);
    status.textContent = "API unavailable";
  }
}

document.addEventListener("DOMContentLoaded", loadDashboard);

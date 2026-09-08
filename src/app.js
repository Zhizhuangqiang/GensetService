const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const pool = require("./db");
const dashboardRouter = require("./routes/dashboard");
const projectsRouter = require("./routes/projects");
const gensetsRouter = require("./routes/gensets");
const servicestatusRouter = require("./routes/servicestatus");

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowlist.length === 0 || allowlist.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not allowed by CORS"));
  },
}));

app.get("/", (_req, res) => {
  res.json({ name: "Maintenance API", status: "running", health: "/api/health" });
});

app.get("/api/health", async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT NOW() AS database_time");
    res.json({
      status: "ok",
      database: "connected",
      databaseTime: result.rows[0].database_time,
    });
  } catch (error) {
    next(error);
  }
});

app.use(
	"/api/dashboard",
	dashboardRouter
);
app.use(
  "/api/projects",
  projectsRouter
);

app.use(
  "/api/gensets",
  gensetsRouter
);

app.use(
  "/api/servicestatus",
  servicestatusRouter
);

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.message === "Origin not allowed by CORS" ? 403 : 500).json({
    error: "Request failed",
    message: process.env.NODE_ENV === "production" ? undefined : error.message,
  });
});

module.exports = app;

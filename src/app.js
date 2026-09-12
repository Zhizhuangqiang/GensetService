const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const pool = require("./db");

const dashboardRouter        = require("./routes/dashboard");
const projectsRouter         = require("./routes/projects");
const packagesRouter         = require("./routes/packages");
const packageTypesRouter     = require("./routes/packagetypes");
const servicestatusRouter    = require("./routes/servicestatus");
const serviceItemsRouter     = require("./routes/serviceitems");
const schedulesRouter        = require("./routes/schedules");
const serviceRecordsRouter   = require("./routes/servicerecords");
const pvDataTypesRouter      = require("./routes/pvdatatypes");
const pvAttributesRouter     = require("./routes/pvattributes");
const pvLogRouter            = require("./routes/pvlog");
const techniciansRouter      = require("./routes/technicians");

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

/*
 * ---------------------------------------------------------------------
 * Basic Auth gate — restricts the ENTIRE app (static site + all API
 * routes) behind a single shared username/password.
 *
 * Credentials come from environment variables so they are never
 * committed to source control:
 *   BASIC_AUTH_USER
 *   BASIC_AUTH_PASS
 *
 * Set these in the Render dashboard under your service's
 * "Environment" tab, then redeploy.
 *
 * If either variable is not set, the app intentionally FAILS CLOSED
 * (returns 503) rather than silently running without protection —
 * this prevents accidentally deploying an unprotected instance.
 * ---------------------------------------------------------------------
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via timing.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function basicAuth(req, res, next) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;

  if (!expectedUser || !expectedPass) {
    console.error(
      "BASIC_AUTH_USER / BASIC_AUTH_PASS are not set — refusing to serve requests."
    );
    return res.status(503).json({
      error: "Server misconfigured: authentication credentials are not set."
    });
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex !== -1) {
      const user = decoded.slice(0, separatorIndex);
      const pass = decoded.slice(separatorIndex + 1);
      if (timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass)) {
        return next();
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Package Service Manager", charset="UTF-8"');
  return res.status(401).json({ error: "Authentication required" });
}

app.use(basicAuth);

const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

app.use(
  express.static(
    path.join(__dirname, "../public")
  )
);

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

app.use("/api/dashboard",      dashboardRouter);
app.use("/api/projects",       projectsRouter);
app.use("/api/packages",       packagesRouter);
app.use("/api/packagetypes",   packageTypesRouter);
app.use("/api/servicestatus",  servicestatusRouter);
app.use("/api/serviceitems",   serviceItemsRouter);
app.use("/api/schedules",      schedulesRouter);
app.use("/api/servicerecords", serviceRecordsRouter);
app.use("/api/pvdatatypes",    pvDataTypesRouter);
app.use("/api/pvattributes",   pvAttributesRouter);
app.use("/api/pvlog",          pvLogRouter);
app.use("/api/technicians",    techniciansRouter);

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.message === "Origin not allowed by CORS" ? 403 : 500).json({
    error: "Request failed",
    message: process.env.NODE_ENV === "production" ? undefined : error.message,
  });
});

module.exports = app;

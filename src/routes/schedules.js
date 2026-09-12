const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleConstraint(error, res) {
  if (!error) return false;
  if (error.code === "23505") {
    res.status(409).json({
      error: "A schedule for this package and service item already exists"
    });
    return true;
  }
  if (error.code === "23503") {
    res.status(400).json({
      error: "The selected package or service item does not exist"
    });
    return true;
  }
  if (error.code === "23514") {
    res.status(400).json({
      error: "Invalid interval or warning value for the schedule"
    });
    return true;
  }
  return false;
}

function optionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : NaN;
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/*
 * GET /api/schedules
 * Optional: ?active=true | ?active=false & ?package_id=1
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.active === "true" || req.query.active === "false") {
      values.push(req.query.active === "true");
      conditions.push(`ss.active = $${values.length}`);
    }

    if (req.query.package_id !== undefined) {
      const packageId = Number.parseInt(req.query.package_id, 10);
      if (!Number.isInteger(packageId) || packageId <= 0) {
        return res.status(400).json({ error: "Invalid package_id filter" });
      }
      values.push(packageId);
      conditions.push(`ss.package_id = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        ss.id,
        ss.package_id,
        ss.service_item_id,
        ss.schedule_start_date,
        ss.interval_days,
        ss.interval_running_hours,
        ss.warning_days,
        ss.warning_hours,
        ss.track_days,
        ss.track_running_hours,
        ss.notes,
        ss.active,
        pkg.name AS package_name,
        pkg.package_tag,
        pkg.package_type_id,
        pt.name AS package_type_name,
        p.id AS project_id,
        p.name AS project_name,
        si.name AS service_item_name
      FROM public.service_schedules ss
      JOIN public.packages pkg     ON pkg.id = ss.package_id
      JOIN public.package_types pt ON pt.id = pkg.package_type_id
      JOIN public.projects p       ON p.id = pkg.project_id
      JOIN public.service_items si ON si.id = ss.service_item_id
      ${where}
      ORDER BY p.name, pkg.name, si.name
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/schedules/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid schedule id" });
    }
    const result = await pool.query(
      `
      SELECT
        ss.*,
        pkg.name AS package_name,
        pkg.package_tag,
        p.id AS project_id,
        p.name AS project_name,
        si.name AS service_item_name
      FROM public.service_schedules ss
      JOIN public.packages pkg     ON pkg.id = ss.package_id
      JOIN public.projects p       ON p.id = pkg.project_id
      JOIN public.service_items si ON si.id = ss.service_item_id
      WHERE ss.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

function buildScheduleData(body) {
  const package_id = Number.parseInt(body.package_id, 10);
  const service_item_id = Number.parseInt(body.service_item_id, 10);
  const interval_days = optionalInt(body.interval_days);
  const interval_running_hours = optionalInt(body.interval_running_hours);
  const warning_days =
    body.warning_days === undefined || body.warning_days === null || body.warning_days === ""
      ? 14
      : Number.parseInt(body.warning_days, 10);
  const warning_hours =
    body.warning_hours === undefined || body.warning_hours === null || body.warning_hours === ""
      ? 120
      : Number.parseInt(body.warning_hours, 10);
  const track_days = toBool(body.track_days, true);
  const track_running_hours = toBool(body.track_running_hours, true);
  const schedule_start_date = body.schedule_start_date;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!Number.isInteger(package_id) || package_id <= 0) {
    return { error: "package_id is required" };
  }
  if (!Number.isInteger(service_item_id) || service_item_id <= 0) {
    return { error: "service_item_id is required" };
  }
  if (Number.isNaN(interval_days) || (interval_days !== null && interval_days <= 0)) {
    return { error: "interval_days must be a positive number when provided" };
  }
  if (Number.isNaN(interval_running_hours) || (interval_running_hours !== null && interval_running_hours <= 0)) {
    return { error: "interval_running_hours must be a positive number when provided" };
  }
  if (!Number.isInteger(warning_days) || warning_days < 0) {
    return { error: "warning_days must be zero or greater" };
  }
  if (!Number.isInteger(warning_hours) || warning_hours < 0) {
    return { error: "warning_hours must be zero or greater" };
  }
  if (interval_days !== null && warning_days > interval_days) {
    return { error: "warning_days cannot exceed interval_days" };
  }
  if (interval_running_hours !== null && warning_hours > interval_running_hours) {
    return { error: "warning_hours cannot exceed interval_running_hours" };
  }
  if (!schedule_start_date) {
    return { error: "schedule_start_date is required" };
  }

  return {
    data: {
      package_id, service_item_id, interval_days, interval_running_hours,
      warning_days, warning_hours, track_days, track_running_hours, schedule_start_date, notes
    }
  };
}

/*
 * POST /api/schedules
 * Body: {
 *   package_id, service_item_id, interval_days,
 *   interval_running_hours?, warning_days?,
 *   track_days?, track_running_hours?,
 *   schedule_start_date, notes?
 * }
 */
router.post("/", async (req, res, next) => {
  try {
    const parsed = buildScheduleData(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const d = parsed.data;

    const result = await pool.query(
      `
      INSERT INTO public.service_schedules
        (package_id, service_item_id, interval_days, interval_running_hours,
         warning_days, warning_hours, track_days, track_running_hours,
         schedule_start_date, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
      RETURNING *
      `,
      [
        d.package_id, d.service_item_id, d.interval_days, d.interval_running_hours,
        d.warning_days, d.warning_hours, d.track_days, d.track_running_hours,
        d.schedule_start_date, d.notes
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleConstraint(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/schedules/:id
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid schedule id" });
    }

    const parsed = buildScheduleData(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const d = parsed.data;
    const active = req.body.active;

    const result = await pool.query(
      `
      UPDATE public.service_schedules
      SET
        package_id = $1,
        service_item_id = $2,
        interval_days = $3,
        interval_running_hours = $4,
        warning_days = $5,
        warning_hours = $6,
        track_days = $7,
        track_running_hours = $8,
        schedule_start_date = $9,
        notes = $10,
        active = $11,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
      `,
      [
        d.package_id, d.service_item_id, d.interval_days, d.interval_running_hours,
        d.warning_days, d.warning_hours, d.track_days, d.track_running_hours,
        d.schedule_start_date, d.notes, active !== false, id
      ]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleConstraint(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/schedules/:id  — soft delete.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid schedule id" });
    }
    const result = await pool.query(
      `
      UPDATE public.service_schedules
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Schedule not found" });
    }
    res.json({ success: true, schedule: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

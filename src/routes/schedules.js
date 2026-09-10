const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * Maps common PostgreSQL constraint errors to friendly responses.
 * Returns true if it handled the error.
 */
function handleConstraint(error, res) {
  if (!error) return false;
  if (error.code === "23505") {
    res.status(409).json({
      error: "A schedule for this genset and service item already exists"
    });
    return true;
  }
  if (error.code === "23503") {
    res.status(400).json({
      error: "The selected genset or service item does not exist"
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

/* Parse an optional integer field. Returns null when blank/undefined. */
function optionalInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : NaN;
}

/* Parse a boolean-ish field (true/false, "true"/"false", 1/0). */
function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

/*
 * GET /api/schedules
 * Optional: ?active=true | ?active=false
 */
router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";
    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE ss.active = $1";
    }
    const result = await pool.query(
      `
      SELECT
        ss.id,
        ss.genset_id,
        ss.service_item_id,
        ss.schedule_start_date,
        ss.interval_days,
        ss.interval_running_hours,
        ss.warning_days,
        ss.track_days,
        ss.track_running_hours,
        ss.notes,
        ss.active,
        g.name AS genset_name,
        g.equipment_tag,
		p.id AS project_id,
        p.name AS project_name,
        si.name AS service_item_name
      FROM public.service_schedules ss
      JOIN public.gensets g        ON g.id = ss.genset_id
      JOIN public.projects p       ON p.id = g.project_id
      JOIN public.service_items si ON si.id = ss.service_item_id
      ${where}
      ORDER BY p.name, g.name, si.name
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
        g.name AS genset_name,
		p.id AS project_id,
        p.name AS project_name,
        si.name AS service_item_name
      FROM public.service_schedules ss
      JOIN public.gensets g        ON g.id = ss.genset_id
      JOIN public.projects p       ON p.id = g.project_id
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

/*
 * Shared validation + normalization for POST/PUT.
 * Returns { error } or { data }.
 */
function buildScheduleData(body) {
  const genset_id = Number.parseInt(body.genset_id, 10);
  const service_item_id = Number.parseInt(body.service_item_id, 10);
  const interval_days = Number.parseInt(body.interval_days, 10);
  const interval_running_hours = optionalInt(body.interval_running_hours);
  const warning_days =
    body.warning_days === undefined || body.warning_days === null || body.warning_days === ""
      ? 30
      : Number.parseInt(body.warning_days, 10);
  const track_days = toBool(body.track_days, true);
  const track_running_hours = toBool(body.track_running_hours, false);
  const schedule_start_date = body.schedule_start_date;
  const notes = body.notes ? String(body.notes).trim() : null;

  if (!Number.isInteger(genset_id) || genset_id <= 0) {
    return { error: "genset_id is required" };
  }
  if (!Number.isInteger(service_item_id) || service_item_id <= 0) {
    return { error: "service_item_id is required" };
  }
  if (!Number.isInteger(interval_days) || interval_days <= 0) {
    return { error: "interval_days must be a positive number" };
  }
  if (Number.isNaN(interval_running_hours) || (interval_running_hours !== null && interval_running_hours <= 0)) {
    return { error: "interval_running_hours must be a positive number when provided" };
  }
  if (!Number.isInteger(warning_days) || warning_days < 0) {
    return { error: "warning_days must be zero or greater" };
  }
  if (warning_days > interval_days) {
    return { error: "warning_days cannot exceed interval_days" };
  }
  if (!schedule_start_date) {
    return { error: "schedule_start_date is required" };
  }

  return {
    data: {
      genset_id,
      service_item_id,
      interval_days,
      interval_running_hours,
      warning_days,
      track_days,
      track_running_hours,
      schedule_start_date,
      notes
    }
  };
}

/*
 * POST /api/schedules
 * Body: {
 *   genset_id, service_item_id, interval_days,
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
        (genset_id, service_item_id, interval_days, interval_running_hours,
         warning_days, track_days, track_running_hours,
         schedule_start_date, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
      RETURNING *
      `,
      [
        d.genset_id,
        d.service_item_id,
        d.interval_days,
        d.interval_running_hours,
        d.warning_days,
        d.track_days,
        d.track_running_hours,
        d.schedule_start_date,
        d.notes
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
        genset_id = $1,
        service_item_id = $2,
        interval_days = $3,
        interval_running_hours = $4,
        warning_days = $5,
        track_days = $6,
        track_running_hours = $7,
        schedule_start_date = $8,
        notes = $9,
        active = $10,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING *
      `,
      [
        d.genset_id,
        d.service_item_id,
        d.interval_days,
        d.interval_running_hours,
        d.warning_days,
        d.track_days,
        d.track_running_hours,
        d.schedule_start_date,
        d.notes,
        active !== false,
        id
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

const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * Maps common PostgreSQL constraint errors to friendly responses.
 * Returns true if it handled the error.
 */
function handleConstraint(error, res) {
  if (!error) return false;
  // Unique violation: one active schedule per (genset, service item)
  if (error.code === "23505") {
    res.status(409).json({
      error: "A schedule for this genset and service item already exists"
    });
    return true;
  }
  // Foreign key violation: genset_id or service_item_id does not exist
  if (error.code === "23503") {
    res.status(400).json({
      error: "The selected genset or service item does not exist"
    });
    return true;
  }
  // Check violation: period/warning constraints
  if (error.code === "23514") {
    res.status(400).json({
      error: "Invalid period or warning value for the schedule"
    });
    return true;
  }
  return false;
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
        ss.period_days,
        ss.warning_days,
        ss.notes,
        ss.active,
        g.name AS genset_name,
        g.equipment_tag,
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
 * POST /api/schedules
 * Body: {
 *   genset_id, service_item_id, period_days,
 *   warning_days?, schedule_start_date, notes?
 * }
 */
router.post("/", async (req, res, next) => {
  try {
    const genset_id = Number.parseInt(req.body.genset_id, 10);
    const service_item_id = Number.parseInt(req.body.service_item_id, 10);
    const period_days = Number.parseInt(req.body.period_days, 10);
    const warning_days =
      req.body.warning_days === undefined || req.body.warning_days === null || req.body.warning_days === ""
        ? 30
        : Number.parseInt(req.body.warning_days, 10);
    const schedule_start_date = req.body.schedule_start_date;
    const notes = req.body.notes ? String(req.body.notes).trim() : null;

    if (!Number.isInteger(genset_id) || genset_id <= 0) {
      return res.status(400).json({ error: "genset_id is required" });
    }
    if (!Number.isInteger(service_item_id) || service_item_id <= 0) {
      return res.status(400).json({ error: "service_item_id is required" });
    }
    if (!Number.isInteger(period_days) || period_days <= 0) {
      return res.status(400).json({ error: "period_days must be a positive number" });
    }
    if (!Number.isInteger(warning_days) || warning_days < 0) {
      return res.status(400).json({ error: "warning_days must be zero or greater" });
    }
    if (warning_days > period_days) {
      return res.status(400).json({ error: "warning_days cannot exceed period_days" });
    }
    if (!schedule_start_date) {
      return res.status(400).json({ error: "schedule_start_date is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.service_schedules
        (genset_id, service_item_id, period_days, warning_days,
         schedule_start_date, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING *
      `,
      [genset_id, service_item_id, period_days, warning_days, schedule_start_date, notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleConstraint(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/schedules/:id
 * Body: {
 *   genset_id, service_item_id, period_days,
 *   warning_days?, schedule_start_date, notes?, active
 * }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid schedule id" });
    }

    const genset_id = Number.parseInt(req.body.genset_id, 10);
    const service_item_id = Number.parseInt(req.body.service_item_id, 10);
    const period_days = Number.parseInt(req.body.period_days, 10);
    const warning_days =
      req.body.warning_days === undefined || req.body.warning_days === null || req.body.warning_days === ""
        ? 30
        : Number.parseInt(req.body.warning_days, 10);
    const schedule_start_date = req.body.schedule_start_date;
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    const active = req.body.active;

    if (!Number.isInteger(genset_id) || genset_id <= 0) {
      return res.status(400).json({ error: "genset_id is required" });
    }
    if (!Number.isInteger(service_item_id) || service_item_id <= 0) {
      return res.status(400).json({ error: "service_item_id is required" });
    }
    if (!Number.isInteger(period_days) || period_days <= 0) {
      return res.status(400).json({ error: "period_days must be a positive number" });
    }
    if (warning_days > period_days) {
      return res.status(400).json({ error: "warning_days cannot exceed period_days" });
    }
    if (!schedule_start_date) {
      return res.status(400).json({ error: "schedule_start_date is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.service_schedules
      SET
        genset_id = $1,
        service_item_id = $2,
        period_days = $3,
        warning_days = $4,
        schedule_start_date = $5,
        notes = $6,
        active = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING *
      `,
      [
        genset_id,
        service_item_id,
        period_days,
        warning_days,
        schedule_start_date,
        notes,
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
 * DELETE /api/schedules/:id
 * Soft delete. A hard DELETE would fail because service_records
 * references service_schedules with ON DELETE RESTRICT.
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

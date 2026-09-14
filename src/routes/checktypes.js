const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({ error: "A check type with this name already exists", field: "name" });
    return true;
  }
  return false;
}

/*
 * GET /api/checktypes
 * Lookup table (Firmware, EOL, EOS) referenced by check_logs and
 * version_logs. No "active" flag on this table — it's a small fixed
 * enum, and check_logs/version_logs both reference it with
 * ON DELETE RESTRICT, so an unused row can still be removed safely.
 */
router.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name FROM public.check_types ORDER BY id`
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid check type id" });
    }
    const result = await pool.query(
      `SELECT id, name FROM public.check_types WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Check type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/checktypes
 * Body: { name }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await pool.query(
      `INSERT INTO public.check_types (name) VALUES ($1) RETURNING id, name`,
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/checktypes/:id
 * Hard delete — blocked by the database (ON DELETE RESTRICT) if any
 * check_logs or version_logs rows still reference this check type.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid check type id" });
    }
    const result = await pool.query(
      `DELETE FROM public.check_types WHERE id = $1 RETURNING id, name`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Check type not found" });
    }
    res.json({ success: true, checkType: result.rows[0] });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(409).json({
        error: "This check type is in use by existing check_logs or version_logs records and cannot be deleted"
      });
    }
    next(error);
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({ error: "A version source with this name already exists", field: "name" });
    return true;
  }
  return false;
}

/*
 * GET /api/versionsources
 * Optional: ?active=true | ?active=false
 * Lookup table (AI-Website, Manual-Website, AI-Email from manufacturer)
 * referenced by check_logs.version_source_id (AI-agent findings only —
 * version_logs, the confirmed/authoritative table, does not use this).
 */
router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";
    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE active = $1";
    }
    const result = await pool.query(
      `SELECT id, name, active, created_at
       FROM public.version_sources
       ${where}
       ORDER BY name`,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/versionsources/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid version source id" });
    }
    const result = await pool.query(
      `SELECT id, name, active, created_at
       FROM public.version_sources WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Version source not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/versionsources
 * Body: { name }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await pool.query(
      `INSERT INTO public.version_sources (name, active)
       VALUES ($1, TRUE)
       RETURNING id, name, active, created_at`,
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/versionsources/:id
 * Body: { name, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid version source id" });
    }
    const name = String(req.body.name ?? "").trim();
    const active = req.body.active;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await pool.query(
      `UPDATE public.version_sources
       SET name = $1, active = $2
       WHERE id = $3
       RETURNING id, name, active, created_at`,
      [name, active !== false, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Version source not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/versionsources/:id (soft delete)
 * A hard delete would fail because check_logs references
 * version_sources with ON DELETE SET NULL — soft delete keeps the
 * historical option list clean without breaking past entries.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid version source id" });
    }
    const result = await pool.query(
      `UPDATE public.version_sources
       SET active = FALSE
       WHERE id = $1
       RETURNING id, name, active`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Version source not found" });
    }
    res.json({ success: true, versionSource: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

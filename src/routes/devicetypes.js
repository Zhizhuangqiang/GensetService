const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({ error: "A device type with this name already exists", field: "name" });
    return true;
  }
  return false;
}

/*
 * GET /api/devicetypes
 * Optional: ?active=true | ?active=false
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
       FROM public.device_types
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
 * GET /api/devicetypes/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid device type id" });
    }
    const result = await pool.query(
      `SELECT id, name, active, created_at
       FROM public.device_types WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/devicetypes
 * Body: { name }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await pool.query(
      `INSERT INTO public.device_types (name, active)
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
 * PUT /api/devicetypes/:id
 * Body: { name, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid device type id" });
    }
    const name = String(req.body.name ?? "").trim();
    const active = req.body.active;
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const result = await pool.query(
      `UPDATE public.device_types
       SET name = $1, active = $2
       WHERE id = $3
       RETURNING id, name, active, created_at`,
      [name, active !== false, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/devicetypes/:id (soft delete)
 * A hard delete would fail because devices reference device_types
 * with ON DELETE RESTRICT.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid device type id" });
    }
    const result = await pool.query(
      `UPDATE public.device_types
       SET active = FALSE
       WHERE id = $1
       RETURNING id, name, active`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device type not found" });
    }
    res.json({ success: true, deviceType: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

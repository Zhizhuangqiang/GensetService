const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * GET /api/gensets
 * Optional: ?active=true | ?active=false
 * Returns all gensets with their project name.
 */
router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";

    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE g.active = $1";
    }

    const result = await pool.query(
      `
      SELECT
        g.id,
        g.project_id,
        g.name,
        g.equipment_tag,
        g.serial_number,
        g.active,
        g.created_at,
        g.updated_at,
        p.name AS project_name
      FROM public.gensets g
      LEFT JOIN public.projects p ON p.id = g.project_id
      ${where}
      ORDER BY p.name, g.name
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/gensets/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid genset id" });
    }

    const result = await pool.query(
      `
      SELECT
        g.*,
        p.name AS project_name
      FROM public.gensets g
      LEFT JOIN public.projects p ON p.id = g.project_id
      WHERE g.id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/gensets
 * Body: { project_id, name, equipment_tag?, serial_number? }
 */
router.post("/", async (req, res, next) => {
  try {
    const { project_id, name, equipment_tag, serial_number } = req.body;

    if (!project_id || !name || !String(name).trim()) {
      return res.status(400).json({
        error: "project_id and name are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO public.gensets
        (project_id, name, equipment_tag, serial_number, active)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING *
      `,
      [
        project_id,
        String(name).trim(),
        equipment_tag ? String(equipment_tag).trim() : null,
        serial_number ? String(serial_number).trim() : null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * PUT /api/gensets/:id
 * Body: { project_id, name, equipment_tag?, serial_number?, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid genset id" });
    }

    const { project_id, name, equipment_tag, serial_number, active } = req.body;

    if (!project_id || !name || !String(name).trim()) {
      return res.status(400).json({
        error: "project_id and name are required"
      });
    }

    const result = await pool.query(
      `
      UPDATE public.gensets
      SET
        project_id = $1,
        name = $2,
        equipment_tag = $3,
        serial_number = $4,
        active = $5,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
      `,
      [
        project_id,
        String(name).trim(),
        equipment_tag ? String(equipment_tag).trim() : null,
        serial_number ? String(serial_number).trim() : null,
        active !== false,
        id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * DELETE /api/gensets/:id
 * Soft delete. A hard DELETE would fail because service_schedules
 * references gensets with ON DELETE RESTRICT, and it would also
 * destroy maintenance history.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid genset id" });
    }

    const result = await pool.query(
      `
      UPDATE public.gensets
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    res.json({ success: true, genset: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

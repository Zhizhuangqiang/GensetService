const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * GET /api/enginehours
 * Optional: ?genset_id=1
 * Returns engine-hour readings, newest reading first.
 */
router.get("/", async (req, res, next) => {
  try {
    const values = [];
    let where = "";
    if (req.query.genset_id) {
      const gensetId = Number.parseInt(req.query.genset_id, 10);
      if (!Number.isInteger(gensetId) || gensetId <= 0) {
        return res.status(400).json({ error: "Invalid genset_id" });
      }
      values.push(gensetId);
      where = "WHERE eh.genset_id = $1";
    }
    const result = await pool.query(
      `
      SELECT
        eh.id,
        eh.genset_id,
        eh.hours,
        eh.reading_date,
        eh.created_at,
        g.name AS genset_name,
        g.equipment_tag,
		p.id AS project_id,
        p.name AS project_name
      FROM public.engine_hours eh
      JOIN public.gensets g  ON g.id = eh.genset_id
      JOIN public.projects p ON p.id = g.project_id
      ${where}
      ORDER BY eh.reading_date DESC, eh.id DESC
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/enginehours/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid engine hours id" });
    }
    const result = await pool.query(
      `
      SELECT
        eh.id,
        eh.genset_id,
        eh.hours,
        eh.reading_date,
        eh.created_at,
        g.name AS genset_name,
        g.equipment_tag,
		p.id AS project_id,
        p.name AS project_name
      FROM public.engine_hours eh
      JOIN public.gensets g  ON g.id = eh.genset_id
      JOIN public.projects p ON p.id = g.project_id
      WHERE eh.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Engine hours reading not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/enginehours
 * Body: { genset_id, hours, reading_date }
 */
router.post("/", async (req, res, next) => {
  try {
    const genset_id = Number.parseInt(req.body.genset_id, 10);
    const hours = Number(req.body.hours);
    const reading_date = req.body.reading_date;

    if (!Number.isInteger(genset_id) || genset_id <= 0) {
      return res.status(400).json({ error: "genset_id is required" });
    }
    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ error: "hours must be zero or greater" });
    }
    if (!reading_date) {
      return res.status(400).json({ error: "reading_date is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.engine_hours (genset_id, hours, reading_date)
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [genset_id, hours, reading_date]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error && error.code === "23503") {
      return res.status(400).json({ error: "The selected genset does not exist" });
    }
    next(error);
  }
});

/*
 * PUT /api/enginehours/:id
 * Body: { genset_id, hours, reading_date }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid engine hours id" });
    }
    const genset_id = Number.parseInt(req.body.genset_id, 10);
    const hours = Number(req.body.hours);
    const reading_date = req.body.reading_date;

    if (!Number.isInteger(genset_id) || genset_id <= 0) {
      return res.status(400).json({ error: "genset_id is required" });
    }
    if (!Number.isFinite(hours) || hours < 0) {
      return res.status(400).json({ error: "hours must be zero or greater" });
    }
    if (!reading_date) {
      return res.status(400).json({ error: "reading_date is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.engine_hours
      SET genset_id = $1, hours = $2, reading_date = $3
      WHERE id = $4
      RETURNING *
      `,
      [genset_id, hours, reading_date, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Engine hours reading not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (error && error.code === "23503") {
      return res.status(400).json({ error: "The selected genset does not exist" });
    }
    next(error);
  }
});

/*
 * DELETE /api/enginehours/:id
 * Hard delete — engine-hour readings carry no dependent rows.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid engine hours id" });
    }
    const result = await pool.query(
      "DELETE FROM public.engine_hours WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Engine hours reading not found" });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

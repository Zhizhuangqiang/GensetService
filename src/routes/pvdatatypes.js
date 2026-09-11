const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * GET /api/pvdatatypes
 * Read-only lookup: boolean, numeric, text.
 */
router.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, name, active, created_at, updated_at
       FROM public.pv_data_types
       ORDER BY name`
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
      return res.status(400).json({ error: "Invalid data type id" });
    }
    const result = await pool.query(
      `SELECT id, name, active, created_at, updated_at
       FROM public.pv_data_types WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Data type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

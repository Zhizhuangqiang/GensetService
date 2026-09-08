const express = require("express");
const pool = require("../db");
const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";
    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE active = $1";
    }
    const result = await pool.query(`
      SELECT id, name, description, active, created_at, updated_at
      FROM public.service_items
      ${where}
      ORDER BY name
    `, values);
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
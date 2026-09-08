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
      where = "WHERE ss.active = $1";
    }
    const result = await pool.query(`
      SELECT
        ss.id,
        ss.genset_id,
        ss.service_item_id,
        ss.schedule_start_date,
        ss.period_days,
        ss.warning_days,
        ss.active,
        g.name AS genset_name,
        g.equipment_tag,
        p.name AS project_name,
        si.name AS service_item_name
      FROM public.service_schedules ss
      JOIN public.gensets g       ON g.id = ss.genset_id
      JOIN public.projects p      ON p.id = g.project_id
      JOIN public.service_items si ON si.id = ss.service_item_id
      ${where}
      ORDER BY p.name, g.name, si.name
    `, values);
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
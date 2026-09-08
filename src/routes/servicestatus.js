const express = require("express");
const pool = require("../db");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        schedule_id,
        project_id,
        project_name,
        genset_id,
        genset_name,
        equipment_tag,
        service_item_id,
        service_item_name,
        schedule_start_date,
        period_days,
        warning_days,
        last_service_record_id,
        last_service_date,
        next_due_date,
        days_remaining,
        status
      FROM maintenance_status
      ORDER BY
        CASE status
          WHEN 'OVERDUE' THEN 1
          WHEN 'DUE_SOON' THEN 2
          WHEN 'OK' THEN 3
          WHEN 'NOT_SET' THEN 4
          ELSE 5
        END,
        next_due_date NULLS LAST,
        project_name,
        genset_name,
        service_item_name
    `);

    res.json({
      count: result.rowCount,
      items: result.rows
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
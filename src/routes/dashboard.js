const express = require("express");
const pool = require("../db");

const router = express.Router();

router.get("/", async (_req, res, next) => {
  try {
    const sql = `
      SELECT
        (SELECT COUNT(*)::int FROM projects WHERE active = TRUE) AS "activeProjects",
        (SELECT COUNT(*)::int FROM gensets WHERE active = TRUE) AS "activeGensets",
        (SELECT COUNT(*)::int FROM service_items WHERE active = TRUE) AS "activeServiceItems",
        (SELECT COUNT(*)::int FROM service_schedules WHERE active = TRUE) AS "activeSchedules",
        (SELECT COUNT(*)::int FROM service_records) AS "serviceRecords",
        (SELECT COUNT(*)::int FROM service_attachments) AS "attachments",
        (SELECT COUNT(*)::int
           FROM service_schedules
          WHERE active = TRUE
            AND initial_due_date IS NOT NULL
            AND initial_due_date < CURRENT_DATE) AS "overdueInitialDates",
        (SELECT COUNT(*)::int
           FROM service_schedules
          WHERE active = TRUE
            AND initial_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS "dueWithin30Days"
    `;
    const result = await pool.query(sql);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/upcoming", async (req, res, next) => {
  try {
    const requestedDays = Number.parseInt(req.query.days || "30", 10);
    const days = Number.isFinite(requestedDays)
      ? Math.min(Math.max(requestedDays, 1), 365)
      : 30;

    const result = await pool.query(`
      SELECT
        ss.id AS schedule_id,
        ss.initial_due_date AS due_date,
        ss.period_days,
        ss.warning_days,
        p.id AS project_id,
        p.name AS project_name,
        g.id AS genset_id,
        g.name AS genset_name,
        g.equipment_tag,
        si.id AS service_item_id,
        si.name AS service_item_name,
        sc.name AS category_name
      FROM service_schedules ss
      JOIN gensets g ON g.id = ss.genset_id
      JOIN projects p ON p.id = g.project_id
      JOIN service_items si ON si.id = ss.service_item_id
      LEFT JOIN service_categories sc ON sc.id = si.category_id
      WHERE ss.active = TRUE
        AND ss.initial_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
      ORDER BY ss.initial_due_date, p.name, g.name, si.name
    `, [days]);

    res.json({ days, count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/overdue", async (_req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        ss.id AS schedule_id,
        ss.initial_due_date AS due_date,
        CURRENT_DATE - ss.initial_due_date AS days_overdue,
        p.name AS project_name,
        g.name AS genset_name,
        g.equipment_tag,
        si.name AS service_item_name,
        sc.name AS category_name
      FROM service_schedules ss
      JOIN gensets g ON g.id = ss.genset_id
      JOIN projects p ON p.id = g.project_id
      JOIN service_items si ON si.id = ss.service_item_id
      LEFT JOIN service_categories sc ON sc.id = si.category_id
      WHERE ss.active = TRUE
        AND ss.initial_due_date IS NOT NULL
        AND ss.initial_due_date < CURRENT_DATE
      ORDER BY ss.initial_due_date, p.name, g.name
    `);

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/recent", async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit || "20", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;

    const result = await pool.query(`
      SELECT
        sr.id AS service_record_id,
        sr.service_date,
        sr.engine_hours,
        sr.performed_by,
        sr.work_order_number,
        sr.report_reference,
        sr.remarks,
        p.name AS project_name,
        g.name AS genset_name,
        g.equipment_tag,
        si.name AS service_item_name
      FROM service_records sr
      JOIN gensets g ON g.id = sr.genset_id
      JOIN projects p ON p.id = g.project_id
      JOIN service_items si ON si.id = sr.service_item_id
      ORDER BY sr.service_date DESC, sr.id DESC
      LIMIT $1
    `, [limit]);

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

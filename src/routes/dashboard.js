const express = require("express");
const pool = require("../db");

const router = express.Router();

/*
 * GET /api/dashboard
 *
 * Returns the main dashboard counters.
 */
router.get("/", async (_req, res, next) => {
  try {
    const sql = `
      SELECT
        (
          SELECT COUNT(*)::int
          FROM projects
          WHERE active = TRUE
        ) AS "activeProjects",

        (
          SELECT COUNT(*)::int
          FROM gensets
          WHERE active = TRUE
        ) AS "activeGensets",

        (
          SELECT COUNT(*)::int
          FROM service_items
          WHERE active = TRUE
        ) AS "activeServiceItems",

        (
          SELECT COUNT(*)::int
          FROM service_schedules
          WHERE active = TRUE
        ) AS "activeSchedules",

        (
          SELECT COUNT(*)::int
          FROM service_records
        ) AS "serviceRecords",

        (
          SELECT COUNT(*)::int
          FROM service_attachments
        ) AS "attachments",

        (
          SELECT COUNT(*)::int
          FROM maintenance_status
          WHERE status = 'OVERDUE'
        ) AS "overdueItems",

        (
          SELECT COUNT(*)::int
          FROM maintenance_status
          WHERE status = 'DUE_SOON'
        ) AS "dueSoonItems",

        (
          SELECT COUNT(*)::int
          FROM maintenance_status
          WHERE status = 'OK'
        ) AS "okItems",

        (
          SELECT COUNT(*)::int
          FROM maintenance_status
          WHERE status = 'NOT_SET'
        ) AS "notSetItems"
    `;

    const result = await pool.query(sql);

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/upcoming
 * GET /api/dashboard/upcoming?days=30
 *
 * Returns service schedules due between today and the requested
 * number of days from today.
 *
 * Valid range: 1 to 365 days.
 */
router.get("/upcoming", async (req, res, next) => {
  try {
    const requestedDays = Number.parseInt(
      req.query.days || "30",
      10
    );

    const days = Number.isInteger(requestedDays)
      ? Math.min(Math.max(requestedDays, 1), 365)
      : 30;

    const sql = `
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
      WHERE next_due_date BETWEEN CURRENT_DATE
                              AND CURRENT_DATE + $1::int
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;

    const result = await pool.query(sql, [days]);

    res.json({
      days,
      count: result.rowCount,
      items: result.rows
    });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/overdue
 *
 * Returns all overdue service schedules.
 */
router.get("/overdue", async (_req, res, next) => {
  try {
    const sql = `
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
        ABS(days_remaining) AS days_overdue,
        status
      FROM maintenance_status
      WHERE status = 'OVERDUE'
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;

    const result = await pool.query(sql);

    res.json({
      count: result.rowCount,
      items: result.rows
    });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/due-soon
 *
 * Returns schedules currently within their individual
 * warning period.
 */
router.get("/due-soon", async (_req, res, next) => {
  try {
    const sql = `
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
      WHERE status = 'DUE_SOON'
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;

    const result = await pool.query(sql);

    res.json({
      count: result.rowCount,
      items: result.rows
    });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/status-summary
 *
 * Returns one row per maintenance status for charts or cards.
 */
router.get("/status-summary", async (_req, res, next) => {
  try {
    const sql = `
      SELECT
        status,
        COUNT(*)::int AS count
      FROM maintenance_status
      GROUP BY status
      ORDER BY
        CASE status
          WHEN 'OVERDUE' THEN 1
          WHEN 'DUE_SOON' THEN 2
          WHEN 'OK' THEN 3
          WHEN 'NOT_SET' THEN 4
          ELSE 5
        END
    `;

    const result = await pool.query(sql);

    const summary = {
      OVERDUE: 0,
      DUE_SOON: 0,
      OK: 0,
      NOT_SET: 0
    };

    for (const row of result.rows) {
      summary[row.status] = row.count;
    }

    res.json({
      total:
        summary.OVERDUE +
        summary.DUE_SOON +
        summary.OK +
        summary.NOT_SET,
      statuses: summary
    });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/recent
 * GET /api/dashboard/recent?limit=20
 *
 * Returns the most recently completed service records.
 *
 * Valid range: 1 to 100 records.
 */
router.get("/recent", async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(
      req.query.limit || "20",
      10
    );

    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;

    const sql = `
      SELECT
        sr.id AS service_record_id,
        sr.service_date,
        sr.engine_hours,
        sr.performed_by,
        sr.work_order_number,
        sr.report_reference,
        sr.remarks,

        p.id AS project_id,
        p.name AS project_name,

        g.id AS genset_id,
        g.name AS genset_name,
        g.equipment_tag,

        si.id AS service_item_id,
        si.name AS service_item_name,

        (
          SELECT COUNT(*)::int
          FROM service_attachments sa
          WHERE sa.service_record_id = sr.id
        ) AS attachment_count

      FROM service_records sr

      JOIN gensets g
        ON g.id = sr.genset_id

      JOIN projects p
        ON p.id = g.project_id

      JOIN service_items si
        ON si.id = sr.service_item_id

      ORDER BY
        sr.service_date DESC,
        sr.id DESC

      LIMIT $1::int
    `;

    const result = await pool.query(sql, [limit]);

    res.json({
      limit,
      count: result.rowCount,
      items: result.rows
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * The status view was rebuilt as public.v_service_status on the new
 * service_schedule_id link. Its status column is "service_status" and it
 * emits OVERDUE, DUE_SOON, OK, NO_BASELINE_DATE, NO_PERIOD, INACTIVE.
 *
 * This helper maps every non-actionable value to NOT_SET and exposes it
 * as "status" so the frontend keeps working unchanged.
 */
const STATUS_SELECT = `
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
  last_service_date,
  next_due_date,
  days_remaining,
  CASE
    WHEN service_status IN ('OVERDUE', 'DUE_SOON', 'OK')
      THEN service_status
    ELSE 'NOT_SET'
  END AS status
`;

/*
 * GET /api/dashboard
 * Returns the main dashboard counters.
 */
router.get("/", async (_req, res, next) => {
  try {
    const sql = `
      WITH status AS (
        SELECT
          CASE
            WHEN service_status IN ('OVERDUE', 'DUE_SOON', 'OK')
              THEN service_status
            ELSE 'NOT_SET'
          END AS status
        FROM public.v_service_status
      )
      SELECT
        (SELECT COUNT(*)::int FROM public.projects WHERE active = TRUE)          AS "activeProjects",
        (SELECT COUNT(*)::int FROM public.gensets WHERE active = TRUE)           AS "activeGensets",
        (SELECT COUNT(*)::int FROM public.service_items WHERE active = TRUE)     AS "activeServiceItems",
        (SELECT COUNT(*)::int FROM public.service_schedules WHERE active = TRUE) AS "activeSchedules",
        (SELECT COUNT(*)::int FROM public.service_records)                       AS "serviceRecords",
        (SELECT COUNT(*)::int FROM public.service_attachments)                   AS "attachments",
        (SELECT COUNT(*)::int FROM status WHERE status = 'OVERDUE')              AS "overdueItems",
        (SELECT COUNT(*)::int FROM status WHERE status = 'DUE_SOON')             AS "dueSoonItems",
        (SELECT COUNT(*)::int FROM status WHERE status = 'OK')                   AS "okItems",
        (SELECT COUNT(*)::int FROM status WHERE status = 'NOT_SET')              AS "notSetItems"
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
 * Service schedules due between today and the requested number of days.
 * Valid range: 1 to 365 days.
 */
router.get("/upcoming", async (req, res, next) => {
  try {
    const requestedDays = Number.parseInt(req.query.days || "30", 10);
    const days = Number.isInteger(requestedDays)
      ? Math.min(Math.max(requestedDays, 1), 365)
      : 30;

    const sql = `
      SELECT ${STATUS_SELECT}
      FROM public.v_service_status
      WHERE next_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;
    const result = await pool.query(sql, [days]);
    res.json({ days, count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/overdue
 * All overdue service schedules.
 */
router.get("/overdue", async (_req, res, next) => {
  try {
    const sql = `
      SELECT
        ${STATUS_SELECT},
        ABS(days_remaining) AS days_overdue
      FROM public.v_service_status
      WHERE service_status = 'OVERDUE'
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;
    const result = await pool.query(sql);
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/due-soon
 * Schedules currently within their warning period.
 */
router.get("/due-soon", async (_req, res, next) => {
  try {
    const sql = `
      SELECT ${STATUS_SELECT}
      FROM public.v_service_status
      WHERE service_status = 'DUE_SOON'
      ORDER BY
        next_due_date,
        project_name,
        genset_name,
        service_item_name
    `;
    const result = await pool.query(sql);
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/dashboard/status-summary
 * One row per status for charts or cards.
 */
router.get("/status-summary", async (_req, res, next) => {
  try {
    const sql = `
      SELECT
        CASE
          WHEN service_status IN ('OVERDUE', 'DUE_SOON', 'OK')
            THEN service_status
          ELSE 'NOT_SET'
        END AS status,
        COUNT(*)::int AS count
      FROM public.v_service_status
      GROUP BY 1
    `;
    const result = await pool.query(sql);

    const summary = { OVERDUE: 0, DUE_SOON: 0, OK: 0, NOT_SET: 0 };
    for (const row of result.rows) {
      summary[row.status] = row.count;
    }

    res.json({
      total: summary.OVERDUE + summary.DUE_SOON + summary.OK + summary.NOT_SET,
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
 * Most recently completed service records. Genset, project and service
 * item are derived through the linked service schedule (the record no
 * longer stores genset_id or service_item_id directly).
 *
 * Valid range: 1 to 100 records.
 */
router.get("/recent", async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit || "20", 10);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;

    const sql = `
      SELECT
        sr.id AS service_record_id,
        sr.service_schedule_id,
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
          FROM public.service_attachments sa
          WHERE sa.service_record_id = sr.id
        ) AS attachment_count
      FROM public.service_records sr
      JOIN public.service_schedules ss ON ss.id = sr.service_schedule_id
      JOIN public.gensets g            ON g.id = ss.genset_id
      JOIN public.projects p           ON p.id = g.project_id
      JOIN public.service_items si     ON si.id = ss.service_item_id
      ORDER BY
        sr.service_date DESC,
        sr.id DESC
      LIMIT $1::int
    `;
    const result = await pool.query(sql, [limit]);
    res.json({ limit, count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

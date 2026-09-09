const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * GET /api/servicestatus
 * Optional: ?status=OVERDUE | DUE_SOON | OK | NOT_SET
 *
 * Reads from the v_service_status view (rebuilt on service_schedule_id).
 *
 * The view emits these service_status values:
 *   OVERDUE, DUE_SOON, OK, NO_BASELINE_DATE, NO_PERIOD, INACTIVE
 *
 * For frontend compatibility, NO_BASELINE_DATE, NO_PERIOD and INACTIVE
 * are all mapped to NOT_SET and exposed as "status".
 */
router.get("/", async (req, res, next) => {
  try {
    const requested = String(req.query.status || "").toUpperCase();
    const allowed = ["OVERDUE", "DUE_SOON", "OK", "NOT_SET"];

    const values = [];
    let having = "";

    if (requested) {
      if (!allowed.includes(requested)) {
        return res.status(400).json({
          error: "Invalid status",
          allowedValues: allowed
        });
      }
      values.push(requested);
      // Filter on the mapped status, not the raw view value.
      having = "WHERE mapped.status = $1";
    }

    const result = await pool.query(
      `
      SELECT *
      FROM (
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
          last_service_date,
          next_due_date,
          days_remaining,
          CASE
            WHEN service_status IN ('OVERDUE', 'DUE_SOON', 'OK')
              THEN service_status
            ELSE 'NOT_SET'
          END AS status,
          service_status AS raw_status
        FROM public.v_service_status
      ) AS mapped
      ${having}
      ORDER BY
        CASE mapped.status
          WHEN 'OVERDUE'  THEN 1
          WHEN 'DUE_SOON' THEN 2
          WHEN 'OK'       THEN 3
          WHEN 'NOT_SET'  THEN 4
          ELSE 5
        END,
        mapped.next_due_date NULLS LAST,
        mapped.project_name,
        mapped.genset_name,
        mapped.service_item_name
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/servicestatus/summary
 * Status counts for dashboard KPI cards.
 */
router.get("/summary", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE service_status = 'OVERDUE')::int  AS "overdue",
        COUNT(*) FILTER (WHERE service_status = 'DUE_SOON')::int AS "dueSoon",
        COUNT(*) FILTER (WHERE service_status = 'OK')::int       AS "ok",
        COUNT(*) FILTER (
          WHERE service_status NOT IN ('OVERDUE', 'DUE_SOON', 'OK')
        )::int AS "notSet",
        COUNT(*)::int AS "total"
      FROM public.v_service_status
      `
    );
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

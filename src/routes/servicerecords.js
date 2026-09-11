const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * GET /api/servicerecords
 * Optional: ?limit=20
 * Returns recent completed service records. Project, package and
 * service item are derived through the linked service schedule.
 */
router.get("/", async (req, res, next) => {
  try {
    const requested = Number.parseInt(req.query.limit || "20", 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), 100)
      : 20;
    const result = await pool.query(
      `
      SELECT
        sr.id AS service_record_id,
        sr.service_schedule_id,
        sr.service_date,
        sr.performed_by,
        sr.work_order_number,
        sr.report_reference,
        sr.remarks,
        sr.created_at,
        p.name  AS project_name,
        pkg.id    AS package_id,
        pkg.name  AS package_name,
        pkg.package_tag,
        pt.name AS package_type_name,
        si.id   AS service_item_id,
        si.name AS service_item_name,
        (
          SELECT COUNT(*)::int
          FROM public.service_attachments sa
          WHERE sa.service_record_id = sr.id
        ) AS attachment_count
      FROM public.service_records sr
      JOIN public.service_schedules ss ON ss.id = sr.service_schedule_id
      JOIN public.packages pkg         ON pkg.id = ss.package_id
      JOIN public.package_types pt     ON pt.id = pkg.package_type_id
      JOIN public.projects p           ON p.id = pkg.project_id
      JOIN public.service_items si     ON si.id = ss.service_item_id
      ORDER BY sr.service_date DESC, sr.id DESC
      LIMIT $1
      `,
      [limit]
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/servicerecords/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service record id" });
    }
    const result = await pool.query(
      `
      SELECT
        sr.*,
        p.name  AS project_name,
        pkg.name AS package_name,
        pkg.package_tag,
        pt.name AS package_type_name,
        si.name AS service_item_name
      FROM public.service_records sr
      JOIN public.service_schedules ss ON ss.id = sr.service_schedule_id
      JOIN public.packages pkg         ON pkg.id = ss.package_id
      JOIN public.package_types pt     ON pt.id = pkg.package_type_id
      JOIN public.projects p           ON p.id = pkg.project_id
      JOIN public.service_items si     ON si.id = ss.service_item_id
      WHERE sr.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service record not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/servicerecords
 * Body: { service_schedule_id, service_date, performed_by?,
 *         work_order_number?, report_reference?, remarks? }
 *
 * The record is linked to a service schedule. Package and service item
 * are not stored directly on the record; they are derived through the
 * schedule.
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      service_schedule_id,
      service_date,
      performed_by,
      work_order_number,
      report_reference,
      remarks
    } = req.body;

    if (!service_schedule_id || !service_date) {
      return res.status(400).json({
        error: "service_schedule_id and service_date are required"
      });
    }

    const schedule = await pool.query(
      "SELECT id FROM public.service_schedules WHERE id = $1",
      [service_schedule_id]
    );
    if (schedule.rowCount === 0) {
      return res.status(400).json({ error: "Invalid service_schedule_id" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.service_records
        (service_schedule_id, service_date,
         performed_by, work_order_number, report_reference, remarks)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        service_schedule_id,
        service_date,
        performed_by ?? null,
        work_order_number ?? null,
        report_reference ?? null,
        remarks ?? null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * PUT /api/servicerecords/:id
 * Updates an existing service record. The linked schedule can be changed.
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service record id" });
    }
    const {
      service_schedule_id,
      service_date,
      performed_by,
      work_order_number,
      report_reference,
      remarks
    } = req.body;
    if (!service_schedule_id || !service_date) {
      return res.status(400).json({
        error: "service_schedule_id and service_date are required"
      });
    }
    const schedule = await pool.query(
      "SELECT id FROM public.service_schedules WHERE id = $1",
      [service_schedule_id]
    );
    if (schedule.rowCount === 0) {
      return res.status(400).json({ error: "Invalid service_schedule_id" });
    }
    const result = await pool.query(
      `
      UPDATE public.service_records
      SET
        service_schedule_id = $1,
        service_date = $2,
        performed_by = $3,
        work_order_number = $4,
        report_reference = $5,
        remarks = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
      `,
      [
        service_schedule_id,
        service_date,
        performed_by ?? null,
        work_order_number ?? null,
        report_reference ?? null,
        remarks ?? null,
        id
      ]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service record not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * DELETE /api/servicerecords/:id
 * Hard delete is allowed here because attachments cascade with the record.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service record id" });
    }
    const result = await pool.query(
      "DELETE FROM public.service_records WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service record not found" });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

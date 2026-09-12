const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/*
 * Look up an attribute's data type name (boolean/numeric/text) so the
 * incoming JS value can be converted to the correctly-typed JSON value
 * before insert. The database also enforces this via a CHECK constraint
 * (chk_pv_log_value_type), so this is a defense-in-depth convenience
 * that produces a friendlier 400 error before hitting the DB.
 */
async function findAttribute(pvAttributeId) {
  const result = await pool.query(
    `
    SELECT pa.id, pa.package_type_id, dt.name AS data_type_name, pa.active
    FROM public.pv_attributes pa
    JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
    WHERE pa.id = $1
    `,
    [pvAttributeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

function coerceValue(rawValue, dataTypeName) {
  if (dataTypeName === "boolean") {
    if (typeof rawValue === "boolean") return rawValue;
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    return { error: "Value must be a boolean for this attribute" };
  }
  if (dataTypeName === "numeric") {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) {
      return { error: "Value must be a number for this attribute" };
    }
    return n;
  }
  // text
  const s = String(rawValue ?? "").trim();
  if (!s) return { error: "Value is required for this attribute" };
  return s;
}

/*
 * GET /api/pvlog
 * Optional filters: ?package_id=1 & ?pv_attribute_id=2
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.package_id !== undefined) {
      const packageId = parseId(req.query.package_id);
      if (!packageId) return res.status(400).json({ error: "Invalid package_id filter" });
      values.push(packageId);
      conditions.push(`pl.package_id = $${values.length}`);
    }

    if (req.query.pv_attribute_id !== undefined) {
      const pvAttributeId = parseId(req.query.pv_attribute_id);
      if (!pvAttributeId) return res.status(400).json({ error: "Invalid pv_attribute_id filter" });
      values.push(pvAttributeId);
      conditions.push(`pl.pv_attribute_id = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        pl.id,
        pl.package_id,
        pkg.name AS package_name,
        pkg.package_tag,
        proj.id AS project_id,
        proj.name AS project_name,
        pl.pv_attribute_id,
        pa.name AS attribute_name,
        pa.unit,
        dt.name AS data_type_name,
        pl.reading_date,
        pl.value,
        pl.technician_id,
        t.name AS technician_name,
        t.company_name AS technician_company,
        pl.notes,
        pl.created_at
      FROM public.pv_log pl
      JOIN public.packages pkg     ON pkg.id = pl.package_id
      JOIN public.projects proj    ON proj.id = pkg.project_id
      JOIN public.pv_attributes pa ON pa.id = pl.pv_attribute_id
      JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
      LEFT JOIN public.technicians t ON t.id = pl.technician_id
      ${where}
      ORDER BY pl.reading_date DESC, pl.id DESC
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/pvlog/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid reading id" });

    const result = await pool.query(
      `
      SELECT
        pl.id, pl.package_id, pkg.name AS package_name, pkg.package_tag,
        proj.id AS project_id, proj.name AS project_name,
        pl.pv_attribute_id, pa.name AS attribute_name, pa.unit,
        dt.name AS data_type_name,
        pl.reading_date, pl.value,
        pl.technician_id, t.name AS technician_name, t.company_name AS technician_company,
        pl.notes, pl.created_at
      FROM public.pv_log pl
      JOIN public.packages pkg     ON pkg.id = pl.package_id
      JOIN public.projects proj    ON proj.id = pkg.project_id
      JOIN public.pv_attributes pa ON pa.id = pl.pv_attribute_id
      JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
      LEFT JOIN public.technicians t ON t.id = pl.technician_id
      WHERE pl.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reading not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/pvlog/latest/:packageId
 * Returns the most recent reading for every attribute applicable to
 * the package's type (useful for a package's "current status" view).
 */
router.get("/latest/:packageId", async (req, res, next) => {
  try {
    const packageId = parseId(req.params.packageId);
    if (!packageId) return res.status(400).json({ error: "Invalid package id" });

    const result = await pool.query(
      `
      SELECT DISTINCT ON (pa.id)
        pa.id AS pv_attribute_id,
        pa.name AS attribute_name,
        pa.unit,
        dt.name AS data_type_name,
        pl.id AS reading_id,
        pl.reading_date,
        pl.value,
        pl.technician_id,
        t.name AS technician_name
      FROM public.pv_attributes pa
      JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
      JOIN public.packages pkg     ON pkg.package_type_id = pa.package_type_id
      LEFT JOIN public.pv_log pl
        ON pl.pv_attribute_id = pa.id AND pl.package_id = pkg.id
      LEFT JOIN public.technicians t ON t.id = pl.technician_id
      WHERE pkg.id = $1 AND pa.active = TRUE
      ORDER BY pa.id, pl.reading_date DESC, pl.id DESC
      `,
      [packageId]
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/pvlog
 * Body: { package_id, pv_attribute_id, value, reading_date?, technician_id?, notes? }
 *
 * "value" is the raw JS value (true/false, a number, or a string) and is
 * coerced to match the attribute's declared data_type before insert.
 * technician_id is optional and references public.technicians.
 */
router.post("/", async (req, res, next) => {
  try {
    const packageId = parseId(req.body.package_id);
    const pvAttributeId = parseId(req.body.pv_attribute_id);
    const readingDate = req.body.reading_date || new Date().toISOString().slice(0, 10);
    const notes = String(req.body.notes ?? "").trim() || null;

    if (!packageId) {
      return res.status(400).json({ error: "package_id is required" });
    }
    if (!pvAttributeId) {
      return res.status(400).json({ error: "pv_attribute_id is required" });
    }
    if (req.body.value === undefined || req.body.value === null || req.body.value === "") {
      return res.status(400).json({ error: "value is required" });
    }

    const technicianIdRaw = req.body.technician_id;
    const technicianId = technicianIdRaw === undefined || technicianIdRaw === null || technicianIdRaw === ""
      ? null
      : Number.parseInt(technicianIdRaw, 10);
    if (technicianId !== null && (!Number.isInteger(technicianId) || technicianId <= 0)) {
      return res.status(400).json({ error: "Invalid technician_id" });
    }
    if (technicianId !== null) {
      const technician = await pool.query(
        "SELECT id FROM public.technicians WHERE id = $1",
        [technicianId]
      );
      if (technician.rowCount === 0) {
        return res.status(400).json({ error: "Invalid technician_id: technician does not exist" });
      }
    }

    const attribute = await findAttribute(pvAttributeId);
    if (!attribute) {
      return res.status(400).json({ error: "Invalid pv_attribute_id: attribute does not exist" });
    }

    const coerced = coerceValue(req.body.value, attribute.data_type_name);
    if (coerced && typeof coerced === "object" && coerced.error) {
      return res.status(400).json({ error: coerced.error });
    }

    const result = await pool.query(
      `
      INSERT INTO public.pv_log
        (package_id, pv_attribute_id, reading_date, value, technician_id, notes)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      RETURNING id, package_id, pv_attribute_id, reading_date, value, technician_id, notes, created_at
      `,
      [packageId, pvAttributeId, readingDate, JSON.stringify(coerced), technicianId, notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid package_id, pv_attribute_id or technician_id" });
    }
    if (error.code === "23514") {
      return res.status(400).json({ error: "Value type does not match the attribute's declared data type" });
    }
    next(error);
  }
});

/*
 * DELETE /api/pvlog/:id
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid reading id" });

    const result = await pool.query(
      "DELETE FROM public.pv_log WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Reading not found" });
    }
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

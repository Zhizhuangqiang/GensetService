const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({
      error: "An attribute with this name already exists for this package type"
    });
    return true;
  }
  return false;
}

/*
 * GET /api/pvattributes
 * Optional: ?package_type_id=1 & ?active=true|false
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.package_type_id !== undefined) {
      const packageTypeId = parseId(req.query.package_type_id);
      if (!packageTypeId) {
        return res.status(400).json({ error: "Invalid package_type_id filter" });
      }
      values.push(packageTypeId);
      conditions.push(`pa.package_type_id = $${values.length}`);
    }

    if (req.query.active !== undefined) {
      if (req.query.active !== "true" && req.query.active !== "false") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      values.push(req.query.active === "true");
      conditions.push(`pa.active = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        pa.id,
        pa.package_type_id,
        pt.name AS package_type_name,
        pa.name,
        pa.data_type_id,
        dt.name AS data_type_name,
        pa.unit,
        pa.description,
        pa.active,
        pa.created_at,
        pa.updated_at
      FROM public.pv_attributes pa
      JOIN public.package_types pt ON pt.id = pa.package_type_id
      JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
      ${where}
      ORDER BY pt.name, pa.name
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/pvattributes/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid attribute id" });

    const result = await pool.query(
      `
      SELECT
        pa.id, pa.package_type_id, pt.name AS package_type_name,
        pa.name, pa.data_type_id, dt.name AS data_type_name,
        pa.unit, pa.description, pa.active, pa.created_at, pa.updated_at
      FROM public.pv_attributes pa
      JOIN public.package_types pt ON pt.id = pa.package_type_id
      JOIN public.pv_data_types dt ON dt.id = pa.data_type_id
      WHERE pa.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Attribute not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/pvattributes
 * Body: { package_type_id, name, data_type_id, unit?, description? }
 */
router.post("/", async (req, res, next) => {
  try {
    const packageTypeId = parseId(req.body.package_type_id);
    const dataTypeId = parseId(req.body.data_type_id);
    const name = String(req.body.name ?? "").trim();
    const unit = String(req.body.unit ?? "").trim() || null;
    const description = String(req.body.description ?? "").trim() || null;

    if (!packageTypeId) {
      return res.status(400).json({ error: "package_type_id is required" });
    }
    if (!dataTypeId) {
      return res.status(400).json({ error: "data_type_id is required" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.pv_attributes
        (package_type_id, name, data_type_id, unit, description, active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, package_type_id, name, data_type_id, unit, description, active, created_at, updated_at
      `,
      [packageTypeId, name, dataTypeId, unit, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid package_type_id or data_type_id" });
    }
    next(error);
  }
});

/*
 * PUT /api/pvattributes/:id
 * Body: { name, data_type_id, unit?, description?, active }
 * (package_type_id is intentionally immutable after creation to avoid
 *  orphaning historical pv_log readings tied to the original type.)
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid attribute id" });

    const dataTypeId = parseId(req.body.data_type_id);
    const name = String(req.body.name ?? "").trim();
    const unit = String(req.body.unit ?? "").trim() || null;
    const description = String(req.body.description ?? "").trim() || null;
    const active = req.body.active !== false;

    if (!dataTypeId) {
      return res.status(400).json({ error: "data_type_id is required" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.pv_attributes
      SET name = $1, data_type_id = $2, unit = $3, description = $4,
          active = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING id, package_type_id, name, data_type_id, unit, description, active, created_at, updated_at
      `,
      [name, dataTypeId, unit, description, active, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Attribute not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid data_type_id" });
    }
    next(error);
  }
});

/*
 * DELETE /api/pvattributes/:id  (soft delete)
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid attribute id" });

    const result = await pool.query(
      `
      UPDATE public.pv_attributes
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Attribute not found" });
    }
    res.json({ success: true, attribute: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({ error: "A manufacturer with this name already exists", field: "name" });
    return true;
  }
  return false;
}

async function technicianExists(id) {
  if (id === null) return true;
  const result = await pool.query("SELECT id FROM public.technicians WHERE id = $1", [id]);
  return result.rowCount > 0;
}

function optionalTechId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

const TECH_FIELDS = [
  ["contact1_id", "contact1Id"],
  ["contact2_id", "contact2Id"],
  ["eureka_responsible_1_id", "eureka1Id"],
  ["eureka_responsible_2_id", "eureka2Id"]
];

/*
 * GET /api/manufacturers
 * Optional: ?active=true | ?active=false & ?search=text
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.active === "true" || req.query.active === "false") {
      values.push(req.query.active === "true");
      conditions.push(`m.active = $${values.length}`);
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim()}%`);
      conditions.push(`m.name ILIKE $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT
        m.id, m.name, m.website, m.notes,
        m.contact1_id, c1.name AS contact1_name,
        m.contact2_id, c2.name AS contact2_name,
        m.eureka_responsible_1_id, e1.name AS eureka_responsible_1_name,
        m.eureka_responsible_2_id, e2.name AS eureka_responsible_2_name,
        m.active, m.created_at, m.updated_at,
        (SELECT COUNT(*)::int FROM public.devices d WHERE d.manufacturer_id = m.id) AS device_count
      FROM public.manufacturers m
      LEFT JOIN public.technicians c1 ON c1.id = m.contact1_id
      LEFT JOIN public.technicians c2 ON c2.id = m.contact2_id
      LEFT JOIN public.technicians e1 ON e1.id = m.eureka_responsible_1_id
      LEFT JOIN public.technicians e2 ON e2.id = m.eureka_responsible_2_id
      ${where}
      ORDER BY m.name
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/manufacturers/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid manufacturer id" });
    const result = await pool.query(
      `
      SELECT
        m.id, m.name, m.website, m.notes,
        m.contact1_id, c1.name AS contact1_name,
        m.contact2_id, c2.name AS contact2_name,
        m.eureka_responsible_1_id, e1.name AS eureka_responsible_1_name,
        m.eureka_responsible_2_id, e2.name AS eureka_responsible_2_name,
        m.active, m.created_at, m.updated_at
      FROM public.manufacturers m
      LEFT JOIN public.technicians c1 ON c1.id = m.contact1_id
      LEFT JOIN public.technicians c2 ON c2.id = m.contact2_id
      LEFT JOIN public.technicians e1 ON e1.id = m.eureka_responsible_1_id
      LEFT JOIN public.technicians e2 ON e2.id = m.eureka_responsible_2_id
      WHERE m.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Manufacturer not found" });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/manufacturers
 * Body: { name, website?, notes?, contact1_id?, contact2_id?,
 *         eureka_responsible_1_id?, eureka_responsible_2_id? }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const website = String(req.body.website ?? "").trim() || null;
    const notes = String(req.body.notes ?? "").trim() || null;
    const techIds = {};
    for (const [bodyKey, varName] of TECH_FIELDS) {
      techIds[varName] = optionalTechId(req.body[bodyKey]);
    }

    if (!name) return res.status(400).json({ error: "name is required" });
    for (const [bodyKey, varName] of TECH_FIELDS) {
      if (Number.isNaN(techIds[varName])) {
        return res.status(400).json({ error: `Invalid ${bodyKey}` });
      }
    }
    for (const [bodyKey, varName] of TECH_FIELDS) {
      if (!(await technicianExists(techIds[varName]))) {
        return res.status(400).json({ error: `Invalid ${bodyKey}: technician does not exist` });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO public.manufacturers
        (name, website, notes, contact1_id, contact2_id, eureka_responsible_1_id, eureka_responsible_2_id, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      RETURNING *
      `,
      [name, website, notes, techIds.contact1Id, techIds.contact2Id, techIds.eureka1Id, techIds.eureka2Id]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid technician reference: foreign key violation" });
    }
    next(error);
  }
});

/*
 * PUT /api/manufacturers/:id
 * Body: same as POST plus { active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid manufacturer id" });
    const name = String(req.body.name ?? "").trim();
    const website = String(req.body.website ?? "").trim() || null;
    const notes = String(req.body.notes ?? "").trim() || null;
    const active = req.body.active !== false;
    const techIds = {};
    for (const [bodyKey, varName] of TECH_FIELDS) {
      techIds[varName] = optionalTechId(req.body[bodyKey]);
    }

    if (!name) return res.status(400).json({ error: "name is required" });
    for (const [bodyKey, varName] of TECH_FIELDS) {
      if (Number.isNaN(techIds[varName])) {
        return res.status(400).json({ error: `Invalid ${bodyKey}` });
      }
    }
    for (const [bodyKey, varName] of TECH_FIELDS) {
      if (!(await technicianExists(techIds[varName]))) {
        return res.status(400).json({ error: `Invalid ${bodyKey}: technician does not exist` });
      }
    }

    const result = await pool.query(
      `
      UPDATE public.manufacturers
      SET name = $1, website = $2, notes = $3,
          contact1_id = $4, contact2_id = $5,
          eureka_responsible_1_id = $6, eureka_responsible_2_id = $7,
          active = $8, updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
      `,
      [name, website, notes, techIds.contact1Id, techIds.contact2Id, techIds.eureka1Id, techIds.eureka2Id, active, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Manufacturer not found" });
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid technician reference: foreign key violation" });
    }
    next(error);
  }
});

/*
 * DELETE /api/manufacturers/:id (soft delete)
 * A hard delete would fail because devices reference manufacturers
 * with ON DELETE RESTRICT.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid manufacturer id" });
    const result = await pool.query(
      `
      UPDATE public.manufacturers
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Manufacturer not found" });
    res.json({ success: true, manufacturer: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

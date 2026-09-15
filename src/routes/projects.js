const express = require("express");
const pool = require("../db");
const router = express.Router();

/*
 * Translates a PostgreSQL unique-violation (23505) into a friendly
 * 409 response. Returns true if it handled the error.
 */
function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    // error.constraint may be e.g. projects_code_key or projects_name_key
    const field =
      error.constraint && error.constraint.includes("name")
        ? "name"
        : "code";
    res.status(409).json({
      error: `A project with this ${field} already exists`,
      field
    });
    return true;
  }
  return false;
}

/*
 * Shared SELECT fragment used by both GET / and GET /:id so the two
 * endpoints always return the same shape (id + name for each
 * contact/Eureka-responsible technician, in addition to their FK ids).
 */
const CONTACT_FIELDS = `
  p.customer,
  p.customer_contact1_id, c1.name AS customer_contact1_name,
  p.customer_contact2_id, c2.name AS customer_contact2_name,
  p.eureka_responsible_1_id, e1.name AS eureka_responsible_1_name,
  p.eureka_responsible_2_id, e2.name AS eureka_responsible_2_name,
  p.firmware_agreement_id, p.notes
`;

const CONTACT_JOINS = `
  LEFT JOIN public.technicians c1 ON c1.id = p.customer_contact1_id
  LEFT JOIN public.technicians c2 ON c2.id = p.customer_contact2_id
  LEFT JOIN public.technicians e1 ON e1.id = p.eureka_responsible_1_id
  LEFT JOIN public.technicians e2 ON e2.id = p.eureka_responsible_2_id
`;

/*
 * Validates that a given id (if provided) refers to an existing
 * technician. Returns true if valid or if id is null/undefined.
 */
async function technicianExists(id) {
  if (id === null || id === undefined) return true;
  const result = await pool.query(
    "SELECT id FROM public.technicians WHERE id = $1",
    [id]
  );
  return result.rowCount > 0;
}

function optionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

/*
 * GET /api/projects
 * Optional: ?active=true | ?active=false
 * Returns all projects with a count of their packages, plus resolved
 * names for customer contacts and Eureka responsibles.
 * An empty result is a valid response (not a 404).
 */
router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";
    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE p.active = $1";
    }
    const result = await pool.query(
      `
    SELECT
        p.id, p.code, p.name, p.active, p.created_at, p.updated_at,
        ${CONTACT_FIELDS},
        COUNT(pkg.id)::int AS package_count
    FROM public.projects p
    ${CONTACT_JOINS}
    LEFT JOIN public.packages pkg ON pkg.project_id = p.id
    ${where}
    GROUP BY p.id, p.code, p.name, p.active, p.created_at, p.updated_at,
             p.customer, p.customer_contact1_id, c1.name,
             p.customer_contact2_id, c2.name,
             p.eureka_responsible_1_id, e1.name,
             p.eureka_responsible_2_id, e2.name,
             p.firmware_agreement_id, p.notes
    ORDER BY p.active DESC, p.name ASC
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/projects/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const result = await pool.query(
      `
      SELECT
        p.id, p.code, p.name, p.active, p.created_at, p.updated_at,
        ${CONTACT_FIELDS}
      FROM public.projects p
      ${CONTACT_JOINS}
      WHERE p.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/projects
 * Body: { name, code?, customer?, customer_contact1_id?, customer_contact2_id?,
 *         eureka_responsible_1_id?, eureka_responsible_2_id?, notes? }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const code = req.body.code ? String(req.body.code).trim() : null;
    const customer = req.body.customer ? String(req.body.customer).trim() : null;
    const customerContact1Id = optionalId(req.body.customer_contact1_id);
    const customerContact2Id = optionalId(req.body.customer_contact2_id);
    const eureka1Id = optionalId(req.body.eureka_responsible_1_id);
    const eureka2Id = optionalId(req.body.eureka_responsible_2_id);
    const notes = req.body.notes ? String(req.body.notes).trim() : null;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    if ([customerContact1Id, customerContact2Id, eureka1Id, eureka2Id].some(Number.isNaN)) {
      return res.status(400).json({ error: "Invalid contact or Eureka responsible id" });
    }
    for (const id of [customerContact1Id, customerContact2Id, eureka1Id, eureka2Id]) {
      if (!(await technicianExists(id))) {
        return res.status(400).json({ error: "One or more technician ids do not exist" });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO public.projects
        (name, code, active, customer, customer_contact1_id, customer_contact2_id,
         eureka_responsible_1_id, eureka_responsible_2_id, notes)
      VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [name, code, customer, customerContact1Id, customerContact2Id, eureka1Id, eureka2Id, notes]
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
 * PUT /api/projects/:id
 * Body: { name, code?, active, customer?, customer_contact1_id?, customer_contact2_id?,
 *         eureka_responsible_1_id?, eureka_responsible_2_id?, notes? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const name = String(req.body.name || "").trim();
    const code = req.body.code ? String(req.body.code).trim() : null;
    const active = req.body.active;
    const customer = req.body.customer ? String(req.body.customer).trim() : null;
    const customerContact1Id = optionalId(req.body.customer_contact1_id);
    const customerContact2Id = optionalId(req.body.customer_contact2_id);
    const eureka1Id = optionalId(req.body.eureka_responsible_1_id);
    const eureka2Id = optionalId(req.body.eureka_responsible_2_id);
    const notes = req.body.notes ? String(req.body.notes).trim() : null;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    if ([customerContact1Id, customerContact2Id, eureka1Id, eureka2Id].some(Number.isNaN)) {
      return res.status(400).json({ error: "Invalid contact or Eureka responsible id" });
    }
    for (const tid of [customerContact1Id, customerContact2Id, eureka1Id, eureka2Id]) {
      if (!(await technicianExists(tid))) {
        return res.status(400).json({ error: "One or more technician ids do not exist" });
      }
    }

    const result = await pool.query(
      `
      UPDATE public.projects
      SET
        name = $1,
        code = $2,
        active = $3,
        customer = $4,
        customer_contact1_id = $5,
        customer_contact2_id = $6,
        eureka_responsible_1_id = $7,
        eureka_responsible_2_id = $8,
        notes = $9,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
      `,
      [name, code, active !== false, customer, customerContact1Id, customerContact2Id,
       eureka1Id, eureka2Id, notes, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
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
 * DELETE /api/projects/:id
 * Soft delete. A hard DELETE would fail because gensets reference
 * projects with ON DELETE RESTRICT.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid project id" });
    }
    const result = await pool.query(
      `
      UPDATE public.projects
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Project not found" });
    }
    res.json({ success: true, project: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

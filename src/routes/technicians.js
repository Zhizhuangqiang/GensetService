const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleDuplicateEmail(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({
      error: "A technician with this email already exists",
      field: "email"
    });
    return true;
  }
  return false;
}

/*
 * GET /api/technicians
 * Optional: ?active=true | ?active=false
 */
router.get("/", async (req, res, next) => {
  try {
    const active = req.query.active;
    const values = [];
    let where = "";
    if (active === "true" || active === "false") {
      values.push(active === "true");
      where = "WHERE active = $1";
    }
    const result = await pool.query(
      `
      SELECT id, name, title, company_name, phone, email, notes,
             active, created_at, updated_at
      FROM public.technicians
      ${where}
      ORDER BY name
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/technicians/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid technician id" });

    const result = await pool.query(
      `
      SELECT id, name, title, company_name, phone, email, notes,
             active, created_at, updated_at
      FROM public.technicians
      WHERE id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Technician not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/technicians
 * Body: { name, title?, company_name?, phone?, email?, notes? }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const title = String(req.body.title ?? "").trim() || null;
    const companyName = String(req.body.company_name ?? "").trim() || null;
    const phone = String(req.body.phone ?? "").trim() || null;
    const email = String(req.body.email ?? "").trim() || null;
    const notes = String(req.body.notes ?? "").trim() || null;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.technicians
        (name, title, company_name, phone, email, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      RETURNING id, name, title, company_name, phone, email, notes,
                active, created_at, updated_at
      `,
      [name, title, companyName, phone, email, notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicateEmail(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/technicians/:id
 * Body: { name, title?, company_name?, phone?, email?, notes?, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid technician id" });

    const name = String(req.body.name ?? "").trim();
    const title = String(req.body.title ?? "").trim() || null;
    const companyName = String(req.body.company_name ?? "").trim() || null;
    const phone = String(req.body.phone ?? "").trim() || null;
    const email = String(req.body.email ?? "").trim() || null;
    const notes = String(req.body.notes ?? "").trim() || null;
    const active = req.body.active !== false;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.technicians
      SET name = $1, title = $2, company_name = $3, phone = $4,
          email = $5, notes = $6, active = $7, updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING id, name, title, company_name, phone, email, notes,
                active, created_at, updated_at
      `,
      [name, title, companyName, phone, email, notes, active, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Technician not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicateEmail(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/technicians/:id
 * Soft delete. A hard DELETE would fail because service_records and
 * pv_log reference technicians with ON DELETE RESTRICT, and it would
 * also erase attribution on historical records.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid technician id" });

    const result = await pool.query(
      `
      UPDATE public.technicians
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Technician not found" });
    }
    res.json({ success: true, technician: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

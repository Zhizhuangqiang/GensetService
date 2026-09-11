const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({ error: "A package type with this name already exists" });
    return true;
  }
  return false;
}

/*
 * GET /api/packagetypes
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
      SELECT id, name, active, created_at, updated_at
      FROM public.package_types
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
 * GET /api/packagetypes/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid package type id" });
    }
    const result = await pool.query(
      `SELECT id, name, active, created_at, updated_at
       FROM public.package_types WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Package type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/packagetypes
 * Body: { name }
 *
 * Automatically seeds a "Running Hours" pv_attributes entry for the
 * new type, so every package type supports running-hours logging
 * from the moment it is created.
 */
router.post("/", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO public.package_types (name, active)
       VALUES ($1, TRUE)
       RETURNING id, name, active, created_at, updated_at`,
      [name]
    );

    const numericTypeId = await client.query(
      `SELECT id FROM public.pv_data_types WHERE name = 'numeric'`
    );
    if (numericTypeId.rowCount > 0) {
      await client.query(
        `INSERT INTO public.pv_attributes
           (package_type_id, name, data_type_id, unit, description, active)
         VALUES ($1, 'Running Hours', $2, 'hours',
                 'Cumulative running/operating hours', TRUE)`,
        [inserted.rows[0].id, numericTypeId.rows[0].id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (handleDuplicate(error, res)) return;
    next(error);
  } finally {
    client.release();
  }
});

/*
 * PUT /api/packagetypes/:id
 * Body: { name, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid package type id" });
    }
    const name = String(req.body.name || "").trim();
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }
    const active = req.body.active;

    const result = await pool.query(
      `UPDATE public.package_types
       SET name = $1, active = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING id, name, active, created_at, updated_at`,
      [name, active !== false, id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Package type not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/packagetypes/:id
 * Soft delete. A hard delete would fail because packages reference
 * package_types with ON DELETE RESTRICT.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid package type id" });
    }
    const result = await pool.query(
      `UPDATE public.package_types
       SET active = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, name, active`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Package type not found" });
    }
    res.json({ success: true, packageType: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

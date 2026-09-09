const express = require("express");
const pool = require("../db");
const router = express.Router();

function handleDuplicate(error, res) {
  if (error && error.code === "23505") {
    res.status(409).json({
      error: "A service item with this name already exists",
      field: "name"
    });
    return true;
  }
  return false;
}

/*
 * GET /api/serviceitems
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
      SELECT id, name, description, active, created_at, updated_at
      FROM public.service_items
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
 * GET /api/serviceitems/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service item id" });
    }
    const result = await pool.query(
      `
      SELECT id, name, description, active, created_at, updated_at
      FROM public.service_items
      WHERE id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service item not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/serviceitems
 * Body: { name, description? }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const description = req.body.description
      ? String(req.body.description).trim()
      : null;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.service_items
        (name, description, active)
      VALUES ($1, $2, TRUE)
      RETURNING *
      `,
      [name, description]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/serviceitems/:id
 * Body: { name, description?, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service item id" });
    }

    const name = String(req.body.name || "").trim();
    const description = req.body.description
      ? String(req.body.description).trim()
      : null;
    const active = req.body.active;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.service_items
      SET
        name = $1,
        description = $2,
        active = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [name, description, active !== false, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service item not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/serviceitems/:id
 * Soft delete. A hard DELETE would fail because service_schedules
 * references service_items with ON DELETE RESTRICT.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid service item id" });
    }
    const result = await pool.query(
      `
      UPDATE public.service_items
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Service item not found" });
    }
    res.json({ success: true, serviceItem: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

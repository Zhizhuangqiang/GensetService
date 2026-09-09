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
 * GET /api/projects
 * Optional: ?active=true | ?active=false
 * Returns all projects with a count of their gensets.
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
        p.id,
        p.code,
        p.name,
        p.active,
        p.created_at,
        p.updated_at,
        COUNT(g.id)::int AS genset_count
      FROM public.projects p
      LEFT JOIN public.gensets g ON g.project_id = p.id
      ${where}
      GROUP BY
        p.id, p.code, p.name, p.active, p.created_at, p.updated_at
      ORDER BY
        p.active DESC,
        p.name ASC
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
      SELECT *
      FROM public.projects
      WHERE id = $1
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
 * Body: { name, code? }
 */
router.post("/", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim();
    const code = req.body.code ? String(req.body.code).trim() : null;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      INSERT INTO public.projects
        (name, code, active)
      VALUES ($1, $2, TRUE)
      RETURNING *
      `,
      [name, code]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/projects/:id
 * Body: { name, code?, active }
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

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const result = await pool.query(
      `
      UPDATE public.projects
      SET
        name = $1,
        code = $2,
        active = $3,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [name, code, active !== false, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Project not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    if (handleDuplicate(error, res)) return;
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

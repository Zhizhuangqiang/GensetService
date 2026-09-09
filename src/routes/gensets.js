const express = require("express");
const pool = require("../db");

const router = express.Router();

/* ------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------ */

// Parse and validate a positive integer id from a string.
function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Confirm a project exists and return it (or null).
async function findProject(projectId) {
  const result = await pool.query(
    "SELECT id, active FROM public.projects WHERE id = $1",
    [projectId]
  );
  return result.rowCount ? result.rows[0] : null;
}

// Check whether a genset name OR equipment_tag already exists within the
// same project. Optionally exclude a genset id (used when updating).
// NOTE: $2 and $3 are cast to ::text so PostgreSQL can determine their
// type even when equipment_tag is NULL (fixes error 42P08).
async function findDuplicate(projectId, name, equipmentTag, excludeId = null) {
  const result = await pool.query(
    `
    SELECT id, name, equipment_tag
    FROM public.gensets
    WHERE project_id = $1
      AND ($4::int8 IS NULL OR id <> $4::int8)
      AND (
        LOWER(name) = LOWER($2::text)
        OR ($3::text IS NOT NULL AND equipment_tag IS NOT NULL
            AND LOWER(equipment_tag) = LOWER($3::text))
      )
    LIMIT 1
    `,
    [projectId, name, equipmentTag, excludeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

// Translate a duplicate row into a specific 409 message.
function duplicateMessage(duplicate, name, equipmentTag) {
  if (duplicate.name && name && duplicate.name.toLowerCase() === name.toLowerCase()) {
    return `A genset named "${name}" already exists in this project.`;
  }
  if (
    duplicate.equipment_tag &&
    equipmentTag &&
    duplicate.equipment_tag.toLowerCase() === equipmentTag.toLowerCase()
  ) {
    return `Equipment tag "${equipmentTag}" is already used in this project.`;
  }
  return "A matching genset already exists in this project.";
}

/* ------------------------------------------------------------------
 * GET /api/gensets
 * Optional filters: ?project_id=1  &  ?active=true|false
 * ------------------------------------------------------------------ */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.project_id !== undefined) {
      const projectId = parseId(req.query.project_id);
      if (!projectId) {
        return res.status(400).json({ error: "Invalid project_id filter" });
      }
      values.push(projectId);
      conditions.push(`g.project_id = $${values.length}`);
    }

    if (req.query.active !== undefined) {
      if (req.query.active !== "true" && req.query.active !== "false") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      values.push(req.query.active === "true");
      conditions.push(`g.active = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        g.id,
        g.project_id,
        g.name,
        g.equipment_tag,
        g.serial_number,
        g.active,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.code AS project_code
      FROM public.gensets g
      JOIN public.projects p ON p.id = g.project_id
      ${where}
      ORDER BY p.name, g.name
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------
 * GET /api/gensets/:id
 * ------------------------------------------------------------------ */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid genset id" });

    const result = await pool.query(
      `
      SELECT
        g.id,
        g.project_id,
        g.name,
        g.equipment_tag,
        g.serial_number,
        g.active,
        g.created_at,
        g.updated_at,
        p.name AS project_name,
        p.code AS project_code
      FROM public.gensets g
      JOIN public.projects p ON p.id = g.project_id
      WHERE g.id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/* ------------------------------------------------------------------
 * POST /api/gensets
 * Body: { project_id, name, equipment_tag?, serial_number? }
 * ------------------------------------------------------------------ */
router.post("/", async (req, res, next) => {
  try {
    const projectId = parseId(req.body.project_id);
    const name = String(req.body.name ?? "").trim();
    const equipmentTag = String(req.body.equipment_tag ?? "").trim() || null;
    const serialNumber = String(req.body.serial_number ?? "").trim() || null;

    // --- validation ---
    if (!projectId) {
      return res.status(400).json({ error: "project_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // --- invalid-project handling ---
    const project = await findProject(projectId);
    if (!project) {
      return res.status(400).json({ error: "Invalid project_id: project does not exist" });
    }
    if (project.active === false) {
      return res.status(400).json({ error: "Cannot add a genset to an inactive project" });
    }

    // --- duplicate handling ---
    const duplicate = await findDuplicate(projectId, name, equipmentTag);
    if (duplicate) {
      return res.status(409).json({
        error: duplicateMessage(duplicate, name, equipmentTag),
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      INSERT INTO public.gensets
        (project_id, name, equipment_tag, serial_number, active)
      VALUES ($1, $2, $3, $4, TRUE)
      RETURNING
        id, project_id, name, equipment_tag, serial_number, active,
        created_at, updated_at
      `,
      [projectId, name, equipmentTag, serialNumber]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    // Safety net if a UNIQUE constraint exists at the DB level.
    if (error.code === "23505") {
      return res.status(409).json({ error: "Genset violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id: foreign key violation" });
    }
    next(error);
  }
});

/* ------------------------------------------------------------------
 * PUT /api/gensets/:id
 * Body: { project_id, name, equipment_tag?, serial_number?, active? }
 * ------------------------------------------------------------------ */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid genset id" });

    const projectId = parseId(req.body.project_id);
    const name = String(req.body.name ?? "").trim();
    const equipmentTag = String(req.body.equipment_tag ?? "").trim() || null;
    const serialNumber = String(req.body.serial_number ?? "").trim() || null;
    const active = req.body.active !== false; // defaults to true

    if (!projectId) {
      return res.status(400).json({ error: "project_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // genset must exist
    const existing = await pool.query(
      "SELECT id FROM public.gensets WHERE id = $1",
      [id]
    );
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    // invalid-project handling
    const project = await findProject(projectId);
    if (!project) {
      return res.status(400).json({ error: "Invalid project_id: project does not exist" });
    }

    // duplicate handling (exclude the current genset)
    const duplicate = await findDuplicate(projectId, name, equipmentTag, id);
    if (duplicate) {
      return res.status(409).json({
        error: duplicateMessage(duplicate, name, equipmentTag),
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      UPDATE public.gensets
      SET project_id = $1,
          name = $2,
          equipment_tag = $3,
          serial_number = $4,
          active = $5,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING
        id, project_id, name, equipment_tag, serial_number, active,
        created_at, updated_at
      `,
      [projectId, name, equipmentTag, serialNumber, active, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Genset violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id: foreign key violation" });
    }
    next(error);
  }
});

/* ------------------------------------------------------------------
 * DELETE /api/gensets/:id  (soft delete)
 * Deactivates instead of removing, to preserve schedules/records.
 * ------------------------------------------------------------------ */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid genset id" });

    const result = await pool.query(
      `
      UPDATE public.gensets
      SET active = FALSE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Genset not found" });
    }

    res.json({ message: "Genset deactivated", genset: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

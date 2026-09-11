const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function findProject(projectId) {
  const result = await pool.query(
    "SELECT id, active FROM public.projects WHERE id = $1",
    [projectId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function findPackageType(packageTypeId) {
  const result = await pool.query(
    "SELECT id, active FROM public.package_types WHERE id = $1",
    [packageTypeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/*
 * Check whether a package name OR package_tag already exists within the
 * same project. Optionally exclude a package id (used when updating).
 */
async function findDuplicate(projectId, name, packageTag, excludeId = null) {
  const result = await pool.query(
    `
    SELECT id, name, package_tag
    FROM public.packages
    WHERE project_id = $1
      AND ($4::int8 IS NULL OR id <> $4::int8)
      AND (
        LOWER(name) = LOWER($2::text)
        OR ($3::text IS NOT NULL AND package_tag IS NOT NULL
            AND LOWER(package_tag) = LOWER($3::text))
      )
    LIMIT 1
    `,
    [projectId, name, packageTag, excludeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

function duplicateMessage(duplicate, name, packageTag) {
  if (duplicate.name && name && duplicate.name.toLowerCase() === name.toLowerCase()) {
    return `A package named "${name}" already exists in this project.`;
  }
  if (
    duplicate.package_tag &&
    packageTag &&
    duplicate.package_tag.toLowerCase() === packageTag.toLowerCase()
  ) {
    return `Package tag "${packageTag}" is already used in this project.`;
  }
  return "A matching package already exists in this project.";
}

/*
 * GET /api/packages
 * Optional filters: ?project_id=1 & ?package_type_id=2 & ?active=true|false
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.project_id !== undefined) {
      const projectId = parseId(req.query.project_id);
      if (!projectId) return res.status(400).json({ error: "Invalid project_id filter" });
      values.push(projectId);
      conditions.push(`pkg.project_id = $${values.length}`);
    }

    if (req.query.package_type_id !== undefined) {
      const packageTypeId = parseId(req.query.package_type_id);
      if (!packageTypeId) return res.status(400).json({ error: "Invalid package_type_id filter" });
      values.push(packageTypeId);
      conditions.push(`pkg.package_type_id = $${values.length}`);
    }

    if (req.query.active !== undefined) {
      if (req.query.active !== "true" && req.query.active !== "false") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      values.push(req.query.active === "true");
      conditions.push(`pkg.active = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await pool.query(
      `
      SELECT
        pkg.id,
        pkg.project_id,
        pkg.package_type_id,
        pkg.name,
        pkg.package_tag,
        pkg.serial_number,
        pkg.attributes,
        pkg.active,
        pkg.created_at,
        pkg.updated_at,
        p.name AS project_name,
        p.code AS project_code,
        pt.name AS package_type_name
      FROM public.packages pkg
      JOIN public.projects p       ON p.id = pkg.project_id
      JOIN public.package_types pt ON pt.id = pkg.package_type_id
      ${where}
      ORDER BY p.name, pkg.name
      `,
      values
    );

    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/packages/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package id" });

    const result = await pool.query(
      `
      SELECT
        pkg.id,
        pkg.project_id,
        pkg.package_type_id,
        pkg.name,
        pkg.package_tag,
        pkg.serial_number,
        pkg.attributes,
        pkg.active,
        pkg.created_at,
        pkg.updated_at,
        p.name AS project_name,
        p.code AS project_code,
        pt.name AS package_type_name
      FROM public.packages pkg
      JOIN public.projects p       ON p.id = pkg.project_id
      JOIN public.package_types pt ON pt.id = pkg.package_type_id
      WHERE pkg.id = $1
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Package not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/packages
 * Body: { project_id, package_type_id, name, package_tag?, serial_number?, attributes? }
 */
router.post("/", async (req, res, next) => {
  try {
    const projectId = parseId(req.body.project_id);
    const packageTypeId = parseId(req.body.package_type_id);
    const name = String(req.body.name ?? "").trim();
    const packageTag = String(req.body.package_tag ?? "").trim() || null;
    const serialNumber = String(req.body.serial_number ?? "").trim() || null;
    const attributes =
      req.body.attributes && typeof req.body.attributes === "object"
        ? req.body.attributes
        : {};

    if (!projectId) {
      return res.status(400).json({ error: "project_id is required and must be a positive integer" });
    }
    if (!packageTypeId) {
      return res.status(400).json({ error: "package_type_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const project = await findProject(projectId);
    if (!project) {
      return res.status(400).json({ error: "Invalid project_id: project does not exist" });
    }
    if (project.active === false) {
      return res.status(400).json({ error: "Cannot add a package to an inactive project" });
    }

    const packageType = await findPackageType(packageTypeId);
    if (!packageType) {
      return res.status(400).json({ error: "Invalid package_type_id: package type does not exist" });
    }

    const duplicate = await findDuplicate(projectId, name, packageTag);
    if (duplicate) {
      return res.status(409).json({
        error: duplicateMessage(duplicate, name, packageTag),
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      INSERT INTO public.packages
        (project_id, package_type_id, name, package_tag, serial_number, attributes, active)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE)
      RETURNING
        id, project_id, package_type_id, name, package_tag, serial_number,
        attributes, active, created_at, updated_at
      `,
      [projectId, packageTypeId, name, packageTag, serialNumber, JSON.stringify(attributes)]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Package violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id or package_type_id: foreign key violation" });
    }
    next(error);
  }
});

/*
 * PUT /api/packages/:id
 * Body: { project_id, package_type_id, name, package_tag?, serial_number?, attributes?, active? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package id" });

    const projectId = parseId(req.body.project_id);
    const packageTypeId = parseId(req.body.package_type_id);
    const name = String(req.body.name ?? "").trim();
    const packageTag = String(req.body.package_tag ?? "").trim() || null;
    const serialNumber = String(req.body.serial_number ?? "").trim() || null;
    const attributes =
      req.body.attributes && typeof req.body.attributes === "object"
        ? req.body.attributes
        : {};
    const active = req.body.active !== false;

    if (!projectId) {
      return res.status(400).json({ error: "project_id is required and must be a positive integer" });
    }
    if (!packageTypeId) {
      return res.status(400).json({ error: "package_type_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const existing = await pool.query("SELECT id FROM public.packages WHERE id = $1", [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: "Package not found" });
    }

    const project = await findProject(projectId);
    if (!project) {
      return res.status(400).json({ error: "Invalid project_id: project does not exist" });
    }

    const packageType = await findPackageType(packageTypeId);
    if (!packageType) {
      return res.status(400).json({ error: "Invalid package_type_id: package type does not exist" });
    }

    const duplicate = await findDuplicate(projectId, name, packageTag, id);
    if (duplicate) {
      return res.status(409).json({
        error: duplicateMessage(duplicate, name, packageTag),
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      UPDATE public.packages
      SET project_id = $1,
          package_type_id = $2,
          name = $3,
          package_tag = $4,
          serial_number = $5,
          attributes = $6::jsonb,
          active = $7,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $8
      RETURNING
        id, project_id, package_type_id, name, package_tag, serial_number,
        attributes, active, created_at, updated_at
      `,
      [projectId, packageTypeId, name, packageTag, serialNumber, JSON.stringify(attributes), active, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Package violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid project_id or package_type_id: foreign key violation" });
    }
    next(error);
  }
});

/*
 * DELETE /api/packages/:id  (soft delete)
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package id" });

    const result = await pool.query(
      `
      UPDATE public.packages
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Package not found" });
    }

    res.json({ message: "Package deactivated", package: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function optionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

function optionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

async function packageExists(id) {
  const result = await pool.query("SELECT id FROM public.packages WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function deviceExists(id) {
  const result = await pool.query("SELECT id FROM public.devices WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function technicianExists(id) {
  if (id === null) return true;
  const result = await pool.query("SELECT id FROM public.technicians WHERE id = $1", [id]);
  return result.rowCount > 0;
}

/*
 * A firmware_version_log_id, if provided, must be a version_logs row
 * belonging to the SAME device_id (a unit's firmware can only point to
 * a confirmed version record for its own device model).
 */
async function versionLogMatchesDevice(versionLogId, deviceId) {
  if (versionLogId === null) return true;
  const result = await pool.query(
    "SELECT id FROM public.version_logs WHERE id = $1 AND device_id = $2",
    [versionLogId, deviceId]
  );
  return result.rowCount > 0;
}

/*
 * Check whether a tag_name already exists within the same package.
 * Optionally exclude a package_devices id (used when updating).
 */
async function findDuplicateTag(packageId, tagName, excludeId = null) {
  const result = await pool.query(
    `
    SELECT id, tag_name
    FROM public.package_devices
    WHERE package_id = $1
      AND ($3::int8 IS NULL OR id <> $3::int8)
      AND LOWER(tag_name) = LOWER($2::text)
    LIMIT 1
    `,
    [packageId, tagName, excludeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

const SELECT_FIELDS = `
  pd.id, pd.package_id, pkg.name AS package_name, pkg.package_tag,
  proj.id AS project_id, proj.name AS project_name,
  pd.device_id, d.name AS device_name, d.hardware_version, d.order_number,
  m.id AS manufacturer_id, m.name AS manufacturer_name,
  d.device_type_id, dt.name AS device_type_name,
  pd.tag_name, pd.serial_number, pd.is_spare_part,
  pd.install_date, pd.installed_by_id, ib.name AS installed_by_name,
  pd.firmware_install_date, pd.firmware_installed_by_id, fib.name AS firmware_installed_by_name,
  pd.firmware_version_log_id, vl.version AS firmware_version, vl.is_approved_latest AS firmware_is_latest,
  pd.active, pd.notes, pd.created_at, pd.updated_at
`;

const SELECT_JOINS = `
  FROM public.package_devices pd
  JOIN public.packages pkg ON pkg.id = pd.package_id
  JOIN public.projects proj ON proj.id = pkg.project_id
  JOIN public.devices d ON d.id = pd.device_id
  JOIN public.manufacturers m ON m.id = d.manufacturer_id
  JOIN public.device_types dt ON dt.id = d.device_type_id
  LEFT JOIN public.technicians ib ON ib.id = pd.installed_by_id
  LEFT JOIN public.technicians fib ON fib.id = pd.firmware_installed_by_id
  LEFT JOIN public.version_logs vl ON vl.id = pd.firmware_version_log_id
`;

/*
 * GET /api/packagedevices
 * Optional filters: ?project_id=1 & ?package_id=2 & ?device_type_id=3 & ?active=true|false
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.project_id !== undefined) {
      const projectId = parseId(req.query.project_id);
      if (!projectId) return res.status(400).json({ error: "Invalid project_id filter" });
      values.push(projectId);
      conditions.push(`proj.id = $${values.length}`);
    }
    if (req.query.package_id !== undefined) {
      const packageId = parseId(req.query.package_id);
      if (!packageId) return res.status(400).json({ error: "Invalid package_id filter" });
      values.push(packageId);
      conditions.push(`pd.package_id = $${values.length}`);
    }
    if (req.query.device_type_id !== undefined) {
      const deviceTypeId = parseId(req.query.device_type_id);
      if (!deviceTypeId) return res.status(400).json({ error: "Invalid device_type_id filter" });
      values.push(deviceTypeId);
      conditions.push(`d.device_type_id = $${values.length}`);
    }
    if (req.query.active !== undefined) {
      if (req.query.active !== "true" && req.query.active !== "false") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      values.push(req.query.active === "true");
      conditions.push(`pd.active = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT ${SELECT_FIELDS} ${SELECT_JOINS} ${where}
       ORDER BY proj.name, pkg.name, pd.tag_name`,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/packagedevices/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package device id" });
    const result = await pool.query(
      `SELECT ${SELECT_FIELDS} ${SELECT_JOINS} WHERE pd.id = $1`,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Package device not found" });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/packagedevices
 * Body: { package_id, device_id, tag_name, serial_number?, is_spare_part?,
 *         install_date?, installed_by_id?, firmware_install_date?,
 *         firmware_installed_by_id?, firmware_version_log_id?, notes? }
 */
router.post("/", async (req, res, next) => {
  try {
    const packageId = parseId(req.body.package_id);
    const deviceId = parseId(req.body.device_id);
    const tagName = String(req.body.tag_name ?? "").trim();
    const serialNumber = String(req.body.serial_number ?? "").trim() || "XXXXXX";
    const isSparePart = req.body.is_spare_part === true || req.body.is_spare_part === "true";
    const installDate = optionalDate(req.body.install_date);
    const installedById = optionalId(req.body.installed_by_id);
    const firmwareInstallDate = optionalDate(req.body.firmware_install_date);
    const firmwareInstalledById = optionalId(req.body.firmware_installed_by_id);
    const firmwareVersionLogId = optionalId(req.body.firmware_version_log_id);
    const notes = String(req.body.notes ?? "").trim() || null;
    const active = req.body.active !== false;

    if (!packageId) return res.status(400).json({ error: "package_id is required" });
    if (!deviceId) return res.status(400).json({ error: "device_id is required" });
    if (!tagName) return res.status(400).json({ error: "tag_name is required" });
    if (Number.isNaN(installedById)) return res.status(400).json({ error: "Invalid installed_by_id" });
    if (Number.isNaN(firmwareInstalledById)) return res.status(400).json({ error: "Invalid firmware_installed_by_id" });
    if (Number.isNaN(firmwareVersionLogId)) return res.status(400).json({ error: "Invalid firmware_version_log_id" });

    if (!(await packageExists(packageId))) {
      return res.status(400).json({ error: "Invalid package_id: package does not exist" });
    }
    if (!(await deviceExists(deviceId))) {
      return res.status(400).json({ error: "Invalid device_id: device does not exist" });
    }
    if (!(await technicianExists(installedById))) {
      return res.status(400).json({ error: "Invalid installed_by_id: technician does not exist" });
    }
    if (!(await technicianExists(firmwareInstalledById))) {
      return res.status(400).json({ error: "Invalid firmware_installed_by_id: technician does not exist" });
    }
    if (!(await versionLogMatchesDevice(firmwareVersionLogId, deviceId))) {
      return res.status(400).json({
        error: "Invalid firmware_version_log_id: it must belong to the selected device"
      });
    }

    const duplicate = await findDuplicateTag(packageId, tagName);
    if (duplicate) {
      return res.status(409).json({
        error: `Tag "${tagName}" already exists on this package.`,
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      INSERT INTO public.package_devices
        (package_id, device_id, tag_name, serial_number, is_spare_part,
         install_date, installed_by_id, firmware_install_date, firmware_installed_by_id,
         firmware_version_log_id, active, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
      `,
      [
        packageId, deviceId, tagName, serialNumber, isSparePart,
        installDate, installedById, firmwareInstallDate, firmwareInstalledById,
        firmwareVersionLogId, active, notes
      ]
    );
    const full = await pool.query(
      `SELECT ${SELECT_FIELDS} ${SELECT_JOINS} WHERE pd.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json(full.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Tag already exists on this package" });
    }
    if (error.code === "23503") {
      return res.status(400).json({
        error: "Invalid package_id, device_id, installed_by_id, firmware_installed_by_id or firmware_version_log_id"
      });
    }
    next(error);
  }
});

/*
 * PUT /api/packagedevices/:id
 * Body: same as POST
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package device id" });
    const packageId = parseId(req.body.package_id);
    const deviceId = parseId(req.body.device_id);
    const tagName = String(req.body.tag_name ?? "").trim();
    const serialNumber = String(req.body.serial_number ?? "").trim() || "XXXXXX";
    const isSparePart = req.body.is_spare_part === true || req.body.is_spare_part === "true";
    const installDate = optionalDate(req.body.install_date);
    const installedById = optionalId(req.body.installed_by_id);
    const firmwareInstallDate = optionalDate(req.body.firmware_install_date);
    const firmwareInstalledById = optionalId(req.body.firmware_installed_by_id);
    const firmwareVersionLogId = optionalId(req.body.firmware_version_log_id);
    const notes = String(req.body.notes ?? "").trim() || null;
    const active = req.body.active !== false;

    if (!packageId) return res.status(400).json({ error: "package_id is required" });
    if (!deviceId) return res.status(400).json({ error: "device_id is required" });
    if (!tagName) return res.status(400).json({ error: "tag_name is required" });
    if (Number.isNaN(installedById)) return res.status(400).json({ error: "Invalid installed_by_id" });
    if (Number.isNaN(firmwareInstalledById)) return res.status(400).json({ error: "Invalid firmware_installed_by_id" });
    if (Number.isNaN(firmwareVersionLogId)) return res.status(400).json({ error: "Invalid firmware_version_log_id" });

    const existing = await pool.query("SELECT id FROM public.package_devices WHERE id = $1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: "Package device not found" });

    if (!(await packageExists(packageId))) {
      return res.status(400).json({ error: "Invalid package_id: package does not exist" });
    }
    if (!(await deviceExists(deviceId))) {
      return res.status(400).json({ error: "Invalid device_id: device does not exist" });
    }
    if (!(await technicianExists(installedById))) {
      return res.status(400).json({ error: "Invalid installed_by_id: technician does not exist" });
    }
    if (!(await technicianExists(firmwareInstalledById))) {
      return res.status(400).json({ error: "Invalid firmware_installed_by_id: technician does not exist" });
    }
    if (!(await versionLogMatchesDevice(firmwareVersionLogId, deviceId))) {
      return res.status(400).json({
        error: "Invalid firmware_version_log_id: it must belong to the selected device"
      });
    }

    const duplicate = await findDuplicateTag(packageId, tagName, id);
    if (duplicate) {
      return res.status(409).json({
        error: `Tag "${tagName}" already exists on this package.`,
        existing_id: duplicate.id
      });
    }

    await pool.query(
      `
      UPDATE public.package_devices
      SET package_id = $1, device_id = $2, tag_name = $3, serial_number = $4,
          is_spare_part = $5, install_date = $6, installed_by_id = $7,
          firmware_install_date = $8, firmware_installed_by_id = $9,
          firmware_version_log_id = $10, active = $11, notes = $12,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $13
      `,
      [
        packageId, deviceId, tagName, serialNumber, isSparePart,
        installDate, installedById, firmwareInstallDate, firmwareInstalledById,
        firmwareVersionLogId, active, notes, id
      ]
    );
    const full = await pool.query(
      `SELECT ${SELECT_FIELDS} ${SELECT_JOINS} WHERE pd.id = $1`,
      [id]
    );
    res.json(full.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Tag already exists on this package" });
    }
    if (error.code === "23503") {
      return res.status(400).json({
        error: "Invalid package_id, device_id, installed_by_id, firmware_installed_by_id or firmware_version_log_id"
      });
    }
    next(error);
  }
});

/*
 * DELETE /api/packagedevices/:id (soft delete)
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid package device id" });
    const result = await pool.query(
      `
      UPDATE public.package_devices
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, tag_name, active
      `,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Package device not found" });
    res.json({ success: true, packageDevice: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

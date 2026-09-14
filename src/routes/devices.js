const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function findManufacturer(manufacturerId) {
  const result = await pool.query(
    "SELECT id, active FROM public.manufacturers WHERE id = $1",
    [manufacturerId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function findDeviceType(deviceTypeId) {
  const result = await pool.query(
    "SELECT id, active FROM public.device_types WHERE id = $1",
    [deviceTypeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/*
 * Check whether a device with the same name + hardware_version + order_number
 * already exists under the same manufacturer. Optionally exclude a device id
 * (used when updating).
 */
async function findDuplicate(manufacturerId, name, hardwareVersion, orderNumber, excludeId = null) {
  const result = await pool.query(
    `
    SELECT id, name, hardware_version, order_number
    FROM public.devices
    WHERE manufacturer_id = $1
      AND ($5::int8 IS NULL OR id <> $5::int8)
      AND LOWER(name) = LOWER($2::text)
      AND COALESCE(hardware_version, '') = COALESCE($3::text, '')
      AND COALESCE(order_number, '') = COALESCE($4::text, '')
    LIMIT 1
    `,
    [manufacturerId, name, hardwareVersion, orderNumber, excludeId]
  );
  return result.rowCount ? result.rows[0] : null;
}

/*
 * GET /api/devices
 * Optional filters: ?manufacturer_id=1 & ?device_type_id=2 & ?active=true|false & ?search=text
 * (search matches device name, order_number or manufacturer name)
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];
    if (req.query.manufacturer_id !== undefined) {
      const manufacturerId = parseId(req.query.manufacturer_id);
      if (!manufacturerId) {
        return res.status(400).json({ error: "Invalid manufacturer_id filter" });
      }
      values.push(manufacturerId);
      conditions.push(`d.manufacturer_id = $${values.length}`);
    }
    if (req.query.device_type_id !== undefined) {
      const deviceTypeId = parseId(req.query.device_type_id);
      if (!deviceTypeId) {
        return res.status(400).json({ error: "Invalid device_type_id filter" });
      }
      values.push(deviceTypeId);
      conditions.push(`d.device_type_id = $${values.length}`);
    }
    if (req.query.active !== undefined) {
      if (req.query.active !== "true" && req.query.active !== "false") {
        return res.status(400).json({ error: "active must be true or false" });
      }
      values.push(req.query.active === "true");
      conditions.push(`d.active = $${values.length}`);
    }
    if (req.query.search) {
      const search = String(req.query.search).trim();
      if (search) {
        values.push(`%${search}%`);
        conditions.push(
          `(d.name ILIKE $${values.length} OR d.order_number ILIKE $${values.length} OR m.name ILIKE $${values.length})`
        );
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT
        d.id, d.manufacturer_id, m.name AS manufacturer_name,
        d.device_type_id, dt.name AS device_type_name,
        d.name, d.order_number, d.hardware_version,
        d.active, d.created_at, d.updated_at
      FROM public.devices d
      JOIN public.manufacturers m ON m.id = d.manufacturer_id
      JOIN public.device_types dt ON dt.id = d.device_type_id
      ${where}
      ORDER BY m.name, d.name, d.hardware_version
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/devices/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid device id" });
    const result = await pool.query(
      `
      SELECT
        d.id, d.manufacturer_id, m.name AS manufacturer_name,
        d.device_type_id, dt.name AS device_type_name,
        d.name, d.order_number, d.hardware_version,
        d.active, d.created_at, d.updated_at
      FROM public.devices d
      JOIN public.manufacturers m ON m.id = d.manufacturer_id
      JOIN public.device_types dt ON dt.id = d.device_type_id
      WHERE d.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/devices/:id/versionlogs
 * Convenience route: all confirmed firmware/EOL/EOS records for one
 * device, newest first — mirrors GET /api/versionlogs?device_id=...
 */
router.get("/:id/versionlogs", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid device id" });
    const result = await pool.query(
      `
      SELECT
        vl.id, vl.device_id, vl.check_type_id, ct.name AS check_type_name,
        vl.version, vl.release_date, vl.eos_date, vl.eol_date,
        vl.confirmed_by_id, t.name AS confirmed_by_name, vl.confirm_date,
        vl.is_approved_latest, vl.notes, vl.created_at
      FROM public.version_logs vl
      JOIN public.check_types ct ON ct.id = vl.check_type_id
      LEFT JOIN public.technicians t ON t.id = vl.confirmed_by_id
      WHERE vl.device_id = $1
      ORDER BY vl.check_type_id, vl.is_approved_latest DESC, vl.release_date DESC NULLS LAST
      `,
      [id]
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/devices
 * Body: { manufacturer_id, device_type_id, name, order_number?, hardware_version? }
 */
router.post("/", async (req, res, next) => {
  try {
    const manufacturerId = parseId(req.body.manufacturer_id);
    const deviceTypeId = parseId(req.body.device_type_id);
    const name = String(req.body.name ?? "").trim();
    const orderNumber = String(req.body.order_number ?? "").trim() || null;
    const hardwareVersion = String(req.body.hardware_version ?? "").trim() || "X";

    if (!manufacturerId) {
      return res.status(400).json({ error: "manufacturer_id is required and must be a positive integer" });
    }
    if (!deviceTypeId) {
      return res.status(400).json({ error: "device_type_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const manufacturer = await findManufacturer(manufacturerId);
    if (!manufacturer) {
      return res.status(400).json({ error: "Invalid manufacturer_id: manufacturer does not exist" });
    }
    const deviceType = await findDeviceType(deviceTypeId);
    if (!deviceType) {
      return res.status(400).json({ error: "Invalid device_type_id: device type does not exist" });
    }

    const duplicate = await findDuplicate(manufacturerId, name, hardwareVersion, orderNumber);
    if (duplicate) {
      return res.status(409).json({
        error: `A device named "${name}" (hardware version "${hardwareVersion}") already exists for this manufacturer.`,
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      INSERT INTO public.devices (manufacturer_id, device_type_id, name, order_number, hardware_version, active)
      VALUES ($1, $2, $3, $4, $5, TRUE)
      RETURNING id, manufacturer_id, device_type_id, name, order_number, hardware_version, active, created_at, updated_at
      `,
      [manufacturerId, deviceTypeId, name, orderNumber, hardwareVersion]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Device violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid manufacturer_id or device_type_id: foreign key violation" });
    }
    next(error);
  }
});

/*
 * PUT /api/devices/:id
 * Body: { manufacturer_id, device_type_id, name, order_number?, hardware_version?, active }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid device id" });
    const manufacturerId = parseId(req.body.manufacturer_id);
    const deviceTypeId = parseId(req.body.device_type_id);
    const name = String(req.body.name ?? "").trim();
    const orderNumber = String(req.body.order_number ?? "").trim() || null;
    const hardwareVersion = String(req.body.hardware_version ?? "").trim() || "X";
    const active = req.body.active !== false;

    if (!manufacturerId) {
      return res.status(400).json({ error: "manufacturer_id is required and must be a positive integer" });
    }
    if (!deviceTypeId) {
      return res.status(400).json({ error: "device_type_id is required and must be a positive integer" });
    }
    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    const existing = await pool.query("SELECT id FROM public.devices WHERE id = $1", [id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const manufacturer = await findManufacturer(manufacturerId);
    if (!manufacturer) {
      return res.status(400).json({ error: "Invalid manufacturer_id: manufacturer does not exist" });
    }
    const deviceType = await findDeviceType(deviceTypeId);
    if (!deviceType) {
      return res.status(400).json({ error: "Invalid device_type_id: device type does not exist" });
    }

    const duplicate = await findDuplicate(manufacturerId, name, hardwareVersion, orderNumber, id);
    if (duplicate) {
      return res.status(409).json({
        error: `A device named "${name}" (hardware version "${hardwareVersion}") already exists for this manufacturer.`,
        existing_id: duplicate.id
      });
    }

    const result = await pool.query(
      `
      UPDATE public.devices
      SET manufacturer_id = $1, device_type_id = $2, name = $3, order_number = $4,
          hardware_version = $5, active = $6, updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING id, manufacturer_id, device_type_id, name, order_number, hardware_version, active, created_at, updated_at
      `,
      [manufacturerId, deviceTypeId, name, orderNumber, hardwareVersion, active, id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Device violates a uniqueness constraint" });
    }
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid manufacturer_id or device_type_id: foreign key violation" });
    }
    next(error);
  }
});

/*
 * DELETE /api/devices/:id (soft delete)
 * A hard delete would fail because version_logs, check_logs and
 * package_devices reference devices with ON DELETE RESTRICT/CASCADE.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid device id" });
    const result = await pool.query(
      `
      UPDATE public.devices
      SET active = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING id, name, active
      `,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Device not found" });
    }
    res.json({ success: true, device: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

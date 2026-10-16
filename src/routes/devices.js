const express = require("express");
const pool = require("../db");

const router = express.Router();

/* Columns returned by every devices read/write — keeps GET, POST and PUT
 * responses identical and in line with the devices table schema:
 * id, manufacturer_id, device_type_id, name, hardware_version,
 * order_number, website, notes, active, created_at, updated_at */
const DEVICE_SELECT = `
  d.id, d.manufacturer_id, m.name AS manufacturer_name,
  d.device_type_id, dt.name AS device_type_name,
  d.name, d.hardware_version, d.order_number,
  d.website, d.notes,
  d.active, d.created_at, d.updated_at
`;

const DEVICE_FROM = `
  FROM public.devices d
  JOIN public.manufacturers m ON m.id = d.manufacturer_id
  JOIN public.device_types dt ON dt.id = d.device_type_id
`;

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/* Trimmed string or null (empty -> null). */
function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

/* Reads and validates the device body used by both POST and PUT.
 * Returns { error } or { values }. */
function parseDeviceBody(body, { isUpdate = false } = {}) {
  const values = {
    manufacturerId: parseId(body.manufacturer_id),
    deviceTypeId: parseId(body.device_type_id),
    name: String(body.name ?? "").trim(),
    hardwareVersion: optionalText(body.hardware_version) || "X",
    orderNumber: optionalText(body.order_number),
    website: optionalText(body.website),
    notes: optionalText(body.notes),
    active: isUpdate ? body.active !== false : true
  };

  if (!values.manufacturerId) {
    return { error: "manufacturer_id is required and must be a positive integer" };
  }
  if (!values.deviceTypeId) {
    return { error: "device_type_id is required and must be a positive integer" };
  }
  if (!values.name) {
    return { error: "name is required" };
  }
  if (values.website && !/^https?:\/\//i.test(values.website)) {
    return { error: "website must start with http:// or https://" };
  }
  return { values };
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
 * Same manufacturer + name (case-insensitive) + hardware_version + order_number
 * counts as a duplicate. Optionally exclude a device id (used when updating).
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

/* Shared validation of FK targets + duplicate check. Returns an
 * { status, body } error object, or null when everything is fine. */
async function validateReferences(v, excludeId = null) {
  if (!(await findManufacturer(v.manufacturerId))) {
    return { status: 400, body: { error: "Invalid manufacturer_id: manufacturer does not exist" } };
  }
  if (!(await findDeviceType(v.deviceTypeId))) {
    return { status: 400, body: { error: "Invalid device_type_id: device type does not exist" } };
  }
  const duplicate = await findDuplicate(
    v.manufacturerId, v.name, v.hardwareVersion, v.orderNumber, excludeId
  );
  if (duplicate) {
    return {
      status: 409,
      body: {
        error: `A device named "${v.name}" (hardware version "${v.hardwareVersion}", order number "${
          v.orderNumber ?? "–"
        }") already exists for this manufacturer (id ${duplicate.id}).`,
        existing_id: duplicate.id
      }
    };
  }
  return null;
}

/* Maps Postgres errors to readable API errors. Returns true if handled. */
function handlePgError(error, res) {
  if (error.code === "23505") {
    const isPkey = String(error.constraint || "").endsWith("_pkey");
    res.status(409).json({
      error: isPkey
        ? "Device id already exists - the devices id sequence is out of sync. Run: SELECT setval(pg_get_serial_sequence('public.devices','id'), (SELECT MAX(id) FROM public.devices));"
        : `Device violates uniqueness constraint ${error.constraint ?? ""}`.trim(),
      detail: error.detail
    });
    return true;
  }
  if (error.code === "23503") {
    res.status(400).json({
      error: "Invalid manufacturer_id or device_type_id: foreign key violation",
      detail: error.detail
    });
    return true;
  }
  if (error.code === "23502") {
    res.status(400).json({ error: `Missing required column: ${error.column}`, detail: error.detail });
    return true;
  }
  return false;
}

/*
 * GET /api/devices
 * Optional filters: ?manufacturer_id= & ?device_type_id= & ?active=true|false & ?search=text
 * (search matches device name, order_number, notes or manufacturer name)
 */
router.get("/", async (req, res, next) => {
  try {
    const conditions = [];
    const values = [];

    if (req.query.manufacturer_id !== undefined) {
      const manufacturerId = parseId(req.query.manufacturer_id);
      if (!manufacturerId) return res.status(400).json({ error: "Invalid manufacturer_id filter" });
      values.push(manufacturerId);
      conditions.push(`d.manufacturer_id = $${values.length}`);
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
      conditions.push(`d.active = $${values.length}`);
    }

    if (req.query.search) {
      const search = String(req.query.search).trim();
      if (search) {
        values.push(`%${search}%`);
        const p = `$${values.length}`;
        conditions.push(
          `(d.name ILIKE ${p} OR d.order_number ILIKE ${p} OR d.notes ILIKE ${p} OR m.name ILIKE ${p})`
        );
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT ${DEVICE_SELECT} ${DEVICE_FROM} ${where}
       ORDER BY m.name, d.name, d.hardware_version`,
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

    const result = await pool.query(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.id = $1`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ error: "Device not found" });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/devices/:id/versionlogs
 * All confirmed firmware/EOL/EOS records for one device.
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
 * Body: { manufacturer_id, device_type_id, name, hardware_version?, order_number?, website?, notes? }
 */
router.post("/", async (req, res, next) => {
  try {
    const { error, values: v } = parseDeviceBody(req.body);
    if (error) return res.status(400).json({ error });

    const refError = await validateReferences(v);
    if (refError) return res.status(refError.status).json(refError.body);

    const inserted = await pool.query(
      `
      INSERT INTO public.devices
        (manufacturer_id, device_type_id, name, hardware_version, order_number, website, notes, active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      RETURNING id
      `,
      [v.manufacturerId, v.deviceTypeId, v.name, v.hardwareVersion, v.orderNumber, v.website, v.notes]
    );

    const result = await pool.query(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.id = $1`, [
      inserted.rows[0].id
    ]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (handlePgError(error, res)) return;
    next(error);
  }
});

/*
 * PUT /api/devices/:id
 * Body: { manufacturer_id, device_type_id, name, hardware_version?, order_number?, website?, notes?, active? }
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid device id" });

    const { error, values: v } = parseDeviceBody(req.body, { isUpdate: true });
    if (error) return res.status(400).json({ error });

    const existing = await pool.query("SELECT id FROM public.devices WHERE id = $1", [id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: "Device not found" });

    const refError = await validateReferences(v, id);
    if (refError) return res.status(refError.status).json(refError.body);

    await pool.query(
      `
      UPDATE public.devices
      SET manufacturer_id = $1, device_type_id = $2, name = $3, hardware_version = $4,
          order_number = $5, website = $6, notes = $7, active = $8,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      `,
      [v.manufacturerId, v.deviceTypeId, v.name, v.hardwareVersion, v.orderNumber, v.website, v.notes, v.active, id]
    );

    const result = await pool.query(`SELECT ${DEVICE_SELECT} ${DEVICE_FROM} WHERE d.id = $1`, [id]);
    res.json(result.rows[0]);
  } catch (error) {
    if (handlePgError(error, res)) return;
    next(error);
  }
});

/*
 * DELETE /api/devices/:id (soft delete)
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
    if (result.rowCount === 0) return res.status(404).json({ error: "Device not found" });
    res.json({ success: true, device: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

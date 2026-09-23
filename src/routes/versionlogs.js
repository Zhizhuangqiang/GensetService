const express = require("express");
const pool = require("../db");
const router = express.Router();

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function deviceExists(id) {
  const result = await pool.query("SELECT id FROM public.devices WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function checkTypeExists(id) {
  const result = await pool.query("SELECT id FROM public.check_types WHERE id = $1", [id]);
  return result.rowCount > 0;
}

async function technicianExists(id) {
  if (id === null) return true;
  const result = await pool.query("SELECT id FROM public.technicians WHERE id = $1", [id]);
  return result.rowCount > 0;
}

function optionalTechId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

function optionalDate(value) {
  if (value === undefined || value === null || value === "") return null;
  return value;
}

/*
 * GET /api/versionlogs
 * Optional filters: ?manufacturer_id=1 & ?device_id=2 & ?check_type_id=3
 *                   & ?is_approved_latest=true|false
 * (manufacturer_id filters via the device's manufacturer)
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
    if (req.query.device_id !== undefined) {
      const deviceId = parseId(req.query.device_id);
      if (!deviceId) return res.status(400).json({ error: "Invalid device_id filter" });
      values.push(deviceId);
      conditions.push(`vl.device_id = $${values.length}`);
    }
    if (req.query.check_type_id !== undefined) {
      const checkTypeId = parseId(req.query.check_type_id);
      if (!checkTypeId) return res.status(400).json({ error: "Invalid check_type_id filter" });
      values.push(checkTypeId);
      conditions.push(`vl.check_type_id = $${values.length}`);
    }
    if (req.query.is_approved_latest !== undefined) {
      if (req.query.is_approved_latest !== "true" && req.query.is_approved_latest !== "false") {
        return res.status(400).json({ error: "is_approved_latest must be true or false" });
      }
      values.push(req.query.is_approved_latest === "true");
      conditions.push(`vl.is_approved_latest = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT
        vl.id, vl.device_id, d.name AS device_name,
        d.manufacturer_id, m.name AS manufacturer_name,
        vl.check_type_id, ct.name AS check_type_name,
        vl.version, vl.release_date, vl.eos_date, vl.eol_date,
        vl.confirmed_by_id, t.name AS confirmed_by_name, vl.confirm_date,
        vl.is_approved_latest, vl.notes, vl.created_at
      FROM public.version_logs vl
      JOIN public.devices d ON d.id = vl.device_id
      JOIN public.manufacturers m ON m.id = d.manufacturer_id
      JOIN public.check_types ct ON ct.id = vl.check_type_id
      LEFT JOIN public.technicians t ON t.id = vl.confirmed_by_id
      ${where}
      ORDER BY m.name, d.name, vl.check_type_id, vl.is_approved_latest DESC, vl.release_date DESC NULLS LAST
      `,
      values
    );
    res.json({ count: result.rowCount, items: result.rows });
  } catch (error) {
    next(error);
  }
});

/*
 * GET /api/versionlogs/:id
 */
router.get("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid version log id" });
    const result = await pool.query(
      `
      SELECT
        vl.id, vl.device_id, d.name AS device_name,
        d.manufacturer_id, m.name AS manufacturer_name,
        vl.check_type_id, ct.name AS check_type_name,
        vl.version, vl.release_date, vl.eos_date, vl.eol_date,
        vl.confirmed_by_id, t.name AS confirmed_by_name, vl.confirm_date,
        vl.is_approved_latest, vl.notes, vl.created_at
      FROM public.version_logs vl
      JOIN public.devices d ON d.id = vl.device_id
      JOIN public.manufacturers m ON m.id = d.manufacturer_id
      JOIN public.check_types ct ON ct.id = vl.check_type_id
      LEFT JOIN public.technicians t ON t.id = vl.confirmed_by_id
      WHERE vl.id = $1
      `,
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Version log not found" });
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

/*
 * POST /api/versionlogs
 * Body: { device_id, check_type_id, version?, release_date?, eos_date?,
 *         eol_date?, confirmed_by_id?, confirm_date?, is_approved_latest?, notes? }
 *
 * eos_date / eol_date fall back to the table default ('2099-12-31')
 * when omitted, meaning "not yet reached / unknown".
 */
router.post("/", async (req, res, next) => {
  try {
    const deviceId = parseId(req.body.device_id);
    const checkTypeId = parseId(req.body.check_type_id);
    const version = String(req.body.version ?? "").trim() || null;
    const releaseDate = optionalDate(req.body.release_date);
    const eosDate = optionalDate(req.body.eos_date);
    const eolDate = optionalDate(req.body.eol_date);
    const confirmedById = optionalTechId(req.body.confirmed_by_id);
    const confirmDate = optionalDate(req.body.confirm_date);
    const isApprovedLatest = req.body.is_approved_latest === true || req.body.is_approved_latest === "true";
    const notes = String(req.body.notes ?? "").trim() || null;

    if (!deviceId) return res.status(400).json({ error: "device_id is required" });
    if (!checkTypeId) return res.status(400).json({ error: "check_type_id is required" });
    if (Number.isNaN(confirmedById)) return res.status(400).json({ error: "Invalid confirmed_by_id" });

    if (!(await deviceExists(deviceId))) {
      return res.status(400).json({ error: "Invalid device_id: device does not exist" });
    }
    if (!(await checkTypeExists(checkTypeId))) {
      return res.status(400).json({ error: "Invalid check_type_id: check type does not exist" });
    }
    if (!(await technicianExists(confirmedById))) {
      return res.status(400).json({ error: "Invalid confirmed_by_id: technician does not exist" });
    }

    const columns = ["device_id", "check_type_id", "version", "release_date", "confirmed_by_id", "confirm_date", "is_approved_latest", "notes"];
    const values = [deviceId, checkTypeId, version, releaseDate, confirmedById, confirmDate, isApprovedLatest, notes];
    if (eosDate !== null) { columns.push("eos_date"); values.push(eosDate); }
    if (eolDate !== null) { columns.push("eol_date"); values.push(eolDate); }
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");

    const result = await pool.query(
      `
      INSERT INTO public.version_logs (${columns.join(", ")})
      VALUES (${placeholders})
      RETURNING *
      `,
      values
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid device_id, check_type_id or confirmed_by_id" });
    }
    next(error);
  }
});

/*
 * PUT /api/versionlogs/:id
 * Body: same as POST
 *
 * eos_date / eol_date: when omitted from the request body, the column
 * is reset to its schema DEFAULT ('2099-12-31', meaning "not yet
 * reached / unknown") using SQL's DEFAULT keyword in the SET clause,
 * rather than hardcoding that literal here. This keeps the database
 * the single source of truth for the default — if it's ever changed
 * at the schema level, both POST and PUT automatically follow, with
 * nothing to update in this file.
 */
router.put("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid version log id" });

    const deviceId = parseId(req.body.device_id);
    const checkTypeId = parseId(req.body.check_type_id);
    const version = String(req.body.version ?? "").trim() || null;
    const releaseDate = optionalDate(req.body.release_date);
    const eosDate = optionalDate(req.body.eos_date);
    const eolDate = optionalDate(req.body.eol_date);
    const confirmedById = optionalTechId(req.body.confirmed_by_id);
    const confirmDate = optionalDate(req.body.confirm_date);
    const isApprovedLatest = req.body.is_approved_latest === true || req.body.is_approved_latest === "true";
    const notes = String(req.body.notes ?? "").trim() || null;

    if (!deviceId) return res.status(400).json({ error: "device_id is required" });
    if (!checkTypeId) return res.status(400).json({ error: "check_type_id is required" });
    if (Number.isNaN(confirmedById)) return res.status(400).json({ error: "Invalid confirmed_by_id" });

    if (!(await deviceExists(deviceId))) {
      return res.status(400).json({ error: "Invalid device_id: device does not exist" });
    }
    if (!(await checkTypeExists(checkTypeId))) {
      return res.status(400).json({ error: "Invalid check_type_id: check type does not exist" });
    }
    if (!(await technicianExists(confirmedById))) {
      return res.status(400).json({ error: "Invalid confirmed_by_id: technician does not exist" });
    }

    const fixedColumns = [
      "device_id", "check_type_id", "version", "release_date",
      "confirmed_by_id", "confirm_date", "is_approved_latest", "notes"
    ];
    const values = [deviceId, checkTypeId, version, releaseDate, confirmedById, confirmDate, isApprovedLatest, notes];
    const setParts = fixedColumns.map((col, i) => `${col} = $${i + 1}`);

    if (eosDate !== null) {
      values.push(eosDate);
      setParts.push(`eos_date = $${values.length}`);
    } else {
      setParts.push("eos_date = DEFAULT");
    }

    if (eolDate !== null) {
      values.push(eolDate);
      setParts.push(`eol_date = $${values.length}`);
    } else {
      setParts.push("eol_date = DEFAULT");
    }

    values.push(id);
    const idPlaceholder = values.length;

    const result = await pool.query(
      `
      UPDATE public.version_logs
      SET ${setParts.join(", ")}
      WHERE id = $${idPlaceholder}
      RETURNING *
      `,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Version log not found" });
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23503") {
      return res.status(400).json({ error: "Invalid device_id, check_type_id or confirmed_by_id" });
    }
    next(error);
  }
});

/*
 * DELETE /api/versionlogs/:id
 * Hard delete — version_logs is a correction-friendly confirmed-record
 * table (similar to service_records), not soft-deleted master data.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid version log id" });
    const result = await pool.query(
      "DELETE FROM public.version_logs WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: "Version log not found" });
    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(409).json({
        error: "This version log is referenced by package_devices records and cannot be deleted"
      });
    }
    next(error);
  }
});

module.exports = router;

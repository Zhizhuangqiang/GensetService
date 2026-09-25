const express = require("express");
const pool = require("../db");

/* ---------------------------------------------------------------------
 * Generic CRUD builder for small "lookup" tables (id + name, optionally
 * + active / created_at / updated_at / one extra column).
 *
 * This single file replaces six previously separate, near-identical
 * route files:
 *   pvdatatypes.js, devicetypes.js, checktypes.js, versionsources.js,
 *   serviceitems.js, packagetypes.js
 *
 * Every endpoint path, response shape, status code, and error message
 * below is preserved EXACTLY as it was in the original six files —
 * this is purely an internal reorganization. app.js mounts each
 * returned router at the same "/api/..." path as before.
 * --------------------------------------------------------------------- */
function createLookupRouter(config) {
  const {
    table,                 // e.g. "device_types"
    idLabel,                // e.g. "device type" (used in "Invalid <idLabel> id")
    notFoundLabel,          // e.g. "Device type not found"
    selectColumns,          // exact column list for GET / GET:id / PUT RETURNING
    orderBy,                // e.g. "name" or "id"
    hasActive = true,       // check_types has no "active" column
    hasUpdatedAt = true,    // device_types / check_types / version_sources have no updated_at
    extraColumns = [],      // e.g. ["description"] for service_items
    hasPost = true,         // pv_data_types is read-only
    hasPut = true,          // pv_data_types and check_types have no PUT
    duplicateMessage,       // 23505 error text
    duplicateField,         // optional "field" key on the 409 body
    deleteMode = "soft",    // "soft" | "hard" | "none"
    deleteReturning,        // RETURNING column list used by DELETE
    deleteKey,              // key name wrapping the deleted row, e.g. "deviceType"
    hardDeleteFkMessage     // 23503 message for hard-delete tables
  } = config;

  const router = express.Router();

  function parseId(value) {
    const id = Number.parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  function handleDuplicate(error, res) {
    if (error && error.code === "23505") {
      const body = { error: duplicateMessage };
      if (duplicateField) body.field = duplicateField;
      res.status(409).json(body);
      return true;
    }
    return false;
  }

  /*
   * GET /
   * Optional: ?active=true | ?active=false (only for tables with an
   * "active" column — check_types ignores this, matching the original).
   */
  router.get("/", async (req, res, next) => {
    try {
      const values = [];
      let where = "";
      if (hasActive && (req.query.active === "true" || req.query.active === "false")) {
        values.push(req.query.active === "true");
        where = "WHERE active = $1";
      }
      const result = await pool.query(
        `SELECT ${selectColumns} FROM public.${table} ${where} ORDER BY ${orderBy}`,
        values
      );
      res.json({ count: result.rowCount, items: result.rows });
    } catch (error) {
      next(error);
    }
  });

  /*
   * GET /:id
   */
  router.get("/:id", async (req, res, next) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: `Invalid ${idLabel} id` });
      const result = await pool.query(
        `SELECT ${selectColumns} FROM public.${table} WHERE id = $1`,
        [id]
      );
      if (result.rowCount === 0) return res.status(404).json({ error: notFoundLabel });
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  });

  /*
   * POST /
   * Body: { name, <extraColumns>? }
   */
  if (hasPost) {
    router.post("/", async (req, res, next) => {
      try {
        const name = String(req.body.name ?? "").trim();
        if (!name) return res.status(400).json({ error: "name is required" });

        const columnNames = ["name"];
        const values = [name];
        for (const col of extraColumns) {
          const raw = req.body[col];
          values.push(raw ? String(raw).trim() : null);
          columnNames.push(col);
        }
        const placeholders = values.map((_, i) => `$${i + 1}`);
        if (hasActive) {
          columnNames.push("active");
          placeholders.push("TRUE");
        }

        const result = await pool.query(
          `INSERT INTO public.${table} (${columnNames.join(", ")})
           VALUES (${placeholders.join(", ")})
           RETURNING ${selectColumns}`,
          values
        );
        res.status(201).json(result.rows[0]);
      } catch (error) {
        if (handleDuplicate(error, res)) return;
        next(error);
      }
    });
  }

  /*
   * PUT /:id
   * Body: { name, <extraColumns>?, active }
   */
  if (hasPut) {
    router.put("/:id", async (req, res, next) => {
      try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: `Invalid ${idLabel} id` });

        const name = String(req.body.name ?? "").trim();
        if (!name) return res.status(400).json({ error: "name is required" });

        const setParts = ["name = $1"];
        const values = [name];
        let idx = 2;
        for (const col of extraColumns) {
          const raw = req.body[col];
          setParts.push(`${col} = $${idx}`);
          values.push(raw ? String(raw).trim() : null);
          idx++;
        }
        if (hasActive) {
          setParts.push(`active = $${idx}`);
          values.push(req.body.active !== false);
          idx++;
        }
        if (hasUpdatedAt) {
          setParts.push("updated_at = CURRENT_TIMESTAMP");
        }
        values.push(id);

        const result = await pool.query(
          `UPDATE public.${table}
           SET ${setParts.join(", ")}
           WHERE id = $${idx}
           RETURNING ${selectColumns}`,
          values
        );
        if (result.rowCount === 0) return res.status(404).json({ error: notFoundLabel });
        res.json(result.rows[0]);
      } catch (error) {
        if (handleDuplicate(error, res)) return;
        next(error);
      }
    });
  }

  /*
   * DELETE /:id
   * "soft"  -> sets active = FALSE (+ updated_at bump if hasUpdatedAt)
   * "hard"  -> real DELETE, blocked by FK (23503) with a friendly message
   * "none"  -> no delete route at all (pv_data_types)
   */
  if (deleteMode !== "none") {
    router.delete("/:id", async (req, res, next) => {
      try {
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: `Invalid ${idLabel} id` });

        let result;
        if (deleteMode === "hard") {
          result = await pool.query(
            `DELETE FROM public.${table} WHERE id = $1 RETURNING ${deleteReturning}`,
            [id]
          );
        } else {
          const setParts = ["active = FALSE"];
          if (hasUpdatedAt) setParts.push("updated_at = CURRENT_TIMESTAMP");
          result = await pool.query(
            `UPDATE public.${table}
             SET ${setParts.join(", ")}
             WHERE id = $1
             RETURNING ${deleteReturning}`,
            [id]
          );
        }
        if (result.rowCount === 0) return res.status(404).json({ error: notFoundLabel });
        res.json({ success: true, [deleteKey]: result.rows[0] });
      } catch (error) {
        if (deleteMode === "hard" && error.code === "23503" && hardDeleteFkMessage) {
          return res.status(409).json({ error: hardDeleteFkMessage });
        }
        next(error);
      }
    });
  }

  return router;
}

/* ---------------------------------------------------------------------
 * 1. pv_data_types  (was pvdatatypes.js)
 *    Read-only: boolean, numeric, text. No POST/PUT/DELETE.
 * --------------------------------------------------------------------- */
const pvDataTypesRouter = createLookupRouter({
  table: "pv_data_types",
  idLabel: "data type",
  notFoundLabel: "Data type not found",
  selectColumns: "id, name, active, created_at, updated_at",
  orderBy: "name",
  hasPost: false,
  hasPut: false,
  deleteMode: "none"
});

/* ---------------------------------------------------------------------
 * 2. device_types  (was devicetypes.js)
 *    Soft delete — devices reference device_types with ON DELETE RESTRICT.
 * --------------------------------------------------------------------- */
const deviceTypesRouter = createLookupRouter({
  table: "device_types",
  idLabel: "device type",
  notFoundLabel: "Device type not found",
  selectColumns: "id, name, active, created_at",
  orderBy: "name",
  hasUpdatedAt: false,
  duplicateMessage: "A device type with this name already exists",
  duplicateField: "name",
  deleteMode: "soft",
  deleteReturning: "id, name, active",
  deleteKey: "deviceType"
});

/* ---------------------------------------------------------------------
 * 3. check_types  (was checktypes.js)
 *    Firmware / EOL / EOS. No "active" column, no PUT. Hard delete,
 *    blocked by the database (ON DELETE RESTRICT) if referenced by
 *    check_logs or version_logs.
 * --------------------------------------------------------------------- */
const checkTypesRouter = createLookupRouter({
  table: "check_types",
  idLabel: "check type",
  notFoundLabel: "Check type not found",
  selectColumns: "id, name",
  orderBy: "id",
  hasActive: false,
  hasUpdatedAt: false,
  hasPut: false,
  duplicateMessage: "A check type with this name already exists",
  duplicateField: "name",
  deleteMode: "hard",
  deleteReturning: "id, name",
  deleteKey: "checkType",
  hardDeleteFkMessage:
    "This check type is in use by existing check_logs or version_logs records and cannot be deleted"
});

/* ---------------------------------------------------------------------
 * 4. version_sources  (was versionsources.js)
 *    AI-Website, Manual-Website, AI-Email from manufacturer.
 *    Soft delete — check_logs references it with ON DELETE SET NULL.
 * --------------------------------------------------------------------- */
const versionSourcesRouter = createLookupRouter({
  table: "version_sources",
  idLabel: "version source",
  notFoundLabel: "Version source not found",
  selectColumns: "id, name, active, created_at",
  orderBy: "name",
  hasUpdatedAt: false,
  duplicateMessage: "A version source with this name already exists",
  duplicateField: "name",
  deleteMode: "soft",
  deleteReturning: "id, name, active",
  deleteKey: "versionSource"
});

/* ---------------------------------------------------------------------
 * 5. service_items  (was serviceitems.js)
 *    Has one extra column: description. Soft delete — service_schedules
 *    references it with ON DELETE RESTRICT.
 * --------------------------------------------------------------------- */
const serviceItemsRouter = createLookupRouter({
  table: "service_items",
  idLabel: "service item",
  notFoundLabel: "Service item not found",
  selectColumns: "id, name, description, active, created_at, updated_at",
  orderBy: "name",
  extraColumns: ["description"],
  duplicateMessage: "A service item with this name already exists",
  duplicateField: "name",
  deleteMode: "soft",
  deleteReturning: "*",
  deleteKey: "serviceItem"
});

/* ---------------------------------------------------------------------
 * 6. package_types  (was packagetypes.js)
 *    Soft delete — packages reference package_types with
 *    ON DELETE RESTRICT. No longer auto-creates a "Running Hours"
 *    pv_attribute on insert (that side effect was removed separately).
 * --------------------------------------------------------------------- */
const packageTypesRouter = createLookupRouter({
  table: "package_types",
  idLabel: "package type",
  notFoundLabel: "Package type not found",
  selectColumns: "id, name, active, created_at, updated_at",
  orderBy: "name",
  duplicateMessage: "A package type with this name already exists",
  deleteMode: "soft",
  deleteReturning: "id, name, active",
  deleteKey: "packageType"
});

module.exports = {
  pvDataTypesRouter,
  deviceTypesRouter,
  checkTypesRouter,
  versionSourcesRouter,
  serviceItemsRouter,
  packageTypesRouter
};

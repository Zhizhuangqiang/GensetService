// src/routes/service-records.js
const express = require("express");
const pool = require("../db");
const router = express.Router();

router.post("/", async (req, res, next) => {
  try {
    const { genset_id, service_item_id, service_date,
            engine_hours, performed_by, work_order_number, remarks } = req.body;
    if (!genset_id || !service_item_id || !service_date) {
      return res.status(400).json({ error: "genset_id, service_item_id and service_date are required" });
    }
    const result = await pool.query(`
      INSERT INTO public.service_records
        (genset_id, service_item_id, service_date, engine_hours,
         performed_by, work_order_number, remarks)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [genset_id, service_item_id, service_date,
       engine_hours ?? null, performed_by ?? null,
       work_order_number ?? null, remarks ?? null]);
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

module.exports = router;
const express = require("express");
const pool = require("../db");

const router = express.Router();

router.get("/", async (req, res, next) => {

  try {

    const result = await pool.query(`
      SELECT
        g.*,
        p.name AS project_name
      FROM gensets g
      LEFT JOIN projects p
        ON p.id = g.project_id
      ORDER BY p.name, g.name
    `);

    res.json(result.rows);

  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM gensets
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Genset not found"
      });
    }

    res.json(result.rows[0]);

  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {

  try {

    const {
      project_id,
      name,
      equipment_tag,
      serial_number
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO gensets
      (
        project_id,
        name,
        equipment_tag,
        serial_number,
        active
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4,
        TRUE
      )
      RETURNING *
      `,
      [
        project_id,
        name,
        equipment_tag,
        serial_number
      ]
    );

    res.status(201).json(result.rows[0]);

  } catch (error) {
    next(error);
  }
});

router.put("/:id", async (req, res, next) => {

  try {

    const {
      project_id,
      name,
      equipment_tag,
      serial_number,
      active
    } = req.body;

    const result = await pool.query(
      `
      UPDATE gensets
      SET
        project_id = $1,
        name = $2,
        equipment_tag = $3,
        serial_number = $4,
        active = $5
      WHERE id = $6
      RETURNING *
      `,
      [
        project_id,
        name,
        equipment_tag,
        serial_number,
        active,
        req.params.id
      ]
    );

    res.json(result.rows[0]);

  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req, res, next) => {

  try {

    await pool.query(
      `
      DELETE FROM gensets
      WHERE id = $1
      `,
      [req.params.id]
    );

    res.json({
      success: true
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;
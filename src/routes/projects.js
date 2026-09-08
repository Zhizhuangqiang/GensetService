const express = require("express");
const pool = require("../db");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM projects
      ORDER BY name
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
      FROM projects
      WHERE id = $1
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Project not found",
      });
    }

    res.json(result.rows[0]);

  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {

    const { name, code } = req.body;

    const result = await pool.query(
      `
      INSERT INTO projects
      (
        name,
        code,
        active
      )
      VALUES
      (
        $1,
        $2,
        TRUE
      )
      RETURNING *
      `,
      [
        name,
        code
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
      name,
      code,
      active
    } = req.body;

    const result = await pool.query(
      `
      UPDATE projects
      SET
        name = $1,
        code = $2,
        active = $3
      WHERE id = $4
      RETURNING *
      `,
      [
        name,
        code,
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
      DELETE FROM projects
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
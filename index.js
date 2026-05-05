const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

// Connect to Railway Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Main route
app.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      message: "Meetro API running",
      time: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      error: "Database connection failed",
      details: err.message,
    });
  }
});

// Health route
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Test DB route
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
app.post("/users", async (req, res) => {
  try {
    const { email } = req.body;

    const result = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING *",
      [email]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Failed to create user",
    });
  }
});

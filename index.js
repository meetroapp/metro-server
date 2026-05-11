const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: "No token provided",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "my_super_secret_key_123"
    );

    req.user = decoded;

    next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid token",
    });
  }
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

app.post("/auth/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users 
      (username, email, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, email, created_at
      `,
      [username || email, email, passwordHash]
    );

    res.json({
      message: "User created",
      user: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Signup failed",
      details: err.message,
    });
  }
});

app.get("/debug-env", (req, res) => {
  res.json({
    hasJwtSecret: !!process.env.JWT_SECRET,
    jwtLength: process.env.JWT_SECRET
      ? process.env.JWT_SECRET.length
      : 0,
  });
});

app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
      },
      process.env.JWT_SECRET || "my_super_secret_key_123",
      {
        expiresIn: "1h",
      }
    );

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "Login failed",
      details: err.message,
    });
  }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, username, email, created_at
      FROM users
      WHERE id = $1
      `,
      [req.user.id]
    );

    res.json({
      user: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch user",
      details: err.message,
    });
  }
});

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { title, description, category, location } = req.body;

    const result = await pool.query(
      `
      INSERT INTO posts
      (user_id, title, description, category, location)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [req.user.id, title, description, category, location]
    );

    res.json({
      message: "Post created",
      post: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to create post",
      details: err.message,
    });
  }
});

app.get("/posts", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT posts.*, users.email, users.username
      FROM posts
      JOIN users ON posts.user_id = users.id
      ORDER BY posts.created_at DESC
      `
    );

    res.json({
      posts: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch posts",
      details: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

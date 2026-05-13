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
    const {
      title,
      description,
      category,
      location,
      image_url,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO posts
      (user_id, title, description, category, location, image_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        req.user.id,
        title,
        description,
        category,
        location,
        image_url,
      ]
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

app.get("/posts/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT posts.*, users.email, users.username
      FROM posts
      JOIN users ON posts.user_id = users.id
      WHERE posts.id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Post not found",
      });
    }

    res.json({
      post: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch post",
      details: err.message,
    });
  }
});

app.post("/contractor-profiles", authMiddleware, async (req, res) => {
  try {
    const {
      business_name,
      category,
      phone,
      location,
      bio,
      image_url,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO contractor_profiles
      (
        user_id,
        business_name,
        category,
        phone,
        location,
        bio,
        image_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        req.user.id,
        business_name,
        category,
        phone,
        location,
        bio,
        image_url,
      ]
    );

    res.json({
      message: "Contractor profile created",
      profile: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to create contractor profile",
      details: err.message,
    });
  }
});

app.get("/contractor-profiles", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT contractor_profiles.*, users.username
      FROM contractor_profiles
      JOIN users ON contractor_profiles.user_id = users.id
      ORDER BY contractor_profiles.created_at DESC
      `
    );

    res.json({
      profiles: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profiles",
      details: err.message,
    });
  }
});

app.get("/contractor-profiles/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT contractor_profiles.*, users.username
      FROM contractor_profiles
      JOIN users ON contractor_profiles.user_id = users.id
      WHERE contractor_profiles.id = $1
      `,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contractor profile not found",
      });
    }

    res.json({
      profile: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profile",
      details: err.message,
    });
  }
});

app.get("/my-contractor-profile", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM contractor_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "No contractor profile found",
      });
    }

    res.json({
      profile: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profile",
      details: err.message,
    });
  }
});
app.put("/contractor-profiles/:id", authMiddleware, async (req, res) => {
  try {
    const {
      business_name,
      category,
      phone,
      location,
      bio,
      image_url,
    } = req.body;

    const result = await pool.query(
      `
      UPDATE contractor_profiles
      SET
        business_name = $1,
        category = $2,
        phone = $3,
        location = $4,
        bio = $5,
        image_url = $6
      WHERE id = $7 AND user_id = $8
      RETURNING *
      `,
      [
        business_name,
        category,
        phone,
        location,
        bio,
        image_url,
        req.params.id,
        req.user.id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Profile not found or not authorized",
      });
    }

    res.json({
      message: "Contractor profile updated",
      profile: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update contractor profile",
      details: err.message,
    });
  }
});
app.post("/quote-requests", authMiddleware, async (req, res) => {
  try {
    const { contractor_id, project_title, project_description, location } = req.body;

    const result = await pool.query(
      `
      INSERT INTO quote_requests
      (contractor_id, homeowner_id, project_title, project_description, location)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [contractor_id, req.user.id, project_title, project_description, location]
    );

    res.json({
      message: "Quote request created",
      quote: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to create quote request",
      details: err.message,
    });
  }
});

app.get("/my-quote-requests", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT quote_requests.*, contractor_profiles.business_name
      FROM quote_requests
      JOIN contractor_profiles ON quote_requests.contractor_id = contractor_profiles.id
      WHERE quote_requests.homeowner_id = $1
      ORDER BY quote_requests.created_at DESC
      `,
      [req.user.id]
    );

    res.json({
      quotes: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch quote requests",
      details: err.message,
    });
  }
});

app.get("/contractor-quote-requests", authMiddleware, async (req, res) => {
  try {
    const profileResult = await pool.query(
      `
      SELECT id
      FROM contractor_profiles
      WHERE user_id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (profileResult.rows.length === 0) {
      return res.json({ quotes: [] });
    }

    const contractorId = profileResult.rows[0].id;

    const result = await pool.query(
      `
      SELECT quote_requests.*, users.email AS homeowner_email
      FROM quote_requests
      JOIN users ON quote_requests.homeowner_id = users.id
      WHERE quote_requests.contractor_id = $1
      ORDER BY quote_requests.created_at DESC
      `,
      [contractorId]
    );

    res.json({
      quotes: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor quote requests",
      details: err.message,
    });
  }
});
app.post("/messages", authMiddleware, async (req, res) => {
  try {
    const {
      quote_request_id,
      receiver_id,
      message_text,
      image_url,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO messages
      (quote_request_id, sender_id, receiver_id, message_text, image_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        quote_request_id,
        req.user.id,
        receiver_id,
        message_text || "",
        image_url || null,
      ]
    );

    res.json({
      message: "Message sent",
      data: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to send message",
      details: err.message,
    });
  }
});

app.get("/messages/:quoteRequestId", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT messages.*, users.email AS sender_email
      FROM messages
      JOIN users ON messages.sender_id = users.id
      WHERE messages.quote_request_id = $1
      ORDER BY messages.created_at ASC
      `,
      [req.params.quoteRequestId]
    );

    res.json({
      messages: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch messages",
      details: err.message,
    });
  }
});

app.post("/reviews", authMiddleware, async (req, res) => {
  try {
    const {
      contractor_id,
      rating,
      review_text,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO reviews
      (contractor_id, reviewer_id, rating, review_text)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        contractor_id,
        req.user.id,
        rating,
        review_text,
      ]
    );

    res.json({
      message: "Review added",
      review: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to create review",
      details: err.message,
    });
  }
});

app.get("/reviews/:contractorId", async (req, res) => {
  try {
    const contractorId = req.params.contractorId;

    const reviewsResult = await pool.query(
      `
      SELECT
        reviews.*,
        users.email AS reviewer_email
      FROM reviews
      JOIN users
      ON reviews.reviewer_id = users.id
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    const ratingResult = await pool.query(
      `
      SELECT
        AVG(rating)::numeric(10,1) AS average_rating,
        COUNT(*) AS total_reviews
      FROM reviews
      WHERE contractor_id = $1
      `,
      [contractorId]
    );

    res.json({
      reviews: reviewsResult.rows,
      stats: ratingResult.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch reviews",
      details: err.message,
    });
  }
});

app.post("/contractor-projects", authMiddleware, async (req, res) => {
  try {
    const {
      contractor_id,
      title,
      description,
      image_url,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO contractor_projects
      (contractor_id, title, description, image_url)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        contractor_id,
        title,
        description,
        image_url,
      ]
    );

    res.json({
      message: "Project uploaded",
      project: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to upload project",
      details: err.message,
    });
  }
});

app.get("/contractor-projects/:contractorId", async (req, res) => {
  try {
    const contractorId = req.params.contractorId;

    const result = await pool.query(
      `
      SELECT *
      FROM contractor_projects
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    res.json({
      projects: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch projects",
      details: err.message,
    });
  }
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

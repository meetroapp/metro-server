require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const twoFactorCodes = {};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

function createToken(user, expiresIn = "7d") {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET || "my_super_secret_key_123",
    { expiresIn }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "No token provided" });
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
    return res.status(401).json({ error: "Invalid token" });
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
      error: "Database connection failed",
      details: err.message,
    });
  }
});

app.post("/auth/signup", async (req, res) => {
  try {
    const {
      username,
      name,
      email,
      password,
      role,
      account_type,
      business_name,
      business_category,
    } = req.body;

    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPassword = String(password || "");

    if (!cleanEmail || !cleanPassword) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const existingUser = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        error: "Email already exists",
      });
    }

    const finalAccountType =
      account_type === "professional"
        ? "professional"
        : "homeowner";

    const finalBusinessCategory =
      finalAccountType === "professional"
        ? business_category || role || "contractor"
        : "";

    const finalBusinessName =
      finalAccountType === "professional"
        ? business_name || username || name || ""
        : "";

    const finalRole =
      finalAccountType === "professional"
        ? finalBusinessCategory
        : "homeowner";

    const finalUsername = username || name || cleanEmail;

    const passwordHash = await bcrypt.hash(cleanPassword, 10);

    const result = await pool.query(
      `
      INSERT INTO users
      (username, email, password_hash, role, account_type, business_name, business_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, username, email, role, account_type, business_name, business_category, profile_photo_url, created_at
      `,
      [
        finalUsername,
        cleanEmail,
        passwordHash,
        finalRole,
        finalAccountType,
        finalBusinessName,
        finalBusinessCategory,
      ]
    );

    const user = result.rows[0];
    const token = createToken(user);

    res.json({
      message: "User created",
      token,
      user,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({
      error: "Signup failed",
      details: err.message,
    });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const cleanEmail = String(req.body.email || "").trim().toLowerCase();
    const cleanPassword = String(req.body.password || "");

    if (!cleanEmail || !cleanPassword) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      cleanEmail,
    ]);

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const valid = await bcrypt.compare(cleanPassword, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const token = createToken(user);

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        account_type: user.account_type,
        business_name: user.business_name,
        business_category: user.business_category,
        profile_photo_url: user.profile_photo_url || "",
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      error: "Login failed",
      details: err.message,
    });
  }
});


app.put("/auth/profile-photo", authMiddleware, async (req, res) => {
  try {
    const { profile_photo_url } = req.body;

    const result = await pool.query(
      `
      UPDATE users
      SET profile_photo_url = $1
      WHERE id = $2
      RETURNING id, username, email, role, account_type, business_name, business_category, profile_photo_url, created_at
      `,
      [profile_photo_url || "", req.user.id]
    );

    res.json({
      message: "Profile photo updated",
      user: result.rows[0],
    });
  } catch (err) {
    console.error("Profile photo update error:", err);
    res.status(500).json({
      error: "Failed to update profile photo",
      details: err.message,
    });
  }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, username, email, role, account_type, business_name, business_category, profile_photo_url, created_at
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

app.post("/auth/request-2fa-code", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    const code = crypto.randomInt(100000, 999999).toString();

    twoFactorCodes[email] = {
      code,
      expires: Date.now() + 1000 * 60 * 10,
    };

    console.log("MEETRO 2FA CODE:", code);

    res.json({
      message: "2FA code generated",
      expiresInMinutes: 10,
      devCode: "123456",
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to generate 2FA code",
      details: err.message,
    });
  }
});

app.post("/auth/verify-2fa-code", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();

    console.log("VERIFY 2FA BODY:", { email, code });

    if (!email || !code) {
      return res.status(400).json({
        error: "Email and code required",
      });
    }

    if (code === "123456") {
      return res.json({
        success: true,
        message: "Code verified",
      });
    }

    return res.status(400).json({
      error: "Invalid code",
    });
  } catch (error) {
    console.error("2FA verify error:", error);
    return res.status(500).json({
      error: "Server error verifying code",
    });
  }
});

app.get("/auth/security-status", authMiddleware, async (req, res) => {
  res.json({
    twoFactorEnabled: false,
    trustedDevicesEnabled: false,
    biometricAvailable: false,
    message: "Security status placeholder ready",
  });
});

app.post("/auth/enable-2fa", authMiddleware, async (req, res) => {
  res.json({
    enabled: true,
    message: "2FA enable placeholder ready",
  });
});

app.post("/auth/disable-2fa", authMiddleware, async (req, res) => {
  res.json({
    enabled: false,
    message: "2FA disable placeholder ready",
  });
});

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { title, description, category, location, image_url } = req.body;

    const result = await pool.query(
      `
      INSERT INTO posts
      (user_id, title, description, category, location, image_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [req.user.id, title, description, category, location, image_url]
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
    const { business_name, category, phone, location, bio, image_url } =
      req.body;

    const result = await pool.query(
      `
      INSERT INTO contractor_profiles
      (user_id, business_name, category, phone, location, bio, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [req.user.id, business_name, category, phone, location, bio, image_url]
    );
    
    await pool.query(
  `
  UPDATE users
  SET
    account_type = 'professional',
    role = $1,
    business_name = $2,
    business_category = $1
  WHERE id = $3
  `,
  [
    category,
    business_name,
    req.user.id,
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
    const { business_name, category, phone, location, bio, image_url } =
      req.body;

    const result = await pool.query(
      `
      UPDATE contractor_profiles
      SET business_name = $1, category = $2, phone = $3, location = $4, bio = $5, image_url = $6
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
    const { contractor_id, project_title, project_description, location } =
      req.body;

    const result = await pool.query(
      `
      INSERT INTO quote_requests
      (contractor_id, homeowner_id, project_title, project_description, location)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        contractor_id,
        req.user.id,
        project_title,
        project_description,
        location,
      ]
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
      message_type,
      workflow_type,
      workflow_status,
      workflow_payload,
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO messages
      (
        quote_request_id,
        sender_id,
        receiver_id,
        message_text,
        image_url,
        message_type,
        workflow_type,
        workflow_status,
        workflow_payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *
      `,
      [
        quote_request_id,
        req.user.id,
        receiver_id,
        message_text || "",
        image_url || null,
        message_type || "text",
        workflow_type || null,
        workflow_status || null,
        JSON.stringify(workflow_payload || {}),
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


// Workflow persistence routes
app.post("/workflow-events", authMiddleware, async (req, res) => {
  try {
    const {
      quote_request_id,
      workflow_type,
      workflow_status,
      workflow_payload,
      event_label,
    } = req.body;

    if (!quote_request_id || !workflow_type) {
      return res.status(400).json({
        error: "quote_request_id and workflow_type are required",
      });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        id SERIAL PRIMARY KEY,
        quote_request_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_status TEXT,
        workflow_payload JSONB DEFAULT '{}'::jsonb,
        event_label TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      `
      INSERT INTO workflow_events
      (
        quote_request_id,
        user_id,
        workflow_type,
        workflow_status,
        workflow_payload,
        event_label
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      RETURNING *
      `,
      [
        quote_request_id,
        req.user.id,
        workflow_type,
        workflow_status || null,
        JSON.stringify(workflow_payload || {}),
        event_label || null,
      ]
    );

    res.json({
      message: "Workflow event saved",
      workflow_event: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to save workflow event",
      details: err.message,
    });
  }
});

app.get("/workflow-events/:quoteRequestId", authMiddleware, async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_events (
        id SERIAL PRIMARY KEY,
        quote_request_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        workflow_type TEXT NOT NULL,
        workflow_status TEXT,
        workflow_payload JSONB DEFAULT '{}'::jsonb,
        event_label TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await pool.query(
      `
      SELECT workflow_events.*, users.email AS user_email
      FROM workflow_events
      JOIN users ON workflow_events.user_id = users.id
      WHERE workflow_events.quote_request_id = $1
      ORDER BY workflow_events.created_at ASC
      `,
      [req.params.quoteRequestId]
    );

    res.json({
      workflow_events: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch workflow events",
      details: err.message,
    });
  }
});

app.post("/reviews", authMiddleware, async (req, res) => {
  try {
    const { contractor_id, rating, review_text } = req.body;

    const result = await pool.query(
      `
      INSERT INTO reviews
      (contractor_id, reviewer_id, rating, review_text)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [contractor_id, req.user.id, rating, review_text]
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
      SELECT reviews.*, users.email AS reviewer_email
      FROM reviews
      JOIN users ON reviews.reviewer_id = users.id
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    const ratingResult = await pool.query(
      `
      SELECT AVG(rating)::numeric(10,1) AS average_rating, COUNT(*) AS total_reviews
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
    const { contractor_id, title, description, image_url, image_urls } = req.body;

    const imageUrls = Array.isArray(image_urls)
      ? image_urls
      : image_url
      ? [image_url]
      : [];

    const result = await pool.query(
      `
      INSERT INTO contractor_projects
      (contractor_id, title, description, image_url, image_urls)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING *
      `,
      [
        contractor_id,
        title,
        description,
        imageUrls[0] || image_url || "",
        JSON.stringify(imageUrls),
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

app.put("/contractor-projects/:id", authMiddleware, async (req, res) => {
  try {
    const projectId = req.params.id;
    const { title, description, image_url, image_urls } = req.body;

    const imageUrls = Array.isArray(image_urls)
      ? image_urls
      : image_url
      ? [image_url]
      : [];

    const result = await pool.query(
      `
      UPDATE contractor_projects
      SET
        title = $1,
        description = $2,
        image_url = $3,
        image_urls = $4::jsonb
      WHERE id = $5
      RETURNING *
      `,
      [
        title,
        description,
        imageUrls[0] || image_url || "",
        JSON.stringify(imageUrls),
        projectId,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Project not found",
      });
    }

    res.json({
      message: "Project updated",
      project: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to update project",
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

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const packageJson = require("./package.json");
const { createAuthRateLimiter } = require("./server/security/authRateLimit");
const { resolveJwtSecret } = require("./server/security/jwtConfig");
const { validatePasswordPolicy } = require("./server/security/passwordPolicy");
const { createEmailDelivery } = require("./server/email/emailDelivery");
const {
  GENERIC_REQUEST_RESPONSE,
  createPasswordResetService,
  hashResetToken,
} = require("./server/security/passwordResetService");
const {
  TWO_FACTOR_FAILURE,
  createTwoFactorChallengeStore,
  normalizeIdentity,
} = require("./server/security/twoFactorChallenges");
const {
  buildCreateBusinessProfileQuery,
  buildUpdateBusinessProfileQuery,
  serializeOwnedBusinessProfile,
  serializePublicBusinessProfile,
  validateBusinessProfilePayload,
} = require("./server/profile/businessProfile");
const {
  isProductionRuntime,
  logSafeServerError,
  sendPublicDatabaseError,
} = require("./server/errors/publicErrors");

const JWT_SECRET = resolveJwtSecret(process.env);
const BCRYPT_ROUNDS = 10;

const app = express();

const LOCAL_DEV_ORIGINS = Object.freeze([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function parseOriginList(value) {
  if (!value) return [];

  return String(value)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getApprovedCorsOrigins(env = process.env) {
  const configuredOrigins = [
    ...parseOriginList(env.ALLOWED_ORIGINS),
    ...parseOriginList(env.FRONTEND_ORIGINS),
    ...parseOriginList(env.FRONTEND_URL),
    ...parseOriginList(env.PUBLIC_WEB_ORIGIN),
  ];

  if (env.NODE_ENV !== "production") {
    configuredOrigins.push(...LOCAL_DEV_ORIGINS);
  }

  return new Set(configuredOrigins.filter((origin) => origin !== "*"));
}

function createCorsOptions(env = process.env) {
  const approvedOrigins = getApprovedCorsOrigins(env);
  const allowRequestsWithoutOrigin = env.NODE_ENV !== "production";

  return {
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    origin(origin, callback) {
      if (!origin) {
        return callback(null, allowRequestsWithoutOrigin);
      }

      if (approvedOrigins.has(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Origin not allowed by CORS"));
    },
  };
}

app.use(cors(createCorsOptions()));
app.use(express.json());

function jsonSyntaxErrorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  next(err);
}

app.use(jsonSyntaxErrorHandler);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

function getPool(req) {
  return req.app?.locals?.pool || pool;
}

const loginRateLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  keyResolver: (req) => `login:${normalizeIdentity(getRequestBody(req).email) || "anonymous"}`,
});
const twoFactorRequestRateLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  keyResolver: (req) => `2fa-request:${normalizeIdentity(getRequestBody(req).email) || "anonymous"}`,
});
const twoFactorVerifyRateLimiter = createAuthRateLimiter({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  keyResolver: (req) => {
    const body = getRequestBody(req);
    return `2fa-verify:${body.challengeId || body.challenge_id || normalizeIdentity(body.email) || "anonymous"}`;
  },
});
const passwordChangeRateLimiter = createAuthRateLimiter({
  windowMs: 30 * 60 * 1000,
  maxAttempts: 5,
  keyResolver: (req) => `password-change:${req.user?.id || "anonymous"}`,
});
const passwordResetRequestRateLimiter = createAuthRateLimiter({
  windowMs: 30 * 60 * 1000,
  maxAttempts: 5,
  keyResolver: (req) => {
    const emailHash = hashResetToken(normalizeIdentity(getRequestBody(req).email));
    const ipHash = hashResetToken(req.ip || req.socket?.remoteAddress || "unknown");
    return `password-reset-request:${emailHash.slice(0, 16)}:${ipHash.slice(0, 16)}`;
  },
  limitResponse: (_req, res) => res.status(429).json(GENERIC_REQUEST_RESPONSE),
});
const passwordResetCompleteRateLimiter = createAuthRateLimiter({
  windowMs: 30 * 60 * 1000,
  maxAttempts: 10,
  keyResolver: (req) => {
    const tokenHash = hashResetToken(getRequestBody(req).token);
    return `password-reset-complete:${tokenHash.slice(0, 16)}`;
  },
});
const twoFactorChallengeStore = createTwoFactorChallengeStore();
const emailDelivery = createEmailDelivery({ env: process.env });

function getPasswordResetService(req) {
  return req.app?.locals?.passwordResetService || createPasswordResetService({
    pool: getPool(req),
    emailDelivery: req.app?.locals?.emailDelivery || emailDelivery,
    env: process.env,
    logger: logAuthFailure,
  });
}

function logAuthFailure(event, code, userId) {
  console.error("Authentication operation failed", {
    event,
    code,
    ...(userId ? { userId } : {}),
  });
}

function validateWorkflowEventPayload(body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const quoteRequestId = Number(source.quote_request_id);
  const workflowType =
    typeof source.workflow_type === "string" ? source.workflow_type.trim() : "";
  const workflowStatus = source.workflow_status;
  const workflowPayload = source.workflow_payload;
  const eventLabel = source.event_label;

  const valid =
    Number.isInteger(quoteRequestId) &&
    quoteRequestId > 0 &&
    Boolean(workflowType) &&
    (workflowStatus == null || typeof workflowStatus === "string") &&
    (workflowPayload == null ||
      (typeof workflowPayload === "object" && !Array.isArray(workflowPayload))) &&
    (eventLabel == null || typeof eventLabel === "string");

  if (!valid) return { valid: false };

  return {
    valid: true,
    value: {
      quoteRequestId,
      workflowType,
      workflowStatus: workflowStatus || null,
      workflowPayload: workflowPayload || {},
      eventLabel: eventLabel || null,
    },
  };
}

function sendWorkflowEventDatabaseFailure(res, operation, error) {
  const schemaUnavailable = error?.code === "42P01";
  console.error("Workflow event operation failed", {
    operation,
    code: error?.code || "DATABASE_OPERATION_FAILED",
  });

  return res.status(schemaUnavailable ? 503 : 500).json({
    error: schemaUnavailable
      ? "Workflow events are temporarily unavailable"
      : `Failed to ${operation} workflow events`,
    code: schemaUnavailable
      ? "WORKFLOW_EVENTS_UNAVAILABLE"
      : `WORKFLOW_EVENTS_${operation.toUpperCase()}_FAILED`,
  });
}

function buildHealthMetadata(env = process.env) {
  return {
    status: "ok",
    version: packageJson.version,
    environment:
      env.RAILWAY_ENVIRONMENT_NAME ||
      env.RAILWAY_ENVIRONMENT ||
      env.NODE_ENV ||
      "unknown",
    commit:
      env.RAILWAY_GIT_COMMIT_SHA ||
      env.VERCEL_GIT_COMMIT_SHA ||
      env.GIT_COMMIT ||
      env.COMMIT_SHA ||
      "unknown",
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

function getRequestBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function maskEmail(email) {
  const [localPart = "", domain = ""] = normalizeIdentity(email).split("@");
  if (!localPart || !domain) return "***";
  const visible = localPart.slice(0, Math.min(2, localPart.length));
  return `${visible}***@${domain}`;
}

function getEmailDelivery(req) {
  return req.app?.locals?.emailDelivery || emailDelivery;
}

async function initiateSecurityVerification(req, account) {
  const prepared = twoFactorChallengeStore.prepare(account.email, {
    accountId: account.id,
    passwordVerified: true,
    tokenVersionSnapshot: Number(account.token_version || 0),
  });
  if (!prepared.ok) {
    return {
      ok: false,
      status: 429,
      body: {
        success: false,
        code: "TOO_MANY_ATTEMPTS",
        message: "Try again later.",
        retryAfterSeconds: prepared.retryAfterSeconds,
      },
    };
  }

  let deliveryResult;
  try {
    deliveryResult = await getEmailDelivery(req).sendSecurityVerificationCode({
      recipientEmail: account.email,
      maskedEmail: maskEmail(account.email),
      code: prepared.deliveryCode,
      expiresInMinutes: Math.ceil((prepared.expiresAt - prepared.createdAt) / 60000),
      challengeId: prepared.challengeId,
    });
  } catch {
    deliveryResult = { accepted: false, status: "provider_unavailable" };
  }

  if (!deliveryResult?.accepted) {
    twoFactorChallengeStore.cancel(prepared);
    logAuthFailure("security_verification_delivery", "DELIVERY_UNAVAILABLE", account.id);
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        code: "VERIFICATION_DELIVERY_UNAVAILABLE",
        message: "Verification code could not be sent. Please try again.",
      },
    };
  }

  const activated = twoFactorChallengeStore.activate(prepared);
  if (!activated.ok) {
    twoFactorChallengeStore.cancel(prepared);
    return {
      ok: false,
      status: 503,
      body: {
        success: false,
        code: "VERIFICATION_DELIVERY_UNAVAILABLE",
        message: "Verification code could not be sent. Please try again.",
      },
    };
  }

  return {
    ok: true,
    challengeId: activated.challengeId,
    maskedEmail: maskEmail(account.email),
    expiresInSeconds: Math.max(1, Math.ceil((prepared.expiresAt - prepared.createdAt) / 1000)),
  };
}

function validateLoginRequestBody(body) {
  const source = body && typeof body === "object" ? body : {};
  const email = String(source.email || "").trim().toLowerCase();
  const password = String(source.password || "");

  if (!email || !password) {
    return {
      ok: false,
      status: 400,
      error: "Email and password are required",
    };
  }

  return {
    ok: true,
    email,
    password,
  };
}

function validateProfileUpdateRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_PROFILE_UPDATE",
      message: "Profile update must be an object.",
    };
  }

  const allowedFields = new Set(["username"]);
  const unsupportedFields = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unsupportedFields.length > 0) {
    return {
      ok: false,
      status: 400,
      code: "UNSUPPORTED_PROFILE_FIELDS",
      message: "One or more profile fields cannot be updated here.",
    };
  }

  const username = String(body.username || "").trim();
  if (!username) {
    return {
      ok: false,
      status: 400,
      code: "PROFILE_NAME_REQUIRED",
      message: "Name is required.",
    };
  }
  if (username.length > 80) {
    return {
      ok: false,
      status: 400,
      code: "PROFILE_NAME_TOO_LONG",
      message: "Name must be 80 characters or fewer.",
    };
  }

  return {
    ok: true,
    username,
  };
}

function toSafePostRow(row = {}) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    category: row.category,
    created_at: row.created_at,
    mage_url: row.mage_url ?? null,
    image_url: row.image_url ?? "",
  };
}

function buildUserPostsQuery(userId) {
  return {
    text: `
      SELECT id, title, description, location, category, created_at, mage_url, image_url
      FROM posts
      WHERE user_id = $1
      ORDER BY posts.created_at DESC
      `,
    values: [userId],
  };
}

function buildUserPostByIdQuery(postId, userId) {
  return {
    text: `
      SELECT id, title, description, location, category, created_at, mage_url, image_url
      FROM posts
      WHERE id = $1 AND user_id = $2
      `,
    values: [postId, userId],
  };
}

function buildQuoteRequestParticipantQuery(quoteRequestId, userId) {
  return {
    text: `
      SELECT
        quote_requests.id,
        quote_requests.homeowner_id,
        contractor_profiles.user_id AS contractor_user_id
      FROM quote_requests
      JOIN contractor_profiles ON quote_requests.contractor_id = contractor_profiles.id
      WHERE quote_requests.id = $1
        AND (
          quote_requests.homeowner_id = $2
          OR contractor_profiles.user_id = $2
        )
      LIMIT 1
      `,
    values: [quoteRequestId, userId],
  };
}

function getQuoteParticipantUserIds(quoteRequest = {}) {
  return [quoteRequest.homeowner_id, quoteRequest.contractor_user_id]
    .filter((id) => id !== undefined && id !== null && id !== "")
    .map((id) => String(id));
}

function receiverBelongsToQuoteRequest(quoteRequest, receiverId) {
  if (receiverId === undefined || receiverId === null || receiverId === "") {
    return true;
  }

  return getQuoteParticipantUserIds(quoteRequest).includes(String(receiverId));
}

async function findAuthorizedQuoteRequest(poolClient, quoteRequestId, userId) {
  const query = buildQuoteRequestParticipantQuery(quoteRequestId, userId);
  const result = await poolClient.query(query.text, query.values);

  return result.rows[0] || null;
}

function buildOwnedContractorProjectUpdateQuery({
  projectId,
  ownerUserId,
  title,
  description,
  imageUrl,
  imageUrls,
}) {
  return {
    text: `
      UPDATE contractor_projects
      SET
        title = $1,
        description = $2,
        image_url = $3,
        image_urls = $4::jsonb
      WHERE contractor_projects.id = $5
        AND EXISTS (
          SELECT 1
          FROM contractor_profiles
          WHERE contractor_profiles.id = contractor_projects.contractor_id
            AND contractor_profiles.user_id = $6
        )
      RETURNING *
      `,
    values: [
      title,
      description,
      imageUrl,
      JSON.stringify(imageUrls),
      projectId,
      ownerUserId,
    ],
  };
}

function buildOwnedContractorProjectCreateQuery({
  contractorId,
  ownerUserId,
  title,
  description,
  imageUrl,
  imageUrls,
}) {
  return {
    text: `
      INSERT INTO contractor_projects
      (contractor_id, title, description, image_url, image_urls)
      SELECT contractor_profiles.id, $2, $3, $4, $5::jsonb
      FROM contractor_profiles
      WHERE contractor_profiles.id = $1
        AND contractor_profiles.user_id = $6
      RETURNING *
      `,
    values: [
      contractorId,
      title,
      description,
      imageUrl,
      JSON.stringify(imageUrls),
      ownerUserId,
    ],
  };
}

function createToken(user, expiresIn = "7d") {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: Number(user.token_version ?? user.tokenVersion ?? 0),
    },
    JWT_SECRET,
    { expiresIn }
  );
}

async function authMiddleware(req, res, next) {
  const authHeader = String(req.headers?.authorization || "");

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return res.status(401).json({
      success: false,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication required.",
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await getPool(req).query(
      `
      SELECT id, email, role, token_version
      FROM users
      WHERE id = $1
      `,
      [decoded.id]
    );
    const user = result.rows[0];
    const tokenVersion = Number(decoded.tokenVersion ?? 0);

    if (!user || Number(user.token_version || 0) !== tokenVersion) {
      return res.status(401).json({
        success: false,
        code: "SESSION_INVALID",
        message: "Session is no longer valid.",
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion,
    };
    next();
  } catch {
    return res.status(401).json({
      success: false,
      code: "SESSION_INVALID",
      message: "Session is no longer valid.",
    });
  }
}

app.get("/health", (req, res) => {
  res.json(buildHealthMetadata());
});

app.get("/test-db", async (req, res) => {
  if (isProductionRuntime(process.env)) {
    return res.status(404).json({
      error: "NOT_FOUND",
      message: "Resource not found.",
    });
  }

  try {
    await getPool(req).query("SELECT NOW()");
    return res.json({ status: "ok" });
  } catch (err) {
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "database_diagnostic",
      code: "DATABASE_UNAVAILABLE",
      message: "The service is temporarily unavailable.",
      status: 503,
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

    const passwordPolicy = validatePasswordPolicy(cleanPassword);
    if (!passwordPolicy.valid) {
      return res.status(400).json({
        success: false,
        code: "PASSWORD_POLICY_FAILED",
        policyCode: passwordPolicy.code,
        message: "Password does not meet requirements.",
      });
    }

    const requestPool = getPool(req);
    const existingUser = await requestPool.query(
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

    const passwordHash = await bcrypt.hash(cleanPassword, BCRYPT_ROUNDS);

    const result = await requestPool.query(
      `
      INSERT INTO users
      (username, email, password_hash, role, account_type, business_name, business_category)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, username, email, role, account_type, business_name, business_category, profile_photo_url, token_version, created_at
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
    const verification = await initiateSecurityVerification(req, user);
    if (!verification.ok) {
      return res.status(verification.status).json(verification.body);
    }

    res.json({
      success: true,
      code: "VERIFICATION_REQUIRED",
      challengeId: verification.challengeId,
      maskedEmail: verification.maskedEmail,
      expiresInSeconds: verification.expiresInSeconds,
    });
  } catch {
    logAuthFailure("signup", "SIGNUP_FAILED");
    res.status(500).json({
      error: "Signup failed",
    });
  }
});

app.post("/auth/login", loginRateLimiter, async (req, res) => {
  try {
    const loginRequest = validateLoginRequestBody(getRequestBody(req));

    if (!loginRequest.ok) {
      return res.status(loginRequest.status).json({
        error: loginRequest.error,
      });
    }

    const result = await getPool(req).query(
      `
      SELECT id, username, email, password_hash, role, account_type,
             business_name, business_category, profile_photo_url, token_version
      FROM users
      WHERE email = $1
      `,
      [loginRequest.email]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const valid = await bcrypt.compare(loginRequest.password, user.password_hash);

    if (!valid) {
      return res.status(401).json({
        error: "Invalid login",
      });
    }

    const verification = await initiateSecurityVerification(req, user);
    if (!verification.ok) {
      return res.status(verification.status).json(verification.body);
    }

    res.json({
      success: true,
      code: "VERIFICATION_REQUIRED",
      challengeId: verification.challengeId,
      maskedEmail: verification.maskedEmail,
      expiresInSeconds: verification.expiresInSeconds,
    });
  } catch {
    logAuthFailure("login", "LOGIN_FAILED");
    res.status(500).json({
      error: "Login failed",
    });
  }
});


app.put("/auth/profile-photo", authMiddleware, async (req, res) => {
  try {
    const { profile_photo_url } = req.body;

    const result = await getPool(req).query(
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
  } catch {
    logAuthFailure("profile_photo_update", "PROFILE_PHOTO_UPDATE_FAILED", req.user.id);
    res.status(500).json({
      error: "Failed to update profile photo",
    });
  }
});

app.patch("/auth/profile", authMiddleware, async (req, res) => {
  const profileUpdate = validateProfileUpdateRequestBody(getRequestBody(req));
  if (!profileUpdate.ok) {
    return res.status(profileUpdate.status).json({
      success: false,
      code: profileUpdate.code,
      message: profileUpdate.message,
    });
  }

  try {
    const result = await getPool(req).query(
      `
      UPDATE users
      SET username = $1
      WHERE id = $2
      RETURNING id, username, email, role, account_type, business_name, business_category, profile_photo_url, token_version, created_at
      `,
      [profileUpdate.username, req.user.id]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({
        success: false,
        code: "SESSION_INVALID",
        message: "Session is no longer valid.",
      });
    }

    return res.json({
      success: true,
      code: "PROFILE_UPDATED",
      user,
    });
  } catch {
    logAuthFailure("profile_update", "PROFILE_UPDATE_FAILED", req.user.id);
    return res.status(500).json({
      success: false,
      code: "PROFILE_UPDATE_FAILED",
      message: "Profile update could not be completed.",
    });
  }
});

app.get("/auth/me", authMiddleware, async (req, res) => {
  try {
    const result = await getPool(req).query(
      `
      SELECT users.id, users.username, users.email, users.role, users.account_type,
             COALESCE(profile.business_name, users.business_name) AS business_name,
             COALESCE(profile.category, users.business_category) AS business_category,
             users.profile_photo_url, users.created_at,
             profile.id AS contractor_profile_id,
             (profile.id IS NOT NULL) AS has_business_profile
      FROM users
      LEFT JOIN LATERAL (
        SELECT contractor_profiles.id,
               contractor_profiles.business_name,
               contractor_profiles.category
        FROM contractor_profiles
        WHERE contractor_profiles.user_id = users.id
        ORDER BY contractor_profiles.created_at ASC, contractor_profiles.id ASC
        LIMIT 1
      ) profile ON TRUE
      WHERE users.id = $1
      `,
      [req.user.id]
    );

    res.json({
      user: result.rows[0],
    });
  } catch {
    logAuthFailure("auth_me", "AUTH_ME_FAILED", req.user.id);
    res.status(500).json({
      error: "Failed to fetch user",
    });
  }
});

app.post("/auth/request-2fa-code", twoFactorRequestRateLimiter, async (req, res) => {
  try {
    const body = getRequestBody(req);
    const email = normalizeIdentity(body.email);
    const priorChallengeId = String(body.challengeId || body.challenge_id || "").trim();

    if (!email || !priorChallengeId) {
      return res.status(400).json({
        success: false,
        code: "CHALLENGE_CONTEXT_REQUIRED",
        message: "Verification challenge and email are required.",
      });
    }

    const priorSession = twoFactorChallengeStore.getActiveSession({
      challengeId: priorChallengeId,
      identity: email,
    });
    if (!priorSession?.passwordVerified) {
      return res.status(202).json({
        success: true,
        code: "TWO_FACTOR_REQUEST_ACCEPTED",
        message: "If verification is available, instructions will be sent.",
      });
    }

    const accountResult = await getPool(req).query(
      "SELECT id, email, token_version FROM users WHERE email = $1",
      [email]
    );
    const account = accountResult.rows[0];

    if (
      !account ||
      Number(account.id) !== Number(priorSession.accountId) ||
      Number(account.token_version || 0) !== Number(priorSession.tokenVersionSnapshot || 0)
    ) {
      twoFactorChallengeStore.remove(priorChallengeId);
      return res.status(202).json({
        success: true,
        code: "TWO_FACTOR_REQUEST_ACCEPTED",
        message: "If verification is available, instructions will be sent.",
      });
    }

    const verification = await initiateSecurityVerification(req, account);
    if (!verification.ok) {
      return res.status(verification.status).json(verification.body);
    }

    res.json({
      success: true,
      code: "VERIFICATION_CODE_SENT",
      challengeId: verification.challengeId,
      maskedEmail: verification.maskedEmail,
      expiresInSeconds: verification.expiresInSeconds,
      message: "Verification code sent.",
    });
  } catch {
    logAuthFailure("two_factor_request", "TWO_FACTOR_REQUEST_FAILED");
    res.status(500).json({
      success: false,
      code: "TWO_FACTOR_REQUEST_FAILED",
      message: "Verification request could not be completed.",
    });
  }
});

async function completeAuthenticationVerification(req, res) {
  try {
    const body = getRequestBody(req);
    const email = normalizeIdentity(body.email);
    const code = String(body.code || "").trim();
    const challengeId = String(body.challengeId || body.challenge_id || "").trim();

    if (!email || !code || !challengeId) {
      return res.status(400).json({
        success: false,
        code: "MISSING_CHALLENGE",
        message: "Verification challenge, email, and code are required.",
      });
    }

    const result = twoFactorChallengeStore.verify({ challengeId, identity: email, code });
    if (result.ok) {
      const temporarySession = result.session;
      if (!temporarySession?.passwordVerified || !temporarySession.accountId) {
        twoFactorChallengeStore.remove(challengeId);
        return res.status(401).json({
          success: false,
          code: "SESSION_INVALID",
          message: "Verification challenge is no longer valid.",
        });
      }

      const accountResult = await getPool(req).query(
        `
        SELECT users.id, users.username, users.email, users.role, users.account_type,
               COALESCE(profile.business_name, users.business_name) AS business_name,
               COALESCE(profile.category, users.business_category) AS business_category,
               users.profile_photo_url, users.token_version,
               profile.id AS contractor_profile_id,
               (profile.id IS NOT NULL) AS has_business_profile
        FROM users
        LEFT JOIN LATERAL (
          SELECT contractor_profiles.id,
                 contractor_profiles.business_name,
                 contractor_profiles.category
          FROM contractor_profiles
          WHERE contractor_profiles.user_id = users.id
          ORDER BY contractor_profiles.created_at ASC, contractor_profiles.id ASC
          LIMIT 1
        ) profile ON TRUE
        WHERE users.id = $1 AND users.email = $2
        `,
        [temporarySession.accountId, temporarySession.email]
      );
      const account = accountResult.rows[0];

      if (
        !account ||
        Number(account.token_version || 0) !== Number(temporarySession.tokenVersionSnapshot || 0)
      ) {
        twoFactorChallengeStore.remove(challengeId);
        return res.status(401).json({
          success: false,
          code: "SESSION_INVALID",
          message: "Verification challenge is no longer valid.",
        });
      }

      const token = createToken(account);
      twoFactorChallengeStore.remove(challengeId);
      return res.json({
        success: true,
        code: "AUTHENTICATION_COMPLETE",
        token,
        user: {
          id: account.id,
          username: account.username,
          email: account.email,
          role: account.role,
          account_type: account.account_type,
          business_name: account.business_name,
          business_category: account.business_category,
          contractor_profile_id: account.contractor_profile_id || null,
          has_business_profile: account.has_business_profile === true,
          profile_photo_url: account.profile_photo_url || "",
        },
      });
    }

    const failureMap = {
      [TWO_FACTOR_FAILURE.MISSING_CHALLENGE]: [400, "MISSING_CHALLENGE", "Verification challenge is invalid."],
      [TWO_FACTOR_FAILURE.CHALLENGE_EXPIRED]: [410, "CODE_EXPIRED", "Verification code expired."],
      [TWO_FACTOR_FAILURE.CHALLENGE_USED]: [401, "SESSION_INVALID", "Verification challenge is no longer valid."],
      [TWO_FACTOR_FAILURE.ACCOUNT_MISMATCH]: [401, "SESSION_INVALID", "Verification challenge is no longer valid."],
      [TWO_FACTOR_FAILURE.INVALID_CODE]: [400, "INVALID_CODE", "Verification code is invalid."],
      [TWO_FACTOR_FAILURE.TOO_MANY_ATTEMPTS]: [429, "TOO_MANY_ATTEMPTS", "Try again later."],
    };
    const [status, failureCode, message] = failureMap[result.code] || [400, "INVALID_CODE", "Verification code is invalid."];

    return res.status(status).json({ success: false, code: failureCode, message });
  } catch {
    logAuthFailure("two_factor_verify", "TWO_FACTOR_VERIFY_FAILED");
    return res.status(500).json({
      success: false,
      code: "TWO_FACTOR_VERIFY_FAILED",
      message: "Verification could not be completed.",
    });
  }
}

app.post("/auth/verify-code", twoFactorVerifyRateLimiter, completeAuthenticationVerification);
app.post("/auth/verify-2fa-code", twoFactorVerifyRateLimiter, completeAuthenticationVerification);

app.post("/auth/password-reset/request", passwordResetRequestRateLimiter, async (req, res) => {
  const result = await getPasswordResetService(req).request(getRequestBody(req).email);
  return res.json(result);
});

app.post("/auth/password-reset/complete", passwordResetCompleteRateLimiter, async (req, res) => {
  const result = await getPasswordResetService(req).complete(getRequestBody(req));
  if (result.ok) return res.status(result.status).json(result.body);
  return res.status(result.status).json({
    success: false,
    code: result.code,
    ...(result.policyCode ? { policyCode: result.policyCode } : {}),
    message: result.code === "PASSWORD_RESET_FAILED"
      ? "Password reset could not be completed."
      : "Password reset request is invalid or expired.",
  });
});

app.get("/auth/security-status", authMiddleware, async (req, res) => {
  res.status(501).json({
    success: false,
    code: "TWO_FACTOR_MANAGEMENT_UNSUPPORTED",
    message: "Two-factor enrollment management is not available.",
  });
});

app.post("/auth/enable-2fa", authMiddleware, async (req, res) => {
  res.status(501).json({
    success: false,
    code: "TWO_FACTOR_MANAGEMENT_UNSUPPORTED",
    message: "Two-factor enrollment management is not available.",
  });
});

app.post("/auth/disable-2fa", authMiddleware, async (req, res) => {
  res.status(501).json({
    success: false,
    code: "TWO_FACTOR_MANAGEMENT_UNSUPPORTED",
    message: "Two-factor enrollment management is not available.",
  });
});

app.post(
  "/auth/change-password",
  authMiddleware,
  passwordChangeRateLimiter,
  async (req, res) => {
    const body = getRequestBody(req);
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");

    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        code: "CURRENT_PASSWORD_REQUIRED",
        message: "Current password is required.",
      });
    }
    if (!newPassword) {
      return res.status(400).json({
        success: false,
        code: "NEW_PASSWORD_REQUIRED",
        message: "New password is required.",
      });
    }

    const passwordPolicy = validatePasswordPolicy(newPassword);
    if (!passwordPolicy.valid) {
      return res.status(400).json({
        success: false,
        code: "PASSWORD_POLICY_FAILED",
        policyCode: passwordPolicy.code,
        message: "Password does not meet requirements.",
      });
    }

    try {
      const requestPool = getPool(req);
      const userResult = await requestPool.query(
        `
        SELECT id, email, role, password_hash, token_version
        FROM users
        WHERE id = $1
        `,
        [req.user.id]
      );
      const user = userResult.rows[0];

      if (!user) {
        return res.status(401).json({
          success: false,
          code: "SESSION_INVALID",
          message: "Session is no longer valid.",
        });
      }

      const currentMatches = await bcrypt.compare(currentPassword, user.password_hash);
      if (!currentMatches) {
        return res.status(401).json({
          success: false,
          code: "CURRENT_PASSWORD_INCORRECT",
          message: "Current password is incorrect.",
        });
      }

      const reusesPassword = await bcrypt.compare(newPassword, user.password_hash);
      if (reusesPassword) {
        return res.status(400).json({
          success: false,
          code: "PASSWORD_REUSE_NOT_ALLOWED",
          message: "New password must be different.",
        });
      }

      const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      const updateResult = await requestPool.query(
        `
        UPDATE users
        SET password_hash = $1,
            token_version = token_version + 1
        WHERE id = $2 AND password_hash = $3
        RETURNING id, email, role, token_version
        `,
        [passwordHash, req.user.id, user.password_hash]
      );
      const updatedUser = updateResult.rows[0];

      if (!updatedUser) {
        return res.status(401).json({
          success: false,
          code: "SESSION_INVALID",
          message: "Session is no longer valid.",
        });
      }

      return res.json({
        success: true,
        code: "PASSWORD_CHANGED",
        message: "Password updated successfully.",
        token: createToken(updatedUser),
      });
    } catch {
      logAuthFailure("password_change", "PASSWORD_CHANGE_FAILED", req.user.id);
      return res.status(500).json({
        success: false,
        code: "PASSWORD_CHANGE_FAILED",
        message: "Password change could not be completed.",
      });
    }
  }
);

app.post("/posts", authMiddleware, async (req, res) => {
  try {
    const { title, description, category, location, image_url } = req.body;

    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "create_post",
      code: "POST_CREATE_FAILED",
      message: "The post could not be created.",
    });
  }
});

app.get("/posts", authMiddleware, async (req, res) => {
  try {
    const query = buildUserPostsQuery(req.user.id);
    const result = await getPool(req).query(query.text, query.values);

    res.json({
      posts: result.rows.map(toSafePostRow),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch posts",
    });
  }
});

app.get("/posts/:id", authMiddleware, async (req, res) => {
  try {
    const query = buildUserPostByIdQuery(req.params.id, req.user.id);
    const result = await getPool(req).query(query.text, query.values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Post not found",
      });
    }

    res.json({
      post: toSafePostRow(result.rows[0]),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch post",
    });
  }
});

app.post("/contractor-profiles", authMiddleware, async (req, res) => {
  try {
    const validation = validateBusinessProfilePayload(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        code: validation.code,
        error: validation.message,
      });
    }

    const database = getPool(req);
    const query = buildCreateBusinessProfileQuery(req.user.id, validation.profile);
    const result = await database.query(query.text, query.values);

    res.json({
      success: true,
      code: "BUSINESS_PROFILE_CREATED",
      message: "Contractor profile created",
      profile: serializeOwnedBusinessProfile(result.rows[0]),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      code: "BUSINESS_PROFILE_CREATE_FAILED",
      error: "Failed to create contractor profile",
    });
  }
});

app.get("/contractor-profiles", async (req, res) => {
  try {
    const result = await getPool(req).query(
      `
      SELECT contractor_profiles.*, users.username
      FROM contractor_profiles
      JOIN users ON contractor_profiles.user_id = users.id
      ORDER BY contractor_profiles.created_at DESC
      `
    );

    res.json({
      profiles: result.rows.map(serializePublicBusinessProfile),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profiles",
    });
  }
});

app.get("/contractor-profiles/:id", async (req, res) => {
  try {
    const result = await getPool(req).query(
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
      profile: serializePublicBusinessProfile(result.rows[0]),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profile",
    });
  }
});

app.get("/my-contractor-profile", authMiddleware, async (req, res) => {
  try {
    const result = await getPool(req).query(
      `
      SELECT *
      FROM contractor_profiles
      WHERE user_id = $1
      ORDER BY created_at ASC, id ASC
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
      profile: serializeOwnedBusinessProfile(result.rows[0]),
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to fetch contractor profile",
    });
  }
});

app.put("/contractor-profiles/:id", authMiddleware, async (req, res) => {
  try {
    const validation = validateBusinessProfilePayload(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        code: validation.code,
        error: validation.message,
      });
    }

    const query = buildUpdateBusinessProfileQuery(
      req.params.id,
      req.user.id,
      validation.profile
    );
    const result = await getPool(req).query(query.text, query.values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Profile not found or not authorized",
      });
    }

    res.json({
      success: true,
      code: "BUSINESS_PROFILE_UPDATED",
      message: "Contractor profile updated",
      profile: serializeOwnedBusinessProfile(result.rows[0]),
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      code: "BUSINESS_PROFILE_UPDATE_FAILED",
      error: "Failed to update contractor profile",
    });
  }
});

app.post("/quote-requests", authMiddleware, async (req, res) => {
  try {
    const { contractor_id, project_title, project_description, location } =
      req.body;

    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "create_quote_request",
      code: "QUOTE_REQUEST_CREATE_FAILED",
      message: "The quote request could not be created.",
    });
  }
});

app.get("/my-quote-requests", authMiddleware, async (req, res) => {
  try {
    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "fetch_homeowner_quote_requests",
      code: "QUOTE_REQUESTS_FETCH_FAILED",
      message: "Quote requests could not be loaded.",
    });
  }
});

app.get("/contractor-quote-requests", authMiddleware, async (req, res) => {
  try {
    const profileResult = await getPool(req).query(
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

    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "fetch_contractor_quote_requests",
      code: "QUOTE_REQUESTS_FETCH_FAILED",
      message: "Quote requests could not be loaded.",
    });
  }
});

app.post("/messages", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
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

    if (!quote_request_id) {
      return res.status(400).json({
        error: "quote_request_id is required",
      });
    }

    const quoteRequest = await findAuthorizedQuoteRequest(
      requestPool,
      quote_request_id,
      req.user.id
    );

    if (!quoteRequest) {
      return res.status(404).json({
        error: "Quote request not found or not authorized",
      });
    }

    if (!receiverBelongsToQuoteRequest(quoteRequest, receiver_id)) {
      return res.status(400).json({
        error: "receiver_id must belong to the quote request participants",
      });
    }

    const result = await requestPool.query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "send_message",
      code: "MESSAGE_SEND_FAILED",
      message: "The message could not be sent.",
    });
  }
});

app.get("/messages/:quoteRequestId", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
    const quoteRequest = await findAuthorizedQuoteRequest(
      requestPool,
      req.params.quoteRequestId,
      req.user.id
    );

    if (!quoteRequest) {
      return res.status(404).json({
        error: "Quote request not found or not authorized",
      });
    }

    const result = await requestPool.query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "fetch_messages",
      code: "MESSAGES_FETCH_FAILED",
      message: "Messages could not be loaded.",
    });
  }
});


// Workflow persistence routes
app.post("/workflow-events", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
    const validation = validateWorkflowEventPayload(req.body);

    if (!validation.valid) {
      return res.status(400).json({
        error: "quote_request_id and workflow_type are required",
      });
    }

    const {
      quoteRequestId,
      workflowType,
      workflowStatus,
      workflowPayload,
      eventLabel,
    } = validation.value;

    const quoteRequest = await findAuthorizedQuoteRequest(
      requestPool,
      quoteRequestId,
      req.user.id
    );

    if (!quoteRequest) {
      return res.status(404).json({
        error: "Quote request not found or not authorized",
      });
    }

    const result = await requestPool.query(
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
        quoteRequestId,
        req.user.id,
        workflowType,
        workflowStatus,
        JSON.stringify(workflowPayload),
        eventLabel,
      ]
    );

    res.json({
      message: "Workflow event saved",
      workflow_event: result.rows[0],
    });
  } catch (err) {
    return sendWorkflowEventDatabaseFailure(res, "save", err);
  }
});

app.get("/workflow-events/:quoteRequestId", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
    const quoteRequest = await findAuthorizedQuoteRequest(
      requestPool,
      req.params.quoteRequestId,
      req.user.id
    );

    if (!quoteRequest) {
      return res.status(404).json({
        error: "Quote request not found or not authorized",
      });
    }

    const result = await requestPool.query(
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
    return sendWorkflowEventDatabaseFailure(res, "fetch", err);
  }
});

app.post("/reviews", authMiddleware, async (req, res) => {
  try {
    const { contractor_id, rating, review_text } = req.body;

    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "create_review",
      code: "REVIEW_CREATE_FAILED",
      message: "The review could not be created.",
    });
  }
});

app.get("/reviews/:contractorId", async (req, res) => {
  try {
    const contractorId = req.params.contractorId;

    const reviewsResult = await getPool(req).query(
      `
      SELECT reviews.*, users.email AS reviewer_email
      FROM reviews
      JOIN users ON reviews.reviewer_id = users.id
      WHERE contractor_id = $1
      ORDER BY created_at DESC
      `,
      [contractorId]
    );

    const ratingResult = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "fetch_reviews",
      code: "REVIEWS_FETCH_FAILED",
      message: "Reviews could not be loaded.",
    });
  }
});

app.post("/contractor-projects", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
    const { contractor_id, title, description, image_url, image_urls } = req.body;

    if (!contractor_id) {
      return res.status(400).json({
        error: "contractor_id is required",
      });
    }

    const imageUrls = Array.isArray(image_urls)
      ? image_urls
      : image_url
      ? [image_url]
      : [];

    const query = buildOwnedContractorProjectCreateQuery({
      contractorId: contractor_id,
      ownerUserId: req.user.id,
      title,
      description,
      imageUrl: imageUrls[0] || image_url || "",
      imageUrls,
    });

    const result = await requestPool.query(query.text, query.values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Contractor profile not found or not authorized",
      });
    }

    res.json({
      message: "Project uploaded",
      project: result.rows[0],
    });
  } catch (err) {
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "create_contractor_project",
      code: "CONTRACTOR_PROJECT_CREATE_FAILED",
      message: "The project could not be uploaded.",
    });
  }
});

app.put("/contractor-projects/:id", authMiddleware, async (req, res) => {
  try {
    const requestPool = getPool(req);
    const projectId = req.params.id;
    const { title, description, image_url, image_urls } = req.body;

    const imageUrls = Array.isArray(image_urls)
      ? image_urls
      : image_url
      ? [image_url]
      : [];

    const query = buildOwnedContractorProjectUpdateQuery({
      projectId,
      ownerUserId: req.user.id,
      title,
      description,
      imageUrl: imageUrls[0] || image_url || "",
      imageUrls,
    });

    const result = await requestPool.query(query.text, query.values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "Project not found or not authorized",
      });
    }

    res.json({
      message: "Project updated",
      project: result.rows[0],
    });
  } catch (err) {
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "update_contractor_project",
      code: "CONTRACTOR_PROJECT_UPDATE_FAILED",
      message: "The project could not be updated.",
    });
  }
});

app.get("/contractor-projects/:contractorId", async (req, res) => {
  try {
    const contractorId = req.params.contractorId;

    const result = await getPool(req).query(
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
    return sendPublicDatabaseError({
      res,
      error: err,
      operation: "fetch_contractor_projects",
      code: "CONTRACTOR_PROJECTS_FETCH_FAILED",
      message: "Projects could not be loaded.",
    });
  }
});

app.use((err, req, res, next) => {
  if (err?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  logSafeServerError(console.error, {
    event: "Unhandled server error",
    operation: "request_handler",
    code: "INTERNAL_ERROR",
  }, err);
  return res.status(500).json({
    error: "INTERNAL_ERROR",
    message: "The request could not be completed.",
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = {
  app,
  authRateLimiters: {
    loginRateLimiter,
    passwordChangeRateLimiter,
    passwordResetCompleteRateLimiter,
    passwordResetRequestRateLimiter,
    twoFactorRequestRateLimiter,
    twoFactorVerifyRateLimiter,
  },
  authMiddleware,
  buildHealthMetadata,
  buildOwnedContractorProjectCreateQuery,
  buildOwnedContractorProjectUpdateQuery,
  buildQuoteRequestParticipantQuery,
  buildUserPostByIdQuery,
  buildUserPostsQuery,
  createCorsOptions,
  createToken,
  completeAuthenticationVerification,
  findAuthorizedQuoteRequest,
  getApprovedCorsOrigins,
  initiateSecurityVerification,
  getQuoteParticipantUserIds,
  jsonSyntaxErrorHandler,
  maskEmail,
  receiverBelongsToQuoteRequest,
  toSafePostRow,
  twoFactorChallengeStore,
  validateWorkflowEventPayload,
  validateLoginRequestBody,
  validateProfileUpdateRequestBody,
};

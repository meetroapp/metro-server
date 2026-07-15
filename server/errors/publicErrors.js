"use strict";

const DATABASE_UNAVAILABLE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

function isProductionRuntime(env = process.env) {
  return [
    env.NODE_ENV,
    env.RAILWAY_ENVIRONMENT,
    env.RAILWAY_ENVIRONMENT_NAME,
  ].some((value) => String(value || "").trim().toLowerCase() === "production");
}

function isSafeDatabaseCode(value) {
  return typeof value === "string" && /^[A-Z0-9]{5}$/.test(value);
}

function classifyPublicDatabaseError(error, fallback) {
  if (error?.code === "23505") {
    return {
      status: 409,
      code: "CONFLICT",
      message: "That value is already in use.",
    };
  }

  if (DATABASE_UNAVAILABLE_CODES.has(error?.code)) {
    return {
      status: 503,
      code: "DATABASE_UNAVAILABLE",
      message: "The service is temporarily unavailable.",
    };
  }

  return {
    status: fallback.status || 500,
    code: fallback.code || "INTERNAL_ERROR",
    message: fallback.message || "The request could not be completed.",
  };
}

function logSafeServerError(logger, context, error) {
  const entry = {
    operation: context.operation,
    code: context.code,
  };

  if (isSafeDatabaseCode(error?.code)) {
    entry.databaseCode = error.code;
  }

  logger(context.event || "Server operation failed", entry);
}

function sendPublicDatabaseError({ res, error, operation, code, message, status = 500, logger = console.error }) {
  const publicError = classifyPublicDatabaseError(error, { code, message, status });
  logSafeServerError(logger, {
    event: "Database operation failed",
    operation,
    code: publicError.code,
  }, error);

  return res.status(publicError.status).json({
    error: publicError.code,
    message: publicError.message,
  });
}

module.exports = {
  classifyPublicDatabaseError,
  isProductionRuntime,
  logSafeServerError,
  sendPublicDatabaseError,
};

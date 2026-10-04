"use strict";

const http = require("node:http");

const BRIDGE_VERSION = "maintenance-bridge-v1";
const DEFAULT_PORT = 8080;
const RETRY_AFTER_SECONDS = 120;

function safeIdentity(value, pattern) {
  const normalized = String(value || "").trim().toLowerCase();
  return pattern.test(normalized) ? normalized : null;
}

function jsonResponse(response, statusCode, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": payload.length,
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

function createRequestHandler({ env = process.env } = {}) {
  const sourceRevision = safeIdentity(env.BRIDGE_SOURCE_SHA, /^[0-9a-f]{40}$/);
  const imageDigest = safeIdentity(env.BRIDGE_IMAGE_DIGEST, /^sha256:[0-9a-f]{64}$/);

  return function maintenanceBridgeHandler(request, response) {
    const exactHealthRequest = request.method === "GET" && request.url === "/health";
    if (exactHealthRequest) {
      const identity = {};
      if (sourceRevision) identity.sourceRevision = sourceRevision;
      if (imageDigest) identity.imageDigest = imageDigest;
      return jsonResponse(response, 200, {
        status: "maintenance",
        trafficMode: "blocked",
        bridgeVersion: BRIDGE_VERSION,
        ...identity,
      });
    }

    request.resume();
    return jsonResponse(response, 503, {
      status: "maintenance",
      trafficMode: "blocked",
      bridgeVersion: BRIDGE_VERSION,
      message: "Meetro is temporarily unavailable while maintenance is completed.",
    }, {
      "Retry-After": String(RETRY_AFTER_SECONDS),
    });
  };
}

function resolvePort(value) {
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function startBridge({ env = process.env, logger = console } = {}) {
  const server = http.createServer(createRequestHandler({ env }));
  server.listen(resolvePort(env.PORT), () => {
    logger.info(JSON.stringify({
      event: "maintenance_bridge_started",
      bridgeVersion: BRIDGE_VERSION,
      trafficMode: "blocked",
    }));
  });
  return server;
}

if (require.main === module) startBridge();

module.exports = Object.freeze({
  BRIDGE_VERSION,
  RETRY_AFTER_SECONDS,
  createRequestHandler,
  resolvePort,
  startBridge,
});

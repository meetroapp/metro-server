"use strict";

const {
  resolveRequestServiceAuthority,
} = require("../requests/requestServiceAuthority");

async function resolveIntelligenceAuthority({
  authority,
  pool,
  actorUserId,
} = {}) {
  if (authority !== "request_service") {
    return Object.freeze({
      authorized: false,
      authority: null,
      accountType: null,
    });
  }

  return resolveRequestServiceAuthority({
    pool,
    actorUserId,
  });
}

module.exports = {
  resolveIntelligenceAuthority,
};

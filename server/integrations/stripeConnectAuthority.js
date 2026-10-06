"use strict";
const { getConnectedServicesBusinessAuthority } = require("./connectedServicesBusinessAuthority");
const failure = (status, code) => ({ ok: false, status, code });

// Deliberately compose the read resolver before checking OWNER. Do not select
// an Owner Business early and bypass Owner-A/Manager-B ambiguity.
async function requireOwner({ pool, authenticatedActor, command = {} } = {}) {
  const authority = await getConnectedServicesBusinessAuthority({ pool, authenticatedActor });
  if (!authority.ok) return authority;
  if (authority.business.role !== "OWNER") return failure(403, "STRIPE_CONNECT_OWNER_REQUIRED");
  if (!command || typeof command !== "object" || Array.isArray(command) ||
      Object.keys(command).some(key => !["intent", "country"].includes(key)) ||
      !["CONNECT", "CONTINUE", "REFRESH"].includes(command.intent) ||
      (command.country !== undefined && (command.intent !== "CONNECT" ||
        typeof command.country !== "string" || !/^[a-z]{2}$/.test(command.country)))) {
    return failure(400, "STRIPE_CONNECT_INVALID_COMMAND");
  }
  return { ...authority, actorUserId: Number(authenticatedActor.id) };
}
module.exports = { requireOwner, failure };

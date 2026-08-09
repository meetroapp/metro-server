"use strict";

const LEGACY_LIFECYCLE_CONTRACT_VERSION = 1;
const CURRENT_LIFECYCLE_CONTRACT_VERSION = 2;
const LIFECYCLE_V2_READINESS_CONTRACT = "MC-JOB-LIFECYCLE-004B";

function resolveLifecycleContractVersion(env = process.env) {
  const enabled = String(env.JOB_LIFECYCLE_V2_ENABLED || "")
    .trim()
    .toLowerCase();
  const readiness = String(env.JOB_LIFECYCLE_V2_READINESS || "").trim();

  if (!enabled || enabled === "false") {
    return {
      ok: true,
      version: LEGACY_LIFECYCLE_CONTRACT_VERSION,
      activated: false,
    };
  }

  if (
    enabled !== "true" ||
    readiness !== LIFECYCLE_V2_READINESS_CONTRACT
  ) {
    return {
      ok: false,
      status: 503,
      code: "LIFECYCLE_V2_ACTIVATION_REJECTED",
      message: "The current lifecycle contract is not ready for activation.",
    };
  }

  return {
    ok: true,
    version: CURRENT_LIFECYCLE_CONTRACT_VERSION,
    activated: true,
  };
}

module.exports = {
  CURRENT_LIFECYCLE_CONTRACT_VERSION,
  LEGACY_LIFECYCLE_CONTRACT_VERSION,
  LIFECYCLE_V2_READINESS_CONTRACT,
  resolveLifecycleContractVersion,
};

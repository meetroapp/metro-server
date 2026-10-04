"use strict";

// Only canonical jobs.source_type establishes the source. In particular,
// requestId = null is also valid for business-owned Jobs.
function jobSourcePresentation(row = {}) {
  if (!row.source_type) return {};
  return {
    sourceType: row.source_type,
    ...(row.source_type === "emergency_request" ? { sourceLabel: "Emergency" } : {}),
  };
}

module.exports = { jobSourcePresentation };

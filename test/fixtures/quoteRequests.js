"use strict";

function buildQuoteRequest(overrides = {}) {
  return {
    id: 3001,
    contractor_id: 4001,
    homeowner_id: 1001,
    project_title: "Synthetic quote request",
    project_description: "Test-only quote request description.",
    location: "Test City",
    created_at: "2026-01-03T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildQuoteRequest };

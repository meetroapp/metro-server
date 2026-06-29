"use strict";

function buildReview(overrides = {}) {
  return {
    id: 7001,
    contractor_id: 4001,
    reviewer_id: 1001,
    rating: 5,
    review_text: "Synthetic review for characterization only.",
    created_at: "2026-01-07T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildReview };

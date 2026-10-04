"use strict";

function serializePublicReview(row = {}) {
  return {
    id: row.id,
    contractor_id: row.contractor_id,
    rating: row.rating,
    review_text: row.review_text,
    created_at: row.created_at,
  };
}

module.exports = {
  serializePublicReview,
};

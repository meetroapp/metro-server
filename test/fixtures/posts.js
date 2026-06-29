"use strict";

function buildPost(overrides = {}) {
  return {
    id: 2001,
    user_id: 1001,
    title: "Synthetic repair request",
    description: "Test-only description with no customer content.",
    category: "contractor",
    location: "Test City",
    mage_url: "https://assets.example.test/legacy-image.jpg",
    image_url: "https://assets.example.test/image.jpg",
    created_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildPost };

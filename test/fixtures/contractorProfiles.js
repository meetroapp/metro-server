"use strict";

function buildContractorProfile(overrides = {}) {
  return {
    id: 4001,
    user_id: 1002,
    business_name: "Example Test Services",
    category: "contractor",
    phone: "+1-202-555-0100",
    location: "Test City",
    bio: "Synthetic contractor profile.",
    image_url: "https://assets.example.test/profile.jpg",
    created_at: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildContractorProfile };

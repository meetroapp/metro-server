"use strict";

function buildUser(overrides = {}) {
  return {
    id: 1001,
    username: "Test Homeowner",
    email: "homeowner@example.test",
    password_hash: "TEST_ONLY_HASH_NOT_AUTHENTIC",
    role: "homeowner",
    account_type: "homeowner",
    business_name: "",
    business_category: "",
    profile_photo_url: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildUser };

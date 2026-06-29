"use strict";

function buildContractorProject(overrides = {}) {
  return {
    id: 6001,
    contractor_id: 4001,
    title: "Synthetic portfolio project",
    description: "Test-only portfolio presentation record.",
    image_url: "https://assets.example.test/project-cover.jpg",
    image_urls: ["https://assets.example.test/project-cover.jpg"],
    created_at: "2026-01-06T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildContractorProject };

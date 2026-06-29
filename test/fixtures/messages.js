"use strict";

function buildMessage(overrides = {}) {
  return {
    id: 5001,
    quote_request_id: 3001,
    sender_id: 1001,
    receiver_id: 1002,
    message_text: "Synthetic message content.",
    image_url: null,
    message_type: "workflow",
    workflow_type: "quote",
    workflow_status: "sent",
    workflow_payload: {
      fixture: true,
    },
    created_at: "2026-01-04T00:00:00.000Z",
    ...overrides,
  };
}

module.exports = { buildMessage };

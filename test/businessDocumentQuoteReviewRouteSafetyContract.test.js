"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sendQuoteDraftResult,
} = require("../server/authorization/quoteDrafts");

function response() {
  return {
    statusCode: null,
    payload: null,

    status(value) {
      this.statusCode = value;
      return this;
    },

    json(value) {
      this.payload = value;
      return value;
    },
  };
}

test(
  "successful Quote review preserves bounded top-level quoteSafety",
  () => {
    const res = response();

    const quoteSafety = {
      ready: true,
      blockingErrors: [],
      warnings: [],
    };

    sendQuoteDraftResult(res, {
      ok: true,
      success: true,
      status: 200,
      code: "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED",
      review: {
        documentId:
          "efaa43c3-d604-4797-8f41-e4f7f61e136b",
        documentVersion: 1,
        jobId:
          "6f40641c-2f06-4971-aeaa-65598ba777b1",
        requestId: null,
        relationshipId: 362,
        customerName: "Liam Molina",
        projectTitle:
          "Emergency Plumbing: Outside main waterline is leaking water",
      },
      quoteSafety,
    });

    assert.equal(res.statusCode, 200);

    assert.deepEqual(res.payload, {
      success: true,
      code: "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED",
      review: {
        documentId:
          "efaa43c3-d604-4797-8f41-e4f7f61e136b",
        documentVersion: 1,
        jobId:
          "6f40641c-2f06-4971-aeaa-65598ba777b1",
        requestId: null,
        relationshipId: 362,
        customerName: "Liam Molina",
        projectTitle:
          "Emergency Plumbing: Outside main waterline is leaking water",
      },
      quoteSafety,
    });
  }
);

test(
  "route serializer still excludes arbitrary internal result fields",
  () => {
    const res = response();

    sendQuoteDraftResult(res, {
      ok: true,
      status: 200,
      code: "BUSINESS_DOCUMENT_QUOTE_REVIEW_LOADED",
      review: {
        documentId:
          "efaa43c3-d604-4797-8f41-e4f7f61e136b",
      },
      quoteSafety: {
        ready: true,
        blockingErrors: [],
        warnings: [],
      },
      privateInternalAuthority: {
        shouldNeverReachClient: true,
      },
    });

    assert.equal(
      Object.prototype.hasOwnProperty.call(
        res.payload,
        "privateInternalAuthority"
      ),
      false
    );

    assert.deepEqual(res.payload.quoteSafety, {
      ready: true,
      blockingErrors: [],
      warnings: [],
    });
  }
);

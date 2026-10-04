"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");

const {
  establishExistingCustomerRequestConversation,
  normalizeExistingCustomerRequestSourcePost,
} = require(
  "../server/relationships/existingCustomerRequestConversationService"
);

const RELATIONSHIP_ID =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function sourcePost(overrides = {}) {
  return {
    id: 41,
    user_id: 7,
    request_origin:
      "existing_customer_request",
    target_contractor_profile_id: 80,
    target_professional_user_id: 9,
    source_meetro_relationship_id:
      RELATIONSHIP_ID,
    ...overrides,
  };
}

function fakeClient({
  existingRelationship = null,
} = {}) {
  const calls = [];
  let nextRelationshipId = 501;

  return {
    calls,

    async query(sql, values = []) {
      const normalized = String(sql)
        .replace(/\s+/g, " ")
        .trim();

      calls.push({
        sql: normalized,
        values,
      });

      if (
        normalized.includes(
          "existing_customer_request:create_relationship"
        )
      ) {
        if (existingRelationship) {
          return {
            rows: [
              {
                ...existingRelationship,
                created: false,
              },
            ],
          };
        }

        return {
          rows: [
            {
              id: nextRelationshipId++,
              post_id: values[0],
              homeowner_id: values[1],
              contractor_id: values[2],
              professional_user_id: values[3],
              status: "active",
              professional_response_id: null,
              ordinary_authority_source:
                "existing_customer_request",
              current_version: 1,
              closure_reason: null,
              source_meetro_relationship_id:
                values[4],
              created: true,
            },
          ],
        };
      }

      throw new Error(
        `Unexpected SQL: ${normalized}`
      );
    },
  };
}

test("normalizes only an exact existing-customer source post", () => {
  assert.deepEqual(
    normalizeExistingCustomerRequestSourcePost(
      sourcePost()
    ),
    {
      id: 41,
      homeownerUserId: 7,
      contractorProfileId: 80,
      professionalUserId: 9,
      meetroRelationshipId:
        RELATIONSHIP_ID,
    }
  );

  assert.equal(
    normalizeExistingCustomerRequestSourcePost(
      sourcePost({
        request_origin: "marketplace",
      })
    ),
    null
  );

  assert.equal(
    normalizeExistingCustomerRequestSourcePost(
      sourcePost({
        target_professional_user_id: 7,
      })
    ),
    null
  );
});

test("creates an active direct Request Relationship and canonical Conversation without a selection", async () => {
  const client = fakeClient();

  const result =
    await establishExistingCustomerRequestConversation({
      client,
      post: sourcePost(),

      ensureConversationImpl: async ({
        relationshipId,
      }) => ({
        ok: true,
        created: true,
        conversation: {
          id: 801,
          relationship_id: relationshipId,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          request_selection_id: null,
          status: "active",
        },
      }),
    });

  assert.equal(
    result.relationship.status,
    "active"
  );

  assert.equal(
    result.relationship
      .ordinary_authority_source,
    "existing_customer_request"
  );

  assert.equal(
    result.relationship.professional_response_id,
    null
  );

  assert.equal(
    result.relationship
      .source_meetro_relationship_id,
    RELATIONSHIP_ID
  );

  assert.equal(
    result.conversation.request_selection_id,
    null
  );

  assert.equal(
    result.conversation.status,
    "active"
  );

  assert.equal(
    result.relationshipCreated,
    true
  );

  assert.equal(
    result.conversationCreated,
    true
  );
});

test("exact relationship and conversation are replay-safe", async () => {
  const client = fakeClient({
    existingRelationship: {
      id: 501,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      professional_response_id: null,
      ordinary_authority_source:
        "existing_customer_request",
      current_version: 1,
      closure_reason: null,
      source_meetro_relationship_id:
        RELATIONSHIP_ID,
    },
  });

  const result =
    await establishExistingCustomerRequestConversation({
      client,
      post: sourcePost(),

      ensureConversationImpl: async ({
        relationshipId,
      }) => ({
        ok: true,
        created: false,
        conversation: {
          id: 801,
          relationship_id: relationshipId,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          request_selection_id: null,
          status: "active",
        },
      }),
    });

  assert.equal(
    result.relationship.id,
    501
  );
  assert.equal(
    result.relationshipCreated,
    false
  );
  assert.equal(
    result.conversationCreated,
    false
  );
});

test("fails closed if an existing relationship has different authority", async () => {
  const client = fakeClient({
    existingRelationship: {
      id: 501,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "pending",
      professional_response_id: 901,
      ordinary_authority_source:
        "professional_response",
      current_version: 1,
      source_meetro_relationship_id:
        null,
    },
  });

  await assert.rejects(
    establishExistingCustomerRequestConversation({
      client,
      post: sourcePost(),
      ensureConversationImpl: async () => {
        throw new Error(
          "Conversation should not be attempted."
        );
      },
    }),
    /could not be created or resolved|identity is invalid/
  );
});

test("fails closed if Conversation contains a fabricated Request Selection", async () => {
  const client = fakeClient();

  await assert.rejects(
    establishExistingCustomerRequestConversation({
      client,
      post: sourcePost(),

      ensureConversationImpl: async ({
        relationshipId,
      }) => ({
        ok: true,
        created: true,
        conversation: {
          id: 801,
          relationship_id: relationshipId,
          homeowner_id: 7,
          contractor_id: 80,
          professional_user_id: 9,
          request_selection_id: 701,
          status: "active",
        },
      }),
    }),
    /Conversation identity is invalid/
  );
});

test("service creates no Professional Response Request Selection or Job", () => {
  const source = readFileSync(
    "server/relationships/existingCustomerRequestConversationService.js",
    "utf8"
  );

  assert.match(
    source,
    /INSERT INTO request_relationships/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO professional_responses/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO request_selections/
  );

  assert.doesNotMatch(
    source,
    /INSERT INTO jobs/
  );
});

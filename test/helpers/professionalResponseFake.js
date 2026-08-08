"use strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tagFor(sql) {
  return String(sql).match(/professional_response:([a-z_]+)/)?.[1] || "";
}

function canonicalRow(state, response) {
  const relationship = state.relationships.find(
    (row) => Number(row.id) === Number(response.request_relationship_id)
  );
  const profile = state.profiles.find(
    (row) => Number(row.id) === Number(response.contractor_id)
  ) || {};
  if (!relationship) return null;

  return {
    response_id: response.id,
    post_id: response.post_id,
    response_post_id: response.post_id,
    homeowner_id: response.homeowner_id,
    response_homeowner_id: response.homeowner_id,
    response_contractor_id: response.contractor_id,
    response_professional_user_id: response.professional_user_id,
    response_status: response.status,
    response_current_version: response.current_version,
    response_introduction_text: response.introduction_text,
    response_submitted_at: response.submitted_at,
    response_updated_at: response.updated_at,
    relationship_id: relationship.id,
    relationship_response_id: relationship.professional_response_id,
    relationship_post_id: relationship.post_id,
    relationship_emergency_request_id: relationship.emergency_request_id,
    relationship_homeowner_id: relationship.homeowner_id,
    relationship_contractor_id: relationship.contractor_id,
    relationship_professional_user_id: relationship.professional_user_id,
    relationship_status: relationship.status,
    ordinary_authority_source: relationship.ordinary_authority_source,
    relationship_current_version: relationship.current_version,
    relationship_created_at: relationship.created_at,
    business_name: profile.business_name,
    professional_category: profile.category,
    business_image_url: profile.image_url,
  };
}

function createProfessionalResponseFake({
  profiles,
  request,
  relationships = [],
  responses = [],
  versions = [],
  evidence = [],
  idempotency = [],
  conversations = [],
  failAt = "",
} = {}) {
  const state = {
    profiles: clone(profiles || [{
      id: 80,
      user_id: 9,
      business_name: "Trusted Repairs",
      category: "handyman",
      image_url: "https://example.test/business.jpg",
      profile_details: {
        service_area: "Cape Coral",
        service_specialties: ["drywall_repair"],
      },
    }]),
    requests: clone([request || {
      id: 41,
      user_id: 7,
      title: "Drywall Repair",
      description: "Repair damaged drywall",
      category: "drywall",
      request_category: "drywall",
      service_domain: "home_services",
      service_specialty: "drywall_repair",
      location: "123 Synthetic Repair Ave, Cape Coral, FL 33990",
      location_intake_mode: "exact_on_file",
      location_normalization_status: "normalized",
      service_address_line1: "123 Synthetic Repair Ave",
      service_city: "Cape Coral",
      service_region: "FL",
      service_postal_code: "33990",
      service_country_code: "US",
      discovery_area_label: "Cape Coral, FL",
      unit_number: null,
      access_notes: "",
      status: "open",
      created_at: "2026-08-06T10:00:00.000Z",
      updated_at: "2026-08-06T10:00:00.000Z",
      image_url: null,
      request_photos: [],
    }]),
    relationships: clone(relationships),
    responses: clone(responses),
    versions: clone(versions),
    evidence: clone(evidence),
    idempotency: clone(idempotency),
    conversations: clone(conversations),
    selections: [],
    participants: [],
    messages: [],
    workflowEvents: [],
  };
  const calls = [];
  let responseSequence = 900;
  let relationshipSequence = 500;
  let lockTail = Promise.resolve();

  function makeClient() {
    let tx = null;
    let releaseRequestLock = null;
    let released = false;

    const unlock = () => {
      if (releaseRequestLock) releaseRequestLock();
      releaseRequestLock = null;
    };

    const client = {
      async query(text, values = []) {
        const sql = String(text).replace(/\s+/g, " ").trim();
        const tag = tagFor(sql);
        calls.push({ sql, values: clone(values), tag });

        if (sql === "BEGIN") {
          tx = clone(state);
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          tx = null;
          unlock();
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          if (failAt === "commit") {
            throw new Error("Injected commit failure");
          }
          Object.assign(state, clone(tx));
          tx = null;
          unlock();
          return { rows: [] };
        }
        if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
          if (failAt === "deferred_validation") {
            throw new Error("Injected deferred validation failure");
          }
          return { rows: [] };
        }

        const current = tx || state;
        if (failAt && tag === failAt) {
          throw new Error(`Injected ${tag} failure`);
        }

        if (
          sql.includes("SELECT id, email, role, token_version") &&
          sql.includes("FROM users")
        ) {
          return {
            rows: [{
              id: values[0],
              email: `user${values[0]}@example.test`,
              role: "user",
              token_version: 0,
            }],
          };
        }

        if (tag === "owned_profiles") {
          return {
            rows: current.profiles
              .filter((row) => Number(row.user_id) === Number(values[0]))
              .sort((left, right) => Number(left.id) - Number(right.id))
              .slice(0, 2)
              .map(clone),
          };
        }

        if (tag === "request_lock") {
          const previous = lockTail;
          lockTail = new Promise((resolve) => {
            releaseRequestLock = resolve;
          });
          await previous;
          tx = clone(state);
          return {
            rows: tx.requests
              .filter((row) => Number(row.id) === Number(values[0]))
              .slice(0, 1)
              .map(clone),
          };
        }

        if (tag === "idempotency_reserve") {
          const [id, actorUserId, contractorId, postId, commandName,
            commandScope, key, fingerprint] = values;
          const exists = current.idempotency.some(
            (row) =>
              Number(row.actor_user_id) === Number(actorUserId) &&
              row.command_name === commandName &&
              row.command_scope === commandScope &&
              row.idempotency_key === key
          );
          if (exists) return { rows: [] };
          const row = {
            id,
            actor_user_id: actorUserId,
            contractor_id: contractorId,
            post_id: postId,
            command_name: commandName,
            command_scope: commandScope,
            idempotency_key: key,
            request_fingerprint: fingerprint,
            professional_response_id: null,
            request_relationship_id: null,
            result_classification: null,
            result_reference: null,
            completed_at: null,
          };
          current.idempotency.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "idempotency_existing") {
          const [actorUserId, commandName, commandScope, key] = values;
          return {
            rows: current.idempotency
              .filter((row) =>
                Number(row.actor_user_id) === Number(actorUserId) &&
                row.command_name === commandName &&
                row.command_scope === commandScope &&
                row.idempotency_key === key
              )
              .slice(0, 1)
              .map(clone),
          };
        }

        if (tag === "canonical_pair_by_business") {
          const [postId, contractorId, professionalUserId] = values;
          return {
            rows: current.responses
              .filter((row) =>
                Number(row.post_id) === Number(postId) &&
                Number(row.contractor_id) === Number(contractorId) &&
                Number(row.professional_user_id) ===
                  Number(professionalUserId)
              )
              .map((row) => canonicalRow(current, row))
              .filter(Boolean)
              .slice(0, 2)
              .map(clone),
          };
        }

        if (tag === "canonical_pair_by_result") {
          const [responseId, relationshipId, postId, contractorId,
            professionalUserId] = values;
          const response = current.responses.find(
            (row) =>
              String(row.id) === String(responseId) &&
              Number(row.request_relationship_id) ===
                Number(relationshipId) &&
              Number(row.post_id) === Number(postId) &&
              Number(row.contractor_id) === Number(contractorId) &&
              Number(row.professional_user_id) ===
                Number(professionalUserId)
          );
          const row = response ? canonicalRow(current, response) : null;
          return { rows: row ? [clone(row)] : [] };
        }

        if (tag === "legacy_relationships") {
          return {
            rows: current.relationships
              .filter((row) =>
                Number(row.post_id) === Number(values[0]) &&
                row.emergency_request_id == null
              )
              .sort((left, right) => Number(left.id) - Number(right.id))
              .map((row) => {
                const response = current.responses.find(
                  (item) => String(item.id) === String(row.professional_response_id)
                );
                return {
                  ...clone(row),
                  linked_response_status: response?.status || null,
                  conversation_exists: current.conversations.some(
                    (conversation) =>
                      Number(conversation.relationship_id) === Number(row.id)
                  ),
                };
              }),
          };
        }

        if (tag === "reserve_identities") {
          responseSequence += 1;
          relationshipSequence += 1;
          return {
            rows: [{
              professional_response_id: String(responseSequence),
              request_relationship_id: relationshipSequence,
            }],
          };
        }

        if (tag === "insert_response") {
          const [id, postId, relationshipId, homeownerId, contractorId,
            professionalUserId, introductionText] = values;
          const row = {
            id: String(id),
            post_id: postId,
            request_relationship_id: relationshipId,
            homeowner_id: homeownerId,
            contractor_id: contractorId,
            professional_user_id: professionalUserId,
            status: "submitted",
            introduction_text: introductionText,
            origin: "canonical_command",
            current_version: 1,
            submitted_at: "2026-08-06T12:00:00.000Z",
            updated_at: "2026-08-06T12:00:00.000Z",
          };
          current.responses.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "insert_relationship") {
          const [id, postId, homeownerId, contractorId, professionalUserId,
            responseId] = values;
          const row = {
            id,
            post_id: postId,
            emergency_request_id: null,
            homeowner_id: homeownerId,
            contractor_id: contractorId,
            professional_user_id: professionalUserId,
            status: "pending",
            introduction_text: "",
            professional_response_id: String(responseId),
            ordinary_authority_source: "professional_response",
            current_version: 1,
            created_at: "2026-08-06T12:00:00.000Z",
          };
          current.relationships.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "insert_version") {
          current.versions.push({
            professional_response_id: String(values[0]),
            version: 1,
            previous_version: null,
            status: "submitted",
            introduction_text: values[1],
            content_fingerprint: values[2],
            actor_user_id: values[3],
          });
          return { rows: [] };
        }

        if (tag === "insert_evidence") {
          current.evidence.push({
            professional_response_id: String(values[0]),
            request_relationship_id: values[1],
            post_id: values[2],
            contractor_id: values[3],
            actor_user_id: values[4],
            idempotency_id: values[5],
            safe_payload: JSON.parse(values[6]),
            implementation_milestone_id: values[7],
            event_type: "professional_response_submitted",
          });
          return { rows: [] };
        }

        if (tag === "idempotency_complete") {
          const row = current.idempotency.find(
            (item) => item.id === values[0] && item.completed_at == null
          );
          if (!row) return { rows: [] };
          row.professional_response_id = String(values[1]);
          row.request_relationship_id = values[2];
          row.result_classification = values[3];
          row.result_reference = JSON.parse(values[4]);
          row.completed_at = "2026-08-06T12:00:00.000Z";
          return { rows: [clone(row)] };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },

      release() {
        released = true;
        unlock();
      },
    };

    return { client, wasReleased: () => released };
  }

  return {
    calls,
    state,
    pool: {
      async connect() {
        return makeClient().client;
      },
      async query(text, values = []) {
        const client = makeClient().client;
        return client.query(text, values);
      },
    },
  };
}

module.exports = {
  createProfessionalResponseFake,
};

"use strict";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tagFor(sql) {
  return String(sql).match(/request_selection:([a-z_]+)/)?.[1] || "";
}

function createRequestSelectionFake({
  request,
  profiles,
  responses,
  relationships,
  selections = [],
  conversations = [],
  idempotency = [],
} = {}) {
  const state = {
    requests: clone([request || {
      id: 41,
      user_id: 7,
      title: "Drywall Repair",
      status: "open",
      location: "Cape Coral, FL 33990",
      unit_number: "2A",
    }]),
    profiles: clone(profiles || [
      {
        id: 80,
        user_id: 9,
        business_name: "Trusted Repairs",
        category: "handyman",
        image_url: "https://example.test/trusted.jpg",
      },
      {
        id: 81,
        user_id: 10,
        business_name: "Second Repairs",
        category: "handyman",
        image_url: "https://example.test/second.jpg",
      },
    ]),
    responses: clone(responses || [
      {
        id: "901",
        post_id: 41,
        request_relationship_id: 501,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "submitted",
        introduction_text: "I can help with this repair.",
        current_version: 1,
        submitted_at: "2026-08-06T12:00:00.000Z",
        selected_at: null,
        terminal_at: null,
        content_fingerprint: "a".repeat(64),
      },
      {
        id: "902",
        post_id: 41,
        request_relationship_id: 502,
        homeowner_id: 7,
        contractor_id: 81,
        professional_user_id: 10,
        status: "submitted",
        introduction_text: "I am also available.",
        current_version: 1,
        submitted_at: "2026-08-06T12:05:00.000Z",
        selected_at: null,
        terminal_at: null,
        content_fingerprint: "b".repeat(64),
      },
    ]),
    relationships: clone(relationships || [
      {
        id: 501,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 80,
        professional_user_id: 9,
        status: "pending",
        professional_response_id: "901",
        ordinary_authority_source: "professional_response",
        current_version: 1,
        accepted_at: null,
        closed_at: null,
        closure_reason: null,
      },
      {
        id: 502,
        post_id: 41,
        emergency_request_id: null,
        homeowner_id: 7,
        contractor_id: 81,
        professional_user_id: 10,
        status: "pending",
        professional_response_id: "902",
        ordinary_authority_source: "professional_response",
        current_version: 1,
        accepted_at: null,
        closed_at: null,
        closure_reason: null,
      },
    ]),
    selections: clone(selections),
    conversations: clone(conversations),
    idempotency: clone(idempotency),
    versions: [],
    responseEvidence: [],
    selectionEvidence: [],
    participants: [],
    messages: [],
    workflowEvents: [],
    alerts: [],
  };
  const calls = [];
  let selectionSequence = 700;
  let conversationSequence = 800;
  let lockTail = Promise.resolve();

  function profileFor(current, response) {
    return current.profiles.find(
      (profile) => Number(profile.id) === Number(response.contractor_id)
    ) || {};
  }

  function canonicalResult(current, selection) {
    const response = current.responses.find(
      (row) => String(row.id) === String(selection.professional_response_id)
    );
    const relationship = current.relationships.find(
      (row) => Number(row.id) === Number(selection.request_relationship_id)
    );
    const conversation = current.conversations.find(
      (row) => Number(row.id) === Number(selection.conversation_id)
    );
    const profile = response ? profileFor(current, response) : {};
    if (!response || !relationship || !conversation) return null;

    return {
      selection_id: selection.id,
      selection_post_id: selection.post_id,
      selection_response_id: selection.professional_response_id,
      selection_relationship_id: selection.request_relationship_id,
      selection_homeowner_id: selection.selected_by_user_id,
      selection_contractor_id: selection.contractor_id,
      selection_professional_user_id: selection.professional_user_id,
      selected_response_version: selection.selected_response_version,
      selection_conversation_id: selection.conversation_id,
      selected_at: selection.selected_at,
      selection_ended_at: selection.ended_at,
      response_id: response.id,
      post_id: response.post_id,
      homeowner_id: response.homeowner_id,
      contractor_id: response.contractor_id,
      professional_user_id: response.professional_user_id,
      response_status: response.status,
      response_current_version: response.current_version,
      introduction_text: response.introduction_text,
      submitted_at: response.submitted_at,
      response_selected_at: response.selected_at,
      relationship_id: relationship.id,
      relationship_status: relationship.status,
      ordinary_authority_source: relationship.ordinary_authority_source,
      relationship_current_version: relationship.current_version,
      accepted_at: relationship.accepted_at,
      conversation_id: conversation.id,
      conversation_selection_id: conversation.request_selection_id,
      conversation_relationship_id: conversation.relationship_id,
      conversation_homeowner_id: conversation.homeowner_id,
      conversation_contractor_id: conversation.contractor_id,
      conversation_professional_user_id: conversation.professional_user_id,
      conversation_status: conversation.status,
      business_name: profile.business_name,
      professional_category: profile.category,
      business_image_url: profile.image_url,
    };
  }

  function makeClient() {
    let tx = null;
    let releaseRequestLock = null;

    const unlock = () => {
      if (releaseRequestLock) releaseRequestLock();
      releaseRequestLock = null;
    };

    return {
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
          Object.assign(state, clone(tx));
          tx = null;
          unlock();
          return { rows: [] };
        }
        if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
          return { rows: [] };
        }

        let current = tx || state;

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

        if (tag === "request_lock") {
          const previous = lockTail;
          lockTail = new Promise((resolve) => {
            releaseRequestLock = resolve;
          });
          await previous;
          tx = clone(state);
          current = tx;
          return {
            rows: current.requests.filter(
              (row) =>
                Number(row.id) === Number(values[0]) &&
                Number(row.user_id) === Number(values[1])
            ).slice(0, 1).map(clone),
          };
        }

        if (tag === "relationship_locks") {
          return {
            rows: current.relationships
              .filter((row) =>
                Number(row.post_id) === Number(values[0]) &&
                row.emergency_request_id == null
              )
              .map((row) => ({
                ...clone(row),
                conversation_exists: current.conversations.some(
                  (conversation) =>
                    Number(conversation.relationship_id) === Number(row.id)
                ),
                conversation_has_selection_authority:
                  current.conversations.some((conversation) =>
                    Number(conversation.relationship_id) === Number(row.id) &&
                    current.selections.some((selection) =>
                      Number(selection.id) ===
                        Number(conversation.request_selection_id) &&
                      Number(selection.conversation_id) ===
                        Number(conversation.id) &&
                      Number(selection.request_relationship_id) ===
                        Number(row.id) &&
                      String(selection.professional_response_id) ===
                        String(row.professional_response_id) &&
                      Number(selection.post_id) === Number(row.post_id) &&
                      selection.ended_at == null
                    )
                  ),
              })),
          };
        }

        if (tag === "response_locks") {
          return {
            rows: current.responses
              .filter((row) => Number(row.post_id) === Number(values[0]))
              .map((row) => {
                const profile = profileFor(current, row);
                return {
                  ...clone(row),
                  profile_owner_user_id: profile.user_id,
                  business_name: profile.business_name,
                  professional_category: profile.category,
                  business_image_url: profile.image_url,
                };
              }),
          };
        }

        if (tag === "idempotency_existing") {
          const [actorUserId, commandName, commandScope, key] = values;
          return {
            rows: current.idempotency.filter((row) =>
              Number(row.actor_user_id) === Number(actorUserId) &&
              row.command_name === commandName &&
              row.command_scope === commandScope &&
              row.idempotency_key === key
            ).slice(0, 1).map(clone),
          };
        }

        if (tag === "canonical_result") {
          const [postId, selectionId] = values;
          return {
            rows: current.selections.filter((row) =>
              Number(row.post_id) === Number(postId) &&
              (selectionId != null
                ? Number(row.id) === Number(selectionId)
                : row.ended_at == null)
            ).map((row) => canonicalResult(current, row))
              .filter(Boolean).slice(0, 2).map(clone),
          };
        }

        if (tag === "idempotency_reserve") {
          const [id, actorUserId, postId, requestedResponseId,
            commandName, commandScope, key, fingerprint] = values;
          const row = {
            id,
            actor_user_id: actorUserId,
            post_id: postId,
            requested_professional_response_id: String(requestedResponseId),
            command_name: commandName,
            command_scope: commandScope,
            idempotency_key: key,
            request_fingerprint: fingerprint,
            request_selection_id: null,
            request_relationship_id: null,
            conversation_id: null,
            result_classification: null,
            result_reference: null,
            completed_at: null,
          };
          current.idempotency.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "reserve_identities") {
          selectionSequence += 1;
          conversationSequence += 1;
          return { rows: [{
            request_selection_id: String(selectionSequence),
            conversation_id: conversationSequence,
          }] };
        }

        if (tag === "insert_selection") {
          const row = {
            id: String(values[0]),
            post_id: values[1],
            professional_response_id: String(values[2]),
            request_relationship_id: values[3],
            selected_by_user_id: values[4],
            contractor_id: values[5],
            professional_user_id: values[6],
            selected_response_version: values[7],
            conversation_id: values[8],
            selected_at: "2026-08-06T13:00:00.000Z",
            ended_at: null,
          };
          current.selections.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "response_version") {
          current.versions.push({
            professional_response_id: String(values[0]),
            version: values[1],
            previous_version: values[2],
            status: values[3],
            introduction_text: values[4],
            content_fingerprint: values[5],
            transition_reason: values[6],
            actor_user_id: values[7],
          });
          return { rows: [] };
        }

        if (tag === "response_transition") {
          const row = current.responses.find((candidate) =>
            String(candidate.id) === String(values[0]) &&
            candidate.status === "submitted" &&
            Number(candidate.current_version) === Number(values[4])
          );
          if (!row) return { rows: [] };
          row.status = values[1];
          row.current_version = values[2];
          row.selected_at = values[1] === "selected"
            ? "2026-08-06T13:00:00.000Z"
            : row.selected_at;
          row.terminal_at = values[3]
            ? "2026-08-06T13:00:00.000Z"
            : null;
          return { rows: [clone(row)] };
        }

        if (tag === "relationship_transition") {
          const row = current.relationships.find((candidate) =>
            Number(candidate.id) === Number(values[0]) &&
            candidate.status === "pending" &&
            Number(candidate.current_version) === Number(values[4]) &&
            String(candidate.professional_response_id) === String(values[5])
          );
          if (!row) return { rows: [] };
          row.status = values[1];
          row.current_version = values[2];
          row.accepted_at = values[1] === "active"
            ? "2026-08-06T13:00:00.000Z"
            : row.accepted_at;
          row.closed_at = values[1] === "closed"
            ? "2026-08-06T13:00:00.000Z"
            : null;
          row.closure_reason = values[3];
          return { rows: [clone(row)] };
        }

        if (tag === "response_evidence") {
          current.responseEvidence.push({
            professional_response_id: String(values[0]),
            request_relationship_id: values[1],
            post_id: values[2],
            contractor_id: values[3],
            actor_user_id: values[4],
            event_type: values[5],
            new_status: values[6],
            previous_version: values[7],
            resulting_version: values[8],
            idempotency_id: values[9],
            implementation_milestone_id: values[11],
          });
          return { rows: [] };
        }

        if (tag === "insert_conversation") {
          const row = {
            id: values[0],
            relationship_id: values[1],
            homeowner_id: values[2],
            contractor_id: values[3],
            professional_user_id: values[4],
            status: "active",
            request_selection_id: String(values[5]),
          };
          current.conversations.push(row);
          return { rows: [clone(row)] };
        }

        if (sql.includes("INSERT INTO conversation_participant_state")) {
          const conversation = current.conversations.find(
            (row) => Number(row.id) === Number(values[0])
          );
          if (conversation) {
            current.participants.push(
              {
                conversation_id: conversation.id,
                user_id: conversation.homeowner_id,
                participant_role: "homeowner",
              },
              {
                conversation_id: conversation.id,
                user_id: conversation.professional_user_id,
                participant_role: "professional",
              }
            );
          }
          return { rows: [] };
        }

        if (tag === "insert_evidence") {
          current.selectionEvidence.push({
            request_selection_id: String(values[0]),
            post_id: values[1],
            professional_response_id: String(values[2]),
            selected_response_version: values[3],
            request_relationship_id: values[4],
            actor_user_id: values[5],
            contractor_id: values[6],
            professional_user_id: values[7],
            conversation_id: values[8],
            previous_response_status: "submitted",
            new_response_status: "selected",
            previous_relationship_status: "pending",
            new_relationship_status: "active",
            idempotency_id: values[9],
            correlation_id: values[10],
            safe_payload: JSON.parse(values[11]),
            implementation_milestone_id: values[12],
          });
          return { rows: [] };
        }

        if (tag === "idempotency_complete") {
          const row = current.idempotency.find(
            (candidate) => candidate.id === values[0]
          );
          if (!row || row.completed_at) return { rows: [] };
          row.request_selection_id = String(values[1]);
          row.request_relationship_id = values[2];
          row.conversation_id = values[3];
          row.result_classification = "created";
          row.result_reference = JSON.parse(values[4]);
          row.completed_at = "2026-08-06T13:00:00.000Z";
          return { rows: [clone(row)] };
        }

        if (
          sql.startsWith("UPDATE alerts") &&
          sql.includes("lifecycle_state = 'resolved'")
        ) {
          const resolved = current.alerts.filter((row) =>
            row.source_domain === values[0] &&
            row.source_entity_type === values[1] &&
            row.source_entity_id === values[2] &&
            (values[3] == null || row.source_event_type === values[3]) &&
            (values[4] == null || Number(row.recipient_user_id) === Number(values[4])) &&
            ["active", "dismissed"].includes(row.lifecycle_state)
          );
          for (const row of resolved) {
            row.lifecycle_state = "resolved";
            row.resolved_at = values[5] || "2026-08-06T13:00:00.000Z";
          }
          return { rows: resolved.map(clone) };
        }

        if (sql.startsWith("INSERT INTO alerts")) {
          const row = {
            id: current.alerts.length + 1,
            recipient_user_id: values[0],
            source_domain: values[1],
            source_event_type: values[2],
            source_entity_type: values[3],
            source_entity_id: values[4],
            source_event_id: values[5],
            canonical_event_key: values[6],
            category: values[7],
            priority: values[8],
            title_key: values[9],
            message_key: values[10],
            safe_payload: JSON.parse(values[11]),
            destination_type: values[12],
            destination_payload: JSON.parse(values[13]),
            dedupe_key: values[14],
            lifecycle_state: "active",
            available_at: values[15] || "2026-08-06T13:00:00.000Z",
            expires_at: values[16],
            read_at: null,
            dismissed_at: null,
            resolved_at: null,
            archived_at: null,
            created_at: "2026-08-06T13:00:00.000Z",
            updated_at: "2026-08-06T13:00:00.000Z",
          };
          current.alerts.push(row);
          return { rows: [clone(row)] };
        }

        if (tag === "homeowner_request_read") {
          return {
            rows: current.requests.filter((row) =>
              Number(row.id) === Number(values[0]) &&
              Number(row.user_id) === Number(values[1])
            ).slice(0, 1).map(clone),
          };
        }

        if (tag === "homeowner_response_read") {
          const postId = values[0];
          const hasActiveSelection = current.selections.some(
            (selection) =>
              Number(selection.post_id) === Number(postId) &&
              selection.ended_at == null
          );
          const hasLegacy = current.relationships.some((relationship) =>
            Number(relationship.post_id) === Number(postId) &&
            relationship.emergency_request_id == null &&
            (!relationship.professional_response_id ||
              relationship.ordinary_authority_source !== "professional_response")
          );
          return {
            rows: current.responses.filter(
              (response) => Number(response.post_id) === Number(postId)
            ).map((response) => {
              const relationship = current.relationships.find(
                (row) => Number(row.id) === Number(response.request_relationship_id)
              );
              const selection = current.selections.find(
                (row) => String(row.professional_response_id) === String(response.id)
              );
              const conversation = selection && current.conversations.find(
                (row) => Number(row.id) === Number(selection.conversation_id)
              );
              const profile = profileFor(current, response);
              return {
                response_id: response.id,
                response_status: response.status,
                response_current_version: response.current_version,
                introduction_text: response.introduction_text,
                submitted_at: response.submitted_at,
                selected_at: response.selected_at,
                relationship_status: relationship?.status,
                ordinary_authority_source: relationship?.ordinary_authority_source,
                relationship_current_version: relationship?.current_version,
                business_name: profile.business_name,
                professional_category: profile.category,
                business_image_url: profile.image_url,
                selection_id: selection?.id || null,
                selection_ended_at: selection?.ended_at || null,
                conversation_id: conversation?.id || null,
                conversation_status: conversation?.status || null,
                unresolved_legacy_state: hasLegacy,
                active_selection_exists: hasActiveSelection,
              };
            }),
          };
        }

        throw new Error(`Unexpected query: ${sql}`);
      },

      release() {
        unlock();
      },
    };
  }

  return {
    calls,
    state,
    pool: {
      async connect() {
        return makeClient();
      },
      async query(text, values = []) {
        return makeClient().query(text, values);
      },
    },
  };
}

module.exports = {
  createRequestSelectionFake,
};

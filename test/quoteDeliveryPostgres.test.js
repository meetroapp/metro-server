"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const { submitProfessionalResponse } = require("../server/relationships/professionalResponseService");
const { selectProfessionalResponse } = require("../server/relationships/requestSelectionService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  getProfessionalQuoteDelivery,
  sendQuoteInMeetro,
} = require("../server/authorization/quoteDeliveryService");
const {
  createConversationMessage,
  listConversationMessages,
} = require("../server/conversations/conversationMessageService");
const { serializeConversationMessage } = require("../server/conversations/conversations");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const databaseUrl = process.env.QUOTE_DELIVERY_DATABASE_URL;
const migrationName = "202608140001_create_canonical_quote_delivery_foundation.sql";
const quiet = { info() {}, warn() {} };

function targetMetadata() {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

function requestPayload(suffix) {
  return {
    title: `Quote delivery ${suffix}`,
    description: "Synthetic canonical Quote delivery fixture",
    category: "home_repair",
    request_category: "home_repair",
    service_domain: "home_services",
    service_specialty: "handyman",
    location: "Cape Coral, FL 33904",
    location_intake_mode: "address_after_selection",
    service_address_line1: null,
    service_city: "Cape Coral",
    service_region: "FL",
    service_postal_code: "33904",
    service_country_code: "US",
    unit_number: "",
    access_notes: "",
    request_photos: [],
  };
}

async function createIdentities(pool, suffix) {
  const ids = {};
  for (const [key, role, accountType] of [
    ["homeowner", "homeowner", "homeowner"],
    ["professional", "handyman", "professional"],
    ["outsider", "handyman", "professional"],
  ]) {
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_type)
       VALUES ($1, $2, 'test-only-hash', $3, $4) RETURNING id`,
      [`Delivery ${key}`, `delivery-${key}-${suffix}@example.test`, role, accountType]
    );
    ids[`${key}Id`] = Number(result.rows[0].id);
  }
  for (const id of [ids.professionalId, ids.outsiderId]) {
    await pool.query(
      `INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
       VALUES ($1, $2, 'handyman', 'Cape Coral', $3::jsonb)`,
      [id, `Delivery Service ${id}`, JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["handyman"],
      })]
    );
  }
  return ids;
}

async function createFixture(pool, ids, suffix) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: ids.homeownerId },
    payload: requestPayload(suffix),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true, created.code);
  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: ids.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "Synthetic delivery response." },
    idempotencyKey: `delivery-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: ids.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `delivery-selection-${suffix}`,
  });
  assert.equal(selection.ok, true, selection.code);
  const result = await pool.query(
    `SELECT jobs.id AS job_id, jobs.source_request_relationship_id AS relationship_id,
      conversations.id AS conversation_id,
      professional.id AS professional_participant_id,
      homeowner.id AS homeowner_participant_id
     FROM jobs
     INNER JOIN request_relationships relationships
       ON relationships.id = jobs.source_request_relationship_id
     INNER JOIN conversations
       ON conversations.relationship_id = relationships.id
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id AND professional.user_id = $2
     INNER JOIN relationship_participants homeowner
       ON homeowner.job_id = jobs.id AND homeowner.user_id = $3
     WHERE jobs.job_request_id = $1`,
    [created.post.id, ids.professionalId, ids.homeownerId]
  );
  return {
    requestId: created.post.id,
    jobId: result.rows[0].job_id,
    relationshipId: Number(result.rows[0].relationship_id),
    conversationId: Number(result.rows[0].conversation_id),
    professionalParticipantId: result.rows[0].professional_participant_id,
    homeownerParticipantId: result.rows[0].homeowner_participant_id,
  };
}

async function createQuote(pool, ids, fixture, suffix, { issue = true } = {}) {
  const created = await createDraftQuote({
    pool,
    authenticatedActor: { id: ids.professionalId },
    jobId: fixture.jobId,
    currency: "USD",
    idempotencyKey: `delivery-quote-${suffix}`,
    logger: quiet,
  });
  assert.equal(created.ok, true, created.code);
  const scoped = await addDraftScopeItem({
    pool,
    authenticatedActor: { id: ids.professionalId },
    quoteId: created.quote.id,
    expectedVersion: 1,
    item: {
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Replace disposal safely",
      unitAmountMinor: 92000,
      quantity: 1,
      source: { type: "MANUAL_PROFESSIONAL" },
    },
    idempotencyKey: `delivery-scope-${suffix}`,
    logger: quiet,
  });
  assert.equal(scoped.ok, true, scoped.code);
  if (!issue) return scoped.quote;
  const issued = await issueQuote({
    pool,
    authenticatedActor: { id: ids.professionalId },
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
    idempotencyKey: `delivery-issue-${suffix}`,
    logger: quiet,
  });
  assert.equal(issued.ok, true, issued.code);
  return issued.quote;
}

test("disposable PostgreSQL certifies canonical Quote delivery and ordinary messages", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12 });
  const suffix = randomUUID();
  try {
    const migrations = getMigrationFiles();
    assert.equal(migrations.at(-1).filename, migrationName);
    const applied = await runMigrationCollection(pool, migrations, targetMetadata());
    assert.equal(applied.success, true);
    assert.equal(applied.applied.length, migrations.length);
    const replay = await runMigrationCollection(pool, migrations, targetMetadata());
    assert.equal(replay.success, true);
    assert.equal(replay.skipped.length, migrations.length);

    const ids = await createIdentities(pool, suffix);
    const fixture = await createFixture(pool, ids, `${suffix}-primary`);
    const quote = await createQuote(pool, ids, fixture, suffix);
    const before = await pool.query(
      `SELECT quotes.status, quotes.updated_at, aggregates.current_version,
        decisions.decision, jobs.created_at AS job_created_at,
        (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visits
       FROM canonical_quotes quotes
       INNER JOIN commercial_authority_aggregates aggregates ON aggregates.id = quotes.id
       LEFT JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id
       INNER JOIN jobs ON jobs.id = quotes.job_id
       WHERE quotes.id = $2`,
      [fixture.jobId, quote.id]
    );

    const projection = await getProfessionalQuoteDelivery({
      pool,
      authenticatedActor: { id: ids.professionalId },
      quoteId: quote.id,
      logger: quiet,
    });
    assert.equal(projection.ok, true, projection.code);
    assert.equal(projection.delivery.actions.canSendInMeetro, true);
    assert.equal(projection.delivery.conversation.id, fixture.conversationId);
    assert.equal(projection.delivery.snapshot.totalMinor, 92000);
    assert.equal(JSON.stringify(projection).includes("materialsSubtotalMinor"), false);

    const key = `delivery-send-${suffix}`;
    const input = {
      pool,
      authenticatedActor: { id: ids.professionalId },
      quoteId: quote.id,
      expectedIssuedVersion: quote.currentVersion,
      idempotencyKey: key,
      logger: quiet,
    };
    const [first, concurrentReplay] = await Promise.all([
      sendQuoteInMeetro(input),
      sendQuoteInMeetro(input),
    ]);
    assert.equal(first.ok, true, first.code);
    assert.equal(concurrentReplay.ok, true, concurrentReplay.code);
    assert.equal(first.delivery.messageId, concurrentReplay.delivery.messageId);
    assert.equal([first.delivery.replayed, concurrentReplay.delivery.replayed].filter(Boolean).length, 1);

    const replayed = await sendQuoteInMeetro(input);
    assert.equal(replayed.delivery.messageId, first.delivery.messageId);
    assert.equal(replayed.delivery.replayed, true);
    const conflict = await sendQuoteInMeetro({ ...input, expectedIssuedVersion: quote.currentVersion + 1 });
    assert.equal(conflict.code, "QUOTE_DELIVERY_IDEMPOTENCY_CONFLICT");
    const reshared = await sendQuoteInMeetro({ ...input, idempotencyKey: `${key}-again` });
    assert.equal(reshared.ok, true, reshared.code);
    assert.notEqual(reshared.delivery.messageId, first.delivery.messageId);

    const rows = await pool.query(
      `SELECT * FROM messages WHERE quote_id = $1 ORDER BY id ASC`,
      [quote.id]
    );
    assert.equal(rows.rowCount, 2);
    assert.equal(rows.rows[0].conversation_id, fixture.conversationId);
    assert.equal(Number(rows.rows[0].sender_id), ids.professionalId);
    assert.equal(Number(rows.rows[0].receiver_id), ids.homeownerId);
    assert.equal(rows.rows[0].job_id, fixture.jobId);
    assert.equal(rows.rows[0].message_type, "quote_shared");
    assert.equal(rows.rows[0].workflow_type, "QUOTE_SHARED");
    assert.equal(rows.rows[0].workflow_status, "SENT");

    const messages = await listConversationMessages({
      pool,
      conversationId: fixture.conversationId,
      limit: 50,
    });
    const serialized = messages.messages.map((row) => serializeConversationMessage(row, ids.homeownerId));
    assert.equal(serialized[0].reference.quoteId, quote.id);
    assert.equal(serialized[0].workflow.payload.jobId, fixture.jobId);
    assert.equal(JSON.stringify(serialized).includes("integrity_hash"), false);
    assert.equal(JSON.stringify(serialized).includes("delivery_idempotency_key"), false);

    const ordinary = await createConversationMessage({
      pool,
      conversationId: fixture.conversationId,
      senderUserId: ids.homeownerId,
      payload: { message_text: "Ordinary text remains canonical." },
    });
    assert.equal(ordinary.ok, true, ordinary.code);
    assert.equal(ordinary.message.message_type, "text");
    const ordinaryRow = await pool.query(`SELECT quote_id, job_id FROM messages WHERE id = $1`, [ordinary.message.id]);
    assert.deepEqual(ordinaryRow.rows[0], { quote_id: null, job_id: null });

    const alert = await pool.query(
      `SELECT count(*)::integer AS count FROM alerts
       WHERE recipient_user_id = $1 AND source_domain = 'communication'
         AND source_entity_id = $2`,
      [ids.homeownerId, String(fixture.conversationId)]
    );
    assert.equal(alert.rows[0].count, 1);

    const outsider = await sendQuoteInMeetro({
      ...input,
      authenticatedActor: { id: ids.outsiderId },
      idempotencyKey: `delivery-outsider-${suffix}`,
    });
    assert.equal(outsider.code, "QUOTE_AUTHORITY_REQUIRED");
    const stale = await sendQuoteInMeetro({
      ...input,
      expectedIssuedVersion: quote.currentVersion + 1,
      idempotencyKey: `delivery-stale-${suffix}`,
    });
    assert.equal(stale.code, "STALE_QUOTE_VERSION");

    const draftFixture = await createFixture(pool, ids, `${suffix}-draft`);
    const draft = await createQuote(pool, ids, draftFixture, `${suffix}-draft`, { issue: false });
    const draftResult = await sendQuoteInMeetro({
      ...input,
      quoteId: draft.id,
      expectedIssuedVersion: draft.currentVersion,
      idempotencyKey: `delivery-draft-${suffix}`,
    });
    assert.equal(draftResult.code, "QUOTE_NOT_DELIVERABLE");

    const closedFixture = await createFixture(pool, ids, `${suffix}-closed`);
    const closedQuote = await createQuote(pool, ids, closedFixture, `${suffix}-closed`);
    await pool.query(`UPDATE conversations SET status = 'closed', closed_at = CURRENT_TIMESTAMP WHERE id = $1`, [closedFixture.conversationId]);
    const closed = await sendQuoteInMeetro({
      ...input,
      quoteId: closedQuote.id,
      expectedIssuedVersion: closedQuote.currentVersion,
      idempotencyKey: `delivery-closed-${suffix}`,
    });
    assert.equal(closed.code, "QUOTE_DELIVERY_CONVERSATION_UNAVAILABLE");

    const revokedFixture = await createFixture(pool, ids, `${suffix}-revoked`);
    const revokedQuote = await createQuote(pool, ids, revokedFixture, `${suffix}-revoked`);
    const readGrant = await pool.query(
      `SELECT id FROM lifecycle_authority_grants
       WHERE grantee_participant_id = $1 AND job_id = $2
         AND capability = 'quote.read' LIMIT 1`,
      [revokedFixture.professionalParticipantId, revokedFixture.jobId]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grant_revocations (
        id, authority_grant_id, job_id, revoked_by_participant_id,
        revocation_reason, source_evidence_type, source_evidence_reference,
        idempotency_key
      ) VALUES ($1, $2, $3, $4, 'Local delivery authority certification',
        'local_certification', $5, $6)`,
      [randomUUID(), readGrant.rows[0].id, revokedFixture.jobId,
        revokedFixture.homeownerParticipantId, suffix, randomUUID()]
    );
    const revoked = await sendQuoteInMeetro({
      ...input,
      quoteId: revokedQuote.id,
      expectedIssuedVersion: revokedQuote.currentVersion,
      idempotencyKey: `delivery-revoked-${suffix}`,
    });
    assert.equal(revoked.code, "QUOTE_AUTHORITY_REQUIRED");

    const approval = await approveIssuedQuote({
      pool,
      authenticatedActor: { id: ids.homeownerId },
      quoteId: quote.id,
      expectedIssuedVersion: quote.currentVersion,
      idempotencyKey: `delivery-approve-${suffix}`,
      logger: quiet,
    });
    assert.equal(approval.ok, true, approval.code);
    const approvedReshare = await sendQuoteInMeetro({ ...input, idempotencyKey: `${key}-approved` });
    assert.equal(approvedReshare.ok, true, approvedReshare.code);
    const approvedMessage = await pool.query(`SELECT workflow_payload FROM messages WHERE id = $1`, [approvedReshare.delivery.messageId]);
    assert.equal(approvedMessage.rows[0].workflow_payload.businessStatus, "APPROVED");

    const after = await pool.query(
      `SELECT quotes.status, quotes.updated_at, aggregates.current_version,
        decisions.decision, jobs.created_at AS job_created_at,
        (SELECT count(*)::integer FROM canonical_visits WHERE job_id = $1) AS visits
       FROM canonical_quotes quotes
       INNER JOIN commercial_authority_aggregates aggregates ON aggregates.id = quotes.id
       LEFT JOIN canonical_quote_customer_decisions decisions ON decisions.quote_id = quotes.id
       INNER JOIN jobs ON jobs.id = quotes.job_id
       WHERE quotes.id = $2`,
      [fixture.jobId, quote.id]
    );
    assert.equal(after.rows[0].status, before.rows[0].status);
    assert.equal(after.rows[0].current_version, before.rows[0].current_version);
    assert.equal(after.rows[0].job_created_at.toISOString(), before.rows[0].job_created_at.toISOString());
    assert.equal(after.rows[0].visits, before.rows[0].visits);
    assert.equal(after.rows[0].decision, "APPROVED");
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM messages WHERE quote_id = $1`, [quote.id])).rows[0].count, 3);
    assert.equal((await pool.query(`SELECT count(*)::integer AS count FROM schema_migrations`)).rows[0].count, migrations.length);
  } finally {
    await pool.end();
  }
});

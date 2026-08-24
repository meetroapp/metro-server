"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const { createJobRequest } = require("../server/requests/jobRequestCreateService");
const { submitProfessionalResponse } = require("../server/relationships/professionalResponseService");
const { selectProfessionalResponse } = require("../server/relationships/requestSelectionService");
const { createOrdinaryJobEvaluation } = require("../server/authorization/evaluationService");
const { confirmFinding, submitFinding } = require("../server/authorization/findingService");
const {
  createRecommendation,
  transitionRecommendation,
} = require("../server/authorization/recommendationService");
const {
  createWorkActivity,
  createWorkstream,
  progressWorkActivity,
} = require("../server/workflow/workstreamService");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  createDerivedDraftQuote,
  declineIssuedQuote,
  getCustomerIssuedQuote,
  getDraftQuote,
  issueQuote,
  listDraftQuotesByJob,
  removeDraftScopeItem,
} = require("../server/authorization/quoteDraftService");
const { getMigrationFiles, runMigrationCollection } = require("../scripts/run-migrations");

const cleanDatabaseUrl = process.env.QUOTE_FOUNDATION_DATABASE_URL;
const upgradeDatabaseUrl = process.env.QUOTE_UPGRADE_DATABASE_URL;
const migrationName = "202608100003_create_canonical_quote_scope_foundation.sql";
const quiet = { info() {}, warn() {} };
const customerTermsSnapshot = {
  schemaVersion: 1,
  paymentTerms: "50% deposit; balance due on completion.",
  estimatedDuration: "3 days",
  customerNotes: "Protect the existing landscaping.",
  agreement: {
    exclusions: ["Permit fees", "Hidden damage"],
    additionalWorkTerms: "Written customer approval is required.",
    hiddenConditionsTerms: "Hidden conditions require a revised Quote.",
    diagnosticTerms: "Diagnostic work is limited to the stated scope.",
    customerResponsibilities: "Provide safe site access.",
    warrantyTerms: "One-year workmanship warranty.",
    cancellationTerms: "Cancellation terms apply as stated.",
    acceptanceTerms: "Approval accepts this exact issued Quote.",
    preauthorizedAdditionalWorkLimit: "$0",
  },
};

function targetMetadata(databaseUrl) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(databaseUrl, { nodeEnv: process.env.NODE_ENV }),
  };
}

function requestPayload(description) {
  return {
    title: `Quote fixture ${description}`,
    description,
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

function evaluationContent() {
  return {
    serviceType: "handyman",
    evaluationContext: "ordinary_job",
    observations: "Inspected synthetic commercial-scope conditions.",
    measurements: [],
    findings: [],
    diagnosisSummary: "",
    limitations: "",
    scopeRecommendations: [],
    relevantConditions: [],
    supportingMediaReferences: [],
    internalNotes: "",
  };
}

async function createIdentities(pool, suffix) {
  const rows = {};
  for (const [key, role, accountType] of [
    ["homeowner", "homeowner", "homeowner"],
    ["professional", "handyman", "professional"],
    ["outsider", "handyman", "professional"],
    ["occupant", "homeowner", "homeowner"],
  ]) {
    const result = await pool.query(
      `INSERT INTO users (username, email, password_hash, role, account_type)
       VALUES ($1, $2, 'test-only-hash', $3, $4) RETURNING id`,
      [`Quote ${key}`, `quote-${key}-${suffix}@example.test`, role, accountType]
    );
    rows[`${key}Id`] = Number(result.rows[0].id);
  }
  for (const id of [rows.professionalId, rows.outsiderId]) {
    await pool.query(
      `INSERT INTO contractor_profiles
        (user_id, business_name, category, location, profile_details)
       VALUES ($1, $2, 'handyman', 'Cape Coral', $3::jsonb)`,
      [id, `Quote Service ${id}`, JSON.stringify({
        service_area: "Cape Coral",
        service_specialties: ["handyman"],
      })]
    );
  }
  return rows;
}

async function createLifecycleFixture(pool, identities, suffix, description) {
  const created = await createJobRequest({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    payload: requestPayload(description),
    idempotencyKey: randomUUID(),
    env: {
      JOB_LIFECYCLE_V2_ENABLED: "true",
      JOB_LIFECYCLE_V2_READINESS: "MC-JOB-LIFECYCLE-004B",
    },
  });
  assert.equal(created.ok, true, created.code);
  const response = await submitProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.professionalId },
    postId: created.post.id,
    payload: { introduction_text: "Synthetic Quote response." },
    idempotencyKey: `quote-response-${suffix}`,
    professionalCanSeeRequest: () => true,
  });
  assert.equal(response.ok, true, response.code);
  const selection = await selectProfessionalResponse({
    pool,
    authenticatedActor: { id: identities.homeownerId },
    postId: created.post.id,
    responseId: response.response.id,
    payload: {},
    idempotencyKey: `quote-selection-${suffix}`,
  });
  assert.equal(selection.ok, true, selection.code);
  const context = await pool.query(
    `SELECT jobs.id AS job_id,
      jobs.source_request_relationship_id AS relationship_id,
      professional.id AS professional_participant_id,
      homeowner.id AS homeowner_participant_id
     FROM jobs
     INNER JOIN relationship_participants professional
       ON professional.job_id = jobs.id AND professional.user_id = $2
     INNER JOIN relationship_participants homeowner
       ON homeowner.job_id = jobs.id AND homeowner.user_id = $3
     WHERE jobs.job_request_id = $1`,
    [created.post.id, identities.professionalId, identities.homeownerId]
  );
  return {
    requestId: created.post.id,
    jobId: context.rows[0].job_id,
    relationshipId: Number(context.rows[0].relationship_id),
    professionalParticipantId: context.rows[0].professional_participant_id,
    homeownerParticipantId: context.rows[0].homeowner_participant_id,
  };
}

async function createFinding(pool, identities, fixture, suffix, statement) {
  const evaluation = await createOrdinaryJobEvaluation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    jobId: fixture.jobId,
    content: evaluationContent(),
    expectedVersion: 0,
    idempotencyKey: `quote-evaluation-${suffix}`,
    logger: quiet,
  });
  assert.equal(evaluation.ok, true, evaluation.code);
  const proposed = await submitFinding({
    pool,
    authenticatedActor: { id: identities.professionalId },
    evaluationId: evaluation.evaluation.id,
    statement,
    idempotencyKey: `quote-finding-${suffix}`,
    logger: quiet,
  });
  assert.equal(proposed.ok, true, proposed.code);
  const confirmed = await confirmFinding({
    pool,
    authenticatedActor: { id: identities.professionalId },
    findingId: proposed.finding.id,
    expectedVersion: 1,
    idempotencyKey: `quote-confirm-${suffix}`,
    logger: quiet,
  });
  assert.equal(confirmed.ok, true, confirmed.code);
  return confirmed.finding;
}

async function recommendation(pool, identities, findingId, suffix, statement, options = {}) {
  const result = await createRecommendation({
    pool,
    authenticatedActor: { id: identities.professionalId },
    findingId,
    kind: options.kind || "PRIMARY",
    statement,
    primaryRecommendationId: options.primaryRecommendationId,
    idempotencyKey: `quote-recommendation-${suffix}`,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result.recommendation;
}

function quoteCommand(service, pool, actorId, values, key) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    ...values,
  });
}

function scopeItem({
  classification,
  scopeSemantic,
  materialResponsibility,
  description,
  unitAmountMinor,
  source = { type: "MANUAL_PROFESSIONAL" },
  quantity = 1,
}) {
  return {
    classification,
    scopeSemantic,
    materialResponsibility,
    description,
    unitAmountMinor,
    quantity,
    source,
  };
}

async function createSimpleIssuedQuote(
  pool,
  identities,
  fixture,
  suffix,
  amountMinor = 2000,
  terms = null
) {
  const created = await quoteCommand(createDraftQuote, pool, identities.professionalId, {
    jobId: fixture.jobId,
    currency: "USD",
    ...(terms == null ? {} : { customerTermsSnapshot: terms }),
  }, `simple-create-${suffix}`);
  assert.equal(created.ok, true, created.code);
  const scoped = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: 1,
    item: scopeItem({
      classification: "LABOR_SERVICE",
      scopeSemantic: "FUTURE_WORK",
      materialResponsibility: "NOT_APPLICABLE",
      description: "Governed synthetic service",
      unitAmountMinor: amountMinor,
    }),
  }, `simple-scope-${suffix}`);
  assert.equal(scoped.ok, true, scoped.code);
  const issued = await quoteCommand(issueQuote, pool, identities.professionalId, {
    quoteId: created.quote.id,
    expectedVersion: scoped.quote.currentVersion,
  }, `simple-issue-${suffix}`);
  assert.equal(issued.ok, true, issued.code);
  return issued.quote;
}

test("clean disposable PostgreSQL certifies canonical $920 Draft and issued Quote", { skip: !cleanDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: cleanDatabaseUrl, max: 8 });
  const suffix = randomUUID();
  try {
    const migrations = getMigrationFiles();
    assert.equal(migrations.length, 51);
    const applied = await runMigrationCollection(pool, migrations, targetMetadata(cleanDatabaseUrl));
    assert.equal(applied.success, true);
    assert.equal(applied.applied.length, 49);
    const replay = await runMigrationCollection(pool, migrations, targetMetadata(cleanDatabaseUrl));
    assert.equal(replay.success, true);
    assert.equal(replay.skipped.length, 45);

    const identities = await createIdentities(pool, suffix);
    const fixture = await createLifecycleFixture(pool, identities, `${suffix}-primary`, "A/C, disposal, lighting, fan and microwave work");
    const crossFixture = await createLifecycleFixture(pool, identities, `${suffix}-cross`, "separate property work");
    const declinedFixture = await createLifecycleFixture(pool, identities, `${suffix}-declined`, "declined commercial proposal");
    const raceFixture = await createLifecycleFixture(pool, identities, `${suffix}-race`, "concurrent customer decision");
    const occupantParticipantId = randomUUID();
    await pool.query(
      `INSERT INTO relationship_participants (
        id, job_id, request_relationship_id, user_id,
        source_evidence_type, source_evidence_reference
      ) VALUES ($1, $2, $3, $4, 'request_selection', $5)`,
      [occupantParticipantId, fixture.jobId, fixture.relationshipId,
        identities.occupantId, `site-occupant-${suffix}`]
    );
    await pool.query(
      `INSERT INTO participant_role_assignments (
        id, participant_id, job_id, role, assigned_by_participant_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      ) VALUES ($1, $2, $3, 'SITE_OCCUPANT', $4,
        'local_certification', $5, $6)`,
      [randomUUID(), occupantParticipantId, fixture.jobId,
        fixture.homeownerParticipantId, suffix, `site-occupant-role-${suffix}`]
    );
    const finding = await createFinding(pool, identities, fixture, suffix, "A/C, disposal and ventilation findings");
    const crossFinding = await createFinding(pool, identities, crossFixture, `${suffix}-cross`, "cross-property finding");
    const acPrimary = await recommendation(pool, identities, finding.id, `${suffix}-ac`, "Replace A/C system");
    const r22 = await recommendation(pool, identities, finding.id, `${suffix}-r22`, "R-22 recharge - $350", {
      kind: "ALTERNATIVE",
      primaryRecommendationId: acPrimary.id,
    });
    const disposal = await recommendation(pool, identities, finding.id, `${suffix}-disposal`, "Replace failed disposal");
    const fan = await recommendation(pool, identities, finding.id, `${suffix}-fan`, "Replace ceiling fan after customer selection");
    const crossRecommendation = await recommendation(pool, identities, crossFinding.id, `${suffix}-cross`, "Cross-property work");

    const workstream = await quoteCommand(createWorkstream, pool, identities.professionalId, {
      jobId: fixture.jobId,
      title: "A/C temporary stabilization",
      sequence: 1,
    }, `quote-workstream-${suffix}`);
    assert.equal(workstream.ok, true, workstream.code);
    const activity = await quoteCommand(createWorkActivity, pool, identities.professionalId, {
      jobId: fixture.jobId,
      workstreamId: workstream.workstream.id,
      activityType: "TEMPORARY_REPAIR",
      statement: "Performed temporary A/C stabilization.",
      temporaryIntervention: true,
      temporaryDetails: "Temporary service pending replacement decision.",
    }, `quote-activity-${suffix}`);
    assert.equal(activity.ok, true, activity.code);
    const inProgress = await quoteCommand(progressWorkActivity, pool, identities.professionalId, {
      jobId: fixture.jobId,
      workstreamId: workstream.workstream.id,
      activityId: activity.activity.id,
      expectedVersion: 1,
      targetStatus: "IN_PROGRESS",
    }, `quote-activity-progress-${suffix}`);
    assert.equal(inProgress.ok, true, inProgress.code);
    const done = await quoteCommand(progressWorkActivity, pool, identities.professionalId, {
      jobId: fixture.jobId,
      workstreamId: workstream.workstream.id,
      activityId: activity.activity.id,
      expectedVersion: 2,
      targetStatus: "DONE",
    }, `quote-activity-done-${suffix}`);
    assert.equal(done.ok, true, done.code);

    const before = await pool.query(
      `SELECT
        (SELECT resolution_state FROM canonical_evaluation_finding_versions
          WHERE finding_id = $1 ORDER BY version DESC LIMIT 1) AS finding_resolution,
        (SELECT state FROM canonical_workstream_versions
          WHERE workstream_id = $2 ORDER BY version DESC LIMIT 1) AS workstream_state,
        (SELECT count(*) FROM jobs WHERE id = $3)::integer AS jobs`,
      [finding.id, workstream.workstream.id, fixture.jobId]
    );

    const createInput = {
      jobId: fixture.jobId,
      currency: "USD",
      customerTermsSnapshot,
    };
    const createKey = `quote-create-${suffix}`;
    const created = await quoteCommand(createDraftQuote, pool, identities.professionalId, createInput, createKey);
    assert.equal(created.code, "DRAFT_QUOTE_CREATED");
    assert.equal(created.quote.currentVersion, 1);
    assert.equal(created.quote.integrityVersion, 2);
    assert.deepEqual(created.quote.customerTermsSnapshot, customerTermsSnapshot);
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.professionalId, createInput, createKey)).replayed, true);
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.professionalId, { ...createInput, currency: "CAD" }, createKey)).code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.homeownerId, createInput, `homeowner-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.outsiderId, createInput, `outsider-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");

    const items = [
      scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_INCLUDED", materialResponsibility: "PROFESSIONAL_SUPPLIED", description: "Disposal replacement material", unitAmountMinor: 12000, source: { type: "RECOMMENDATION", recommendationId: disposal.id, version: 1 } }),
      scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_INCLUDED", materialResponsibility: "PROFESSIONAL_SUPPLIED", description: "Smoke-detector batteries", unitAmountMinor: 3000 }),
      scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_INCLUDED", materialResponsibility: "PROFESSIONAL_SUPPLIED", description: "Lighting bulbs", unitAmountMinor: 4000 }),
      scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_INCLUDED", materialResponsibility: "PROFESSIONAL_SUPPLIED", description: "Microwave handle subject to compatibility", unitAmountMinor: 5000 }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "TEMPORARY_SERVICE", materialResponsibility: "NOT_APPLICABLE", description: "A/C temporary service", unitAmountMinor: 18000, source: { type: "WORK_ACTIVITY", workstreamId: workstream.workstream.id, activityId: activity.activity.id, version: 3 } }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", description: "Fan installation labor", unitAmountMinor: 15000 }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", description: "Disposal installation labor", unitAmountMinor: 14000, source: { type: "RECOMMENDATION", recommendationId: disposal.id, version: 1 } }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", description: "Lighting and battery labor", unitAmountMinor: 9000 }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "FUTURE_WORK", materialResponsibility: "NOT_APPLICABLE", description: "Microwave-handle installation", unitAmountMinor: 12000 }),
      scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_EXCLUDED", materialResponsibility: "PENDING_SELECTION", description: "Replacement ceiling fan material pending customer selection", unitAmountMinor: 35000, source: { type: "RECOMMENDATION", recommendationId: fan.id, version: 1 } }),
      scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "SEPARATE_PROPOSAL", materialResponsibility: "NOT_APPLICABLE", description: "A/C replacement separate proposal", unitAmountMinor: 500000, source: { type: "RECOMMENDATION", recommendationId: acPrimary.id, version: 1 } }),
    ];

    let quote = created.quote;
    for (let index = 0; index < items.length; index += 1) {
      const key = `quote-scope-${index}-${suffix}`;
      const expectedVersion = quote.currentVersion;
      const added = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
        quoteId: quote.id,
        expectedVersion,
        item: items[index],
      }, key);
      assert.equal(added.ok, true, added.code);
      quote = added.quote;
      if (index === 0) {
        assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
          quoteId: quote.id,
          expectedVersion,
          item: items[index],
        }, key)).replayed, true);
        assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
          quoteId: quote.id,
          expectedVersion,
          item: { ...items[index], unitAmountMinor: 13000 },
        }, key)).code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
      }
    }
    assert.equal(quote.materialsSubtotalMinor, 24000);
    assert.equal(quote.laborServiceSubtotalMinor, 68000);
    assert.equal(quote.totalMinor, 92000);
    assert.equal(quote.scopeItemCount, 11);
    assert.equal(quote.integrityVersion, 2);
    assert.equal(
      quote.versions.every((version) =>
        version.integrityVersion === 2 &&
        JSON.stringify(version.customerTermsSnapshot) === JSON.stringify(customerTermsSnapshot)
      ),
      true
    );
    assert.equal(quote.scopeItems.find((row) => row.description.includes("ceiling fan")).includedInTotal, false);
    assert.equal(quote.scopeItems.find((row) => row.description.includes("separate proposal")).includedInTotal, false);
    assert.equal(quote.scopeItems.some((row) => row.source.recommendationId === r22.id), false);
    assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      expectedVersion: quote.currentVersion - 1,
      item: items[1],
    }, `stale-${suffix}`)).code, "STALE_QUOTE_VERSION");
    assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      expectedVersion: quote.currentVersion,
      item: { ...items[1], source: { type: "RECOMMENDATION", recommendationId: crossRecommendation.id, version: 1 } },
    }, `cross-source-${suffix}`)).code, "QUOTE_SOURCE_SCOPE_MISMATCH");
    assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      expectedVersion: quote.currentVersion,
      item: { ...items[1], totalMinor: 3000 },
    }, `client-total-${suffix}`)).code, "QUOTE_AUTHORITY_FIELD_REJECTED");

    const transient = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      expectedVersion: quote.currentVersion,
      item: scopeItem({ classification: "LABOR_SERVICE", scopeSemantic: "SEPARATE_PROPOSAL", materialResponsibility: "NOT_APPLICABLE", description: "Transient separate line", unitAmountMinor: 1 }),
    }, `transient-add-${suffix}`);
    const removeKey = `transient-remove-${suffix}`;
    const removed = await quoteCommand(removeDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      scopeItemId: transient.scopeItem.scopeItemId,
      expectedVersion: transient.quote.currentVersion,
    }, removeKey);
    assert.equal(removed.quote.totalMinor, 92000);
    assert.equal(removed.quote.scopeItemCount, 11);
    assert.equal((await quoteCommand(removeDraftScopeItem, pool, identities.professionalId, {
      quoteId: quote.id,
      scopeItemId: transient.scopeItem.scopeItemId,
      expectedVersion: transient.quote.currentVersion,
    }, removeKey)).replayed, true);

    quote = removed.quote;
    const issueInput = { quoteId: quote.id, expectedVersion: quote.currentVersion };
    assert.equal((await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.homeownerId },
      quoteId: quote.id,
      logger: quiet,
    })).code, "QUOTE_UNAVAILABLE");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: quote.id,
      expectedIssuedVersion: quote.currentVersion,
    }, `draft-approve-${suffix}`)).code, "ISSUED_QUOTE_VERSION_REQUIRED");
    assert.equal((await quoteCommand(issueQuote, pool, identities.homeownerId, issueInput, `homeowner-issue-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(issueQuote, pool, identities.outsiderId, issueInput, `outsider-issue-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      ...issueInput,
      expectedVersion: quote.currentVersion - 1,
    }, `stale-issue-${suffix}`)).code, "STALE_QUOTE_VERSION");
    await assert.rejects(
      quoteCommand(issueQuote, pool, identities.professionalId, {
        ...issueInput,
        failureInjector(stage) {
          if (stage === "after_write") throw new Error("injected Quote issue rollback");
        },
      }, `rollback-issue-${suffix}`),
      /injected Quote issue rollback/
    );
    const rolledBackIssue = await pool.query(
      `SELECT
        (SELECT status FROM canonical_quotes WHERE id = $1) AS status,
        (SELECT current_version FROM commercial_authority_aggregates
          WHERE id = $1)::integer AS current_version,
        (SELECT count(*) FROM canonical_quote_issuances
          WHERE quote_id = $1)::integer AS issuances,
        (SELECT count(*) FROM commercial_command_idempotency
          WHERE idempotency_key = $2)::integer AS command_rows`,
      [quote.id, `rollback-issue-${suffix}`]
    );
    assert.deepEqual(rolledBackIssue.rows[0], {
      status: "DRAFT",
      current_version: 14,
      issuances: 0,
      command_rows: 0,
    });

    const issueAttempts = [
      { key: `issue-a-${suffix}` },
      { key: `issue-b-${suffix}` },
    ];
    await Promise.all(issueAttempts.map(async (attempt) => {
      attempt.result = await quoteCommand(
        issueQuote,
        pool,
        identities.professionalId,
        issueInput,
        attempt.key
      );
    }));
    assert.deepEqual(
      issueAttempts.map((attempt) => attempt.result.code).sort(),
      ["QUOTE_ALREADY_ISSUED", "QUOTE_ISSUED"]
    );
    const successfulIssue = issueAttempts.find((attempt) => attempt.result.code === "QUOTE_ISSUED");
    const issued = successfulIssue.result.quote;
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, issueInput, successfulIssue.key)).replayed, true);
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      ...issueInput,
      expectedVersion: issueInput.expectedVersion + 1,
    }, successfulIssue.key)).code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, issueInput, `already-issued-${suffix}`)).code, "QUOTE_ALREADY_ISSUED");
    assert.equal(issued.status, "ISSUED");
    assert.equal(issued.currentVersion, 15);
    assert.ok(issued.issuedAt);
    assert.equal(issued.materialsSubtotalMinor, 24000);
    assert.equal(issued.laborServiceSubtotalMinor, 68000);
    assert.equal(issued.totalMinor, 92000);
    assert.equal(issued.integrityVersion, 2);
    assert.deepEqual(issued.customerTermsSnapshot, customerTermsSnapshot);
    assert.deepEqual(issued.conditions, []);
    assert.equal(issued.exclusions.length, 2);
    assert.equal(issued.scopeItems.find((row) => row.description.includes("ceiling fan")).includedInTotal, false);
    assert.equal(issued.scopeItems.find((row) => row.description.includes("separate proposal")).includedInTotal, false);
    assert.equal(issued.scopeItems.some((row) => row.source.recommendationId === r22.id), false);
    const issuanceProof = await pool.query(
      `SELECT issuances.quote_version, issuances.issuer_participant_id,
        issuances.issued_at, issuances.source_snapshot_integrity_hash,
        evidence.actor_user_id, evidence.resulting_version,
        grants.capability
       FROM canonical_quote_issuances issuances
       INNER JOIN commercial_authority_evidence evidence
         ON evidence.id = issuances.commercial_evidence_id
       INNER JOIN lifecycle_authority_grants grants
         ON grants.id = issuances.authority_grant_id
       WHERE issuances.quote_id = $1`,
      [issued.id]
    );
    assert.equal(issuanceProof.rows[0].quote_version, 15);
    assert.equal(issuanceProof.rows[0].issuer_participant_id, fixture.professionalParticipantId);
    assert.equal(Number(issuanceProof.rows[0].actor_user_id), identities.professionalId);
    assert.equal(issuanceProof.rows[0].resulting_version, 15);
    assert.equal(issuanceProof.rows[0].capability, "quote.issue");
    assert.equal(issuanceProof.rows[0].source_snapshot_integrity_hash, issued.versions.at(-1).integrityHash);
    assert.ok(issuanceProof.rows[0].issued_at);
    await assert.rejects(
      pool.query(`UPDATE canonical_quotes SET currency = 'CAD' WHERE id = $1`, [issued.id]),
      /immutable/
    );
    await assert.rejects(
      pool.query(`UPDATE canonical_quotes SET status = 'DRAFT', issued_at = NULL WHERE id = $1`, [issued.id]),
      /immutable/
    );
    await assert.rejects(
      pool.query(
        `UPDATE canonical_quote_scope_item_snapshots
         SET unit_amount_minor = unit_amount_minor + 1
         WHERE quote_id = $1 AND quote_version = $2`,
        [issued.id, issued.currentVersion]
      ),
      /append-only/
    );
    await assert.rejects(
      pool.query(
        `UPDATE canonical_quote_versions
         SET customer_terms_snapshot = jsonb_set(
           customer_terms_snapshot,
           '{agreement,warrantyTerms}',
           '"Two years"'::jsonb
         )
         WHERE quote_id = $1 AND version = $2`,
        [issued.id, issued.currentVersion]
      ),
      /append-only/
    );
    await assert.rejects(
      pool.query(`DELETE FROM canonical_quote_issuances WHERE quote_id = $1`, [issued.id]),
      /append-only/
    );

    assert.equal((await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: issued.id,
      expectedVersion: issued.currentVersion,
      item: items[1],
    }, `issued-add-${suffix}`)).code, "DRAFT_QUOTE_REQUIRED");
    assert.equal((await quoteCommand(removeDraftScopeItem, pool, identities.professionalId, {
      quoteId: issued.id,
      scopeItemId: issued.scopeItems[0].scopeItemId,
      expectedVersion: issued.currentVersion,
    }, `issued-remove-${suffix}`)).code, "DRAFT_QUOTE_REQUIRED");

    const frozenScope = JSON.parse(JSON.stringify(issued.scopeItems));
    const frozenHash = issued.versions.at(-1).integrityHash;
    const changedRecommendation = await quoteCommand(
      transitionRecommendation,
      pool,
      identities.professionalId,
      {
        recommendationId: disposal.id,
        expectedVersion: 1,
        targetStatus: "DEFERRED",
        decisionEvidenceNote: "Lifecycle truth changed after Quote issuance.",
      },
      `post-issue-recommendation-${suffix}`
    );
    assert.equal(changedRecommendation.ok, true, changedRecommendation.code);
    const read = await getDraftQuote({ pool, authenticatedActor: { id: identities.professionalId }, quoteId: quote.id, logger: quiet });
    const listed = await listDraftQuotesByJob({ pool, authenticatedActor: { id: identities.professionalId }, jobId: fixture.jobId, logger: quiet });
    assert.equal(read.quote.status, "ISSUED");
    assert.equal(read.quote.totalMinor, 92000);
    assert.equal(listed.quotes.length, 1);
    assert.equal(read.quote.versions.length, 15);
    assert.deepEqual(JSON.parse(JSON.stringify(read.quote.scopeItems)), frozenScope);
    assert.equal(read.quote.versions.at(-1).integrityHash, frozenHash);
    assert.equal(read.quote.scopeItems.filter((row) => row.source.recommendationId === disposal.id).every((row) => row.source.version === 1), true);

    const customerRead = await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.homeownerId },
      quoteId: issued.id,
      logger: quiet,
    });
    assert.equal(customerRead.code, "CUSTOMER_QUOTE_FOUND");
    assert.equal("authoritySource" in customerRead, false);
    assert.equal(customerRead.quote.status, "ISSUED");
    assert.equal(customerRead.quote.decisionCommandVersion, 15);
    assert.equal(customerRead.quote.totalMinor, 92000);
    assert.equal(customerRead.quote.customerDecision, null);
    assert.deepEqual(customerRead.quote.customerTermsSnapshot, customerTermsSnapshot);
    assert.deepEqual(customerRead.quote.actions, {
      canViewQuote: true,
      canApprove: true,
      canDecline: true,
    });
    assert.equal(customerRead.quote.scopeItems.length, 9);
    assert.equal(customerRead.quote.exclusions.length, 2);
    assert.equal("relationshipId" in customerRead.quote, false);
    assert.equal("issuerParticipantId" in customerRead.quote, false);
    assert.equal("materialsSubtotalMinor" in customerRead.quote, false);
    assert.equal("laborServiceSubtotalMinor" in customerRead.quote, false);
    assert.equal("versions" in customerRead.quote, false);
    assert.equal((await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.occupantId },
      quoteId: issued.id,
      logger: quiet,
    })).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.occupantId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, `occupant-approve-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(declineIssuedQuote, pool, identities.occupantId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, `occupant-decline-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.professionalId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, `professional-approve-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.outsiderId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, `outsider-approve-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");

    const approvalKey = `customer-approve-${suffix}`;
    await assert.rejects(
      quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
        quoteId: issued.id,
        expectedIssuedVersion: issued.currentVersion,
        failureInjector(stage) {
          if (stage === "after_write") throw new Error("injected customer decision rollback");
        },
      }, `rollback-approve-${suffix}`),
      /injected customer decision rollback/
    );
    const rolledBackDecision = await pool.query(
      `SELECT
        (SELECT count(*) FROM canonical_quote_customer_decisions
          WHERE quote_id = $1)::integer AS decisions,
        (SELECT count(*) FROM commercial_command_idempotency
          WHERE idempotency_key = $2)::integer AS command_rows`,
      [issued.id, `rollback-approve-${suffix}`]
    );
    assert.deepEqual(rolledBackDecision.rows[0], { decisions: 0, command_rows: 0 });

    const approved = await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, approvalKey);
    assert.equal(approved.code, "QUOTE_CUSTOMER_DECISION_RECORDED");
    assert.equal(approved.customerDecision.decision, "APPROVED");
    assert.equal(approved.customerDecision.issuedQuoteVersion, 15);
    assert.equal(approved.quote.status, "ISSUED");
    assert.equal(approved.quote.decisionState, "APPROVED");
    assert.equal(approved.quote.totalMinor, 92000);
    assert.equal(approved.quote.versions.at(-1).integrityHash, frozenHash);
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, approvalKey)).replayed, true);
    assert.equal((await quoteCommand(declineIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, approvalKey)).code, "QUOTE_DECISION_FINAL");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion - 1,
    }, approvalKey)).code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
    assert.equal((await quoteCommand(declineIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
    }, `decline-after-approve-${suffix}`)).code, "QUOTE_DECISION_FINAL");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion - 1,
    }, `stale-approve-${suffix}`)).code, "ISSUED_QUOTE_VERSION_REQUIRED");
    const decisionProof = await pool.query(
      `SELECT decisions.decision, decisions.issued_quote_version,
        decisions.customer_participant_id, decisions.issued_integrity_hash,
        grants.capability, commands.command_name
       FROM canonical_quote_customer_decisions decisions
       INNER JOIN lifecycle_authority_grants grants
         ON grants.id = decisions.authority_grant_id
       INNER JOIN commercial_command_idempotency commands
         ON commands.id = decisions.idempotency_id
       WHERE decisions.quote_id = $1`,
      [issued.id]
    );
    assert.deepEqual(decisionProof.rows[0], {
      decision: "APPROVED",
      issued_quote_version: 15,
      customer_participant_id: fixture.homeownerParticipantId,
      issued_integrity_hash: frozenHash,
      capability: "quote.approve",
      command_name: "quote.customer.approve",
    });
    await assert.rejects(
      pool.query(
        `UPDATE canonical_quote_customer_decisions
         SET decision = 'DECLINED' WHERE quote_id = $1`,
        [issued.id]
      ),
      /append-only/
    );
    await assert.rejects(
      pool.query(`DELETE FROM canonical_quote_customer_decisions WHERE quote_id = $1`, [issued.id]),
      /append-only/
    );

    assert.equal((await quoteCommand(createDerivedDraftQuote, pool, identities.homeownerId, {
      parentQuoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
    }, `customer-revision-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");
    const supplementKey = `supplement-${suffix}`;
    const supplement = await quoteCommand(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
    }, supplementKey);
    assert.equal(supplement.code, "DERIVED_DRAFT_QUOTE_CREATED");
    assert.equal(supplement.quote.status, "DRAFT");
    assert.equal(supplement.quote.parentQuoteId, issued.id);
    assert.equal(supplement.quote.lineageType, "SUPPLEMENTAL_QUOTE");
    assert.equal(supplement.quote.scopeItemCount, 0);
    assert.equal(supplement.quote.totalMinor, 0);
    assert.equal(supplement.quote.decisionState, null);
    assert.equal((await quoteCommand(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
      lineageType: "SUPPLEMENTAL_QUOTE",
      reasonCategory: "SUPPLEMENTAL_WORK",
    }, supplementKey)).replayed, true);
    assert.equal((await quoteCommand(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: issued.id,
      expectedIssuedVersion: issued.currentVersion,
      lineageType: "REVISED_QUOTE",
      reasonCategory: "PRICING_CHANGE",
    }, supplementKey)).code, "COMMERCIAL_IDEMPOTENCY_KEY_CONFLICT");
    const r22Supplement = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: supplement.quote.id,
      expectedVersion: 1,
      item: scopeItem({
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "R-22 alternative proposal",
        unitAmountMinor: 35000,
        source: { type: "RECOMMENDATION", recommendationId: r22.id, version: 1 },
      }),
    }, `r22-supplement-${suffix}`);
    assert.equal(r22Supplement.quote.totalMinor, 35000);
    assert.equal(r22Supplement.quote.scopeItemCount, 1);
    assert.equal(r22Supplement.quote.scopeItems[0].includedInTotal, true);
    const approvedParentAfterSupplement = await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.homeownerId },
      quoteId: issued.id,
      logger: quiet,
    });
    assert.equal(approvedParentAfterSupplement.quote.status, "ISSUED");
    assert.equal(approvedParentAfterSupplement.quote.customerDecision, "APPROVED");
    assert.equal(approvedParentAfterSupplement.quote.totalMinor, 92000);
    assert.deepEqual(approvedParentAfterSupplement.quote.actions, {
      canViewQuote: true,
      canApprove: false,
      canDecline: false,
    });
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.professionalId, {
      jobId: fixture.jobId,
      currency: "USD",
    }, `second-root-${suffix}`)).code, "ROOT_QUOTE_ALREADY_EXISTS");

    const declinedIssued = await createSimpleIssuedQuote(
      pool,
      identities,
      declinedFixture,
      `${suffix}-declined`,
      2000,
      customerTermsSnapshot
    );
    const declined = await quoteCommand(declineIssuedQuote, pool, identities.homeownerId, {
      quoteId: declinedIssued.id,
      expectedIssuedVersion: declinedIssued.currentVersion,
    }, `decline-${suffix}`);
    assert.equal(declined.quote.decisionState, "DECLINED");
    assert.equal(
      declined.customerDecision.issuedIntegrityHash,
      declinedIssued.versions.at(-1).integrityHash
    );
    const declinedCustomerRead = await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.homeownerId },
      quoteId: declinedIssued.id,
      logger: quiet,
    });
    assert.equal(declinedCustomerRead.quote.customerDecision, "DECLINED");
    assert.deepEqual(declinedCustomerRead.quote.actions, {
      canViewQuote: true,
      canApprove: false,
      canDecline: false,
    });
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: declinedIssued.id,
      expectedIssuedVersion: declinedIssued.currentVersion,
    }, `approve-after-decline-${suffix}`)).code, "QUOTE_DECISION_FINAL");
    const revised = await quoteCommand(createDerivedDraftQuote, pool, identities.professionalId, {
      parentQuoteId: declinedIssued.id,
      expectedIssuedVersion: declinedIssued.currentVersion,
      lineageType: "REVISED_QUOTE",
      reasonCategory: "CUSTOMER_DECLINED",
    }, `revision-after-decline-${suffix}`);
    assert.equal(revised.quote.status, "DRAFT");
    assert.equal(revised.quote.parentQuoteId, declinedIssued.id);
    assert.equal(revised.quote.decisionState, null);
    assert.equal(declined.quote.status, "ISSUED");
    assert.equal(declined.quote.totalMinor, 2000);

    const raceIssued = await createSimpleIssuedQuote(
      pool,
      identities,
      raceFixture,
      `${suffix}-race`
    );
    const decisionRace = await Promise.all([
      quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
        quoteId: raceIssued.id,
        expectedIssuedVersion: raceIssued.currentVersion,
      }, `race-approve-${suffix}`),
      quoteCommand(declineIssuedQuote, pool, identities.homeownerId, {
        quoteId: raceIssued.id,
        expectedIssuedVersion: raceIssued.currentVersion,
      }, `race-decline-${suffix}`),
    ]);
    assert.deepEqual(
      decisionRace.map((result) => result.code).sort(),
      ["QUOTE_CUSTOMER_DECISION_RECORDED", "QUOTE_DECISION_FINAL"]
    );
    const raceDecisionCount = await pool.query(
      `SELECT count(*)::integer AS count
       FROM canonical_quote_customer_decisions WHERE quote_id = $1`,
      [raceIssued.id]
    );
    assert.equal(raceDecisionCount.rows[0].count, 1);

    const crossDraft = await quoteCommand(createDraftQuote, pool, identities.professionalId, {
      jobId: crossFixture.jobId,
      currency: "USD",
    }, `cross-quote-${suffix}`);
    const raceItem = scopeItem({ classification: "MATERIAL", scopeSemantic: "MATERIAL_EXCLUDED", materialResponsibility: "EXCLUDED", description: "Concurrent excluded item", unitAmountMinor: 1 });
    const raced = await Promise.all([
      quoteCommand(addDraftScopeItem, pool, identities.professionalId, { quoteId: crossDraft.quote.id, expectedVersion: 1, item: raceItem }, `race-a-${suffix}`),
      quoteCommand(addDraftScopeItem, pool, identities.professionalId, { quoteId: crossDraft.quote.id, expectedVersion: 1, item: raceItem }, `race-b-${suffix}`),
    ]);
    assert.deepEqual(raced.map((result) => result.code).sort(), ["QUOTE_SCOPE_ITEM_ADDED", "STALE_QUOTE_VERSION"]);
    const racedQuote = raced.find((result) => result.code === "QUOTE_SCOPE_ITEM_ADDED").quote;
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      quoteId: crossDraft.quote.id,
      expectedVersion: racedQuote.currentVersion,
    }, `excluded-only-issue-${suffix}`)).code, "QUOTE_INCLUDED_SCOPE_REQUIRED");
    const crossIncluded = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: crossDraft.quote.id,
      expectedVersion: racedQuote.currentVersion,
      item: scopeItem({
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Cross-property governed work",
        unitAmountMinor: 1000,
        source: { type: "RECOMMENDATION", recommendationId: crossRecommendation.id, version: 1 },
      }),
    }, `cross-included-${suffix}`);
    assert.equal(crossIncluded.ok, true, crossIncluded.code);
    const crossChanged = await quoteCommand(
      transitionRecommendation,
      pool,
      identities.professionalId,
      {
        recommendationId: crossRecommendation.id,
        expectedVersion: 1,
        targetStatus: "DEFERRED",
      },
      `cross-recommendation-change-${suffix}`
    );
    assert.equal(crossChanged.ok, true, crossChanged.code);
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      quoteId: crossDraft.quote.id,
      expectedVersion: crossIncluded.quote.currentVersion,
    }, `stale-source-issue-${suffix}`)).code, "QUOTE_SOURCE_VERSION_STALE");

    const grant = await pool.query(
      `SELECT id FROM lifecycle_authority_grants
       WHERE grantee_participant_id = $1 AND job_id = $2
         AND capability = 'quote.issue' LIMIT 1`,
      [crossFixture.professionalParticipantId, crossFixture.jobId]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grant_revocations (
        id, authority_grant_id, job_id, revoked_by_participant_id,
        revocation_reason, source_evidence_type, source_evidence_reference,
        idempotency_key
      ) VALUES ($1, $2, $3, $4, 'Local Quote certification',
        'local_certification', $5, $6)`,
      [randomUUID(), grant.rows[0].id, crossFixture.jobId, crossFixture.homeownerParticipantId, suffix, randomUUID()]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id,
        capability, scope_type, scope_job_id, valid_from, valid_until,
        source_evidence_type, source_evidence_reference, idempotency_key
      ) VALUES ($1, $2, $3, $4, 'quote.issue', 'job', $4,
        CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour',
        'local_certification', $5, $6)`,
      [randomUUID(), crossFixture.professionalParticipantId, crossFixture.homeownerParticipantId, crossFixture.jobId, suffix, randomUUID()]
    );
    const customerApproveGrant = await pool.query(
      `SELECT id FROM lifecycle_authority_grants
       WHERE grantee_participant_id = $1 AND job_id = $2
         AND capability = 'quote.approve' LIMIT 1`,
      [crossFixture.homeownerParticipantId, crossFixture.jobId]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grant_revocations (
        id, authority_grant_id, job_id, revoked_by_participant_id,
        revocation_reason, source_evidence_type, source_evidence_reference,
        idempotency_key
      ) VALUES ($1, $2, $3, $4, 'Local customer approval revocation',
        'local_certification', $5, $6)`,
      [randomUUID(), customerApproveGrant.rows[0].id, crossFixture.jobId,
        crossFixture.homeownerParticipantId, suffix, `revoke-customer-approve-${suffix}`]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id,
        capability, scope_type, scope_job_id, valid_from, valid_until,
        source_evidence_type, source_evidence_reference, idempotency_key
      ) VALUES ($1, $2, $3, $4, 'quote.approve', 'job', $4,
        CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour',
        'local_certification', $5, $6)`,
      [randomUUID(), crossFixture.homeownerParticipantId,
        crossFixture.homeownerParticipantId, crossFixture.jobId, suffix,
        `expired-customer-approve-${suffix}`]
    );
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: crossDraft.quote.id,
      expectedIssuedVersion: crossIncluded.quote.currentVersion,
    }, `revoked-expired-customer-approve-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      quoteId: crossDraft.quote.id,
      expectedVersion: crossIncluded.quote.currentVersion,
    }, `revoked-issue-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");

    const legacy = await pool.query(
      `INSERT INTO posts (user_id, title, description, category, location)
       VALUES ($1, 'Legacy Quote request', 'legacy preview remains non-canonical', 'handyman', 'Legacy area')
       RETURNING id, lifecycle_contract_version`,
      [identities.homeownerId]
    );
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.professionalId, {
      jobId: randomUUID(), currency: "USD",
    }, `legacy-${suffix}`)).code, "QUOTE_UNAVAILABLE");
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, {
      quoteId: randomUUID(), expectedVersion: 1,
    }, `legacy-issue-${suffix}`)).code, "QUOTE_UNAVAILABLE");

    const after = await pool.query(
      `SELECT
        (SELECT resolution_state FROM canonical_evaluation_finding_versions
          WHERE finding_id = $1 ORDER BY version DESC LIMIT 1) AS finding_resolution,
        (SELECT state FROM canonical_workstream_versions
          WHERE workstream_id = $2 ORDER BY version DESC LIMIT 1) AS workstream_state,
        (SELECT count(*) FROM jobs WHERE id = $3)::integer AS jobs,
        (SELECT count(*) FROM canonical_quotes WHERE status = 'ISSUED')::integer AS issued_quotes,
        (SELECT count(*) FROM canonical_quotes)::integer AS quote_count,
        (SELECT count(*) FROM canonical_quote_issuances)::integer AS issuances,
        (SELECT count(*) FROM canonical_quote_customer_decisions)::integer AS customer_decisions,
        (SELECT count(*) FROM commercial_authority_evidence
          WHERE evidence_type = 'quote_issued')::integer AS issue_evidence,
        (SELECT count(*) FROM canonical_quote_scope_item_snapshots
          WHERE source_recommendation_id = $4)::integer AS r22_priced,
        (SELECT count(*) FROM quote_requests)::integer AS legacy_quote_requests,
        (SELECT count(*) FROM schema_migrations)::integer AS ledger,
        to_regclass('public.canonical_quote_approvals') IS NULL AS no_approvals,
        to_regclass('public.canonical_procurement') IS NULL AS no_procurement,
        (SELECT lifecycle_contract_version FROM posts WHERE id = $5)::integer AS legacy_contract`,
      [finding.id, workstream.workstream.id, fixture.jobId, r22.id, legacy.rows[0].id]
    );
    assert.deepEqual(after.rows[0], {
      ...before.rows[0],
      issued_quotes: 3,
      quote_count: 6,
      issuances: 3,
      customer_decisions: 3,
      issue_evidence: 3,
      r22_priced: 1,
      legacy_quote_requests: 0,
      ledger: 44,
      no_approvals: true,
      no_procurement: true,
      legacy_contract: 1,
    });
  } finally {
    await pool.end();
  }
});

test("disposable PostgreSQL upgrades 31 to 32 with rollback and no retroactive Quote authority", { skip: !upgradeDatabaseUrl }, async () => {
  const pool = new Pool({ connectionString: upgradeDatabaseUrl, max: 6 });
  const suffix = randomUUID();
  try {
    const migrations = getMigrationFiles();
    const prior = migrations.filter((migration) => migration.filename < migrationName);
    const migration = migrations.find((candidate) => candidate.filename === migrationName);
    assert.equal(prior.length, 31);
    assert.ok(migration);
    const priorResult = await runMigrationCollection(pool, prior, targetMetadata(upgradeDatabaseUrl));
    assert.equal(priorResult.success, true);
    const identities = await createIdentities(pool, `${suffix}-upgrade`);
    const fixture = await createLifecycleFixture(pool, identities, `${suffix}-upgrade`, "pre-Quote lifecycle Job");
    const legacy = await pool.query(
      `INSERT INTO posts (user_id, title, description, category, location)
       VALUES ($1, 'Preserved legacy Quote preview', 'no canonical conversion', 'handyman', 'Legacy area')
       RETURNING id`,
      [identities.homeownerId]
    );
    const forced = await runMigrationCollection(
      pool,
      [{ ...migration, sql: `${migration.sql}\nSELECT * FROM missing_quote_foundation_relation;` }],
      targetMetadata(upgradeDatabaseUrl)
    );
    assert.equal(forced.success, false);
    const rolledBack = await pool.query(
      `SELECT
        (SELECT count(*) FROM schema_migrations)::integer AS ledger,
        to_regclass('public.canonical_quotes') IS NULL AS no_quotes,
        (SELECT count(*) FROM lifecycle_capabilities WHERE capability LIKE 'quote.%')::integer AS quote_capabilities`
    );
    assert.deepEqual(rolledBack.rows[0], { ledger: 31, no_quotes: true, quote_capabilities: 0 });

    const upgraded = await runMigrationCollection(pool, [migration], targetMetadata(upgradeDatabaseUrl));
    assert.equal(upgraded.success, true);
    assert.deepEqual(upgraded.applied, [migrationName]);
    const preserved = await pool.query(
      `SELECT
        (SELECT count(*) FROM canonical_quotes)::integer AS quotes,
        (SELECT count(*) FROM canonical_quote_versions)::integer AS versions,
        (SELECT count(*) FROM canonical_quote_scope_items)::integer AS scope_items,
        (SELECT count(*) FROM lifecycle_authority_grants
          WHERE job_id = $1 AND capability LIKE 'quote.%')::integer AS retroactive_grants,
        (SELECT description FROM posts WHERE id = $2) AS legacy_description,
        (SELECT count(*) FROM schema_migrations)::integer AS ledger`,
      [fixture.jobId, legacy.rows[0].id]
    );
    assert.deepEqual(preserved.rows[0], {
      quotes: 0,
      versions: 0,
      scope_items: 0,
      retroactive_grants: 0,
      legacy_description: "no canonical conversion",
      ledger: 32,
    });
    assert.equal((await quoteCommand(createDraftQuote, pool, identities.professionalId, {
      jobId: fixture.jobId, currency: "USD",
    }, `role-only-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");

    for (const capability of ["quote.create", "quote.read", "quote.scope.manage"]) {
      await pool.query(
        `INSERT INTO lifecycle_authority_grants (
          id, grantee_participant_id, grantor_participant_id, job_id,
          capability, scope_type, scope_job_id,
          source_evidence_type, source_evidence_reference, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, 'job', $4,
          'local_certification', $6, $7)`,
        [randomUUID(), fixture.professionalParticipantId,
          fixture.homeownerParticipantId, fixture.jobId, capability,
          suffix, `${capability}-${suffix}`]
      );
    }
    const scopeOnlyDraft = await quoteCommand(createDraftQuote, pool, identities.professionalId, {
      jobId: fixture.jobId, currency: "USD",
    }, `scope-only-create-${suffix}`);
    assert.equal(scopeOnlyDraft.ok, true, scopeOnlyDraft.code);
    assert.equal((await getCustomerIssuedQuote({
      pool,
      authenticatedActor: { id: identities.homeownerId },
      quoteId: scopeOnlyDraft.quote.id,
      logger: quiet,
    })).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    assert.equal((await quoteCommand(approveIssuedQuote, pool, identities.homeownerId, {
      quoteId: scopeOnlyDraft.quote.id,
      expectedIssuedVersion: 1,
    }, `role-only-customer-approve-${suffix}`)).code, "CUSTOMER_QUOTE_AUTHORITY_REQUIRED");
    const scopeOnlyLine = await quoteCommand(addDraftScopeItem, pool, identities.professionalId, {
      quoteId: scopeOnlyDraft.quote.id,
      expectedVersion: 1,
      item: scopeItem({
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Scope authority without issue authority",
        unitAmountMinor: 1000,
      }),
    }, `scope-only-line-${suffix}`);
    assert.equal(scopeOnlyLine.ok, true, scopeOnlyLine.code);
    const issueInput = {
      quoteId: scopeOnlyDraft.quote.id,
      expectedVersion: scopeOnlyLine.quote.currentVersion,
    };
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, issueInput, `missing-issue-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");

    await pool.query(
      `INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id,
        capability, scope_type, scope_job_id, valid_from, valid_until,
        source_evidence_type, source_evidence_reference, idempotency_key
      ) VALUES ($1, $2, $3, $4, 'quote.issue', 'job', $4,
        CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour',
        'local_certification', $5, $6)`,
      [randomUUID(), fixture.professionalParticipantId,
        fixture.homeownerParticipantId, fixture.jobId, suffix, `expired-issue-${suffix}`]
    );
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, issueInput, `expired-issue-command-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");

    const activeGrantId = randomUUID();
    await pool.query(
      `INSERT INTO lifecycle_authority_grants (
        id, grantee_participant_id, grantor_participant_id, job_id,
        capability, scope_type, scope_job_id,
        source_evidence_type, source_evidence_reference, idempotency_key
      ) VALUES ($1, $2, $3, $4, 'quote.issue', 'job', $4,
        'local_certification', $5, $6)`,
      [activeGrantId, fixture.professionalParticipantId,
        fixture.homeownerParticipantId, fixture.jobId, suffix, `active-issue-${suffix}`]
    );
    await pool.query(
      `INSERT INTO lifecycle_authority_grant_revocations (
        id, authority_grant_id, job_id, revoked_by_participant_id,
        revocation_reason, source_evidence_type, source_evidence_reference,
        idempotency_key
      ) VALUES ($1, $2, $3, $4, 'Local issuance revocation',
        'local_certification', $5, $6)`,
      [randomUUID(), activeGrantId, fixture.jobId,
        fixture.homeownerParticipantId, suffix, `revoke-issue-${suffix}`]
    );
    assert.equal((await quoteCommand(issueQuote, pool, identities.professionalId, issueInput, `revoked-issue-command-${suffix}`)).code, "QUOTE_AUTHORITY_REQUIRED");
    const issueState = await pool.query(
      `SELECT
        (SELECT status FROM canonical_quotes WHERE id = $1) AS status,
        (SELECT count(*) FROM canonical_quote_issuances WHERE quote_id = $1)::integer AS issuances,
        (SELECT count(*) FROM lifecycle_capabilities
          WHERE capability IN ('quote.approve', 'quote.decline'))::integer AS customer_decision_capabilities`,
      [scopeOnlyDraft.quote.id]
    );
    assert.deepEqual(issueState.rows[0], {
      status: "DRAFT",
      issuances: 0,
      customer_decision_capabilities: 2,
    });
  } finally {
    await pool.end();
  }
});

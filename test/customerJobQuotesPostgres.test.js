"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Pool } = require("pg");

const { assertSafeTestDatabaseUrl } = require("./helpers/databaseTargetSafety");
const {
  createVisitLifecycleFixture,
  createVisitTestIdentities,
  quiet,
} = require("./helpers/visitLifecycleFixture");
const {
  addDraftScopeItem,
  approveIssuedQuote,
  createDraftQuote,
  createDerivedDraftQuote,
  issueQuote,
} = require("../server/authorization/quoteDraftService");
const {
  createOrdinaryJobEvaluation,
} = require("../server/authorization/evaluationService");
const {
  getCustomerJobQuotes,
} = require("../server/authorization/customerJobQuotesService");
const { sendQuoteInMeetro } = require("../server/authorization/quoteDeliveryService");
const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const databaseUrl = process.env.CUSTOMER_JOB_QUOTES_DATABASE_URL;

function targetMetadata(url) {
  return {
    target: "local-test",
    database: assertSafeTestDatabaseUrl(url, { nodeEnv: process.env.NODE_ENV }),
  };
}

function command(service, pool, actorId, values, key) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    idempotencyKey: key,
    logger: quiet,
    ...values,
  });
}

async function deliver(pool, identities, quote, key) {
  const result = await sendQuoteInMeetro({
    pool,
    authenticatedActor: { id: identities.professionalId },
    quoteId: quote.id,
    expectedIssuedVersion: quote.currentVersion,
    idempotencyKey: key,
    logger: quiet,
  });
  assert.equal(result.ok, true, result.code);
  return result;
}

async function saveEvaluation(pool, identities, fixture, suffix) {
  const evaluation = await command(
    createOrdinaryJobEvaluation,
    pool,
    identities.professionalId,
    {
      jobId: fixture.jobId,
      content: {
        serviceType: "handyman",
        evaluationContext: "ordinary_job",
        observations: "Saved governed evaluation before Quote issuance.",
        measurements: [],
        findings: [],
        diagnosisSummary: "",
        limitations: "",
        scopeRecommendations: [],
        relevantConditions: [],
        supportingMediaReferences: [],
        internalNotes: "",
      },
      expectedVersion: 0,
    },
    `customer-discovery-evaluation-${suffix}`
  );
  assert.equal(evaluation.ok, true, evaluation.code);
  return evaluation.evaluation;
}

async function addSyntheticScope(pool, identities, quote, suffix) {
  return command(
    addDraftScopeItem,
    pool,
    identities.professionalId,
    {
      quoteId: quote.id,
      expectedVersion: quote.currentVersion,
      item: {
        classification: "LABOR_SERVICE",
        scopeSemantic: "FUTURE_WORK",
        materialResponsibility: "NOT_APPLICABLE",
        description: "Governed synthetic customer Quote discovery work",
        quantity: 1,
        unitAmountMinor: 265000,
        source: { type: "MANUAL_PROFESSIONAL" },
      },
    },
    `customer-discovery-scope-${suffix}`
  );
}

test(
  "disposable PostgreSQL certifies customer Job Quote discovery authority and visibility",
  { skip: !databaseUrl },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const suffix = randomUUID();
    try {
      const migrations = getMigrationFiles();
      const applied = await runMigrationCollection(
        pool,
        migrations,
        targetMetadata(databaseUrl)
      );
      assert.equal(applied.success, true);
      assert.equal(applied.applied.length, migrations.length);

      const identities = await createVisitTestIdentities(pool, suffix, {
        requesterAccountType: "professional",
      });
      const fixture = await createVisitLifecycleFixture(
        pool,
        identities,
        suffix
      );

      const originalDraft = await command(
        createDraftQuote,
        pool,
        identities.professionalId,
        { jobId: fixture.jobId, currency: "USD" },
        `customer-discovery-create-${suffix}`
      );
      assert.equal(originalDraft.ok, true, originalDraft.code);
      const draftRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(draftRead.ok, true);
      assert.deepEqual(draftRead.quotes, []);

      const originalScoped = await addSyntheticScope(
        pool,
        identities,
        originalDraft.quote,
        `${suffix}-original`
      );
      assert.equal(originalScoped.ok, true, originalScoped.code);
      const blockedBeforeEvaluation = await command(
        issueQuote,
        pool,
        identities.professionalId,
        {
          quoteId: originalScoped.quote.id,
          expectedVersion: originalScoped.quote.currentVersion,
        },
        `customer-discovery-issue-before-evaluation-${suffix}`
      );
      assert.equal(blockedBeforeEvaluation.code, "QUOTE_EVALUATION_REQUIRED");
      await saveEvaluation(pool, identities, fixture, suffix);
      const originalIssued = await command(
        issueQuote,
        pool,
        identities.professionalId,
        {
          quoteId: originalScoped.quote.id,
          expectedVersion: originalScoped.quote.currentVersion,
        },
        `customer-discovery-issue-${suffix}`
      );
      assert.equal(originalIssued.ok, true, originalIssued.code);

      const undeliveredRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.deepEqual(undeliveredRead.quotes, []);
      await deliver(
        pool,
        identities,
        originalIssued.quote,
        `customer-discovery-delivery-${suffix}`
      );

      const waitingRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.deepEqual(waitingRead.quotes.map((quote) => ({
        quoteId: quote.quoteId,
        businessStatus: quote.businessStatus,
        lineageLabel: quote.lineageLabel,
        actions: quote.actions,
      })), [{
        quoteId: originalIssued.quote.id,
        businessStatus: "WAITING_ON_CUSTOMER",
        lineageLabel: "Original",
        actions: {
          canViewQuote: true,
          canApprove: true,
          canDecline: true,
        },
      }]);

      const approved = await command(
        approveIssuedQuote,
        pool,
        identities.homeownerId,
        {
          quoteId: originalIssued.quote.id,
          expectedIssuedVersion: originalIssued.quote.currentVersion,
        },
        `customer-discovery-approve-${suffix}`
      );
      assert.equal(approved.ok, true, approved.code);

      const additionalDraft = await command(
        createDerivedDraftQuote,
        pool,
        identities.professionalId,
        {
          parentQuoteId: originalIssued.quote.id,
          expectedIssuedVersion: originalIssued.quote.currentVersion,
          lineageType: "SUPPLEMENTAL_QUOTE",
          reasonCategory: "SUPPLEMENTAL_WORK",
        },
        `customer-discovery-additional-${suffix}`
      );
      assert.equal(additionalDraft.ok, true, additionalDraft.code);
      const draftContained = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.deepEqual(draftContained.quotes.map(({ quoteId }) => quoteId), [
        originalIssued.quote.id,
      ]);

      const additionalScoped = await addSyntheticScope(
        pool,
        identities,
        additionalDraft.quote,
        `${suffix}-additional`
      );
      assert.equal(additionalScoped.ok, true, additionalScoped.code);
      const additionalIssued = await command(
        issueQuote,
        pool,
        identities.professionalId,
        {
          quoteId: additionalScoped.quote.id,
          expectedVersion: additionalScoped.quote.currentVersion,
        },
        `customer-discovery-additional-issue-${suffix}`
      );
      assert.equal(additionalIssued.ok, true, additionalIssued.code);
      await deliver(
        pool,
        identities,
        additionalIssued.quote,
        `customer-discovery-additional-delivery-${suffix}`
      );

      const multipleRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.deepEqual(multipleRead.quotes.map((quote) => ({
        quoteId: quote.quoteId,
        businessStatus: quote.businessStatus,
        lineageLabel: quote.lineageLabel,
        canApprove: quote.actions.canApprove,
      })), [
        {
          quoteId: additionalIssued.quote.id,
          businessStatus: "WAITING_ON_CUSTOMER",
          lineageLabel: "Additional",
          canApprove: true,
        },
        {
          quoteId: originalIssued.quote.id,
          businessStatus: "APPROVED",
          lineageLabel: "Original",
          canApprove: false,
        },
      ]);

      const outsiderRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.outsiderId },
        jobId: fixture.jobId,
      });
      assert.equal(outsiderRead.code, "CUSTOMER_JOB_QUOTES_UNAVAILABLE");

      const readGrant = await pool.query(
        `SELECT grants.id
         FROM lifecycle_authority_grants grants
         LEFT JOIN lifecycle_authority_grant_revocations revocations
           ON revocations.authority_grant_id = grants.id
         WHERE grants.grantee_participant_id = $1
           AND grants.job_id = $2
           AND grants.capability = 'quote.read_customer'
           AND revocations.id IS NULL
         LIMIT 1`,
        [fixture.homeownerParticipantId, fixture.jobId]
      );
      await pool.query(
        `INSERT INTO lifecycle_authority_grant_revocations (
          id, authority_grant_id, job_id, revoked_by_participant_id,
          revocation_reason, source_evidence_type,
          source_evidence_reference, idempotency_key
        ) VALUES ($1, $2, $3, $4, 'Disposable discovery certification',
          'local_certification', $5, $6)`,
        [
          randomUUID(),
          readGrant.rows[0].id,
          fixture.jobId,
          fixture.homeownerParticipantId,
          suffix,
          `customer-discovery-revoke-${suffix}`,
        ]
      );
      const revokedRead = await getCustomerJobQuotes({
        pool,
        authenticatedActor: { id: identities.homeownerId },
        jobId: fixture.jobId,
      });
      assert.equal(revokedRead.code, "CUSTOMER_JOB_QUOTES_UNAVAILABLE");
    } finally {
      await pool.end();
    }
  }
);

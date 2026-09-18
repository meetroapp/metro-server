"use strict";

const {
  archiveBusinessContact,
  endBusinessContactRole,
} = require("../server/contacts/businessContactService");

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const {
  getMigrationFiles,
  runMigrationCollection,
} = require("../scripts/run-migrations");

const {
  createBusinessCustomerJob,
} = require("../server/relationships/businessCustomerJobService");

const {
  createOrdinaryJobEvaluation,
  completeEvaluation,
} = require("../server/authorization/evaluationService");

const {
  createDraftQuote,
  addDraftScopeItem,
  issueQuote,
  recordExternalQuoteApproval,
} = require("../server/authorization/quoteDraftService");

const {
  confirmDepositReceived,
} = require("../server/finance/preWorkDepositService");

const {
  createWorkstream,
} = require("../server/workflow/workstreamService");

const {
  materializeApprovedWorkExecution,
  bindWorkstreamToExecution,
  completeApprovedWork,
} = require("../server/workflow/approvedWorkExecutionService");

const {
  materializeWorkPreparation,
  reviseWorkPreparation,
} = require("../server/workflow/workPreparationService");

const {
  activateApprovedWorkVisitAuthority,
} = require("../server/workflow/approvedWorkVisitService");

const {
  proposeVisit,
  startVisit,
  completeVisit,
} = require("../server/workflow/visitService");

const {
  recordExternalVisitConfirmation,
} = require("../server/workflow/externalVisitConfirmationService");

const {
  getJobCompletionReview,
  completeJob,
  getProfessionalJobHistory,
} = require("../server/workflow/jobCompletionService");

const {
  createInvoice,
  issueInvoiceExternally,
  recordPayment,
  getProfessionalJobInvoice,
} = require("../server/finance/invoicePaymentService");

const {
  getBusinessCustomerRelationshipActivity,
} = require("../server/relationships/businessCustomerRelationshipService");

const databaseUrl =
  process.env.BUSINESS_CUSTOMER_FULL_LIFECYCLE_DATABASE_URL;

const quiet = {
  info() {},
  warn() {},
  error() {},
};

function ok(result) {
  assert.equal(
    result?.ok,
    true,
    JSON.stringify(result)
  );

  return result;
}

function command(service, pool, actorId, values = {}) {
  return service({
    pool,
    authenticatedActor: { id: actorId },
    logger: quiet,
    idempotencyKey: randomUUID(),
    ...values,
  });
}

function customerTerms() {
  return {
    schemaVersion: 1,
    paymentTerms:
      "75% deposit required before scheduling.",
    estimatedDuration: "1 day",
    customerNotes: "",
    agreement: {
      exclusions: [],
      additionalWorkTerms:
        "Written customer approval is required.",
      hiddenConditionsTerms:
        "Hidden conditions require a revised Quote.",
      diagnosticTerms:
        "Diagnostic work is limited to the stated scope.",
      customerResponsibilities:
        "Provide safe site access.",
      warrantyTerms:
        "One-year workmanship warranty.",
      cancellationTerms:
        "Cancellation terms apply as stated.",
      acceptanceTerms:
        "Approval accepts this exact issued Quote.",
      preauthorizedAdditionalWorkLimit: "$0",
    },
  };
}

test(
  "disposable PostgreSQL certifies full business_customer lifecycle without fabricated Meetro authority",
  { skip: !databaseUrl },
  async () => {
    const database =
      assertSafeTestDatabaseUrl(
        databaseUrl,
        { nodeEnv: process.env.NODE_ENV }
      );

    const pool = new Pool({
      connectionString: databaseUrl,
      max: 12,
    });

    try {
      /*
       * Governed schema generation.
       */
      const migrations = getMigrationFiles();

      assert.equal(migrations.length, 99);
      assert.equal(
        migrations.at(-1).filename,
        "202609160015_generalize_invoice_job_origins.sql"
      );

      const migrated =
        await runMigrationCollection(
          pool,
          migrations,
          {
            target: "local-test",
            database,
          }
        );

      assert.equal(migrated.success, true);
      assert.equal(migrated.applied.length, 99);

      const suffix = randomUUID();

      /*
       * Business professional.
       */
      const professional =
        (
          await pool.query(
            `INSERT INTO users
              (
                username,
                email,
                password_hash,
                business_name,
                business_category,
                role,
                account_type
              )
             VALUES
              (
                $1,
                $2,
                'test-only',
                'Origin Four Certification Business',
                'Testing',
                'handyman',
                'professional'
              )
             RETURNING id`,
            [
              `origin-four-${suffix}`,
              `origin-four-${suffix}@example.test`,
            ]
          )
        ).rows[0];

      const professionalId =
        Number(professional.id);

      const profile =
        (
          await pool.query(
            `INSERT INTO contractor_profiles
              (
                user_id,
                business_name,
                category
              )
             VALUES
              (
                $1,
                'Origin Four Certification Business',
                'Testing'
              )
             RETURNING id`,
            [professionalId]
          )
        ).rows[0];

      const contractorProfileId =
        Number(profile.id);

      /*
       * Real business-owned Customer.
       */
      const contact =
        (
          await pool.query(
            `INSERT INTO business_contacts
              (
                contractor_profile_id,
                created_by_user_id,
                party_type,
                display_name,
                email,
                address_text
              )
             VALUES
              (
                $1,
                $2,
                'PERSON',
                'Origin Four External Customer',
                'origin-four-customer@example.test',
                '123 Customer Record Address'
              )
             RETURNING id`,
            [
              contractorProfileId,
              professionalId,
            ]
          )
        ).rows[0];

      const businessContactId =
        contact.id;

      await pool.query(
        `INSERT INTO business_contact_roles
          (
            business_contact_id,
            contractor_profile_id,
            role,
            assigned_by_user_id
          )
         VALUES
          (
            $1,
            $2,
            'CUSTOMER',
            $3
          )`,
        [
          businessContactId,
          contractorProfileId,
          professionalId,
        ]
      );

      const relationship =
        (
          await pool.query(
            `INSERT INTO business_customer_relationships
              (
                contractor_profile_id,
                business_contact_id,
                established_by_user_id
              )
             VALUES ($1,$2,$3)
             RETURNING id`,
            [
              contractorProfileId,
              businessContactId,
              professionalId,
            ]
          )
        ).rows[0];

      const customerRelationshipId =
        relationship.id;

      const initialUserCount =
        Number(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
               FROM users`
            )
          ).rows[0].count
        );

      /*
       * TRUE Origin 4 Job.
       */
      const createdJob =
        await createBusinessCustomerJob({
          pool,
          authenticatedActor: {
            id: professionalId,
          },
          relationshipId:
            customerRelationshipId,
          payload: {
            projectTitle:
              "Origin Four governed external repair",
            projectDescription:
              "Inspect and complete the approved external-customer repair.",
            serviceLocation: {
              mode: "STRUCTURED",
              addressLine1:
                "456 Certification Avenue",
              city: "Cape Coral",
              region: "FL",
              postalCode: "33990",
              countryCode: "US",
            },
          },
          idempotencyKey:
            randomUUID(),
          logger: quiet,
        });

      assert.equal(
        createdJob.ok,
        true,
        createdJob.code
      );

      assert.equal(
        createdJob.job.sourceType,
        "business_customer"
      );

      const jobId =
        createdJob.job.id;

      const businessCustomerJobSourceId =
        createdJob.job.sourceId;

      const job =
        (
          await pool.query(
            `SELECT *
             FROM jobs
             WHERE id = $1`,
            [jobId]
          )
        ).rows[0];

      assert.equal(
        job.source_type,
        "business_customer"
      );

      assert.equal(
        job.job_request_id,
        null
      );

      assert.equal(
        job.source_request_selection_id,
        null
      );

      assert.equal(
        job.source_request_relationship_id,
        null
      );

      assert.equal(
        job.originating_business_document_id,
        null
      );

      assert.equal(
        job.source_business_customer_job_id,
        businessCustomerJobSourceId
      );

      /*
       * Job Evaluation.
       *
       * Despite the legacy function name,
       * createOrdinaryJobEvaluation is the generalized
       * Job Evaluation command and resolves source truth
       * directly from the Job.
       */
      const evaluation =
        await createOrdinaryJobEvaluation({
          pool,
          authenticatedActor: {
            id: professionalId,
          },
          jobId,
          content: {
            observations:
              "Remote assessment confirms the repair can proceed under the documented scope.",
          },
          expectedVersion: 0,
          idempotencyKey:
            randomUUID(),
          logger: quiet,
        });

      assert.equal(
        evaluation.ok,
        true,
        evaluation.code
      );

      assert.equal(
        evaluation.aggregate.sourceContext.type,
        "business_customer_job"
      );

      assert.equal(
        evaluation.aggregate.sourceContext
          .businessCustomerJobSourceId,
        businessCustomerJobSourceId
      );

      const evaluationId =
        evaluation.evaluation.id;

      /*
       * Quote can be drafted before Evaluation completion,
       * but cannot be ISSUED.
       */
      const draft =
        ok(
          await command(
            createDraftQuote,
            pool,
            professionalId,
            {
              jobId,
              currency: "USD",
              customerTermsSnapshot:
                customerTerms(),
            }
          )
        ).quote;

      const scoped =
        ok(
          await command(
            addDraftScopeItem,
            pool,
            professionalId,
            {
              quoteId: draft.id,
              expectedVersion:
                draft.currentVersion,
              item: {
                classification:
                  "LABOR_SERVICE",
                scopeSemantic:
                  "FUTURE_WORK",
                materialResponsibility:
                  "NOT_APPLICABLE",
                description:
                  "Complete governed Origin Four external repair",
                quantity: 1,
                unitAmountMinor: 68000,
                source: {
                  type:
                    "MANUAL_PROFESSIONAL",
                },
              },
            }
          )
        ).quote;

      const premature =
        await command(
          issueQuote,
          pool,
          professionalId,
          {
            quoteId: draft.id,
            expectedVersion:
              scoped.currentVersion,
          }
        );

      assert.equal(
        premature.ok,
        false
      );

      assert.equal(
        premature.code,
        "QUOTE_EVALUATION_REQUIRED"
      );

      /*
       * Complete Evaluation remotely.
       */
      const completedEvaluation =
        await completeEvaluation({
          pool,
          authenticatedActor: {
            id: professionalId,
          },
          evaluationId,
          expectedVersion: 1,
          completionMode: "REMOTE",
          assessmentMethod: "PHONE",
          assessmentBasis:
            "Reviewed the Origin Four external repair with the customer by phone.",
          idempotencyKey:
            randomUUID(),
          logger: quiet,
        });

      assert.equal(
        completedEvaluation.ok,
        true,
        completedEvaluation.code
      );

      assert.equal(
        completedEvaluation
          .evaluation.status,
        "completed"
      );

      assert.equal(
        completedEvaluation
          .aggregate.sourceContext.type,
        "business_customer_job"
      );

      /*
       * Now issuance is permitted.
       */
      const issued =
        ok(
          await command(
            issueQuote,
            pool,
            professionalId,
            {
              quoteId: draft.id,
              expectedVersion:
                scoped.currentVersion,
            }
          )
        ).quote;

      const quoteTruth =
        (
          await pool.query(
            `SELECT
               source_context_type,
               job_source_type,
               job_request_id,
               relationship_id,
               business_customer_job_source_id
             FROM canonical_quotes
             WHERE id = $1`,
            [issued.id]
          )
        ).rows[0];

      assert.equal(
        quoteTruth.source_context_type,
        "business_customer"
      );

      assert.equal(
        quoteTruth.job_source_type,
        "business_customer"
      );

      assert.equal(
        quoteTruth.job_request_id,
        null
      );

      assert.equal(
        quoteTruth.relationship_id,
        null
      );

      assert.equal(
        quoteTruth.business_customer_job_source_id,
        businessCustomerJobSourceId
      );

      /*
       * Professional records external approval evidence.
       */
      const issuance =
        (
          await pool.query(
            `SELECT issued_at
             FROM canonical_quote_issuances
             WHERE quote_id = $1`,
            [issued.id]
          )
        ).rows[0];

      ok(
        await recordExternalQuoteApproval({
          pool,
          authenticatedActor: {
            id: professionalId,
          },
          quoteId: issued.id,
          expectedIssuedVersion:
            issued.currentVersion,
          evidenceMethod: "PHONE",
          approvedAt:
            new Date(
              issuance.issued_at
            ).toISOString(),
          evidenceReference:
            "External customer approved the exact issued Quote by phone.",
          evidenceNote:
            "Origin Four PostgreSQL certification.",
          idempotencyKey:
            randomUUID(),
          logger: quiet,
        })
      );

      const approval =
        (
          await pool.query(
            `SELECT *
             FROM canonical_quote_approvals
             WHERE quote_id = $1`,
            [issued.id]
          )
        ).rows[0];

      assert.equal(
        approval.approval_source,
        "EXTERNAL_EVIDENCE"
      );

      assert.equal(
        approval.customer_decision_id,
        null
      );

      assert.ok(
        approval.external_approval_evidence_id
      );

      /*
       * Deposit automatically exists from exact approval.
       */
      const deposit =
        (
          await pool.query(
            `SELECT
               obligations.id,
               obligations.required_minor,
               versions.version,
               versions.state
             FROM canonical_pre_work_deposit_obligations
               obligations
             JOIN LATERAL (
               SELECT
                 version,
                 state
               FROM canonical_pre_work_deposit_versions
               WHERE obligation_id =
                     obligations.id
               ORDER BY version DESC
               LIMIT 1
             ) versions
               ON TRUE
             WHERE obligations.job_id = $1
               AND obligations.quote_approval_id = $2`,
            [
              jobId,
              approval.id,
            ]
          )
        ).rows[0];

      assert.equal(
        Number(deposit.required_minor),
        51000
      );

      assert.equal(
        deposit.state,
        "DUE"
      );

      /*
       * Partial payment remains locked.
       */
      const partial =
        ok(
          await confirmDepositReceived({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
            amountMinor: 10000,
            currency: "USD",
            normalizedMethod:
              "EXTERNAL_TRANSFER",
            displayMethod:
              "External transfer",
            externalReference:
              `origin-four-partial-${suffix}`,
            receivedAt:
              new Date().toISOString(),
            expectedVersion:
              Number(deposit.version),
            idempotencyKey:
              randomUUID(),
            logger: quiet,
          })
        ).deposit;

      assert.equal(
        partial.state,
        "PARTIALLY_SATISFIED"
      );

      const locked =
        await command(
          activateApprovedWorkVisitAuthority,
          pool,
          professionalId,
          {
            jobId,
            quoteId: issued.id,
          }
        );

      assert.equal(
        locked.ok,
        false
      );

      assert.equal(
        locked.code,
        "DEPOSIT_REQUIRED_BEFORE_SCHEDULING"
      );

      /*
       * Remaining deposit satisfies gate.
       */
      const satisfied =
        ok(
          await confirmDepositReceived({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
            amountMinor: 41000,
            currency: "USD",
            normalizedMethod:
              "EXTERNAL_TRANSFER",
            displayMethod:
              "External transfer",
            externalReference:
              `origin-four-balance-${suffix}`,
            receivedAt:
              new Date().toISOString(),
            expectedVersion: 2,
            idempotencyKey:
              randomUUID(),
            logger: quiet,
          })
        ).deposit;

      assert.equal(
        satisfied.state,
        "SATISFIED"
      );

      /*
       * Governed Work execution roots.
       */
      const workstream =
        ok(
          await command(
            createWorkstream,
            pool,
            professionalId,
            {
              jobId,
              title:
                "Origin Four approved repair",
              sequence: 1,
            }
          )
        ).workstream;

      const execution =
        ok(
          await command(
            materializeApprovedWorkExecution,
            pool,
            professionalId,
            {
              jobId,
              quoteApprovalId:
                approval.id,
            }
          )
        ).execution;

      ok(
        await command(
          bindWorkstreamToExecution,
          pool,
          professionalId,
          {
            jobId,
            executionId:
              execution.id,
            workstreamId:
              workstream.id,
            expectedExecutionVersion:
              1,
          }
        )
      );

      const preparation =
        ok(
          await command(
            materializeWorkPreparation,
            pool,
            professionalId,
            {
              jobId,
              quoteApprovalId:
                approval.id,
            }
          )
        ).workPreparation;

      ok(
        await command(
          reviseWorkPreparation,
          pool,
          professionalId,
          {
            jobId,
            planId:
              preparation.id,
            expectedVersion: 1,
            planningState:
              "PLANNED",
            workStartPolicy:
              "NONE",
            items: [],
          }
        )
      );

      /*
       * Satisfied deposit unlocks Approved Work Visit.
       */
      ok(
        await command(
          activateApprovedWorkVisitAuthority,
          pool,
          professionalId,
          {
            jobId,
            quoteId: issued.id,
          }
        )
      );

      const visit =
        ok(
          await command(
            proposeVisit,
            pool,
            professionalId,
            {
              jobId,
              quoteApprovalId:
                approval.id,
              purpose:
                "APPROVED_WORK",
              scheduledStartAt:
                new Date(
                  Date.now() +
                    60 * 60 * 1000
                ).toISOString(),
              scheduledEndAt:
                new Date(
                  Date.now() +
                    2 * 60 * 60 * 1000
                ).toISOString(),
              timeZone:
                "America/New_York",
              locationMode:
                "JOB_SERVICE_LOCATION",
            }
          )
        ).visit;

      ok(
        await command(
          recordExternalVisitConfirmation,
          pool,
          professionalId,
          {
            jobId,
            visitId: visit.id,
            expectedVersion: 1,
            quoteApprovalId:
              approval.id,
            evidenceMethod:
              "PHONE",
            confirmedAt:
              new Date().toISOString(),
            evidenceReference:
              "External customer confirmed the approved-work appointment by phone.",
          }
        )
      );

      const started =
        ok(
          await command(
            startVisit,
            pool,
            professionalId,
            {
              jobId,
              visitId: visit.id,
              expectedVersion: 2,
              approvedWorkExecutionId:
                execution.id,
              expectedExecutionVersion:
                1,
              acknowledgeScheduleVariance:
                true,
            }
          )
        ).visit;

      assert.equal(
        started.state,
        "STARTED"
      );

      const finishedVisit =
        ok(
          await command(
            completeVisit,
            pool,
            professionalId,
            {
              jobId,
              visitId: visit.id,
              expectedVersion: 3,
            }
          )
        ).visit;

      assert.equal(
        finishedVisit.state,
        "COMPLETED"
      );

      const finishedWork =
        await command(
          completeApprovedWork,
          pool,
          professionalId,
          {
            jobId,
            executionId:
              execution.id,
            expectedExecutionVersion:
              1,
            expectedWorkstreams: [
              {
                workstreamId:
                  workstream.id,
                expectedVersion: 1,
              },
            ],
            expectedActivities: [],
          }
        );

      assert.equal(
        finishedWork.ok,
        true,
        finishedWork.code
      );

      assert.equal(
        finishedWork.code,
        "APPROVED_WORK_COMPLETED"
      );

      /*
       * Canonical Job completion.
       */
      const review =
        ok(
          await getJobCompletionReview({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
            logger: quiet,
          })
        ).completionReview;

      assert.equal(
        review.authority.kind,
        "BUSINESS_CUSTOMER"
      );

      assert.equal(
        review.canComplete,
        true
      );

      const completed =
        ok(
          await command(
            completeJob,
            pool,
            professionalId,
            {
              jobId,
              expectedVersion:
                review.currentVersion,
            }
          )
        ).completion;

      assert.equal(
        completed.status,
        "COMPLETED"
      );

      /*
       * Final Invoice.
       */
      let invoice =
        ok(
          await createInvoice({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
            expectedCompletionVersion:
              1,
            due: {
              mode:
                "DUE_ON_RECEIPT",
              date: null,
            },
            idempotencyKey:
              randomUUID(),
            logger: quiet,
          })
        ).invoice;

      assert.equal(
        invoice.totalMinor,
        68000
      );

      assert.equal(
        invoice.paidMinor,
        51000
      );

      assert.equal(
        invoice.balanceMinor,
        17000
      );

      invoice =
        ok(
          await issueInvoiceExternally({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            invoiceId:
              invoice.invoiceId,
            expectedVersion:
              invoice.currentVersion,
            idempotencyKey:
              randomUUID(),
            logger: quiet,
          })
        ).invoice;

      invoice =
        ok(
          await recordPayment({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            invoiceId:
              invoice.invoiceId,
            expectedVersion:
              invoice.currentVersion,
            amountMinor: 17000,
            method: "CASH",
            receivedDate:
              new Date()
                .toISOString()
                .slice(0, 10),
            idempotencyKey:
              randomUUID(),
            logger: quiet,
          })
        ).invoice;

      assert.equal(
        invoice.status,
        "PAID"
      );

      assert.equal(
        invoice.balanceMinor,
        0
      );

      const reopened =
        ok(
          await getProfessionalJobInvoice({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
          })
        ).invoice;

      assert.equal(
        reopened.invoiceId,
        invoice.invoiceId
      );

      /*
       * Durable business customer activity.
       */
      const activity =
        ok(
          await getBusinessCustomerRelationshipActivity({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            relationshipId:
              customerRelationshipId,
          })
        ).activity;

      assert.ok(
        activity.work.some(
          (row) =>
            row.jobId === jobId &&
            row.status ===
              "COMPLETED"
        )
      );

      assert.ok(
        activity.quotes.some(
          (row) =>
            row.quoteId ===
              issued.id &&
            row.customerDecision ===
              "APPROVED"
        )
      );

      assert.ok(
        activity.invoices.some(
          (row) =>
            row.invoiceId ===
              invoice.invoiceId &&
            row.paidMinor ===
              68000
        )
      );

      /*
       * End current action authority.
       * Immutable completed History must survive.
       */
      const contactAuthorityBeforeEnd =
        (
          await pool.query(
            `SELECT
               contacts.version
                 AS contact_version,
               roles.id
                 AS role_id
             FROM business_contacts contacts

             INNER JOIN business_contact_roles roles
               ON roles.business_contact_id =
                  contacts.id
              AND roles.contractor_profile_id =
                  contacts.contractor_profile_id

             WHERE contacts.id = $1
               AND contacts.contractor_profile_id = $2
               AND contacts.status = 'ACTIVE'
               AND roles.role = 'CUSTOMER'
               AND roles.ended_at IS NULL

             LIMIT 1`,
            [
              businessContactId,
              contractorProfileId,
            ]
          )
        ).rows[0];

      assert.ok(
        contactAuthorityBeforeEnd
      );

      const endedCustomerRole =
        ok(
          await endBusinessContactRole({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            contactId:
              businessContactId,
            roleId:
              contactAuthorityBeforeEnd
                .role_id,
            payload: {
              expectedVersion:
                Number(
                  contactAuthorityBeforeEnd
                    .contact_version
                ),
            },
            idempotencyKey:
              randomUUID(),
          })
        ).contact;

      assert.equal(
        endedCustomerRole.roles.find(
          (role) =>
            role.role === "CUSTOMER"
        )?.active,
        false
      );

      const archivedContact =
        ok(
          await archiveBusinessContact({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            contactId:
              businessContactId,
            payload: {
              expectedVersion:
                endedCustomerRole.version,
            },
            idempotencyKey:
              randomUUID(),
          })
        ).contact;

      assert.equal(
        archivedContact.status,
        "ARCHIVED"
      );

      assert.equal(
        archivedContact.version,
        endedCustomerRole.version + 1
      );

      const history =
        ok(
          await getProfessionalJobHistory({
            pool,
            authenticatedActor: {
              id: professionalId,
            },
            jobId,
          })
        ).jobHistory;

      assert.equal(
        history.audience,
        "professional"
      );

      assert.equal(
        history.approvedQuote.totalMinor,
        68000
      );

      /*
       * Absolutely no fabricated Meetro customer authority.
       */
      const userCount =
        Number(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
               FROM users`
            )
          ).rows[0].count
        );

      assert.equal(
        userCount,
        initialUserCount
      );

      const participantTruth =
        await pool.query(
          `SELECT
             user_id,
             request_relationship_id,
             source_evidence_type
           FROM relationship_participants
           WHERE job_id = $1`,
          [jobId]
        );

      assert.equal(
        participantTruth.rowCount,
        1
      );

      assert.equal(
        Number(
          participantTruth.rows[0]
            .user_id
        ),
        professionalId
      );

      assert.equal(
        participantTruth.rows[0]
          .request_relationship_id,
        null
      );

      assert.equal(
        participantTruth.rows[0]
          .source_evidence_type,
        "business_customer"
      );

      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
               FROM canonical_quote_customer_decisions
               WHERE job_id = $1`,
              [jobId]
            )
          ).rows[0].count
        ),
        0
      );

      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
               FROM participant_role_assignments
               WHERE job_id = $1
                 AND role =
                     'CUSTOMER_REPRESENTATIVE'`,
              [jobId]
            )
          ).rows[0].count
        ),
        0
      );

      assert.equal(
        Number(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
               FROM conversations
               WHERE professional_user_id = $1`,
              [professionalId]
            )
          ).rows[0].count
        ),
        0
      );

      /*
       * Exact terminal canonical truth.
       */
      const truthResult =
        await pool.query(
          `SELECT
             jobs.source_type,
             jobs.job_request_id,
             jobs.source_request_selection_id,
             jobs.source_request_relationship_id,
             jobs.originating_business_document_id,
             jobs.source_business_customer_job_id,

             approvals.approval_source,
             approvals.customer_decision_id,
             approvals.external_approval_evidence_id,

             deposits.relationship_id
               AS deposit_relationship_id,

             deposit_versions.state
               AS deposit_state,

             executions.approval_source
               AS execution_approval_source,

             execution_versions.state
               AS execution_state,

             completions.status
               AS completion_status

           FROM jobs

           INNER JOIN canonical_quote_approvals
             approvals
             ON approvals.job_id =
                jobs.id
            AND approvals.decision =
                'APPROVED'

           INNER JOIN canonical_pre_work_deposit_obligations
             deposits
             ON deposits.job_id =
                jobs.id
            AND deposits.quote_approval_id =
                approvals.id

           INNER JOIN LATERAL (
             SELECT state
             FROM canonical_pre_work_deposit_versions
             WHERE obligation_id =
                   deposits.id
             ORDER BY version DESC
             LIMIT 1
           ) deposit_versions
             ON TRUE

           INNER JOIN canonical_approved_work_executions
             executions
             ON executions.job_id =
                jobs.id
            AND executions.quote_approval_id =
                approvals.id

           INNER JOIN LATERAL (
             SELECT state
             FROM canonical_approved_work_execution_versions
             WHERE execution_id =
                   executions.id
             ORDER BY version DESC
             LIMIT 1
           ) execution_versions
             ON TRUE

           INNER JOIN canonical_job_completion_records
             completions
             ON completions.job_id =
                jobs.id

           WHERE jobs.id = $1`,
          [jobId]
        );

      assert.equal(
        truthResult.rowCount,
        1
      );

      const truth =
        truthResult.rows[0];

      assert.equal(
        truth.source_type,
        "business_customer"
      );

      assert.equal(
        truth.job_request_id,
        null
      );

      assert.equal(
        truth.source_request_selection_id,
        null
      );

      assert.equal(
        truth.source_request_relationship_id,
        null
      );

      assert.equal(
        truth.originating_business_document_id,
        null
      );

      assert.equal(
        truth.source_business_customer_job_id,
        businessCustomerJobSourceId
      );

      assert.equal(
        truth.approval_source,
        "EXTERNAL_EVIDENCE"
      );

      assert.equal(
        truth.customer_decision_id,
        null
      );

      assert.ok(
        truth.external_approval_evidence_id
      );

      assert.equal(
        truth.deposit_relationship_id,
        null
      );

      assert.equal(
        truth.deposit_state,
        "SATISFIED"
      );

      assert.equal(
        truth.execution_approval_source,
        "EXTERNAL_EVIDENCE"
      );

      assert.equal(
        truth.execution_state,
        "CLOSED"
      );

      assert.equal(
        truth.completion_status,
        "COMPLETED"
      );
    } finally {
      await pool.end();
    }
  }
);

"use strict";

const { randomUUID } = require("node:crypto");
const { commercialAuthorityInternals } = require("../authorization/commercialAuthorityService");
const { hasActiveLifecycleGrant } = require("../authorization/lifecycleAuthorityService");
const { evaluateApprovedWorkDepositGateWithClient, schedulingGateFailure } = require("../finance/preWorkDepositService");
const { visitServiceInternals } = require("./visitService");
const { failure, fingerprint, normalizedUuid } = commercialAuthorityInternals;
const { validatedVersionCommand, runTransaction, requireActorRole, loadVisit, reserveCommand,
  completeCommand, insertVisitVersion, insertVisitEvent, currentSchedule, currentInstant,
  strictInstant, visitProjection } = visitServiceInternals;
const EXTERNAL_CONFIRMATION_CAPABILITY = "visit.external_confirmation.record";
const METHODS = new Set(["PHONE","EMAIL","TEXT_MESSAGE","IN_PERSON","OTHER"]);

function evidenceText(value, maximum) {
  if (value == null) return null;
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= maximum
    ? value.trim() : undefined;
}

async function recordExternalVisitConfirmation(input = {}) {
  const command =
    validatedVersionCommand(
      input,
      [
        "quoteApprovalId",
        "expectedProposalIntegrityHash",
        "evidenceMethod",
        "confirmedAt",
        "evidenceReference",
        "evidenceNote",
      ],
      "INVALID_EXTERNAL_VISIT_CONFIRMATION"
    );

  if (command.error) {
    return command.error;
  }

  const {
    validated,
    jobId,
    visitId,
    expectedVersion,
  } = command;

  const quoteApprovalId =
    input.quoteApprovalId == null
      ? null
      : normalizedUuid(
          input.quoteApprovalId
        );

  const confirmedAt =
    strictInstant(
      input.confirmedAt
    );

  const reference =
    evidenceText(
      input.evidenceReference,
      1000
    );

  const note =
    evidenceText(
      input.evidenceNote,
      8000
    );

  if (
    !METHODS.has(
      input.evidenceMethod
    ) ||
    !confirmedAt ||
    (
      input.quoteApprovalId != null &&
      !quoteApprovalId
    ) ||
    reference === undefined ||
    note === undefined ||
    (!reference && !note) ||
    (
      input.expectedProposalIntegrityHash != null &&
      !/^[0-9a-f]{64}$/.test(
        input.expectedProposalIntegrityHash
      )
    )
  ) {
    return failure(
      400,
      "INVALID_EXTERNAL_VISIT_CONFIRMATION",
      "Valid external customer confirmation evidence is required."
    );
  }

  const logger =
    input.logger || console;

  return runTransaction(
    input.pool,
    async (client) => {
      const authorized =
        await requireActorRole({
          client,
          actorUserId:
            validated.actorId,
          jobId,
          requiredRole:
            "PROFESSIONAL",
          logger,
          lock: true,
        });

      if (authorized.error) {
        return {
          abort:
            authorized.error,
        };
      }

      const current =
        await loadVisit(
          client,
          jobId,
          visitId,
          { lock: true }
        );

      const approvedWorkExternal =
        Boolean(
          current &&
          [
            "business_document",
            "business_customer",
          ].includes(
            authorized.context.source_type
          ) &&
          current.purpose ===
            "APPROVED_WORK" &&
          current.quote_approval_source ===
            "EXTERNAL_EVIDENCE" &&
          current.quote_approval_id
        );

      const businessCustomerEvaluation =
        Boolean(
          current &&
          authorized.context.source_type ===
            "business_customer" &&
          current.purpose ===
            "EVALUATION" &&
          current.quote_approval_id == null &&
          current.quote_approval_source == null
        );

      if (
        !approvedWorkExternal &&
        !businessCustomerEvaluation
      ) {
        return {
          abort: failure(
            409,
            "EXTERNAL_VISIT_APPROVAL_MISMATCH",
            "External customer confirmation is unavailable for this Visit."
          ),
        };
      }

      if (
        approvedWorkExternal &&
        quoteApprovalId &&
        quoteApprovalId !==
          current.quote_approval_id
      ) {
        return {
          abort: failure(
            409,
            "EXTERNAL_VISIT_APPROVAL_MISMATCH",
            "External confirmation requires this Visit’s exact Quote approval."
          ),
        };
      }

      if (
        businessCustomerEvaluation &&
        quoteApprovalId
      ) {
        return {
          abort: failure(
            409,
            "EXTERNAL_VISIT_APPROVAL_MISMATCH",
            "Evaluation Visit confirmation does not use Quote approval."
          ),
        };
      }

      const participantId =
        authorized.context
          .actor_participant_id;

      const granted =
        businessCustomerEvaluation
          ? await hasActiveLifecycleGrant({
              client,
              participantId,
              jobId,
              capability:
                EXTERNAL_CONFIRMATION_CAPABILITY,
              allowJobScope: false,
              allowEvaluationVisitScope: true,
              logger,
            })
          : await hasActiveLifecycleGrant({
              client,
              participantId,
              jobId,
              capability:
                EXTERNAL_CONFIRMATION_CAPABILITY,
              quoteApprovalId:
                current.quote_approval_id,
              allowJobScope: false,
              logger,
            });

      if (!granted) {
        return {
          abort: failure(
            403,
            "EXTERNAL_VISIT_CONFIRMATION_AUTHORITY_REQUIRED",
            "External confirmation recording authority is required."
          ),
        };
      }

      const requestFingerprint =
        approvedWorkExternal
          ? fingerprint({
              jobId,
              visitId,
              expectedVersion,
              quoteApprovalId:
                current.quote_approval_id,
              expectedProposalIntegrityHash:
                input.expectedProposalIntegrityHash ||
                null,
              evidenceMethod:
                input.evidenceMethod,
              confirmedAt,
              evidenceReference:
                reference,
              evidenceNote:
                note,
            })
          : fingerprint({
              jobId,
              visitId,
              expectedVersion,
              sourceType:
                "business_customer",
              purpose:
                "EVALUATION",
              expectedProposalIntegrityHash:
                input.expectedProposalIntegrityHash ||
                null,
              evidenceMethod:
                input.evidenceMethod,
              confirmedAt,
              evidenceReference:
                reference,
              evidenceNote:
                note,
            });

      const reservation =
        await reserveCommand({
          client,
          participantId,
          jobId,
          commandName:
            EXTERNAL_CONFIRMATION_CAPABILITY,
          commandScope:
            `visit:${visitId}`,
          idempotencyKey:
            validated.idempotencyKey,
          requestFingerprint,
        });

      if (reservation.error) {
        return {
          abort:
            reservation.error,
        };
      }

      if (
        reservation.replay
      ) {
        return {
          result: {
            ...reservation.replay,
            replayed: true,
          },
        };
      }

      if (
        Number(current.version) !==
        expectedVersion
      ) {
        return {
          abort: failure(
            409,
            "STALE_VISIT_VERSION",
            "The Visit version is no longer current."
          ),
        };
      }

      if (
        current.state !==
        "PROPOSED"
      ) {
        return {
          abort: failure(
            409,
            "EXTERNAL_VISIT_CONFIRMATION_FINAL",
            "Only a current proposed Visit can receive external confirmation."
          ),
        };
      }

      if (
        input.expectedProposalIntegrityHash &&
        input.expectedProposalIntegrityHash !==
          current.version_integrity_hash
      ) {
        return {
          abort: failure(
            409,
            "EXTERNAL_VISIT_PROPOSAL_MISMATCH",
            "The confirmation does not match the exact proposed schedule."
          ),
        };
      }

      const now =
        currentInstant(
          input.clock
        );

      if (
        Date.parse(
          current.scheduled_start_at
        ) <=
        now.getTime()
      ) {
        return {
          abort: failure(
            409,
            "VISIT_START_TIME_PASSED",
            "The proposed Visit must still start in the future."
          ),
        };
      }

      if (
        Date.parse(
          confirmedAt
        ) >
          now.getTime() ||
        Date.parse(
          confirmedAt
        ) <
          Date.parse(
            current.version_created_at
          )
      ) {
        return {
          abort: failure(
            400,
            "INVALID_EXTERNAL_VISIT_CONFIRMATION_TIME",
            "Confirmation must occur after this proposal and no later than now."
          ),
        };
      }

      if (
        approvedWorkExternal
      ) {
        const gate =
          await evaluateApprovedWorkDepositGateWithClient({
            client,
            jobId,
            quoteApprovalId:
              current.quote_approval_id,
            lock: true,
          });

        if (!gate.allowed) {
          return {
            abort:
              schedulingGateFailure(
                gate
              ),
          };
        }
      }

      const commandId =
        reservation
          .reservation
          .id;

      const version =
        expectedVersion + 1;

      await insertVisitVersion(
        client,
        {
          visitId,
          jobId,
          version,
          state:
            "SCHEDULED",
          schedule:
            currentSchedule(
              current
            ),
          participantId,
          commandId,
        }
      );

      const event =
        await insertVisitEvent(
          client,
          {
            visitId,
            jobId,
            visitVersion:
              version,
            previousVisitVersion:
              expectedVersion,
            eventType:
              "VISIT_EXTERNAL_CONFIRMATION_RECORDED",
            visitState:
              "SCHEDULED",
            reason:
              (
                note ||
                reference
              ).slice(
                0,
                2000
              ),
            participantId,
            commandId,
          }
        );

      if (
        approvedWorkExternal
      ) {
        const evidence =
          await client.query(
            `
            INSERT INTO
              canonical_visit_external_confirmation_evidence
            (
              id,
              job_id,
              visit_id,
              proposed_visit_version,
              proposed_integrity_hash,
              scheduled_visit_version,
              quote_approval_id,
              quote_id,
              issued_quote_version,
              issued_integrity_hash,
              contractor_profile_id,
              customer_snapshot_hash,
              business_contact_id,
              business_customer_relationship_id,
              scheduled_start_at,
              scheduled_end_at,
              time_zone,
              location_mode,
              evidence_method,
              confirmed_at,
              evidence_reference,
              evidence_note,
              recorded_by_participant_id,
              command_idempotency_id,
              event_id
            )
            SELECT
              $1,
              proposed.job_id,
              proposed.visit_id,
              proposed.version,
              proposed.integrity_hash,
              $2,
              approvals.id,
              approvals.quote_id,
              approvals.issued_quote_version,
              approvals.issued_integrity_hash,
              approval_evidence.contractor_profile_id,
              approval_evidence.customer_snapshot_hash,
              approval_evidence.business_contact_id,
              approval_evidence.business_customer_relationship_id,
              proposed.scheduled_start_at,
              proposed.scheduled_end_at,
              proposed.time_zone,
              proposed.location_mode,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            FROM
              canonical_visit_versions proposed

            INNER JOIN canonical_quote_approvals approvals
              ON approvals.id =
                   $10

             AND approvals.job_id =
                   proposed.job_id

             AND approvals.decision =
                   'APPROVED'

             AND approvals.approval_source =
                   'EXTERNAL_EVIDENCE'

             AND approvals.external_approval_evidence_id
                   IS NOT NULL

            INNER JOIN
              canonical_quote_external_approval_evidence
                approval_evidence
              ON approval_evidence.id =
                   approvals.external_approval_evidence_id

             AND approval_evidence.quote_id =
                   approvals.quote_id

             AND approval_evidence.job_id =
                   approvals.job_id

             AND approval_evidence.issued_quote_version =
                   approvals.issued_quote_version

             AND approval_evidence.issued_integrity_hash =
                   approvals.issued_integrity_hash

            WHERE proposed.visit_id =
                  $11

              AND proposed.version =
                  $12

            RETURNING id
            `,
            [
              randomUUID(),
              version,
              input.evidenceMethod,
              confirmedAt,
              reference,
              note,
              participantId,
              commandId,
              event.id,
              current.quote_approval_id,
              visitId,
              expectedVersion,
            ]
          );

        if (
          !evidence.rows[0]
        ) {
          throw new Error(
            "External Approved Work Visit confirmation evidence creation failed."
          );
        }
      } else {
        const evidence =
          await client.query(
            `
            INSERT INTO
              canonical_evaluation_visit_external_confirmation_evidence
            (
              id,
              job_id,
              visit_id,
              business_customer_job_source_id,
              contractor_profile_id,
              business_contact_id,
              business_customer_relationship_id,
              source_created_by_user_id,
              proposed_visit_version,
              proposed_integrity_hash,
              scheduled_visit_version,
              scheduled_start_at,
              scheduled_end_at,
              time_zone,
              location_mode,
              evidence_method,
              confirmed_at,
              evidence_reference,
              evidence_note,
              recorded_by_participant_id,
              command_idempotency_id,
              event_id
            )
            SELECT
              $1,
              jobs.id,
              proposed.visit_id,
              jobs.source_business_customer_job_id,
              jobs.contractor_profile_id,
              jobs.business_contact_id,
              jobs.business_customer_relationship_id,
              sources.created_by_user_id,
              proposed.version,
              proposed.integrity_hash,
              $2,
              proposed.scheduled_start_at,
              proposed.scheduled_end_at,
              proposed.time_zone,
              proposed.location_mode,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9
            FROM
              canonical_visit_versions proposed

            INNER JOIN canonical_visits visits
              ON visits.id =
                   proposed.visit_id
             AND visits.job_id =
                   proposed.job_id
             AND visits.purpose =
                   'EVALUATION'

            INNER JOIN jobs
              ON jobs.id =
                   proposed.job_id
             AND jobs.source_type =
                   'business_customer'

            INNER JOIN
              business_customer_job_sources sources
              ON sources.id =
                   jobs.source_business_customer_job_id
             AND sources.contractor_profile_id =
                   jobs.contractor_profile_id
             AND sources.business_contact_id =
                   jobs.business_contact_id
             AND sources.business_customer_relationship_id =
                   jobs.business_customer_relationship_id
             AND sources.created_by_user_id =
                   jobs.created_by_user_id

            WHERE proposed.visit_id =
                  $10

              AND proposed.version =
                  $11

            RETURNING id
            `,
            [
              randomUUID(),
              version,
              input.evidenceMethod,
              confirmedAt,
              reference,
              note,
              participantId,
              commandId,
              event.id,
              visitId,
              expectedVersion,
            ]
          );

        if (
          !evidence.rows[0]
        ) {
          throw new Error(
            "Business Customer Evaluation Visit confirmation evidence creation failed."
          );
        }
      }

      if (
        input.failureInjector
      ) {
        await input.failureInjector(
          "after_write"
        );
      }

      const row =
        await loadVisit(
          client,
          jobId,
          visitId
        );

      const result = {
        ok: true,
        success: true,
        status: 201,
        code:
          "VISIT_EXTERNAL_CONFIRMATION_RECORDED",
        visit:
          visitProjection(
            row,
            authorized.context,
            now
          ),
      };

      await completeCommand(
        client,
        commandId,
        result
      );

      return {
        result,
      };
    }
  );
}

module.exports={EXTERNAL_CONFIRMATION_CAPABILITY,recordExternalVisitConfirmation};

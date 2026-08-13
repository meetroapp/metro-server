"use strict";

const { hasActiveLifecycleGrant } = require("../authorization/lifecycleAuthorityService");

const LIVE_JOB_CONTRACT_VERSION = 1;

const LIVE_JOB_CAPABILITIES = Object.freeze([
  "reported_concern.read",
  "participant.read",
  "evaluation.perform",
  "finding.submit",
  "finding.confirm",
  "recommendation.create",
  "recommendation.read",
  "quote.create",
  "quote.read",
  "quote.scope.manage",
  "quote.issue",
  "quote.revise",
  "workstream.read",
  "work_activity.create",
  "work_activity.progress",
  "work_activity.read",
  "work_obligation.read",
  "workstream.complete",
]);

const STAGE_DEFINITIONS = Object.freeze({
  EVALUATION_NEEDED: "Evaluation needed",
  EVALUATION_IN_PROGRESS: "Evaluation in progress",
  FINDINGS_REVIEW_NEEDED: "Findings need review",
  FINDINGS_NEEDED: "Findings needed",
  RECOMMENDATIONS_NEEDED: "Recommendations needed",
  QUOTE_NEEDED: "Proposal needed",
  QUOTE_DRAFT: "Proposal in progress",
  WAITING_FOR_CUSTOMER_DECISION: "Waiting for customer decision",
  QUOTE_DECLINED: "Proposal declined",
  QUOTE_APPROVED: "Work approved",
  WORK_READY: "Work ready",
  WORK_IN_PROGRESS: "Work in progress",
  WORK_BLOCKED: "Work needs attention",
  WORK_REVIEW_NEEDED: "Work status needs review",
  WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION: "Recorded work is complete",
});

const RESPONSIBILITY_DEFINITIONS = Object.freeze({
  PROFESSIONAL: "Professional",
  CUSTOMER: "Customer",
  SYSTEM_WAITING: "Waiting for a future workflow step",
  NONE: "No current responsibility",
});

const BLOCKER_DEFINITIONS = Object.freeze({
  EVALUATION_NOT_RECORDED: "An evaluation has not been recorded yet.",
  EVALUATION_INCOMPLETE: "The evaluation still needs to be finished.",
  FINDINGS_NOT_RECORDED: "Findings have not been recorded yet.",
  FINDINGS_AWAITING_CONFIRMATION: "Proposed findings still need professional review.",
  QUOTE_NOT_ISSUED: "The proposal is still being prepared.",
  CUSTOMER_DECISION_PENDING: "The customer has not decided on the proposal yet.",
  CUSTOMER_DECLINED_QUOTE: "The customer declined the current proposal.",
  WORKSTREAM_BLOCKED: "At least one part of the work is blocked.",
  UNRESOLVED_OBLIGATION: "An open work obligation needs attention.",
  NEXT_WORKFLOW_AUTHORITY_NOT_AVAILABLE: "The next work-planning step is not available yet.",
  JOB_COMPLETION_NOT_AVAILABLE: "Whole-job completion is not available yet.",
});

const NEXT_ACTION_DEFINITIONS = Object.freeze({
  START_OR_CONTINUE_EVALUATION: {
    label: "Review or continue the evaluation",
    description: "Record what you observed before moving to findings and recommendations.",
  },
  REVIEW_FINDINGS: {
    label: "Review findings",
    description: "Review what was found and confirm only accurate professional findings.",
  },
  PREPARE_RECOMMENDATIONS: {
    label: "Prepare recommendations",
    description: "Review confirmed findings and record the professional recommendation.",
  },
  BUILD_QUOTE: {
    label: "Prepare a proposal",
    description: "Use the confirmed work record to prepare the customer proposal.",
  },
  REVIEW_DRAFT_QUOTE: {
    label: "Review the draft proposal",
    description: "Review scope and professional pricing before the proposal is issued.",
  },
  WAIT_FOR_CUSTOMER_DECISION: {
    label: "Wait for the customer decision",
    description: "The issued proposal is with the customer for review.",
  },
  REVIEW_DECLINED_QUOTE: {
    label: "Review the declined proposal",
    description: "Review the customer decision before preparing any revision.",
  },
  REVIEW_ACTIVE_WORK: {
    label: "Review active work",
    description: "Review the current work record and continue the authorized activity.",
  },
  REVIEW_BLOCKED_WORK: {
    label: "Review what is blocking the work",
    description: "Resolve the recorded blocker before the work can move forward.",
  },
  REVIEW_WORKSTREAM_COMPLETION: {
    label: "Review the completed work record",
    description: "Recorded work is complete; whole-job completion is not available yet.",
  },
  NEXT_STEP_NOT_YET_AVAILABLE: {
    label: "The next step is not available yet",
    description: "This Job is waiting for a later workflow capability.",
  },
});

const ACTION_DEFINITIONS = Object.freeze({
  VIEW_CONCERN: "View customer concern",
  MESSAGE_CUSTOMER: "Message customer",
  START_EVALUATION: "Start evaluation",
  EDIT_EVALUATION: "Edit evaluation",
  COMPLETE_EVALUATION: "Complete evaluation",
  REVIEW_FINDINGS: "Review findings",
  REVIEW_RECOMMENDATIONS: "Review recommendations",
  CREATE_QUOTE: "Create proposal draft",
  REVIEW_QUOTE: "Review proposal",
  ISSUE_QUOTE: "Issue proposal",
  REVIEW_ACTIVE_WORK: "Review active work",
  CONTINUE_ACTIVE_WORK: "Continue active work",
  REVIEW_WORKSTREAM_COMPLETION: "Review completed work record",
});

const DERIVATION_PRECEDENCE = Object.freeze([
  "BLOCKED_WORK",
  "ACTIVE_WORK",
  "READY_WORK",
  "TERMINAL_WORKSTREAMS",
  "APPROVED_WORK_SCHEDULING",
  "DRAFT_QUOTE",
  "ISSUED_QUOTE_DECISION",
  "DECLINED_QUOTE",
  "APPROVED_QUOTE",
  "EVALUATION",
  "FINDINGS",
  "RECOMMENDATIONS",
  "QUOTE_PREPARATION",
]);

function failure(status, code, message) {
  return { ok: false, status, code, message };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedUuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : null;
}

function normalizedCapabilities(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((capability) => String(capability || "").trim())
      .filter((capability) => LIVE_JOB_CAPABILITIES.includes(capability))
  );
}

function currentVersion(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (maximum, row) => Math.max(maximum, Number(row?.version) || 0),
    0
  );
}

function definition(code, definitions) {
  return code ? { code, label: definitions[code] } : null;
}

function nextAction(code) {
  return { code, ...NEXT_ACTION_DEFINITIONS[code] };
}

function projectedNextAction(code, override = null) {
  return override ? { code, ...override } : nextAction(code);
}

function availableAction(code) {
  return { code, label: ACTION_DEFINITIONS[code] };
}

function baseAvailableActions(state, capabilities, stage) {
  const actions = [];
  if (capabilities.has("reported_concern.read")) actions.push("VIEW_CONCERN");
  if (state.hasConversation) actions.push("MESSAGE_CUSTOMER");

  if (stage === "EVALUATION_NEEDED" && capabilities.has("evaluation.perform")) {
    actions.push("START_EVALUATION");
  } else if (
    stage === "EVALUATION_IN_PROGRESS" &&
    state.evaluation?.status === "draft" &&
    capabilities.has("evaluation.perform")
  ) {
    actions.push("EDIT_EVALUATION");
    if (String(state.evaluation.observations || "").trim()) {
      actions.push("COMPLETE_EVALUATION");
    }
  }

  if (
    ["FINDINGS_NEEDED", "FINDINGS_REVIEW_NEEDED"].includes(stage) &&
    (capabilities.has("finding.submit") || capabilities.has("finding.confirm"))
  ) {
    actions.push("REVIEW_FINDINGS");
  }
  if (
    ["RECOMMENDATIONS_NEEDED", "QUOTE_NEEDED", "QUOTE_DRAFT"].includes(stage) &&
    capabilities.has("recommendation.read")
  ) {
    actions.push("REVIEW_RECOMMENDATIONS");
  }
  if (stage === "QUOTE_NEEDED" && capabilities.has("quote.create")) {
    actions.push("CREATE_QUOTE");
  }
  if (
    [
      "QUOTE_DRAFT",
      "WAITING_FOR_CUSTOMER_DECISION",
      "QUOTE_DECLINED",
      "QUOTE_APPROVED",
    ].includes(stage) &&
    capabilities.has("quote.read")
  ) {
    actions.push("REVIEW_QUOTE");
  }
  if (
    stage === "QUOTE_DRAFT" &&
    state.quotes?.some((quote) => quote.status === "DRAFT" && Number(quote.scope_item_count) > 0) &&
    capabilities.has("quote.issue")
  ) {
    actions.push("ISSUE_QUOTE");
  }
  if (
    ["WORK_READY", "WORK_IN_PROGRESS", "WORK_BLOCKED", "WORK_REVIEW_NEEDED"].includes(stage) &&
    capabilities.has("workstream.read")
  ) {
    actions.push("REVIEW_ACTIVE_WORK");
  }
  if (
    ["WORK_READY", "WORK_IN_PROGRESS", "WORK_BLOCKED"].includes(stage) &&
    state.activities?.some((activity) => ["PLANNED", "IN_PROGRESS"].includes(activity.status)) &&
    capabilities.has("work_activity.progress")
  ) {
    actions.push("CONTINUE_ACTIVE_WORK");
  }
  if (
    stage === "WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION" &&
    capabilities.has("workstream.read")
  ) {
    actions.push("REVIEW_WORKSTREAM_COMPLETION");
  }
  return [...new Set(actions)].map(availableAction);
}

function result({
  stage,
  stageLabel = null,
  responsibility,
  blocker = null,
  action,
  actionProjection = null,
  reasons,
  state,
  derivedAt,
}) {
  const capabilities = normalizedCapabilities(state.capabilities);
  return {
    contractVersion: LIVE_JOB_CONTRACT_VERSION,
    stage: stageLabel ? { code: stage, label: stageLabel } : definition(stage, STAGE_DEFINITIONS),
    responsibility: definition(responsibility, RESPONSIBILITY_DEFINITIONS),
    blocker: definition(blocker, BLOCKER_DEFINITIONS),
    nextAction: projectedNextAction(action, actionProjection),
    availableActions: baseAvailableActions(state, capabilities, stage),
    reasonCodes: reasons,
    freshness: {
      derivedAt,
      jobCreatedAt: state.jobCreatedAt || null,
      evaluationVersion: Number(state.evaluation?.version) || 0,
      findingVersion: currentVersion(state.findings),
      recommendationVersion: currentVersion(state.recommendations),
      quoteVersion: currentVersion(state.quotes),
      workstreamVersion: currentVersion(state.workstreams),
      activityVersion: currentVersion(state.activities),
      obligationVersion: currentVersion(state.obligations),
      evaluationCount: state.evaluation ? 1 : 0,
      findingCount: state.findings.length,
      recommendationCount: state.recommendations.length,
      quoteCount: state.quotes.length,
      workstreamCount: state.workstreams.length,
      activityCount: state.activities.length,
      obligationCount: state.obligations.length,
    },
  };
}

function deriveCanonicalLiveJob(state = {}, { derivedAt = new Date().toISOString() } = {}) {
  const workstreams = Array.isArray(state.workstreams) ? state.workstreams : [];
  const activities = Array.isArray(state.activities) ? state.activities : [];
  const obligations = Array.isArray(state.obligations) ? state.obligations : [];
  const findings = Array.isArray(state.findings) ? state.findings : [];
  const recommendations = Array.isArray(state.recommendations) ? state.recommendations : [];
  const quotes = Array.isArray(state.quotes) ? state.quotes : [];
  const approvedWorkScheduling = Array.isArray(state.approvedWorkScheduling)
    ? state.approvedWorkScheduling
    : [];
  const scopedState = {
    ...state,
    workstreams,
    activities,
    obligations,
    findings,
    recommendations,
    quotes,
    approvedWorkScheduling,
  };

  const blockedWorkstream = workstreams.some((workstream) => workstream.state === "BLOCKED");
  const openObligation = obligations.some((obligation) => obligation.status === "OPEN");
  if (blockedWorkstream || openObligation) {
    return result({
      stage: "WORK_BLOCKED",
      responsibility: "PROFESSIONAL",
      blocker: blockedWorkstream ? "WORKSTREAM_BLOCKED" : "UNRESOLVED_OBLIGATION",
      action: "REVIEW_BLOCKED_WORK",
      reasons: [blockedWorkstream ? "BLOCKED_WORKSTREAM_PRESENT" : "OPEN_OBLIGATION_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (
    workstreams.some((workstream) => workstream.state === "ACTIVE") ||
    activities.some((activity) => activity.status === "IN_PROGRESS")
  ) {
    return result({
      stage: "WORK_IN_PROGRESS",
      responsibility: "PROFESSIONAL",
      action: "REVIEW_ACTIVE_WORK",
      reasons: ["ACTIVE_WORK_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (
    workstreams.some((workstream) => workstream.state === "OPEN") ||
    activities.some((activity) => activity.status === "PLANNED")
  ) {
    return result({
      stage: "WORK_READY",
      responsibility: "PROFESSIONAL",
      action: "REVIEW_ACTIVE_WORK",
      reasons: ["OPEN_WORK_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (workstreams.length && workstreams.every((workstream) => workstream.state === "COMPLETED")) {
    return result({
      stage: "WORKSTREAMS_COMPLETE_PENDING_JOB_COMPLETION",
      responsibility: "PROFESSIONAL",
      blocker: "JOB_COMPLETION_NOT_AVAILABLE",
      action: "REVIEW_WORKSTREAM_COMPLETION",
      reasons: ["ALL_WORKSTREAMS_COMPLETED", "JOB_COMPLETION_AUTHORITY_ABSENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (workstreams.length) {
    return result({
      stage: "WORK_REVIEW_NEEDED",
      responsibility: "PROFESSIONAL",
      action: "REVIEW_ACTIVE_WORK",
      reasons: ["TERMINAL_WORKSTREAM_STATE_REQUIRES_REVIEW"],
      state: scopedState,
      derivedAt,
    });
  }

  const approvedQuote = quotes.find(
    (quote) => quote.status === "ISSUED" && quote.customer_decision === "APPROVED"
  );
  const approvedWorkSchedule = approvedWorkScheduling.find(
    (item) =>
      ["AVAILABLE", "ACTIVE"].includes(item.authorityState) &&
      quotes.some(
        (quote) =>
          quote.id === item.quoteId &&
          quote.status === "ISSUED" &&
          quote.customer_decision === "APPROVED"
      )
  );
  const schedulableApprovedQuote = approvedWorkSchedule
    ? quotes.find((quote) => quote.id === approvedWorkSchedule.quoteId)
    : null;
  if (
    schedulableApprovedQuote &&
    approvedWorkSchedule
  ) {
    const scheduled = approvedWorkSchedule.visitState === "SCHEDULED";
    return result({
      stage: scheduled ? "WORK_READY" : "QUOTE_APPROVED",
      stageLabel: scheduled
        ? "Approved work scheduled"
        : "Work approved — ready to schedule",
      responsibility: "PROFESSIONAL",
      action: "REVIEW_ACTIVE_WORK",
      actionProjection: scheduled
        ? {
            label: "Review scheduled work",
            description: "Review the approved work visit and prepare for the scheduled time.",
          }
        : {
            label: "Schedule approved work",
            description: "Use the approved scope to plan a work visit.",
          },
      reasons: [
        scheduled
          ? "APPROVED_WORK_VISIT_SCHEDULED"
          : "APPROVED_WORK_VISIT_AUTHORITY_AVAILABLE",
        ...(quotes.some(
          (quote) =>
            quote.status === "DRAFT" &&
            quote.lineage_type === "SUPPLEMENTAL_QUOTE" &&
            quote.parent_quote_id === schedulableApprovedQuote.id
        )
          ? ["SUPPLEMENTAL_DRAFT_REMAINS_SECONDARY"]
          : []),
      ],
      state: scopedState,
      derivedAt,
    });
  }

  const draftQuote = quotes.find((quote) => quote.status === "DRAFT");
  if (draftQuote) {
    return result({
      stage: "QUOTE_DRAFT",
      responsibility: "PROFESSIONAL",
      blocker: "QUOTE_NOT_ISSUED",
      action: "REVIEW_DRAFT_QUOTE",
      reasons: ["DRAFT_QUOTE_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  const pendingIssuedQuote = quotes.find(
    (quote) => quote.status === "ISSUED" && !quote.customer_decision
  );
  if (pendingIssuedQuote) {
    return result({
      stage: "WAITING_FOR_CUSTOMER_DECISION",
      responsibility: "CUSTOMER",
      blocker: "CUSTOMER_DECISION_PENDING",
      action: "WAIT_FOR_CUSTOMER_DECISION",
      reasons: ["ISSUED_QUOTE_WITHOUT_DECISION"],
      state: scopedState,
      derivedAt,
    });
  }

  const declinedQuote = quotes.find(
    (quote) => quote.status === "ISSUED" && quote.customer_decision === "DECLINED"
  );
  if (declinedQuote) {
    return result({
      stage: "QUOTE_DECLINED",
      responsibility: "PROFESSIONAL",
      blocker: "CUSTOMER_DECLINED_QUOTE",
      action: "REVIEW_DECLINED_QUOTE",
      reasons: ["DECLINED_QUOTE_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (approvedQuote) {
    return result({
      stage: "QUOTE_APPROVED",
      responsibility: "SYSTEM_WAITING",
      blocker: "NEXT_WORKFLOW_AUTHORITY_NOT_AVAILABLE",
      action: "NEXT_STEP_NOT_YET_AVAILABLE",
      reasons: ["APPROVED_QUOTE_PRESENT", "VISIT_SCHEDULE_AUTHORITY_ABSENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (!state.evaluation) {
    return result({
      stage: "EVALUATION_NEEDED",
      responsibility: "PROFESSIONAL",
      blocker: "EVALUATION_NOT_RECORDED",
      action: "START_OR_CONTINUE_EVALUATION",
      reasons: ["NO_EVALUATION_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  if (state.evaluation.status === "draft") {
    return result({
      stage: "EVALUATION_IN_PROGRESS",
      responsibility: "PROFESSIONAL",
      blocker: "EVALUATION_INCOMPLETE",
      action: "START_OR_CONTINUE_EVALUATION",
      reasons: ["DRAFT_EVALUATION_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  const currentFindings = findings.filter(
    (finding) => finding.confirmation_state !== "SUPERSEDED"
  );
  if (currentFindings.some((finding) => finding.confirmation_state === "PROPOSED")) {
    return result({
      stage: "FINDINGS_REVIEW_NEEDED",
      responsibility: "PROFESSIONAL",
      blocker: "FINDINGS_AWAITING_CONFIRMATION",
      action: "REVIEW_FINDINGS",
      reasons: ["PROPOSED_FINDING_PRESENT"],
      state: scopedState,
      derivedAt,
    });
  }

  const confirmedFindings = currentFindings.filter(
    (finding) => finding.confirmation_state === "CONFIRMED"
  );
  if (!confirmedFindings.length) {
    return result({
      stage: "FINDINGS_NEEDED",
      responsibility: "PROFESSIONAL",
      blocker: "FINDINGS_NOT_RECORDED",
      action: "REVIEW_FINDINGS",
      reasons: ["COMPLETED_EVALUATION_WITHOUT_CONFIRMED_FINDINGS"],
      state: scopedState,
      derivedAt,
    });
  }

  const currentRecommendations = recommendations.filter(
    (recommendation) => !["SUPERSEDED", "WITHDRAWN"].includes(recommendation.status)
  );
  const recommendationFindingIds = new Set(
    currentRecommendations.map((recommendation) => recommendation.finding_id)
  );
  if (confirmedFindings.some((finding) => !recommendationFindingIds.has(finding.id))) {
    return result({
      stage: "RECOMMENDATIONS_NEEDED",
      responsibility: "PROFESSIONAL",
      action: "PREPARE_RECOMMENDATIONS",
      reasons: ["CONFIRMED_FINDING_WITHOUT_RECOMMENDATION"],
      state: scopedState,
      derivedAt,
    });
  }

  return result({
    stage: "QUOTE_NEEDED",
    responsibility: "PROFESSIONAL",
    action: "BUILD_QUOTE",
    reasons: ["EVALUATION_FINDINGS_AND_RECOMMENDATIONS_READY"],
    state: scopedState,
    derivedAt,
  });
}

async function loadAuthorizedJob(pool, jobId, actorUserId) {
  const result = await pool.query(
    `
    /* live_job:authorized_context */
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.source_request_relationship_id AS relationship_id,
      jobs.lifecycle_contract_version,
      jobs.created_at AS job_created_at,
      request_relationships.status AS relationship_status,
      request_relationships.professional_user_id AS selected_professional_user_id,
      users.account_type AS actor_account_type,
      relationship_participants.id AS actor_participant_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments
        LEFT JOIN participant_role_revocations
          ON participant_role_revocations.role_assignment_id = participant_role_assignments.id
        WHERE participant_role_assignments.participant_id = relationship_participants.id
          AND participant_role_assignments.job_id = jobs.id
          AND participant_role_assignments.role = 'PRIMARY_PROFESSIONAL'
          AND participant_role_assignments.valid_from <= CURRENT_TIMESTAMP
          AND (
            participant_role_assignments.valid_until IS NULL
            OR participant_role_assignments.valid_until > CURRENT_TIMESTAMP
          )
          AND participant_role_revocations.id IS NULL
      ) AS is_primary_professional,
      request_selections.conversation_id,
      ARRAY(
        SELECT lifecycle_authority_grants.capability
        FROM lifecycle_authority_grants
        LEFT JOIN lifecycle_authority_grant_revocations
          ON lifecycle_authority_grant_revocations.authority_grant_id =
            lifecycle_authority_grants.id
        WHERE lifecycle_authority_grants.grantee_participant_id =
            relationship_participants.id
          AND lifecycle_authority_grants.job_id = jobs.id
          AND lifecycle_authority_grants.scope_type = 'job'
          AND lifecycle_authority_grants.scope_job_id = jobs.id
          AND lifecycle_authority_grants.scope_concern_id IS NULL
          AND lifecycle_authority_grants.capability = ANY($3::text[])
          AND lifecycle_authority_grants.valid_from <= CURRENT_TIMESTAMP
          AND (
            lifecycle_authority_grants.valid_until IS NULL
            OR lifecycle_authority_grants.valid_until > CURRENT_TIMESTAMP
          )
          AND lifecycle_authority_grant_revocations.id IS NULL
        ORDER BY lifecycle_authority_grants.capability
      ) AS active_capabilities
    FROM jobs
    INNER JOIN posts
      ON posts.id = jobs.job_request_id
      AND posts.lifecycle_contract_version = 2
      AND posts.cancelled_at IS NULL
    INNER JOIN request_relationships
      ON request_relationships.id = jobs.source_request_relationship_id
      AND request_relationships.post_id = jobs.job_request_id
      AND request_relationships.emergency_request_id IS NULL
    INNER JOIN request_selections
      ON request_selections.id = jobs.source_request_selection_id
      AND request_selections.request_relationship_id = request_relationships.id
      AND request_selections.post_id = jobs.job_request_id
    INNER JOIN relationship_participants
      ON relationship_participants.job_id = jobs.id
      AND relationship_participants.request_relationship_id = request_relationships.id
      AND relationship_participants.user_id = $2
    INNER JOIN users ON users.id = $2
    WHERE jobs.id = $1
      AND jobs.lifecycle_contract_version = 2
    LIMIT 1
    `,
    [jobId, actorUserId, [...LIVE_JOB_CAPABILITIES]]
  );
  return result.rows[0] || null;
}

async function loadCanonicalState(pool, context) {
  const jobId = context.job_id;
  const [
    evaluation,
    findings,
    recommendations,
    quotes,
    workstreams,
    activities,
    obligations,
    approvedWorkScheduling,
  ] =
    await Promise.all([
      pool.query(
        `/* live_job:evaluation */
         SELECT canonical_evaluations.id, canonical_evaluations.status,
           canonical_evaluation_versions.version,
           canonical_evaluation_versions.observations
         FROM canonical_evaluation_job_subjects
         INNER JOIN canonical_evaluations
           ON canonical_evaluations.id = canonical_evaluation_job_subjects.evaluation_id
         INNER JOIN LATERAL (
           SELECT version, observations
           FROM canonical_evaluation_versions
           WHERE evaluation_id = canonical_evaluations.id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_evaluation_versions ON TRUE
         WHERE canonical_evaluation_job_subjects.job_id = $1
         LIMIT 1`,
        [jobId]
      ),
      pool.query(
        `/* live_job:findings */
         SELECT canonical_evaluation_findings.id,
           canonical_evaluation_finding_versions.version,
           canonical_evaluation_finding_versions.confirmation_state,
           canonical_evaluation_finding_versions.resolution_state
         FROM canonical_evaluation_findings
         INNER JOIN LATERAL (
           SELECT version, confirmation_state, resolution_state
           FROM canonical_evaluation_finding_versions
           WHERE finding_id = canonical_evaluation_findings.id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_evaluation_finding_versions ON TRUE
         WHERE canonical_evaluation_findings.job_id = $1
         ORDER BY canonical_evaluation_findings.created_at, canonical_evaluation_findings.id`,
        [jobId]
      ),
      pool.query(
        `/* live_job:recommendations */
         SELECT canonical_recommendations.id, canonical_recommendations.finding_id,
           canonical_recommendation_versions.version,
           canonical_recommendation_versions.status
         FROM canonical_recommendations
         INNER JOIN LATERAL (
           SELECT version, status
           FROM canonical_recommendation_versions
           WHERE recommendation_id = canonical_recommendations.id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_recommendation_versions ON TRUE
         WHERE canonical_recommendations.job_id = $1
         ORDER BY canonical_recommendations.created_at, canonical_recommendations.id`,
        [jobId]
      ),
      pool.query(
        `/* live_job:quotes */
         SELECT canonical_quotes.id, canonical_quotes.created_at,
           canonical_quotes.parent_quote_id, canonical_quotes.lineage_type,
           canonical_quote_versions.version, canonical_quote_versions.status,
           canonical_quote_versions.scope_item_count,
           decisions.decision AS customer_decision,
           decisions.id AS customer_decision_id,
           decisions.issued_quote_version AS customer_decision_quote_version
         FROM canonical_quotes
         INNER JOIN LATERAL (
           SELECT version, status, scope_item_count
           FROM canonical_quote_versions
           WHERE quote_id = canonical_quotes.id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_quote_versions ON TRUE
         LEFT JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = canonical_quotes.id
         WHERE canonical_quotes.job_id = $1
         ORDER BY canonical_quotes.updated_at DESC, canonical_quotes.created_at DESC,
           canonical_quotes.id DESC`,
        [jobId]
      ),
      pool.query(
        `/* live_job:workstreams */
         SELECT canonical_workstreams.id,
           canonical_workstream_versions.version,
           canonical_workstream_versions.state
         FROM canonical_workstreams
         INNER JOIN LATERAL (
           SELECT version, state
           FROM canonical_workstream_versions
           WHERE workstream_id = canonical_workstreams.id
             AND job_id = canonical_workstreams.job_id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_workstream_versions ON TRUE
         WHERE canonical_workstreams.job_id = $1
         ORDER BY canonical_workstreams.sequence, canonical_workstreams.id`,
        [jobId]
      ),
      pool.query(
        `/* live_job:activities */
         SELECT canonical_work_activities.id,
           canonical_work_activity_versions.version,
           canonical_work_activity_versions.status
         FROM canonical_work_activities
         INNER JOIN LATERAL (
           SELECT version, status
           FROM canonical_work_activity_versions
           WHERE activity_id = canonical_work_activities.id
             AND workstream_id = canonical_work_activities.workstream_id
             AND job_id = canonical_work_activities.job_id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_work_activity_versions ON TRUE
         WHERE canonical_work_activities.job_id = $1
         ORDER BY canonical_work_activities.created_at, canonical_work_activities.id`,
        [jobId]
      ),
      pool.query(
        `/* live_job:obligations */
         SELECT canonical_workstream_obligations.id,
           canonical_workstream_obligation_versions.version,
           canonical_workstream_obligation_versions.status
         FROM canonical_workstream_obligations
         INNER JOIN LATERAL (
           SELECT version, status
           FROM canonical_workstream_obligation_versions
           WHERE obligation_id = canonical_workstream_obligations.id
             AND workstream_id = canonical_workstream_obligations.workstream_id
             AND job_id = canonical_workstream_obligations.job_id
           ORDER BY version DESC LIMIT 1
         ) AS canonical_workstream_obligation_versions ON TRUE
         WHERE canonical_workstream_obligations.job_id = $1
         ORDER BY canonical_workstream_obligations.workstream_id,
           canonical_workstream_obligations.sequence,
           canonical_workstream_obligations.id`,
        [jobId]
      ),
      pool.query(
        `/* live_job:approved_work_scheduling */
         SELECT canonical_quotes.id AS quote_id,
           decisions.id AS approved_quote_decision_id,
           activations.id AS activation_id,
           COALESCE(active_grants.grant_count, 0)::integer AS active_grant_count,
           latest_visit.state AS visit_state
         FROM canonical_quotes
         INNER JOIN canonical_quote_customer_decisions decisions
           ON decisions.quote_id = canonical_quotes.id
           AND decisions.job_id = canonical_quotes.job_id
           AND decisions.decision = 'APPROVED'
         INNER JOIN request_relationships relationships
           ON relationships.id = canonical_quotes.relationship_id
           AND relationships.status = 'active'
         INNER JOIN relationship_participants customer
           ON customer.job_id = canonical_quotes.job_id
           AND customer.request_relationship_id = canonical_quotes.relationship_id
           AND customer.user_id = relationships.homeowner_id
         INNER JOIN participant_role_assignments customer_roles
           ON customer_roles.participant_id = customer.id
           AND customer_roles.job_id = canonical_quotes.job_id
           AND customer_roles.role = 'CUSTOMER_REPRESENTATIVE'
           AND customer_roles.valid_from <= CURRENT_TIMESTAMP
           AND (customer_roles.valid_until IS NULL OR customer_roles.valid_until > CURRENT_TIMESTAMP)
         LEFT JOIN participant_role_revocations customer_role_revocations
           ON customer_role_revocations.role_assignment_id = customer_roles.id
         LEFT JOIN canonical_approved_work_visit_authority_activations activations
           ON activations.approved_quote_decision_id = decisions.id
           AND activations.job_id = canonical_quotes.job_id
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT (grants.grantee_participant_id, grants.capability)) AS grant_count
           FROM lifecycle_authority_grants grants
           LEFT JOIN lifecycle_authority_grant_revocations revocations
             ON revocations.authority_grant_id = grants.id
           WHERE grants.job_id = canonical_quotes.job_id
             AND grants.scope_type = 'approved_work'
             AND grants.scope_approved_quote_decision_id = decisions.id
             AND grants.scope_approved_quote_decision = 'APPROVED'
             AND (
               (
                 grants.grantee_participant_id = $3
                 AND grants.capability = ANY($2::text[])
               )
               OR
               (
                 grants.grantee_participant_id = customer.id
                 AND grants.capability = ANY($4::text[])
               )
             )
             AND grants.valid_from <= CURRENT_TIMESTAMP
             AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
             AND revocations.id IS NULL
         ) AS active_grants ON TRUE
         LEFT JOIN LATERAL (
           SELECT versions.state
           FROM canonical_visits visits
           INNER JOIN LATERAL (
             SELECT state
             FROM canonical_visit_versions
             WHERE visit_id = visits.id AND job_id = visits.job_id
             ORDER BY version DESC LIMIT 1
           ) AS versions ON TRUE
           WHERE visits.job_id = canonical_quotes.job_id
             AND visits.purpose = 'APPROVED_WORK'
             AND visits.approved_quote_decision_id = decisions.id
           ORDER BY visits.created_at DESC, visits.id DESC
           LIMIT 1
         ) AS latest_visit ON TRUE
         WHERE canonical_quotes.job_id = $1
           AND canonical_quotes.status = 'ISSUED'
           AND customer_role_revocations.id IS NULL
         ORDER BY canonical_quotes.updated_at DESC, canonical_quotes.id DESC`,
        [
          jobId,
          [
            "visit.read",
            "visit.propose",
            "visit.reschedule",
            "visit.cancel",
            "visit.complete",
          ],
          context.actor_participant_id,
          ["visit.read", "visit.confirm", "visit.change_request"],
        ]
      ),
    ]);

  return {
    jobCreatedAt: context.job_created_at,
    hasConversation: positiveInteger(context.conversation_id) !== null,
    capabilities: context.active_capabilities,
    evaluation: evaluation.rows[0] || null,
    findings: findings.rows,
    recommendations: recommendations.rows,
    quotes: quotes.rows,
    workstreams: workstreams.rows,
    activities: activities.rows,
    obligations: obligations.rows,
    approvedWorkScheduling: quotes.rows
      .filter((quote) => quote.customer_decision === "APPROVED")
      .map((quote) => {
        const authority = approvedWorkScheduling.rows.find(
          (row) => row.quote_id === quote.id && row.approved_quote_decision_id === quote.customer_decision_id
        );
        if (!authority || !context.active_capabilities.includes("quote.read")) return null;
        return {
          quoteId: quote.id,
          approvedQuoteDecisionId: quote.customer_decision_id,
          authorityState: authority.activation_id
            ? Number(authority.active_grant_count) === 8
              ? "ACTIVE"
              : "UNAVAILABLE"
            : "AVAILABLE",
          visitState: authority.visit_state || null,
        };
      })
      .filter(Boolean),
  };
}

async function getCanonicalLiveJob(input = {}) {
  const actorUserId = positiveInteger(input.authenticatedActor?.id);
  if (!actorUserId) {
    return failure(401, "AUTHENTICATION_REQUIRED", "Authentication is required.");
  }
  const jobId = normalizedUuid(input.jobId);
  if (!jobId) {
    return failure(400, "INVALID_JOB_ID", "A valid Job ID is required.");
  }
  if (!input.pool || typeof input.pool.query !== "function") {
    throw new TypeError("A database pool is required.");
  }

  const client = typeof input.pool.connect === "function"
    ? await input.pool.connect()
    : input.pool;
  const ownsClient = client !== input.pool;
  let transactionStarted = false;
  try {
    if (ownsClient) {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      transactionStarted = true;
    }
    const context = await loadAuthorizedJob(client, jobId, actorUserId);
    if (!context) {
      if (transactionStarted) await client.query("COMMIT");
      transactionStarted = false;
      return failure(404, "LIVE_JOB_UNAVAILABLE", "The current Job is unavailable.");
    }
    if (
      Number(context.lifecycle_contract_version) !== 2 ||
      context.relationship_status !== "active" ||
      context.actor_account_type !== "professional" ||
      Number(context.selected_professional_user_id) !== actorUserId ||
      context.is_primary_professional !== true
    ) {
      if (transactionStarted) await client.query("COMMIT");
      transactionStarted = false;
      return failure(404, "LIVE_JOB_UNAVAILABLE", "The current Job is unavailable.");
    }

    const capabilities = normalizedCapabilities(context.active_capabilities);
    for (const requiredCapability of ["participant.read", "reported_concern.read"]) {
      if (!capabilities.has(requiredCapability)) {
        const granted = await hasActiveLifecycleGrant({
          client,
          participantId: context.actor_participant_id,
          capability: requiredCapability,
          jobId,
          logger: input.logger,
        });
        if (!granted) {
          if (transactionStarted) await client.query("COMMIT");
          transactionStarted = false;
          return failure(
            403,
            "LIVE_JOB_READ_AUTHORITY_REQUIRED",
            "Current Job read authority is required."
          );
        }
        capabilities.add(requiredCapability);
      }
    }

    const state = await loadCanonicalState(client, {
      ...context,
      active_capabilities: [...capabilities],
    });
    const projection = deriveCanonicalLiveJob(state);
    if (transactionStarted) await client.query("COMMIT");
    transactionStarted = false;
    return {
      ok: true,
      status: 200,
      code: "LIVE_JOB_STATE_LOADED",
      liveJob: {
        jobId,
        requestId: Number(context.job_request_id),
        relationshipId: Number(context.relationship_id),
        ...projection,
      },
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    transactionStarted = false;
    throw error;
  } finally {
    if (ownsClient && typeof client.release === "function") client.release();
  }
}

module.exports = {
  ACTION_DEFINITIONS,
  BLOCKER_DEFINITIONS,
  DERIVATION_PRECEDENCE,
  LIVE_JOB_CAPABILITIES,
  LIVE_JOB_CONTRACT_VERSION,
  NEXT_ACTION_DEFINITIONS,
  RESPONSIBILITY_DEFINITIONS,
  STAGE_DEFINITIONS,
  deriveCanonicalLiveJob,
  getCanonicalLiveJob,
  loadAuthorizedJob,
  loadCanonicalState,
};

"use strict";

const { createHash } = require("node:crypto");

const { isPlainObject } = require("./intelligenceGatewayContracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INPUT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;
const MAX_MINOR_AMOUNT = 9_000_000_000_000;
const MATERIAL_RESPONSIBILITIES = new Set([
  "PROFESSIONAL_SUPPLIED",
  "CUSTOMER_SUPPLIED",
  "EXCLUDED",
  "PENDING_SELECTION",
  "NOT_APPLICABLE",
]);

function operationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function contextError(message) {
  return operationError("intelligence_context_invalid", message);
}

function assertExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) throw contextError("Expected a plain object.");
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw contextError("Object fields do not match the quote composition schema.");
  }
}

function boundedText(value, maximum, { required = false } = {}) {
  if (value === undefined && !required) return null;
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum) {
    throw contextError("Text does not match quote composition bounds.");
  }
  if (required && !value) throw contextError("Required text is missing.");
  return value || null;
}

function normalizedUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function safeMinorAmount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR_AMOUNT
    ? value
    : null;
}

function normalizeProfessionalInput(input) {
  assertExactKeys(
    input,
    ["jobId", "mode"],
    [
      "professionalInstructions",
      "quoteDraftId",
      "pricingInputs",
      "materialInputs",
      "terms",
    ]
  );
  const jobId = normalizedUuid(input.jobId);
  const quoteDraftId = input.quoteDraftId == null
    ? null
    : normalizedUuid(input.quoteDraftId);
  if (!jobId || input.mode !== "ADVISORY" || (input.quoteDraftId != null && !quoteDraftId)) {
    throw contextError("The quote composition identity is invalid.");
  }

  const pricingInputs = input.pricingInputs || [];
  if (!Array.isArray(pricingInputs) || pricingInputs.length > 30) {
    throw contextError("Pricing inputs exceed the operation bounds.");
  }
  const pricingKeys = new Set();
  const normalizedPricing = pricingInputs.map((item) => {
    assertExactKeys(item, ["key", "classification", "amountMinor"], ["quantity"]);
    const key = typeof item.key === "string" ? item.key.trim().toLowerCase() : "";
    const classification = String(item.classification || "").trim().toUpperCase();
    const amountMinor = safeMinorAmount(item.amountMinor);
    const quantity = item.quantity == null ? 1 : item.quantity;
    if (
      !INPUT_KEY_PATTERN.test(key) ||
      pricingKeys.has(key) ||
      !["MATERIAL", "LABOR_SERVICE"].includes(classification) ||
      amountMinor == null ||
      !Number.isSafeInteger(quantity) ||
      quantity < 1 ||
      quantity > 10_000 ||
      amountMinor * quantity > MAX_MINOR_AMOUNT
    ) {
      throw contextError("A professional pricing input is invalid.");
    }
    pricingKeys.add(key);
    return { key, classification, amountMinor, quantity };
  });

  const materialInputs = input.materialInputs || [];
  if (!Array.isArray(materialInputs) || materialInputs.length > 30) {
    throw contextError("Material inputs exceed the operation bounds.");
  }
  const materialKeys = new Set();
  const normalizedMaterials = materialInputs.map((item) => {
    assertExactKeys(item, ["key", "description", "responsibility"]);
    const key = typeof item.key === "string" ? item.key.trim().toLowerCase() : "";
    const responsibility = String(item.responsibility || "").trim().toUpperCase();
    if (!INPUT_KEY_PATTERN.test(key) || materialKeys.has(key) || !MATERIAL_RESPONSIBILITIES.has(responsibility)) {
      throw contextError("A professional material input is invalid.");
    }
    materialKeys.add(key);
    return {
      key,
      description: boundedText(item.description, 500, { required: true }),
      responsibility,
    };
  });

  const terms = input.terms || {};
  assertExactKeys(terms, [], ["depositPercent", "availability", "confirmedTotalMinor"]);
  const depositPercent = terms.depositPercent == null ? null : terms.depositPercent;
  const confirmedTotalMinor = terms.confirmedTotalMinor == null
    ? null
    : safeMinorAmount(terms.confirmedTotalMinor);
  if (
    (depositPercent != null &&
      (!Number.isInteger(depositPercent) || depositPercent < 1 || depositPercent > 100)) ||
    (terms.confirmedTotalMinor != null && confirmedTotalMinor == null)
  ) {
    throw contextError("Professional commercial terms are invalid.");
  }

  return {
    jobId,
    mode: "ADVISORY",
    quoteDraftId,
    professionalInstructions: boundedText(input.professionalInstructions, 4000),
    pricingInputs: normalizedPricing,
    materialInputs: normalizedMaterials,
    terms: {
      depositPercent,
      availability: boundedText(terms.availability, 500),
      confirmedTotalMinor,
    },
  };
}

function reference(type, id, version = 1) {
  return { type, id: String(id), version: Number(version) };
}

function mapRows(result, mapper) {
  return (result?.rows || []).map(mapper);
}

async function loadAuthorizedJob(pool, jobId, actorUserId) {
  const result = await pool.query(
    `
    /* quote_composition:job_authority */
    SELECT
      jobs.id AS job_id,
      jobs.job_request_id,
      jobs.lifecycle_contract_version,
      posts.title,
      posts.description,
      posts.request_category,
      posts.service_domain,
      posts.service_specialty,
      posts.user_id AS homeowner_user_id,
      relationships.id AS relationship_id,
      relationships.status AS relationship_status,
      relationships.professional_user_id AS selected_professional_user_id,
      actor_users.account_type AS actor_account_type,
      participants.id AS professional_participant_id,
      EXISTS (
        SELECT 1
        FROM participant_role_assignments roles
        LEFT JOIN participant_role_revocations revocations
          ON revocations.role_assignment_id = roles.id
        WHERE roles.participant_id = participants.id
          AND roles.job_id = jobs.id
          AND roles.role = 'PRIMARY_PROFESSIONAL'
          AND roles.valid_from <= CURRENT_TIMESTAMP
          AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
      ) AS is_primary_professional,
      ARRAY(
        SELECT grants.capability
        FROM lifecycle_authority_grants grants
        LEFT JOIN lifecycle_authority_grant_revocations revocations
          ON revocations.authority_grant_id = grants.id
        WHERE grants.grantee_participant_id = participants.id
          AND grants.job_id = jobs.id
          AND grants.scope_type = 'job'
          AND grants.scope_job_id = jobs.id
          AND grants.scope_concern_id IS NULL
          AND grants.capability = ANY($3::text[])
          AND grants.valid_from <= CURRENT_TIMESTAMP
          AND (grants.valid_until IS NULL OR grants.valid_until > CURRENT_TIMESTAMP)
          AND revocations.id IS NULL
        ORDER BY grants.capability
      ) AS active_quote_capabilities
    FROM jobs
    INNER JOIN posts ON posts.id = jobs.job_request_id
    INNER JOIN request_relationships relationships
      ON relationships.id = jobs.source_request_relationship_id
      AND relationships.post_id = jobs.job_request_id
      AND relationships.emergency_request_id IS NULL
    INNER JOIN users actor_users ON actor_users.id = $2
    LEFT JOIN relationship_participants participants
      ON participants.job_id = jobs.id
      AND participants.request_relationship_id = relationships.id
      AND participants.user_id = $2
    WHERE jobs.id = $1
    LIMIT 1
    `,
    [jobId, actorUserId, ["quote.create", "quote.read", "quote.scope.manage"]]
  );
  const row = result.rows[0] || null;
  if (!row) throw operationError("intelligence_job_unavailable", "Job unavailable.");
  if (Number(row.lifecycle_contract_version) !== 2) {
    throw operationError("intelligence_lifecycle_v2_required", "Lifecycle v2 required.");
  }
  const capabilities = new Set(row.active_quote_capabilities || []);
  if (
    row.relationship_status !== "active" ||
    row.actor_account_type !== "professional" ||
    Number(row.selected_professional_user_id) !== actorUserId ||
    !row.professional_participant_id ||
    row.is_primary_professional !== true ||
    !capabilities.has("quote.create") ||
    !capabilities.has("quote.scope.manage")
  ) {
    throw operationError(
      "intelligence_quote_authority_required",
      "Professional Quote authority required."
    );
  }
  return { ...row, capabilities };
}

async function loadCanonicalContext(pool, job) {
  const [concerns, evaluation, findings, workstreams, activities, obligations, recommendations, constraints] =
    await Promise.all([
      pool.query(
        `/* quote_composition:concerns */
         SELECT concerns.id, concerns.original_text, concerns.sequence,
           clarifications.id AS clarification_id,
           clarifications.clarification_text, clarifications.semantics,
           clarifications.actor_user_id
         FROM reported_concerns concerns
         LEFT JOIN concern_clarifications clarifications
           ON clarifications.concern_id = concerns.id
         WHERE concerns.job_request_id = $1
         ORDER BY concerns.sequence, concerns.id, clarifications.created_at, clarifications.id
         LIMIT 100`,
        [Number(job.job_request_id)]
      ),
      pool.query(
        `/* quote_composition:evaluation */
         SELECT evaluations.id, evaluations.status, versions.version,
           versions.service_type, versions.evaluation_context,
           versions.observations, versions.diagnosis_summary, versions.limitations
         FROM canonical_evaluation_job_subjects subjects
         INNER JOIN canonical_evaluations evaluations ON evaluations.id = subjects.evaluation_id
         INNER JOIN LATERAL (
           SELECT * FROM canonical_evaluation_versions
           WHERE evaluation_id = evaluations.id ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         WHERE subjects.job_id = $1 AND evaluations.status = 'completed'
         LIMIT 1`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:findings */
         SELECT findings.id, findings.evaluation_id, versions.version,
           versions.evaluation_version, versions.statement,
           versions.confirmation_state, versions.resolution_state,
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', evidence.id, 'type', evidence.evidence_type,
             'namespace', evidence.reference_namespace, 'reference', evidence.reference_id
           ) ORDER BY evidence.created_at, evidence.id)
             FILTER (WHERE evidence.id IS NOT NULL), '[]'::jsonb) AS evidence
         FROM canonical_evaluation_findings findings
         INNER JOIN LATERAL (
           SELECT * FROM canonical_evaluation_finding_versions
           WHERE finding_id = findings.id ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         LEFT JOIN canonical_finding_evidence_references evidence
           ON evidence.finding_id = findings.id
           AND evidence.finding_version = versions.version
           AND evidence.job_id = findings.job_id
         WHERE findings.job_id = $1 AND versions.confirmation_state = 'CONFIRMED'
         GROUP BY findings.id, findings.evaluation_id, versions.version,
           versions.evaluation_version, versions.statement,
           versions.confirmation_state, versions.resolution_state
         ORDER BY findings.created_at, findings.id LIMIT 50`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:workstreams */
         SELECT workstreams.id, workstreams.sequence, versions.version,
           versions.title, versions.state
         FROM canonical_workstreams workstreams
         INNER JOIN LATERAL (
           SELECT * FROM canonical_workstream_versions
           WHERE workstream_id = workstreams.id AND job_id = workstreams.job_id
           ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         WHERE workstreams.job_id = $1
         ORDER BY workstreams.sequence, workstreams.id LIMIT 50`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:activities */
         SELECT activities.id, activities.workstream_id, versions.version,
           versions.activity_type, versions.statement, versions.status,
           versions.temporary_intervention, versions.temporary_details
         FROM canonical_work_activities activities
         INNER JOIN LATERAL (
           SELECT * FROM canonical_work_activity_versions
           WHERE activity_id = activities.id
             AND workstream_id = activities.workstream_id
             AND job_id = activities.job_id
           ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         WHERE activities.job_id = $1
         ORDER BY activities.created_at, activities.id LIMIT 100`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:obligations */
         SELECT obligations.id, obligations.workstream_id,
           obligations.source_finding_id, obligations.sequence,
           versions.version, versions.statement, versions.status
         FROM canonical_workstream_obligations obligations
         INNER JOIN LATERAL (
           SELECT * FROM canonical_workstream_obligation_versions
           WHERE obligation_id = obligations.id
             AND workstream_id = obligations.workstream_id
             AND job_id = obligations.job_id
           ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         WHERE obligations.job_id = $1
         ORDER BY obligations.workstream_id, obligations.sequence, obligations.id LIMIT 100`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:recommendations */
         SELECT recommendations.id, recommendations.finding_id,
           recommendations.evaluation_id, recommendations.kind,
           recommendations.primary_recommendation_id,
           versions.version, versions.evaluation_version,
           versions.statement, versions.status
         FROM canonical_recommendations recommendations
         INNER JOIN LATERAL (
           SELECT * FROM canonical_recommendation_versions
           WHERE recommendation_id = recommendations.id
           ORDER BY version DESC LIMIT 1
         ) versions ON TRUE
         WHERE recommendations.job_id = $1
         ORDER BY recommendations.created_at, recommendations.id LIMIT 100`,
        [job.job_id]
      ),
      pool.query(
        `/* quote_composition:constraints */
         SELECT id, recommendation_id, finding_id, constraint_type, statement
         FROM canonical_customer_constraints
         WHERE job_id = $1 ORDER BY created_at, id LIMIT 100`,
        [job.job_id]
      ),
    ]);

  const concernMap = new Map();
  for (const row of concerns.rows) {
    if (!concernMap.has(row.id)) {
      concernMap.set(row.id, {
        id: row.id,
        sequence: Number(row.sequence),
        originalText: row.original_text,
        provenance: "CUSTOMER_REPORTED",
        sourceReferences: [reference("CONCERN", row.id)],
        clarifications: [],
      });
    }
    if (row.clarification_id) {
      concernMap.get(row.id).clarifications.push({
        id: row.clarification_id,
        semantics: row.semantics,
        text: row.clarification_text,
        provenance: Number(row.actor_user_id) === Number(job.homeowner_user_id)
          ? "CUSTOMER_REPORTED"
          : "PROFESSIONAL_INPUT",
        sourceReferences: [reference("CLARIFICATION", row.clarification_id)],
      });
    }
  }
  const evaluationRow = evaluation.rows[0] || null;
  return {
    reportedConcerns: [...concernMap.values()],
    evaluation: evaluationRow
      ? {
          id: evaluationRow.id,
          version: Number(evaluationRow.version),
          status: "COMPLETED",
          serviceType: evaluationRow.service_type,
          context: evaluationRow.evaluation_context,
          observations: evaluationRow.observations,
          diagnosisSummary: evaluationRow.diagnosis_summary,
          limitations: evaluationRow.limitations,
          provenance: "CANONICAL_CONFIRMED",
          sourceReferences: [reference("EVALUATION", evaluationRow.id, evaluationRow.version)],
        }
      : null,
    findings: mapRows(findings, (row) => ({
      id: row.id,
      evaluationId: row.evaluation_id,
      version: Number(row.version),
      statement: row.statement,
      confirmationState: row.confirmation_state,
      resolutionState: row.resolution_state,
      evidence: row.evidence || [],
      provenance: "CANONICAL_CONFIRMED",
      sourceReferences: [reference("FINDING", row.id, row.version)],
    })),
    workstreams: mapRows(workstreams, (row) => ({
      id: row.id,
      sequence: Number(row.sequence),
      version: Number(row.version),
      title: row.title,
      state: row.state,
      provenance: "CANONICAL_CONFIRMED",
      sourceReferences: [reference("WORKSTREAM", row.id, row.version)],
    })),
    workActivities: mapRows(activities, (row) => ({
      id: row.id,
      workstreamId: row.workstream_id,
      version: Number(row.version),
      activityType: row.activity_type,
      statement: row.statement,
      status: row.status,
      workStatus: row.status === "DONE"
        ? (row.temporary_intervention ? "DONE_TEMPORARY" : "DONE")
        : row.status === "CANCELLED" ? "DEFERRED" : "OPEN",
      temporaryIntervention: row.temporary_intervention === true,
      temporaryDetails: row.temporary_details,
      provenance: "CANONICAL_CONFIRMED",
      sourceReferences: [reference("WORK_ACTIVITY", row.id, row.version)],
    })),
    workstreamObligations: mapRows(obligations, (row) => ({
      id: row.id,
      workstreamId: row.workstream_id,
      sourceFindingId: row.source_finding_id,
      sequence: Number(row.sequence),
      version: Number(row.version),
      statement: row.statement,
      status: row.status,
      provenance: "CANONICAL_CONFIRMED",
      sourceReferences: [reference("WORKSTREAM_OBLIGATION", row.id, row.version)],
    })),
    recommendations: mapRows(recommendations, (row) => ({
      id: row.id,
      findingId: row.finding_id,
      evaluationId: row.evaluation_id,
      kind: row.kind,
      primaryRecommendationId: row.primary_recommendation_id,
      version: Number(row.version),
      statement: row.statement,
      status: row.status,
      provenance: "CANONICAL_CONFIRMED",
      sourceReferences: [reference("RECOMMENDATION", row.id, row.version)],
    })),
    customerConstraints: mapRows(constraints, (row) => ({
      id: row.id,
      recommendationId: row.recommendation_id,
      findingId: row.finding_id,
      type: row.constraint_type,
      statement: row.statement,
      provenance: "CUSTOMER_REPORTED",
      sourceReferences: [reference("CUSTOMER_CONSTRAINT", row.id)],
    })),
  };
}

async function loadQuoteDraft(pool, job, quoteDraftId) {
  if (!quoteDraftId) return null;
  if (!job.capabilities.has("quote.read")) {
    throw operationError(
      "intelligence_quote_authority_required",
      "Draft Quote read authority required."
    );
  }
  const result = await pool.query(
    `/* quote_composition:quote_draft */
     SELECT quotes.id, quotes.currency, quotes.status, current.version,
       current.materials_subtotal_minor, current.labor_service_subtotal_minor,
       current.total_minor, current.conditions_snapshot, current.exclusions_snapshot,
       COALESCE(jsonb_agg(jsonb_build_object(
         'scopeItemId', snapshots.scope_item_id,
         'sequence', snapshots.sequence,
         'classification', snapshots.classification,
         'scopeSemantic', snapshots.scope_semantic,
         'materialResponsibility', snapshots.material_responsibility,
         'description', snapshots.description,
         'quantity', snapshots.quantity,
         'unitAmountMinor', snapshots.unit_amount_minor,
         'lineTotalMinor', snapshots.line_total_minor,
         'includedInTotal', snapshots.included_in_total,
         'sourceType', snapshots.source_type,
         'sourceVersion', snapshots.source_version,
         'sourceWorkstreamVersion', snapshots.source_workstream_version,
         'sourceFindingId', snapshots.source_finding_id,
         'sourceRecommendationId', snapshots.source_recommendation_id,
         'sourceWorkstreamId', snapshots.source_workstream_id,
         'sourceActivityId', snapshots.source_activity_id,
         'sourceObligationId', snapshots.source_obligation_id
       ) ORDER BY snapshots.sequence) FILTER (WHERE snapshots.scope_item_id IS NOT NULL),
       '[]'::jsonb) AS scope_items
     FROM canonical_quotes quotes
     INNER JOIN LATERAL (
       SELECT * FROM canonical_quote_versions
       WHERE quote_id = quotes.id ORDER BY version DESC LIMIT 1
     ) current ON TRUE
     LEFT JOIN canonical_quote_scope_item_snapshots snapshots
       ON snapshots.quote_id = quotes.id AND snapshots.quote_version = current.version
     WHERE quotes.id = $1 AND quotes.job_id = $2 AND quotes.status = 'DRAFT'
     GROUP BY quotes.id, quotes.currency, quotes.status, current.version,
       current.materials_subtotal_minor, current.labor_service_subtotal_minor,
       current.total_minor, current.conditions_snapshot, current.exclusions_snapshot
     LIMIT 1`,
    [quoteDraftId, job.job_id]
  );
  const row = result.rows[0];
  if (!row) {
    throw operationError(
      "intelligence_quote_draft_unavailable",
      "Draft Quote unavailable."
    );
  }
  return {
    id: row.id,
    version: Number(row.version),
    currency: row.currency,
    status: row.status,
    materialsSubtotalMinor: Number(row.materials_subtotal_minor),
    laborServiceSubtotalMinor: Number(row.labor_service_subtotal_minor),
    totalMinor: Number(row.total_minor),
    conditions: row.conditions_snapshot || [],
    exclusions: row.exclusions_snapshot || [],
    scopeItems: row.scope_items || [],
    provenance: "PROFESSIONAL_INPUT",
    sourceReferences: [reference("QUOTE_DRAFT", row.id, row.version)],
  };
}

function professionalInputContext(input) {
  return {
    instructions: input.professionalInstructions
      ? {
          text: input.professionalInstructions,
          provenance: "PROFESSIONAL_INPUT",
          sourceReferences: [reference("PROFESSIONAL_INPUT", "instructions")],
        }
      : null,
    pricingInputs: input.pricingInputs.map((item) => ({
      ...item,
      status: "PRICE_CONFIRMED_BY_PROFESSIONAL",
      provenance: "PROFESSIONAL_INPUT",
      sourceReferences: [reference("PROFESSIONAL_INPUT", `pricing:${item.key}`)],
    })),
    materialInputs: input.materialInputs.map((item) => ({
      ...item,
      provenance: "PROFESSIONAL_INPUT",
      sourceReferences: [reference("PROFESSIONAL_INPUT", `material:${item.key}`)],
    })),
    terms: {
      ...input.terms,
      provenance: "PROFESSIONAL_INPUT",
      sourceReferences: [reference("PROFESSIONAL_INPUT", "terms")],
    },
  };
}

function sourceContextFingerprint(context) {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

async function assembleQuoteCompositionContext({ context, input, runtimeContext }) {
  assertExactKeys(context, []);
  const normalized = normalizeProfessionalInput(input);
  const pool = runtimeContext?.pool;
  const actor = runtimeContext?.authenticatedActor;
  if (!pool || typeof pool.query !== "function" || !Number.isInteger(actor?.id)) {
    throw operationError("required_engine_failure", "Quote context authority is unavailable.");
  }
  const job = await loadAuthorizedJob(pool, normalized.jobId, actor.id);
  job.homeowner_user_id = job.homeowner_user_id || null;
  const canonical = await loadCanonicalContext(pool, job);
  const quoteDraft = await loadQuoteDraft(pool, job, normalized.quoteDraftId);
  const assembled = {
    mode: "ADVISORY",
    job: {
      id: job.job_id,
      requestId: Number(job.job_request_id),
      title: job.title || "",
      description: job.description || "",
      requestCategory: job.request_category || "",
      serviceDomain: job.service_domain || "",
      serviceSpecialty: job.service_specialty || "",
      lifecycleContractVersion: 2,
    },
    generatedFor: {
      professionalParticipantId: job.professional_participant_id,
    },
    canonical,
    quoteDraft,
    professionalInput: professionalInputContext(normalized),
    privacy: {
      exactLocationIncluded: false,
      communicationIncluded: false,
      unrelatedHistoryIncluded: false,
    },
  };
  return {
    ...assembled,
    sourceContextFingerprint: sourceContextFingerprint(assembled),
  };
}

module.exports = {
  MATERIAL_RESPONSIBILITIES,
  UUID_PATTERN,
  assembleQuoteCompositionContext,
  loadAuthorizedJob,
  normalizeProfessionalInput,
  sourceContextFingerprint,
};

"use strict";

const {
  requireDatabasePool,
} = require("./alertContracts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WORK_CENTER_STAGES = Object.freeze([
  "evaluation",
  "quote",
  "deposit",
  "schedule",
  "work",
  "invoice",
  "completion",
  "review",
]);

const ACTIONABLE_WORK_CENTER_EVENT_TYPES = Object.freeze([
  "visit.proposed",
  "visit.schedule_proposed",
  "visit.change_requested",
  "quote.delivered",
  "deposit.required",
  "deposit.request_sent",
  "deposit.payment_recorded",
  "invoice.delivered",
  "invoice.payment_recorded",
]);


const WORK_CENTER_STAGE_SET = new Set(WORK_CENTER_STAGES);

function normalizeCount(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeJobId(value) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeRequestId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : null;
}

function normalizeStage(value) {
  return typeof value === "string" &&
    WORK_CENTER_STAGE_SET.has(value)
    ? value
    : null;
}

function projectWorkCenterAttention(rows = []) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Work Center Alert rows must be an array.");
  }

  const jobs = new Map();

  for (const row of rows) {
    const jobId = normalizeJobId(row?.job_id);
    const requestId = normalizeRequestId(
      row?.request_id
    );
    const stage = normalizeStage(row?.stage);
    const unread = normalizeCount(row?.unread_count);

    if (
      !jobId ||
      !stage ||
      unread === null ||
      unread === 0
    ) {
      continue;
    }

    const current = jobs.get(jobId) || {
      jobId,
      requestId,
      unread: 0,
      stageCounts: new Map(),
    };

    if (current.requestId !== requestId) {
      throw new TypeError(
        "Work Center request identity changed inside one Job."
      );
    }

    current.unread += unread;
    current.stageCounts.set(
      stage,
      (current.stageCounts.get(stage) || 0) + unread
    );

    jobs.set(jobId, current);
  }

  const byJob = [...jobs.values()]
    .sort((left, right) => left.jobId.localeCompare(right.jobId))
    .map((job) => ({
      jobId: job.jobId,
      requestId: job.requestId,
      unread: job.unread,
      stages: WORK_CENTER_STAGES
        .filter((stage) => job.stageCounts.has(stage))
        .map((stage) => ({
          stage,
          unread: job.stageCounts.get(stage),
        })),
    }));

  return Object.freeze({
    unread: byJob.reduce((total, job) => total + job.unread, 0),
    byJob,
  });
}

async function countWorkCenterAttentionForRecipientWithClient({
  client,
  recipientUserId,
}) {
  requireDatabasePool(client);

  const result = await client.query(
    `/* alerts:work_center_attention_counts */
     WITH unread_alerts AS (
       SELECT
         alerts.id,
         alerts.safe_payload,
         alerts.source_event_type,
         alerts.source_entity_type,
         alerts.source_entity_id,
         alerts.category,
         alerts.destination_type,
         alerts.destination_payload,
         visits.purpose AS visit_purpose
       FROM alerts
       LEFT JOIN canonical_visits visits
         ON alerts.destination_type = 'visit'
        AND visits.id::text = alerts.destination_payload->>'visitId'
       WHERE alerts.recipient_user_id = $1
         AND alerts.lifecycle_state = 'active'
         AND alerts.archived_at IS NULL
         AND (
           alerts.read_at IS NULL
           OR alerts.source_event_type IN (
             'visit.proposed',
             'visit.schedule_proposed',
             'visit.change_requested',
             'quote.delivered',
             'deposit.required',
             'deposit.request_sent',
             'deposit.payment_recorded',
             'invoice.delivered',
             'invoice.payment_recorded'
           )
           OR (
             alerts.source_event_type = 'quote.customer_approved'
             AND alerts.safe_payload->>'workCenterStage' = 'deposit'
           )
         )
         AND alerts.available_at <= CURRENT_TIMESTAMP
         AND alerts.destination_payload ? 'jobId'
     ),
     scoped AS (
       SELECT
         id,
         destination_payload->>'jobId' AS job_id,
         CASE
           WHEN safe_payload->>'workCenterStage' IN (
             'evaluation',
             'quote',
             'deposit',
             'schedule',
             'work',
             'invoice',
             'completion',
             'review'
           )
             THEN safe_payload->>'workCenterStage'

           WHEN source_event_type IN (
             'quote.delivered',
             'quote.customer_approved',
             'quote.customer_declined'
           )
             THEN 'quote'

           WHEN source_event_type IN (
             'deposit.required',
             'deposit.satisfied'
           )
             THEN 'deposit'

           WHEN destination_type = 'visit'
             AND visit_purpose = 'EVALUATION'
             THEN 'evaluation'

           WHEN destination_type = 'visit'
             AND visit_purpose = 'APPROVED_WORK'
             AND source_event_type IN (
               'visit.started',
               'visit.completed'
             )
             THEN 'work'

           WHEN destination_type = 'visit'
             AND visit_purpose = 'APPROVED_WORK'
             THEN 'schedule'

           WHEN destination_type = 'visit'
             AND visit_purpose = 'FOLLOW_UP'
             THEN 'work'

           WHEN destination_type = 'invoice'
             THEN 'invoice'

           WHEN category = 'completion'
             THEN 'completion'

           WHEN category = 'review'
             THEN 'review'

           ELSE NULL
         END AS stage
       FROM unread_alerts
     )
     SELECT
       scoped.job_id,
       jobs.job_request_id AS request_id,
       scoped.stage,
       COUNT(DISTINCT scoped.id)::integer AS unread_count
     FROM scoped
     LEFT JOIN jobs
       ON jobs.id::text = scoped.job_id
     WHERE scoped.job_id IS NOT NULL
       AND scoped.stage IS NOT NULL
     GROUP BY
       scoped.job_id,
       jobs.job_request_id,
       scoped.stage
     ORDER BY scoped.job_id, scoped.stage`,
    [recipientUserId]
  );

  return result.rows;
}

module.exports = {
  ACTIONABLE_WORK_CENTER_EVENT_TYPES,
  WORK_CENTER_STAGES,
  countWorkCenterAttentionForRecipientWithClient,
  projectWorkCenterAttention,
};

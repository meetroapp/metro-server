"use strict";

const EXPECTED_COLUMNS = Object.freeze({
  id: { dataType: "integer", nullable: "NO", defaultPattern: /^nextval\(/ },
  quote_request_id: { dataType: "integer", nullable: "NO" },
  user_id: { dataType: "integer", nullable: "NO" },
  workflow_type: { dataType: "text", nullable: "NO" },
  workflow_status: { dataType: "text", nullable: "YES" },
  workflow_payload: {
    dataType: "jsonb",
    nullable: "YES",
    defaultPattern: /'\{\}'::jsonb/,
  },
  event_label: { dataType: "text", nullable: "YES" },
  created_at: {
    dataType: "timestamp without time zone",
    nullable: "YES",
    defaultPattern: /CURRENT_TIMESTAMP|now\(\)/i,
  },
});

function validateWorkflowEventColumns(rows) {
  const byName = new Map((rows || []).map((row) => [row.column_name, row]));
  if (byName.size !== Object.keys(EXPECTED_COLUMNS).length) return false;

  return Object.entries(EXPECTED_COLUMNS).every(([name, expected]) => {
    const row = byName.get(name);
    return Boolean(
      row &&
        row.data_type === expected.dataType &&
        row.is_nullable === expected.nullable &&
        (!expected.defaultPattern ||
          expected.defaultPattern.test(String(row.column_default || "")))
    );
  });
}

function validateWorkflowEventConstraints(rows) {
  const source = (rows || [])
    .map((row) => `${row.contype}:${row.definition}`)
    .join("\n");
  return (
    /p:PRIMARY KEY \(id\)/i.test(source) &&
    /f:FOREIGN KEY \(quote_request_id\) REFERENCES quote_requests\(id\) ON DELETE CASCADE/i.test(
      source
    ) &&
    /f:FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i.test(
      source
    )
  );
}

function validateWorkflowEventIndexes(rows) {
  const index = (rows || []).find(
    (row) => row.indexname === "workflow_events_quote_request_id_created_at_idx"
  );
  return /\(quote_request_id, created_at\)/i.test(index?.indexdef || "");
}

async function inspectWorkflowEventsSchema(client) {
  const relationsResult = await client.query(`
    SELECT
      to_regclass('public.users') IS NOT NULL AS users_exists,
      to_regclass('public.quote_requests') IS NOT NULL AS quote_requests_exists,
      to_regclass('public.workflow_events') IS NOT NULL AS table_exists,
      to_regclass('public.workflow_events_id_seq') IS NOT NULL AS sequence_exists,
      to_regclass('public.workflow_events_quote_request_id_created_at_idx')
        IS NOT NULL AS index_exists
  `);
  const relations = relationsResult.rows[0] || {};
  if (!relations.users_exists || !relations.quote_requests_exists) {
    const error = new Error("Workflow-event prerequisite tables are missing.");
    error.code = "WORKFLOW_EVENTS_PREREQUISITE_MISSING";
    throw error;
  }
  if (!relations.table_exists) {
    if (relations.sequence_exists || relations.index_exists) {
      const error = new Error("Conflicting workflow-event relations exist.");
      error.code = "WORKFLOW_EVENTS_RELATION_CONFLICT";
      throw error;
    }
    return { exists: false, valid: false, rowCount: 0 };
  }

  const columns = await client.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'workflow_events'
    ORDER BY ordinal_position
  `);
  const constraints = await client.query(`
    SELECT c.contype, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.conrelid = 'public.workflow_events'::regclass
    ORDER BY c.contype, c.conname
  `);
  const indexes = await client.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'workflow_events'
    ORDER BY indexname
  `);
  const count = await client.query(
    "SELECT COUNT(*)::bigint AS count FROM workflow_events"
  );
  const valid =
    Boolean(relations.sequence_exists) &&
    validateWorkflowEventColumns(columns.rows) &&
    validateWorkflowEventConstraints(constraints.rows) &&
    validateWorkflowEventIndexes(indexes.rows);
  if (!valid) {
    const error = new Error("Existing workflow-event schema is incompatible.");
    error.code = "WORKFLOW_EVENTS_SCHEMA_CONFLICT";
    throw error;
  }

  return {
    exists: true,
    valid: true,
    rowCount: Number(count.rows[0]?.count || 0),
    columnCount: columns.rows.length,
    requiredConstraintCount: 3,
    requiredIndexCount: 1,
    sequenceValid: true,
  };
}

module.exports = {
  EXPECTED_COLUMNS,
  inspectWorkflowEventsSchema,
  validateWorkflowEventColumns,
  validateWorkflowEventConstraints,
  validateWorkflowEventIndexes,
};

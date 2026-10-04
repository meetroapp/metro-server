"use strict";

const { createHash } = require("node:crypto");
const { LEGACY_ROW_COLUMNS } = require("./prestate");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCatalogRows(rows) {
  return rows
    .map((row) => Object.entries(row).sort(([left], [right]) =>
      left.localeCompare(right)
    ))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function catalogFingerprint(rows) {
  return Object.freeze({
    count: rows.length,
    sha256: sha256(JSON.stringify(canonicalCatalogRows(rows))),
  });
}

function identityFingerprint(values) {
  return sha256(values.map(String).join(","));
}

function rowFingerprint(rows) {
  return sha256(JSON.stringify(rows));
}

const CATALOG_QUERIES = Object.freeze({
  tables: `
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  columns: `
    SELECT table_name, column_name, ordinal_position, data_type, udt_name,
           is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'`,
  constraints: `
    SELECT conrelid::regclass::text AS table_name, conname, contype,
           pg_get_constraintdef(oid, true) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace`,
  indexes: `
    SELECT table_relation.relname AS table_name,
           index_relation.relname AS index_name,
           pg_get_indexdef(index_relation.oid) AS definition
      FROM pg_index index_record
      JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
      JOIN pg_class table_relation ON table_relation.oid = index_record.indrelid
     WHERE table_relation.relnamespace = 'public'::regnamespace`,
  functions: `
    SELECT proname, pg_get_function_identity_arguments(oid) AS arguments,
           pg_get_functiondef(oid) AS definition
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace`,
  triggers: `
    SELECT tgrelid::regclass::text AS table_name, tgname,
           pg_get_triggerdef(oid, true) AS definition
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgrelid IN (
         SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace
       )`,
});

async function readCatalog(client) {
  const catalog = {};
  for (const [name, sql] of Object.entries(CATALOG_QUERIES)) {
    catalog[name] = catalogFingerprint((await client.query(sql)).rows);
  }
  return catalog;
}

async function readLedger(client) {
  const result = await client.query(`
    SELECT filename, checksum, execution_target
      FROM schema_migrations
     ORDER BY filename`);
  return result.rows.map(({ filename, checksum, execution_target }) => ({
    filename,
    checksum,
    executionTarget: execution_target,
  }));
}

async function tableExists(client, table) {
  const result = await client.query(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${table}`]
  );
  return result.rows[0].present;
}

async function readIdentity(client, table, expression = "id::text", order = "id") {
  if (!(await tableExists(client, table))) return null;
  const result = await client.query(
    `SELECT ${expression} AS identity FROM ${table} ORDER BY ${order}`
  );
  return {
    count: result.rows.length,
    identitySha256: identityFingerprint(result.rows.map(({ identity }) => identity)),
  };
}

async function readLegacyRows(client, table, columns) {
  if (!(await tableExists(client, table))) return null;
  const projection = columns.map((column) => `source.${column}`).join(", ");
  const result = await client.query(
    `SELECT to_jsonb(projected) AS row
       FROM (SELECT ${projection} FROM ${table} source ORDER BY source.id) projected`
  );
  return rowFingerprint(result.rows.map(({ row }) => row));
}

async function readPreservation(client) {
  const preservation = {};
  for (const table of [
    "users", "contractor_profiles", "contractor_projects", "posts",
    "quote_requests", "messages", "conversations", "request_relationships",
    "workflow_events",
  ]) {
    preservation[table] = await readIdentity(client, table);
  }
  preservation.conversation_participant_state = await readIdentity(
    client,
    "conversation_participant_state",
    "conversation_id::text || ':' || user_id::text",
    "conversation_id, user_id"
  );
  preservation.legacy_orphan_message_archive = await readIdentity(
    client,
    "legacy_orphan_message_archive",
    "message_id::text || ':' || source_record_sha256",
    "message_id"
  );
  for (const [table, columns] of Object.entries(LEGACY_ROW_COLUMNS)) {
    if (preservation[table]) {
      preservation[table].legacyRowSha256 = await readLegacyRows(client, table, columns);
    }
  }
  return preservation;
}

module.exports = Object.freeze({
  CATALOG_QUERIES,
  canonicalCatalogRows,
  catalogFingerprint,
  identityFingerprint,
  readCatalog,
  readLedger,
  readPreservation,
  rowFingerprint,
  sha256,
  tableExists,
});

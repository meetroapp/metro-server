"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const migrationName = "202608010002_create_canonical_evaluations.sql";
const participantStateMigrationName =
  "202608030001_create_conversation_participant_state.sql";
const sql = readFileSync(join(root, "migrations", migrationName), "utf8");

test("canonical Evaluation migration remains unique, additive, and ordered before participant read state", () => {
  const migrations = readdirSync(join(root, "migrations"))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  assert.ok(migrations.includes(participantStateMigrationName));
  assert.ok(
    migrations.indexOf(migrationName) <
      migrations.indexOf(participantStateMigrationName)
  );
  assert.equal(migrations.filter((name) => name.startsWith("202608010002_")).length, 1);
  assert.doesNotMatch(sql, /\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(sql, /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:workflow_events|emergency_requests|request_relationships)\b/i);
});

test("Evaluation identity extends the commercial aggregate and retains source history", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_evaluations/i);
  assert.match(sql, /aggregate_type = 'evaluation'/i);
  assert.match(sql, /owning_engine = 'authorization_engine'/i);
  assert.match(sql, /FOREIGN KEY \(id, aggregate_type, owning_engine\)[\s\S]*REFERENCES commercial_authority_aggregates[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /relationship_id INTEGER NOT NULL[\s\S]*REFERENCES request_relationships\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /professional_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(sql, /UNIQUE \(relationship_id, professional_user_id\)/i);
});

test("Evaluation lifecycle and completed truth are constrained", () => {
  assert.match(sql, /status IN \('draft', 'completed'\)/i);
  assert.match(sql, /status = 'draft' AND completed_at IS NULL/i);
  assert.match(sql, /status = 'completed' AND completed_at IS NOT NULL/i);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
});

test("version history is structured, bounded, append-oriented, and not one uncontrolled JSON object", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS canonical_evaluation_versions/i);
  assert.match(sql, /PRIMARY KEY \(evaluation_id, version\)/i);
  assert.match(sql, /observations TEXT[\s\S]*char_length\(observations\) <= 5000/i);
  assert.match(sql, /diagnosis_summary TEXT[\s\S]*limitations TEXT/i);
  assert.match(sql, /measurements JSONB[\s\S]*findings JSONB[\s\S]*scope_recommendations JSONB/i);
  assert.match(sql, /jsonb_typeof\(measurements\) = 'array'/i);
  assert.match(sql, /canonical_evaluation_version_history_idx/i);
  assert.doesNotMatch(sql, /form_definition|uncontrolled_payload|evaluation_data JSONB/i);
});

test("only the minimum Evaluation commands and evidence types extend the foundation", () => {
  for (const command of [
    "evaluation.create",
    "evaluation.draft.update",
    "evaluation.complete",
  ]) assert.match(sql, new RegExp(command.replaceAll(".", "\\.")));
  for (const evidence of [
    "evaluation_created",
    "evaluation_draft_updated",
    "evaluation_completed",
  ]) assert.match(sql, new RegExp(evidence));
  assert.doesNotMatch(sql, /evaluation_revised|quote_created|authorization_issued/i);
});

test("evidence traces the certified foundation and Evaluation capability separately", () => {
  assert.match(sql, /capability_milestone_id TEXT[\s\S]*DEFAULT 'MC-WORKFLOW-002A'/i);
  assert.match(sql, /'MC-WORKFLOW-002A',[\s\S]*'MC-WORKFLOW-002B'/i);
});

test("migration does not promote browser or legacy authority", () => {
  assert.doesNotMatch(sql, /localStorage|sessionStorage|legacy|meetro_business_schedule/i);
  assert.doesNotMatch(sql, /INSERT INTO canonical_evaluations[\s\S]*SELECT/i);
  assert.doesNotMatch(sql, /workflow_events/i);
});

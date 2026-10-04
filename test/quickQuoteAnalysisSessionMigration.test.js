"use strict";

const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const repositoryRoot = join(__dirname, "..");
const migrationName =
  "202608190001_create_quick_quote_analysis_session_foundation.sql";
const migrationPath = join(
  repositoryRoot,
  "migrations",
  migrationName
);

const sql = readFileSync(migrationPath, "utf8");
const readme = readFileSync(
  join(repositoryRoot, "migrations", "README.md"),
  "utf8"
);

test(
  "Quick Quote analysis-session migration is additive, ordered, and inventoried",
  () => {
    const migrations = readdirSync(
      join(repositoryRoot, "migrations")
    )
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    assert.ok(migrations.includes(migrationName));

    assert.ok(
      migrations.indexOf(
        "202608180001_expand_ask_meetro_workflow_review_operations.sql"
      ) < migrations.indexOf(migrationName)
    );

    assert.equal(
      migrations.filter((filename) =>
        filename.startsWith("202608190001_")
      ).length,
      1
    );

    assert.match(
      readme,
      /46\. `202608190001_create_quick_quote_analysis_session_foundation\.sql`/
    );

    assert.doesNotMatch(
      sql,
      /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\s+\S+\s+SET\b)/im
    );
  }
);

test(
  "session identity is private, non-canonical, and exactly user-owned",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS quick_quote_analysis_sessions/i
    );

    assert.match(
      sql,
      /actor_user_id INTEGER NOT NULL[\s\S]*REFERENCES users\(id\)/i
    );

    assert.match(
      sql,
      /authority_scope = 'user:' \|\| actor_user_id::TEXT/i
    );

    assert.match(
      sql,
      /authority_classification = 'PRIVATE_NON_CANONICAL'/i
    );

    assert.match(
      sql,
      /UNIQUE \(id, actor_user_id\)/i
    );
  }
);

test(
  "evidence is immutable, versioned, fingerprinted, bounded, and removable with its session",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS quick_quote_analysis_evidence_versions/i
    );

    assert.match(
      sql,
      /PRIMARY KEY \(session_id, version\)/i
    );

    assert.match(
      sql,
      /evidence_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i
    );

    assert.doesNotMatch(
      sql,
      /UNIQUE\s*\(\s*session_id\s*,\s*evidence_fingerprint\s*\)/i
    );

    assert.match(
      sql,
      /jsonb_array_length\(photo_references\) <= 5/i
    );

    assert.match(
      sql,
      /char_length\(btrim\(professional_input\)\) > 0[\s\S]*OR[\s\S]*jsonb_array_length\(photo_references\) > 0/i
    );

    assert.match(
      sql,
      /quick_quote_analysis_evidence_session_fk[\s\S]*ON DELETE CASCADE/i
    );

    assert.match(
      sql,
      /BEFORE UPDATE ON quick_quote_analysis_evidence_versions/i
    );

    assert.doesNotMatch(
      sql,
      /BEFORE UPDATE OR DELETE ON quick_quote_analysis_evidence_versions/i
    );
  }
);

test(
  "private turns have deterministic per-session ordering and exact evidence-version lineage",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS quick_quote_analysis_turns/i
    );

    assert.match(
      sql,
      /turn_index INTEGER NOT NULL[\s\S]*CHECK \(turn_index >= 1\)/i
    );

    assert.match(
      sql,
      /role IN \('PROFESSIONAL', 'MEETRO'\)/i
    );

    assert.match(
      sql,
      /FOREIGN KEY \([\s\S]*session_id,[\s\S]*evidence_version,[\s\S]*actor_user_id[\s\S]*\)[\s\S]*REFERENCES quick_quote_analysis_evidence_versions/i
    );

    assert.match(
      sql,
      /UNIQUE \(session_id, turn_index\)/i
    );

    assert.match(
      sql,
      /jsonb_typeof\(turn_payload\) = 'object'[\s\S]*octet_length\(turn_payload::TEXT\) <= 65536/i
    );

    assert.match(
      sql,
      /quick_quote_analysis_turn_session_fk[\s\S]*ON DELETE CASCADE/i
    );
  }
);

test(
  "analysis-session commands have scoped durable idempotency without provider execution state",
  () => {
    assert.match(
      sql,
      /CREATE TABLE IF NOT EXISTS quick_quote_analysis_command_idempotency/i
    );

    for (const command of [
      "quick_quote.analysis_session.create",
      "quick_quote.analysis_evidence.append",
      "quick_quote.analysis_turn.append",
      "quick_quote.analysis_session.discard",
    ]) {
      assert.match(sql, new RegExp(command.replaceAll(".", "\\.")));
    }

    assert.match(
      sql,
      /request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/i
    );

    assert.match(
      sql,
      /UNIQUE \([\s\S]*actor_user_id,[\s\S]*authority_scope,[\s\S]*command_name,[\s\S]*command_scope,[\s\S]*idempotency_key[\s\S]*\)/i
    );

    assert.doesNotMatch(
      sql,
      /provider_execution_state|usage_state|provider_name|openai/i
    );
  }
);

test(
  "R1-02 foundation creates no adjacent business authority or provider continuation",
  () => {
    assert.doesNotMatch(
      sql,
      /\b(job_id|quote_id|request_id|conversation_id|invoice_id|payment_id|customer_id)\b/i
    );

    assert.doesNotMatch(
      sql,
      /REFERENCES\s+(?:jobs|canonical_quotes|canonical_invoices|conversations|posts)\b/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO lifecycle_capabilities|customer_visible|published_at|issued_at/i
    );

    assert.doesNotMatch(
      sql,
      /quick_quote\.analysis\.continue|Responses API|provider request/i
    );
  }
);

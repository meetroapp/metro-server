"use strict";

const assert =
  require("node:assert/strict");

const {
  readFileSync,
  readdirSync,
} = require("node:fs");

const test =
  require("node:test");

const file =
  "migrations/202609160009_create_business_customer_evaluation_visit_confirmation.sql";

const sql =
  readFileSync(
    file,
    "utf8"
  );


test(
  "009 follows the certified 008 Evaluation source migration",
  () => {
    const files =
      readdirSync("migrations")
        .filter(
          (name) =>
            /^20260916000[1-9]_/.test(
              name
            )
        )
        .sort();

    const eight =
      files.indexOf(
        "202609160008_generalize_canonical_evaluation_job_sources.sql"
      );

    const nine =
      files.indexOf(
        "202609160009_create_business_customer_evaluation_visit_confirmation.sql"
      );

    assert.equal(
      nine,
      eight + 1
    );
  }
);


test(
  "009 creates dedicated business customer Evaluation Visit confirmation evidence",
  () => {
    assert.match(
      sql,
      /CREATE TABLE[\s\S]*canonical_evaluation_visit_external_confirmation_evidence/i
    );

    assert.match(
      sql,
      /visit_purpose[\s\S]*'EVALUATION'/i
    );

    assert.match(
      sql,
      /business_customer_job_source_id/i
    );

    assert.match(
      sql,
      /business_customer_relationship_id/i
    );
  }
);


test(
  "Evaluation Visit confirmation evidence is Job and Visit scoped, not Evaluation scoped",
  () => {
    const start =
      sql.indexOf(
        "CREATE TABLE"
      );

    const end =
      sql.indexOf(
        "CREATE INDEX",
        start
      );

    const table =
      sql.slice(
        start,
        end
      );

    assert.doesNotMatch(
      table,
      /\bevaluation_id\b/i
    );

    assert.match(
      table,
      /\bjob_id\b/i
    );

    assert.match(
      table,
      /\bvisit_id\b/i
    );
  }
);


test(
  "external confirmation binds exact proposed and scheduled Visit identity",
  () => {
    assert.match(
      sql,
      /proposed_visit_version[\s\S]*proposed_integrity_hash[\s\S]*scheduled_visit_version/i
    );

    assert.match(
      sql,
      /scheduled_visit_version[\s\S]*proposed_visit_version \+ 1/i
    );

    assert.match(
      sql,
      /scheduled\.scheduled_start_at =[\s\S]*proposed\.scheduled_start_at/i
    );

    assert.match(
      sql,
      /scheduled\.time_zone =[\s\S]*proposed\.time_zone/i
    );
  }
);


test(
  "database proves exact professional-only business customer authority",
  () => {
    assert.match(
      sql,
      /jobs\.source_type =[\s\S]*'business_customer'/i
    );

    assert.match(
      sql,
      /actor\.request_relationship_id[\s\S]*IS NULL/i
    );

    assert.match(
      sql,
      /actor\.source_evidence_type =[\s\S]*'business_customer'/i
    );

    assert.match(
      sql,
      /roles\.role =[\s\S]*'PRIMARY_PROFESSIONAL'/i
    );

    assert.match(
      sql,
      /business_contact_roles[\s\S]*roles\.role =[\s\S]*'CUSTOMER'/i
    );
  }
);


test(
  "business customer scheduled Evaluation Visit requires confirmation evidence",
  () => {
    assert.match(
      sql,
      /require_business_customer_evaluation_visit_schedule_evidence/i
    );

    assert.match(
      sql,
      /NEW\.state = 'SCHEDULED'[\s\S]*visits\.purpose =[\s\S]*'EVALUATION'[\s\S]*jobs\.source_type =[\s\S]*'business_customer'/i
    );

    assert.match(
      sql,
      /DEFERRABLE INITIALLY DEFERRED/i
    );
  }
);


test(
  "009B-1 does not introduce Quote deposit Request or Meetro customer authority",
  () => {
    assert.doesNotMatch(
      sql,
      /canonical_quote_approvals|canonical_pre_work|request_relationships|CUSTOMER_REPRESENTATIVE/i
    );

    assert.doesNotMatch(
      sql,
      /INSERT INTO\s+lifecycle_authority_grants/i
    );
  }
);


test(
  "009B-1 creates no lifecycle business rows",
  () => {
    assert.doesNotMatch(
      sql,
      /INSERT INTO\s+(?:canonical_visits|canonical_visit_versions|canonical_evaluations|jobs|relationship_participants)\b/i
    );

    assert.doesNotMatch(
      sql,
      /\bUPDATE\s+(?:canonical_visits|canonical_visit_versions|canonical_evaluations|jobs|relationship_participants)\b/i
    );
  }
);

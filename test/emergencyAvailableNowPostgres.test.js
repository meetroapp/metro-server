"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { Client } = require("pg");

const {
  getMigrationFiles,
} = require("../scripts/run-migrations");

const {
  assertSafeTestDatabaseUrl,
} = require("./helpers/databaseTargetSafety");

const {
  createProfessionalEmergencyResponse,
  listHomeownerEmergencyResponses,
} = require(
  "../server/relationships/requestRelationshipService"
);

const {
  listHomeownerAvailableEmergencyProfessionals,
  professionalCanSeeEmergencyOpportunity,
} = require(
  "../server/emergency/emergencyOpportunityService"
);

const {
  selectHomeownerAvailableEmergencyProfessional,
} = require(
  "../server/emergency/emergencySelectionService"
);

const {
  getOwnedEmergencyRequest,
} = require(
  "../server/emergency/emergencyRequestService"
);

const runtimeUrl =
  process.env.EMERGENCY_AVAILABLE_NOW_DATABASE_URL;

const upgradeUrl =
  process.env.EMERGENCY_AVAILABLE_NOW_UPGRADE_DATABASE_URL;

const migration105 =
  getMigrationFiles().at(-1);

assert.equal(
  migration105.filename,
  "202609210001_add_emergency_available_now_direct_select_authority.sql"
);

function transactionalFacade(client) {
  const facade = {
    async query(sql, values) {
      const normalized =
        String(sql).trim();

      if (/^BEGIN\b/i.test(normalized)) {
        return client.query(
          "SAVEPOINT emergency_available_now_service"
        );
      }

      if (normalized === "COMMIT") {
        return client.query(
          "RELEASE SAVEPOINT emergency_available_now_service"
        );
      }

      if (normalized === "ROLLBACK") {
        await client.query(
          "ROLLBACK TO SAVEPOINT emergency_available_now_service"
        );

        return client.query(
          "RELEASE SAVEPOINT emergency_available_now_service"
        );
      }

      return client.query(sql, values);
    },

    async connect() {
      return facade;
    },

    release() {},
  };

  return facade;
}

async function user(
  client,
  {
    username,
    professional = false,
  }
) {
  return (
    await client.query(
      `
      INSERT INTO users
      (
        username,
        email,
        password_hash,
        role,
        account_type
      )
      VALUES (
        $1,
        $2,
        'test-hash',
        $3,
        $4
      )
      RETURNING id
      `,
      [
        username,
        `${randomUUID()}@example.test`,
        professional
          ? "handyman"
          : "homeowner",
        professional
          ? "professional"
          : "homeowner",
      ]
    )
  ).rows[0].id;
}

async function business(
  client,
  {
    userId,
    name,
    availableNow,
    dispatchReady,
  }
) {
  return (
    await client.query(
      `
      INSERT INTO contractor_profiles
      (
        user_id,
        business_name,
        category,
        location,
        profile_details
      )
      VALUES (
        $1,
        $2,
        'plumbing',
        'Cape Coral, FL',
        $3::jsonb
      )
      RETURNING id
      `,
      [
        userId,
        name,
        JSON.stringify({
          service_specialties: [
            "plumbing",
          ],
          service_area:
            "Cape Coral",
          city:
            "Cape Coral",
          postal_code:
            "33904",
          available_now:
            availableNow,
          dispatch_ready:
            dispatchReady,
        }),
      ]
    )
  ).rows[0].id;
}

async function emergencyRequest(
  client,
  homeownerId
) {
  const request = (
    await client.query(
      `
      INSERT INTO emergency_requests
      (
        homeowner_id,
        category,
        service_domain,
        service_specialty,
        title,
        description,
        location_text,
        status,
        requested_at
      )
      VALUES (
        $1,
        'plumbing',
        'home_services',
        'plumbing_repair',
        'Emergency leak',
        'Active plumbing leak.',
        'Cape Coral, FL',
        'ready_for_distribution',
        CURRENT_TIMESTAMP
      )
      RETURNING *
      `,
      [homeownerId]
    )
  ).rows[0];

  await client.query(
    `
    INSERT INTO emergency_request_safety_assessments
    (
      emergency_request_id,
      immediate_danger,
      medical_emergency,
      fire_or_smoke,
      gas_odor_or_suspected_leak,
      active_crime_or_threat,
      electrical_immediate_hazard,
      structural_collapse_risk,
      flooding_or_water_damage,
      occupants_unable_to_exit,
      emergency_services_contacted,
      safe_to_remain_at_location,
      additional_safety_context,
      disposition
    )
    VALUES (
      $1,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      FALSE,
      TRUE,
      '',
      'continue'
    )
    `,
    [request.id]
  );

  return request;
}

async function rejectsSql(
  client,
  sql,
  values
) {
  await client.query(
    "SAVEPOINT expected_rejection"
  );

  try {
    await assert.rejects(
      client.query(sql, values),
      /check constraint|violates/i
    );
  } finally {
    await client.query(
      "ROLLBACK TO SAVEPOINT expected_rejection"
    );
  }
}

test(
  "migration 105 upgrades legacy Emergency response provenance and enforces truthful timestamp shapes",
  {
    skip: !upgradeUrl,
    timeout: 120000,
  },
  async () => {
    assertSafeTestDatabaseUrl(
      upgradeUrl,
      {
        nodeEnv:
          process.env.NODE_ENV,
      }
    );

    const client =
      new Client({
        connectionString:
          upgradeUrl,
      });

    await client.connect();

    try {
      await client.query("BEGIN");

      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('public.users') AS existing"
          )
        ).rows[0].existing,
        null
      );

      const migrations =
        getMigrationFiles();

      for (
        const migration of
        migrations.slice(0, -1)
      ) {
        await client.query(
          migration.sql
        );
      }

      const homeownerId =
        await user(client, {
          username:
            "legacy-homeowner",
        });

      const professionalId =
        await user(client, {
          username:
            "legacy-professional",
          professional: true,
        });

      const profileId =
        await business(client, {
          userId:
            professionalId,
          name:
            "Legacy Response Plumbing",
          availableNow: false,
          dispatchReady: false,
        });

      const request =
        await emergencyRequest(
          client,
          homeownerId
        );

      const legacy =
        (
          await client.query(
            `
            INSERT INTO request_relationships
            (
              post_id,
              emergency_request_id,
              homeowner_id,
              contractor_id,
              professional_user_id,
              status,
              introduction_text
            )
            VALUES (
              NULL,
              $1,
              $2,
              $3,
              $4,
              'pending',
              ''
            )
            RETURNING *
            `,
            [
              request.id,
              homeownerId,
              profileId,
              professionalId,
            ]
          )
        ).rows[0];

      assert.ok(
        legacy.responded_at
      );

      // Migrations 1-104 and the legacy fixture intentionally share this
      // rollback-only test transaction. Flush deferred relationship trigger
      // events before ALTER TABLE so this models the real deployment boundary,
      // where pre-105 relationship rows are already committed.
      await client.query(
        "SET CONSTRAINTS ALL IMMEDIATE"
      );

      await client.query(
        migration105.sql
      );

      await client.query(
        "SET CONSTRAINTS ALL DEFERRED"
      );

      const upgraded =
        (
          await client.query(
            `
            SELECT *
            FROM request_relationships
            WHERE id = $1
            `,
            [legacy.id]
          )
        ).rows[0];

      assert.equal(
        upgraded
          .emergency_authority_source,
        "professional_response"
      );

      assert.equal(
        new Date(
          upgraded.responded_at
        ).toISOString(),
        new Date(
          legacy.responded_at
        ).toISOString()
      );

      await rejectsSql(
        client,
        `
        UPDATE request_relationships
        SET responded_at = NULL
        WHERE id = $1
        `,
        [legacy.id]
      );

      await rejectsSql(
        client,
        `
        UPDATE request_relationships
        SET
          status = 'active',
          emergency_authority_source =
            'available_now_direct_select'
        WHERE id = $1
        `,
        [legacy.id]
      );

      const directProfessionalId =
        await user(client, {
          username:
            "direct-professional",
          professional: true,
        });

      const directProfileId =
        await business(client, {
          userId:
            directProfessionalId,
          name:
            "Direct Plumbing",
          availableNow: true,
          dispatchReady: true,
        });

      const directRequest =
        await emergencyRequest(
          client,
          homeownerId
        );

      const direct =
        (
          await client.query(
            `
            INSERT INTO request_relationships
            (
              post_id,
              emergency_request_id,
              homeowner_id,
              contractor_id,
              professional_user_id,
              emergency_authority_source,
              status,
              introduction_text,
              responded_at,
              accepted_at
            )
            VALUES (
              NULL,
              $1,
              $2,
              $3,
              $4,
              'available_now_direct_select',
              'active',
              '',
              NULL,
              CURRENT_TIMESTAMP
            )
            RETURNING *
            `,
            [
              directRequest.id,
              homeownerId,
              directProfileId,
              directProfessionalId,
            ]
          )
        ).rows[0];

      assert.equal(
        direct.responded_at,
        null
      );

      assert.equal(
        direct
          .emergency_authority_source,
        "available_now_direct_select"
      );

      await rejectsSql(
        client,
        `
        UPDATE request_relationships
        SET responded_at =
          CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [direct.id]
      );
    } finally {
      await client.query(
        "ROLLBACK"
      );

      assert.equal(
        (
          await client.query(
            "SELECT to_regclass('public.users') AS existing"
          )
        ).rows[0].existing,
        null
      );

      await client.end();
    }
  }
);

test(
  "real PostgreSQL keeps Emergency responses separate while Available Now direct selection creates one canonical relationship, Conversation and Job",
  {
    skip: !runtimeUrl,
    timeout: 120000,
  },
  async () => {
    assertSafeTestDatabaseUrl(
      runtimeUrl,
      {
        nodeEnv:
          process.env.NODE_ENV,
      }
    );

    const client =
      new Client({
        connectionString:
          runtimeUrl,
      });

    await client.connect();

    try {
      await client.query("BEGIN");

      const pool =
        transactionalFacade(
          client
        );

      const homeownerId =
        await user(client, {
          username:
            "available-now-homeowner",
        });

      const directProfessionalId =
        await user(client, {
          username:
            "available-now-direct",
          professional: true,
        });

      const responderId =
        await user(client, {
          username:
            "available-now-responder",
          professional: true,
        });

      const directProfileId =
        await business(client, {
          userId:
            directProfessionalId,
          name:
            "Available Now Plumbing",
          availableNow: true,
          dispatchReady: true,
        });

      const responderProfileId =
        await business(client, {
          userId:
            responderId,
          name:
            "Response Only Plumbing",
          availableNow: false,
          dispatchReady: false,
        });

      const request =
        await emergencyRequest(
          client,
          homeownerId
        );

      const discovery =
        await listHomeownerAvailableEmergencyProfessionals({
          pool,
          homeownerUserId:
            homeownerId,
          emergencyRequestId:
            request.id,
        });

      assert.equal(
        discovery.ok,
        true
      );

      assert.deepEqual(
        discovery.professionals.map(
          ({
            contractorProfileId,
          }) =>
            contractorProfileId
        ),
        [directProfileId]
      );

      const response =
        await createProfessionalEmergencyResponse({
          pool,
          professionalUserId:
            responderId,
          emergencyRequestId:
            request.id,
          payload: {},
          professionalCanSeeEmergencyOpportunity,
          async projectEmergencyResponseAlert() {},
        });

      assert.equal(
        response.ok,
        true
      );

      const responseRow =
        (
          await client.query(
            `
            SELECT *
            FROM request_relationships
            WHERE id = $1
            `,
            [
              response
                .relationship.id,
            ]
          )
        ).rows[0];

      assert.equal(
        responseRow
          .contractor_id,
        responderProfileId
      );

      assert.equal(
        responseRow
          .emergency_authority_source,
        "professional_response"
      );

      assert.ok(
        responseRow.responded_at
      );

      assert.equal(
        responseRow.status,
        "pending"
      );

      const selection =
        await selectHomeownerAvailableEmergencyProfessional({
          pool,
          homeownerUserId:
            homeownerId,
          emergencyRequestId:
            request.id,
          contractorProfileId:
            directProfileId,
        });

      assert.equal(
        selection.ok,
        true
      );

      assert.equal(
        selection.code,
        "EMERGENCY_AVAILABLE_PROFESSIONAL_SELECTED"
      );

      assert.equal(
        selection
          .declinedResponseCount,
        1
      );

      const directRow =
        (
          await client.query(
            `
            SELECT *
            FROM request_relationships
            WHERE id = $1
            `,
            [
              selection
                .relationship.id,
            ]
          )
        ).rows[0];

      assert.equal(
        directRow.status,
        "active"
      );

      assert.equal(
        directRow.responded_at,
        null
      );

      assert.equal(
        directRow
          .emergency_authority_source,
        "available_now_direct_select"
      );

      const ownedAfterDirectSelection =
        await getOwnedEmergencyRequest({
          pool,
          homeownerUserId:
            homeownerId,
          emergencyRequestId:
            request.id,
        });

      assert.equal(
        ownedAfterDirectSelection.ok,
        true
      );

      assert.equal(
        ownedAfterDirectSelection
          .emergencyRequest
          .hasSelectedProfessional,
        true
      );

      assert.ok(
        ownedAfterDirectSelection
          .emergencyRequest
          .selectedProfessionalBusinessName
      );

      assert.equal(
        ownedAfterDirectSelection
          .emergencyRequest
          .conversationAvailable,
        true
      );

      assert.equal(
        ownedAfterDirectSelection
          .emergencyRequest
          .conversationId,
        selection.conversation.id
      );

      const competing =
        (
          await client.query(
            `
            SELECT *
            FROM request_relationships
            WHERE id = $1
            `,
            [
              response
                .relationship.id,
            ]
          )
        ).rows[0];

      assert.equal(
        competing.status,
        "declined"
      );

      const assigned =
        (
          await client.query(
            `
            SELECT *
            FROM emergency_requests
            WHERE id = $1
            `,
            [request.id]
          )
        ).rows[0];

      assert.equal(
        assigned.status,
        "assigned"
      );

      assert.ok(
        assigned.assigned_at
      );

      const activeCount =
        Number(
          (
            await client.query(
              `
              SELECT COUNT(*)::integer
                AS count
              FROM request_relationships
              WHERE emergency_request_id =
                $1
                AND status = 'active'
              `,
              [request.id]
            )
          ).rows[0].count
        );

      assert.equal(
        activeCount,
        1
      );

      const conversationRows =
        (
          await client.query(
            `
            SELECT *
            FROM conversations
            WHERE relationship_id = $1
            `,
            [
              directRow.id,
            ]
          )
        ).rows;

      assert.equal(
        conversationRows.length,
        1
      );

      assert.equal(
        conversationRows[0]
          .status,
        "active"
      );

      const jobs =
        (
          await client.query(
            `
            SELECT *
            FROM jobs
            WHERE
              source_emergency_request_id =
                $1
              AND
              source_request_relationship_id =
                $2
            `,
            [
              request.id,
              directRow.id,
            ]
          )
        ).rows;

      assert.equal(
        jobs.length,
        1
      );

      assert.equal(
        jobs[0].source_type,
        "emergency_request"
      );

      const responseInbox =
        await listHomeownerEmergencyResponses({
          pool,
          homeownerUserId:
            homeownerId,
          emergencyRequestId:
            request.id,
        });

      assert.equal(
        responseInbox.ok,
        true
      );

      assert.deepEqual(
        responseInbox.responses.map(
          ({ id }) => id
        ),
        [
          response
            .relationship.id,
        ]
      );

      assert.equal(
        responseInbox.responses.some(
          ({ id }) =>
            String(id) ===
            String(
              directRow.id
            )
        ),
        false
      );

      const countsBeforeReplay =
        (
          await client.query(
            `
            SELECT
              (
                SELECT COUNT(*)
                FROM request_relationships
                WHERE emergency_request_id =
                  $1
              )::integer
                AS relationships,
              (
                SELECT COUNT(*)
                FROM conversations
                WHERE relationship_id =
                  $2
              )::integer
                AS conversations,
              (
                SELECT COUNT(*)
                FROM jobs
                WHERE
                  source_emergency_request_id =
                    $1
                  AND
                  source_request_relationship_id =
                    $2
              )::integer
                AS jobs
            `,
            [
              request.id,
              directRow.id,
            ]
          )
        ).rows[0];

      const replay =
        await selectHomeownerAvailableEmergencyProfessional({
          pool,
          homeownerUserId:
            homeownerId,
          emergencyRequestId:
            request.id,
          contractorProfileId:
            directProfileId,
        });

      assert.equal(
        replay.ok,
        true
      );

      assert.equal(
        replay.alreadySelected,
        true
      );

      assert.equal(
        replay.code,
        "EMERGENCY_AVAILABLE_PROFESSIONAL_ALREADY_SELECTED"
      );

      const countsAfterReplay =
        (
          await client.query(
            `
            SELECT
              (
                SELECT COUNT(*)
                FROM request_relationships
                WHERE emergency_request_id =
                  $1
              )::integer
                AS relationships,
              (
                SELECT COUNT(*)
                FROM conversations
                WHERE relationship_id =
                  $2
              )::integer
                AS conversations,
              (
                SELECT COUNT(*)
                FROM jobs
                WHERE
                  source_emergency_request_id =
                    $1
                  AND
                  source_request_relationship_id =
                    $2
              )::integer
                AS jobs
            `,
            [
              request.id,
              directRow.id,
            ]
          )
        ).rows[0];

      assert.deepEqual(
        countsAfterReplay,
        countsBeforeReplay
      );
    } finally {
      await client.query(
        "ROLLBACK"
      );

      const counts =
        (
          await client.query(
            `
            SELECT
              (SELECT COUNT(*) FROM users)::integer
                AS users,
              (SELECT COUNT(*) FROM contractor_profiles)::integer
                AS profiles,
              (SELECT COUNT(*) FROM emergency_requests)::integer
                AS emergencies,
              (SELECT COUNT(*) FROM request_relationships)::integer
                AS relationships,
              (SELECT COUNT(*) FROM conversations)::integer
                AS conversations,
              (SELECT COUNT(*) FROM jobs)::integer
                AS jobs
            `
          )
        ).rows[0];

      assert.deepEqual(
        counts,
        {
          users: 0,
          profiles: 0,
          emergencies: 0,
          relationships: 0,
          conversations: 0,
          jobs: 0,
        }
      );

      await client.end();
    }
  }
);

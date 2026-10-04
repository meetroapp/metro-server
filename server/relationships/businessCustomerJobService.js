"use strict";

const {
  createHash,
  randomUUID,
} = require("node:crypto");

const {
  PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
} = require("../workflow/jobFoundationService");

const BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES =
  Object.freeze([
    "participant.read",
    ...PROFESSIONAL_BOOTSTRAP_CAPABILITIES,
    "quote.external_approval.record",
  ]);

const BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES =
  Object.freeze([
    "visit.read",
    "visit.propose",
    "visit.reschedule",
    "visit.cancel",
    "visit.external_confirmation.record",
    "visit.start",
    "visit.complete",
  ]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(status, code, message) {
  return {
    ok: false,
    status,
    code,
    message,
  };
}

function uuid(value) {
  const normalized =
    String(value || "").trim().toLowerCase();

  return UUID_PATTERN.test(normalized)
    ? normalized
    : null;
}

function actorId(authenticatedActor) {
  const value =
    Number(authenticatedActor?.id);

  return Number.isSafeInteger(value) &&
    value > 0
    ? value
    : null;
}

function boundedText(
  value,
  maximum,
  { required = false } = {}
) {
  if (
    value === undefined ||
    value === null
  ) {
    return required
      ? null
      : "";
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  if (
    (required && !normalized) ||
    normalized.length > maximum
  ) {
    return null;
  }

  return normalized;
}

function exactObject(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return exactObject(value) &&
    Object.keys(value).every(
      (key) => allowed.has(key)
    );
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (exactObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical(value[key]),
        ])
    );
  }

  return value;
}

function fingerprint(value) {
  return createHash("sha256")
    .update(
      JSON.stringify(canonical(value))
    )
    .digest("hex");
}

function normalizeLocation(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return {
      valid: true,
      value: {
        state: "UNSPECIFIED",
        text: null,
        addressLine1: null,
        unitNumber: null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
      },
    };
  }

  if (
    !onlyKeys(
      value,
      new Set([
        "mode",
        "text",
        "addressLine1",
        "unitNumber",
        "city",
        "region",
        "postalCode",
        "countryCode",
      ])
    )
  ) {
    return { valid: false };
  }

  const mode =
    String(value.mode || "")
      .trim()
      .toUpperCase();

  if (mode === "UNSPECIFIED") {
    if (
      Object.keys(value).some(
        (key) =>
          key !== "mode" &&
          value[key] != null &&
          String(value[key]).trim() !== ""
      )
    ) {
      return { valid: false };
    }

    return normalizeLocation(null);
  }

  if (mode === "TEXT") {
    const text =
      boundedText(
        value.text,
        600,
        { required: true }
      );

    const unitNumber =
      boundedText(
        value.unitNumber,
        120
      );

    if (
      text === null ||
      unitNumber === null ||
      value.addressLine1 != null ||
      value.city != null ||
      value.region != null ||
      value.postalCode != null ||
      value.countryCode != null
    ) {
      return { valid: false };
    }

    return {
      valid: true,
      value: {
        state: "TEXT",
        text,
        addressLine1: null,
        unitNumber:
          unitNumber || null,
        city: null,
        region: null,
        postalCode: null,
        countryCode: null,
      },
    };
  }

  if (mode === "STRUCTURED") {
    const addressLine1 =
      boundedText(
        value.addressLine1,
        500,
        { required: true }
      );

    const unitNumber =
      boundedText(
        value.unitNumber,
        120
      );

    const city =
      boundedText(
        value.city,
        120,
        { required: true }
      );

    const region =
      boundedText(
        value.region,
        120,
        { required: true }
      );

    const postalCode =
      boundedText(
        value.postalCode,
        32,
        { required: true }
      );

    const countryCode =
      typeof value.countryCode ===
        "string"
        ? value.countryCode
            .trim()
            .toUpperCase()
        : "";

    if (
      addressLine1 === null ||
      unitNumber === null ||
      city === null ||
      region === null ||
      postalCode === null ||
      !/^[A-Z]{2}$/.test(countryCode) ||
      value.text != null
    ) {
      return { valid: false };
    }

    return {
      valid: true,
      value: {
        state: "STRUCTURED",
        text: null,
        addressLine1,
        unitNumber:
          unitNumber || null,
        city,
        region,
        postalCode,
        countryCode,
      },
    };
  }

  return { valid: false };
}

function normalizeInput(input = {}) {
  const actor = actorId(
    input.authenticatedActor
  );

  if (!actor) {
    return {
      error: failure(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required."
      ),
    };
  }

  const relationshipId =
    uuid(input.relationshipId);

  const idempotencyKey =
    uuid(input.idempotencyKey);

  if (
    !relationshipId ||
    !idempotencyKey
  ) {
    return {
      error: failure(
        400,
        "BUSINESS_CUSTOMER_JOB_INVALID",
        "The external customer Job request is invalid."
      ),
    };
  }

  if (
    !onlyKeys(
      input.payload || {},
      new Set([
        "projectTitle",
        "projectDescription",
        "serviceLocation",
      ])
    )
  ) {
    return {
      error: failure(
        400,
        "BUSINESS_CUSTOMER_JOB_FIELD_REJECTED",
        "The external customer Job contains unsupported fields."
      ),
    };
  }

  const projectTitle =
    boundedText(
      input.payload.projectTitle,
      500,
      { required: true }
    );

  const projectDescription =
    boundedText(
      input.payload.projectDescription,
      12000
    );

  const serviceLocation =
    normalizeLocation(
      input.payload.serviceLocation
    );

  if (
    projectTitle === null ||
    projectDescription === null ||
    !serviceLocation.valid
  ) {
    return {
      error: failure(
        400,
        "BUSINESS_CUSTOMER_JOB_CONTENT_INVALID",
        "The external customer Job details are invalid."
      ),
    };
  }

  return {
    actor,
    relationshipId,
    idempotencyKey,
    projectTitle,
    projectDescription,
    serviceLocation:
      serviceLocation.value,
  };
}

function tag(sql) {
  return String(sql).match(
    /business_customer_job:([a-z_]+)/
  )?.[1] || "";
}

function sourceReference(sourceId) {
  return `business-customer:${sourceId}`;
}

function serviceLocationProjection(
  location
) {
  if (
    !location ||
    location.state === "UNSPECIFIED"
  ) {
    return null;
  }

  if (location.state === "TEXT") {
    return Object.freeze({
      mode: "TEXT",
      text: location.text,
      unitNumber:
        location.unitNumber || null,
    });
  }

  return Object.freeze({
    mode: "STRUCTURED",
    addressLine1:
      location.addressLine1,
    unitNumber:
      location.unitNumber || null,
    city: location.city,
    region: location.region,
    postalCode:
      location.postalCode,
    countryCode:
      location.countryCode,
  });
}

async function createBusinessCustomerJob(
  input = {}
) {
  const validated =
    normalizeInput(input);

  if (validated.error) {
    return validated.error;
  }

  if (
    !input.pool ||
    typeof input.pool.query !==
      "function"
  ) {
    throw new TypeError(
      "A database pool or client is required."
    );
  }

  const logger =
    input.logger || console;

  const idFactory =
    typeof input.idFactory ===
      "function"
      ? input.idFactory
      : randomUUID;

  const sourceId =
    uuid(idFactory());

  const jobId =
    uuid(idFactory());

  const participantId =
    uuid(idFactory());

  if (
    !sourceId ||
    !jobId ||
    !participantId
  ) {
    throw new Error(
      "Business Customer Job identity generation failed."
    );
  }

  const client =
    typeof input.pool.connect ===
      "function"
      ? await input.pool.connect()
      : input.pool;

  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const authorityResult =
      await client.query(
        `
        /* business_customer_job:load_relationship */
        SELECT
          relationships.id,
          relationships.contractor_profile_id,
          relationships.business_contact_id,
          profiles.user_id
            AS professional_user_id,
          contacts.display_name
            AS customer_name,
          contacts.status
            AS contact_status,
          EXISTS (
            SELECT 1
            FROM business_contact_roles roles
            WHERE roles.business_contact_id =
                  contacts.id
              AND roles.contractor_profile_id =
                  contacts.contractor_profile_id
              AND roles.role = 'CUSTOMER'
              AND roles.ended_at IS NULL
          ) AS active_customer_role
        FROM business_customer_relationships
          relationships
        INNER JOIN business_contacts contacts
          ON contacts.id =
             relationships.business_contact_id
         AND contacts.contractor_profile_id =
             relationships.contractor_profile_id
        INNER JOIN contractor_profiles profiles
          ON profiles.id =
             relationships.contractor_profile_id
        WHERE relationships.id = $1
          AND profiles.user_id = $2
        LIMIT 1
        FOR KEY SHARE OF relationships, contacts
        `,
        [
          validated.relationshipId,
          validated.actor,
        ]
      );

    const authority =
      authorityResult.rows[0];

    if (!authority) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return failure(
        404,
        "BUSINESS_CUSTOMER_JOB_CUSTOMER_NOT_FOUND",
        "The external Customer Relationship was not found."
      );
    }

    if (
      authority.contact_status !==
        "ACTIVE" ||
      authority.active_customer_role !==
        true
    ) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return failure(
        409,
        "BUSINESS_CUSTOMER_JOB_CUSTOMER_INACTIVE",
        "The Contact must be an active Customer before new work can be created."
      );
    }

    const contractorProfileId =
      Number(
        authority.contractor_profile_id
      );

    const businessContactId =
      uuid(
        authority.business_contact_id
      );

    if (
      !Number.isSafeInteger(
        contractorProfileId
      ) ||
      contractorProfileId <= 0 ||
      !businessContactId
    ) {
      throw new Error(
        "Business Customer Job authority identity is invalid."
      );
    }

    const requestHash =
      fingerprint({
        relationshipId:
          validated.relationshipId,
        projectTitle:
          validated.projectTitle,
        projectDescription:
          validated.projectDescription,
        serviceLocation:
          validated.serviceLocation,
      });

    const commandInsert =
      await client.query(
        `
        /* business_customer_job:reserve_command */
        INSERT INTO
          business_customer_job_create_commands
        (
          actor_user_id,
          business_customer_relationship_id,
          idempotency_key,
          request_hash
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (
          actor_user_id,
          idempotency_key
        )
        DO NOTHING
        RETURNING id
        `,
        [
          validated.actor,
          validated.relationshipId,
          validated.idempotencyKey,
          requestHash,
        ]
      );

    let commandId =
      commandInsert.rows[0]?.id ||
      null;

    if (!commandId) {
      const existingCommand =
        await client.query(
          `
          /* business_customer_job:load_command */
          SELECT
            id,
            business_customer_relationship_id,
            request_hash,
            response_json
          FROM
            business_customer_job_create_commands
          WHERE actor_user_id = $1
            AND idempotency_key = $2
          LIMIT 1
          `,
          [
            validated.actor,
            validated.idempotencyKey,
          ]
        );

      const command =
        existingCommand.rows[0];

      if (
        !command ||
        String(
          command
            .business_customer_relationship_id
        ) !==
          validated.relationshipId ||
        command.request_hash !==
          requestHash
      ) {
        await client.query("ROLLBACK");
        transactionStarted = false;

        return failure(
          409,
          "BUSINESS_CUSTOMER_JOB_IDEMPOTENCY_CONFLICT",
          "That Job creation identity was already used for different input."
        );
      }

      if (command.response_json) {
        await client.query("COMMIT");
        transactionStarted = false;

        return {
          ...command.response_json,
          status: 200,
          replayed: true,
        };
      }

      await client.query("ROLLBACK");
      transactionStarted = false;

      return failure(
        409,
        "BUSINESS_CUSTOMER_JOB_IN_PROGRESS",
        "That Job creation command is already being processed."
      );
    }

    const location =
      validated.serviceLocation;

    const sourceResult =
      await client.query(
        `
        /* business_customer_job:insert_source */
        INSERT INTO
          business_customer_job_sources
        (
          id,
          contractor_profile_id,
          business_contact_id,
          business_customer_relationship_id,
          created_by_user_id,
          project_title,
          project_description,
          location_state,
          service_location_text,
          service_address_line1,
          unit_number,
          service_city,
          service_region,
          service_postal_code,
          service_country_code
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15
        )
        RETURNING *
        `,
        [
          sourceId,
          contractorProfileId,
          businessContactId,
          validated.relationshipId,
          validated.actor,
          validated.projectTitle,
          validated.projectDescription,
          location.state,
          location.text,
          location.addressLine1,
          location.unitNumber,
          location.city,
          location.region,
          location.postalCode,
          location.countryCode,
        ]
      );

    const source =
      sourceResult.rows[0];

    if (!source) {
      throw new Error(
        "Business Customer Job source was not created."
      );
    }

    const jobResult =
      await client.query(
        `
        /* business_customer_job:insert_job */
        INSERT INTO jobs
        (
          id,
          created_by_user_id,
          lifecycle_contract_version,
          source_type,
          contractor_profile_id,
          business_contact_id,
          business_customer_relationship_id,
          originating_business_document_id,
          source_business_customer_job_id
        )
        VALUES (
          $1, $2, 2,
          'business_customer',
          $3, $4, $5,
          NULL, $6
        )
        RETURNING *
        `,
        [
          jobId,
          validated.actor,
          contractorProfileId,
          businessContactId,
          validated.relationshipId,
          sourceId,
        ]
      );

    const job =
      jobResult.rows[0];

    if (!job) {
      throw new Error(
        "Business Customer lifecycle Job was not created."
      );
    }

    const evidenceReference =
      sourceReference(sourceId);

    const participantResult =
      await client.query(
        `
        /* business_customer_job:insert_participant */
        INSERT INTO
          relationship_participants
        (
          id,
          job_id,
          request_relationship_id,
          user_id,
          identity_type,
          source_evidence_type,
          source_evidence_reference
        )
        VALUES (
          $1, $2, NULL, $3,
          'authenticated_user',
          'business_customer',
          $4
        )
        RETURNING *
        `,
        [
          participantId,
          jobId,
          validated.actor,
          evidenceReference,
        ]
      );

    if (!participantResult.rows[0]) {
      throw new Error(
        "Business Customer Job professional participant was not created."
      );
    }

    await client.query(
      `
      /* business_customer_job:insert_role */
      INSERT INTO
        participant_role_assignments
      (
        id,
        participant_id,
        job_id,
        role,
        assigned_by_participant_id,
        source_evidence_type,
        source_evidence_reference,
        idempotency_key
      )
      VALUES (
        $1, $2, $3,
        'PRIMARY_PROFESSIONAL',
        $2,
        'business_customer',
        $4,
        $5
      )
      `,
      [
        randomUUID(),
        participantId,
        jobId,
        evidenceReference,
        `business-customer:${sourceId}:role:primary-professional`,
      ]
    );

    const capabilityResult =
      await client.query(
        `
        /* business_customer_job:capabilities */
        SELECT capability
        FROM lifecycle_capabilities
        WHERE capability =
          ANY($1::text[])
        ORDER BY capability ASC
        `,
        [[
          ...new Set([
            ...BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES,
            ...BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
          ]),
        ]]
      );

    const registeredCapabilities =
      new Set(
        capabilityResult.rows.map(
          (row) => row.capability
        )
      );

    const capabilities =
      BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES.filter(
        (capability) =>
          registeredCapabilities.has(
            capability
          )
      );

    const evaluationVisitCapabilities =
      BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES.filter(
        (capability) =>
          registeredCapabilities.has(
            capability
          )
      );

    for (
      const capability of capabilities
    ) {
      await client.query(
        `
        /* business_customer_job:insert_grant */
        INSERT INTO
          lifecycle_authority_grants
        (
          id,
          grantee_participant_id,
          grantor_participant_id,
          job_id,
          capability,
          scope_type,
          scope_job_id,
          source_evidence_type,
          source_evidence_reference,
          idempotency_key
        )
        VALUES (
          $1, $2, $2, $3,
          $4, 'job', $3,
          'business_customer',
          $5, $6
        )
        `,
        [
          randomUUID(),
          participantId,
          jobId,
          capability,
          evidenceReference,
          `business-customer:${sourceId}:grant:${capability}`,
        ]
      );
    }

    for (
      const capability of
        evaluationVisitCapabilities
    ) {
      await client.query(
        `
        /* business_customer_job:insert_evaluation_visit_grant */
        INSERT INTO
          lifecycle_authority_grants
        (
          id,
          grantee_participant_id,
          grantor_participant_id,
          job_id,
          capability,
          scope_type,
          scope_job_id,
          source_evidence_type,
          source_evidence_reference,
          idempotency_key
        )
        VALUES (
          $1, $2, $2, $3,
          $4, 'evaluation_visit', $3,
          'business_customer',
          $5, $6
        )
        `,
        [
          randomUUID(),
          participantId,
          jobId,
          capability,
          evidenceReference,
          `business-customer:${sourceId}:evaluation-visit:${capability}`,
        ]
      );
    }

    const partyResult =
      await client.query(
        `
        /* business_customer_job:insert_customer_party */
        INSERT INTO job_customer_parties
        (
          job_id,
          contractor_profile_id,
          business_contact_id,
          business_customer_relationship_id,
          linked_by_user_id
        )
        VALUES (
          $1, $2, $3, $4, $5
        )
        RETURNING *
        `,
        [
          jobId,
          contractorProfileId,
          businessContactId,
          validated.relationshipId,
          validated.actor,
        ]
      );

    if (!partyResult.rows[0]) {
      throw new Error(
        "Business Customer Job customer party was not linked."
      );
    }

    const projectedJob = Object.freeze({
      id: jobId,
      sourceType:
        "business_customer",
      sourceId,
      contractorProfileId,
      customer: Object.freeze({
        businessContactId,
        customerRelationshipId:
          validated.relationshipId,
        displayName:
          String(
            authority.customer_name || ""
          ).trim() || "Customer",
      }),
      project: Object.freeze({
        title:
          validated.projectTitle,
        description:
          validated.projectDescription,
        serviceLocation:
          serviceLocationProjection(
            validated.serviceLocation
          ),
      }),
    });

    const response = {
      ok: true,
      success: true,
      status: 201,
      code:
        "BUSINESS_CUSTOMER_JOB_CREATED",
      job: projectedJob,
    };

    const completed =
      await client.query(
        `
        /* business_customer_job:finish_command */
        UPDATE
          business_customer_job_create_commands
        SET source_id = $2,
            job_id = $3,
            response_json = $4::jsonb,
            completed_at =
              CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [
          commandId,
          sourceId,
          jobId,
          JSON.stringify(response),
        ]
      );

    if (
      completed.rowCount !== 1
    ) {
      throw new Error(
        "Business Customer Job command could not be completed."
      );
    }

    await client.query("COMMIT");
    transactionStarted = false;

    logger.info?.(
      "Business Customer lifecycle Job created",
      {
        code:
          "BUSINESS_CUSTOMER_JOB_CREATED",
        jobId,
        sourceId,
        contractorProfileId,
        businessContactId,
        customerRelationshipId:
          validated.relationshipId,
        participantCount: 1,
        professionalCapabilityCount:
          capabilities.length,
        evaluationVisitCapabilityCount:
          evaluationVisitCapabilities.length,
      }
    );

    return response;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch {
        // Preserve original error.
      }
    }

    throw error;
  } finally {
    if (
      client !== input.pool &&
      typeof client.release ===
        "function"
    ) {
      client.release();
    }
  }
}

module.exports = {
  BUSINESS_CUSTOMER_EVALUATION_VISIT_CAPABILITIES,
  BUSINESS_CUSTOMER_PROFESSIONAL_CAPABILITIES,
  createBusinessCustomerJob,
  businessCustomerJobInternals:
    Object.freeze({
      fingerprint,
      normalizeInput,
      normalizeLocation,
      serviceLocationProjection,
      sourceReference,
      tag,
    }),
};

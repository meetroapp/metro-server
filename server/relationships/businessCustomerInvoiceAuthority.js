"use strict";

// Shared exact authority for Invoice reads and Revenue; no source-only ownership.
const BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL = `
  SELECT
    jobs.id AS job_id,
    jobs.source_type,
    jobs.lifecycle_contract_version,
    jobs.job_request_id,
    jobs.source_request_relationship_id
      AS relationship_id,
    jobs.contractor_profile_id,
    jobs.business_contact_id,
    jobs.business_customer_relationship_id,
    jobs.source_business_customer_job_id,

    profiles.user_id
      AS professional_user_id,
    profiles.user_id
      AS actor_user_id,

    professional.id
      AS professional_participant_id,
    professional.id
      AS actor_participant_id,

    'active'::text
      AS relationship_status,
    TRUE
      AS primary_role_active,

    NULL::integer
      AS homeowner_id,
    NULL::uuid
      AS customer_participant_id,
    NULL::integer
      AS conversation_id,
    NULL::text
      AS conversation_status,

    contacts.display_name
      AS customer_name,
    contacts.email
      AS customer_email,

    COALESCE(
      NULLIF(profiles.business_name, ''),
      owner.username
    ) AS business_name,

    sources.project_title
      AS job_title,
    sources.project_description
      AS job_service,

    completions.id
      AS completion_id,
    completions.version
      AS completion_version,
    completions.version
      AS job_version,
    completions.completed_at

  FROM jobs

  INNER JOIN contractor_profiles profiles
    ON profiles.id =
       jobs.contractor_profile_id

  INNER JOIN users owner
    ON owner.id =
       profiles.user_id

  INNER JOIN business_customer_relationships customers
    ON customers.id =
       jobs.business_customer_relationship_id

   AND customers.contractor_profile_id =
       jobs.contractor_profile_id

   AND customers.business_contact_id =
       jobs.business_contact_id

  INNER JOIN business_contacts contacts
    ON contacts.id =
       jobs.business_contact_id

   AND contacts.contractor_profile_id =
       jobs.contractor_profile_id

   AND contacts.status =
       'ACTIVE'

  INNER JOIN job_customer_parties parties
    ON parties.job_id =
       jobs.id

   AND parties.contractor_profile_id =
       jobs.contractor_profile_id

   AND parties.business_contact_id =
       jobs.business_contact_id

   AND parties.business_customer_relationship_id =
       jobs.business_customer_relationship_id

  INNER JOIN business_customer_job_sources sources
    ON sources.id =
       jobs.source_business_customer_job_id

   AND sources.contractor_profile_id =
       jobs.contractor_profile_id

   AND sources.business_contact_id =
       jobs.business_contact_id

   AND sources.business_customer_relationship_id =
       jobs.business_customer_relationship_id

   AND sources.created_by_user_id =
       profiles.user_id

  INNER JOIN relationship_participants professional
    ON professional.job_id =
       jobs.id

   AND professional.user_id =
       profiles.user_id

   AND professional.request_relationship_id
       IS NULL

   AND professional.source_evidence_type =
       'business_customer'

  LEFT JOIN canonical_job_completion_records completions
    ON completions.job_id =
       jobs.id

  WHERE jobs.source_type =
        'business_customer'

    AND jobs.lifecycle_contract_version = 2

    AND jobs.job_request_id IS NULL

    AND jobs.source_request_selection_id IS NULL

    AND jobs.source_request_relationship_id IS NULL

    AND jobs.originating_business_document_id IS NULL

    AND jobs.contractor_profile_id IS NOT NULL

    AND jobs.business_contact_id IS NOT NULL

    AND jobs.business_customer_relationship_id IS NOT NULL

    AND jobs.source_business_customer_job_id IS NOT NULL

    AND EXISTS (
      SELECT 1

      FROM business_contact_roles roles

      WHERE roles.business_contact_id =
            contacts.id

        AND roles.contractor_profile_id =
            profiles.id

        AND roles.role =
            'CUSTOMER'

        AND roles.ended_at IS NULL
    )

    AND EXISTS (
      SELECT 1

      FROM participant_role_assignments roles

      LEFT JOIN participant_role_revocations revoked
        ON revoked.role_assignment_id =
           roles.id

      WHERE roles.participant_id =
            professional.id

        AND roles.job_id =
            jobs.id

        AND roles.role =
            'PRIMARY_PROFESSIONAL'

        AND roles.valid_from <=
            CURRENT_TIMESTAMP

        AND (
          roles.valid_until IS NULL
          OR roles.valid_until >
             CURRENT_TIMESTAMP
        )

        AND revoked.id IS NULL
    )
`;

module.exports = { BUSINESS_CUSTOMER_INVOICE_CONTEXT_SQL };

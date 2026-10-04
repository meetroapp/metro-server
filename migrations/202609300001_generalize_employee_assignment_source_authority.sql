-- Task63J4E8-A0: explicit employee assignment source authority.
-- No rows rewritten; existing source-shape constraints and role/event guards remain.
-- SECURITY INVOKER, not a general employee/customer-record permission grant.
CREATE FUNCTION business_employee_job_sources(business_id INTEGER, exact_job_id UUID DEFAULT NULL)
RETURNS TABLE (
  job_id UUID, job_source_type TEXT, source_id TEXT, source_version INTEGER,
  job_title TEXT, job_description TEXT, job_category TEXT, customer_name TEXT,
  request_photos JSONB, location_intake_mode TEXT, location_normalization_status TEXT,
  service_address_line1 TEXT, service_city TEXT, service_region TEXT,
  service_postal_code TEXT, service_country_code TEXT, discovery_area_label TEXT,
  job_created_at TIMESTAMPTZ
)
LANGUAGE SQL STABLE
SET search_path = pg_catalog, public
AS $source$
  -- Ordinary and existing-customer Requests retain their canonical post/privacy path.
  SELECT jobs.id, jobs.source_type, posts.id::text, posts.modification_version,
    posts.title, posts.description, posts.category, customers.username,
    posts.request_photos, posts.location_intake_mode, posts.location_normalization_status,
    posts.service_address_line1, posts.service_city, posts.service_region,
    posts.service_postal_code, posts.service_country_code, posts.discovery_area_label,
    jobs.created_at::timestamptz
  FROM contractor_profiles profiles
  JOIN request_relationships relationships
    ON relationships.professional_user_id = profiles.user_id
   AND relationships.contractor_id = profiles.id
   AND relationships.emergency_request_id IS NULL AND relationships.status = 'active'
  JOIN jobs ON jobs.source_request_relationship_id = relationships.id
   AND jobs.job_request_id = relationships.post_id
  JOIN posts ON posts.id = jobs.job_request_id
   AND posts.lifecycle_contract_version = 2 AND posts.cancelled_at IS NULL
  JOIN users customers ON customers.id = relationships.homeowner_id
  WHERE profiles.id = business_id AND (exact_job_id IS NULL OR jobs.id = exact_job_id)
    AND jobs.lifecycle_contract_version = 2
    AND jobs.source_type IN ('ordinary_request_selection', 'existing_customer_request')
    AND ((jobs.source_type = 'ordinary_request_selection' AND jobs.source_request_selection_id IS NOT NULL)
      OR (jobs.source_type = 'existing_customer_request' AND jobs.source_request_selection_id IS NULL))
    AND jobs.contractor_profile_id IS NULL AND jobs.business_contact_id IS NULL
    AND jobs.business_customer_relationship_id IS NULL AND jobs.originating_business_document_id IS NULL
    AND jobs.source_business_customer_job_id IS NULL AND jobs.source_emergency_request_id IS NULL

  UNION ALL
  -- Native intake reference stays canonical; no contact email/phone/private notes projected.
  SELECT jobs.id, jobs.source_type, sources.id::text, sources.version,
    sources.project_title, sources.project_description, NULL::text, contacts.display_name,
    '[]'::jsonb,
    CASE WHEN sources.location_state = 'STRUCTURED' THEN 'exact_on_file' ELSE 'address_after_selection' END,
    CASE WHEN sources.location_state = 'STRUCTURED' THEN 'normalized' ELSE 'unknown' END,
    sources.service_address_line1, sources.service_city, sources.service_region,
    sources.service_postal_code, sources.service_country_code,
    CASE WHEN sources.location_state = 'TEXT' THEN sources.service_location_text ELSE NULL END,
    jobs.created_at::timestamptz
  FROM jobs
  JOIN contractor_profiles profiles ON profiles.id = jobs.contractor_profile_id
  JOIN business_customer_job_sources sources ON sources.id = jobs.source_business_customer_job_id
   AND sources.contractor_profile_id = profiles.id AND sources.business_contact_id = jobs.business_contact_id
   AND sources.business_customer_relationship_id = jobs.business_customer_relationship_id
   AND sources.created_by_user_id = profiles.user_id
  JOIN business_customer_relationships customers ON customers.id = sources.business_customer_relationship_id
   AND customers.contractor_profile_id = profiles.id AND customers.business_contact_id = sources.business_contact_id
  JOIN business_contacts contacts ON contacts.id = sources.business_contact_id
   AND contacts.contractor_profile_id = profiles.id AND contacts.status = 'ACTIVE'
  JOIN job_customer_parties parties ON parties.job_id = jobs.id
   AND parties.contractor_profile_id = profiles.id AND parties.business_contact_id = contacts.id
   AND parties.business_customer_relationship_id = customers.id
  JOIN relationship_participants professional ON professional.job_id = jobs.id
   AND professional.user_id = profiles.user_id AND professional.request_relationship_id IS NULL
   AND professional.source_evidence_type = 'business_customer'
  WHERE profiles.id = business_id AND (exact_job_id IS NULL OR jobs.id = exact_job_id)
    AND jobs.source_type = 'business_customer' AND jobs.lifecycle_contract_version = 2
    AND jobs.created_by_user_id = profiles.user_id
    AND jobs.job_request_id IS NULL AND jobs.source_request_selection_id IS NULL
    AND jobs.source_request_relationship_id IS NULL AND jobs.originating_business_document_id IS NULL
    AND jobs.source_emergency_request_id IS NULL
    AND EXISTS (SELECT 1 FROM business_contact_roles roles WHERE roles.business_contact_id = contacts.id
      AND roles.contractor_profile_id = profiles.id AND roles.role = 'CUSTOMER' AND roles.ended_at IS NULL)
    AND EXISTS (SELECT 1 FROM participant_role_assignments roles
      WHERE roles.participant_id = professional.id AND roles.job_id = jobs.id
        AND roles.role = 'PRIMARY_PROFESSIONAL' AND roles.valid_from <= CURRENT_TIMESTAMP
        AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM participant_role_revocations r WHERE r.role_assignment_id = roles.id))

  UNION ALL
  -- Emergency ownership comes from the exact selected relationship, never Job.profile/title/conversation.
  SELECT jobs.id, jobs.source_type, emergency.id::text, NULL::integer,
    emergency.title, emergency.description, emergency.category, customers.username,
    '[]'::jsonb, 'address_after_selection'::text, 'unknown'::text,
    NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, emergency.location_text,
    jobs.created_at::timestamptz
  FROM jobs
  JOIN emergency_requests emergency ON emergency.id = jobs.source_emergency_request_id
  JOIN request_relationships relationships ON relationships.id = jobs.source_request_relationship_id
   AND relationships.emergency_request_id = emergency.id AND relationships.post_id IS NULL
   AND relationships.homeowner_id = emergency.homeowner_id AND relationships.status = 'active'
  JOIN contractor_profiles profiles ON profiles.id = relationships.contractor_id
   AND profiles.user_id = relationships.professional_user_id
  JOIN users customers ON customers.id = emergency.homeowner_id
  JOIN relationship_participants professional ON professional.job_id = jobs.id
   AND professional.request_relationship_id = relationships.id
   AND professional.user_id = relationships.professional_user_id
   AND professional.source_evidence_type = 'emergency_selection'
  WHERE profiles.id = business_id AND (exact_job_id IS NULL OR jobs.id = exact_job_id)
    AND jobs.source_type = 'emergency_request' AND jobs.lifecycle_contract_version = 2
    AND jobs.created_by_user_id = emergency.homeowner_id
    AND jobs.job_request_id IS NULL AND jobs.source_request_selection_id IS NULL
    AND jobs.contractor_profile_id IS NULL AND jobs.business_contact_id IS NULL
    AND jobs.business_customer_relationship_id IS NULL AND jobs.originating_business_document_id IS NULL
    AND jobs.source_business_customer_job_id IS NULL
    AND EXISTS (SELECT 1 FROM participant_role_assignments roles
      WHERE roles.participant_id = professional.id AND roles.job_id = jobs.id
        AND roles.role = 'PRIMARY_PROFESSIONAL' AND roles.valid_from <= CURRENT_TIMESTAMP
        AND (roles.valid_until IS NULL OR roles.valid_until > CURRENT_TIMESTAMP)
        AND NOT EXISTS (SELECT 1 FROM participant_role_revocations r WHERE r.role_assignment_id = roles.id))
$source$;

CREATE OR REPLACE FUNCTION validate_business_job_assignment_authority()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM business_employee_job_sources(NEW.contractor_profile_id, NEW.job_id)
  ) THEN
    RAISE EXCEPTION 'Job source does not belong to the exact business';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('MANAGER', 'FIELD_EMPLOYEE')
  ) THEN
    RAISE EXCEPTION 'Assignment target is not an active field-authorized Team member';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.assigned_by_membership_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role IN ('OWNER', 'MANAGER')
  ) THEN
    RAISE EXCEPTION 'Assignment actor lacks authority';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_business_time_session_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  activation_version INTEGER;
BEGIN
  NEW.clocked_in_at := CURRENT_TIMESTAMP;
  NEW.created_at := CURRENT_TIMESTAMP;
  NEW.updated_at := CURRENT_TIMESTAMP;
  IF NOT EXISTS (
    SELECT 1 FROM business_team_memberships memberships
     WHERE memberships.id = NEW.membership_id
       AND memberships.contractor_profile_id = NEW.contractor_profile_id
       AND memberships.user_id = NEW.user_id
       AND memberships.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Time evidence requires the exact active Team membership';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM business_time_commands commands
     WHERE commands.id = NEW.clock_in_command_id
       AND commands.contractor_profile_id = NEW.contractor_profile_id
       AND commands.actor_membership_id = NEW.membership_id
       AND commands.action = 'CLOCK_IN'
  ) THEN
    RAISE EXCEPTION 'Clock In command identity is invalid';
  END IF;

  IF NEW.category = 'JOB_WORK' THEN
    IF NOT EXISTS (SELECT 1 FROM business_employee_job_sources(NEW.contractor_profile_id, NEW.job_id)) THEN
      RAISE EXCEPTION 'Job Work requires current exact-business source authority';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM business_job_assignments assignments
       WHERE assignments.id = NEW.assignment_id
         AND assignments.contractor_profile_id = NEW.contractor_profile_id
         AND assignments.job_id = NEW.job_id
         AND assignments.membership_id = NEW.membership_id
         AND assignments.state = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Job Work requires the exact active assignment';
    END IF;
    SELECT max(events.assignment_version)
      INTO activation_version
      FROM business_job_assignment_events events
     WHERE events.assignment_id = NEW.assignment_id
       AND events.event_type IN ('ASSIGNED', 'REASSIGNED');
    IF activation_version IS NULL
       OR activation_version <> NEW.assignment_activation_version THEN
      RAISE EXCEPTION 'Job Work assignment activation identity is stale';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;



CREATE OR REPLACE FUNCTION validate_business_job_field_status_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status TEXT;
  current_status_version INTEGER;
  current_activation_version INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_employee_job_sources(NEW.contractor_profile_id, NEW.job_id)) THEN
    RAISE EXCEPTION 'Field operations require current exact-business source authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignments assignments
      JOIN business_team_memberships memberships
        ON memberships.id = assignments.membership_id
       AND memberships.contractor_profile_id = assignments.contractor_profile_id
     WHERE assignments.id = NEW.assignment_id
       AND assignments.contractor_profile_id = NEW.contractor_profile_id
       AND assignments.job_id = NEW.job_id
       AND assignments.membership_id = NEW.membership_id
       AND assignments.state = 'ACTIVE'
       AND memberships.status = 'ACTIVE'
       AND memberships.role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Field status requires an active Field Employee assignment';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM business_team_memberships
     WHERE id = NEW.actor_membership_id
       AND id = NEW.membership_id
       AND user_id = NEW.actor_user_id
       AND contractor_profile_id = NEW.contractor_profile_id
       AND status = 'ACTIVE'
       AND role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Only the assigned Field Employee may record field status';
  END IF;

  SELECT max(assignment_version)
    INTO current_activation_version
    FROM business_job_assignment_events
   WHERE assignment_id = NEW.assignment_id
     AND event_type IN ('ASSIGNED', 'REASSIGNED');

  IF current_activation_version IS NULL
     OR NEW.assignment_activation_version <> current_activation_version THEN
    RAISE EXCEPTION 'Field status activation identity is stale';
  END IF;

  SELECT events.to_status, events.status_version
    INTO current_status, current_status_version
    FROM business_job_field_status_events events
   WHERE events.assignment_id = NEW.assignment_id
     AND events.assignment_activation_version = NEW.assignment_activation_version
   ORDER BY events.status_version DESC
   LIMIT 1;

  current_status := COALESCE(current_status, 'ASSIGNED');
  current_status_version := COALESCE(current_status_version, 0);
  IF NEW.from_status <> current_status
     OR NEW.status_version <> current_status_version + 1 THEN
    RAISE EXCEPTION 'Field status transition is not the next exact transition';
  END IF;

  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION validate_business_job_field_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sender_role TEXT;
  sender_status TEXT;
  sender_user INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business_employee_job_sources(NEW.contractor_profile_id, NEW.job_id)) THEN
    RAISE EXCEPTION 'Field operations require current exact-business source authority';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM business_job_assignments assignments
      JOIN business_team_memberships targets
        ON targets.id = assignments.membership_id
       AND targets.contractor_profile_id = assignments.contractor_profile_id
     WHERE assignments.id = NEW.assignment_id
       AND assignments.contractor_profile_id = NEW.contractor_profile_id
       AND assignments.job_id = NEW.job_id
       AND assignments.membership_id = NEW.membership_id
       AND assignments.state = 'ACTIVE'
       AND targets.status = 'ACTIVE'
       AND targets.role = 'FIELD_EMPLOYEE'
  ) THEN
    RAISE EXCEPTION 'Field communication requires an active Field Employee assignment';
  END IF;

  SELECT role, status, user_id
    INTO sender_role, sender_status, sender_user
    FROM business_team_memberships
   WHERE id = NEW.sender_membership_id
     AND contractor_profile_id = NEW.contractor_profile_id;

  IF sender_status IS DISTINCT FROM 'ACTIVE'
     OR sender_user IS DISTINCT FROM NEW.sender_user_id
     OR sender_role IS NULL
     OR sender_role NOT IN ('OWNER', 'MANAGER', 'FIELD_EMPLOYEE')
     OR (sender_role = 'FIELD_EMPLOYEE' AND NEW.sender_membership_id <> NEW.membership_id) THEN
    RAISE EXCEPTION 'Field message sender lacks exact Job authority';
  END IF;

  RETURN NEW;
END;
$$;

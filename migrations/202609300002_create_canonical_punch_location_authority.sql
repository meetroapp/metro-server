-- Task63J4E8-A. Additive foundation only: no existing timer/Punch semantics changed.
-- Geometry is explicitly confirmed by Business management, never by an employee.
-- No default radius and no proximity calculation/enforcement in this phase.
CREATE FUNCTION business_punch_customer_location(business_id INTEGER, exact_job_id UUID)
RETURNS TABLE(source_type TEXT, source_id TEXT, source_version INTEGER, source_revision TEXT, address JSONB)
LANGUAGE SQL STABLE SET search_path = pg_catalog, public AS $$
 SELECT s.job_source_type, s.source_id, s.source_version,
   encode(sha256(convert_to(jsonb_build_object('type',s.job_source_type,'id',s.source_id,
     'version',s.source_version,'address',a.value)::text,'UTF8')),'hex'), a.value
 FROM business_employee_job_sources(business_id, exact_job_id) s
 CROSS JOIN LATERAL (SELECT CASE
   WHEN s.location_normalization_status='normalized' AND s.location_intake_mode='exact_on_file'
     THEN jsonb_build_object('line1',s.service_address_line1,'city',s.service_city,'region',s.service_region,
       'postalCode',s.service_postal_code,'countryCode',s.service_country_code)
   WHEN s.job_source_type IN ('business_customer','emergency_request') AND nullif(btrim(s.discovery_area_label),'') IS NOT NULL
     THEN jsonb_build_object('text',s.discovery_area_label)
   ELSE NULL END AS value) a
 WHERE a.value IS NOT NULL
$$;

CREATE TABLE business_punch_location_commands (
 id UUID PRIMARY KEY, contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
 actor_membership_id UUID NOT NULL, action TEXT NOT NULL CHECK(action IN ('POLICY_WRITE','SITE_WRITE','ASSOCIATION_WRITE','SNAPSHOT')),
 idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
 result_reference JSONB, completed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(actor_membership_id,contractor_profile_id) REFERENCES business_team_memberships(id,contractor_profile_id) ON DELETE RESTRICT,
 CHECK((result_reference IS NULL AND completed_at IS NULL) OR (result_reference IS NOT NULL AND completed_at IS NOT NULL)),
 UNIQUE(actor_membership_id,idempotency_key), UNIQUE(id,contractor_profile_id,actor_membership_id,action)
);

CREATE TABLE business_punch_policy_versions (
 id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0), contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
 radius_meters DOUBLE PRECISION NOT NULL CHECK(radius_meters>0 AND radius_meters<'Infinity'::float8),
 max_accuracy_meters DOUBLE PRECISION NOT NULL CHECK(max_accuracy_meters>0 AND max_accuracy_meters<'Infinity'::float8),
 max_sample_age_seconds INTEGER NOT NULL CHECK(max_sample_age_seconds>0), max_future_skew_seconds INTEGER NOT NULL CHECK(max_future_skew_seconds>=0),
 actor_membership_id UUID NOT NULL, command_id UUID NOT NULL UNIQUE REFERENCES business_punch_location_commands(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(id,version), UNIQUE(id,version,contractor_profile_id),
 FOREIGN KEY(actor_membership_id,contractor_profile_id) REFERENCES business_team_memberships(id,contractor_profile_id) ON DELETE RESTRICT
);

CREATE TABLE business_punch_site_versions (
 id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0), contractor_profile_id INTEGER NOT NULL REFERENCES contractor_profiles(id) ON DELETE RESTRICT,
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
 kind TEXT NOT NULL CHECK(kind IN ('CUSTOMER_JOB','MANUAL_BUSINESS')), label TEXT NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 200),
 job_id UUID REFERENCES jobs(id) ON DELETE RESTRICT,
 source_type TEXT, source_id TEXT, source_version INTEGER, source_revision TEXT,
 manual_address JSONB,
 latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90), longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 resolution_method TEXT NOT NULL DEFAULT 'BUSINESS_CONFIRMED' CHECK(resolution_method='BUSINESS_CONFIRMED'),
 policy_id UUID NOT NULL, policy_version INTEGER NOT NULL,
 actor_membership_id UUID NOT NULL, command_id UUID NOT NULL UNIQUE REFERENCES business_punch_location_commands(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(id,version), UNIQUE(id,version,contractor_profile_id),
 FOREIGN KEY(policy_id,policy_version,contractor_profile_id) REFERENCES business_punch_policy_versions(id,version,contractor_profile_id) ON DELETE RESTRICT,
 FOREIGN KEY(actor_membership_id,contractor_profile_id) REFERENCES business_team_memberships(id,contractor_profile_id) ON DELETE RESTRICT,
 CHECK((kind='CUSTOMER_JOB' AND job_id IS NOT NULL AND source_type IS NOT NULL AND source_id IS NOT NULL
     AND source_revision IS NOT NULL AND source_revision ~ '^[a-f0-9]{64}$' AND manual_address IS NULL)
   OR (kind='MANUAL_BUSINESS' AND job_id IS NULL AND source_type IS NULL AND source_id IS NULL AND source_version IS NULL AND source_revision IS NULL
     AND manual_address IS NOT NULL AND jsonb_typeof(manual_address)='object'
     AND jsonb_typeof(manual_address->'line1')='string' AND length(btrim(manual_address->>'line1')) BETWEEN 1 AND 500
     AND jsonb_typeof(manual_address->'city')='string' AND length(btrim(manual_address->>'city')) BETWEEN 1 AND 120
     AND jsonb_typeof(manual_address->'region')='string' AND length(btrim(manual_address->>'region')) BETWEEN 1 AND 120
     AND jsonb_typeof(manual_address->'postalCode')='string' AND length(btrim(manual_address->>'postalCode')) BETWEEN 1 AND 32
     AND jsonb_typeof(manual_address->'countryCode')='string' AND manual_address->>'countryCode' ~ '^[A-Z]{2}$'
     AND manual_address ?& ARRAY['line1','city','region','postalCode','countryCode']
     AND manual_address-ARRAY['line1','city','region','postalCode','countryCode']='{}'::jsonb))
);

CREATE TABLE business_punch_assignment_site_versions (
 assignment_id UUID NOT NULL, site_id UUID NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 contractor_profile_id INTEGER NOT NULL, job_id UUID NOT NULL, membership_id UUID NOT NULL,
 assignment_activation_version INTEGER NOT NULL CHECK(assignment_activation_version>0), site_version INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')), actor_membership_id UUID NOT NULL,
 command_id UUID NOT NULL UNIQUE REFERENCES business_punch_location_commands(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(assignment_id,site_id,version),
 UNIQUE(assignment_id,site_id,version,contractor_profile_id,job_id,membership_id),
 FOREIGN KEY(assignment_id,contractor_profile_id,job_id,membership_id) REFERENCES business_job_assignments(id,contractor_profile_id,job_id,membership_id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,site_version,contractor_profile_id) REFERENCES business_punch_site_versions(id,version,contractor_profile_id) ON DELETE RESTRICT,
 FOREIGN KEY(actor_membership_id,contractor_profile_id) REFERENCES business_team_memberships(id,contractor_profile_id) ON DELETE RESTRICT
);

CREATE TABLE business_punch_location_snapshots (
 id UUID PRIMARY KEY, contractor_profile_id INTEGER NOT NULL, membership_id UUID NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 job_id UUID NOT NULL, assignment_id UUID NOT NULL, assignment_activation_version INTEGER NOT NULL CHECK(assignment_activation_version>0),
 site_id UUID NOT NULL, site_version INTEGER NOT NULL, association_version INTEGER NOT NULL,
 boundary TEXT NOT NULL CHECK(boundary IN ('CLOCK_IN','CLOCK_OUT')),
 capture_status TEXT NOT NULL CHECK(capture_status IN ('CAPTURED','MISSING','DENIED','UNAVAILABLE')),
 device_latitude DOUBLE PRECISION, device_longitude DOUBLE PRECISION, accuracy_meters DOUBLE PRECISION, sampled_at TIMESTAMPTZ,
 received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 sample_state TEXT NOT NULL CHECK(sample_state IN ('READY_FOR_VERIFICATION','INSUFFICIENT_ACCURACY','STALE','FUTURE_SAMPLE','MISSING','DENIED','UNAVAILABLE')),
 target_latitude DOUBLE PRECISION NOT NULL, target_longitude DOUBLE PRECISION NOT NULL,
 policy_id UUID NOT NULL, policy_version INTEGER NOT NULL, radius_meters DOUBLE PRECISION NOT NULL,
 verification_result TEXT NOT NULL DEFAULT 'NOT_PERFORMED' CHECK(verification_result='NOT_PERFORMED'),
 distance_meters DOUBLE PRECISION CHECK(distance_meters IS NULL),
 command_id UUID NOT NULL UNIQUE REFERENCES business_punch_location_commands(id) ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id,contractor_profile_id,job_id,membership_id) REFERENCES business_job_assignments(id,contractor_profile_id,job_id,membership_id) ON DELETE RESTRICT,
 FOREIGN KEY(assignment_id,site_id,association_version,contractor_profile_id,job_id,membership_id)
   REFERENCES business_punch_assignment_site_versions(assignment_id,site_id,version,contractor_profile_id,job_id,membership_id) ON DELETE RESTRICT,
 FOREIGN KEY(site_id,site_version,contractor_profile_id) REFERENCES business_punch_site_versions(id,version,contractor_profile_id) ON DELETE RESTRICT,
 FOREIGN KEY(policy_id,policy_version,contractor_profile_id) REFERENCES business_punch_policy_versions(id,version,contractor_profile_id) ON DELETE RESTRICT,
 CHECK((capture_status='CAPTURED' AND device_latitude IS NOT NULL AND device_longitude IS NOT NULL AND accuracy_meters IS NOT NULL AND sampled_at IS NOT NULL
   AND device_latitude BETWEEN -90 AND 90 AND device_longitude BETWEEN -180 AND 180 AND accuracy_meters>0 AND accuracy_meters<'Infinity'::float8 AND isfinite(sampled_at))
   OR (capture_status<>'CAPTURED' AND device_latitude IS NULL AND device_longitude IS NULL AND accuracy_meters IS NULL AND sampled_at IS NULL))
);
CREATE INDEX business_punch_snapshots_self_idx ON business_punch_location_snapshots(contractor_profile_id,membership_id,received_at DESC,id);

CREATE FUNCTION assert_punch_command(business_id INTEGER, member_id UUID, exact_command UUID, expected_action TEXT, allowed_roles TEXT[])
RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_team_memberships m JOIN business_punch_location_commands c
    ON c.actor_membership_id=m.id AND c.contractor_profile_id=m.contractor_profile_id
   WHERE m.id=member_id AND m.contractor_profile_id=business_id AND m.status='ACTIVE' AND m.role=ANY(allowed_roles)
     AND c.id=exact_command AND c.action=expected_action AND c.completed_at IS NULL) THEN
   RAISE EXCEPTION 'Punch command lacks exact active business/member/action authority';
 END IF;
END $$;

CREATE FUNCTION guard_punch_policy_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE prior business_punch_policy_versions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text,0));
 SELECT * INTO prior FROM business_punch_policy_versions WHERE id=NEW.id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(prior.version,0)+1 OR (prior.id IS NOT NULL AND prior.contractor_profile_id<>NEW.contractor_profile_id) THEN
   RAISE EXCEPTION 'Punch policy version or business identity is invalid'; END IF;
 PERFORM assert_punch_command(NEW.contractor_profile_id,NEW.actor_membership_id,NEW.command_id,'POLICY_WRITE',ARRAY['OWNER']);
 IF NEW.state='REVOKED' AND (prior.id IS NULL OR
   (to_jsonb(NEW)-ARRAY['version','state','actor_membership_id','command_id','created_at']) IS DISTINCT FROM
   (to_jsonb(prior)-ARRAY['version','state','actor_membership_id','command_id','created_at'])) THEN
   RAISE EXCEPTION 'Punch policy revocation must preserve prior policy'; END IF;
 NEW.created_at:=CURRENT_TIMESTAMP; RETURN NEW;
END $$;
CREATE TRIGGER business_punch_policy_guard BEFORE INSERT ON business_punch_policy_versions FOR EACH ROW EXECUTE FUNCTION guard_punch_policy_version();

CREATE FUNCTION business_punch_site_is_current(business_id INTEGER, exact_site UUID, exact_version INTEGER, exact_job UUID DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE SQL STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM business_punch_site_versions s
 JOIN business_punch_policy_versions p ON p.id=s.policy_id AND p.version=s.policy_version AND p.contractor_profile_id=s.contractor_profile_id
 WHERE s.id=exact_site AND s.version=exact_version AND s.contractor_profile_id=business_id AND s.state='ACTIVE' AND p.state='ACTIVE'
 AND s.version=(SELECT max(version) FROM business_punch_site_versions WHERE id=s.id)
 AND p.version=(SELECT max(version) FROM business_punch_policy_versions WHERE id=p.id)
 AND (s.kind='MANUAL_BUSINESS' OR (s.job_id=COALESCE(exact_job,s.job_id) AND EXISTS(
   SELECT 1 FROM business_punch_customer_location(business_id,s.job_id) r
   WHERE r.source_type=s.source_type AND r.source_id=s.source_id AND r.source_version IS NOT DISTINCT FROM s.source_version AND r.source_revision=s.source_revision))))
$$;

CREATE FUNCTION guard_punch_site_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE prior business_punch_site_versions%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id::text,0));
 SELECT * INTO prior FROM business_punch_site_versions WHERE id=NEW.id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(prior.version,0)+1 OR (prior.id IS NOT NULL AND (prior.contractor_profile_id<>NEW.contractor_profile_id OR prior.kind<>NEW.kind OR prior.job_id IS DISTINCT FROM NEW.job_id)) THEN
   RAISE EXCEPTION 'Punch site version or source/business identity is invalid'; END IF;
 PERFORM assert_punch_command(NEW.contractor_profile_id,NEW.actor_membership_id,NEW.command_id,'SITE_WRITE',ARRAY['OWNER','MANAGER']);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.policy_id::text,0));
 IF NEW.state='ACTIVE' THEN
   IF NOT EXISTS(SELECT 1 FROM business_punch_policy_versions p WHERE p.id=NEW.policy_id AND p.version=NEW.policy_version AND p.contractor_profile_id=NEW.contractor_profile_id
     AND p.state='ACTIVE' AND p.version=(SELECT max(version) FROM business_punch_policy_versions WHERE id=p.id)) THEN
     RAISE EXCEPTION 'Punch site requires a current active business policy'; END IF;
   IF NEW.kind='CUSTOMER_JOB' AND NOT EXISTS(SELECT 1 FROM business_punch_customer_location(NEW.contractor_profile_id,NEW.job_id) r
     WHERE r.source_type=NEW.source_type AND r.source_id=NEW.source_id AND r.source_version IS NOT DISTINCT FROM NEW.source_version AND r.source_revision=NEW.source_revision) THEN
     RAISE EXCEPTION 'Punch site requires current canonical customer location reference'; END IF;
 END IF;
 IF NEW.state='REVOKED' AND (prior.id IS NULL OR
   (to_jsonb(NEW)-ARRAY['version','state','actor_membership_id','command_id','created_at']) IS DISTINCT FROM
   (to_jsonb(prior)-ARRAY['version','state','actor_membership_id','command_id','created_at'])) THEN
   RAISE EXCEPTION 'Punch site revocation must preserve prior geometry/provenance'; END IF;
 NEW.created_at:=CURRENT_TIMESTAMP; RETURN NEW;
END $$;
CREATE TRIGGER business_punch_site_guard BEFORE INSERT ON business_punch_site_versions FOR EACH ROW EXECUTE FUNCTION guard_punch_site_version();

CREATE FUNCTION business_punch_assignment_is_current(business_id INTEGER, exact_assignment UUID, exact_job UUID, exact_member UUID, activation INTEGER)
RETURNS BOOLEAN LANGUAGE SQL STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM business_job_assignments a JOIN business_team_memberships m ON m.id=a.membership_id AND m.contractor_profile_id=a.contractor_profile_id
 WHERE a.id=exact_assignment AND a.contractor_profile_id=business_id AND a.job_id=exact_job AND a.membership_id=exact_member AND a.state='ACTIVE'
 AND m.status='ACTIVE' AND m.role IN ('MANAGER','FIELD_EMPLOYEE')
 AND activation=(SELECT max(assignment_version) FROM business_job_assignment_events WHERE assignment_id=a.id AND event_type IN ('ASSIGNED','REASSIGNED'))
 AND EXISTS(SELECT 1 FROM business_employee_job_sources(business_id,exact_job)))
$$;
CREATE FUNCTION guard_punch_assignment_site_version() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE prior business_punch_assignment_site_versions%ROWTYPE;
BEGIN
 PERFORM 1 FROM business_job_assignments WHERE id=NEW.assignment_id FOR UPDATE;
 SELECT * INTO prior FROM business_punch_assignment_site_versions WHERE assignment_id=NEW.assignment_id AND site_id=NEW.site_id ORDER BY version DESC LIMIT 1;
 IF NEW.version<>COALESCE(prior.version,0)+1 OR (prior.assignment_id IS NOT NULL AND (prior.contractor_profile_id<>NEW.contractor_profile_id OR prior.membership_id<>NEW.membership_id OR prior.job_id<>NEW.job_id)) THEN
   RAISE EXCEPTION 'Punch association version or exact assignment identity is invalid'; END IF;
 PERFORM assert_punch_command(NEW.contractor_profile_id,NEW.actor_membership_id,NEW.command_id,'ASSOCIATION_WRITE',ARRAY['OWNER','MANAGER']);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.site_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(policy_id::text,0)) FROM business_punch_site_versions WHERE id=NEW.site_id AND version=NEW.site_version;
 IF NEW.state='ACTIVE' AND (NOT business_punch_assignment_is_current(NEW.contractor_profile_id,NEW.assignment_id,NEW.job_id,NEW.membership_id,NEW.assignment_activation_version)
   OR NOT business_punch_site_is_current(NEW.contractor_profile_id,NEW.site_id,NEW.site_version,NEW.job_id)) THEN
   RAISE EXCEPTION 'Punch association requires current assignment activation and active site authority'; END IF;
 IF NEW.state='REVOKED' AND (prior.assignment_id IS NULL OR NEW.site_version<>prior.site_version OR NEW.assignment_activation_version<>prior.assignment_activation_version) THEN
   RAISE EXCEPTION 'Punch association revocation must preserve prior authority'; END IF;
 NEW.created_at:=CURRENT_TIMESTAMP; RETURN NEW;
END $$;
CREATE TRIGGER business_punch_assignment_site_guard BEFORE INSERT ON business_punch_assignment_site_versions FOR EACH ROW EXECUTE FUNCTION guard_punch_assignment_site_version();

CREATE FUNCTION guard_punch_location_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s business_punch_site_versions%ROWTYPE; p business_punch_policy_versions%ROWTYPE;
BEGIN
 PERFORM 1 FROM business_job_assignments WHERE id=NEW.assignment_id FOR UPDATE;
 PERFORM assert_punch_command(NEW.contractor_profile_id,NEW.membership_id,NEW.command_id,'SNAPSHOT',ARRAY['MANAGER','FIELD_EMPLOYEE']);
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.site_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(policy_id::text,0)) FROM business_punch_site_versions WHERE id=NEW.site_id AND version=NEW.site_version;
 IF NOT EXISTS(SELECT 1 FROM business_team_memberships WHERE id=NEW.membership_id AND contractor_profile_id=NEW.contractor_profile_id AND user_id=NEW.user_id AND status='ACTIVE') THEN
   RAISE EXCEPTION 'Punch snapshot requires exact authenticated employee identity'; END IF;
 IF NOT business_punch_assignment_is_current(NEW.contractor_profile_id,NEW.assignment_id,NEW.job_id,NEW.membership_id,NEW.assignment_activation_version)
 OR NOT EXISTS(SELECT 1 FROM business_punch_assignment_site_versions a WHERE a.assignment_id=NEW.assignment_id AND a.site_id=NEW.site_id AND a.version=NEW.association_version
   AND a.contractor_profile_id=NEW.contractor_profile_id AND a.membership_id=NEW.membership_id AND a.job_id=NEW.job_id AND a.state='ACTIVE'
   AND a.assignment_activation_version=NEW.assignment_activation_version AND a.site_version=NEW.site_version
   AND a.version=(SELECT max(version) FROM business_punch_assignment_site_versions WHERE assignment_id=a.assignment_id AND site_id=a.site_id))
 OR NOT business_punch_site_is_current(NEW.contractor_profile_id,NEW.site_id,NEW.site_version,NEW.job_id) THEN
   RAISE EXCEPTION 'Punch snapshot requires current exact assignment/site/source authority'; END IF;
 SELECT * INTO s FROM business_punch_site_versions WHERE id=NEW.site_id AND version=NEW.site_version;
 SELECT * INTO p FROM business_punch_policy_versions WHERE id=s.policy_id AND version=s.policy_version;
 NEW.target_latitude:=s.latitude; NEW.target_longitude:=s.longitude; NEW.policy_id:=p.id; NEW.policy_version:=p.version; NEW.radius_meters:=p.radius_meters;
 NEW.received_at:=clock_timestamp(); NEW.verification_result:='NOT_PERFORMED'; NEW.distance_meters:=NULL;
 NEW.sample_state:=CASE WHEN NEW.capture_status<>'CAPTURED' THEN NEW.capture_status
   WHEN NEW.accuracy_meters>p.max_accuracy_meters THEN 'INSUFFICIENT_ACCURACY'
   WHEN NEW.sampled_at>NEW.received_at+make_interval(secs=>p.max_future_skew_seconds) THEN 'FUTURE_SAMPLE'
   WHEN NEW.sampled_at<NEW.received_at-make_interval(secs=>p.max_sample_age_seconds) THEN 'STALE'
   ELSE 'READY_FOR_VERIFICATION' END;
 RETURN NEW;
END $$;
CREATE TRIGGER business_punch_snapshot_guard BEFORE INSERT ON business_punch_location_snapshots FOR EACH ROW EXECUTE FUNCTION guard_punch_location_snapshot();

CREATE FUNCTION immutable_punch_location_evidence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Punch location authority versions and evidence are immutable; append a new version'; END $$;
CREATE TRIGGER immutable_punch_policy BEFORE UPDATE OR DELETE ON business_punch_policy_versions FOR EACH ROW EXECUTE FUNCTION immutable_punch_location_evidence();
CREATE TRIGGER immutable_punch_site BEFORE UPDATE OR DELETE ON business_punch_site_versions FOR EACH ROW EXECUTE FUNCTION immutable_punch_location_evidence();
CREATE TRIGGER immutable_punch_association BEFORE UPDATE OR DELETE ON business_punch_assignment_site_versions FOR EACH ROW EXECUTE FUNCTION immutable_punch_location_evidence();
CREATE TRIGGER immutable_punch_snapshot BEFORE UPDATE OR DELETE ON business_punch_location_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_punch_location_evidence();
CREATE FUNCTION guard_punch_location_command_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Punch command evidence is immutable'; END IF;
 IF OLD.completed_at IS NOT NULL OR NEW.result_reference IS NULL OR NEW.completed_at IS NULL
 OR (to_jsonb(NEW)-ARRAY['result_reference','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result_reference','completed_at']) THEN
   RAISE EXCEPTION 'Punch command identity/result is immutable'; END IF;
 NEW.completed_at:=CURRENT_TIMESTAMP; RETURN NEW;
END $$;
CREATE TRIGGER immutable_punch_command BEFORE UPDATE OR DELETE ON business_punch_location_commands FOR EACH ROW EXECUTE FUNCTION guard_punch_location_command_update();

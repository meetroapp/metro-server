-- Task63J4E8-C: extend the existing immutable evidence; no historical backfill.
-- Existing capture-only rows and A0/A/B authority remain valid.
ALTER TABLE business_punch_location_snapshots
 ADD COLUMN time_command_id UUID,
 ADD COLUMN verification_algorithm TEXT,
 DROP CONSTRAINT business_punch_location_snapshots_verification_result_check,
 DROP CONSTRAINT business_punch_location_snapshots_distance_meters_check,
 ADD CONSTRAINT business_punch_snapshot_time_command_unique UNIQUE(time_command_id),
 ADD CONSTRAINT business_punch_snapshot_time_command_fk
 FOREIGN KEY(time_command_id,contractor_profile_id,membership_id)
 REFERENCES business_time_commands(id,contractor_profile_id,actor_membership_id) ON DELETE RESTRICT,
 ADD CONSTRAINT business_punch_snapshot_verification_shape CHECK(
   (time_command_id IS NULL AND verification_result='NOT_PERFORMED'
    AND distance_meters IS NULL AND verification_algorithm IS NULL)
   OR (time_command_id IS NOT NULL AND capture_status='CAPTURED'
    AND sample_state='READY_FOR_VERIFICATION' AND verification_result='VERIFIED_INSIDE'
    AND verification_algorithm IS NOT NULL AND verification_algorithm='HAVERSINE_V1'
    AND distance_meters IS NOT NULL AND distance_meters>=0
    AND distance_meters<'Infinity'::float8 AND distance_meters<=radius_meters));

-- Haversine V1; mean Earth radius is geometric algorithm metadata, never site policy.
CREATE FUNCTION business_punch_distance_meters(lat1 DOUBLE PRECISION, lon1 DOUBLE PRECISION,
 lat2 DOUBLE PRECISION, lon2 DOUBLE PRECISION) RETURNS DOUBLE PRECISION
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
 SELECT 2*6371008.8*asin(sqrt(greatest(0::float8,least(1::float8,
   power(sin(radians(lat2-lat1)/2),2)+cos(radians(lat1))*cos(radians(lat2))*power(sin(radians(lon2-lon1)/2),2)))));
$$;

CREATE OR REPLACE FUNCTION guard_punch_location_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE s business_punch_site_versions%ROWTYPE; p business_punch_policy_versions%ROWTYPE; d DOUBLE PRECISION;
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
 IF NEW.time_command_id IS NULL THEN
   NEW.verification_algorithm := NULL;
 ELSE
   IF NOT EXISTS(SELECT 1 FROM business_time_commands c
     WHERE c.id=NEW.time_command_id AND c.contractor_profile_id=NEW.contractor_profile_id
     AND c.actor_membership_id=NEW.membership_id AND c.action=NEW.boundary
     AND c.completed_at IS NULL AND c.result_reference IS NULL FOR UPDATE) THEN
     RAISE EXCEPTION 'Verified Punch requires exact unfinished time command authority';
   END IF;
   IF NEW.capture_status<>'CAPTURED' OR NEW.sample_state<>'READY_FOR_VERIFICATION' THEN
     RAISE EXCEPTION 'Verified Punch requires fresh accurate captured evidence';
   END IF;
   d := business_punch_distance_meters(NEW.device_latitude,NEW.device_longitude,NEW.target_latitude,NEW.target_longitude);
   IF d IS NULL OR NOT(d>=0 AND d<'Infinity'::float8 AND d<=NEW.radius_meters) THEN
     RAISE EXCEPTION 'Punch is outside authorized proximity';
   END IF;
   NEW.distance_meters := d;
   NEW.verification_result := 'VERIFIED_INSIDE';
   NEW.verification_algorithm := 'HAVERSINE_V1';
 END IF;
 RETURN NEW;
END $$;

-- Deferred until the existing time command/session/event has completed atomically.
CREATE FUNCTION assert_consumed_punch_verification() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.time_command_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM business_time_commands c
   JOIN business_time_events e ON e.command_id=c.id
   JOIN business_time_sessions s ON s.id=e.session_id
   WHERE c.id=NEW.time_command_id AND c.contractor_profile_id=NEW.contractor_profile_id
   AND c.actor_membership_id=NEW.membership_id AND c.action=NEW.boundary
   AND c.completed_at IS NOT NULL AND c.result_reference IS NOT NULL
   AND e.contractor_profile_id=NEW.contractor_profile_id AND e.membership_id=NEW.membership_id
   AND e.actor_user_id=NEW.user_id
   AND e.event_type=CASE NEW.boundary WHEN 'CLOCK_IN' THEN 'CLOCKED_IN' ELSE 'CLOCKED_OUT' END
   AND s.contractor_profile_id=NEW.contractor_profile_id AND s.membership_id=NEW.membership_id
   AND s.user_id=NEW.user_id
   AND (s.category<>'JOB_WORK' OR (s.job_id=NEW.job_id AND s.assignment_id=NEW.assignment_id
     AND s.assignment_activation_version=NEW.assignment_activation_version))
   AND ((NEW.boundary='CLOCK_IN' AND s.clock_in_command_id=c.id AND e.occurred_at=s.clocked_in_at)
     OR (NEW.boundary='CLOCK_OUT' AND s.clock_out_command_id=c.id AND e.occurred_at=s.clocked_out_at))) THEN
   RAISE EXCEPTION 'Verified Punch must be consumed by exact completed time boundary';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER business_punch_consumed_boundary_guard
AFTER INSERT ON business_punch_location_snapshots DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_consumed_punch_verification();
-- Keep immutable_punch_snapshot intact. No UPDATE transition is authorized.

"use strict";

const LEGACY_ROW_COLUMNS = Object.freeze({
  contractor_profiles: Object.freeze([
    "id", "business_name", "category", "phone", "location", "bio",
    "image_url", "plan_type", "is_verified", "is_featured", "created_at",
    "user_id", "for_hire_post_limit", "profile_details",
  ]),
  contractor_projects: Object.freeze([
    "id", "contractor_id", "title", "description", "image_url",
    "created_at", "image_urls",
  ]),
  posts: Object.freeze([
    "id", "user_id", "title", "description", "location", "category",
    "created_at", "mage_url", "image_url", "request_photos",
    "request_category", "service_domain", "service_specialty", "unit_number",
    "access_notes", "status", "updated_at", "cancelled_at",
    "location_intake_mode", "location_normalization_status",
    "service_address_line1", "service_city", "service_region",
    "service_postal_code", "service_country_code", "discovery_area_label",
  ]),
  messages: Object.freeze([
    "id", "quote_request_id", "sender_id", "message_text", "receiver_id",
    "created_at", "image_url", "message_type", "workflow_type",
    "workflow_status", "workflow_payload", "conversation_id",
  ]),
});

const IDENTITY_TABLES = Object.freeze([
  "users",
  "contractor_profiles",
  "contractor_projects",
  "posts",
  "quote_requests",
  "messages",
  "conversations",
  "request_relationships",
  "workflow_events",
]);

const OPERATIONAL_ZERO_TABLES = Object.freeze([
  "jobs",
  "reported_concerns",
  "relationship_participants",
  "canonical_evaluations",
  "canonical_evaluation_findings",
  "canonical_workstreams",
  "canonical_recommendations",
  "canonical_quotes",
  "canonical_invoices",
  "canonical_invoice_payments",
  "canonical_pre_work_deposit_obligations",
  "canonical_material_purchase_records",
  "canonical_approved_work_executions",
  "business_job_assignments",
  "business_time_sessions",
  "business_job_customer_messages",
  "intelligence_quote_composition_feedback",
]);

module.exports = Object.freeze({
  IDENTITY_TABLES,
  LEGACY_ROW_COLUMNS,
  OPERATIONAL_ZERO_TABLES,
});

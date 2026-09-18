-- MEETRO EXISTING CUSTOMER REQUEST CONVERSATION AUTHORITY
--
-- Allows a fresh existing_customer_request Job Request to establish its own
-- active Request Relationship and canonical Conversation from immutable prior
-- Meetro relationship provenance.
--
-- This migration does NOT:
-- - create a Professional Response
-- - create a Request Selection
-- - create a Job
-- - reuse any prior Conversation
-- - reuse prior Quote, deposit, payment, schedule, or work authority
--
-- Marketplace conversations remain governed by canonical Request Selection.
-- Emergency conversation behavior remains unchanged.


-- -------------------------------------------------------------------------
-- Generalize the existing deferred conversation authority trigger.
--
-- Marketplace:
--   active ordinary relationship + canonical Request Selection
--
-- Existing customer:
--   active relationship with ordinary_authority_source =
--   existing_customer_request + exact post/provenance tuple +
--   NULL request_selection_id
--
-- Emergency:
--   active Emergency relationship + NULL request_selection_id
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION
validate_request_selection_authority()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  selection_record request_selections%ROWTYPE;
  response_record professional_responses%ROWTYPE;
  relationship_record request_relationships%ROWTYPE;
  conversation_record conversations%ROWTYPE;
  request_record posts%ROWTYPE;
  selection_id BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'request_selections' THEN
    selection_id := NEW.id;

  ELSIF TG_TABLE_NAME = 'conversations' THEN
    SELECT *
    INTO relationship_record
    FROM request_relationships
    WHERE id = NEW.relationship_id;

    IF relationship_record.id IS NULL THEN
      RAISE EXCEPTION
        'Conversation relationship authority is missing.'
        USING ERRCODE = '23514';
    END IF;

    -- Emergency conversations continue to have no ordinary selection.
    IF relationship_record.emergency_request_id IS NOT NULL THEN
      IF NEW.request_selection_id IS NOT NULL THEN
        RAISE EXCEPTION
          'Emergency conversations cannot use ordinary selection authority.'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END IF;

    -- Direct repeat-customer conversations are governed by the exact
    -- existing-customer Job Request and immutable prior Meetro relationship,
    -- not by a fabricated Professional Response or Request Selection.
    IF relationship_record.ordinary_authority_source =
         'existing_customer_request' THEN

      IF NEW.request_selection_id IS NOT NULL
         OR relationship_record.post_id IS NULL
         OR relationship_record.professional_response_id IS NOT NULL
         OR relationship_record.source_meetro_relationship_id IS NULL
         OR relationship_record.status <> 'active' THEN
        RAISE EXCEPTION
          'Existing Customer conversation authority is incomplete.'
          USING ERRCODE = '23514';
      END IF;

      SELECT *
      INTO request_record
      FROM posts
      WHERE id = relationship_record.post_id;

      IF request_record.id IS NULL
         OR request_record.request_origin <>
              'existing_customer_request'
         OR request_record.user_id <>
              relationship_record.homeowner_id
         OR request_record.target_contractor_profile_id <>
              relationship_record.contractor_id
         OR request_record.target_professional_user_id <>
              relationship_record.professional_user_id
         OR request_record.source_meetro_relationship_id <>
              relationship_record.source_meetro_relationship_id
         OR NEW.homeowner_id <>
              relationship_record.homeowner_id
         OR NEW.contractor_id <>
              relationship_record.contractor_id
         OR NEW.professional_user_id <>
              relationship_record.professional_user_id
         OR NEW.status <> 'active' THEN
        RAISE EXCEPTION
          'Existing Customer conversation identity does not match its governed Job Request.'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END IF;

    -- Existing marketplace rule remains unchanged.
    IF NEW.request_selection_id IS NULL THEN
      RAISE EXCEPTION
        'New ordinary conversations require canonical selection authority.'
        USING ERRCODE = '23514';
    END IF;

    selection_id := NEW.request_selection_id;

  ELSIF TG_TABLE_NAME = 'professional_responses' THEN
    SELECT id
    INTO selection_id
    FROM request_selections
    WHERE professional_response_id = NEW.id
      AND ended_at IS NULL;

    IF selection_id IS NULL THEN
      RETURN NEW;
    END IF;

  ELSE
    SELECT id
    INTO selection_id
    FROM request_selections
    WHERE request_relationship_id = NEW.id
      AND ended_at IS NULL;

    IF selection_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT *
  INTO selection_record
  FROM request_selections
  WHERE id = selection_id;

  IF selection_record.id IS NULL
     OR selection_record.ended_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT *
  INTO response_record
  FROM professional_responses
  WHERE id = selection_record.professional_response_id;

  SELECT *
  INTO relationship_record
  FROM request_relationships
  WHERE id = selection_record.request_relationship_id;

  SELECT *
  INTO conversation_record
  FROM conversations
  WHERE id = selection_record.conversation_id;

  IF response_record.id IS NULL
     OR relationship_record.id IS NULL
     OR conversation_record.id IS NULL
     OR response_record.status <> 'selected'
     OR response_record.current_version <>
       selection_record.selected_response_version
     OR relationship_record.status <> 'active'
     OR relationship_record.current_version <>
       selection_record.selected_response_version
     OR relationship_record.emergency_request_id IS NOT NULL
     OR relationship_record.post_id <> selection_record.post_id
     OR relationship_record.professional_response_id <>
       selection_record.professional_response_id
     OR relationship_record.homeowner_id <>
       selection_record.selected_by_user_id
     OR relationship_record.contractor_id <>
       selection_record.contractor_id
     OR relationship_record.professional_user_id <>
       selection_record.professional_user_id
     OR conversation_record.relationship_id <>
       selection_record.request_relationship_id
     OR conversation_record.request_selection_id <>
       selection_record.id
     OR conversation_record.homeowner_id <>
       selection_record.selected_by_user_id
     OR conversation_record.contractor_id <>
       selection_record.contractor_id
     OR conversation_record.professional_user_id <>
       selection_record.professional_user_id
     OR conversation_record.status <> 'active' THEN
    RAISE EXCEPTION
      'Canonical Request Selection authority is incomplete or inconsistent.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;


COMMENT ON COLUMN conversations.request_selection_id IS
  'Canonical Request Selection for marketplace conversations. NULL for Emergency and existing_customer_request conversations, whose authority is proven by their exact Request Relationship source.';

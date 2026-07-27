"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONVERSATION_STATUSES,
  CONVERSATION_STATUS_VALUES,
  canArchiveConversation,
  canCloseConversation,
  canRestoreConversation,
  deriveEmergencyWorkflow,
  hasExactlyOneConversationSource,
  isConversationParticipant,
  isValidPositiveInteger,
  parsePositiveInteger,
  participantArchiveField,
  serializeConversationForHomeowner,
  serializeConversationForProfessional,
  serializeConversationDetail,
  serializeConversationMessage,
  serializeConversationSummaryForHomeowner,
  serializeConversationSummaryForProfessional,
  validateConversationStatus,
} = require("../server/conversations/conversations");

test("conversation statuses expose the governed shared lifecycle", () => {
  assert.deepEqual(CONVERSATION_STATUSES, {
    ACTIVE: "active",
    CLOSED: "closed",
  });

  assert.deepEqual(CONVERSATION_STATUS_VALUES, [
    "active",
    "closed",
  ]);
});

test("positive integer parsing rejects malformed and unsafe identifiers", () => {
  assert.equal(isValidPositiveInteger("1"), true);
  assert.equal(isValidPositiveInteger(42), true);

  for (const invalid of [
    undefined,
    null,
    "",
    "0",
    0,
    "-1",
    "1.5",
    "abc",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(isValidPositiveInteger(invalid), false);
    assert.equal(parsePositiveInteger(invalid), null);
  }

  assert.equal(parsePositiveInteger("42"), 42);
});

test("conversation status validation rejects archive as a shared status", () => {
  assert.equal(validateConversationStatus("active"), true);
  assert.equal(validateConversationStatus("closed"), true);

  for (const unsupported of [
    "archived",
    "pending",
    "declined",
    "withdrawn",
    "deleted",
    "",
    null,
  ]) {
    assert.equal(validateConversationStatus(unsupported), false);
  }
});

test("conversation participant checks are owner scoped", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
  };

  assert.equal(isConversationParticipant(conversation, 7), true);
  assert.equal(isConversationParticipant(conversation, 9), true);
  assert.equal(isConversationParticipant(conversation, 10), false);

  assert.equal(
    participantArchiveField(conversation, 7),
    "homeowner_archived_at"
  );

  assert.equal(
    participantArchiveField(conversation, 9),
    "professional_archived_at"
  );

  assert.equal(participantArchiveField(conversation, 10), null);
});

test("each participant can archive their own active inbox record independently", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
  };

  assert.equal(canArchiveConversation(conversation, 7), true);
  assert.equal(canArchiveConversation(conversation, 9), false);
  assert.equal(canArchiveConversation(conversation, 10), false);
});

test("each participant can restore only their own archived inbox record", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
    homeowner_archived_at: "2026-07-21T14:00:00.000Z",
    professional_archived_at: null,
  };

  assert.equal(canRestoreConversation(conversation, 7), true);
  assert.equal(canRestoreConversation(conversation, 9), false);
  assert.equal(canRestoreConversation(conversation, 10), false);
});

test("closed conversations cannot be archived or restored", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "closed",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
  };

  assert.equal(canArchiveConversation(conversation, 7), false);
  assert.equal(canRestoreConversation(conversation, 9), false);
});

test("conversation closure is participant scoped and irreversible", () => {
  const conversation = {
    homeowner_id: 7,
    professional_user_id: 9,
    status: "active",
  };

  assert.equal(canCloseConversation(conversation, 7), true);
  assert.equal(canCloseConversation(conversation, 9), true);
  assert.equal(canCloseConversation(conversation, 10), false);

  assert.equal(
    canCloseConversation(
      { ...conversation, status: "closed" },
      7
    ),
    false
  );
});

test("homeowner serializer exposes only the homeowner archive state", () => {
  const serialized = serializeConversationForHomeowner({
    id: 51,
    relationship_id: 31,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    business_name: "Molina Home Services",
    business_image_url: "https://example.com/logo.jpg",
    professional_category: "Home Services",
    status: "active",
    homeowner_archived_at: "2026-07-21T14:00:00.000Z",
    professional_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.deepEqual(serialized, {
    id: 51,
    relationship_id: 31,
    contractor_id: 80,
    business_name: "Molina Home Services",
    business_image_url: "https://example.com/logo.jpg",
    professional_category: "Home Services",
    status: "active",
    archived: true,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
  assert.equal(
    Object.hasOwn(serialized, "professional_archived_at"),
    false
  );
});

test("professional serializer exposes only the professional archive state", () => {
  const serialized = serializeConversationForProfessional({
    id: 51,
    relationship_id: 31,
    post_id: 41,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    request_title: "Kitchen drywall repair",
    homeowner_display_name: "William",
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.deepEqual(serialized, {
    id: 51,
    relationship_id: 31,
    request_id: 41,
    request_title: "Kitchen drywall repair",
    homeowner_display_name: "William",
    status: "active",
    archived: true,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-21T14:00:00.000Z",
    closed_at: null,
  });

  assert.equal(Object.hasOwn(serialized, "homeowner_id"), false);
  assert.equal(Object.hasOwn(serialized, "professional_user_id"), false);
  assert.equal(Object.hasOwn(serialized, "contractor_id"), false);
  assert.equal(
    Object.hasOwn(serialized, "homeowner_archived_at"),
    false
  );
});


test("homeowner conversation summary exposes UI-safe relationship and business context", () => {
  const summary = serializeConversationSummaryForHomeowner({
    id: 91,
    relationship_id: 51,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    post_id: 41,
    request_title: "Drywall Repair",
    business_name: "Trusted Repairs",
    business_image_url: "https://example.test/logo.jpg",
    professional_category: "handyman",
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-22T14:00:00.000Z",
  });

  assert.deepEqual(summary, {
    id: 91,
    conversation_id: 91,
    request_id: 41,
    request_title: "Drywall Repair",
    relationship: {
      title: "Drywall Repair",
      stage: "conversation",
    },
    display: {
      name: "Trusted Repairs",
      image_url: "https://example.test/logo.jpg",
      category: "handyman",
    },
    status: {
      value: "active",
      active: true,
      archived: false,
      requires_attention: false,
    },
    last_activity: "2026-07-22T14:00:00.000Z",
    last_message_preview: null,
    unread_count: 0,
    conversation_available: true,
    permissions: {
      canSendMessages: true,
    },
  });

  for (const privateField of [
    "relationship_id",
    "homeowner_id",
    "professional_user_id",
    "contractor_id",
    "homeowner_archived_at",
    "professional_archived_at",
  ]) {
    assert.equal(Object.hasOwn(summary, privateField), false);
  }

  assert.equal(Object.hasOwn(summary.relationship, "id"), false);
});

test("professional conversation summary uses the same UI contract", () => {
  const summary = serializeConversationSummaryForProfessional({
    id: 91,
    relationship_id: 51,
    post_id: 41,
    homeowner_id: 7,
    professional_user_id: 9,
    contractor_id: 80,
    request_title: "Drywall Repair",
    homeowner_display_name: "William Molina",
    status: "active",
    homeowner_archived_at: null,
    professional_archived_at: "2026-07-21T14:00:00.000Z",
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-22T14:00:00.000Z",
  });

  assert.deepEqual(summary, {
    id: 91,
    relationship: {
      id: 51,
      title: "Drywall Repair",
      stage: "conversation",
    },
    display: {
      name: "William Molina",
      image_url: "",
      category: "",
    },
    status: {
      value: "active",
      active: true,
      archived: true,
      requires_attention: false,
    },
    last_activity: "2026-07-22T14:00:00.000Z",
    last_message_preview: null,
    unread_count: 0,
    conversation_available: true,
  });

  for (const privateField of [
    "homeowner_id",
    "professional_user_id",
    "contractor_id",
    "post_id",
    "homeowner_archived_at",
    "professional_archived_at",
  ]) {
    assert.equal(Object.hasOwn(summary, privateField), false);
  }
});

test("closed conversation summaries remain available but not active", () => {
  const homeowner = serializeConversationSummaryForHomeowner({
    id: 91,
    relationship_id: 51,
    post_id: 41,
    request_title: "Drywall Repair",
    status: "closed",
    homeowner_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: null,
  });

  assert.equal(homeowner.status.value, "closed");
  assert.equal(homeowner.status.active, false);
  assert.equal(homeowner.conversation_available, true);
  assert.equal(homeowner.permissions.canSendMessages, false);
  assert.equal(
    homeowner.last_activity,
    "2026-07-20T14:00:00.000Z"
  );
});


test("conversation detail serializer exposes canonical participant-scoped data", () => {
  const row = {
    id: 91,
    relationship_id: 51,
    post_id: 41,
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    request_title: "Drywall Repair",
    homeowner_display_name: "William Molina",
    business_name: "Trusted Repairs",
    business_image_url: "https://example.test/logo.jpg",
    professional_category: "handyman",
    homeowner_archived_at: null,
    professional_archived_at: null,
    created_at: "2026-07-20T14:00:00.000Z",
    updated_at: "2026-07-22T14:00:00.000Z",
    closed_at: null,
  };

  assert.deepEqual(
    serializeConversationDetail(row, 7),
    {
      conversation: {
        id: 91,
        type: "request",
        status: "active",
        createdAt: "2026-07-20T14:00:00.000Z",
        updatedAt: "2026-07-22T14:00:00.000Z",
        closedAt: null,
      },
      participants: {
        viewer: {
          id: 7,
          role: "homeowner",
        },
        homeowner: {
          id: 7,
          displayName: "William Molina",
        },
        business: {
          id: 80,
          userId: 9,
          name: "Trusted Repairs",
          imageUrl: "https://example.test/logo.jpg",
          category: "handyman",
        },
      },
      relationship: {
        id: 51,
        requestId: 41,
        title: "Drywall Repair",
      },
      workflow: {
        status: null,
        stage: null,
      },
      permissions: {
        canRead: true,
        canSendMessages: true,
        canManageWorkflow: false,
      },
    }
  );

  const serialized =
    serializeConversationDetail(row, 7);

  for (const internalField of [
    "homeowner_id",
    "professional_user_id",
    "contractor_id",
    "homeowner_archived_at",
    "professional_archived_at",
    "post_id",
    "relationship_id",
  ]) {
    assert.equal(
      Object.hasOwn(serialized, internalField),
      false
    );
  }
});

test("conversation detail serializer identifies the professional viewer", () => {
  const detail = serializeConversationDetail(
    {
      id: 91,
      relationship_id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      request_title: "Drywall Repair",
      homeowner_display_name: "William Molina",
      business_name: "Trusted Repairs",
      created_at: "2026-07-20T14:00:00.000Z",
      updated_at: "2026-07-22T14:00:00.000Z",
    },
    9
  );

  assert.deepEqual(detail.participants.viewer, {
    id: 9,
    role: "professional",
  });

  assert.equal(detail.permissions.canRead, true);
  assert.equal(detail.permissions.canSendMessages, true);
  assert.equal(detail.permissions.canManageWorkflow, false);
});

test("closed conversation detail disables sending without granting workflow authority", () => {
  const detail = serializeConversationDetail(
    {
      id: 91,
      relationship_id: 51,
      post_id: 41,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "closed",
      request_title: "Drywall Repair",
      created_at: "2026-07-20T14:00:00.000Z",
      updated_at: "2026-07-22T14:00:00.000Z",
      closed_at: "2026-07-22T14:00:00.000Z",
    },
    7
  );

  assert.equal(detail.permissions.canRead, true);
  assert.equal(detail.permissions.canSendMessages, false);
  assert.equal(detail.permissions.canManageWorkflow, false);
});

test("conversation detail serializer rejects a non-participant viewer", () => {
  assert.throws(
    () =>
      serializeConversationDetail(
        {
          homeowner_id: 7,
          professional_user_id: 9,
        },
        10
      ),
    /authorized participant/
  );
});


test("conversation message serializer exposes only the canonical public contract", () => {
  const serialized =
    serializeConversationMessage(
      {
        id: 201,
        quote_request_id: 3001,
        conversation_id: 91,
        sender_id: 7,
        receiver_id: 9,
        sender_email:
          "private@example.test",
        message_text: "Hello",
        image_url: null,
        message_type: "workflow",
        workflow_type: "quote",
        workflow_status: "sent",
        workflow_payload: {
          safe: true,
        },
        created_at:
          "2026-07-21T12:00:00.000Z",
      },
      7
    );

  assert.deepEqual(serialized, {
    id: 201,
    sender: {
      id: 7,
      isViewer: true,
    },
    recipient: {
      id: 9,
    },
    content: {
      text: "Hello",
      imageUrl: null,
      type: "workflow",
    },
    workflow: {
      type: "quote",
      status: "sent",
      payload: {
        safe: true,
      },
    },
    createdAt:
      "2026-07-21T12:00:00.000Z",
  });

  for (const privateField of [
    "quote_request_id",
    "conversation_id",
    "sender_id",
    "receiver_id",
    "sender_email",
    "message_text",
    "image_url",
    "message_type",
    "workflow_type",
    "workflow_status",
    "workflow_payload",
    "created_at",
  ]) {
    assert.equal(
      Object.hasOwn(
        serialized,
        privateField
      ),
      false
    );
  }
});

test("conversation message serializer normalizes malformed workflow payloads", () => {
  const serialized =
    serializeConversationMessage(
      {
        id: 202,
        sender_id: 9,
        receiver_id: null,
        message_text: "",
        message_type: "",
        workflow_payload: [],
        created_at: null,
      },
      7
    );

  assert.equal(
    serialized.sender.isViewer,
    false
  );

  assert.deepEqual(
    serialized.workflow.payload,
    {}
  );

  assert.equal(
    serialized.content.type,
    "text"
  );

  assert.equal(
    serialized.recipient.id,
    null
  );
});


test("Emergency conversation serializers expose explicit Emergency source identity", () => {
  const row = {
    id: 92,
    relationship_id: 52,
    post_id: null,
    emergency_request_id: 61,
    source_type: "emergency",
    request_title: "Emergency Plumbing",
    source_service_domain: "home_services",
    source_service_specialty: "plumbing_repair",
    source_relationship_status: "active",
    source_workflow_status: "assigned",
    source_assigned_at: "2026-07-23T14:00:30.000Z",
    source_en_route_at: null,
    source_arrived_at: null,
    source_work_started_at: null,
    source_completed_at: null,
    source_location_text: "101 Synthetic Test Ave",
    source_unit_number: "Unit 2",
    source_access_notes: "Use the test entrance",
    homeowner_id: 7,
    contractor_id: 80,
    professional_user_id: 9,
    status: "active",
    homeowner_display_name: "William Molina",
    business_name: "Trusted Repairs",
    business_image_url: "",
    professional_category: "plumbing",
    created_at: "2026-07-23T14:00:00.000Z",
    updated_at: "2026-07-23T14:01:00.000Z",
  };
  const homeowner = serializeConversationSummaryForHomeowner(row);
  assert.equal(homeowner.request_id, null);
  assert.equal(homeowner.emergency_request_id, 61);
  assert.equal(homeowner.source.type, "emergency");
  assert.equal(homeowner.source.isEmergency, true);
  assert.equal(homeowner.viewer.role, "homeowner");
  assert.equal(homeowner.workflow.status, "assigned");
  assert.deepEqual(homeowner.workflow.allowedActions, []);
  assert.equal(homeowner.permissions.canMarkEnRoute, false);
  assert.equal(Object.hasOwn(homeowner, "location"), false);
  const professional = serializeConversationSummaryForProfessional(row);
  assert.equal(professional.emergency_request_id, 61);
  assert.equal(professional.source.id, 61);
  assert.equal(professional.viewer.role, "professional");
  assert.deepEqual(
    professional.workflow.allowedActions,
    ["mark_en_route"]
  );
  assert.equal(professional.permissions.canMarkEnRoute, true);
  assert.equal(Object.hasOwn(professional, "location"), false);
  const detail = serializeConversationDetail(row, 7);
  assert.equal(detail.conversation.type, "emergency");
  assert.equal(detail.relationship.emergencyRequestId, 61);
  assert.equal(Object.hasOwn(detail.relationship, "requestId"), false);
  assert.deepEqual(detail.location, {
    locationText: "101 Synthetic Test Ave",
    unitNumber: "Unit 2",
    accessNotes: "Use the test entrance",
  });
  assert.deepEqual(detail.workflow, {
    status: "assigned",
    assignedAt: "2026-07-23T14:00:30.000Z",
    enRouteAt: null,
    arrivedAt: null,
    workStartedAt: null,
    completedAt: null,
    allowedActions: [],
  });
  assert.equal(
    JSON.stringify(detail).includes("safety"),
    false
  );
});

test("Emergency workflow derivation grants only the professional's exact next action", () => {
  const cases = [
    ["ready_for_distribution", null],
    ["assigned", "mark_en_route"],
    ["professional_en_route", "mark_arrived"],
    ["professional_arrived", "start_work"],
    ["work_in_progress", "complete_work"],
    ["completed", null],
  ];

  for (const [status, expectedAction] of cases) {
    const row = {
      emergency_request_id: 61,
      source_relationship_status: "active",
      source_workflow_status: status,
      status: "active",
    };
    const professional = deriveEmergencyWorkflow({
      row,
      viewerRole: "professional",
    });
    const homeowner = deriveEmergencyWorkflow({
      row,
      viewerRole: "homeowner",
    });

    assert.deepEqual(
      professional.workflow.allowedActions,
      expectedAction ? [expectedAction] : []
    );
    assert.deepEqual(
      homeowner.workflow.allowedActions,
      []
    );
    assert.equal(
      homeowner.permissions.canManageWorkflow,
      false
    );
  }
});

test("both participants recover every Emergency dispatch stage from canonical rows", () => {
  const cases = [
    ["assigned", "mark_en_route"],
    ["professional_en_route", "mark_arrived"],
    ["professional_arrived", "start_work"],
    ["work_in_progress", "complete_work"],
    ["completed", null],
  ];

  for (const [status, expectedAction] of cases) {
    const row = {
      id: 92,
      relationship_id: 52,
      post_id: null,
      emergency_request_id: 61,
      source_relationship_status: "active",
      source_workflow_status: status,
      source_assigned_at: "assigned",
      source_en_route_at:
        status === "assigned" ? null : "en-route",
      source_arrived_at: [
        "professional_arrived",
        "work_in_progress",
        "completed",
      ].includes(status)
        ? "arrived"
        : null,
      source_work_started_at: [
        "work_in_progress",
        "completed",
      ].includes(status)
        ? "work-started"
        : null,
      source_completed_at:
        status === "completed" ? "completed" : null,
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
    };
    const homeownerList =
      serializeConversationSummaryForHomeowner(row);
    const professionalList =
      serializeConversationSummaryForProfessional(row);
    const homeownerDetail =
      serializeConversationDetail(row, 7);
    const professionalDetail =
      serializeConversationDetail(row, 9);

    for (const projection of [
      homeownerList,
      professionalList,
      homeownerDetail,
      professionalDetail,
    ]) {
      assert.equal(projection.workflow.status, status);
      assert.equal(
        projection.workflow.completedAt,
        status === "completed" ? "completed" : null
      );
    }

    assert.deepEqual(
      homeownerList.workflow.allowedActions,
      []
    );
    assert.deepEqual(
      homeownerDetail.workflow.allowedActions,
      []
    );
    assert.deepEqual(
      professionalList.workflow.allowedActions,
      expectedAction ? [expectedAction] : []
    );
    assert.deepEqual(
      professionalDetail.workflow.allowedActions,
      expectedAction ? [expectedAction] : []
    );
  }
});

test("Emergency workflow derivation grants no actions for inactive authority", () => {
  for (const row of [
    {
      emergency_request_id: 61,
      source_relationship_status: "inactive",
      source_workflow_status: "assigned",
      status: "active",
    },
    {
      emergency_request_id: 61,
      source_relationship_status: "active",
      source_workflow_status: "assigned",
      status: "closed",
    },
  ]) {
    const result = deriveEmergencyWorkflow({
      row,
      viewerRole: "professional",
    });

    assert.deepEqual(result.workflow.allowedActions, []);
    assert.equal(
      result.permissions.canManageWorkflow,
      false
    );
  }
});

test("Emergency conversation serializers fail closed on malformed or inactive sources", () => {
  assert.equal(
    hasExactlyOneConversationSource({
      post_id: 41,
      emergency_request_id: null,
    }),
    true
  );
  assert.equal(
    hasExactlyOneConversationSource({
      post_id: null,
      emergency_request_id: 61,
    }),
    true
  );

  for (const row of [
    {
      post_id: 41,
      emergency_request_id: 61,
      homeowner_id: 7,
      professional_user_id: 9,
    },
    {
      post_id: null,
      emergency_request_id: null,
      homeowner_id: 7,
      professional_user_id: 9,
    },
  ]) {
    assert.throws(
      () => serializeConversationDetail(row, 7),
      /source is invalid/
    );
    assert.throws(
      () => serializeConversationSummaryForHomeowner(row),
      /source is invalid/
    );
    assert.throws(
      () => serializeConversationSummaryForProfessional(row),
      /source is invalid/
    );
  }

  assert.throws(
    () =>
      serializeConversationDetail(
        {
          post_id: null,
          emergency_request_id: 61,
          source_relationship_status: "inactive",
          homeowner_id: 7,
          professional_user_id: 9,
        },
        7
      ),
    /active Emergency relationship/
  );
});

test("completed Emergency work remains an open conversation without fabricated closeout state", () => {
  const detail = serializeConversationDetail(
    {
      id: 92,
      relationship_id: 52,
      post_id: null,
      emergency_request_id: 61,
      source_relationship_status: "active",
      source_workflow_status: "completed",
      source_completed_at: "2026-07-23T16:00:00.000Z",
      homeowner_id: 7,
      contractor_id: 80,
      professional_user_id: 9,
      status: "active",
      closed_at: null,
    },
    9
  );

  assert.equal(detail.conversation.status, "active");
  assert.equal(detail.conversation.closedAt, null);
  assert.equal(detail.workflow.status, "completed");
  assert.deepEqual(detail.workflow.allowedActions, []);

  for (const fabricatedField of [
    "archived",
    "reviewReady",
    "invoiceReady",
    "history",
    "closeout",
  ]) {
    assert.equal(
      JSON.stringify(detail).includes(fabricatedField),
      false
    );
  }
});

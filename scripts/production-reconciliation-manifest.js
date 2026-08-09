"use strict";

const EXPECTED_TARGET = Object.freeze({
  projectId: "10d1facd-6aa6-4052-9897-803396f813c4",
  projectName: "profound-magic",
  environmentId: "3554dcb8-3f0a-4b8f-bbdf-162777ad87fa",
  environmentName: "production",
  databaseServiceId: "80a103f2-56b3-4b62-a261-51a19169de5b",
  databaseServiceName: "Postgres",
  backendServiceId: "831a310f-2cee-4c3c-8f36-52e78bbdb5bf",
  databaseName: "railway",
  volumeId: "240904be-1b53-48f2-9ab8-6681e6d5b0d2",
  volumeInstanceId: "d17824c7-8e51-4fcb-b0ed-4efb6e806448",
});

const LOGICAL_BACKUP_CERTIFICATION = Object.freeze({
  sourcePostgresMajor: 18,
  counts: Object.freeze({
    schema_migrations: 14,
    messages: 16,
    users: 11,
    posts: 43,
    request_relationships: 1,
    conversations: 1,
  }),
  tables: Object.freeze([
    "contractor_profiles",
    "contractor_projects",
    "conversations",
    "emergency_request_safety_assessments",
    "emergency_requests",
    "messages",
    "password_reset_tokens",
    "posts",
    "quote_requests",
    "request_relationships",
    "reviews",
    "schema_migrations",
    "users",
    "workflow_events",
  ]),
  catalog: Object.freeze({
    columns: Object.freeze({
      count: 161,
      sha256: "1cea9649d2322074d67a4f746579f67805dd3b0f096b47651fe39a52704002db",
    }),
    constraints: Object.freeze({
      count: 127,
      sha256: "423544374e73fc7ba72c1c9acdcf533be7e4e86c057c6b22c7c0e7484a04fe59",
    }),
    indexes: Object.freeze({
      count: 37,
      sha256: "5e15ce0cb6ca8a7525f6826e337178ce453c8fe3f2db6ed91ad3d7f853df1809",
    }),
    functions: Object.freeze({
      count: 0,
      sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    }),
    triggers: Object.freeze({
      count: 0,
      sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    }),
  }),
});

const REVIEWED_ORPHAN_MESSAGES = Object.freeze([
  Object.freeze({
    id: 8,
    sha256: "32a286dc0240485c77fa983470ab368962bc6100fd26b2f53780f909fa21cb4f",
  }),
  Object.freeze({
    id: 9,
    sha256: "5e1eb02167fe0977558494ca17a2968ce934bf01ddc2d94b1e513bf187930c73",
  }),
  Object.freeze({
    id: 10,
    sha256: "6dbdf8d572bb710842d39f3e166b5335127f201da2cf5bbe7c7756329cb4f429",
  }),
  Object.freeze({
    id: 11,
    sha256: "2d9ecbd4966b1693b244306566759eda9dd784f0a37497108e92df43d23b4e5b",
  }),
]);

const EXPECTED_RECORDED_MIGRATIONS = Object.freeze([
  ["202607130001_add_user_token_version.sql", "e5aee8dc248a4964c74fc5d9ab2e0298aec8db0262eef9b32270568693111cc1"],
  ["202607130002_create_password_reset_tokens.sql", "55b87fc1f171a526a852dd6596b4ac6e03e6a0383ec96cbee2b21f61e41121ac"],
  ["202607140001_add_contractor_profile_details.sql", "08bca06f249b042eef8c342a79c8d51b27528daaa2b76c1e6f11f5b5d414e716"],
  ["202607140002_create_workflow_events.sql", "c67a83e775116a13c36ee2cf95cf66d3a43e069b03eb32b61aa15ca13bc3b7cb"],
  ["202607190001_add_user_profile_photo_details.sql", "3fa88d13d130efeb02e8ecf8d259e369056374e28d29b362aa4c760ed34344cd"],
  ["202607190002_add_post_request_photos.sql", "bacbb50f6f4127fe035b11a35face48b662669c0ce22909bedfd14a3e739bfa0"],
  ["202607200001_add_post_request_lifecycle.sql", "805381ae15c586de9a0795e27fde589f07ea74ab998694a74dfd1127386cd8cb"],
  ["202607200002_create_request_relationships.sql", "8b0ad74b021e7cf560ed1e7a88899013bf2c8363c07b45a49f2de631489acd54"],
  ["202607200003_create_conversations.sql", "5fa1e5a7d573c0ac62fbab255356435b1010f4c86458228c22fe9a7c23151556"],
  ["202607230001_create_emergency_requests.sql", "29fc9b8cbf68e63daf01f6103e42b982492add0ae4c745d3a643251d9a9eaf7b"],
  ["202607230002_add_emergency_relationship_source.sql", "d5ffe1e34b61087afb58905d116c7fe04ed1262b699905f081efc8abd3b5b7a0"],
  ["202607230003_create_emergency_safety_assessments.sql", "f02ddb70a1c50914fc0acaf2ffe5f4f434a4b8e1db910bea20b44e28d1706e23"],
  ["202607240001_add_single_active_emergency_relationship.sql", "5d824b8c31722dcd6a9debd49b28687f16b93b1efd4f71b65bb8eb89fff2fa80"],
  ["202607250001_add_emergency_dispatch_lifecycle.sql", "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462"],
].map(([filename, checksum]) => Object.freeze({ filename, checksum })));

const APPROVED_MIGRATIONS = Object.freeze([
  ["202608090001_create_legacy_orphan_message_archive.sql", "d14bf4ac64b6b0c59568f1af285d25655a53e526533784ffd3381739d02a078c"],
  ["202607210001_add_message_conversation_identity.sql", "885ec19aa0b2ff126c05e2d9c3a20c6110fce2c14dcb1949fb9cb6f9fc68f970"],
  ["202607210002_allow_dual_message_identity.sql", "0a7e18d4f4c709ba3caa8bf0f0430b1b8cce7ffebd109af582fc8d89c4b47d18"],
  ["202608010001_create_commercial_authority_foundation.sql", "620d3c6ad9053072be4b3b743017b3fe9b8e3b652f83044bb9d2b3e6d95e98a3"],
  ["202608010002_create_canonical_evaluations.sql", "85370e52cb777132a319c1acb1956d312e1315fe7d696223ace8dec7125c88a6"],
  ["202608030001_create_conversation_participant_state.sql", "12354e0c5256b3e90f8663995dd301441847d80fffc7016f6964020cc813e02a"],
  ["202608030002_create_canonical_alerts.sql", "9e65f4c49f6cd7d312a07ca3adcdf150c387d4827cd8dab70b05540e3d0e2131"],
  ["202608060001_create_professional_response_foundation.sql", "c024b48ff7eba181c482e423de5034b1ad51a2ed12d424f0913dc698ffa7361b"],
  ["202608060002_create_request_selection_authority.sql", "391adef70a63ca3786acbb17dab554640d3391dd4d6c5f293fbda703f33b2052"],
  ["202608070001_create_job_request_create_command_idempotency.sql", "78ce27f655ca9c4d354deaeeb64c44a2b58ef12af444f5e5c58a0c2042cab146"],
  ["202608070002_create_intelligence_operation_idempotency.sql", "0bfc57d8ceedd1434ef1250afcc73061cd2d408e3e31ac10c458bda1051335ef"],
  ["202608070003_add_job_request_service_location.sql", "9f7e3603b8e4d0837798807c37030fc342681a90050354443f157798c127fea1"],
].map(([filename, checksum]) => Object.freeze({ filename, checksum })));

module.exports = Object.freeze({
  APPROVED_MIGRATIONS,
  EXPECTED_RECORDED_MIGRATIONS,
  EXPECTED_TARGET,
  LOGICAL_BACKUP_CERTIFICATION,
  REVIEWED_ORPHAN_MESSAGES,
});

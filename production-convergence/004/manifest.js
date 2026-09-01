"use strict";

const CONVERGENCE_ID = "MC-PRODUCTION-CONVERGENCE-004";
const BASELINE_FILENAME = "202607050001_initial_schema_baseline.sql";
const EXECUTION_TARGET = "production-convergence-004";
const ADVISORY_LOCK_ID = 481005040;

const EXPECTED_PRODUCTION_TARGET = Object.freeze({
  projectId: "10d1facd-6aa6-4052-9897-803396f813c4",
  projectName: "profound-magic",
  environmentId: "3554dcb8-3f0a-4b8f-bbdf-162777ad87fa",
  environmentName: "production",
  databaseServiceId: "80a103f2-56b3-4b62-a261-51a19169de5b",
  databaseServiceName: "Postgres",
  backendServiceId: "831a310f-2cee-4c3c-8f36-52e78bbdb5bf",
  backendServiceName: "athletic-rebirth",
  databaseName: "railway",
});

const PRODUCTION_PRESTATE = Object.freeze({
  serverSha: "6e4d78ed0e3cfe0541ff686198299ec1d850cdf6",
  deploymentId: "3914f61b-831a-4a7a-9372-d388a52dbb0c",
  imageDigest: "sha256:9ccd24c79227dd0ec4a09ca9253e0cf097ddb9a9c95c84eb2a21b4a2eee3ba2d",
  postgresVersion: "18.6",
  auditSchemaFingerprint: "8d238df84a2cc3328e85227b65595efcd07a0788fc3010ee952272440658fd7b",
  ledgerRows: 26,
  canonicalRepositoryRows: 25,
  archiveRows: 4,
  catalog: Object.freeze({
    tables: Object.freeze({ count: 32, sha256: "83f5246fc960152aa686a74d5946f2f819c9a7f33f24d11687e57f3d6f276e5e" }),
    columns: Object.freeze({ count: 446, sha256: "e4c001f9ff70070e64ae91dfd296aad34950e34ba7560509a670aec6bf3726b6" }),
    constraints: Object.freeze({ count: 619, sha256: "689b1913fd752407f8b319d961ca4e3ff92c99bb09ab92c98178a44f234bf346" }),
    indexes: Object.freeze({ count: 124, sha256: "93a5351d1868e9e01805fcb44b1ef540f778fc1b5e26d93899d274f8134f776c" }),
    functions: Object.freeze({ count: 5, sha256: "a82d0b8388c6b2827c8d81c984196352cf92603a97924cff5fc71953fb7e8fa7" }),
    triggers: Object.freeze({ count: 11, sha256: "9605f6585776397d512149937fd1ef20583eb5140ef616a7728759f5b7fb6e34" }),
  }),
  preservation: Object.freeze({
    users: Object.freeze({ count: 13, identitySha256: "072efc4e2e3bd95de260f582c4e887fb0fb6b50671f8feecf44930b4ac74c39e" }),
    contractor_profiles: Object.freeze({ count: 6, identitySha256: "93c69ba5671e377916a7a5738e71afa07a65067fece97dc42372e610594669de", legacyRowSha256: "676d887f534b234c3f8dd64acdd30d33650c90f6571a3e9ec92f1fc3cc6870c0" }),
    contractor_projects: Object.freeze({ count: 4, identitySha256: "37db36876b9ccaaa88394679f019c3435af9320dea117e867003840317870e25", legacyRowSha256: "c0681ca23907e9da36b7c99a101f4e39b824b656553aa0f2d956292964d1c56b" }),
    posts: Object.freeze({ count: 43, identitySha256: "ca6051c9f9dc988b17715acc5047bb9afd80f9902b91060169ff27b958c17361", legacyRowSha256: "c0642ae1871e15d40d5ca84654605955167951bbe45d45c7482d6d2615bd85b0" }),
    quote_requests: Object.freeze({ count: 1, identitySha256: "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b" }),
    messages: Object.freeze({ count: 12, identitySha256: "26b8df63c052beec8ed7a49fa3d7467dc1fdb1a84e58a7746915862d43c3e7c1", legacyRowSha256: "9ac273ac20bd2ecb107af0ad26d5028a7ae230d3bbd4a6a3fad692d5373496c9" }),
    conversations: Object.freeze({ count: 1, identitySha256: "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b" }),
    request_relationships: Object.freeze({ count: 1, identitySha256: "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b" }),
    workflow_events: Object.freeze({ count: 0, identitySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }),
    conversation_participant_state: Object.freeze({ count: 2, identitySha256: "e8484c2db78fe11c40cf73eda138d9959f6b5a219afda480bb3b1401678a877c" }),
    legacy_orphan_message_archive: Object.freeze({ count: 4, identitySha256: "3aac03c4a05d9bb8b4775c3a306a445c0d8e316d966006b89f8d4ca43e3a44a8" }),
  }),
});

const CURRENT_PRODUCTION_LEDGER = Object.freeze([
  {
    "filename": "202607130001_add_user_token_version.sql",
    "checksum": "e5aee8dc248a4964c74fc5d9ab2e0298aec8db0262eef9b32270568693111cc1",
    "executionTarget": "production-emergency-additive"
  },
  {
    "filename": "202607130002_create_password_reset_tokens.sql",
    "checksum": "55b87fc1f171a526a852dd6596b4ac6e03e6a0383ec96cbee2b21f61e41121ac",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607140001_add_contractor_profile_details.sql",
    "checksum": "08bca06f249b042eef8c342a79c8d51b27528daaa2b76c1e6f11f5b5d414e716",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607140002_create_workflow_events.sql",
    "checksum": "c67a83e775116a13c36ee2cf95cf66d3a43e069b03eb32b61aa15ca13bc3b7cb",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607190001_add_user_profile_photo_details.sql",
    "checksum": "3fa88d13d130efeb02e8ecf8d259e369056374e28d29b362aa4c760ed34344cd",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607190002_add_post_request_photos.sql",
    "checksum": "bacbb50f6f4127fe035b11a35face48b662669c0ce22909bedfd14a3e739bfa0",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607200001_add_post_request_lifecycle.sql",
    "checksum": "805381ae15c586de9a0795e27fde589f07ea74ab998694a74dfd1127386cd8cb",
    "executionTarget": "production-governed-additive"
  },
  {
    "filename": "202607200002_create_request_relationships.sql",
    "checksum": "8b0ad74b021e7cf560ed1e7a88899013bf2c8363c07b45a49f2de631489acd54",
    "executionTarget": "production-governed-conversation-prerequisites"
  },
  {
    "filename": "202607200003_create_conversations.sql",
    "checksum": "5fa1e5a7d573c0ac62fbab255356435b1010f4c86458228c22fe9a7c23151556",
    "executionTarget": "production-governed-conversation-prerequisites"
  },
  {
    "filename": "202607210001_add_message_conversation_identity.sql",
    "checksum": "885ec19aa0b2ff126c05e2d9c3a20c6110fce2c14dcb1949fb9cb6f9fc68f970",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202607210002_allow_dual_message_identity.sql",
    "checksum": "0a7e18d4f4c709ba3caa8bf0f0430b1b8cce7ffebd109af582fc8d89c4b47d18",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202607230001_create_emergency_requests.sql",
    "checksum": "29fc9b8cbf68e63daf01f6103e42b982492add0ae4c745d3a643251d9a9eaf7b",
    "executionTarget": "production-governed-emergency"
  },
  {
    "filename": "202607230002_add_emergency_relationship_source.sql",
    "checksum": "d5ffe1e34b61087afb58905d116c7fe04ed1262b699905f081efc8abd3b5b7a0",
    "executionTarget": "production-governed-emergency"
  },
  {
    "filename": "202607230003_create_emergency_safety_assessments.sql",
    "checksum": "f02ddb70a1c50914fc0acaf2ffe5f4f434a4b8e1db910bea20b44e28d1706e23",
    "executionTarget": "production-governed-emergency"
  },
  {
    "filename": "202607240001_add_single_active_emergency_relationship.sql",
    "checksum": "5d824b8c31722dcd6a9debd49b28687f16b93b1efd4f71b65bb8eb89fff2fa80",
    "executionTarget": "production-governed-emergency"
  },
  {
    "filename": "202607250001_add_emergency_dispatch_lifecycle.sql",
    "checksum": "aa39d8311f8a73970e20069dad8fd1e4a4bfa0b65acc7e09cffaa0e33be21462",
    "executionTarget": "production-governed-emergency"
  },
  {
    "filename": "202608010001_create_commercial_authority_foundation.sql",
    "checksum": "620d3c6ad9053072be4b3b743017b3fe9b8e3b652f83044bb9d2b3e6d95e98a3",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608010002_create_canonical_evaluations.sql",
    "checksum": "85370e52cb777132a319c1acb1956d312e1315fe7d696223ace8dec7125c88a6",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608030001_create_conversation_participant_state.sql",
    "checksum": "12354e0c5256b3e90f8663995dd301441847d80fffc7016f6964020cc813e02a",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608030002_create_canonical_alerts.sql",
    "checksum": "9e65f4c49f6cd7d312a07ca3adcdf150c387d4827cd8dab70b05540e3d0e2131",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608060001_create_professional_response_foundation.sql",
    "checksum": "c024b48ff7eba181c482e423de5034b1ad51a2ed12d424f0913dc698ffa7361b",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608060002_create_request_selection_authority.sql",
    "checksum": "391adef70a63ca3786acbb17dab554640d3391dd4d6c5f293fbda703f33b2052",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608070001_create_job_request_create_command_idempotency.sql",
    "checksum": "78ce27f655ca9c4d354deaeeb64c44a2b58ef12af444f5e5c58a0c2042cab146",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608070002_create_intelligence_operation_idempotency.sql",
    "checksum": "0bfc57d8ceedd1434ef1250afcc73061cd2d408e3e31ac10c458bda1051335ef",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608070003_add_job_request_service_location.sql",
    "checksum": "9f7e3603b8e4d0837798807c37030fc342681a90050354443f157798c127fea1",
    "executionTarget": "production-governed-reconciliation-001"
  },
  {
    "filename": "202608090001_create_legacy_orphan_message_archive.sql",
    "checksum": "d14bf4ac64b6b0c59568f1af285d25655a53e526533784ffd3381739d02a078c",
    "executionTarget": "production-governed-reconciliation-001"
  }
].map(Object.freeze));
const TARGET_MIGRATIONS = Object.freeze([
  {
    "order": 1,
    "filename": "202608090001_create_job_lifecycle_concern_foundation.sql",
    "checksum": "e9cfdb8ea4034807da7ab8d7831b9776cd04d20b465055cda0c6ead6c7d0090f",
    "sourceCommit": "036dfb75b1f38d0996ac3fa94dae6dd3414abf94",
    "purpose": "create job lifecycle concern foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 2,
    "filename": "202608090002_create_job_participant_authority_foundation.sql",
    "checksum": "c596313f1419f8f4243f860c85a47d8fac7c43b47bc53edb295363044d7efe68",
    "sourceCommit": "036dfb75b1f38d0996ac3fa94dae6dd3414abf94",
    "purpose": "create job participant authority foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 3,
    "filename": "202608090003_create_ordinary_evaluation_finding_foundation.sql",
    "checksum": "ac3f650778b9043e67688b78073cad46dc33d7f32c36e8598efd3f1ac6de7272",
    "sourceCommit": "78babf18c3f050d0aa11a311174adcaaff07f640",
    "purpose": "create ordinary evaluation finding foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 4,
    "filename": "202608100001_create_workstream_activity_foundation.sql",
    "checksum": "87b35df892e7e91c0d7d5e33f99e74e0ccee5baaa51bf68754577c98940f3ace",
    "sourceCommit": "c832b66767f6a3dcc68d1386f6296501c17434fc",
    "purpose": "create workstream activity foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 5,
    "filename": "202608100002_create_recommendation_hierarchy_foundation.sql",
    "checksum": "4b982c1e830525d0d3c5b3a648b5747fcb482cd0eab4104caef691e8247a25ba",
    "sourceCommit": "4d7a14e3da34f2f303c94e3c44a5bfa9b0d59751",
    "purpose": "create recommendation hierarchy foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 6,
    "filename": "202608100003_create_canonical_quote_scope_foundation.sql",
    "checksum": "a2d65246914b02eb4b63b0be86ee68bb3a4bf1b4c5fd04f9153452b66a0147ea",
    "sourceCommit": "2c3a85c329436fbe0c67382d390ad221698c3f53",
    "purpose": "create canonical quote scope foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 7,
    "filename": "202608100004_create_quote_composition_feedback.sql",
    "checksum": "09622b5ea6c272aef5d9b064e20cbadd4838f47de2f5531336abd7de727f1588",
    "sourceCommit": "9d3e29cf03ccaa81eab9117251395102e0337354",
    "purpose": "create quote composition feedback",
    "dmlClass": "NONE"
  },
  {
    "order": 8,
    "filename": "202608110001_create_request_modification_authority_foundation.sql",
    "checksum": "7986f26f64394995ee93877b4d2509b8c917186637eb3c84386d0661e9381953",
    "sourceCommit": "7a5c304e07acd257c74c16425eeee79cb56162d2",
    "purpose": "create request modification authority foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 9,
    "filename": "202608120001_create_business_portfolio_authority_foundation.sql",
    "checksum": "a424ffe0a586a1e70772036691248cfd6d0feddd63b30333e399644314f66eac",
    "sourceCommit": "640c9a04f140ba622812b6f9f98de87ef8b8f2eb",
    "purpose": "create business portfolio authority foundation",
    "dmlClass": "LEGACY_STRUCTURAL_BACKFILL"
  },
  {
    "order": 10,
    "filename": "202608130001_create_canonical_visit_persistence_foundation.sql",
    "checksum": "63a4730e1049a04d9428aa82462dbb609183cdc9b86f1871a562db28a26e0d88",
    "sourceCommit": "644c88f56bff6d1cf6f757d172ec37dfd99dfef9",
    "purpose": "create canonical visit persistence foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 11,
    "filename": "202608130002_activate_evaluation_visit_authority.sql",
    "checksum": "212ff7aa7327ce6940bc3e521837f3620913835d1e34705878a91baeb539cb5e",
    "sourceCommit": "4b08b0c22c22d4fcd6e2723f271afe7a22e18789",
    "purpose": "activate evaluation visit authority",
    "dmlClass": "NONE"
  },
  {
    "order": 12,
    "filename": "202608130003_activate_approved_work_visit_authority.sql",
    "checksum": "138da5dfdb470dfcc33b374442b8eae12f70cf8a6f99f87cc9c533d5d3236436",
    "sourceCommit": "e0377f799ab0930ead0771e95faaaf180237c93f",
    "purpose": "activate approved work visit authority",
    "dmlClass": "NONE"
  },
  {
    "order": 13,
    "filename": "202608140001_create_canonical_quote_delivery_foundation.sql",
    "checksum": "07de8363533296f6363c7e52a63edd74b8c745506cfb65d380898338136b5969",
    "sourceCommit": "362d41ee5cc9f0df64c041592d79658db81b2df3",
    "purpose": "create canonical quote delivery foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 14,
    "filename": "202608150001_activate_customer_safe_efr.sql",
    "checksum": "d7f6a73abccb2160d5e5a9711dc688415e907392bfba33f3b1835d14e23a99a3",
    "sourceCommit": "9ce3f9d24e2dbca91aabaa5ab1bae4f30c0d919c",
    "purpose": "activate customer safe efr",
    "dmlClass": "NONE"
  },
  {
    "order": 15,
    "filename": "202608150002_activate_work_plan_execution.sql",
    "checksum": "56d4174d1a92e24da18945def79239ed5a80d2533311be8a761a0c2bf9f77bab",
    "sourceCommit": "3e97efef76c6990e8c3310a3bb694409177f2188",
    "purpose": "activate work plan execution",
    "dmlClass": "NONE"
  },
  {
    "order": 16,
    "filename": "202608150003_create_job_completion_history.sql",
    "checksum": "832b50694125c20a8a694fa37b8f6a6541db18e5c12ba282c29480eae1b666a4",
    "sourceCommit": "e4dcfb58ffc1ecc1373e561f0d87ce7bee3aaf0b",
    "purpose": "create job completion history",
    "dmlClass": "NONE"
  },
  {
    "order": 17,
    "filename": "202608150004_create_canonical_invoice_payment_foundation.sql",
    "checksum": "4c507ab33c26e8ae2274ae0d2534c062f3655ecc12f5f27e7ef3c07a212a6c7b",
    "sourceCommit": "33042e3fa3bc18c025fef93fc9702396ef9636ad",
    "purpose": "create canonical invoice payment foundation",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 18,
    "filename": "202608150005_create_ask_meetro_workflow_review.sql",
    "checksum": "2e5a8ee1adfee6893a431d0c24218b2db503f767c734d9d5e898a25aa84ae987",
    "sourceCommit": "ce876f158be21b6e1b48e24247e75a2d41d53e96",
    "purpose": "create ask meetro workflow review",
    "dmlClass": "NONE"
  },
  {
    "order": 19,
    "filename": "202608180001_expand_ask_meetro_workflow_review_operations.sql",
    "checksum": "1edfdb8cee4543df5cb8635a7d530bd79f763e4164b784553ae6a82076b98d29",
    "sourceCommit": "438612d1bbbf109ec9354d91dd54e014888db0af",
    "purpose": "expand ask meetro workflow review operations",
    "dmlClass": "NONE"
  },
  {
    "order": 20,
    "filename": "202608190001_create_quick_quote_analysis_session_foundation.sql",
    "checksum": "2fb082f6b0455d62794d19e69555685160e94336734ba871e1eb52ae69d5fec6",
    "sourceCommit": "c6501b92502ebe75719f62a93e352a42fed616f8",
    "purpose": "create quick quote analysis session foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 21,
    "filename": "202608190002_expand_ask_meetro_analysis_continuation_review.sql",
    "checksum": "df4db3a88f2ad0b8c469f9a28203a8af74acb59ca5d0db585897dc237a67d97b",
    "sourceCommit": "f0bcf8f9d401ee4e26d2279a33974835f45b3262",
    "purpose": "expand ask meetro analysis continuation review",
    "dmlClass": "NONE"
  },
  {
    "order": 22,
    "filename": "202608210001_create_business_document_working_drafts.sql",
    "checksum": "467f015617e7eb558faa8a663f2620a7dc1d6355d3fb435d689c04c6b471fbf7",
    "sourceCommit": "d339ac859f6d5c18908adae30400cc325fc587b2",
    "purpose": "create business document working drafts",
    "dmlClass": "NONE"
  },
  {
    "order": 23,
    "filename": "202608210002_create_business_document_delivery_foundation.sql",
    "checksum": "211859a3f0daca7a06d7d4efcc3a88fc48c2e30597b9a81044a6bbb834b14a2b",
    "sourceCommit": "62251f6e338fe9e338d80937b82f6be7b492c3ae",
    "purpose": "create business document delivery foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 24,
    "filename": "202608230001_add_business_document_numbers.sql",
    "checksum": "12e68c382a1d4fea90832bf9048ee2fdd4d3fcc3fa711c57730d65b36f4729ba",
    "sourceCommit": "fd7708af05694892b7747984b0a386b0faad3cb3",
    "purpose": "add business document numbers",
    "dmlClass": "NONE"
  },
  {
    "order": 25,
    "filename": "202608230002_add_canonical_quote_customer_terms_snapshot.sql",
    "checksum": "34c46aa18c9125ae492f918a905d546b4ccef268522336e84828833b2d24a6b6",
    "sourceCommit": "610ff138a5b61c59058f7e6a12c71f33097d75af",
    "purpose": "add canonical quote customer terms snapshot",
    "dmlClass": "NONE"
  },
  {
    "order": 26,
    "filename": "202608230003_create_canonical_quote_business_document_sources.sql",
    "checksum": "f329915c25d44680617d429a8710b15448183ac2ef95b02a09a19ebdc0dd84fc",
    "sourceCommit": "3959044544adb905fe8591b893f05d8952a0f728",
    "purpose": "create canonical quote business document sources",
    "dmlClass": "NONE"
  },
  {
    "order": 27,
    "filename": "202608230004_create_business_contact_foundation.sql",
    "checksum": "727eca6ffc534f5cd3940f4f5199f8967751546822e06dc371045734a4cb3a31",
    "sourceCommit": "6cac3f52fe3bf78d30fa2e0e87f2d2b9b4135bd9",
    "purpose": "create business contact foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 28,
    "filename": "202608230005_create_business_customer_relationship_foundation.sql",
    "checksum": "f8a2070204b0469cb75d2a37ed15058732de74bcc8ff9daa61d514ba7e4d8a69",
    "sourceCommit": "b3b6458322ed17742cf8c7996f9bfa8909ca25bb",
    "purpose": "create business customer relationship foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 29,
    "filename": "202608240001_create_customer_party_linkage_foundation.sql",
    "checksum": "0366575b67a20b4aea5a835e9fc5e0b42d9802091e35edcbbb38b3a61cdad13f",
    "sourceCommit": "adec5724e95185f200961f3bfb6ef0864826ec75",
    "purpose": "create customer party linkage foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 30,
    "filename": "202608250001_correct_evaluation_visit_authority_and_negotiation.sql",
    "checksum": "22329b57c68a1eb54141a68b9662bb7b840c6ef0cba0d649ef6991ff502205f8",
    "sourceCommit": "73b0ece56328a570b1eef6cd6e31da1a19fa67db",
    "purpose": "correct evaluation visit authority and negotiation",
    "dmlClass": "NONE"
  },
  {
    "order": 31,
    "filename": "202608260001_create_evaluation_remote_provenance.sql",
    "checksum": "2e0a9de0120bda1ad6426c9fcd12f9783338d8c4e058de20bfd916634ef73363",
    "sourceCommit": "4fd9a52c28da767034f386661d16b1c8e6bf5fc9",
    "purpose": "create evaluation remote provenance",
    "dmlClass": "LEGACY_STRUCTURAL_BACKFILL"
  },
  {
    "order": 32,
    "filename": "202608270001_add_canonical_visit_start_authority.sql",
    "checksum": "29252b472cb0114d7df1049546e4e985602296b64a19e2ce37d522dc4e0c5c2b",
    "sourceCommit": "8bbdf9ea026f639c8fe9d7449560abc53b8cbe1c",
    "purpose": "add canonical visit start authority",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 33,
    "filename": "202608280001_create_pre_work_deposit_payment_authority.sql",
    "checksum": "4f056b6cd009b7e2fa4b1f904e5558dbbb4779e599e3358f22ca262f7d5093a8",
    "sourceCommit": "0d70a1eeba7a95d1e9a3138fff04232861c97a4f",
    "purpose": "create pre work deposit payment authority",
    "dmlClass": "NONE"
  },
  {
    "order": 34,
    "filename": "202608280002_create_canonical_materials_work_preparation_authority.sql",
    "checksum": "6ad53d9af8400617d5ff3d8cbdf18a407b21931107542d4a72784e7793331f27",
    "sourceCommit": "9d56b55c83d11a329b2e0d0c5ebc86975b5f732c",
    "purpose": "create canonical materials work preparation authority",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 35,
    "filename": "202608280003_create_canonical_approved_work_execution_authority.sql",
    "checksum": "dc2d6d7e76b2742447094517908073b7e9b10d567f6982292046d843d8ddf0e6",
    "sourceCommit": "9d56b55c83d11a329b2e0d0c5ebc86975b5f732c",
    "purpose": "create canonical approved work execution authority",
    "dmlClass": "STATIC_GOVERNED_CAPABILITY_CONFIGURATION_SEED"
  },
  {
    "order": 36,
    "filename": "202608290001_add_invoice_line_source_authority.sql",
    "checksum": "5287a8f9d73e066d18430f18fb9e96447987eb22142f2349ec60d026d9453a94",
    "sourceCommit": "f48faa1f0125887515fa22bb5aa63cd2f16ba721",
    "purpose": "add invoice line source authority",
    "dmlClass": "LEGACY_STRUCTURAL_BACKFILL"
  },
  {
    "order": 37,
    "filename": "202608290002_add_deposit_request_document_authority.sql",
    "checksum": "0bd7eca425534cdd72465349c2784d94d6b152b6b4e5263cef2ccbc7285a776c",
    "sourceCommit": "9cc2c6388b8215dccedf1734488b731faab481d6",
    "purpose": "add deposit request document authority",
    "dmlClass": "NONE"
  },
  {
    "order": 38,
    "filename": "202608290003_add_canonical_alert_event_identity.sql",
    "checksum": "237d49e77ca03c38eff026f5fec88444c3d32c2f2cba718b810ba38dce870bb0",
    "sourceCommit": "b4e931a7b7e85a0770ef69ee4478b3e4ef5fd902",
    "purpose": "add canonical alert event identity",
    "dmlClass": "NONE"
  },
  {
    "order": 39,
    "filename": "202608300001_create_professional_subscription_foundation.sql",
    "checksum": "f8f29408402b67c0bf466c38ac9fc8c5281f592104343bbe3c8c55aebde76b6e",
    "sourceCommit": "50c8c910298d83ff629b402ff3d738fcc2697730",
    "purpose": "create professional subscription foundation",
    "dmlClass": "NONE"
  },
  {
    "order": 40,
    "filename": "202608300002_add_stripe_subscription_authority.sql",
    "checksum": "aca3c69899c5171ecbb7b0e9c18aa43149bc2517ecb412265ffe657dbeaffa88",
    "sourceCommit": "affbe0bb9ec048ac7ba0ba69d6ca8061b44b96be",
    "purpose": "add stripe subscription authority",
    "dmlClass": "NONE"
  },
  {
    "order": 41,
    "filename": "202608300003_add_professional_subscription_plan.sql",
    "checksum": "1cdeb5376517f432fc8e96c74d8e687ebc2d8a9d9b87450f80614cca1b9e61ca",
    "sourceCommit": "e359ad3411ea564a5f8b65b07a94996c72dc57e0",
    "purpose": "add professional subscription plan",
    "dmlClass": "NONE"
  },
  {
    "order": 42,
    "filename": "202608300004_create_meetro_business_trial_authority.sql",
    "checksum": "57131db362f3acce80046cf12746abb3eed1d3343ad4cd4d5d0106cf1aff7652",
    "sourceCommit": "49fcd39280001ea46158cd9c30e66f711c3bf2e3",
    "purpose": "create meetro business trial authority",
    "dmlClass": "NONE"
  },
  {
    "order": 43,
    "filename": "202608300005_create_business_team_membership_authority.sql",
    "checksum": "a851a467a1b1aee0b92ac0cc2667383bcf22b296df0f51588e225d5f748d8e3e",
    "sourceCommit": "77905560fda6b79f87f9d959cba7bf9c5eefd4e5",
    "purpose": "create business team membership authority",
    "dmlClass": "BUSINESS_AUTHORITY_CREATION"
  },
  {
    "order": 44,
    "filename": "202608300006_create_business_job_assignment_authority.sql",
    "checksum": "f96358a1f040bd9d05e5e3b1012ed1f06d94b76575f95d7b612ccf5583a5fceb",
    "sourceCommit": "5ee7517bbba7a68007f90c78680718200f20b06a",
    "purpose": "create business job assignment authority",
    "dmlClass": "NONE"
  },
  {
    "order": 45,
    "filename": "202608300007_create_business_job_field_operations_authority.sql",
    "checksum": "51869d1ede51a7481b085ae21c2b5855d73e5f677399380ef97909ec3fd05e21",
    "sourceCommit": "db854b5e6defc07dd4ed2ec1a0c2709e5f6f1ed1",
    "purpose": "create business job field operations authority",
    "dmlClass": "NONE"
  },
  {
    "order": 46,
    "filename": "202608300008_create_business_time_evidence_authority.sql",
    "checksum": "221e30dd89fd080e13775722a0c264e555c91f602aed4905f6ad051861ec844d",
    "sourceCommit": "a0dc5a98e1d6198327f6b25a3b42732ee300b50e",
    "purpose": "create business time evidence authority",
    "dmlClass": "NONE"
  },
  {
    "order": 47,
    "filename": "202608300009_add_business_time_settings_authority.sql",
    "checksum": "42c75e15327feb208bd7c9080eae46b78a197bdea859cfd9f1342f56ca6ee480",
    "sourceCommit": "13606d230265532d0d2f3110a592bcc5b3cd5712",
    "purpose": "add business time settings authority",
    "dmlClass": "NONE"
  },
  {
    "order": 48,
    "filename": "202608300010_allow_pending_team_invitation_token_rotation.sql",
    "checksum": "3b732b1f3433f520d4a630f2e4c13c9c2911f723f9386f02adbbce430fb59a37",
    "sourceCommit": "585a5747d13b157d0aa238e3f05408b5c81ee2da",
    "purpose": "allow pending team invitation token rotation",
    "dmlClass": "NONE"
  },
  {
    "order": 49,
    "filename": "202608310001_create_business_job_customer_message_authority.sql",
    "checksum": "ae8aefbb4205d489d56fa9695025adcb95fc9da855a9c2847854a60772457cb2",
    "sourceCommit": "79883a76cf4c8b287cc2d73fdb39a48a1b48515d",
    "purpose": "create business job customer message authority",
    "dmlClass": "NONE"
  }
].map(Object.freeze));
const ARCHIVE_MIGRATION = CURRENT_PRODUCTION_LEDGER.find(({ filename }) =>
  filename === "202608090001_create_legacy_orphan_message_archive.sql"
);

module.exports = Object.freeze({
  ADVISORY_LOCK_ID,
  ARCHIVE_MIGRATION,
  BASELINE_FILENAME,
  CONVERGENCE_ID,
  CURRENT_PRODUCTION_LEDGER,
  EXECUTION_TARGET,
  EXPECTED_PRODUCTION_TARGET,
  PRODUCTION_PRESTATE,
  TARGET_MIGRATIONS,
});

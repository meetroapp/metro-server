# Universal Ask Meetro retrieval V1

## Pre-implementation audit

Parent: `82bb0cc303fb9762eab0d80d0507314a2418994b`. Before work, live staging `/health` reported `environment: staging` and `commit` equal to this parent. `git ls-remote` independently returned the same `origin/staging` SHA. Work is isolated in `/private/tmp/meetro-universal-retrieval-server-82bb0cc`.

| Area | Existing source and authority | Reuse / gap |
| --- | --- | --- |
| Endpoint/auth | `server/intelligence/intelligenceRoutes.js`, `resolveIntelligenceAuthenticatedActor`, `executeIntelligenceGateway` | Keep authenticated `/api/companion/ask`, role resolution and capability checks. |
| Registry/provider | `intelligenceOperationRegistry.js`, `operations/companionConverse.js`, `intelligenceOrchestrator.js`, `openAiWorkflowProvider.js` | Keep seven operations and `workflow_assistance`. Add no endpoint or operation. |
| Exact reads | `conversationContext.js:loadConversationContext` | Reuse exact readers and bounded field projection. |
| Jobs | `liveJobProjectionService.js:getCanonicalLiveJob`; `customerJobQuotesService.js:getCustomerJobQuotes` | Professional current grants/roles and homeowner-specific read remain final authority. Job picker excludes completed Jobs and requires Quote-writing grants, so it is unsuitable as universal discovery. Add bounded candidate-ID selection scoped by existing participants/ownership, then exact reauthorization before disclosure. |
| Schedule | `professionalScheduleService.js:getProfessionalSchedule`; `visitService.js:listVisits/getVisit` | Existing canonical schedule states and visit authorization. Reuse Visit timezone validation and local-date helper; never assume UTC for an unknown local timezone. |
| Quotes | `professionalQuotesService.js:getProfessionalQuotes`; `quoteDraftService.js:getDraftQuote/getCustomerIssuedQuote` | Professional list has capability filtering; exact reader remains final authority. |
| Invoices | `invoicePaymentService.js:getProfessionalInvoiceWorkspace/getProfessionalInvoice/getCustomerInvoice/getCustomerJobInvoice` | Read existing canonical total, paid, balance, issuance. Working documents are not issued invoices/payment evidence. |
| Deposits | `preWorkDepositService.js:getProfessionalDepositStatus`; canonical live Job deposit projection | Read derived canonical obligations/payment allocations only. Never materialize an obligation during retrieval. |
| Relationships | `businessCustomerRelationshipService.js:listBusinessCustomerRelationships/getBusinessCustomerRelationship/getBusinessCustomerRelationshipActivity` | List requires owner-verified contractor profile; exact read checks ownership. Homeowners excluded. |
| Job Requests | `index.js:buildUserPostsQuery`, `conversationContext.js` owned request read | Existing list is unbounded; bounded candidate query must retain `posts.user_id = actor.id`. Discovery opportunities do not grant private request access. |
| Evaluations/Visits | `evaluationService.js:listEvaluationsForJob/getEvaluation`; `visitService.js:listVisits/getVisit` | Discover only through authorized Jobs, then exact reader. |
| Conversations | `conversationService.js:listHomeownerConversations/listProfessionalConversations/getConversation` | Existing lists are unbounded. Bound participant-scoped candidate selection; exact participant check before message read. Do not include Team communication. |
| Property | `portfolio/businessPortfolioAuthorityService.js` and migrations | `contractor_projects` are portfolio publications; no canonical authorized Property model found. Property deferred; no invented PROPERTY type. |
| Matching | Existing document listing search; no general authorized name resolver | Add bounded deterministic name/title matching. No provider-generated queries or fuzzy single-match authority. |
| Continuation/idempotency | `intelligenceOperationIdempotencyRepository.js`, `intelligenceOperationIdempotencyService.js` | Existing actor-scoped durable UUID operation/result ledger. Reuse completed result IDs plus bounded selection indexes, actor/role verification, expiry and exact reader reauthorization. No new storage/migration or signing secret. |

## Implemented contract

Retrieval is opt-in with `context.retrieval = {version: 1}`. An optional `continuation` identifies a completed prior operation and optional bounded choice index. Existing `{}` / `{record}` requests keep the original strict four-field response contract, so frozen client `e76a44b` is unchanged.

V1 retains the four conversational authority fields and adds server-owned resolution metadata. Metadata is never accepted from the provider. Deterministic facts and clarification bypass the provider; reasoning uses bounded authorized context. Operational text may resolve a target and require existing governed Review, but retrieval produces no executable patch and applies nothing. The next client must consume the resolved target and enter the existing operation-specific reviewer.

Exact deictic context wins. An explicitly different named entity triggers scoped discovery; an unavailable supplied exact context is never silently ignored. Continuations retain only bounded result identities and must reauthorize on every reuse. Provider history alone never selects authority.

No migration, dependency, credential, production configuration, endpoint, client change, or deployment is planned.


## Certification evidence

Implementation is complete in the isolated server candidate based on
`82bb0cc303fb9762eab0d80d0507314a2418994b`.

Certified behavior:

- Universal Retrieval remains inside authenticated `POST /api/companion/ask`.
- No second assistant endpoint or new Companion operation was added.
- Exact current-record context remains supported and takes precedence for deictic requests.
- Context-free `companion.converse` remains supported.
- Actor-scoped discovery supports Job, Job Request, Quote, Invoice, Evaluation,
  Customer Relationship, and Conversation records through bounded candidate
  discovery followed by existing exact authorization readers.
- Property remains deferred because no canonical governed Property entity and
  authorization reader exist. Portfolio records are not treated as Property authority.
- Deterministic schedule, Job status, Quote approval, Invoice/payment, and Deposit
  facts may bypass provider execution when canonical Meetro truth is sufficient.
- Provider-backed reasoning occurs only after server-owned resolution and bounded
  exact authorization.
- Ambiguous matches return bounded clarification and never silently establish authority.
- Continuation reuses the existing Intelligence result ledger, is actor/role bound,
  expires after 15 minutes, and reauthorizes records on every reuse.
- Operational requests may resolve an exact target but Universal Retrieval creates
  no executable patch and performs no canonical mutation.
- Existing governed Review -> Confirm & Apply authority remains required.
- Business-origin Jobs retain their canonical Professional participant and
  participant.read authority without fabricating a marketplace customer participant.
- Private Team communication is not a Universal Retrieval discovery source.
- Unauthorized and nonexistent lookups remain privacy-safe.

Certification:

- Universal Retrieval focused suite: 72 passed, 0 failed.
- Combined Companion + Universal Retrieval focused gate: 144 passed, 0 failed.
- Canonical npm test: 2,365 passed, 69 skipped, 0 failed.
- Prior canonical benchmark: 2,293 passed, 69 skipped.
- Exact increase: 72 Universal Retrieval tests.
- Candidate JavaScript syntax checks: PASS.
- git diff --check: PASS.
- Static audit: no mutation SQL.
- Static audit: no new routes/endpoints.
- Direct-write scan found only explanatory Review / Confirm & Apply text, not an executable write helper.
- No migration.
- No dependency or package-lock change.
- No production configuration change.
- No credential or secret change.
- Property support remains explicitly deferred.
- Client candidate `e76a44b142779308073b85f666f313f1d0ffa013` remained untouched.

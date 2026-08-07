"use strict";

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createIntelligenceOperationRepositoryFake() {
  const records = new Map();
  const calls = [];
  const keyFor = ({ actorUserId, authorityScope, operation, idempotencyKey }) =>
    [actorUserId, authorityScope, operation, idempotencyKey].join("|");
  const findById = (operationId) =>
    [...records.values()].find(({ id }) => id === operationId);

  return {
    calls,
    records,
    async reserveIntelligenceOperation(input) {
      calls.push({ name: "reserve", input: clone(input) });
      const key = keyFor(input);
      const existing = records.get(key);
      if (existing) return { created: false, record: clone(existing) };

      const record = {
        id: input.operationId,
        actor_user_id: input.actorUserId,
        authority_scope: input.authorityScope,
        operation: input.operation,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: input.requestFingerprint,
        status: "executing",
        provider_execution_state: "started",
        result_classification: null,
        result_payload: null,
        error_classification: null,
        usage_state: "pending",
        usage_classification: null,
        correlation_id: input.correlationId,
      };
      records.set(key, record);
      return { created: true, record: clone(record) };
    },
    async recordProviderSuccess(input) {
      calls.push({ name: "provider_success", input: clone(input) });
      const record = findById(input.operationId);
      record.provider_execution_state = "succeeded";
      record.result_classification = input.resultClassification;
      record.result_payload = clone(input.resultPayload);
      return clone(record);
    },
    async claimUsageFinalization(input) {
      calls.push({ name: "usage_claim", input: clone(input) });
      const record = findById(input.operationId);
      record.usage_state = "finalizing";
      return clone(record);
    },
    async completeIntelligenceOperation(input) {
      calls.push({ name: "complete", input: clone(input) });
      const record = findById(input.operationId);
      if (record.usage_state !== input.expectedUsageState) {
        throw new Error("Unexpected usage ownership state.");
      }
      record.status = "completed";
      record.usage_state = input.usageState;
      record.usage_classification = input.usageClassification;
      record.completed_at = new Date().toISOString();
      return clone(record);
    },
    async failIntelligenceOperation(input) {
      calls.push({ name: "fail", input: clone(input) });
      const record = findById(input.operationId);
      if (!record || record.status !== "executing") return null;
      record.status = "failed";
      record.provider_execution_state = input.providerExecutionState;
      record.usage_state = input.usageState;
      record.error_classification = input.errorClassification;
      if (input.resultPayload) {
        record.result_classification = input.resultClassification;
        record.result_payload = clone(input.resultPayload);
      }
      return clone(record);
    },
  };
}

module.exports = {
  createIntelligenceOperationRepositoryFake,
};

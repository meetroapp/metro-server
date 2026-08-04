"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeSafePayload,
} = require("../server/alerts/alertPayload");

function invalid(value) {
  return normalizeSafePayload(value).error?.code === "INVALID_ALERT_PAYLOAD";
}

function payloadWithSerializedBytes(targetBytes) {
  const payload = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`k${index}`, ""])
  );
  let remaining = targetBytes - Buffer.byteLength(JSON.stringify(payload), "utf8");
  for (const key of Object.keys(payload)) {
    const unicodeCharacters = Math.min(160, Math.floor(remaining / 2));
    payload[key] = "é".repeat(unicodeCharacters);
    remaining -= unicodeCharacters * 2;
  }
  if (remaining === 1) {
    const key = Object.keys(payload).find((candidate) => payload[candidate].length < 160);
    payload[key] += "x";
    remaining -= 1;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(payload), "utf8"), targetBytes);
  return payload;
}

test("safe alert payload accepts empty and bounded plain-data objects", () => {
  assert.deepEqual(normalizeSafePayload().value, {});
  assert.deepEqual(normalizeSafePayload({}).value, {});
  assert.deepEqual(
    normalizeSafePayload({
      count: 2,
      urgent: true,
      shortPreview: "New response",
      empty: null,
      nested: { stage: "accepted" },
    }).value,
    {
      count: 2,
      urgent: true,
      shortPreview: "New response",
      empty: null,
      nested: { stage: "accepted" },
    }
  );
});

test("safe alert payload rejects every supplied non-object root", () => {
  class CustomPayload {}
  const customPrototype = Object.create({ inherited: true });
  for (const value of [
    null,
    false,
    0,
    "",
    "text",
    [],
    () => {},
    BigInt(1),
    new Date(),
    Buffer.from("x"),
    new Map(),
    new Set(),
    new Uint8Array([1]),
    customPrototype,
    new CustomPayload(),
  ]) {
    assert.equal(invalid(value), true);
  }
});

test("safe alert payload enforces one global recursive 20-key limit", () => {
  const twenty = {
    first: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`a${index}`, index])),
    second: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`b${index}`, index])),
  };
  const twentyOne = structuredClone(twenty);
  twentyOne.second.b9 = 9;

  assert.equal(normalizeSafePayload(twenty).error, undefined);
  assert.equal(invalid(twentyOne), true);
});

test("safe alert payload enforces depth, string, and exact UTF-8 byte limits", () => {
  assert.equal(invalid({ label: "x".repeat(161) }), true);
  assert.equal(invalid({ a: { b: { c: { d: "too deep" } } } }), true);
  assert.equal(normalizeSafePayload(payloadWithSerializedBytes(4096)).error, undefined);
  assert.equal(invalid(payloadWithSerializedBytes(4097)), true);
});

test("safe alert payload rejects accessors and coercion hooks without executing them", () => {
  let executions = 0;
  const getter = {};
  Object.defineProperty(getter, "label", {
    enumerable: true,
    get() {
      executions += 1;
      return "unsafe";
    },
  });
  const setter = {};
  Object.defineProperty(setter, "label", {
    enumerable: true,
    set() {
      executions += 1;
    },
  });
  const toJson = {
    toJSON() {
      executions += 1;
      return {};
    },
  };
  const hiddenToJson = {};
  Object.defineProperty(hiddenToJson, "toJSON", {
    value() {
      executions += 1;
      return {};
    },
  });
  const toStringOverride = {
    toString() {
      executions += 1;
      return "unsafe";
    },
  };
  const valueOfOverride = {
    valueOf() {
      executions += 1;
      return 1;
    },
  };
  const proxied = new Proxy({}, {
    getPrototypeOf() {
      executions += 1;
      return Object.prototype;
    },
    ownKeys() {
      executions += 1;
      return [];
    },
  });

  for (const value of [
    getter,
    setter,
    toJson,
    hiddenToJson,
    toStringOverride,
    valueOfOverride,
    proxied,
  ]) {
    assert.equal(invalid(value), true);
  }
  assert.equal(executions, 0);
});

test("safe alert payload rejects circular, unsafe numeric, and non-JSON values", () => {
  const circular = {};
  circular.self = circular;
  for (const value of [
    circular,
    { items: [] },
    { amount: Number.NaN },
    { amount: Infinity },
    { createdAt: new Date() },
    { fn() {} },
    { big: BigInt(1) },
    { symbol: Symbol("x") },
  ]) {
    assert.equal(invalid(value), true);
  }
});

test("safe alert payload rejects message content and sensitive keys consistently", () => {
  for (const key of [
    "message",
    "messageText",
    "MESSAGE-TEXT",
    "message_body",
    "body",
    "content",
    "raw-content",
    "fullMessage",
    "text_content",
    "html",
    "markup",
    "accessNotes",
    "email",
    "token",
    "mediaUrl",
  ]) {
    assert.equal(invalid({ [key]: "private" }), true);
  }
  assert.deepEqual(normalizeSafePayload({ shortPreview: "Arriving soon" }).value, {
    shortPreview: "Arriving soon",
  });
});

test("safe alert payload rejects URL, HTML, and prototype pollution input", () => {
  for (const value of [
    { label: "<strong>unsafe</strong>" },
    { link: "https://example.test" },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { constructor: "unsafe" },
  ]) {
    assert.equal(invalid(value), true);
  }
  assert.equal({}.polluted, undefined);
});

test("safe alert payload does not mutate input and emits a safe prototype", () => {
  const input = { label: "  Safe label  ", nested: { stage: " active " } };
  const copy = structuredClone(input);
  const result = normalizeSafePayload(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(result.value, {
    label: "Safe label",
    nested: { stage: "active" },
  });
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.value.nested), Object.prototype);
});

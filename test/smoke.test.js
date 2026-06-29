"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

test("node:test executes assertions successfully", () => {
  assert.equal(2 + 2, 4);
});

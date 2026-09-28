"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", file), "utf8");
}

test("completed Emergency remains in professional discovery until canonical Invoice is PAID", () => {
  const picker = source("server/workflow/professionalJobPickerService.js");
  assert.match(picker, /emergency_jobs\.completion_id IS NOT NULL/);
  assert.match(picker, /emergency_jobs\.emergency_status = 'completed'/);
  assert.match(picker, /FROM canonical_invoices invoices/);
  assert.match(picker, /current_invoice\.status = 'PAID'/);
});

test("customer has canonical completed-Job History list route", () => {
  const service = source("server/workflow/jobCompletionService.js");
  const routes = source("server/workflow/jobCompletions.js");
  assert.match(service, /async function listCustomerJobHistory/);
  assert.match(service, /relationships\.homeowner_id = \$1/);
  assert.match(service, /emergency_history\.homeowner_id = \$1/);
  assert.match(service, /enrichEmergencyHistory\([\s\S]*"customer"/);
  assert.match(routes, /app\.get\("\/customer\/jobs\/history"/);
});

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function listJsFiles(directory) {
  return fs
    .readdirSync(path.join(root, directory))
    .filter((filename) => filename.endsWith(".js"))
    .map((filename) => path.join(directory, filename));
}

function listJsFilesRecursively(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listJsFilesRecursively(relativePath);
      return entry.isFile() && entry.name.endsWith(".js") ? [relativePath] : [];
    });
}

test("004C registers only the five approved recipient alert routes", () => {
  const index = read("index.js");
  const routes = read("server/alerts/alerts.js");
  assert.match(index, /require\("\.\/server\/alerts\/alerts"\)/);
  assert.match(index, /registerAlertRoutes\(\{/);

  const registrations = [...routes.matchAll(
    /app\.(get|post)\("([^"\n]+)"/g
  )].map((match) => [match[1], match[2]]);
  assert.deepEqual(registrations, [
    ["get", "/alerts"],
    ["get", "/alerts/counts"],
    ["post", "/alerts/read-all"],
    ["post", "/alerts/:alertId/read"],
    ["post", "/alerts/:alertId/dismiss"],
  ]);
  assert.doesNotMatch(routes, /app\.(?:post|put|patch|delete)\("\/alerts"/);
  assert.doesNotMatch(routes, /\/resolve|\/expire|\/archive/);
  assert.doesNotMatch(routes, /createAlert\(/);

  for (const relativePath of listJsFiles("server/alerts")) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /express\.Router|router\.(?:get|post|patch|delete)/i);
    assert.doesNotMatch(source, /localStorage|sessionStorage|Notification API|navigator\.serviceWorker/i);
    assert.doesNotMatch(source, /push_token|APNs|FCM|createEmail|sendEmail|sendSms|badge|device token/i);
  }
});

test("004D permits only the canonical communication producer and resolver", () => {
  const producerCandidates = [
    "server/emergency/emergencyDispatchService.js",
    "server/emergency/emergencyOpportunityService.js",
    "server/emergency/emergencyRequestService.js",
    "server/emergency/emergencySelectionService.js",
    "server/relationships/requestRelationshipService.js",
    "server/authorization/evaluationService.js",
    "server/authorization/commercialAuthorityService.js",
  ];

  for (const relativePath of producerCandidates) {
    const source = read(relativePath);
    assert.doesNotMatch(
      source,
      /require\(["']\.\.\/alerts|createAlert|resolveAlertsBySource|markAlertRead|dismissAlert/
    );
  }

  const messageSource = read(
    "server/conversations/conversationMessageService.js"
  );
  const participantSource = read(
    "server/conversations/conversationParticipantStateService.js"
  );
  assert.match(messageSource, /createOrRefreshCommunicationMessageAlert/);
  assert.match(messageSource, /getCommunicationAttentionWindowWithClient/);
  assert.match(participantSource, /resolveCommunicationMessageAlerts/);

  const approved = new Set([
    "server/conversations/conversationMessageService.js",
    "server/conversations/conversationParticipantStateService.js",
  ]);
  for (const relativePath of listJsFilesRecursively("server")
    .filter((item) => !item.startsWith("server/alerts/"))) {
    const source = read(relativePath);
    if (approved.has(relativePath)) continue;
    assert.doesNotMatch(
      source,
      /require\(["'][^"']*\/alerts\/|createAlert\(|resolveAlertsBySource\(|createOrRefreshCommunicationMessageAlert|resolveCommunicationMessageAlerts/
    );
  }
});

test("004D keeps generic alerts, workflow, and communication policy bounded", () => {
  const genericAlertSources = listJsFiles("server/alerts")
    .filter((relativePath) =>
      !relativePath.endsWith("communicationAlertService.js")
    )
    .map((relativePath) => read(relativePath))
    .join("\n");
  assert.doesNotMatch(genericAlertSources, /workflow_events/i);
  assert.doesNotMatch(
    genericAlertSources,
    /conversation_participant_state/i
  );

  const communication = read(
    "server/alerts/communicationAlertService.js"
  );
  assert.match(communication, /conversation_participant_state/);
  assert.doesNotMatch(
    communication,
    /emergency_requests|workflow_events|request_relationships|evaluations|commercial/i
  );
});

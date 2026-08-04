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

test("004B registers no public alert routes or frontend notification authority", () => {
  const index = read("index.js");
  assert.doesNotMatch(index, /server\/alerts|\/alerts|GET \/alerts|POST \/alerts/i);

  for (const relativePath of listJsFiles("server/alerts")) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /express\.Router|router\.(?:get|post|patch|delete)/i);
    assert.doesNotMatch(source, /localStorage|sessionStorage|Notification API|navigator\.serviceWorker/i);
    assert.doesNotMatch(source, /push_token|APNs|FCM|createEmail|sendEmail|sendSms|badge|device token/i);
  }
});

test("004B does not wire alert producers into existing domains", () => {
  const producerCandidates = [
    "server/conversations/conversationMessageService.js",
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


  const allNonAlertServerSources = listJsFilesRecursively("server")
    .filter((relativePath) => !relativePath.startsWith("server/alerts/"))
    .map((relativePath) => read(relativePath))
    .join("\n");
  assert.doesNotMatch(
    allNonAlertServerSources,
    /require\(["'][^"']*\/alerts\/|createAlert\(|resolveAlertsBySource\(|expireAlert\(|archiveAlert\(/
  );
});

test("004B keeps workflow events and 004A participant read state separate", () => {
  const alertSources = listJsFiles("server/alerts")
    .map((relativePath) => read(relativePath))
    .join("\n");
  assert.doesNotMatch(alertSources, /workflow_events/i);
  assert.doesNotMatch(alertSources, /conversation_participant_state/i);
});

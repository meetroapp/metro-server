"use strict";

const fs = require("node:fs");
const path = require("node:path");

const contextRoot = path.resolve(process.argv[2] || process.cwd());
const requiredFiles = [
  ".dockerignore",
  "Dockerfile",
  "index.js",
  "package-lock.json",
  "package.json",
];
const forbiddenPatterns = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)\.codex(?:\/|$)/,
  /(^|\/)\.agents?(?:\/|$)/,
  /(^|\/)node_modules(?:\/|$)/,
  /(^|\/)(?:MeetroBackups|backups?)(?:\/|$)/i,
  /\.dump$/i,
  /(?:^|\/)(?:tmp|temp)(?:\/|$)/i,
];
const allowedTopLevel = new Set([
  ".dockerignore",
  "Dockerfile",
  "index.js",
  "package-lock.json",
  "package.json",
  "server",
]);
const secretPatterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bpostgres(?:ql)?:\/\/[^\s/:]+:[^\s/@]+@/i,
];

function fail(message) {
  console.error(`DOCKER_CONTEXT_REJECTED: ${message}`);
  process.exit(1);
}

for (const relativePath of requiredFiles) {
  if (!fs.statSync(path.join(contextRoot, relativePath), { throwIfNoEntry: false })?.isFile()) {
    fail(`missing required file ${relativePath}`);
  }
}

const dockerignore = fs.readFileSync(path.join(contextRoot, ".dockerignore"), "utf8");
const expectedDockerignore = [
  "**",
  "!Dockerfile",
  "!.dockerignore",
  "!index.js",
  "!package.json",
  "!package-lock.json",
  "!server/",
  "!server/**",
  "",
].join("\n");
if (dockerignore !== expectedDockerignore) {
  fail(".dockerignore must remain the reviewed allowlist");
}

const includedFiles = [];
function inspectIncludedPath(absolutePath, relativePath) {
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    fail(`symbolic link is not allowed: ${relativePath}`);
  }
  if (forbiddenPatterns.some((pattern) => pattern.test(relativePath))) {
    fail(`forbidden included path ${relativePath}`);
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolutePath)) {
      inspectIncludedPath(path.join(absolutePath, child), path.join(relativePath, child));
    }
    return;
  }
  if (!stat.isFile()) {
    fail(`non-regular included path ${relativePath}`);
  }
  const contents = fs.readFileSync(absolutePath, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(contents))) {
    fail(`credential-like material found in ${relativePath}`);
  }
  includedFiles.push(relativePath);
}

for (const entry of [...allowedTopLevel].sort()) {
  inspectIncludedPath(path.join(contextRoot, entry), entry);
}

const sensitiveTopLevel = fs.readdirSync(contextRoot).filter((entry) =>
  forbiddenPatterns.some((pattern) => pattern.test(entry))
);
if (sensitiveTopLevel.length > 0) {
  const ignored = new Set(
    fs.readFileSync(path.join(contextRoot, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
  );
  if (!ignored.has("**")) {
    fail(`sensitive paths are not covered by deny-all: ${sensitiveTopLevel.join(", ")}`);
  }
}

console.log(JSON.stringify({
  code: "DOCKER_CONTEXT_ALLOWLIST_VERIFIED",
  contextRoot,
  includedFileCount: includedFiles.length,
  includedTopLevel: [...allowedTopLevel].sort(),
}));

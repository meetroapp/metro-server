"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("Docker context is deny-all with a production-runtime allowlist", () => {
  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  assert.equal(
    dockerignore,
    [
      "**",
      "!Dockerfile",
      "!.dockerignore",
      "!index.js",
      "!package.json",
      "!package-lock.json",
      "!server/",
      "!server/**",
      "",
    ].join("\n")
  );
});

test("Docker context verifier rejects credential-like included content", () => {
  const verifier = fs.readFileSync(
    path.join(root, "scripts/verify-docker-build-context.js"),
    "utf8"
  );
  assert.match(verifier, /PRIVATE KEY/);
  assert.match(verifier, /github_pat/);
  assert.match(verifier, /postgres/);
  assert.match(verifier, /isSymbolicLink/);
});

test("Dockerfile installs from the lockfile and reports immutable provenance", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:22\.23\.1-bookworm-slim$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /GIT_COMMIT=\$OCI_REVISION/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision=\$OCI_REVISION/);
  assert.match(dockerfile, /io\.meetro\.packaging\.revision=\$PACKAGING_REVISION/);
  assert.match(dockerfile, /CMD \["node", "index\.js"\]/);
  assert.doesNotMatch(dockerfile, /COPY\s+\.env/);
});

test("Publishing requires an explicit full SHA and has no push trigger", () => {
  const workflow = fs.readFileSync(
    path.join(root, ".github/workflows/publish-immutable-backend-image.yml"),
    "utf8"
  );
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule):/m);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(workflow, /ghcr\.io\/meetroapp\/metro-server:\$\{\{ inputs\.source_sha \}\}/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.match(workflow, /PACKAGING_REVISION=\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /Workflow run: \$WORKFLOW_RUN_URL/);
});

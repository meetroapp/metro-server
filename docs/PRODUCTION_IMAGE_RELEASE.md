# Immutable Production Image Release

Production application code is released from a public GHCR image identified by
an OCI manifest digest. A Git branch, tag, or Railway deployment ID is evidence,
not canonical image authority.

## Release identity

Every release record must contain:

- source repository `https://github.com/meetroapp/metro-server`;
- the full certified Git SHA;
- SHA-specific GHCR tag;
- OCI manifest digest;
- UTC build timestamp;
- GitHub Actions workflow run ID;
- OCI source, revision, created, and version labels.

The canonical Railway source is:

```text
ghcr.io/meetroapp/metro-server@sha256:<manifest-digest>
```

Never use `latest`, `production`, or `stable` as production authority.

## Historical source packaging

The workflow checks out the requested SHA into an isolated directory, then adds
only the reviewed `Dockerfile` and `.dockerignore` from the workflow revision.
The image therefore consists of the exact historical application source plus a
separately reviewable packaging authority. The source SHA and packaging commit
must both be recorded with the published digest.

## Publication

Run `Publish immutable backend image` manually with a full lowercase Git SHA.
The workflow has no push, pull-request, or schedule trigger. Publishing creates
an artifact but does not authorize production promotion.

Before the first publication, confirm the GHCR package can be public without a
Railway registry credential. After publication, pull the image by digest without
credentials and verify its labels, filesystem, health response, and reported
commit.

## Promotion and rollback

Production source changes require a separate approval naming the exact digest.
Promote only after disposable Railway certification proves restart, redeploy,
scale, harmless configuration deployment, disabled image auto-update, and
digest rollback behavior.

Rollback selects the prior recorded GHCR digest and deploys it without rebuilding.
Railway historical rollback is secondary evidence, not the durable recovery source.

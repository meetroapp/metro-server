# Meetro immutable maintenance bridge v1

This dependency-free HTTP service is the governed traffic boundary for a future
production convergence window. It does not import or start the Meetro backend,
does not inspect database configuration, and does not initiate outbound
connections.

- Exact `GET /health` returns HTTP 200 so Railway can complete a health-gated
  deployment.
- Every other method, path, query, and request body returns HTTP 503 with
  `Retry-After` and `Cache-Control: no-store`.
- Request headers, bodies, cookies, and query values are never logged or echoed.
- The container runs as the non-root `node` user on `process.env.PORT` (default
  8080 for local use).

The published artifact must use the separate repository identity
`ghcr.io/meetroapp/metro-maintenance-bridge` and an exact manifest digest.
`railway.json` defines the `/health` deployment gate used during disposable and
future governed cutovers; production activation still requires separate human
authorization and pre-change configuration fingerprinting.

# Verified APIs

Verified 2026-11-16 against Wrangler 4.157.0 (released 2026-11-03). Reference implementation: `../phamhuuthien/worker/` and its `docs/tech.md`.

## Cloudflare Worker + static assets + D1 (pattern copied from phamhuuthien)

- `wrangler.jsonc`: `main` = Worker entry; `assets.directory` = `./dist`; `assets.binding` = `ASSETS`;
  `assets.not_found_handling` = `single-page-application`; `assets.run_worker_first` = `["/api/*"]`, so the Worker runs
  only for API paths and everything else is a static asset. Fallthrough: `return env.ASSETS.fetch(request)`.
- D1 binding: `"d1_databases": [{ "binding": "DB", "database_name": "...", "database_id": "..." }]`. Without `database_id`,
  Wrangler auto-provisions on deploy; pin the ID afterwards. API: `env.DB.prepare(sql).bind(...)` then `.run()`,
  `.all()`, `.first(column?)`; `env.DB.batch([...])` is one transaction. Only `?`/`?NNN` parameters.
  **`meta.changes` on `.run()`**: for INSERT/UPDATE/DELETE, `meta.changes` is the number of rows affected.
  Useful for checking if an operation succeeded: e.g., `INSERT ... WHERE NOT EXISTS ...` returns `changes === 1` if
  the INSERT happened, `0` if the WHERE condition blocked it. Tested and works in both local and remote D1.
  Source: https://developers.cloudflare.com/d1/worker-api/
- D1 migrations: SQL files in `migrations/`, names sorted by number; `wrangler d1 migrations apply <database_name>
  [--local|--remote]`. Applied names are tracked in the `d1_migrations` table. Prefer the database name over the
  binding name. Source: https://developers.cloudflare.com/d1/reference/migrations/
- Foreign keys are enforced in D1 (`PRAGMA foreign_keys=on` by default). Source: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
- Rate limiting binding (`ratelimits` in wrangler.jsonc): `{ name, namespace_id, simple: { limit, period } }`; period is
  10 or 60 seconds; call `await env.X.limit({ key })` -> `{ success }`. Counts are per Cloudflare location. Same shape
  as `../phamhuuthien/wrangler.jsonc`.
- Secrets: `npx wrangler secret put ADMIN_TOKEN`; local dev reads `.dev.vars` (gitignored).
- `crypto.subtle.timingSafeEqual` is a non-standard Workers extension (not in Node). This project does not use it:
  it hashes both values with SHA-256 (`crypto.subtle.digest`) and compares the equal-length digests with an
  XOR-accumulate loop. Source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- `crypto.getRandomValues(new Uint8Array(n))` is available in Workers and Node for token generation.
- Tests: `node:sqlite` `DatabaseSync(':memory:')` wrapped in the D1 shape (see `../phamhuuthien/worker/testDb.ts`).

## Cloudflare Access JWT validation (verified 2026-11-16)

- Access adds the signed JWT to each request that passes it as the `Cf-Access-Jwt-Assertion` header (also the
  `CF_Authorization` cookie; the header is the one to validate). Public keys: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  (JWKS `keys[]`, RS256; rotated every 6 weeks, old key valid 7 more days; match by `kid`, do not hard-code keys).
  Validate signature, `iss` = `https://<team>.cloudflareaccess.com` and `aud` = the application's AUD tag.
  Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- `ctx.access` is NOT available here: a Worker with Static Assets runs behind a router Worker that does not pass
  `ctx.access` to the user Worker. So the Worker validates the JWT itself.
  Source: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
- Library: `jose` 6.2.16 (released 2026-11-08). Confirmed against `node_modules/jose/dist/types/` (2026-11-16).
  ```ts
  import { jwtVerify, createRemoteJWKSet, createLocalJWKSet, decodeProtectedHeader,
           generateKeyPair, exportJWK, SignJWT } from 'jose'
  import type { JWTVerifyGetKey, LocalJWKSet } from 'jose'

  // Verify (all option names confirmed):
  jwtVerify(token, keysOrFn, {
    algorithms: ['RS256'],
    issuer: string,
    audience: string,
    requiredClaims: ['exp', 'iat'],  // string[]
    clockTolerance: 30,              // number (seconds) or string
  })

  // Remote JWKS (option names confirmed):
  createRemoteJWKSet(new URL(certsUrl), {
    cooldownDuration: 30_000,   // ms between refetch attempts on unknown kid
    timeoutDuration: 3_000,     // ms HTTP timeout
    cacheMaxAge: 600_000,       // ms max cache lifetime
  })

  // Synchronous protected-header decode (no signature check):
  decodeProtectedHeader(token: string): { alg?: string; kid?: string; [k: string]: unknown }

  // Test helpers — generateKeyPair returns { privateKey: CryptoKey, publicKey: CryptoKey }
  // createLocalJWKSet({ keys: [{ ...jwk, kid: 'k1' }] }) returns LocalJWKSet (callable as JWTVerifyGetKey)
  ```
  Validate signature, `iss` = `https://<team>.cloudflareaccess.com` and `aud` = the application's AUD tag.
  The `email` claim is used to match against the admin list in D1.
- Hostname/path protection: a self-hosted Access application on the hostname and paths (`/admin*`, `/api/admin/*`)
  protects only those URLs. A `workers.dev` hostname needs its own application or must be disabled.

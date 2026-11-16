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
- **Schema**: The `teacher`, `card`, and `admin` tables are created by the `ensureSchema(db)` function in `worker/schema.ts` using idempotent `CREATE TABLE IF NOT EXISTS` statements. Each run is a no-op if the tables already exist. This avoids a migration step and keeps the schema as single source of truth in code. `ensureSchema` is called once per D1 binding per isolate and cached via a `WeakMap` so concurrent requests share one DDL batch. If DDL fails the cache entry is evicted and the next request retries. For any future column changes, a schema version table or a migration system would be needed — this shortcut applies only to immutable CREATE. Source: `worker/schema.ts`.
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

## Google Sign-In (Google Identity Services) ID tokens (verified 2026-11-16)

- Browser: load `https://accounts.google.com/gsi/client` with a `<script async>`; `google.accounts.id.initialize({ client_id, callback })`
  returns the ID token as `response.credential` in the JS callback (no cookie). `renderButton` draws the button.
  Sources: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid ,
  https://developers.google.com/identity/gsi/web/reference/js-reference
- Server verification (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token): signature with Google's public keys
  (JWKS `https://www.googleapis.com/oauth2/v3/certs`, RS256, rotated; honour `Cache-Control`), `aud` equals the app's client ID, `iss` is
  `accounts.google.com` or `https://accounts.google.com`, `exp` not passed. Discovery (checked today):
  `https://accounts.google.com/.well-known/openid-configuration` gives issuer `https://accounts.google.com`, `id_token_signing_alg_values_supported: [RS256]`.
- Google is authoritative for an email when it ends with `@gmail.com`, or when `email_verified` is true and `hd` is set (Workspace). Otherwise the
  address may have changed owner. Google recommends `sub` as the stable user id; this project allow-lists by email because admins are added by typing an address.
- CSP additions for GIS: `script-src https://accounts.google.com/gsi/client`, `frame-src https://accounts.google.com/gsi/`,
  `connect-src https://accounts.google.com/gsi/`, `style-src https://accounts.google.com/gsi/style`. COOP changes are only needed when FedCM is off.
- Jose usage (6.2.16, same as the Access code): `jwtVerify(token, keys, { algorithms, issuer: [..], audience, requiredClaims, clockTolerance, maxTokenAge })`;
  confirm option names in `node_modules/jose` types.

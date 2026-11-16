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

## Admin email normalisation (verified 2026-11-16)

- Typed email sent as `X-Admin-Email` header; checked against D1 admin list. Email is normalised (trim, lower-case, ASCII, ≤254 chars, pattern validation) by `worker/email.ts:normalizeEmail()` shared with `admins.ts`. No cryptographic identity verification (accepted risk R1 — see decisions.md). SSO version preserved in git (tag `sso-google-signin`, commit cec9a58).

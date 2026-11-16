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


## Image Storage: Base64 in D1 TEXT (Decision 2026-11-16)

- **Why base64 in TEXT, not R2**: Adding R2 binding fails on accounts where R2 is not enabled. D1 needs no new permissions. D1 BLOB read behavior historically returned arrays of numbers, so base64 TEXT is safer and universally supported.
- **Size overhead**: Base64 encoding is ~1.33× larger than raw bytes (4 chars per 3 bytes). A 300 KB JPEG becomes ~400 KB in D1 storage.
- **Encode/decode without Buffer**: `Uint8Array.prototype.toBase64()` is available in modern Workers; fallback to chunked `atob()` loop over 32 KB chunks to avoid stack overflow (no `Buffer.from` available without `nodejs_compat`).
  - Encode: `array.toBase64?.() ?? /* chunked btoa fallback */`
  - Decode: `Uint8Array.fromBase64(text)` when available, else chunked `atob` with `fromCharCode.apply`
- **Tested**: ~290 KB byte-exact round trip without calling `Buffer.from`; smoke test: 2 consecutive 288 KB fetches decoded correctly.
- **SHORTCUT: CPU cost on free plan**: free-plan Workers allow 10 ms CPU per request. A 300 KB base64 decode takes ~10 ms on local runtime. If production CPU exceeds the limit, move to R2 (R2 cost ~$0.015/GB/month; CPU savings may not justify it for 200 images, but is the eventual upgrade path).
- **Atomic insert cap**: `INSERT INTO image (…) SELECT … WHERE (SELECT COUNT(*) FROM image) < 200 AND (SELECT COALESCE(SUM(size),0) FROM image) + ? <= 41943040`; if `changes === 0`, the cap was hit → 409 `conflict`.

## Cache API: Canonical Keys and 200-Only Caching

- **Binding**: `caches.default` in `worker/index.ts` routes GET `/api/image/:token` through the edge cache.
- **Canonical key**: `new URL('/api/image/<token>', request.url).origin + path` — this key is invariant to query strings and fragments (they are ignored). Requests to `/api/image/:token?foo=bar` and `/api/image/:token#hash` use the same cache entry as `/api/image/:token`.
- **200-only caching**: `await caches.default.put(key, response)` only when `response.status === 200`. 404 and other errors are never cached.
- **Immutable + waitUntil**: `response.headers.set('Cache-Control', 'public, max-age=31536000, immutable')` and `context.waitUntil(caches.default.put(…))` to write the cache asynchronously without blocking the response.
- **Local runtime**: `wrangler dev` is a no-op (no real cache); the stub always returns cache miss. On workers.dev and custom domains, caching actually happens.
- **Testing**: guard in tests: if `caches` is unavailable, skip the cache write; verify with a stub-cache test that a hit skips the DB query.
- **Deletion**: when an image is deleted from D1, the cached copy remains (up to 1 year). To immediately replace a published image in cards, upload a new one and switch the card reference (documented in admin runbook).

## Admin Rate Limit: 60/60 s (Doubled from 30/60 s, R1 Consequence)

- **Decision**: R1 (unverified admin email) accepted; admin endpoints are guarded by `ADMIN_FAIL_LIMIT` 60 requests per 60 s per IP.
- **Why doubled**: An upload session makes many API calls (list teachers, upload image, attach image, preview, publish). Raising the limit from 30 to 60 allows busy editing sessions.
- **R1 consequence**: The rate limit is also the only brake on guessing admin emails (R1). Doubling the limit means guessing rate per IP doubles (from ~2 s per attempt to ~1 s per attempt). Accepted by the decision owner; documented in decisions.md and plan.md.
- **Multi-admin scenario**: multiple admins behind one NAT (one IP) share the 60-request budget. A busy editing session may hit the limit; users wait, or request a higher limit for their domain.
- **Configured in wrangler.jsonc**: `{ "name": "ADMIN_FAIL_LIMIT", "namespace_id": "2002", "simple": { "limit": 60, "period": 60 } }`.

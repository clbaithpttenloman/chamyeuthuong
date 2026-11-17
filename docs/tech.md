# Verified APIs & Implementation Notes

Verified 2026-11-17 for the student cards platform.

**Dependencies verified:**
- Wrangler 4.157.0 (released 2026-11-03)
- ESLint 10.15.0 + ESLint Plugin React Hooks 7.1.1 + TypeScript-ESLint 8.73.0 (upgraded under security-patch exception after advisories)
- All versions pinned exactly (no ranges)

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

## Student Cards Platform — Schema & APIs (2026-11-17)

### New Tables (Idempotent CREATE TABLE IF NOT EXISTS via ensureSchema)

```sql
teacher_profile(
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  public_id TEXT UNIQUE NOT NULL,
  department TEXT NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1))
)
-- Used in public URLs; private teacher.token never exposed

template(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  layout TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
)
-- Layouts: lotus, spring, night, classic, minimal (checked in isLayout())

template_image(
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('background','banner','photo')),
  image_id INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, slot)
)
-- Prevents template deletion if cards use it (RESTRICT)

student_card(
  id INTEGER PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  teacher_id INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  from_name TEXT NOT NULL DEFAULT '' CHECK (length(from_name) <= 40),
  from_class TEXT NOT NULL DEFAULT '' CHECK (length(from_class) <= 10),
  anonymous INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT
)
-- Indexes: (teacher_id, status) for QR random-card query; (status, created_at) for moderation list
```

### Unchanged Tables

- `teacher(id, token UNIQUE, name, subject, created_at)` — private QR token
- `teacher_title(teacher_id PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE, title CHECK IN ('Thầy','Cô'))`
- `image(id, token UNIQUE, name, mime, size, data, created_at, created_by)` — base64 TEXT (no R2)
- `wish(id, title, body, created_at, created_by)` — 12 example seeds
- `admin(id, email UNIQUE, created_at, created_by)` — normalized email (trim, lowercase)
- `meta(key PRIMARY KEY, value)` — schema seeding marker

### Removed from Code

- Old tables `card`, `card_style`, `card_image` removed from `SCHEMA` constant
- Old endpoint `/api/card/:token` → 404 (replaced by `/api/qr/:token`)
- React routes `/mockup/*` and component `src/mockup/` deleted
- `CardPage` component deleted
- `BulkCreate` component deleted

### Public API SQL Fragments

**Constants** in `worker/publicSql.ts`:

- `PUBLIC_CARD_WHERE = "sc.status = 'approved'"` — every public read filters on this
- `PUBLIC_TEACHER_WHERE = "tp.show_on_home = 1"` — wall and latest only show active teachers
- Used by `/api/wall`, `/api/teachers/:publicId`, `/api/qr/:token`

### Atomic Operations

#### Submit Card (Plan § Amendment: Pending Caps)

```sql
INSERT INTO student_card (public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at)
SELECT ?, tp.teacher_id, ?, ?, ?, ?, ?, 'pending', ?
FROM teacher_profile tp
WHERE tp.public_id = ?
  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1)
  AND (SELECT COUNT(*) FROM student_card WHERE status = 'pending') < 2000
  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = tp.teacher_id AND sc2.status = 'pending') < 200
```

- **Atomicity:** all checks (teacher exists, template active, global cap, per-teacher cap) in one INSERT…SELECT
- **Disambiguation on changes=0:** one follow-up read to distinguish teacher not found (404) from inactive/missing template (400) from caps exceeded (409)
- **Per-teacher cap:** 200 pending cards per teacher (prevents one teacher's spam filling the queue)
- **Global cap:** 2000 pending cards (system-wide limit; must delete to free space)

#### Bulk Review (Plan § Amendment: D1 100-Parameter Limit)

```sql
UPDATE student_card
SET status = ?, reviewed_at = ?, reviewed_by = ?
WHERE id IN (SELECT value FROM json_each(?))
```

- **json_each:** allows unlimited IDs without hitting the 100-parameter bind limit
- **Input:** `JSON.stringify(ids)` → single JSON parameter
- **Validation:** testDb guard counts bound parameters per statement and throws if > 100 (catch violations early)

#### Character Rules & Rejection (Plan § Amendment: Submit Character Rules)

**Rejected:** U+00AD (soft hyphen), U+034F (combining grapheme joiner), U+061C (Arabic letter mark), U+180E (Mongolian vowel separator), U+200B–U+200F (zero-width space, zero-width non-joiner, zero-width joiner, left-to-right mark, right-to-left mark), U+2028–U+2029 (line/paragraph separators), U+202A–U+202E (bidi override), U+2060–U+2069 (word joiner, function application, invisible times, invisible separator), U+3164 (hangul filler), U+FEFF (zero-width no-break space), U+FFA0 (halfwidth hangul filler), U+E0000–U+E007F (tag characters), lone surrogates.

**Allowed:** U+200D (zero-width joiner, needed for emoji like 👩‍🏫 and ❤️) and variation selectors (U+FE00–U+FE0F), because every card is moderated before it is public, so an invisible joiner cannot hide content.

**Control characters:** rejected in message (except \n, max 5), rejected in name/class.

**Regex:** `REJECT_MSG_RE` and `REJECT_NAME_RE` used in `worker/submit.ts`.

### Template Create: Batch Insert with MAX(id)

**Why not last_insert_rowid():**

```sql
-- WRONG: binds template_image rows in sequence; 2nd+ row's last_insert_rowid() returns previous image row id
INSERT INTO template_image (...) VALUES (...);
INSERT INTO template_image (...) VALUES (...); -- last_insert_rowid() points at 1st template_image, not template
```

**Correct:** inside one serial `db.batch([...])` transaction:

```sql
INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?);
INSERT INTO template_image VALUES ((SELECT MAX(id) FROM template), 'background', ?);
INSERT INTO template_image VALUES ((SELECT MAX(id) FROM template), 'banner', ?);
```

- `SELECT MAX(id) FROM template)` inside the batch sees the just-inserted template row
- Tested and verified in smoke.md

### Rate Limits & School NAT

**Configured** in `wrangler.jsonc` under `ratelimits`:

- `PUBLIC_IP_LIMIT` (namespace 2004): 120/60 s — `/api/wall`, `/api/teachers/*`, `/api/templates`, `/api/wishes`
- `SUBMIT_IP_LIMIT` (namespace 2005): 20/60 s — `POST /api/cards` (tight on 20/11; raise if needed)
- `CARD_IP_LIMIT` (namespace 2001): 60/60 s — `GET /api/qr/:token` (QR scanners)
- `IMAGE_IP_LIMIT` (namespace 2003): 300/60 s — `GET /api/image/:token` (fast card loads)
- `ADMIN_FAIL_LIMIT` (namespace 2002): 60/60 s — all `/api/admin/*` (doubled from 30/60 for upload sessions; also only brake on R1 guessing)

**School NAT:** all students on school Wi-Fi = one IP. 20 card submissions per minute for 500 students = 1 submission per 25 seconds average; tight, but acceptable. If 20/11 event is busier, raise `SUBMIT_IP_LIMIT` in `wrangler.jsonc` (documented in admin runbook).

---

## Admin Rate Limit: 60/60 s (Doubled from 30/60 s, R1 Consequence)

- **Decision**: R1 (unverified admin email) accepted; admin endpoints are guarded by `ADMIN_FAIL_LIMIT` 60 requests per 60 s per IP.
- **Why doubled**: An upload session makes many API calls (list teachers, upload image, attach image, preview, publish). Raising the limit from 30 to 60 allows busy editing sessions.
- **R1 consequence**: The rate limit is also the only brake on guessing admin emails (R1). Doubling the limit means guessing rate per IP doubles (from ~2 s per attempt to ~1 s per attempt). Accepted by the decision owner; documented in decisions.md and plan.md.
- **Multi-admin scenario**: multiple admins behind one NAT (one IP) share the 60-request budget. A busy editing session may hit the limit; users wait, or request a higher limit for their domain.
- **Configured in wrangler.jsonc**: `{ "name": "ADMIN_FAIL_LIMIT", "namespace_id": "2002", "simple": { "limit": 60, "period": 60 } }`.

---

## React Hooks Linting & Security Patch Upgrade (2026-11-17)

**Added:** `eslint` + `eslint-plugin-react-hooks` 7.1.1 + `typescript-eslint` 8.73.0 (decision 2026-11-17).

**Reason:** React hooks-after-early-return crash on the home page wall was only caught in the browser; static linting could have prevented it.

**Configuration** (`.eslintrc.cjs`):
- `rules-of-hooks` error (non-negotiable)
- `exhaustive-deps` warn (informational)
- Applied to `src/**/*.tsx` only

**Run:** `npm lint` or as part of `npm test` (which runs `eslint src && vitest run`).

**Security upgrade:** `npm audit` reported 8 moderate advisories (minimatch GHSA-g3hv-75wg-m249 through eslint and typescript-eslint). Under the security-patch exception (7-day quarantine does not apply), upgraded at once to eslint 10.15.0 and typescript-eslint 8.73.0 (released within the last 7 days as of 2026-11-17). `npm audit` after upgrade: 0 vulnerabilities. Both are dev-only tools, not in the deployed bundle.


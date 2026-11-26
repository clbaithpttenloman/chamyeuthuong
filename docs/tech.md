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
- Secrets: `printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY` (see `docs/runbooks/google-signin.md`); local dev reads `.dev.vars` (gitignored).
- `crypto.subtle.timingSafeEqual` is a non-standard Workers extension (not in Node). This project does not use it:
  it hashes both values with SHA-256 (`crypto.subtle.digest`) and compares the equal-length digests with an
  XOR-accumulate loop. Source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- `crypto.getRandomValues(new Uint8Array(n))` is available in Workers and Node for token generation.
- Tests: `node:sqlite` `DatabaseSync(':memory:')` wrapped in the D1 shape (see `../phamhuuthien/worker/testDb.ts`).

## Admin email normalisation (verified 2026-11-16) — SUPERSEDED

> Superseded by ADR-9 (Phase 2b): admins are accounts with an `admin_role` row. The `X-Admin-Email` header and `worker/email.ts` are no longer used for authorisation. Kept only as history.


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

## Student Cards Platform — Schema & APIs (2026-11-18)

### New Tables (Idempotent CREATE TABLE IF NOT EXISTS via ensureSchema)

```sql
teacher_profile(
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  department   TEXT NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1)),
  role         TEXT NOT NULL DEFAULT 'Giáo viên' CHECK (role IN ('Giáo viên','Hiệu trưởng','Phó hiệu trưởng','Giám thị'))
)

template(
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
)

template_image(
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL CHECK (slot IN ('background')),
  image_id    INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, slot)
)

student_card(
  id          INTEGER PRIMARY KEY,
  public_id   TEXT UNIQUE NOT NULL,
  teacher_id  INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  message     TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  from_name   TEXT NOT NULL DEFAULT '' CHECK (length(from_name) <= 40),
  from_class  TEXT NOT NULL DEFAULT '' CHECK (length(from_class) <= 10),
  anonymous   INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at  TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  font        TEXT NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32),
  ink         TEXT NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
)

site_content(
  key        TEXT PRIMARY KEY CHECK (key IN ('about')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
)
```

### Unchanged Tables

- `teacher(id, token UNIQUE, name, subject, created_at)` — `token` is the private QR identifier (16 chars)
- `teacher_title(teacher_id PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE, title CHECK IN ('Thầy','Cô'))`
- `image(id, token UNIQUE, name, mime, size, data, created_at, created_by)` — base64 TEXT (no R2)
- `wish(id, title, body, created_at, created_by)` — 12 example seeds
- `admin(id, email UNIQUE, created_at, created_by)` — normalized email (trim, lowercase)
- `meta(key PRIMARY KEY, value)` — schema seeding marker

### Changes from Prior Versions

- **Removed:** `teacher_profile.public_id` (teachers identified only by numeric `id` internally, `token` for private QR)
- **Removed:** `/api/teachers/:publicId` endpoint (404)
- **Removed:** `/thay-co/:publicId` React route (no public teacher pages)
- **Removed:** `template_image.slot='banner'` and `'photo'` from new templates (slots: `background` only); old DBs keep old CHECK but code rejects banner/photo writes and ignores them on reads
- **Removed:** `latest` array from `/api/wall` (privacy model)
- **Removed:** old label "GV môn: {môn}" (replaced with "Giáo viên: {môn}" or role name for leaders)
- **Removed:** old layout ids as write-targets (classic, lotus, spring, minimal, night) — mapped read-time only
- **Removed:** translucent overlay background rendering (card v3: solid background image)
- **Removed:** banner CSS and `card-mini` scale hacks
- **Added:** `student_card.font` TEXT DEFAULT 'patrick-hand' (Card v3: student font choice)
- **Added:** `student_card.ink` TEXT DEFAULT '#1d3fa6' (Card v3: student ink colour)
- **Added:** seven supported fonts via @fontsource (patrick-hand, pangolin, itim, mali, charm, be-vietnam-pro, lora)
- **Added:** `/api/qr/:token` endpoint (private teacher card page)
- **Added:** `/api/about` (public) and `/api/admin/about` (admin editor)
- **Added:** `POST /api/cards` accepts exactly one of `teacherId` or `teacherToken`
- **Added:** `site_content` table for About page (seeded once via INSERT OR IGNORE)
- **Added:** `teacher_profile.role` column (chức vụ: Giáo viên, Hiệu trưởng, Phó hiệu trưởng; Giám thị added later)
- **Added:** six layout ids (doc-giua, doc-duoi, doc-tren, ngang-giua, ngang-phai, ngang-trai)
- **Added:** one-time seed: 6 flower backgrounds + 6 example templates (guarded by meta `images_seeded`)

### Schema Upgrades (Idempotent, Applied Automatically)

`ensureSchema` runs the `UPGRADES` list in `worker/schema.ts` after the CREATE batch. It probes `PRAGMA table_info('teacher_profile')` and `PRAGMA table_info('student_card')` per table, re-probing only after a step ran on that table. Each step is its own `db.batch` (one D1 transaction).

1. **Drop `public_id`** (if `public_id` present on teacher_profile and `role` absent): CREATE `teacher_profile_new` from the current DDL, copy `teacher_id, department, show_on_home`, DROP, RENAME. Rows get `role = 'Giáo viên'` from the DDL default.
2. **Add `role`** (if absent on teacher_profile): `ALTER TABLE teacher_profile ADD COLUMN role TEXT NOT NULL DEFAULT 'Giáo viên' CHECK (role IN ('Giáo viên','Hiệu trưởng','Phó hiệu trưởng','Giám thị'))`. Skipped after step 1.
3. **Add `font`** (if absent on student_card, Card v3): `ALTER TABLE student_card ADD COLUMN font TEXT NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32)`. Existing cards get Bút bi.
4. **Add `ink`** (if absent on student_card, Card v3): `ALTER TABLE student_card ADD COLUMN ink TEXT NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`. Existing cards get blue.
4b. **Role list (Giám thị)** (after steps 1–4, if the stored `teacher_profile` CREATE text lacks the current role CHECK): one batch that creates `teacher_profile_new` from the current DDL, copies all four columns, drops `teacher_profile`, and renames. Probe: `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'teacher_profile'`. Every row keeps its role; a racing replay copies the same data. Verified on local D1 from the f7cc60e shape (rows intact, Giám thị accepted, invalid values rejected, `ON DELETE CASCADE` kept).
5. **Seed images & templates** (Card v3, best-effort, guarded by meta `images_seeded`): Six WebP backgrounds from `worker/seedImages.ts` (tokens seedbg0000000001–6, created_by 'seed') + six example templates (created_by 'seed') + links. Runs once per DB; failure logs `schema: seed images failed` (does not 503). Each statement repeats the flag-absent guard, so racing isolates produce exactly 6/6/6 rows and one flag.

A failed step logs `schema: upgrade failed`, rejects (request → 503), and is retried on the next request. Two isolates racing: the loser gets "duplicate column name" once, then the retry skips. A 4d3a5df database runs step 1 (which also creates `role`), then 3–5. Production at fdb5da3 (no `public_id`, no `role`) runs steps 2–5 on the next deploy; verified on a local copy created by fdb5da3. Operator reference: `docs/runbooks/admin.md` → "Schema upgrades".

### Seed Images & Example Templates (Card v3)

**Source:** Six 960×1280 / 1280×960 WebP images rendered from the approved mockup (`docs/design/card-v3-mockup.html`), one per layout. Flowers avoid the writing zone per layout. Size: ~18–20 KB each, ≤ 300 KB per image CHECK. Encoded as base64 in `worker/seedImages.ts` and loaded with dynamic `import()` only when the seed has not run (so normal cold starts do not parse the 122 KB module).

**Example templates:** Six active templates named after colour + layout (e.g., "Hoa hồng · Dọc – giữa"), one per seed image, with created_by='seed'. Admins can deactivate or delete them (deletion is allowed because the image's used_by count ignores legacy banner links; see image deletion below).

**Idempotency:** Guarded by meta flag `images_seeded`. Every INSERT statement repeats `WHERE NOT EXISTS (SELECT 1 FROM meta WHERE key='images_seeded')`, so a racing isolate inserts nothing. Flag is written last in the same batch.

**Bypassable caps:** Seed images bypass the 200-image / 40 MB upload caps (~6 images, well under limits).

**Best-effort:** Failure logs `schema: seed images failed` (fixed string, no stack) and never rejects `ensureSchema`. Runs at most once per isolate (success or failure cached), so a failing seed is not re-sent per request.

### Atomic Operations

#### Submit Card (Plan § Amendment: teacherId or teacherToken)

Two paths; exactly one required:

**Path A: Public teacherId (show_on_home = 1 only):**
```sql
INSERT INTO student_card (public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at)
SELECT ?, t.id, ?, ?, ?, ?, ?, 'pending', ?
FROM teacher t
JOIN teacher_profile tp ON tp.teacher_id = t.id
WHERE t.id = ? AND tp.show_on_home = 1
  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1)
  AND (SELECT COUNT(*) FROM student_card WHERE status = 'pending') < 2000
  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = t.id AND sc2.status = 'pending') < 200
```

**Path B: Private teacherToken (any teacher):**
```sql
INSERT INTO student_card (public_id, teacher_id, template_id, message, from_name, from_class, anonymous, status, created_at)
SELECT ?, t.id, ?, ?, ?, ?, ?, 'pending', ?
FROM teacher t
WHERE t.token = ?
  AND EXISTS (SELECT 1 FROM template WHERE id = ? AND active = 1)
  AND (SELECT COUNT(*) FROM student_card WHERE status = 'pending') < 2000
  AND (SELECT COUNT(*) FROM student_card sc2 WHERE sc2.teacher_id = t.id AND sc2.status = 'pending') < 200
```

- **Atomicity:** all checks in one INSERT…SELECT
- **Disambiguation on changes=0:** one follow-up read to distinguish teacher not found (404) from inactive/missing template (400) from caps exceeded (409)
- **Per-teacher cap:** 200 pending cards per teacher
- **Global cap:** 2000 pending cards (must delete to free space)
- **Request validation:** both or neither → 400 before DB
- **Font validation** (Card v3): exact string match against FONTS ids (Map-based `isFont`, so `__proto__` and `constructor` fail); absent defaults to 'patrick-hand'; invalid → 400
- **Ink validation** (Card v3): regex `^#[0-9a-fA-F]{6}$` on raw input (strict, no `m` flag, no newlines), then `.toLowerCase()` for storage; absent defaults to '#1d3fa6'; invalid or null → 400; stored value passes GLOB CHECK

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
```

- `SELECT MAX(id) FROM template)` inside the batch sees the just-inserted template row
- Tested and verified in smoke.md

### Rate Limits & School NAT

**Configured** in `wrangler.jsonc` under `ratelimits`:

- `PUBLIC_IP_LIMIT` (namespace 2004): 120/60 s — `/api/wall`, `/api/templates`, `/api/wishes`, `/api/about`
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


## Fonts (self-hosted, verified 2026-11-17)

- `@fontsource/be-vietnam-pro` 5.3.0 (body, weights 400/600/700) and `@fontsource/lora` 5.3.0 (headings and card text, 400, 400 italic, 700), exact pins, SIL Open Font License 1.1. Imported in `src/main.tsx`; CSS uses `--font-sans` and `--font-serif` in `src/styles.css`.
- Why: Georgia and `system-ui` differ per device (Android has no Georgia; some fallbacks place stacked Vietnamese marks such as "ẫ", "ầ" badly). Both families are designed with full Vietnamese coverage.
- The weight CSS files declare `unicode-range` subsets, so a browser only downloads the latin, latin-ext and vietnamese files it needs (checked: 15 woff2 files on the wall page, all same-origin, no CSP change needed because `default-src 'self'` covers fonts). The build copies every subset (about 1 MB in `dist/assets`), which is not downloaded unless used.
- `font-display: swap`: text shows at once in the fallback font and switches when the file arrives.

---

## Google sign-in + sessions (campaign platform, Phase 1)

Verified 2026-11-20 for plan `.kiro/delivery/2026-11-18-campaign-platform/` (ADR-3).

### Campaign Table & Migration

**Phase 1 schema:**
```sql
campaign(
  id       INTEGER PRIMARY KEY,
  slug     TEXT UNIQUE NOT NULL CHECK (length(slug) BETWEEN 2 AND 32 AND NOT slug GLOB '*[^a-z0-9-]*'),
  kind     TEXT NOT NULL CHECK (kind IN ('teacher_cards','gift_tree')),
  name     TEXT NOT NULL,
  tagline  TEXT NOT NULL DEFAULT '',
  content  TEXT NOT NULL,  -- JSON { home: { kicker, heading, body } }
  theme_colors TEXT NOT NULL DEFAULT '{}',  -- JSON
  settings TEXT NOT NULL DEFAULT '{}',  -- JSON (validation in code)
  starts_at TEXT NOT NULL,  -- ISO-8601 UTC YYYY-MM-DDTHH:MM:SSZ
  ends_at TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
)
CREATE UNIQUE INDEX one_active ON campaign(status) WHERE status = 'active'
```

**Migration step:** after campaign table is created, if no row with id=1 exists:
1. Insert campaign 1 with slug='20-11', kind='teacher_cards', status='active', content from `src/content/site.json`
2. This runs atomically with the `ADD COLUMN campaign_id` steps on existing tables (template, wish, student_card), all with DEFAULT 1

**Existing table changes:**
- `template.campaign_id INTEGER NOT NULL DEFAULT 1` (added in upgrade step, indexed)
- `wish.campaign_id INTEGER NOT NULL DEFAULT 1` (added in upgrade step, indexed)
- `student_card.campaign_id INTEGER NOT NULL DEFAULT 1` (added in upgrade step, indexed)

(These columns are not foreign-key constrained because SQLite cannot `ALTER TABLE ... ADD COLUMN ... REFERENCES ... DEFAULT <non-null>` while FKs are ON. Validation is in app code and indexes are added after the ADD COLUMN step.)

### Campaign Admin Endpoints (Phase 1)

**All campaign admin routes require Google sign-in only** (no legacy email path). Signature: `POST /api/admin/campaigns` returns 201 on success; dates are validated (end > start), status defaults to 'draft' on POST (rejected on PATCH), slug is generated from name if absent.

| Method | Path | Fields | Purpose | Response |
|--------|------|--------|---------|----------|
| POST | `/api/admin/campaigns` | slug, kind, name, content, theme_colors, settings, starts_at, ends_at | Create draft campaign | 201 created |
| GET | `/api/admin/campaigns` | — | List all campaigns | 200 + array |
| GET | `/api/admin/campaigns/<id>` | — | Get one for editing | 200 + campaign |
| PATCH | `/api/admin/campaigns/<id>` | name, content, theme_colors, settings, starts_at, ends_at | Update (status rejected 400) | 200 + campaign |
| POST | `/api/admin/campaigns/<id>/activate` | — | Close prev active, activate this | 200 + campaign |
| POST | `/api/admin/campaigns/<id>/close` | — | Set status='closed' | 200 + campaign |
| DELETE | `/api/admin/campaigns/<id>` | — | Remove campaign | 204 (or 409 if campaign 1 or owns rows) |

**Slug validation:** 2–32 chars, regex `[a-z0-9-]+` (lowercase, digits, hyphens only); reserved words: admin, api, t, gui-thiep, ve-clb-ai, assets, theme, g.

**Content shape:** `{ home: { kicker?: string, heading?: string, body?: string } }`; seeded for campaign 1 from `src/content/site.json`.

**Effective open:** `status = 'active' AND now BETWEEN starts_at AND ends_at` (no automatic status flip at midnight).

### Public Campaign Endpoints (Phase 1)

| Method | Path | Returns | Rate Limit |
|--------|------|---------|-----------|
| GET | `/api/campaigns/active` | active campaign, or most recent closed (`open: false`) | PUBLIC_READ_LIMIT (3000/60 s, per IP, cache misses only) |
| GET | `/api/campaigns/<slug>` | campaign by slug (drafts → 404 unless admin) | PUBLIC_READ_LIMIT (cache misses) |

**Memo + cache:** `/api/campaigns/active` and `/:slug` are memoised per isolate (5 s TTL, 32-entry LRU, active slug pinned, unknown slugs in separate 30-s 404 cache). Memo key = normalised path + validated slug (query params ignored). Rate limiter is charged only on cache misses. Tests verify a /api/campaigns/active memo hit does not charge PUBLIC_READ_LIMIT.

### `jose` — version 6.2.17
- Pin `"jose": "6.2.17"`: released 2026-11-09. 6.2.18 (2026-11-18) is inside the 7-day quarantine. ESM (`"type": "module"`).
- Imports: `import { createRemoteJWKSet, jwtVerify, errors } from 'jose'`.
- `createRemoteJWKSet(url: URL, options?: { timeoutDuration?, cooldownDuration?, cacheMaxAge?, ... }): RemoteJWKSet` — one instance per isolate; `cooldownDuration` stops unknown-`kid` tokens from forcing refetches.
- `jwtVerify(jwt, getKey, options)` where `options` includes `algorithms`, `issuer` (string | string[]), `audience`, `clockTolerance`, `maxTokenAge`, `requiredClaims`, `currentDate`.
- Errors: `errors.JWTExpired` (code `ERR_JWT_EXPIRED`), `errors.JWTClaimValidationFailed` (`ERR_JWT_CLAIM_VALIDATION_FAILED`), `errors.JWKSNoMatchingKey`, `errors.JWKSTimeout`.
- Behaviour checked locally with node 22: options `{ algorithms: ['RS256'], issuer: ['https://accounts.google.com','accounts.google.com'], audience, clockTolerance: 60, maxTokenAge: '1h', requiredClaims: ['sub','exp','iat'] }`.
- **Shipped (worker/google.ts):** `maxTokenAge` is not passed, because jose subtracts `clockTolerance` from it. The code checks `iat` itself after `jwtVerify`: refused when `iat > now + 60 s` (future) or `now − iat > 3600 s` (older than 1 h).
  - `iat` = now passes; `iat` = now + 30 s passes (within tolerance).
  - `iat` = now + 300 s fails: "iat claim timestamp check failed (it should be in the past)".
  - Expired `exp` fails with `ERR_JWT_EXPIRED`.
- Source: package types in `node_modules/jose/dist/types/{jwks/remote.d.ts,jwt/verify.d.ts,types.d.ts,util/errors.d.ts}` (6.2.17); `npm view jose time`.

### Google Identity Services (browser)
- Script: `<script src="https://accounts.google.com/gsi/client" async></script>`. It must be loaded from Google; self-hosting is unsupported.
- `google.accounts.id.initialize({ client_id, callback, nonce, ux_mode: 'popup', use_fedcm_for_button: true, context: 'signin' })`, then `google.accounts.id.renderButton(el, options)`.
  - `callback` receives `{ credential }`, which is the ID token.
  - `nonce` is "a random string for ID tokens … to prevent replay attacks" and is echoed in the token's `nonce` claim.
  - Call `initialize` only once per page.
  - `use_fedcm_for_prompt` is deprecated and ignored.
- CSP when these directives are present:
  - `script-src https://accounts.google.com/gsi/client`
  - `frame-src https://accounts.google.com/gsi/`
  - `connect-src https://accounts.google.com/gsi/` (use the parent URL, not individual endpoints)
  - `style-src https://accounts.google.com/gsi/style`
- COOP: no change is needed when FedCM is enabled. Without FedCM, `same-origin-allow-popups` is required for popups. We set no COOP header.
- FedCM inside iframes needs `allow="identity-credentials-get"`. Not applicable: the sign-in page is top-level.
- Sources:
  - https://developers.google.com/identity/gsi/web/reference/js-reference
  - https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid (CSP, COOP)
  - https://developers.google.com/identity/gsi/web/guides/fedcm-migration

### Verifying the ID token (Worker)
- JWKS: `https://www.googleapis.com/oauth2/v3/certs`. Keys rotate, so honour `Cache-Control`.
- Checks:
  - Signature.
  - `aud` = our client ID.
  - `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}.
  - `exp` not passed.
  - Plus our own: RS256, `iat`/`sub` required, max age 1 h, `email_verified === true`, `nonce` equals the signed nonce cookie.
- **Cookies as shipped (worker/session.ts, verified in tests 2026-11-21):**
  - Nonce: `__Host-cyt_n=<32 hex>.<expiry epoch>.<HMAC-SHA256(NONCE_KEY) hex>`; HttpOnly; Secure; SameSite=Lax; Path=/; 5 min. Returned as `{ nonce, clientId }` by `GET /api/auth/nonce` (`clientId` = the `GOOGLE_CLIENT_ID` var). Cleared after every sign-in attempt.
  - Session: `__Host-cyt_s=<32 random bytes, base64url>`; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600 (14 days); no Domain. D1 stores only SHA-256(token). Sign-in deletes the presented session first; at most 10 per user.
- **Email authority (affects admin matching):** Google is authoritative for an email only when it ends with `@gmail.com`, or when `email_verified` is true and `hd` is set (Workspace). For other addresses, Google says ownership "may have since changed". Rule: an `admin` entry matches only if the token's email is authoritative by this test. In every case, `admin.google_sub` is pinned on first sign-in.
- Use `sub` as the user key, never email ("Email is not a good choice because it can be changed by the user").
- GIS also sends a `g_csrf_token` cookie and body field, but only in `login_uri` (redirect) mode. We use the JS callback and POST JSON ourselves, so CSRF protection is our nonce plus `X-Requested-With` plus `Sec-Fetch-Site`.
- Source: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

### Embedded in-app browsers
- Google blocks OAuth in embedded webviews ("disallowed_useragent") since 2021-09-30.
- Source: https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/
- User-agent markers to detect (best-effort, case-insensitive). There is no official list, so test on real devices:
  - `Zalo`
  - `FBAN`, `FBAV`, `FB_IAB` (Facebook and Messenger)
  - `Instagram`
  - ` Line/`
  - `musical_ly`, `BytedanceWebview` (TikTok)
  - Android webview `; wv)`
- When detected, show the "Mở bằng Chrome/Safari" guide plus a copy-link button instead of the Google button.

### Cloudflare platform
- **Rate limiting binding:**
  - `limit({ key, delta? })`, where `key` can be any string.
  - `simple.period` is 10 or 60 s, counted per Cloudflare location, and approximate.
  - Cloudflare recommends user/tenant ids over IP keys because users share IPs.
  - Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- **Cache API:** needs a custom domain or route. It has no effect on `*.workers.dev`. Source: https://developers.cloudflare.com/r2/examples/cache-api/
- **Environments:**
  - `env.<name>` deploys as Worker `<name>-<env>`.
  - `vars`, D1 and other bindings, and `secrets` are **non-inheritable**: they must be repeated in `env.staging`. Assume `ratelimits` is non-inheritable too and verify with `wrangler deploy --dry-run --env staging`.
  - `secrets.required: string[]` lists secret names that must be set to deploy.
  - Sources: https://developers.cloudflare.com/workers/wrangler/environments/ and https://developers.cloudflare.com/workers/wrangler/configuration/ ("Non-inheritable keys").
- **Secrets, non-interactive:** `printf '%s' "$VALUE" | npx wrangler secret put NAME [--env staging]` (reads stdin). Use `npx wrangler secret bulk file.json` for several at once.
- **Git tag `sso-google-signin`** (commit 1c14767) is the starting point. Its CSP line still matches Google's current guidance (script/frame/connect/style as above). Its `jose` verification options match the list above, except that it does not use `nonce` and `requiredClaims`. Add both.

---

## Noel game core (Phase 2) — verified 2026-11-21

### Browser APIs (no animation or rendering library — ADR-4)
- **Web Animations API**: `el.animate(keyframes, { duration, easing, fill })` returns an `Animation`; await `animation.finished` to chain steps; `animation.commitStyles()` then `cancel()` keeps the end state without a lingering fill. Safari 13.1+ supports `animate()` and `finished`; `commitStyles` from Safari 13.1. Source: https://developer.mozilla.org/en-US/docs/Web/API/Element/animate, https://developer.mozilla.org/en-US/docs/Web/API/Animation/commitStyles
- **Drag + inertia**: Pointer Events (`pointerdown/move/up/cancel`) with `el.setPointerCapture(e.pointerId)`; CSS `touch-action: pan-y` on the scene so vertical page scroll still works while horizontal drags spin; velocity from the last ~100 ms of moves, then decay per `requestAnimationFrame` frame. Source: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events, https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
- **Pause when hidden**: stop the rAF loop and polling when `document.visibilityState === 'hidden'` (`visibilitychange` event). Source: https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState
- **Reduced motion**: `window.matchMedia('(prefers-reduced-motion: reduce)')` (`.matches`, `change` event) → no inertia, opacity-only transitions, snow off. Source: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion

### Default theme export (ADR-5) — no new dependency
Chromium encodes WebP from a canvas: `canvas.toDataURL('image/webp', 0.9)`. Run in headless Edge with `puppeteer-core` (present in `../phamhuuthien/node_modules`, not a dependency of this repo), decode the base64 and write the file. Checked: a 256×256 canvas with a transparent background gave a `RIFF…WEBPVP8X` file with the alpha flag set (`file`: "Web/P image"). Chromium adds an `ICCP` chunk (~0.5 KB); harmless for static assets (Phase 3 upload validation rejects ICCP, but default files are not uploads). Source: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL. The export script draws each slot from the shapes in `docs/design/noel-mockup.html` at the slot's exact pixel size.

### D1 batch = one transaction
`env.DB.batch([...])` runs the statements sequentially in one SQL transaction; if one fails the whole batch rolls back. So `INSERT OR IGNORE INTO heart … SELECT … WHERE …` followed by `UPDATE gift SET heart_count = (SELECT COUNT(*) …)` commits together, and a recount always matches the rows. Source: https://developers.cloudflare.com/d1/worker-api/d1-database/ (batch). Vietnam day bucket: `date('now','+7 hours')` (Asia/Ho_Chi_Minh has no DST).

### Reusing card v3 for gift cards
- `src/components/CardView.tsx` renders a teacher card: fixed "Kính gửi", the teacher name, `roleLabel(role, subject)` (which returns "Giáo viên" when both are empty) and the stamp "<site.title> · 20/11". Gifts need three optional props with the current values as defaults so 20/11 output is unchanged: `toLine` (greeting line; `null` hides it), `subLine` (overrides `roleLabel`; `null` hides it), `stamp`. Gift mapping: `card = { name: <heading, e.g. "Điều ước Giáng sinh">, subject: '', message }`, `from = "<nickname> · <class>"`, `stamp = "<site.title> · Noel"`, plus `layout`, `images.background`, `font`, `ink` from the gift.
- Server validation for gift text reuses `worker/submit.ts` rules: `shared/text.ts` (`hasControlCharsMultiline` for the message, `hasControlCharsSingleLine` for nickname/class, `hasLoneSurrogate`), NFC + trim, code-point lengths, `MAX_NEWLINES`; `shared/fonts.ts` (`isFont`, `isInkInput`, `normalizeInk`); layout ids from `shared/layouts.ts`. Gift limits: message 1–`MAX_MESSAGE` (300), nickname 1–30, class ≤ 10.
- Gift backgrounds are templates of the gift's campaign. Until Phase 2, every template has `campaign_id = 1`; Phase 2 adds a campaign choice to the template admin form, `GET /api/campaigns/<slug>/templates`, and filters the 20/11 template list to campaign 1 (same output today).


## Noel Game Core (Phase 2)

### Pure Frontend Modules (No DOM Dependency)

Verified 2026-11-21 for performance and accessibility.

- **`src/game/cone.ts`** — 2.5D conical projection: given slot index i (0 … N-1), returns { x, depth, scale, opacity }. Input: cone angle φ (radians, from drag/keyboard), tree_slots (5–25), ground_slots (0–15). Output: screen x (in px, from centre), depth z (0.0 visible, 1.0 far, <0 behind tree), scale, opacity. Tested: no overlaps on the tree between any two slots with tree_slots ≥ 5; ground slots stack below with ≤ 35px min gap.
- **`src/game/rank.ts`** — Ranking: 30 gifts (sorted by hearts DESC, created_at ASC, id ASC) → { tree: [ranks 1–15], ground: [16–25], list: [26–30] }. No ties; ordering stable under additions/removals.
- **`src/game/spin.ts`** — Drag-to-rotate state: { velocity, angle, inertia }. Input: pointer events, keyboard ←/→, requestAnimationFrame dt. Output: current angle φ and decayed velocity. Prefers-reduced-motion disables inertia (linear stop). Inertia decay: 0.96^(dt/16) per frame (exponential).
- **`src/game/poll.ts`** — Polling loop state machine (one-shot init, in-flight check, generation guard, visibility pause/resume, backoff on errors, abort, cleanup). Used for `/api/me` and `/api/campaigns/<slug>/tree` fetches every 15 ± 3 s. No fetch itself; caller provides the fetcher.
- **`src/game/dialogFocus.ts`** (or `useDialog.ts`) — Dialog focus trap and return-focus manager. Extracted from DOM context for reusability and testing without a DOM library.
- **`src/game/gesture.ts`** — Tap-vs-drag threshold (~6 px) and capture logic, zero-velocity-on-grab. Pure state, no DOM side-effects.
- **`src/game/paging.ts`** — Paginated list reducer: { items, page, total, loading, error }. Stale-response guard: update only if page >= current page. Retry state. Stop at page 50.

### Browser APIs Used (Verified)

- **Web Animations API:** `Element.animate({ keyframes }, options)` → `Animation` with `finished` promise. Used for gift-box opening, star twinkle, finale. `prefers-reduced-motion: reduce` detected via `matchMedia` → animations use opacity/fade only, no transform. Safari 16+, Edge, Chrome. Source: https://developer.mozilla.org/en-US/docs/Web/API/Element/animate
- **Pointer Events:** `pointerdown`, `pointermove`, `pointerup` (vs touch + mouse separately). `setPointerCapture(pointerId)` for drag tracking. `touch-action: none` on draggable elements. Source: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
- **Canvas particles:** `OffscreenCanvas` (if available) or `<canvas>` → `toDataURL('image/webp', quality)` for export. Snow ≤ 120 particles, paused when `document.hidden === true` (user switched tabs). Source: https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL
- **Media queries:** `matchMedia('(prefers-reduced-motion: reduce)')` → boolean. Used to disable inertia, animations; all text rendered regardless. Source: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- **Request animation frame:** `requestAnimationFrame(callback)` for smooth 60 Hz render loop. Callback stopped when `document.visibilityState === 'hidden'`. Source: https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame

### Default Theme (Static Files)

Shipped in `public/theme/gift_tree/default/` (copied into `dist/` at build time, served by Cloudflare CDN).

**Export method (verified 2026-11-21):**

Original mockup HTML (`docs/design/noel-mockup.html`) is designed in Figma/Penpot. Layers exported to separate PNGs, each layer composited to the exact slot size using:
- Photopea / Figma export: per-layer PNG with transparency where specified
- Browser canvas render (from mockup HTML or a dev script): draw each layer, `canvas.toDataURL('image/webp', 0.9)` → base64 → file

Example command (verified to produce valid WebP):

```bash
# In-browser via Node + puppeteer-core or browser DevTools console:
const canvas = document.getElementById('noel-mockup'); // your canvas id
const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9));
const uint8 = new Uint8Array(await blob.arrayBuffer());
// Write uint8 to public/theme/gift_tree/default/<slot>.webp

# Verify the file:
file public/theme/gift_tree/default/sky_portrait.webp
# Expected: "WebP image data, 1080 x 1920, …"
```

**Slot list (from plan):**

| Slot | Size | Format | Transparent | Max | Notes |
|---|---|---|---|---|---|
| sky_portrait | 1080×1920 | PNG/WebP | no | 600 KB | Phone background |
| sky_landscape | 1920×1080 | PNG/WebP | no | 600 KB | Desktop background |
| layer_ground | 1920×500 | PNG/WebP | yes | 400 KB | Snow/floor overlay |
| tree | 1200×1600 | PNG/WebP | yes | 800 KB | Tree (no ornaments) |
| star | 256×256 | PNG/WebP/GIF | yes | 300 KB | Star on tip |
| ornament_1…6 | 256×256 | PNG/WebP | yes | 150 KB | 6 styles |
| box_1…6_closed | 512×512 | PNG/WebP | yes | 200 KB | 6 closed box styles |
| box_1…6_open | sprite grid (cells 512×512, ≤2048×2048) | PNG/WebP | yes | 1 MB | Box opening animation |

**Code-drawn animations:**

- Star twinkle: CSS keyframe (opacity 0.3…1.0) or WAAPI with sine easing
- Box open: sprite grid player (frame count = cols × rows) at 12–30 fps (configurable per upload)
- Snow loop: canvas particles (≤120) with falling + wind drift
- All animations respect `prefers-reduced-motion: reduce` (reduced-motion → static final frame or fade only)

### Bundle Sizes (Measured 2026-11-21)

**Main bundle (gzip):** ~120 KB (includes React, Vite runtime, all pages)
**Noel page lazy chunk (gzip):** ~9 KB (game, flows, moderation UI combined)
**Total added by Noel:** ~9 KB over the base 20/11 size (card-page libraries reused)

No animation library added (Web Animations API built-in).

### Rate-Limit Bindings (Phase 2)

New rate-limit classes in `wrangler.jsonc` (production namespace_id 2000s, staging 3000s):

| Binding | Limit | Namespace | Used On |
|---|---|---|---|
| GIFT_LIMIT | 6/60 s per user | 2011 (prod), 3011 (staging) | `POST /api/campaigns/<slug>/gifts` |
| HEART_LIMIT | 20/60 s per user | 2012 (prod), 3012 (staging) | `POST /api/gifts/<publicId>/heart` |
| REPORT_LIMIT | 10/60 s per user | 2013 (prod), 3013 (staging) | `POST /api/gifts/<publicId>/report` |
| TREE_READ_LIMIT | 3,000/60 s per IP | 2014 (prod), 3014 (staging) | `GET /api/campaigns/<slug>/tree` (cache miss only) |
| LIST_READ_LIMIT | 300/60 s per IP | 2015 (prod), 3015 (staging) | `GET /api/campaigns/<slug>/gifts` (cache miss), `GET /api/gifts/<publicId>` |

All checked BEFORE database queries. Tree and list reads hit the cache first (memoised per isolate for 5 s), so cache hits do not count against limits.

### Conditional Write Pattern (Used for Hearts, Reports, Auto-Hide)

One-batch atomicity with diagnosis:

```sql
-- Worker pseudocode for POST /api/gifts/:id/heart:
BEGIN TRANSACTION;
INSERT OR IGNORE INTO heart (gift_id, user_id, day, created_at)
SELECT ?, ?, date('now', '+7 hours'), datetime('now')
WHERE
  EXISTS(SELECT 1 FROM gift WHERE id = ? AND campaign_id = ? AND status = 'visible')
  AND NOT EXISTS(SELECT 1 FROM app_user WHERE id = ? AND banned = 1)
  AND NOT EXISTS(SELECT 1 FROM heart WHERE gift_id = ? AND user_id = ?)
  AND (SELECT COUNT(*) FROM heart WHERE user_id = ? AND day = date('now', '+7 hours')) < 5;

UPDATE gift SET heart_count = (SELECT COUNT(*) FROM heart WHERE gift_id = ?) WHERE id = ?;
COMMIT;

-- If INSERT changed 0 rows, check each diagnosis in order:
if meta.changes === 0:
  if NOT EXISTS(gift) → gift_not_found (404)
  else if campaign.status !== 'active' OR NOT BETWEEN dates → campaign_closed (409)
  else if user.banned → banned (403)
  else if EXISTS(own_gift) → own_gift (403)
  else if EXISTS(previous_heart) → already_hearted (409)
  else if heart_count >= hearts_per_day → hearts_exhausted (429)
```

Ensures: even under concurrent requests, `heart_count = COUNT(heart)` always (recount is idempotent), and the client gets the right error code on first try.

### Text Validation (Shared Worker & Client)

All gift text validated by `shared/gift.ts:validateGiftText({ message, nickname, className })`:

```typescript
// Returns { ok: true, value: { message, nickname, className } } or { ok: false, field: '...' }
// Applies to every field:
//   - Unicode NFC normalisation + trim
//   - Code-point length check (not UTF-16)
//   - Reject empty after trim
//   - Reject control chars (except \n in message), bidi-override, zero-width, lone surrogates
//
// message: 1–300 code points, multiline (max 5 \n), required
// nickname: 1–30 code points, single-line, required
// className: 0–10 code points, single-line, optional (empty string valid)
```

Used on gift create, also by client-side form validation (`src/game/createGiftValidation.ts`).


## Password hashing on Workers (accounts, Phase 2b) — verified 2026-11-22

- **API**: WebCrypto, no dependency.
  ```ts
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  ```
  Same call works in Node 22 (`globalThis.crypto.subtle`) and workerd.
- **workerd cap**: production Workers refuse more than 100,000 iterations (`NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested N)`). The cap is **production-only**: local `wrangler dev` (workerd 1.20261103.1) accepted 50,000, 100,000 and 100,001 on 2026-11-22, so a local test cannot catch a value above the cap — keep the constant ≤ 100,000 by test. Sources: [Cloudflare community](https://community.cloudflare.com/t/configure-pbkdf2-iteration-cap/848334), [Nantoka PRESS](https://nantokapress.com/workers-pbkdf2-iteration-limit/) ("only in production"), proposal to raise it: [workerd PR #7550](https://github.com/cloudflare/workerd/pull/7550) (status not verified).
- **CPU budget**: Workers Free = 10 ms CPU per HTTP request, Paid = 30 s default; D1 waits do not count ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Isolates tolerate occasional overruns; consistent overruns return error 1102.
- **Measured (Node 22, Apple silicon, PBKDF2-SHA256, 32-byte output)**: 10k = 0.8 ms, 25k = 1.8 ms, 50k = 3.6 ms, 100k = 7.1 ms. Chosen: 50,000, stored per credential, rehash on login when raised.
- **Test vector** (RFC 7914 §11): P = "passwd", S = "salt", c = 1, dkLen = 64 → `55 ac 04 6e 56 e3 08 9f ec 16 91 c2 25 44 b6 05 f9 41 85 21 6d de 04 65 e6 8b 9d 57 c2 0d ac bc 49 ca 9c cc f1 79 b6 45 99 16 64 b3 9d 77 ef 31 7c 71 b8 45 b1 e3 0b d5 09 11 20 41 d3 a1 97 83`.
- **Constant-time compare**: XOR-accumulate over the fixed 32 bytes. `crypto.subtle.timingSafeEqual` exists in workerd (probe 2026-11-22) but not in Node's WebCrypto, and tests run in Node.
- **Normalisation**: passwords are `String.prototype.normalize('NFC')` before length checks, the common-password check and hashing (Vietnamese keyboards emit NFC or NFD).
- **Common-password list**: `worker/commonPasswords.ts` (Worker only, so the browser bundle does not grow). Source: SecLists `Passwords/Common-Credentials/10k-most-common.txt`, MIT licence (Copyright (c) 2018 Daniel Miessler), filtered to the 2,087 entries of ≥ 8 characters (shorter ones fail the length rule anyway), plus Vietnamese/school additions (`anhyeuem`, `emyeuanh`, `matkhau123`, `tenloman`, …). Downloaded 2026-11-22 from `https://raw.githubusercontent.com/danielmiessler/SecLists/master/…`; the licence notice is kept in the file header.
- **`Sec-Fetch-Site`**: values `same-origin`, `same-site`, `cross-site`, `none`; a same-origin `fetch` sends `same-origin`; sent only to potentially trustworthy (HTTPS/localhost) URLs and Baseline since March 2023, so absence means an old browser or a non-browser client ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site)). Account endpoints accept `same-origin` or absent.
- **Rate-limit binding**: `limit({ key, delta? })` → `{ success }`; a successful call counts, a refused one does not; there is no read-only check; counts are approximate and per Cloudflare location ([Workers rate limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), page updated 2026-11-12). So any limit meant to bound hashing must be called before the hash.
- **IPv6 /64 key**: `CF-Connecting-IP` holds the client address as text (IPv4 dotted or IPv6). Key = IPv4 as is; IPv6 → expand `::`, take the first four 16-bit groups, join with `:` and append `::/64`. Pure function `ipKey()` in `worker/accounts.ts`, unit-tested.

## Theme image inspection and storage (Noel, Phase 3, 2026-11-23)

- **Scope:** static PNG, JPEG and WebP only. Animated files, sprite grids and overlays are not accepted yet.
- **Metadata** (EXIF, XMP, text chunks, comments) is refused. PNG: `eXIf`, `tEXt`, `zTXt`, `iTXt` chunks. JPEG: APP1, APP13 and COM
  segments before the scan, plus an Exif/XMP signature search over the whole file. The 20/11 parsers only flag EXIF, so the theme path adds this check.
- **Format is read from bytes, not the file name or the Content-Type header.** Magic bytes first, then
  `worker/themeInspect.ts` reads the header:
  - PNG: IHDR width and height, colour type 4 or 6 or a `tRNS` chunk means alpha, an `acTL` chunk means animated, an `eXIf` chunk means EXIF.
  - WebP: VP8X flags (bit 0x10 alpha, 0x02 animation), VP8L alpha bit (bit 28 of the u32 at offset 21), `ANIM`/`ANMF` chunks mean animated, `EXIF` and `XMP ` chunks are metadata. `ICCP` (colour profile) is allowed.
  - JPEG: SOF0–SOF15 (except DHT, JPG, DAC) give the size. JPEG has no alpha. An APP1 `Exif` segment means EXIF.
- **Dimensions** reuse `checkDimensions` and `magicOk` from `worker/images.ts` (20/11 image library).
- **Storage:** D1 table `theme_image` with base64 `data`. Size CHECK ≤ 1,048,576 bytes per row (largest slot is 800 KB).
  The per-campaign total (15,728,640 bytes) is checked inside the INSERT, and the old row of the same slot
  is deleted in the same `DB.batch` (D1 batches are transactional).
- **Serving:** `GET /api/theme-image/<32 hex>` runs `IMAGE_IP_LIMIT` first, then the Cache API (200s only), then D1. It returns the bytes with the stored MIME,
  `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` and `X-Robots-Tag: noindex`. The token is random (16 bytes), so the URL is not guessable.
- **Read cost:** `GET /api/campaigns/<slug>` adds a `theme` map (slot → URL). It does not read the `data` column.
- Source: `worker/themeInspect.ts`, `worker/themes.ts`, `shared/themeSlots.ts`. The chunk rules are covered by
  `worker/themeInspect.test.ts`. The byte layouts were written from the format notes, not re-checked against the
  published specs; review them against the PNG and WebP specs before relying on them for untrusted files.


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

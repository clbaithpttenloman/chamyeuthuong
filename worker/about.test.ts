// @vitest-environment node
/**
 * Tests for worker/about.ts and worker/aboutSeed.ts
 *
 * ALL tests fail until Group 2 creates these modules.
 *
 * Contracts expected:
 *   worker/about.ts:
 *     handleAbout(request: Request, env: Env): Promise<Response>
 *       — handles GET /api/about (public, rate-limited via PUBLIC_IP_LIMIT)
 *     handleAdminAbout(request: Request, env: Env, email: string): Promise<Response>
 *       — handles GET /api/admin/about and PUT /api/admin/about (admin-auth already checked)
 *
 *   worker/aboutSeed.ts:
 *     ABOUT_SEED: AboutContent — the seed content constant
 *     aboutSeedSql(): string — returns INSERT OR IGNORE SQL for the about seed row
 */
import { describe, it, expect, beforeEach } from 'vitest'

// These imports fail until Group 2 creates the modules → all tests fail
import { handleAbout, handleAdminAbout } from './about.ts'
import { ABOUT_SEED, aboutSeedSql } from './aboutSeed.ts'
import { testDb, type D1 } from './testDb.ts'
import type { AboutContent } from '../shared/api.ts'
import {
  ABOUT_HEADING_MAX, ABOUT_INTRO_MAX, ABOUT_STATS_MAX, ABOUT_STAT_VALUE_MAX,
  ABOUT_STAT_LABEL_MAX, ABOUT_STEPS_MAX, ABOUT_STEP_WHEN_MAX, ABOUT_STEP_TEXT_MAX,
  ABOUT_MEMBERS_MAX, ABOUT_MEMBER_NAME_MAX, ABOUT_MEMBER_ROLE_MAX, ABOUT_NEWLINES_MAX,
  ABOUT_BODY_MAX,
} from '../shared/api.ts'

const TEST_EMAIL = 'admin@test.com'

function makePublicEnv(db: D1, opts: { ipLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.ipLimit ?? true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const VALID_ABOUT: AboutContent = {
  heading: 'CLB AI - THPT Test',
  intro: 'Giới thiệu về câu lạc bộ.',
  stats: [{ value: '2', label: 'ngày phát triển' }],
  stepsHeading: 'Quá trình',
  steps: [{ when: '16/11/2026', title: 'Khởi tạo', text: '' }],
  membersHeading: 'Thành viên',
  members: [{ name: 'Vũ Ngọc Diệp', role: 'Chủ nhiệm CLB' }],
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
})

// ---- aboutSeed.ts ----

describe('aboutSeed — ABOUT_SEED constant', () => {
  it('ABOUT_SEED is an object with required keys', () => {
    expect(typeof ABOUT_SEED).toBe('object')
    expect(ABOUT_SEED).toHaveProperty('heading')
    expect(ABOUT_SEED).toHaveProperty('intro')
    expect(ABOUT_SEED).toHaveProperty('stats')
    expect(ABOUT_SEED).toHaveProperty('stepsHeading')
    expect(ABOUT_SEED).toHaveProperty('steps')
    expect(ABOUT_SEED).toHaveProperty('membersHeading')
    expect(ABOUT_SEED).toHaveProperty('members')
  })

  it('ABOUT_SEED.members contains "Vũ Ngọc Diệp"', () => {
    const names = ABOUT_SEED.members.map((m: { name: string }) => m.name)
    expect(names).toContain('Vũ Ngọc Diệp')
  })

  it('ABOUT_SEED.members contains "Kiro Coding Agent"', () => {
    const names = ABOUT_SEED.members.map((m: { name: string }) => m.name)
    expect(names).toContain('Kiro Coding Agent')
  })

  it('ABOUT_SEED has at least 8 steps', () => {
    expect(Array.isArray(ABOUT_SEED.steps)).toBe(true)
    expect(ABOUT_SEED.steps.length).toBeGreaterThanOrEqual(8)
  })
})

describe('aboutSeed — aboutSeedSql()', () => {
  it('returns a string starting with INSERT OR IGNORE', () => {
    const sql = aboutSeedSql()
    expect(typeof sql).toBe('string')
    expect(sql.trim().toUpperCase()).toMatch(/^INSERT OR IGNORE/)
  })

  it('SQL targets the site_content table', () => {
    expect(aboutSeedSql()).toContain('site_content')
  })

  it('SQL contains key = \'about\'', () => {
    expect(aboutSeedSql()).toContain("'about'")
  })

  it('round-trips a value containing a single apostrophe through the SQL generator', () => {
    // The seed generator must escape single quotes by doubling them (SQL standard).
    // We verify by executing the generated SQL against a real SQLite DB.
    const { sqlite } = testDb()
    // Create the site_content table in SQLite
    sqlite.exec(`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY CHECK (key IN ('about')),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`)
    // Execute the seed SQL — if apostrophes are unescaped, this will throw a syntax error.
    expect(() => sqlite.exec(aboutSeedSql())).not.toThrow()
    // Verify the row is present and parses as JSON
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    expect(row).toBeDefined()
    expect(() => JSON.parse(row!.value)).not.toThrow()
  })

  it('seed content survives a JSON round-trip (parse then stringify then parse → same shape)', () => {
    const sql = aboutSeedSql()
    // Extract the JSON value from the SQL — it should be valid JSON inside the SQL string.
    // Run against SQLite to get the actual stored value.
    const { sqlite } = testDb()
    sqlite.exec(`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY CHECK (key IN ('about')),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`)
    sqlite.exec(sql)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string }
    const parsed = JSON.parse(row.value) as AboutContent
    expect(parsed).toMatchObject({ heading: expect.any(String), intro: expect.any(String) })
  })

  it('aboutSeedSql accepts custom content with apostrophe and stores heading correctly', () => {
    // Verify the builder accepts content with a single-quote (apostrophe) and round-trips it.
    // This fails until aboutSeedSql takes a content parameter.
    const customContent: AboutContent = { ...ABOUT_SEED, heading: "it's a test" }
    const sql = aboutSeedSql(customContent)
    // Use schema:false so the about seed from schema.ts doesn't block INSERT OR IGNORE
    const { sqlite } = testDb({ schema: false })
    sqlite.exec(`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY CHECK (key IN ('about')),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`)
    sqlite.exec(sql)
    const row = sqlite.prepare("SELECT value FROM site_content WHERE key = 'about'").get() as { value: string } | undefined
    expect(row).toBeDefined()
    const parsed = JSON.parse(row!.value) as AboutContent
    expect(parsed.heading).toBe("it's a test")
  })
})

// ---- GET /api/about — public endpoint ----

describe('GET /api/about — public (failing until Group 2)', () => {
  it('returns 200 with AboutContent shape', async () => {
    const r = await handleAbout(
      req('GET', '/api/about'),
      makePublicEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as AboutContent
    expect(body).toHaveProperty('heading')
    expect(body).toHaveProperty('intro')
    expect(Array.isArray(body.stats)).toBe(true)
    expect(body).toHaveProperty('stepsHeading')
    expect(Array.isArray(body.steps)).toBe(true)
    expect(body).toHaveProperty('membersHeading')
    expect(Array.isArray(body.members)).toBe(true)
  })

  it('returns seed content on a fresh DB (no PUT yet)', async () => {
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as AboutContent
    // Seed contains both required member names
    const names = body.members.map((m) => m.name)
    expect(names).toContain('Vũ Ngọc Diệp')
    expect(names).toContain('Kiro Coding Agent')
  })

  it('returns Cache-Control: no-store (sensitive content)', async () => {
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(db))
    expect(r.headers.get('Cache-Control')).toBe('no-store')
  })

  it('POST /api/about → 405', async () => {
    const r = await handleAbout(req('POST', '/api/about', {}), makePublicEnv(db))
    expect(r.status).toBe(405)
  })

  it('rate limit → 429', async () => {
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(db, { ipLimit: false }))
    expect(r.status).toBe(429)
  })

  it('corrupted JSON in DB → returns seed instead of 500', async () => {
    // Use schema: false and pre-create site_content with corrupted data.
    // handleAbout calls ensureSchema which uses INSERT OR IGNORE → won't overwrite.
    const { db: freshDb } = testDb({ schema: false })
    await freshDb.prepare(`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY CHECK (key IN ('about')),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`).run()
    await freshDb.prepare("INSERT INTO site_content (key, value, updated_at, updated_by) VALUES ('about', 'NOT VALID JSON', '2026-01-01', 'test')").run()
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(freshDb))
    // Must not 500; falls back to seed → 200
    expect(r.status).toBe(200)
    expect(() => r.json()).not.toThrow()
  })

  it('valid JSON but wrong shape in DB → falls back to seed', async () => {
    // Use schema: false and pre-create site_content with wrong-shape data.
    const { db: freshDb } = testDb({ schema: false })
    await freshDb.prepare(`CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY CHECK (key IN ('about')),
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    )`).run()
    // Insert valid JSON with wrong shape (missing required keys)
    await freshDb.prepare("INSERT INTO site_content (key, value, updated_at, updated_by) VALUES ('about', '{\"wrong\":\"shape\"}', '2026-01-01', 'test')").run()
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(freshDb))
    expect(r.status).toBe(200)
    const body = await r.json() as AboutContent
    // Falls back to seed which has the proper shape with the member names
    const names = body.members.map((m) => m.name)
    expect(names).toContain('Vũ Ngọc Diệp')
  })
})

// ---- GET /api/admin/about ----

describe('GET /api/admin/about (failing until Group 2)', () => {
  it('returns 200 with AboutContent shape', async () => {
    const r = await handleAdminAbout(
      req('GET', '/api/admin/about'),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as AboutContent
    expect(body).toHaveProperty('heading')
    expect(Array.isArray(body.members)).toBe(true)
  })
})

// ---- PUT /api/admin/about ----

describe('PUT /api/admin/about — validation (failing until Group 2)', () => {
  it('valid body → 200 and returns stored content', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', VALID_ABOUT),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as AboutContent
    expect(body.heading).toBe(VALID_ABOUT.heading)
  })

  it('PUT then GET returns updated content', async () => {
    await handleAdminAbout(req('PUT', '/api/admin/about', VALID_ABOUT), makePublicEnv(db), TEST_EMAIL)
    const r = await handleAbout(req('GET', '/api/about'), makePublicEnv(db))
    const body = await r.json() as AboutContent
    expect(body.heading).toBe(VALID_ABOUT.heading)
    expect(body.intro).toBe(VALID_ABOUT.intro)
  })

  it('updated_by is set to the caller email (asserted from site_content row)', async () => {
    await handleAdminAbout(req('PUT', '/api/admin/about', VALID_ABOUT), makePublicEnv(db), TEST_EMAIL)
    const row = await db
      .prepare("SELECT updated_by FROM site_content WHERE key = 'about'")
      .first<{ updated_by: string }>()
    expect(row?.updated_by).toBe(TEST_EMAIL)
  })

  it('heading too long → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, heading: 'a'.repeat(ABOUT_HEADING_MAX + 1) }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('heading empty → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, heading: '' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('intro too long → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro: 'a'.repeat(ABOUT_INTRO_MAX + 1) }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('intro empty → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro: '' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('too many stats → 400', async () => {
    const stats = Array.from({ length: ABOUT_STATS_MAX + 1 }, (_, i) => ({ value: String(i), label: 'x' }))
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, stats }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('stat value too long → 400', async () => {
    const stats = [{ value: 'a'.repeat(ABOUT_STAT_VALUE_MAX + 1), label: 'label' }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, stats }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('stat label too long → 400', async () => {
    const stats = [{ value: '1', label: 'a'.repeat(ABOUT_STAT_LABEL_MAX + 1) }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, stats }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('too many steps → 400', async () => {
    const steps = Array.from({ length: ABOUT_STEPS_MAX + 1 }, (_, i) => ({ when: '1/1', title: `s${i}`, text: '' }))
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, steps }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('step when too long → 400', async () => {
    const steps = [{ when: 'a'.repeat(ABOUT_STEP_WHEN_MAX + 1), title: 'T', text: '' }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, steps }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('step title too long → 400', async () => {
    const steps = [{ when: '1/1', title: 'a'.repeat(ABOUT_HEADING_MAX + 1), text: '' }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, steps }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('step text too long → 400', async () => {
    const steps = [{ when: '1/1', title: 'T', text: 'a'.repeat(ABOUT_STEP_TEXT_MAX + 1) }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, steps }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('too many members → 400', async () => {
    const members = Array.from({ length: ABOUT_MEMBERS_MAX + 1 }, (_, i) => ({ name: `n${i}`, role: 'r' }))
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, members }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('member name too long → 400', async () => {
    const members = [{ name: 'a'.repeat(ABOUT_MEMBER_NAME_MAX + 1), role: 'r' }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, members }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('member role too long → 400', async () => {
    const members = [{ name: 'n', role: 'a'.repeat(ABOUT_MEMBER_ROLE_MAX + 1) }]
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, members }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('stepsHeading too long → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, stepsHeading: 'a'.repeat(ABOUT_HEADING_MAX + 1) }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('membersHeading too long → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, membersHeading: 'a'.repeat(ABOUT_HEADING_MAX + 1) }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('unknown top-level key → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, unknownKey: 'value' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('non-object body → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', [1, 2, 3]),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('string body → 400', async () => {
    const r = await handleAdminAbout(
      new Request('https://x/api/admin/about', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: '"just a string"',
      }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('intro with control char (tab) → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro: 'text\twith\ttab' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('heading with invisible char (zero-width space) → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, heading: 'text\u200Binvisible' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('heading with newline → 400 (single-line field)', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, heading: 'line1\nline2' }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it(`intro with ${ABOUT_NEWLINES_MAX} newlines → 200 (at limit)`, async () => {
    const intro = 'a\n'.repeat(ABOUT_NEWLINES_MAX).trimEnd() + 'a'
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(200)
  })

  it(`intro with ${ABOUT_NEWLINES_MAX + 1} newlines → 400 (exceeds newline cap)`, async () => {
    const intro = 'a\n'.repeat(ABOUT_NEWLINES_MAX + 1) + 'a'
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('intro with lone surrogate → 400', async () => {
    const intro = 'valid\uD800invalid'
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, intro }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('PUT body with Content-Length > 16KB → 400', async () => {
    const r = await handleAdminAbout(
      new Request('https://x/api/admin/about', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(ABOUT_BODY_MAX + 1),
          'CF-Connecting-IP': '1.2.3.4',
        },
        body: '{}',
      }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('PUT body > 16KB (UTF-8 bytes) but ≤ 16KB (UTF-16 code units) without Content-Length → 400', async () => {
    // 'ề' is U+1EC1: 1 UTF-16 code unit, 3 UTF-8 bytes.
    // Build a valid About body where UTF-8 bytes > ABOUT_BODY_MAX but code units ≤ ABOUT_BODY_MAX.
    // 20 steps × 400 'ề' each = 8000 code units but 24000 UTF-8 bytes for text alone.
    const bigAbout = {
      ...VALID_ABOUT,
      intro: 'ề'.repeat(ABOUT_INTRO_MAX),
      steps: Array.from({ length: ABOUT_STEPS_MAX }, (_, i) => ({
        when: `${i + 1}/11`,
        title: 'Khởi tạo',
        text: 'ề'.repeat(ABOUT_STEP_TEXT_MAX),
      })),
    }
    const bodyStr = JSON.stringify(bigAbout)
    expect(new TextEncoder().encode(bodyStr).length).toBeGreaterThan(ABOUT_BODY_MAX)
    expect(bodyStr.length).toBeLessThanOrEqual(ABOUT_BODY_MAX)
    const r = await handleAdminAbout(
      new Request('https://x/api/admin/about', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: bodyStr,
      }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty stat value → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, stats: [{ value: '', label: 'label' }] }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty step title → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, steps: [{ when: '1/1', title: '', text: '' }] }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty member name → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, members: [{ name: '', role: 'role' }] }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('empty member role → 400', async () => {
    const r = await handleAdminAbout(
      req('PUT', '/api/admin/about', { ...VALID_ABOUT, members: [{ name: 'name', role: '' }] }),
      makePublicEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('GET /api/admin/about → 200 (method guard: not 405)', async () => {
    const r = await handleAdminAbout(req('GET', '/api/admin/about'), makePublicEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
  })

  it('DELETE /api/admin/about → 405', async () => {
    const r = await handleAdminAbout(req('DELETE', '/api/admin/about'), makePublicEnv(db), TEST_EMAIL)
    expect(r.status).toBe(405)
  })
})

describe('ABOUT_SEED content', () => {
  it('uses the school name "Ten Lơ Man" (never "Tên Lơ Man")', async () => {
    const { ABOUT_SEED } = await import('./aboutSeed.ts')
    const text = JSON.stringify(ABOUT_SEED)
    expect(text).toContain('THPT Ten Lơ Man')
    expect(text).not.toContain('Tên Lơ Man')
  })
  it('every timeline step has a description', async () => {
    const { ABOUT_SEED } = await import('./aboutSeed.ts')
    for (const s of ABOUT_SEED.steps) expect(s.text.trim().length).toBeGreaterThan(0)
  })
})

// ---- Marker scan: approved card data must NOT appear in /api/about ----

describe('GET /api/about — marker scan (card data must never leak)', () => {
  it('approved card message/from_name/from_class markers do NOT appear in /api/about response', async () => {
    const MSG_MARKER = 'UNIQUE_ABOUT_MSG_MARKER_49'
    const FROM_MARKER = 'UNIQUE_ABOUT_FROM_MARKER_50'
    const CLASS_MARKER = 'CLSABT9999'  // ≤ 10 chars (from_class column CHECK constraint)
    // Seed a teacher, template, and approved card with markers
    const now = new Date().toISOString()
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
      .bind('tok1234567890abc', 'Teacher', 'Math', now).run()
    const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 1).run()
    await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .bind('T', 'classic', 1, now, 'admin@test.com').run()
    const tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id
    await db.prepare(
      'INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).bind('crdmrkrabt123456', tid, tmplId, MSG_MARKER, FROM_MARKER, CLASS_MARKER, 0, 'approved', now).run()

    // PUT a valid about content first so the endpoint returns real content
    await handleAdminAbout(req('PUT', '/api/admin/about', VALID_ABOUT), makePublicEnv(db), TEST_EMAIL)

    const r = await handleAbout(
      req('GET', '/api/about'),
      makePublicEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.text()
    expect(body).not.toContain(MSG_MARKER)
    expect(body).not.toContain(FROM_MARKER)
    expect(body).not.toContain(CLASS_MARKER)
  })
})

// @vitest-environment node
/**
 * RED-phase tests for worker/tree.ts (Noel gift-tree read APIs).
 *
 * Contract:
 *   handleTree(request, env) handles:
 *
 *   GET /api/campaigns/<slug>/tree
 *       → { asOf: string, gifts: GiftItem[], totals: { visible: number } }
 *       Cache-Control: public, max-age=5; no Vary; no Set-Cookie.
 *       Rank = heart_count DESC, created_at ASC, id ASC.
 *       Each item carries:
 *         rank        (1-based integer)
 *         place       ('tree' for ranks 1..tree_slots; 'ground' for the next ground_slots)
 *         publicId, heartCount, nickname, className, boxStyle, ornamentStyle,
 *         layout, backgroundTemplateId, font, ink, message, createdAt
 *       Fields NOT present: id, user_id, email, google_sub.
 *       Memo keyed by validated slug (all query params ignored), TTL 5 s.
 *       Active-campaign slug is pinned in a separate slot (never evicted by FIFO).
 *       Unknown slugs → separate bounded 404 set (30 s, ≤ 32 entries).
 *       TREE_READ_LIMIT charged on cache misses only.
 *       Slug validated (regex + reserved words) BEFORE any DB or limiter call.
 *       Response body byte-identical for anonymous vs signed-in; never reads Cookie.
 *
 *   GET /api/campaigns/<slug>/gifts?sort=hearts|new&page=<n>
 *       → 24 items per page; page 1..50; page outside range → 400 bad_request.
 *       Hidden and deleted gifts excluded.
 *       PUBLIC_READ_LIMIT charged on every request.
 *
 *   GET /api/gifts/<publicId>
 *       → 200 with gift data for visible gifts.
 *       404 for hidden_auto/hidden_admin/deleted unless the requester is
 *       the owner (session cookie) or a Google admin.
 *
 * Tests import handleTree from ./tree.ts which does not exist yet.
 * All tests in this file fail at import (red phase). They pass once tree.ts is created.
 *
 * Column names assumed for gift/heart seeding (put in createGiftTables below).
 * If the schema task uses different names, update ONLY the SQL strings in this file.
 *
 *   gift:  id, public_id, campaign_id, user_id, box_style, ornament_style, layout,
 *          background_template_id, font, ink, message, nickname, class_name,
 *          heart_count, report_count, status, status_before_ban, created_at
 *   heart: gift_id, user_id, day, created_at  (PK: gift_id, user_id)
 */
import { describe, it, expect } from 'vitest'
// --- Module under test does not exist yet; import triggers red phase ---
import { handleTree } from './tree.ts'
import { testDb, type D1 } from './testDb.ts'
import { type DatabaseSync } from 'node:sqlite'
import {
  createNewTables,
  seedUser,
  seedSession,
  seedAdminEmail,
  makeRawToken,
  sha256Hex,
  SESSION_COOKIE_NAME,
  TEST_CLIENT_ID,
  TEST_NONCE_KEY,
} from './testGoogle.ts'

// ── Schema helpers ────────────────────────────────────────────────────────────

/**
 * Creates gift and heart tables on a bare sqlite handle obtained from testDb().
 * These tables are defined here (red-phase) so tests can seed data.
 * The schema task writes the production DDL; keep column names in sync.
 */
function createGiftTables(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gift (
      id                     INTEGER PRIMARY KEY,
      public_id              TEXT UNIQUE NOT NULL,
      campaign_id            INTEGER NOT NULL,
      user_id                INTEGER NOT NULL,
      box_style              INTEGER NOT NULL DEFAULT 1,
      ornament_style         INTEGER NOT NULL DEFAULT 1,
      layout                 TEXT    NOT NULL DEFAULT 'classic',
      background_template_id INTEGER,
      font                   TEXT    NOT NULL DEFAULT 'patrick-hand',
      ink                    TEXT    NOT NULL DEFAULT '#1d3fa6',
      message                TEXT    NOT NULL DEFAULT '',
      nickname               TEXT    NOT NULL DEFAULT '',
      class_name             TEXT    NOT NULL DEFAULT '',
      heart_count            INTEGER NOT NULL DEFAULT 0,
      report_count           INTEGER NOT NULL DEFAULT 0,
      status                 TEXT    NOT NULL DEFAULT 'visible'
                               CHECK (status IN ('visible','hidden_auto','hidden_admin','deleted')),
      status_before_ban      TEXT,
      created_at             TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gift_rank
      ON gift(campaign_id, status, heart_count DESC, created_at);
    CREATE TABLE IF NOT EXISTS heart (
      gift_id    INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      day        TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      PRIMARY KEY (gift_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_heart_user_day ON heart(user_id, day);
  `)
}

/**
 * Seeds a gift_tree campaign and returns its integer id.
 * Closes any existing active campaign first (the UNIQUE INDEX allows only one active).
 */
function seedGiftTreeCampaign(
  sqlite: DatabaseSync,
  opts: {
    slug?: string
    status?: 'active' | 'closed' | 'draft'
    settings?: string
  } = {},
): number {
  sqlite.prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active'").run()
  const slug = opts.slug ?? 'noel'
  const status = opts.status ?? 'active'
  const settings = opts.settings ?? JSON.stringify({
    tree_slots: 15, ground_slots: 10, hearts_per_day: 5,
    gifts_per_user: 3, report_threshold: 3,
  })
  sqlite.prepare(`
    INSERT INTO campaign
      (slug, kind, name, tagline, content, theme_colors, settings,
       starts_at, ends_at, status, created_at, created_by)
    VALUES (?, 'gift_tree', 'Noel', '', '{}', '{}', ?,
      '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', ?, datetime('now'), 'test')
  `).run(slug, settings, status)
  return (sqlite.prepare('SELECT id FROM campaign WHERE slug = ?').get(slug) as { id: number }).id
}

let _giftSeq = 0
/**
 * Seeds one gift row and returns its integer id and public_id.
 * Offset `createdAt` by _giftSeq microseconds so successive calls get distinct timestamps
 * and deterministic rank ordering by created_at.
 */
function seedGift(
  sqlite: DatabaseSync,
  opts: {
    campaignId: number
    userId: number
    heartCount?: number
    status?: string
    createdAt?: string
  },
): { id: number; publicId: string } {
  _giftSeq++
  const publicId = `g${String(_giftSeq).padStart(15, '0')}`
  // Space seeds 1 ms apart so rank-by-created_at is deterministic
  const now = opts.createdAt ?? new Date(Date.now() + _giftSeq).toISOString()
  sqlite.prepare(`
    INSERT INTO gift
      (public_id, campaign_id, user_id, box_style, ornament_style, layout,
       font, ink, message, nickname, class_name,
       heart_count, report_count, status, created_at)
    VALUES (?, ?, ?, 1, 1, 'classic', 'patrick-hand', '#1d3fa6',
            'msg', 'Nick', '11A', ?, 0, ?, ?)
  `).run(publicId, opts.campaignId, opts.userId, opts.heartCount ?? 0, opts.status ?? 'visible', now)
  const row = sqlite.prepare('SELECT id FROM gift WHERE public_id = ?').get(publicId) as { id: number }
  return { id: row.id, publicId }
}

// ── Env builder ───────────────────────────────────────────────────────────────

type TreeTestEnv = {
  DB: D1
  TREE_READ_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> }
  PUBLIC_READ_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> }
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY?: string
  ADMIN_LEGACY_LOGIN?: string
}

function makeTreeEnv(
  db: D1,
  opts: {
    treeLimitRef?: { calls: number }
    publicLimitRef?: { calls: number }
    treeLimitAllows?: boolean
    publicLimitAllows?: boolean
  } = {},
): TreeTestEnv {
  return {
    DB: db,
    TREE_READ_LIMIT: {
      limit: async () => {
        if (opts.treeLimitRef) opts.treeLimitRef.calls++
        return { success: opts.treeLimitAllows !== false }
      },
    },
    PUBLIC_READ_LIMIT: {
      limit: async () => {
        if (opts.publicLimitRef) opts.publicLimitRef.calls++
        return { success: opts.publicLimitAllows !== false }
      },
    },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    NONCE_KEY: TEST_NONCE_KEY,
  }
}

function treeReq(slug: string, extraQuery = '', cookie?: string): Request {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (cookie) headers['Cookie'] = cookie
  return new Request(`https://x/api/campaigns/${slug}/tree${extraQuery}`, { headers })
}

function giftsReq(slug: string, params: Record<string, string | number> = {}, cookie?: string): Request {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (cookie) headers['Cookie'] = cookie
  return new Request(`https://x/api/campaigns/${slug}/gifts${qs ? '?' + qs : ''}`, { headers })
}

function giftByIdReq(publicId: string, cookie?: string): Request {
  const headers: Record<string, string> = { 'CF-Connecting-IP': '1.2.3.4' }
  if (cookie) headers['Cookie'] = cookie
  return new Request(`https://x/api/gifts/${publicId}`, { headers })
}

// ── Tree basics ───────────────────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — shape and headers', () => {
  it('returns 200 { asOf, gifts, totals } with Cache-Control: public, max-age=5', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId, heartCount: 2 })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))

    expect(r.status).toBe(200)
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=5')
    const body = await r.json() as { asOf?: string; gifts?: unknown[]; totals?: unknown }
    expect(typeof body.asOf).toBe('string')
    expect(Array.isArray(body.gifts)).toBe(true)
    expect(body.totals).toBeDefined()
  })

  it('no Set-Cookie header on tree response', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))

    const h = r.headers as typeof r.headers & { getAll?: (n: string) => string[]; getSetCookie?: () => string[] }
    const setCookies = h.getAll?.('Set-Cookie') ?? h.getSetCookie?.() ?? (r.headers.get('Set-Cookie') ? [r.headers.get('Set-Cookie')!] : [])
    expect(setCookies.length).toBe(0)
  })

  it('no Vary header on tree response', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    expect(r.headers.get('Vary')).toBeNull()
  })

  it('non-gift_tree campaign slug → 404', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    // campaign 1 is teacher_cards (seeded by testDb)

    const r = await handleTree(treeReq('20-11'), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })
})

// ── Rank and placement (ADR-7, AC-11) ────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — rank order: hearts DESC, created_at ASC, id ASC', () => {
  it('gifts sorted by heart_count DESC when hearts differ', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)

    // Seed in arbitrary order; rank must be by hearts
    const { publicId: low } = seedGift(sqlite, { campaignId, userId, heartCount: 1 })
    const { publicId: high } = seedGift(sqlite, { campaignId, userId, heartCount: 10 })
    const { publicId: mid } = seedGift(sqlite, { campaignId, userId, heartCount: 5 })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { publicId: string; rank: number }[] }

    expect(gifts.find((g) => g.publicId === high)?.rank).toBe(1)
    expect(gifts.find((g) => g.publicId === mid)?.rank).toBe(2)
    expect(gifts.find((g) => g.publicId === low)?.rank).toBe(3)
  })

  it('ties broken by created_at ASC then id ASC', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)

    // All have equal hearts; earlier created_at wins
    const base = Date.now()
    const { publicId: first } = seedGift(sqlite, { campaignId, userId, heartCount: 3, createdAt: new Date(base).toISOString() })
    const { publicId: second } = seedGift(sqlite, { campaignId, userId, heartCount: 3, createdAt: new Date(base + 1000).toISOString() })
    const { publicId: third } = seedGift(sqlite, { campaignId, userId, heartCount: 3, createdAt: new Date(base + 2000).toISOString() })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { publicId: string; rank: number }[] }

    expect(gifts.find((g) => g.publicId === first)?.rank).toBe(1)
    expect(gifts.find((g) => g.publicId === second)?.rank).toBe(2)
    expect(gifts.find((g) => g.publicId === third)?.rank).toBe(3)
  })

  it('AC-11: 30 gifts → response has exactly tree_slots + ground_slots items (25)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite, {
      settings: JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 10, report_threshold: 3 }),
    })

    const base = Date.now()
    for (let i = 0; i < 30; i++) {
      seedGift(sqlite, { campaignId, userId, heartCount: 30 - i, createdAt: new Date(base + i).toISOString() })
    }

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { rank: number; place: string }[] }

    expect(gifts).toHaveLength(25) // tree_slots=15 + ground_slots=10
  })

  it('AC-11: ranks 1–15 have place=tree, ranks 16–25 have place=ground', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite, {
      settings: JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 10, report_threshold: 3 }),
    })

    const base = Date.now()
    for (let i = 0; i < 30; i++) {
      seedGift(sqlite, { campaignId, userId, heartCount: 30 - i, createdAt: new Date(base + i).toISOString() })
    }

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { rank: number; place: string }[] }

    for (const g of gifts) {
      if (g.rank <= 15) expect(g.place).toBe('tree')
      else expect(g.place).toBe('ground')
    }
  })

  it('gifts with rank > tree_slots + ground_slots are NOT in the tree response', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite, {
      settings: JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 10, report_threshold: 3 }),
    })

    const base = Date.now()
    const publicIds: string[] = []
    for (let i = 0; i < 30; i++) {
      const { publicId } = seedGift(sqlite, { campaignId, userId, heartCount: 30 - i, createdAt: new Date(base + i).toISOString() })
      publicIds.push(publicId)
    }
    // ranks 26..30 are the last 5 in insertion order
    const rank26to30 = publicIds.slice(25)

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { publicId: string }[] }

    for (const pid of rank26to30) {
      expect(gifts.some((g) => g.publicId === pid)).toBe(false)
    }
  })
})

// ── Public fields (ADR-8 NFR-6) ──────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — public fields only', () => {
  it('no id, user_id, email, google_sub in any gift item', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId, heartCount: 1 })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: Record<string, unknown>[] }

    expect(gifts.length).toBeGreaterThan(0)
    for (const g of gifts) {
      expect('id' in g).toBe(false)
      expect('user_id' in g).toBe(false)
      expect('userId' in g).toBe(false)
      expect('email' in g).toBe(false)
      expect('google_sub' in g).toBe(false)
      expect('googleSub' in g).toBe(false)
    }
  })

  it('each gift item has rank (integer ≥ 1) and place (tree|ground)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId, heartCount: 1 })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { rank: unknown; place: unknown }[] }

    expect(gifts.length).toBeGreaterThan(0)
    for (const g of gifts) {
      expect(typeof g.rank).toBe('number')
      expect((g.rank as number) >= 1).toBe(true)
      expect(g.place === 'tree' || g.place === 'ground').toBe(true)
    }
  })

  it('each gift item has publicId (string)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
    const { gifts } = await r.json() as { gifts: { publicId: unknown }[] }

    for (const g of gifts) {
      expect(typeof g.publicId).toBe('string')
      expect((g.publicId as string).length).toBeGreaterThan(0)
    }
  })
})

// ── Hidden / deleted exclusion ────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — hidden and deleted gifts excluded', () => {
  for (const status of ['hidden_auto', 'hidden_admin', 'deleted'] as const) {
    it(`${status} gift does not appear in tree response`, async () => {
      const { db, sqlite } = testDb()
      createNewTables(sqlite)
      createGiftTables(sqlite)
      const userId = await seedUser(db)
      const campaignId = seedGiftTreeCampaign(sqlite)
      const { publicId: visiblePid } = seedGift(sqlite, { campaignId, userId, heartCount: 10, status: 'visible' })
      const { publicId: hiddenPid } = seedGift(sqlite, { campaignId, userId, heartCount: 5, status })

      const r = await handleTree(treeReq('noel'), makeTreeEnv(db))
      const { gifts } = await r.json() as { gifts: { publicId: string }[] }

      expect(gifts.some((g) => g.publicId === visiblePid)).toBe(true)
      expect(gifts.some((g) => g.publicId === hiddenPid)).toBe(false)
    })
  }
})

// ── Memoisation (ADR-7) ───────────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — memo: same path repeated → one DB read per 5 s', () => {
  it('second identical request returns memo hit (prepares unchanged)', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const env = makeTreeEnv(db)
    // First call: cache miss, runs DB queries
    await handleTree(treeReq('noel'), env)
    const preparesAfterFirst = state.prepares

    // Second call within 5 s: should be a memo hit (zero new prepares)
    await handleTree(treeReq('noel'), env)
    expect(state.prepares).toBe(preparesAfterFirst)
  })

  it('?x=<random> query param is ignored — memo hit', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const env = makeTreeEnv(db)
    // First call with ?x=abc: miss
    await handleTree(treeReq('noel', '?x=abc'), env)
    const preparesAfterFirst = state.prepares

    // Second call with different ?x=xyz: must still be a memo hit
    await handleTree(treeReq('noel', '?x=xyz'), env)
    expect(state.prepares).toBe(preparesAfterFirst)
  })
})

// ── Slug validation before DB ─────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — slug validated before DB or limiter', () => {
  it('slug with uppercase chars → 404 with 0 DB prepares', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)

    const limiterCalls = { calls: 0 }
    const env = makeTreeEnv(db, { treeLimitRef: limiterCalls })
    const preparesBefor = state.prepares

    const r = await handleTree(treeReq('NOEL'), env)

    expect(r.status).toBe(404)
    expect(state.prepares).toBe(preparesBefor)   // no DB calls
    expect(limiterCalls.calls).toBe(0)           // no limiter call
  })

  it('reserved slug "admin" → 404 with 0 DB prepares', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)

    const limiterCalls = { calls: 0 }
    const env = makeTreeEnv(db, { treeLimitRef: limiterCalls })
    const preparesBefor = state.prepares

    const r = await handleTree(treeReq('admin'), env)

    expect(r.status).toBe(404)
    expect(state.prepares).toBe(preparesBefor)
    expect(limiterCalls.calls).toBe(0)
  })

  it('reserved slug "api" → 404 with 0 DB prepares', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)

    const limiterCalls = { calls: 0 }
    const env = makeTreeEnv(db, { treeLimitRef: limiterCalls })
    const preparesBefor = state.prepares

    const r = await handleTree(treeReq('api'), env)

    expect(r.status).toBe(404)
    expect(state.prepares).toBe(preparesBefor)
    expect(limiterCalls.calls).toBe(0)
  })
})

// ── Separate 404 set for unknown slugs ────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — unknown slugs cached as 404 without further DB hits', () => {
  it('unknown slug → 404', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(treeReq('no-such-campaign'), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })

  it('second request to same unknown slug does not cost a DB query', async () => {
    const { db, sqlite, state } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const env = makeTreeEnv(db)
    // First: miss, DB query to confirm not found
    await handleTree(treeReq('no-such-campaign'), env)
    const preparesAfterFirst = state.prepares
    expect(preparesAfterFirst).toBeGreaterThan(0)

    // Second: should be a 404-set hit, no new DB queries
    const r2 = await handleTree(treeReq('no-such-campaign'), env)
    expect(r2.status).toBe(404)
    expect(state.prepares).toBe(preparesAfterFirst)
  })
})

// ── TREE_READ_LIMIT ───────────────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/tree — TREE_READ_LIMIT charged on cache misses only', () => {
  it('cache miss → limiter called once', async () => {
    // Use two separate D1 bindings on the same SQLite so memo is fresh on the first call.
    const { sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const now = new Date().toISOString()
    const userId = (sqlite.prepare(
      'INSERT INTO app_user (google_sub, email, nickname, class_name, banned, created_at, last_seen_at) VALUES (?,?,?,?,0,?,?) RETURNING id',
    ).get('sub-lim', 'lim@gmail.com', 'Lim', '11A', now, now) as { id: number }).id
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const { db } = testDb({ shareWith: sqlite })
    const limiterCalls = { calls: 0 }
    const env = makeTreeEnv(db, { treeLimitRef: limiterCalls })

    await handleTree(treeReq('noel'), env)
    expect(limiterCalls.calls).toBe(1) // miss → charged
  })

  it('cache hit → limiter NOT called', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const limiterCalls = { calls: 0 }
    const env = makeTreeEnv(db, { treeLimitRef: limiterCalls })

    // Warm the memo
    await handleTree(treeReq('noel'), env)
    const callsAfterFirst = limiterCalls.calls

    // Second request: memo hit, limiter must NOT be called again
    await handleTree(treeReq('noel'), env)
    expect(limiterCalls.calls).toBe(callsAfterFirst)
  })

  it('exhausted TREE_READ_LIMIT → 429 on cache miss', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const env = makeTreeEnv(db, { treeLimitAllows: false })
    const r = await handleTree(treeReq('noel'), env)
    expect(r.status).toBe(429)
  })
})

// ── Byte-identical for anonymous vs signed-in (ADR-7) ────────────────────────

describe('GET /api/campaigns/<slug>/tree — byte-identical body regardless of session cookie', () => {
  it('anonymous and signed-in responses have the same body', async () => {
    // Use the same SQLite but two separate D1 bindings (different memos) to force DB reads on both.
    const { sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const now = new Date().toISOString()
    const userId = (sqlite.prepare(
      'INSERT INTO app_user (google_sub, email, nickname, class_name, banned, created_at, last_seen_at) VALUES (?,?,?,?,0,?,?) RETURNING id',
    ).get('anon-cmp-sub', 'anon@gmail.com', 'Anon', '11A', now, now) as { id: number }).id
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId, heartCount: 7 })

    // db1 and db2: separate D1 bindings on the same underlying sqlite (different memos)
    const { db: db1 } = testDb({ shareWith: sqlite })
    // db2: second D1 binding on the same underlying sqlite (different memo)
    const { db: db2 } = testDb({ shareWith: sqlite })

    const rawToken = makeRawToken()
    // Seed a session for the user
    const hash = await sha256Hex(rawToken)
    const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    sqlite.prepare('INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)').run(hash, userId, expires, new Date().toISOString(), 'testhash')

    const anonReq = treeReq('noel')
    const signedReq = treeReq('noel', '', `${SESSION_COOKIE_NAME}=${rawToken}`)

    const r1 = await handleTree(anonReq, makeTreeEnv(db1))
    const r2 = await handleTree(signedReq, makeTreeEnv(db2))

    const body1 = await r1.text()
    const body2 = await r2.text()
    expect(body1).toBe(body2)
  })

  it('signed-in tree response has no Set-Cookie header', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })
    const rawToken = makeRawToken()
    const hash = await sha256Hex(rawToken)
    sqlite.prepare('INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)').run(hash, userId, new Date(Date.now() + 1e10).toISOString(), new Date().toISOString(), 'h')

    const r = await handleTree(treeReq('noel', '', `${SESSION_COOKIE_NAME}=${rawToken}`), makeTreeEnv(db))

    const h = r.headers as typeof r.headers & { getAll?: (n: string) => string[]; getSetCookie?: () => string[] }
    const sc = h.getAll?.('Set-Cookie') ?? h.getSetCookie?.() ?? []
    expect(sc.length).toBe(0)
  })
})

// ── Gift list (/gifts) ────────────────────────────────────────────────────────

describe('GET /api/campaigns/<slug>/gifts — pagination', () => {
  it('returns at most 24 gifts per page', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    for (let i = 0; i < 30; i++) seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 1 }), makeTreeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as { gifts?: unknown[] }
    expect(Array.isArray(body.gifts)).toBe(true)
    expect((body.gifts as unknown[]).length).toBeLessThanOrEqual(24)
  })

  it('page=51 → 400 bad_request', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 51 }), makeTreeEnv(db))
    expect(r.status).toBe(400)
    const body = await r.json() as { error?: string }
    expect(body.error).toBe('bad_request')
  })

  it('page=0 → 400 bad_request', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 0 }), makeTreeEnv(db))
    expect(r.status).toBe(400)
  })

  it('page=50 → 200 (valid boundary)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 50 }), makeTreeEnv(db))
    expect(r.status).toBe(200)
  })

  it('page=1 is the default when page param is absent', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(giftsReq('noel', { sort: 'hearts' }), makeTreeEnv(db))
    expect(r.status).toBe(200)
  })

  it('sort=hearts is accepted', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 1 }), makeTreeEnv(db))
    expect(r.status).toBe(200)
  })

  it('sort=new is accepted', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    seedGift(sqlite, { campaignId, userId })

    const r = await handleTree(giftsReq('noel', { sort: 'new', page: 1 }), makeTreeEnv(db))
    expect(r.status).toBe(200)
  })

  it('hidden and deleted gifts excluded from list', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)

    const { publicId: visiblePid } = seedGift(sqlite, { campaignId, userId, status: 'visible' })
    const { publicId: hiddenPid } = seedGift(sqlite, { campaignId, userId, status: 'hidden_auto' })

    const r = await handleTree(giftsReq('noel', { sort: 'hearts', page: 1 }), makeTreeEnv(db))
    const body = await r.json() as { gifts: { publicId: string }[] }

    expect(body.gifts.some((g) => g.publicId === visiblePid)).toBe(true)
    expect(body.gifts.some((g) => g.publicId === hiddenPid)).toBe(false)
  })
})

// ── Gift by public id ─────────────────────────────────────────────────────────

describe('GET /api/gifts/<publicId>', () => {
  it('visible gift → 200 with public fields', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'visible' })

    const r = await handleTree(giftByIdReq(publicId), makeTreeEnv(db))
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    // Public fields present
    expect(body.publicId).toBe(publicId)
    // Private fields absent
    expect('id' in body).toBe(false)
    expect('user_id' in body).toBe(false)
    expect('userId' in body).toBe(false)
  })

  it('hidden_auto gift → 404 for anonymous', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'hidden_auto' })

    const r = await handleTree(giftByIdReq(publicId), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })

  it('hidden_admin gift → 404 for anonymous', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'hidden_admin' })

    const r = await handleTree(giftByIdReq(publicId), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })

  it('deleted gift → 404 for anonymous', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'deleted' })

    const r = await handleTree(giftByIdReq(publicId), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })

  it('hidden gift → 200 for the gift owner (session cookie)', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'hidden_auto' })

    const rawToken = makeRawToken()
    await seedSession(db, userId, rawToken)

    const r = await handleTree(
      giftByIdReq(publicId, `${SESSION_COOKIE_NAME}=${rawToken}`),
      makeTreeEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('hidden gift → 200 for a Google admin', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    const userId = await seedUser(db)
    const adminId = await seedUser(db, { sub: 'admin-sub-999', email: 'admin@gmail.com' })
    await seedAdminEmail(db, 'admin@gmail.com')
    const campaignId = seedGiftTreeCampaign(sqlite)
    const { publicId } = seedGift(sqlite, { campaignId, userId, status: 'hidden_admin' })

    const rawToken = makeRawToken()
    await seedSession(db, adminId, rawToken)

    const r = await handleTree(
      giftByIdReq(publicId, `${SESSION_COOKIE_NAME}=${rawToken}`),
      makeTreeEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('non-existent publicId → 404', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    createGiftTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(giftByIdReq('no-such-gift-pubid'), makeTreeEnv(db))
    expect(r.status).toBe(404)
  })
})

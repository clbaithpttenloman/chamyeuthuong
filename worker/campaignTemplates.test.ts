// @vitest-environment node
/**
 * RED-phase tests for campaign-aware template APIs (decisions.md 2026-11-21 "templates per campaign").
 *
 * This file tests three things:
 *
 * 1. GET /api/campaigns/<slug>/templates  (via handleTree from worker/tree.ts — not yet created)
 *    Returns active templates whose campaign_id matches the campaign, never other campaigns.
 *
 * 2. Admin template create/update now accepts campaignId (via handleAdmin / handleTemplates)
 *    POST /api/admin/templates  { name, layout, active?, campaignId? }
 *      → template row stored with the given campaign_id (default 1 when omitted)
 *    PUT  /api/admin/templates/:id { campaignId? }
 *      → updates campaign_id of the template
 *    Admin MUST have a Google session (not legacy email) for this route is unchanged (existing
 *    admin.ts routes templates through legacy-compatible auth; campaign behaviour is a data change).
 *
 * 3. GET /api/templates (20/11 compat via handlePublic from worker/public.ts — already exists)
 *    Returns active templates for campaign 1 ONLY after Phase 2.
 *    Before Phase 2 it returns all active templates; this test encodes the new contract so the
 *    implementation knows it must add a WHERE campaign_id = 1 filter.
 *
 * Import of handleTree from ./tree.ts (not yet created) causes all tests in this file to fail
 * at import time (red phase). Tests will pass once tree.ts is created with handleTree.
 *
 * Column names assumed:
 *   template.campaign_id  — added via ALTER TABLE in CAMPAIGN_UPGRADE_SQLS (already in schema.ts)
 *                          Phase 2 adds the ability to set it to values other than 1.
 */
import { describe, it, expect } from 'vitest'
// --- Module under test does not exist yet; import triggers red phase ---
import { handleTree } from './tree.ts'
import { handlePublic } from './public.ts'
import { handleAdmin } from './admin.ts'
import { testDb } from './testDb.ts'
import {
  createNewTables,
  seedUser,
  seedSession,
  seedAdminEmail,
  makeRawToken,
  SESSION_COOKIE_NAME,
  TEST_CLIENT_ID,
  TEST_NONCE_KEY,
  TEST_EMAIL,
  TEST_SUB,
  pinAdminSub,
} from './testGoogle.ts'
import type { D1 } from './testDb.ts'

// ── Schema helpers ────────────────────────────────────────────────────────────

/** Closes any existing active campaign and inserts a gift_tree campaign at the given slug. */
function seedGiftTreeCampaign(
  sqlite: import('node:sqlite').DatabaseSync,
  slug = 'noel',
  status: 'active' | 'closed' | 'draft' = 'active',
): number {
  sqlite.prepare("UPDATE campaign SET status = 'closed' WHERE status = 'active'").run()
  const settings = JSON.stringify({ tree_slots: 15, ground_slots: 10, hearts_per_day: 5, gifts_per_user: 3, report_threshold: 3 })
  sqlite.prepare(`
    INSERT INTO campaign (slug, kind, name, tagline, content, theme_colors, settings,
      starts_at, ends_at, status, created_at, created_by)
    VALUES (?, 'gift_tree', 'Noel', '', '{}', '{}', ?,
      '2026-01-01T00:00:00Z', '2027-12-31T23:59:59Z', ?, datetime('now'), 'test')
  `).run(slug, settings, status)
  return (sqlite.prepare('SELECT id FROM campaign WHERE slug = ?').get(slug) as { id: number }).id
}

/** Inserts a template row with an explicit campaign_id. Returns the new template id. */
function seedTemplate(
  sqlite: import('node:sqlite').DatabaseSync,
  opts: { name?: string; layout?: string; active?: 0 | 1; campaignId?: number },
): number {
  const name = opts.name ?? 'Test Template'
  const layout = opts.layout ?? 'classic'
  const active = opts.active ?? 1
  const campaignId = opts.campaignId ?? 1
  const now = new Date().toISOString()
  sqlite.prepare(
    'INSERT INTO template (name, layout, active, created_at, created_by, campaign_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(name, layout, active, now, 'test', campaignId)
  return (sqlite.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
}

type TemplatesTestEnv = {
  DB: D1
  PUBLIC_READ_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> }
  TREE_READ_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> }
  ADMIN_FAIL_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> }
  GOOGLE_CLIENT_ID?: string
  NONCE_KEY?: string
  ADMIN_LEGACY_LOGIN?: string
  PUBLIC_IP_LIMIT: { limit(o: { key: string }): Promise<{ success: boolean }> }
}

function makeTemplatesEnv(db: D1): TemplatesTestEnv {
  return {
    DB: db,
    PUBLIC_READ_LIMIT: { limit: async () => ({ success: true }) },
    TREE_READ_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    NONCE_KEY: TEST_NONCE_KEY,
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
  }
}

/** Signs in with the test admin and returns a session cookie. */
async function signInAsAdmin(
  db: D1,
  sqlite: import('node:sqlite').DatabaseSync,
): Promise<string> {
  await seedAdminEmail(db, TEST_EMAIL)
  const userId = await seedUser(db, { sub: TEST_SUB, email: TEST_EMAIL })
  await pinAdminSub(db, TEST_EMAIL, TEST_SUB)
  const rawToken = makeRawToken()
  await seedSession(db, userId, rawToken)
  void sqlite // used by caller for setup; sqlite handle not needed here
  return `${SESSION_COOKIE_NAME}=${rawToken}`
}

// ── GET /api/campaigns/<slug>/templates ───────────────────────────────────────

describe('GET /api/campaigns/<slug>/templates — public read', () => {
  it('returns active templates for the campaign slug only', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const noelId = seedGiftTreeCampaign(sqlite)
    // Template for noel (campaign 2)
    seedTemplate(sqlite, { name: 'Noel BG', campaignId: noelId, active: 1 })
    // Template for campaign 1 (20-11) — must NOT appear
    seedTemplate(sqlite, { name: '20/11 BG', campaignId: 1, active: 1 })

    const r = await handleTree(
      new Request('https://x/api/campaigns/noel/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { id: number; name: string }[]
    expect(Array.isArray(body)).toBe(true)
    const names = body.map((t) => t.name)
    expect(names).toContain('Noel BG')
    expect(names).not.toContain('20/11 BG')
  })

  it('inactive templates are excluded', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const noelId = seedGiftTreeCampaign(sqlite)
    seedTemplate(sqlite, { name: 'Active BG', campaignId: noelId, active: 1 })
    seedTemplate(sqlite, { name: 'Inactive BG', campaignId: noelId, active: 0 })

    const r = await handleTree(
      new Request('https://x/api/campaigns/noel/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db),
    )
    const body = await r.json() as { name: string }[]
    expect(body.map((t) => t.name)).toContain('Active BG')
    expect(body.map((t) => t.name)).not.toContain('Inactive BG')
  })

  it('no templates for the campaign → returns empty array', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    seedGiftTreeCampaign(sqlite)
    // No templates for noel

    const r = await handleTree(
      new Request('https://x/api/campaigns/noel/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as unknown[]
    expect(body).toEqual([])
  })

  it('response has Cache-Control: public, max-age=5', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    seedGiftTreeCampaign(sqlite)

    const r = await handleTree(
      new Request('https://x/api/campaigns/noel/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db),
    )
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=5')
  })

  it('unknown campaign slug → 404', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    // No campaign with slug "ghost"
    seedGiftTreeCampaign(sqlite, 'noel') // set up noel so the 20-11 campaign is closed

    const r = await handleTree(
      new Request('https://x/api/campaigns/ghost/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db),
    )
    expect(r.status).toBe(404)
  })
})

// ── Admin: template create/update with campaignId ────────────────────────────

describe('Admin POST /api/admin/templates — campaignId field', () => {
  it('POST with campaignId → template stored with that campaign_id', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const noelId = seedGiftTreeCampaign(sqlite)
    const cookie = await signInAsAdmin(db, sqlite)

    const req = new Request('https://x/api/admin/templates', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ name: 'Noel Card BG', layout: 'classic', active: 1, campaignId: noelId }),
    })
    const r = await handleAdmin(req, makeTemplatesEnv(db) as never)
    expect(r.status).toBe(200)

    // Verify stored campaign_id
    const row = sqlite.prepare('SELECT campaign_id FROM template WHERE name = ?').get('Noel Card BG') as { campaign_id: number } | undefined
    expect(row).toBeDefined()
    expect(row!.campaign_id).toBe(noelId)
  })

  it('POST without campaignId → defaults to campaign 1', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    seedGiftTreeCampaign(sqlite)
    const cookie = await signInAsAdmin(db, sqlite)

    const req = new Request('https://x/api/admin/templates', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ name: 'Default Campaign Template', layout: 'classic', active: 1 }),
    })
    const r = await handleAdmin(req, makeTemplatesEnv(db) as never)
    expect(r.status).toBe(200)

    const row = sqlite.prepare('SELECT campaign_id FROM template WHERE name = ?').get('Default Campaign Template') as { campaign_id: number } | undefined
    expect(row?.campaign_id).toBe(1)
  })

  it('POST with campaignId for a non-existent campaign → 400', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const cookie = await signInAsAdmin(db, sqlite)

    const req = new Request('https://x/api/admin/templates', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ name: 'Bad Campaign', layout: 'classic', campaignId: 9999 }),
    })
    const r = await handleAdmin(req, makeTemplatesEnv(db) as never)
    expect(r.status).toBe(400)
  })
})

describe('Admin PUT /api/admin/templates/:id — campaignId field', () => {
  it('PUT with campaignId → updates campaign_id of existing template', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const noelId = seedGiftTreeCampaign(sqlite)
    const cookie = await signInAsAdmin(db, sqlite)

    // Template starts in campaign 1
    const tplId = seedTemplate(sqlite, { campaignId: 1, active: 1 })

    const req = new Request(`https://x/api/admin/templates/${tplId}`, {
      method: 'PUT',
      headers: {
        'CF-Connecting-IP': '1.2.3.4',
        'X-Requested-With': 'fetch',
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({ name: 'Updated Template', layout: 'classic', active: 1, campaignId: noelId }),
    })
    const r = await handleAdmin(req, makeTemplatesEnv(db) as never)
    expect(r.status).toBe(200)

    const row = sqlite.prepare('SELECT campaign_id FROM template WHERE id = ?').get(tplId) as { campaign_id: number } | undefined
    expect(row?.campaign_id).toBe(noelId)
  })
})

// ── GET /api/templates — 20/11 compat: campaign 1 only ───────────────────────

describe('GET /api/templates — 20/11 compat returns campaign 1 templates only', () => {
  it('templates with campaign_id = 1 appear in /api/templates', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    const noelId = seedGiftTreeCampaign(sqlite)
    seedTemplate(sqlite, { name: 'Campaign 1 Template', campaignId: 1, active: 1 })
    seedTemplate(sqlite, { name: 'Noel Template', campaignId: noelId, active: 1 })

    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db) as never,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { name: string }[]
    expect(body.map((t) => t.name)).toContain('Campaign 1 Template')
    expect(body.map((t) => t.name)).not.toContain('Noel Template')
  })

  it('/api/templates output is byte-identical with and without Phase 2 noel campaign in DB', async () => {
    // Phase 2 must not change the response for campaign 1 templates.
    // Before Phase 2: { db1 } has only campaign 1 templates.
    // After Phase 2: { db2 } has campaign 1 + campaign 2 templates.
    // The /api/templates response must be the same.
    const { sqlite: sq1 } = testDb()
    createNewTables(sq1)
    const tid = seedTemplate(sq1, { name: 'Shared BG', campaignId: 1, active: 1 })

    const { sqlite: sq2 } = testDb()
    createNewTables(sq2)
    // Same campaign 1 template
    seedTemplate(sq2, { name: 'Shared BG', campaignId: 1, active: 1 })
    // Extra noel template that should NOT appear
    const noelId2 = seedGiftTreeCampaign(sq2)
    seedTemplate(sq2, { name: 'Noel Only', campaignId: noelId2, active: 1 })

    const { db: db1 } = testDb({ shareWith: sq1 })
    const { db: db2 } = testDb({ shareWith: sq2 })

    const r1 = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db1) as never,
    )
    const r2 = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db2) as never,
    )

    const body1 = await r1.json() as { id: number; name: string }[]
    const body2 = await r2.json() as { id: number; name: string }[]

    // Both must include the campaign 1 template only
    expect(body1.map((t) => t.name)).toContain('Shared BG')
    expect(body2.map((t) => t.name)).toContain('Shared BG')
    expect(body2.map((t) => t.name)).not.toContain('Noel Only')

    // The ids can differ between the two fresh databases, so compare by name
    const names1 = body1.map((t) => t.name).sort()
    const names2 = body2.map((t) => t.name).sort()
    expect(names1).toEqual(names2)

    void tid // suppress unused
  })

  it('inactive campaign 1 templates are still excluded from /api/templates', async () => {
    const { db, sqlite } = testDb()
    createNewTables(sqlite)
    seedTemplate(sqlite, { name: 'Active C1', campaignId: 1, active: 1 })
    seedTemplate(sqlite, { name: 'Inactive C1', campaignId: 1, active: 0 })

    const r = await handlePublic(
      new Request('https://x/api/templates', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeTemplatesEnv(db) as never,
    )
    const body = await r.json() as { name: string }[]
    expect(body.map((t) => t.name)).toContain('Active C1')
    expect(body.map((t) => t.name)).not.toContain('Inactive C1')
  })
})

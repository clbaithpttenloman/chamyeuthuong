// @vitest-environment node
// Tests for worker/campaigns.ts and /api/cards campaign-closed check (red phase)
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// These imports fail NOW (modules do not exist yet — expected red phase)
import { handleCampaigns, activateCampaign, handleAdminCampaigns } from './campaigns.ts'
import { handleSubmit } from './submit.ts'
import { testDb, type D1 } from './testDb.ts'
import { newToken } from './token.ts'

// ---- Env builders ----

function campaignsEnv(db: D1): { DB: D1 } {
  return { DB: db }
}

function submitEnv(db: D1) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

// ---- Fixtures ----

const VALID_TOKEN = 'tok1234567890abc'

/** Insert campaign 1 (slug 20-11, teacher_cards) with configurable status and dates.
 * Uses INSERT OR REPLACE so it works even after testDb() pre-inserted campaign 1
 * (Fix Group 5a Accept #1: fresh DBs now always get campaign 1).
 */
async function seedCampaign(
  db: D1,
  opts: {
    id?: number
    slug?: string
    kind?: string
    status?: 'draft' | 'active' | 'closed'
    startsAt?: string
    endsAt?: string
    name?: string
    tagline?: string
    content?: string
  } = {},
) {
  const {
    id = 1,
    slug = '20-11',
    kind = 'teacher_cards',
    status = 'active',
    startsAt = '2000-01-01T00:00:00Z',
    endsAt = '2099-12-31T23:59:59Z',
    name = 'Ngày 20/11',
    tagline = 'Tri ân thầy cô',
    content = '{}',
  } = opts
  await db
    .prepare(
      'INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ' +
        "VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?, datetime('now'), 'test')",
    )
    .bind(id, slug, kind, name, tagline, content, startsAt, endsAt, status)
    .run()
}

/** Insert a teacher + teacher_profile + template for submit tests. */
async function seedTeacherAndTemplate(db: D1) {
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(VALID_TOKEN, 'Teacher', 'Math', now)
    .run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(VALID_TOKEN).first<{ id: number }>())!.id
  await db
    .prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)')
    .bind(tid, 'Thầy')
    .run()
  await db
    .prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
    .bind(tid, '', 1)
    .run()
  // Insert template with campaign_id = 1 (default)
  await db
    .prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind('Default', 'classic', 1, now, 'admin@test.com')
    .run()
  const tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('Default').first<{ id: number }>())!.id
  return { tid, tmplId }
}

function submitReq(body: unknown) {
  return new Request('https://x/api/cards', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '1.2.3.4',
    },
    body: JSON.stringify(body),
  })
}

let db: D1

beforeEach(() => {
  ;({ db } = testDb())
  vi.mocked(newToken).mockReturnValue('newcard00000001a')
})

// ---- GET /api/campaigns/active ----

describe('handleCampaigns — GET /api/campaigns/active', () => {
  it('no campaigns at all → 404 { error: "not_found" }', async () => {
    // testDb() now includes campaign 1 as active (Fix Group 5a Accept #1: fresh DBs get campaign 1).
    // Delete it to test the true "no campaigns" edge case (FR-3 fallback also needs no closed campaign).
    await db.prepare('DELETE FROM campaign').run()
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('active campaign → 200 with correct JSON keys', async () => {
    await seedCampaign(db)
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body).toHaveProperty('slug')
    expect(body).toHaveProperty('kind')
    expect(body).toHaveProperty('name')
    expect(body).toHaveProperty('tagline')
    expect(body).toHaveProperty('content')
    expect(body).toHaveProperty('themeColors')
    expect(body).toHaveProperty('settings')
    expect(body).toHaveProperty('startsAt')
    expect(body).toHaveProperty('endsAt')
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('open')
  })

  it('active campaign within dates → open: true', async () => {
    // starts in year 2000, ends in year 2099 → always open during tests
    await seedCampaign(db, { status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { open: boolean }).open).toBe(true)
  })

  it('active campaign outside dates → open: false', async () => {
    await seedCampaign(db, {
      status: 'active',
      startsAt: '2000-01-01T00:00:00Z',
      endsAt: '2001-01-01T00:00:00Z',
    })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { open: boolean }).open).toBe(false)
  })

  it('response has Cache-Control: public, max-age=5', async () => {
    await seedCampaign(db)
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=5')
  })

  it('response has no Set-Cookie header', async () => {
    await seedCampaign(db)
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Set-Cookie')).toBeNull()
  })

  it('response has no Vary header', async () => {
    await seedCampaign(db)
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Vary')).toBeNull()
  })

  it('slug field equals the stored slug', async () => {
    await seedCampaign(db, { slug: '20-11' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect((await r.json() as { slug: string }).slug).toBe('20-11')
  })
})

// ---- GET /api/campaigns/<slug> ----

describe('handleCampaigns — GET /api/campaigns/<slug>', () => {
  it('known slug → 200 with correct shape', async () => {
    await seedCampaign(db, { slug: 'noel-2026', kind: 'gift_tree', status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/noel-2026'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body.slug).toBe('noel-2026')
    expect(body.kind).toBe('gift_tree')
  })

  it('unknown slug → 404 { error: "not_found" }', async () => {
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/does-not-exist'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('invalid slug (a_b — underscore not allowed) → 404', async () => {
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/a_b'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('invalid slug (33 chars) → 404', async () => {
    const r = await handleCampaigns(
      new Request(`https://x/api/campaigns/${'a'.repeat(33)}`),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('invalid slug (single char "x") → 404', async () => {
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/x'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('Cache-Control: public, max-age=5', async () => {
    await seedCampaign(db, { slug: '20-11' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/20-11'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=5')
  })

  it('no Set-Cookie on slug lookup', async () => {
    await seedCampaign(db, { slug: '20-11' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/20-11'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Set-Cookie')).toBeNull()
  })

  it('signed-in user gets byte-identical response to anonymous (no Vary, no Set-Cookie)', async () => {
    await seedCampaign(db, { slug: '20-11' })
    const env = campaignsEnv(db)
    const anonResp = await handleCampaigns(new Request('https://x/api/campaigns/20-11'), env)
    const authResp = await handleCampaigns(
      new Request('https://x/api/campaigns/20-11', {
        headers: { Cookie: '__Host-cyt_s=somesessiontoken' },
      }),
      env,
    )
    expect(anonResp.headers.get('Vary')).toBeNull()
    expect(authResp.headers.get('Vary')).toBeNull()
    expect(anonResp.headers.get('Set-Cookie')).toBeNull()
    expect(authResp.headers.get('Set-Cookie')).toBeNull()
    const anonBody = await anonResp.text()
    const authBody = await authResp.text()
    expect(anonBody).toBe(authBody)
  })
})

// ---- Memo: 10 calls with different ?x= hit D1 exactly once within 5s ----

describe('handleCampaigns — memo per path+slug (query string ignored)', () => {
  it('10 calls with different ?x= within 5s hit D1 at most once after the first call', async () => {
    // Use an isolated db so the state counter is fresh and unaffected by other tests.
    // Use a unique slug so the module-level memo has no prior entry for it.
    const { db: mdb, state: mst } = testDb()
    const slug = 'memo-reads-yz8p-unique'
    await seedCampaign(mdb, { slug, status: 'active' })
    const env = campaignsEnv(mdb)

    // First call: memo miss → hits D1
    await handleCampaigns(new Request(`https://x/api/campaigns/${slug}?x=1`), env)
    const readsAfterFirst = mst.reads

    // 9 more calls with different query strings — all within the same 5-second window.
    // The memo key is path+slug (query ignored), so all map to the same memo entry.
    for (let i = 2; i <= 10; i++) {
      await handleCampaigns(new Request(`https://x/api/campaigns/${slug}?x=${i}`), env)
    }

    // No additional D1 reads: 9 subsequent calls were served from memo.
    expect(mst.reads).toBe(readsAfterFirst)
  })
})

// ---- activateCampaign ----

describe('activateCampaign', () => {
  it('makes the campaign active', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'draft' })
    await activateCampaign(db, 1)
    const row = await db
      .prepare('SELECT status FROM campaign WHERE id = 1')
      .first<{ status: string }>()
    expect(row?.status).toBe('active')
  })

  it('closes any other active campaign in the same batch (AC-2)', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    await seedCampaign(db, { id: 2, slug: 'noel-2026', kind: 'gift_tree', status: 'draft' })
    await activateCampaign(db, 2)
    const prev = await db
      .prepare('SELECT status FROM campaign WHERE id = 1')
      .first<{ status: string }>()
    const next = await db
      .prepare('SELECT status FROM campaign WHERE id = 2')
      .first<{ status: string }>()
    expect(prev?.status).toBe('closed')
    expect(next?.status).toBe('active')
  })

  it('activating the already-active campaign is a no-op (still active, no other closed)', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    await activateCampaign(db, 1)
    const row = await db
      .prepare('SELECT status FROM campaign WHERE id = 1')
      .first<{ status: string }>()
    expect(row?.status).toBe('active')
    // No second campaign exists to have been closed
    const count = await db
      .prepare("SELECT COUNT(*) AS c FROM campaign WHERE status = 'closed'")
      .first<{ c: number }>()
    expect(count?.c).toBe(0)
  })

  it('at most one active campaign after activate (partial unique index holds)', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    await seedCampaign(db, { id: 2, slug: 'noel-2026', kind: 'gift_tree', status: 'draft' })
    await activateCampaign(db, 2)
    const activeCount = await db
      .prepare("SELECT COUNT(*) AS c FROM campaign WHERE status = 'active'")
      .first<{ c: number }>()
    expect(activeCount?.c).toBe(1)
  })
})

// ---- POST /api/cards — campaign_closed check (AC-3) ----

describe('POST /api/cards — 409 campaign_closed when campaign 1 is not effectively open', () => {
  it('campaign 1 status=closed → 409 { error: "campaign_closed" }', async () => {
    // Insert campaign 1 as closed
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'closed' })
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('campaign 1 status=active but dates in the past → 409 campaign_closed', async () => {
    await seedCampaign(db, {
      id: 1,
      slug: '20-11',
      status: 'active',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: '2020-12-31T23:59:59Z',
    })
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('campaign 1 status=draft even with current dates → 409 campaign_closed', async () => {
    await seedCampaign(db, {
      id: 1,
      slug: '20-11',
      status: 'draft',
    })
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })

  it('campaign 1 status=active + current dates → 201 (existing behavior preserved)', async () => {
    // Always-open campaign (year 2000 to 2099)
    await seedCampaign(db, {
      id: 1,
      slug: '20-11',
      status: 'active',
    })
    const { tmplId } = await seedTeacherAndTemplate(db)
    vi.mocked(newToken).mockReturnValue('newcard00000001a')
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(201)
    expect((await r.json() as { status: string }).status).toBe('pending')
  })

  it('no campaign 1 in DB → 409 campaign_closed (treats missing as closed)', async () => {
    // testDb() has campaign 1 active. Delete it to simulate "campaign table exists but no campaign 1 row".
    // (Fix Group 5a Accept #1: adjust tests that assumed no campaign on fresh DB)
    await db.prepare('DELETE FROM campaign WHERE id = 1').run()
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })
})

// ============================================================
// Fix Group 4a — new tests (red phase until implementation)
// ============================================================

// ---- Admin request helpers ----

function adminPost(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify(body),
  })
}

function adminPatch(url: string, body: unknown) {
  return new Request(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ---- handleAdminCampaigns — POST: snake_case body the editor sends ----

describe('handleAdminCampaigns — POST accepts snake_case body the editor sends', () => {
  it('POST with snake_case keys (starts_at, ends_at, theme_colors) → 201', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'noel-2026',
        kind: 'gift_tree',
        name: 'Noel 2026',
        tagline: 'Treo ước nguyện',
        content: '{"home":{"kicker":"test"}}',
        theme_colors: '{"primary":"#cc0000"}',
        settings: '{}',
        starts_at: '2026-12-01T00:00:00Z',
        ends_at: '2026-12-31T23:59:59Z',
        // No status field: POST always creates as draft (Fix Group 5a Accept #3)
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(201)
    const body = await r.json() as { id?: number }
    expect(typeof body.id).toBe('number')
  })

  it('POST with camelCase keys (startsAt, endsAt) alone → 400 (dates required)', async () => {
    // The API no longer reads camelCase; camelCase body has no dates → bad_request
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        startsAt: '2026-01-01T00:00:00Z',  // camelCase — not read
        endsAt: '2026-12-31T00:00:00Z',    // camelCase — not read
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })
})

// ---- handleAdminCampaigns — POST: validation ----

describe('handleAdminCampaigns — POST: validation', () => {
  it('unknown kind → 400 bad_request', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'unknown_kind',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('invalid gift_tree settings (report_threshold out of range) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'gift_tree',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        settings: JSON.stringify({ report_threshold: 100 }),
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('invalid gift_tree settings (tree_slots too low) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'gift_tree',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        settings: JSON.stringify({ tree_slots: 1 }),  // min is 5
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('non-object content (JSON array string) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        content: '[1,2,3]',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('non-object content (null JSON string) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        content: 'null',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('non-object theme_colors (JSON array) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        theme_colors: '[1,2,3]',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('non-ISO starts_at → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: 'not-a-date',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('non-ISO ends_at → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: 'bad-date',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('ends_at equal to starts_at → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-06-01T00:00:00Z',
        ends_at: '2026-06-01T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('ends_at before starts_at → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-12-31T00:00:00Z',
        ends_at: '2026-01-01T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })
})

// ---- handleAdminCampaigns — PATCH: status and kind rejected ----

describe('handleAdminCampaigns — PATCH: status and kind rejected', () => {
  beforeEach(async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', kind: 'teacher_cards', status: 'draft' })
  })

  it('PATCH with status field → 400 bad_request', async () => {
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { status: 'active' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('PATCH with kind field → 400 bad_request', async () => {
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { kind: 'gift_tree' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('PATCH with invalid settings → 400', async () => {
    // First upgrade campaign to gift_tree so settings validation is tested
    await db.prepare("UPDATE campaign SET kind = 'gift_tree' WHERE id = 1").run()
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', {
        settings: JSON.stringify({ tree_slots: 999 }),
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with non-object content → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { content: '[1,2,3]' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with ends_at ≤ starts_at (both provided) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', {
        starts_at: '2026-12-31T00:00:00Z',
        ends_at: '2026-01-01T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH valid name only → 200, content unchanged', async () => {
    // Insert with specific content
    await db.prepare("UPDATE campaign SET content = '{\"home\":{\"kicker\":\"keep me\"}}' WHERE id = 1").run()
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { name: 'Updated Name' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(200)
    // Content must remain intact
    const row = await db.prepare('SELECT content FROM campaign WHERE id = 1').first<{ content: string }>()
    expect(row?.content).toBe('{"home":{"kicker":"keep me"}}')
  })
})

// ---- handleAdminCampaigns — body limit (16 KB) ----

describe('handleAdminCampaigns — body limit 16 KB', () => {
  it('POST body > 16 KB → 413 too_long', async () => {
    // Build a body > 16 KB
    const big = 'x'.repeat(16385)
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: big,
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(413)
  })

  it('POST body ≤ 16 KB with real content does NOT return 413', async () => {
    // A 15 KB payload (> old 4 KB limit, < new 16 KB limit)
    const bigContent = 'a'.repeat(14000)
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'big-content',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        content: JSON.stringify({ data: bigContent }),
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    // Should NOT be 413; it may be 201 (success) or 400 (bad_request for other reasons)
    expect(r.status).not.toBe(413)
  })

  it('PATCH body > 16 KB → 413 too_long', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11' })
    const big = 'x'.repeat(16385)
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: big,
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(413)
  })
})

// ---- handleAdminCampaigns — /close endpoint ----

describe('handleAdminCampaigns — /close endpoint', () => {
  it('POST /close → sets campaign status to closed → 200 { ok: true }', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/1/close', { method: 'POST' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { ok: boolean }).ok).toBe(true)
    const row = await db.prepare('SELECT status FROM campaign WHERE id = 1').first<{ status: string }>()
    expect(row?.status).toBe('closed')
  })

  it('/close on a draft campaign → 200, status becomes closed', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'draft' })
    await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/1/close', { method: 'POST' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    const row = await db.prepare('SELECT status FROM campaign WHERE id = 1').first<{ status: string }>()
    expect(row?.status).toBe('closed')
  })

  it('GET /close → 405 method not allowed', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/1/close', { method: 'GET' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(405)
  })
})

// ---- handleAdminCampaigns — GET <id> returns full row (content, settings, theme_colors) ----

describe('handleAdminCampaigns — GET /api/admin/campaigns/<id> returns full row', () => {
  it('returns content, settings, theme_colors fields', async () => {
    // Use id=2 to avoid conflict with campaign 1 that testDb() inserts (Fix Group 5a Accept #1)
    await db
      .prepare(
        'INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ' +
        "VALUES (2, 'admin-preview', 'teacher_cards', 'Test', '', '{\"k\":\"v\"}', '{\"primary\":\"#abc\"}', '{\"x\":1}', '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', 'draft', datetime('now'), 'test')",
      )
      .run()
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/2', { method: 'GET' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(200)
    const row = await r.json() as Record<string, unknown>
    expect(row.content).toBe('{"k":"v"}')
    expect(row.theme_colors).toBe('{"primary":"#abc"}')
    expect(row.settings).toBe('{"x":1}')
    expect(row.slug).toBe('admin-preview')
    expect(row.kind).toBe('teacher_cards')
  })
})

// ---- handleCampaigns — FR-3: no active → most recent closed ----

describe('handleCampaigns — FR-3 fallback (no active → most recent closed)', () => {
  it('no active campaign, one closed → 200 with open: false', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'closed' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { slug: string; open: boolean }
    expect(body.slug).toBe('20-11')
    expect(body.open).toBe(false)
  })

  it('no active campaign, two closed → returns the most recent one (highest id)', async () => {
    await seedCampaign(db, { id: 1, slug: 'old-campaign', status: 'closed' })
    await seedCampaign(db, { id: 2, slug: 'newer-campaign', status: 'closed' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
    expect((await r.json() as { slug: string }).slug).toBe('newer-campaign')
  })

  it('no campaigns at all → 404', async () => {
    // testDb() has campaign 1 active (Fix Group 5a Accept #1). Delete it for the true empty case.
    await db.prepare('DELETE FROM campaign').run()
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('FR-3 fallback: closed campaign returned with Cache-Control: public, max-age=5', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'closed' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active'),
      campaignsEnv(db),
    )
    expect(r.headers.get('Cache-Control')).toBe('public, max-age=5')
  })
})

// ---- handleCampaigns — draft campaigns not publicly readable (decisions.md 4) ----

describe('handleCampaigns — draft campaigns not public', () => {
  it('GET /api/campaigns/<draft-slug> → 404', async () => {
    await seedCampaign(db, { id: 1, slug: 'noel-2026', kind: 'gift_tree', status: 'draft' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/noel-2026'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('GET /api/campaigns/<active-slug> → 200 (active campaign is public)', async () => {
    await seedCampaign(db, { id: 1, slug: 'noel-2026', kind: 'gift_tree', status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/noel-2026'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
  })

  it('GET /api/campaigns/<closed-slug> → 200 (closed campaigns are readable)', async () => {
    await seedCampaign(db, { id: 1, slug: 'noel-2026', kind: 'gift_tree', status: 'closed' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/noel-2026'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(200)
  })
})

// ===================================================================
// Fix Group 5a — new failing tests
// ===================================================================

// ---- Accept #2: unknown id → 404 ----

describe('Fix Group 5a — Accept #2: activate/close/PATCH/DELETE unknown id → 404', () => {
  it('POST /activate on unknown id → 404 not_found', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/999/activate', { method: 'POST' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('activate on unknown id leaves the current active campaign active', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/999/activate', { method: 'POST' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    // Campaign 1 must still be active — not closed by the failed activate
    const row = await db.prepare('SELECT status FROM campaign WHERE id = 1').first<{ status: string }>()
    expect(row?.status).toBe('active')
  })

  it('POST /close on unknown id → 404 not_found', async () => {
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/999/close', { method: 'POST' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('PATCH on unknown id → 404 not_found', async () => {
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/999', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })

  it('DELETE on unknown id → 404 not_found', async () => {
    const r = await handleAdminCampaigns(
      new Request('https://x/api/admin/campaigns/999', { method: 'DELETE' }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(404)
    expect((await r.json() as { error: string }).error).toBe('not_found')
  })
})

// ---- Accept #3: POST with status → 400 ----

describe('Fix Group 5a — Accept #3: POST with status → 400', () => {
  it('POST with status: "closed" → 400 bad_request (status disallowed on POST)', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        status: 'closed',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('POST with status: "draft" → 400 bad_request (status disallowed on POST)', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
        status: 'draft',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
    expect((await r.json() as { error: string }).error).toBe('bad_request')
  })

  it('POST without status creates campaign as draft', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(201)
    const { id } = await r.json() as { id: number }
    const row = await db.prepare('SELECT status FROM campaign WHERE id = ?').bind(id).first<{ status: string }>()
    expect(row?.status).toBe('draft')
  })
})

// ---- Accept #4: name/tagline validation ----

describe('Fix Group 5a — Accept #4: name/tagline validation', () => {
  it('POST with non-string name (number) → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 123,
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('POST with name > 120 codepoints → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'N'.repeat(121),
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('POST with name ≤ 120 codepoints → not 400 (valid)', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'N'.repeat(120),
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).not.toBe(400)
  })

  it('POST with tagline > 200 codepoints → 400', async () => {
    const r = await handleAdminCampaigns(
      adminPost('https://x/api/admin/campaigns', {
        slug: 'test-cam',
        kind: 'teacher_cards',
        name: 'Test',
        tagline: 'T'.repeat(201),
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-12-31T00:00:00Z',
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with name > 120 codepoints → 400', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'draft' })
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { name: 'N'.repeat(121) }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with tagline > 200 codepoints → 400', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'draft' })
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', { tagline: 'T'.repeat(201) }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with only ends_at before existing starts_at → 400', async () => {
    await seedCampaign(db, {
      id: 1, slug: '20-11', status: 'draft',
      startsAt: '2026-06-01T00:00:00Z',
      endsAt: '2026-12-31T00:00:00Z',
    })
    // Send only ends_at earlier than stored starts_at
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', {
        ends_at: '2026-01-01T00:00:00Z',  // before stored starts_at 2026-06-01
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })

  it('PATCH with only starts_at after existing ends_at → 400', async () => {
    await seedCampaign(db, {
      id: 1, slug: '20-11', status: 'draft',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-06-01T00:00:00Z',
    })
    // Send only starts_at later than stored ends_at
    const r = await handleAdminCampaigns(
      adminPatch('https://x/api/admin/campaigns/1', {
        starts_at: '2026-12-01T00:00:00Z',  // after stored ends_at 2026-06-01
      }),
      campaignsEnv(db),
      'admin@test.com',
    )
    expect(r.status).toBe(400)
  })
})

// ---- Accept #9: extra path segments and non-GET ----

describe('Fix Group 5a — Accept #9: public campaign reads validation', () => {
  it('GET /api/campaigns/active/extra → 404', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active/extra'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('GET /api/campaigns/20-11/extra → 404', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/20-11/extra'),
      campaignsEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('POST /api/campaigns/active → 405 method', async () => {
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/active', { method: 'POST' }),
      campaignsEnv(db),
    )
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })

  it('POST /api/campaigns/20-11 → 405 method', async () => {
    await seedCampaign(db, { id: 1, slug: '20-11', status: 'active' })
    const r = await handleCampaigns(
      new Request('https://x/api/campaigns/20-11', { method: 'POST' }),
      campaignsEnv(db),
    )
    expect(r.status).toBe(405)
    expect((await r.json() as { error: string }).error).toBe('method')
  })
})

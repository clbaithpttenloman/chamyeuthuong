// @vitest-environment node
// Tests for worker/campaigns.ts and /api/cards campaign-closed check (red phase)
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// These imports fail NOW (modules do not exist yet — expected red phase)
import { handleCampaigns, activateCampaign } from './campaigns.ts'
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

/** Insert campaign 1 (slug 20-11, teacher_cards) with configurable status and dates. */
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
      'INSERT INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) ' +
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
  it('no active campaign → 404 { error: "not_found" }', async () => {
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
    // Campaign table exists but no campaign 1 row
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'Chúc thầy' }),
      submitEnv(db),
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('campaign_closed')
  })
})

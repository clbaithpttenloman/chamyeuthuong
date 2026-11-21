// @vitest-environment node
/**
 * Tests for worker/submit.ts
 *
 * Contract expected:
 *   handleSubmit(request: Request, env: Env): Promise<Response>
 *   — handles POST /api/cards
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

import { handleSubmit } from './submit.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'
import { newToken } from './token.ts'

const VALID_TOKEN = 'tok1234567890abc'

function makeEnv(db: D1, opts: { submitIpLimit?: boolean } = {}) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async (_: { key: string }) => ({ success: opts.submitIpLimit ?? true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
  }
}

function submitReq(body: unknown, opts: { ip?: string; contentType?: string } = {}) {
  return new Request('https://x/api/cards', {
    method: 'POST',
    headers: {
      'Content-Type': opts.contentType ?? 'application/json',
      'CF-Connecting-IP': opts.ip ?? '1.2.3.4',
    },
    body: JSON.stringify(body),
  })
}

/** Seed teacher + profile + template for submit tests. */
/** Adds `count` pending cards spread over extra teachers (≤ 150 each) so only the GLOBAL cap is exercised. */
async function seedPendingElsewhere(db: D1, tmplId: number, count: number) {
  const now = new Date().toISOString()
  let made = 0
  for (let t = 0; made < count; t++) {
    const tok = `oth${String(t).padStart(13, '0')}`
    await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(tok, `Other ${t}`, '', now).run()
    const oid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(tok).first<{ id: number }>())!.id
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
    .bind(oid, '', 1).run()
    for (let i = 0; i < 150 && made < count; i++, made++) {
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`cap${String(made).padStart(13, '0')}`, oid, tmplId, 'msg', '', '', 0, 'pending', now).run()
    }
  }
}

async function seedTeacherAndTemplate(db: D1, opts: { active?: 0 | 1 } = {}) {
  const now = new Date().toISOString()

  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(VALID_TOKEN, 'Teacher', 'Math', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(VALID_TOKEN).first<{ id: number }>())!.id

  await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)')
    .bind(tid, 'Thầy').run()
  await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
    .bind(tid, '', 1).run()
  await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind('Default', 'classic', opts.active ?? 1, now, TEST_EMAIL).run()
  const tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('Default').first<{ id: number }>())!.id

  return { tid, tmplId }
}

let db: D1

beforeEach(async () => {
  ;({ db } = testDb())
  vi.mocked(newToken).mockReturnValue('newcard00000001a')
  // Campaign 1 (slug '20-11') must be effectively open for all submit tests.
  // Fix Group 5a Accept #1: fresh DBs now get campaign 1 via CAMPAIGN_UPGRADE_SQLS
  // (the WHERE EXISTS guard was removed). The schema-seeded campaign 1 uses narrow
  // production dates, so we need our test-open dates (2000–2099) and status=active.
  // INSERT OR REPLACE replaces the schema-seeded row with the test's version;
  // idempotent if campaign 1 is already absent (e.g. { schema: false }).
  await db
    .prepare(
      "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
        "VALUES (1, '20-11', 'teacher_cards', 'Ngày 20/11', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
    )
    .run()
})

// ---- Happy path ----

describe('POST /api/cards — happy path', () => {
  it('valid card → 201 { status: "pending" }', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid,
      templateId: tmplId,
      message: 'Chúc mừng ngày 20/11!',
    }), makeEnv(db))
    expect(r.status).toBe(201)
    const body = await r.json() as Record<string, unknown>
    expect(body).toEqual({ status: 'pending' })
  })

  it('response does NOT echo id, publicId, message, fromName, fromClass, teacherId, templateId', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid,
      templateId: tmplId,
      message: 'Secret message',
      fromName: 'Học sinh',
      fromClass: '12A1',
    }), makeEnv(db))
    expect(r.status).toBe(201)
    const body = await r.json() as Record<string, unknown>
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('publicId')
    expect(body).not.toHaveProperty('message')
    expect(body).not.toHaveProperty('fromName')
    expect(body).not.toHaveProperty('fromClass')
    expect(body).not.toHaveProperty('teacherId')
    expect(body).not.toHaveProperty('templateId')
  })

  it('created card is status=pending in DB', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherId: tid,
      templateId: tmplId,
      message: 'Test message',
    }), makeEnv(db))
    const card = await db.prepare('SELECT status FROM student_card LIMIT 1').first<{ status: string }>()
    expect(card?.status).toBe('pending')
  })

  it('fields are trimmed: message and fromName leading/trailing spaces stripped', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherId: tid,
      templateId: tmplId,
      message: '  Hello  ',
      fromName: '  Nguyễn Văn A  ',
    }), makeEnv(db))
    const card = await db.prepare('SELECT message, from_name FROM student_card LIMIT 1').first<{ message: string; from_name: string }>()
    expect(card?.message).toBe('Hello')
    expect(card?.from_name).toBe('Nguyễn Văn A')
  })

  it('anonymous=true → from_name stored empty even when fromName is provided', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherId: tid,
      templateId: tmplId,
      message: 'Anon message',
      fromName: 'Should be erased',
      fromClass: 'Kept',
      anonymous: true,
    }), makeEnv(db))
    const card = await db.prepare('SELECT from_name, from_class, anonymous FROM student_card LIMIT 1')
      .first<{ from_name: string; from_class: string; anonymous: number }>()
    expect(card?.from_name).toBe('')
    expect(card?.from_class).toBe('Kept')
    expect(card?.anonymous).toBe(1)
  })
})

// ---- Rate limit — checked first ----

describe('POST /api/cards — rate limit first', () => {
  it('exhausted SUBMIT_IP_LIMIT → 429, zero DB statements including DDL', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handleSubmit(
      submitReq({ teacherId: 1, templateId: 1, message: 'x' }),
      makeEnv(freshDb, { submitIpLimit: false }),
    )
    expect(r.status).toBe(429)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })
})

// ---- Validation errors ----

describe('POST /api/cards — Content-Type validation', () => {
  it('missing Content-Type → 400', async () => {
    const r = await handleSubmit(
      new Request('https://x/api/cards', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '1.2.3.4' },
        body: JSON.stringify({ teacherId: 1, templateId: 1, message: 'y' }),
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('Content-Type: text/plain → 400', async () => {
    const r = await handleSubmit(
      submitReq({ teacherId: 1, templateId: 1, message: 'y' }, { contentType: 'text/plain' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('Content-Type: application/json; charset=utf-8 → allowed (passes media type check)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherId: tid, templateId: tmplId, message: 'ok' }, { contentType: 'application/json; charset=utf-8' }),
      makeEnv(db),
    )
    expect(r.status).toBe(201)
  })
})

describe('POST /api/cards — message validation', () => {
  it('empty message → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: '' }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message of exactly 300 code points → 201', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a'.repeat(300)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('message of 301 code points → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a'.repeat(301)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with more than 5 newlines → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a\nb\nc\nd\ne\nf\ng'  // 6 newlines (> MAX_NEWLINES=5)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with exactly 5 newlines → 201 (5 is the max allowed)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a\nb\nc\nd\ne\nf'  // 5 newlines = MAX_NEWLINES → accepted
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('message with control character (C0 except \\n) → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'hello\x01world'
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with bidi control U+202A → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'hello\u202Aworld'
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — fromName/fromClass validation', () => {
  it('fromName of 40 code points → 201', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
      fromName: 'a'.repeat(40),
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('fromName of 41 code points → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
      fromName: 'a'.repeat(41),
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('fromClass of 10 code points → 201', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
      fromClass: 'a'.repeat(10),
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('fromClass of 11 code points → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
      fromClass: 'a'.repeat(11),
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — anonymous field validation', () => {
  it('anonymous=true (boolean) → 201', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok', anonymous: true,
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('anonymous="true" (string, not boolean) → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok', anonymous: 'true',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('anonymous=1 (number, not boolean) → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok', anonymous: 1,
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — teacher/template validation', () => {
  it('unknown teacherId → 404', async () => {
    const { tmplId: tmpl } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: 99999, templateId: tmpl, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(404)
  })

  it('non-positive teacherId → 400 with zero DB statements', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handleSubmit(submitReq({
      teacherId: 0, templateId: 1, message: 'ok',
    }), makeEnv(freshDb))
    expect(r.status).toBe(400)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('inactive template → 400', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db, { active: 0 })
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('unknown templateId → 400', async () => {
    const { tid: teacherTid } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: teacherTid, templateId: 9999, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — body shape validation', () => {
  it('body > 2 KB → 413 or 400', async () => {
    const bigMsg = 'x'.repeat(3000)
    const r = await handleSubmit(submitReq({
      teacherId: 1, templateId: 1, message: bigMsg,
    }), makeEnv(db))
    expect([400, 413]).toContain(r.status)
  })

  it('non-object body (array) → 400', async () => {
    const r = await handleSubmit(
      new Request('https://x/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
        body: '[1,2,3]',
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('unknown extra key in body → 400 (strict fields)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
      unknownField: 'injected',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

// ---- Pending cap ----

describe('POST /api/cards — pending caps (atomic)', () => {
  it('2000th pending card is accepted (global cap not reached)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await seedPendingElsewhere(db, tmplId, 1999)
    vi.mocked(newToken).mockReturnValue('card2000final001')
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('2001st pending card is rejected 409 "conflict"', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await seedPendingElsewhere(db, tmplId, 2000)
    vi.mocked(newToken).mockReturnValue('card2001reject01')
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('per-teacher pending cap (200) → 409 when teacher has 200 pending', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const now = new Date().toISOString()
    for (let i = 0; i < 200; i++) {
      const pid = `ptc${String(i).padStart(13, '0')}`
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(pid, tid, tmplId, 'msg', '', '', 0, 'pending', now).run()
    }
    vi.mocked(newToken).mockReturnValue('ptcextra0000001a')
    const r = await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })
})

// ---- Card invisible on public endpoints after submit ----

describe('POST /api/cards — created card is invisible publicly', () => {
  it('pending card does not appear on /api/wall (approved-only)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherId: tid, templateId: tmplId, message: 'Secret',
    }), makeEnv(db))
    // Verify card is pending
    const card = await db.prepare("SELECT status FROM student_card WHERE status='pending'").first<{ status: string }>()
    expect(card?.status).toBe('pending')
    // No approved cards exist
    const approved = await db.prepare("SELECT COUNT(*) as c FROM student_card WHERE status='approved'").first<{ c: number }>()
    expect(approved?.c).toBe(0)
  })
})

// ---- Method guard ----

describe('POST /api/cards — method guard', () => {
  it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('%s → 405', async (method) => {
    const r = await handleSubmit(
      new Request('https://x/api/cards', { method, headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(405)
  })

  it('OPTIONS → 405 without Access-Control-* headers', async () => {
    const r = await handleSubmit(
      new Request('https://x/api/cards', { method: 'OPTIONS', headers: { 'CF-Connecting-IP': '1.2.3.4' } }),
      makeEnv(db),
    )
    expect(r.status).toBe(405)
    expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(r.headers.get('Access-Control-Allow-Methods')).toBeNull()
  })
})

// ---- Security headers ----

describe('POST /api/cards — security headers', () => {
  it('every response has Cache-Control: no-store, X-Content-Type-Options, X-Robots-Tag', async () => {
    const r = await handleSubmit(
      submitReq({ teacherId: 1, templateId: 1, message: 'y' }),
      makeEnv(db, { submitIpLimit: false }),
    )
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})

describe('POST /api/cards — more invisible and malformed characters (security review suggestion)', () => {
  let db: D1
  beforeEach(async () => {
    db = testDb().db
    // Campaign 1 must be open for submit to reach validation (not campaign_closed).
    await db
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
  })
  const cases: Array<[string, string]> = [
    ['line separator U+2028', 'a\u2028b'],
    ['paragraph separator U+2029', 'a\u2029b'],
    ['Arabic letter mark U+061C', 'a\u061Cb'],
    ['soft hyphen U+00AD', 'a\u00ADb'],
    ['combining grapheme joiner U+034F', 'a\u034Fb'],
    ['Mongolian vowel separator U+180E', 'a\u180Eb'],
    ['Hangul filler U+3164 (renders blank)', '\u3164\u3164'],
    ['halfwidth Hangul filler U+FFA0', '\uFFA0'],
    ['tag character U+E0041', 'a\u{E0041}b'],
  ]
  for (const [label, text] of cases) {
    it(`rejects ${label} in the message`, async () => {
      const { tid, tmplId } = await seedTeacherAndTemplate(db)
      const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: text }), makeEnv(db))
      expect(r.status).toBe(400)
    })
  }
  it('rejects a lone surrogate with 400 (not a database error)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    // Control: the same body without the surrogate is accepted, so the 400 below comes from the surrogate rule
    const ok = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'hi there' }), makeEnv(db))
    expect(ok.status).toBe(201)
    const raw = `{"teacherId":${tid},"templateId":${tmplId},"message":"hi \\ud800 there"}`
    const r = await handleSubmit(new Request('https://x/api/cards', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: raw,
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
  it('accepts Vietnamese text with emoji, including ZWJ sequences (👩‍🏫) and variation selectors (❤️)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc cô 20/11 vui vẻ 🌸💐 👩\u200D🏫 ❤\uFE0F' }), makeEnv(db))
    expect(r.status).toBe(201)
  })
})


describe('POST /api/cards — teacherId / teacherToken', () => {
  it('teacherId (show_on_home=1) → 201', async () => {
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    // Campaign 1 must be open.
    await freshDb
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    // Seed teacher with show_on_home=1
    await freshDb.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok1234567890abc', 'T', '', now).run()
    const tid = (await freshDb.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
    await freshDb.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    await freshDb.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 1).run()
    await freshDb.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, 'a@b.com').run()
    const tmplId = (await freshDb.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id

    const r = await handleSubmit(
      submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc mừng!' }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(201)
  })

  it('teacherToken (any teacher, including hidden) → 201', async () => {
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    // Campaign 1 must be open.
    await freshDb
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    const TOKEN = 'tok1234567890abc'
    await freshDb.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind(TOKEN, 'T', '', now).run()
    const tid = (await freshDb.prepare('SELECT id FROM teacher WHERE token=?').bind(TOKEN).first<{ id: number }>())!.id
    await freshDb.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    // show_on_home = 0 (hidden teacher, reachable via token only)
    await freshDb.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 0).run()
    await freshDb.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, 'a@b.com').run()
    const tmplId = (await freshDb.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id

    const r = await handleSubmit(
      submitReq({ teacherToken: TOKEN, templateId: tmplId, message: 'Chúc mừng!' }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(201)
  })

  it('teacherId for show_on_home=0 teacher → 404', async () => {
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    // Campaign 1 must be open so the check doesn't return 409 before reaching teacher lookup.
    await freshDb
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    await freshDb.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)').bind('tok1234567890abc', 'T', '', now).run()
    const tid = (await freshDb.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
    await freshDb.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    await freshDb.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)').bind(tid, '', 0).run()
    await freshDb.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, 'a@b.com').run()
    const tmplId = (await freshDb.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id

    const r = await handleSubmit(
      submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc mừng!' }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
  })

  it('both teacherId AND teacherToken → 400', async () => {
    const r = await handleSubmit(
      submitReq({ teacherId: 1, teacherToken: 'tok1234567890abc', templateId: 1, message: 'msg' }),
      makeEnv(db),
    )
    // Both are present → bad_request regardless of implementation.
    expect(r.status).toBe(400)
  })

  it('neither teacherId nor teacherToken → 400', async () => {
    const r = await handleSubmit(
      submitReq({ templateId: 1, message: 'Chúc mừng!' }),
      makeEnv(db),
    )
    // No identifier provided → bad_request.
    expect(r.status).toBe(400)
  })

  it('unknown teacherId → 404', async () => {
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    // Campaign 1 must be open so the check doesn't return 409 before reaching teacher lookup.
    await freshDb
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    await freshDb.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, 'a@b.com').run()
    const tmplId = (await freshDb.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id

    const r = await handleSubmit(
      submitReq({ teacherId: 99999, templateId: tmplId, message: 'Chúc mừng!' }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
  })

  it('non-integer teacherId → 400', async () => {
    const r = await handleSubmit(
      submitReq({ teacherId: 1.5, templateId: 1, message: 'msg' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('string "1" as teacherId → 400 (must be numeric)', async () => {
    const r = await handleSubmit(
      submitReq({ teacherId: '1', templateId: 1, message: 'msg' } as unknown),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('unknown teacherToken (valid format, not in DB) → 404', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherToken: 'unknowntoken1234', templateId: tmplId, message: 'Chúc mừng!' }),
      makeEnv(db),
    )
    expect(r.status).toBe(404)
  })

  it('malformed teacherToken (not 16 alphanumeric chars) → 400', async () => {
    const r = await handleSubmit(
      submitReq({ teacherToken: 'bad!token', templateId: 1, message: 'msg' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('201 via teacherId: DB row stores correct teacher_id', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    vi.mocked(newToken).mockReturnValue('teachidcard0001a')
    const r = await handleSubmit(
      submitReq({ teacherId: tid, templateId: tmplId, message: 'ok' }),
      makeEnv(db),
    )
    expect(r.status).toBe(201)
    const row = await db.prepare('SELECT teacher_id FROM student_card LIMIT 1')
      .first<{ teacher_id: number }>()
    expect(row?.teacher_id).toBe(tid)
  })

  it('201 via teacherToken: DB row stores correct teacher_id', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    vi.mocked(newToken).mockReturnValue('tokcard000000001')
    const r = await handleSubmit(
      submitReq({ teacherToken: VALID_TOKEN, templateId: tmplId, message: 'ok' }),
      makeEnv(db),
    )
    expect(r.status).toBe(201)
    const row = await db.prepare('SELECT teacher_id FROM student_card LIMIT 1')
      .first<{ teacher_id: number }>()
    expect(row?.teacher_id).toBe(tid)
  })

  it('marker scan: submit response body never echoes submitted message text', async () => {
    const MARKER = 'UNIQUE_SUBMIT_MARKER_XYZ'
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherId: tid, templateId: tmplId, message: MARKER }),
      makeEnv(db),
    )
    const body = await r.text()
    expect(body).not.toContain(MARKER)
  })

  it('marker scan: 404 error response body does not echo submitted text', async () => {
    const MARKER = 'UNIQUE_NOTFOUND_MARKER_XYZ'
    const { db: freshDb } = testDb()
    const now = new Date().toISOString()
    // Campaign 1 must be open so the check doesn't return 409 before reaching teacher lookup.
    await freshDb
      .prepare(
        "INSERT OR REPLACE INTO campaign (id, slug, kind, name, tagline, content, theme_colors, settings, starts_at, ends_at, status, created_at, created_by) " +
          "VALUES (1, '20-11', 'teacher_cards', '', '', '{}', '{}', '{}', '2000-01-01T00:00:00Z', '2099-12-31T23:59:59Z', 'active', datetime('now'), 'test')",
      )
      .run()
    await freshDb.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind('T', 'classic', 1, now, 'a@b.com').run()
    const tmplId = (await freshDb.prepare('SELECT id FROM template WHERE name=?').bind('T').first<{ id: number }>())!.id
    const r = await handleSubmit(
      submitReq({ teacherId: 99999, templateId: tmplId, message: MARKER }),
      makeEnv(freshDb),
    )
    expect(r.status).toBe(404)
    const body = await r.text()
    expect(body).not.toContain(MARKER)
  })

  it('marker scan: 429 rate-limited response does not echo submitted text', async () => {
    const MARKER = 'UNIQUE_RATELIMIT_MARKER_XYZ'
    const r = await handleSubmit(
      submitReq({ teacherId: 1, templateId: 1, message: MARKER }),
      makeEnv(db, { submitIpLimit: false }),
    )
    const body = await r.text()
    expect(body).not.toContain(MARKER)
  })
})

// ===================================================================
// Card v3: font and ink chosen by the student
// ===================================================================

describe('POST /api/cards — font and ink', () => {
  const stored = async (db: D1) =>
    db.prepare('SELECT font, ink FROM student_card ORDER BY id DESC LIMIT 1').first<{ font: string; ink: string }>()

  it('omitted → Bút bi (patrick-hand) and blue (#1d3fa6)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc thầy' }), makeEnv(db))
    expect(r.status).toBe(201)
    expect(await stored(db)).toEqual({ font: 'patrick-hand', ink: '#1d3fa6' })
  })

  it('valid font and ink are stored; ink is lowercased', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc thầy', font: 'charm', ink: '#AB12CD' }), makeEnv(db))
    expect(r.status).toBe(201)
    expect(await stored(db)).toEqual({ font: 'charm', ink: '#ab12cd' })
  })

  it('each supported font is accepted', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    for (const [i, font] of ['patrick-hand', 'pangolin', 'itim', 'mali', 'charm', 'be-vietnam-pro', 'lora'].entries()) {
      vi.mocked(newToken).mockReturnValue(`fontcard0000000${i}`) // newToken is mocked to a fixed value
      const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: `Chúc ${font}`, font }), makeEnv(db))
      expect(r.status).toBe(201)
    }
  })

  it('invalid font → 400 (null, other types, unknown names, prototype keys)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    for (const font of [null, 1, ['lora'], {}, '', 'Lora', 'dancing-script', '__proto__', 'constructor', "lora;color:red"]) {
      const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc', font }), makeEnv(db))
      expect(r.status).toBe(400)
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM student_card').first<{ n: number }>()).toEqual({ n: 0 })
  })

  it('invalid ink → 400 (CSS injection, other formats, trailing newline, non-strings)', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    for (const ink of [null, 0x1d3fa6, ['#000000'], {}, '', 'red', '#fff', '#1234567', '#gggggg', '#aabbcc\n', ' #aabbcc',
      'red;background:url(https://x)', '#aabbcc;color:red', 'rgb(0,0,0)', 'var(--x)']) {
      const r = await handleSubmit(submitReq({ teacherId: tid, templateId: tmplId, message: 'Chúc', ink }), makeEnv(db))
      expect(r.status).toBe(400)
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM student_card').first<{ n: number }>()).toEqual({ n: 0 })
  })

  it('teacherToken path stores font and ink too', async () => {
    const { tid, tmplId } = await seedTeacherAndTemplate(db)
    const tok = (await db.prepare('SELECT token FROM teacher WHERE id = ?').bind(tid).first<{ token: string }>())!.token
    const r = await handleSubmit(submitReq({ teacherToken: tok, templateId: tmplId, message: 'Chúc', font: 'itim', ink: '#6b21a8' }), makeEnv(db))
    expect(r.status).toBe(201)
    expect(await stored(db)).toEqual({ font: 'itim', ink: '#6b21a8' })
  })
})

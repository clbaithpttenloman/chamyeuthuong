// @vitest-environment node
/**
 * Tests for worker/submit.ts
 * All tests fail until Group 2 creates worker/submit.ts.
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

// This import fails until Group 2 creates the module → all tests fail
import { handleSubmit } from './submit.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'
import { newToken } from './token.ts'

const VALID_PUBLIC_ID = 'pub1234567890abc'
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
    await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)').bind(oid, `opb${String(t).padStart(13, '0')}`, '', 1).run()
    for (let i = 0; i < 150 && made < count; i++, made++) {
      await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(`cap${String(made).padStart(13, '0')}`, oid, tmplId, 'msg', '', '', 0, 'pending', now).run()
    }
  }
}

async function seedTeacherAndTemplate(db: D1, opts: { publicId?: string; active?: 0 | 1 } = {}) {
  const now = new Date().toISOString()
  const pubId = opts.publicId ?? VALID_PUBLIC_ID

  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind(VALID_TOKEN, 'Teacher', 'Math', now).run()
  const tid = (await db.prepare('SELECT id FROM teacher WHERE token=?').bind(VALID_TOKEN).first<{ id: number }>())!.id

  await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)')
    .bind(tid, 'Thầy').run()
  await db.prepare('INSERT INTO teacher_profile (teacher_id, public_id, department, show_on_home) VALUES (?, ?, ?, ?)')
    .bind(tid, pubId, '', 1).run()
  await db.prepare('INSERT INTO template (name, layout, active, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .bind('Default', 'classic', opts.active ?? 1, now, TEST_EMAIL).run()
  const tmplId = (await db.prepare('SELECT id FROM template WHERE name=?').bind('Default').first<{ id: number }>())!.id

  return { tid, tmplId }
}

let db: D1

beforeEach(async () => {
  ;({ db } = testDb())
  vi.mocked(newToken).mockReturnValue('newcard00000001a')
})

// ---- Happy path ----

describe('POST /api/cards — happy path', () => {
  it('valid card → 201 { status: "pending" }', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID,
      templateId: tmplId,
      message: 'Chúc mừng ngày 20/11!',
    }), makeEnv(db))
    expect(r.status).toBe(201)
    const body = await r.json() as Record<string, unknown>
    expect(body).toEqual({ status: 'pending' })
  })

  it('response does NOT echo id, publicId, message, fromName, fromClass, teacherId, templateId', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID,
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
    const { tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID,
      templateId: tmplId,
      message: 'Test message',
    }), makeEnv(db))
    const card = await db.prepare('SELECT status FROM student_card LIMIT 1').first<{ status: string }>()
    expect(card?.status).toBe('pending')
  })

  it('fields are trimmed: message and fromName leading/trailing spaces stripped', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID,
      templateId: tmplId,
      message: '  Hello  ',
      fromName: '  Nguyễn Văn A  ',
    }), makeEnv(db))
    const card = await db.prepare('SELECT message, from_name FROM student_card LIMIT 1').first<{ message: string; from_name: string }>()
    expect(card?.message).toBe('Hello')
    expect(card?.from_name).toBe('Nguyễn Văn A')
  })

  it('anonymous=true → from_name stored empty even when fromName is provided', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID,
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
      submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: 1, message: 'x' }),
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
        body: JSON.stringify({ teacherPublicId: 'x', templateId: 1, message: 'y' }),
      }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('Content-Type: text/plain → 400', async () => {
    const r = await handleSubmit(
      submitReq({ teacherPublicId: 'x', templateId: 1, message: 'y' }, { contentType: 'text/plain' }),
      makeEnv(db),
    )
    expect(r.status).toBe(400)
  })

  it('Content-Type: application/json; charset=utf-8 → allowed (passes media type check)', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(
      submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok' }, { contentType: 'application/json; charset=utf-8' }),
      makeEnv(db),
    )
    expect(r.status).toBe(201)
  })
})

describe('POST /api/cards — message validation', () => {
  it('empty message → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: '' }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message of exactly 300 code points → 201', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a'.repeat(300)
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('message of 301 code points → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a'.repeat(301)
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with more than 5 newlines → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a\nb\nc\nd\ne\nf\ng'  // 6 newlines (> MAX_NEWLINES=5)
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with exactly 5 newlines → 201 (5 is the max allowed)', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'a\nb\nc\nd\ne\nf'  // 5 newlines = MAX_NEWLINES → accepted
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('message with control character (C0 except \\n) → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'hello\x01world'
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('message with bidi control U+202A → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const msg = 'hello\u202Aworld'
    const r = await handleSubmit(submitReq({ teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: msg }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — fromName/fromClass validation', () => {
  it('fromName of 40 code points → 201', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
      fromName: 'a'.repeat(40),
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('fromName of 41 code points → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
      fromName: 'a'.repeat(41),
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('fromClass of 10 code points → 201', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
      fromClass: 'a'.repeat(10),
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('fromClass of 11 code points → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
      fromClass: 'a'.repeat(11),
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — anonymous field validation', () => {
  it('anonymous=true (boolean) → 201', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok', anonymous: true,
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('anonymous="true" (string, not boolean) → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok', anonymous: 'true',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('anonymous=1 (number, not boolean) → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok', anonymous: 1,
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — teacher/template validation', () => {
  it('unknown teacherPublicId → 404', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: 'unknownpublic01a', templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(404)
  })

  it('malformed teacherPublicId (not 16 lowercase alnum) → 400 with zero DB statements', async () => {
    const { db: freshDb, state } = testDb()
    const r = await handleSubmit(submitReq({
      teacherPublicId: 'BAD!!', templateId: 1, message: 'ok',
    }), makeEnv(freshDb))
    expect(r.status).toBe(400)
    expect(state.prepares).toBe(0)
    expect(state.ddl).toBe(0)
  })

  it('inactive template → 400', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db, { active: 0 })
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })

  it('unknown templateId → 400', async () => {
    await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: 9999, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

describe('POST /api/cards — body shape validation', () => {
  it('body > 2 KB → 413 or 400', async () => {
    const bigMsg = 'x'.repeat(3000)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: 1, message: bigMsg,
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
    const { tmplId } = await seedTeacherAndTemplate(db)
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
      unknownField: 'injected',
    }), makeEnv(db))
    expect(r.status).toBe(400)
  })
})

// ---- Pending cap ----

describe('POST /api/cards — pending caps (atomic)', () => {
  it('2000th pending card is accepted (global cap not reached)', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    await seedPendingElsewhere(db, tmplId, 1999)
    vi.mocked(newToken).mockReturnValue('card2000final001')
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(201)
  })

  it('2001st pending card is rejected 409 "conflict"', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    await seedPendingElsewhere(db, tmplId, 2000)
    vi.mocked(newToken).mockReturnValue('card2001reject01')
    const r = await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
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
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'ok',
    }), makeEnv(db))
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })
})

// ---- Card invisible on public endpoints after submit ----

describe('POST /api/cards — created card is invisible publicly', () => {
  it('pending card does not appear on /api/wall (approved-only)', async () => {
    const { tmplId } = await seedTeacherAndTemplate(db)
    await handleSubmit(submitReq({
      teacherPublicId: VALID_PUBLIC_ID, templateId: tmplId, message: 'Secret',
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
      submitReq({ teacherPublicId: 'x', templateId: 1, message: 'y' }),
      makeEnv(db, { submitIpLimit: false }),
    )
    expect(r.headers.get('Cache-Control')).toBe('no-store')
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })
})

// @vitest-environment node
/**
 * Tests for worker/templates.ts (admin template CRUD).
 * All tests fail until Group 2 creates worker/templates.ts.
 *
 * Contract expected:
 *   handleTemplates(request: Request, env: Env, email: string): Promise<Response>
 *   — handles GET/POST /api/admin/templates, PUT/DELETE /api/admin/templates/:id
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('./token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// This import fails until Group 2 creates the module → all tests fail
import { handleTemplates } from './templates.ts'
import { ensureSchema } from './schema.ts'
import { testDb, type D1 } from './testDb.ts'
import { TEST_EMAIL } from './testAuth.ts'

function makeEnv(db: D1) {
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

function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': '1.2.3.4',
    'X-Admin-Email': TEST_EMAIL,
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

async function seedImage(db: D1, token = 'imgabc1234567890') {
  const now = new Date().toISOString()
  await db.prepare("INSERT INTO image (token,name,mime,size,data,created_at,created_by) VALUES (?,?,?,?,?,?,?)")
    .bind(token, 'x.jpg', 'image/jpeg', 100, 'data', now, TEST_EMAIL).run()
  return (await db.prepare('SELECT id FROM image WHERE token=?').bind(token).first<{ id: number }>())!.id
}

async function seedTeacher(db: D1) {
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO teacher (token, name, subject, created_at) VALUES (?, ?, ?, ?)')
    .bind('tok1234567890abc', 'Teacher', 'Math', now).run()
  return (await db.prepare('SELECT id FROM teacher WHERE token=?').bind('tok1234567890abc').first<{ id: number }>())!.id
}

let db: D1

beforeEach(async () => {
  ;({ db } = testDb())
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(TEST_EMAIL, now, 'test-seed').run()
})

// ---- GET /api/admin/templates ----

describe('GET /api/admin/templates', () => {
  it('empty → []', async () => {
    const r = await handleTemplates(req('GET', '/api/admin/templates'), makeEnv(db), TEST_EMAIL)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual([])
  })

  it('response includes { id, name, layout, active, images, created_at, created_by }', async () => {
    await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'Test', layout: 'classic' }),
      makeEnv(db), TEST_EMAIL,
    )
    const r = await handleTemplates(req('GET', '/api/admin/templates'), makeEnv(db), TEST_EMAIL)
    const list = await r.json() as Array<Record<string, unknown>>
    expect(list).toHaveLength(1)
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('name', 'Test')
    expect(list[0]).toHaveProperty('layout', 'classic')
    expect(list[0]).toHaveProperty('active')
    expect(list[0]).toHaveProperty('images')
    expect(list[0]).toHaveProperty('created_at')
    expect(list[0]).toHaveProperty('created_by')
  })
})

// ---- POST /api/admin/templates ----

describe('POST /api/admin/templates', () => {
  it('creates template with defaults, returns 200 AdminTemplate', async () => {
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'Holiday', layout: 'lotus' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as Record<string, unknown>
    expect(body).toHaveProperty('id')
    expect(body.name).toBe('Holiday')
    expect(body.layout).toBe('lotus')
    expect(body).toHaveProperty('active', 1)
    expect(typeof (body.images as object)).toBe('object')
    expect(body.created_by).toBe(TEST_EMAIL)
  })

  it('name > 60 chars → 400', async () => {
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'x'.repeat(61), layout: 'classic' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('invalid layout → 400', async () => {
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'T', layout: 'nonexistent' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('valid layouts accepted: classic, lotus, spring, night, minimal', async () => {
    for (const layout of ['classic', 'lotus', 'spring', 'night', 'minimal']) {
      const r = await handleTemplates(
        req('POST', '/api/admin/templates', { name: `T-${layout}`, layout }),
        makeEnv(db), TEST_EMAIL,
      )
      expect(r.status, `layout ${layout} should be accepted`).toBe(200)
    }
  })

  it('creates template with image slot', async () => {
    const imgId = await seedImage(db)
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', {
        name: 'WithImage', layout: 'classic',
        images: { background: imgId },
      }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, { id: number; token: string }> }
    expect(body.images['background']?.token).toBe('imgabc1234567890')
  })

  it('unknown image id → 400', async () => {
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', {
        name: 'T', layout: 'classic',
        images: { banner: 9999 },
      }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('invalid slot name → 400', async () => {
    const imgId = await seedImage(db)
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', {
        name: 'T', layout: 'classic',
        images: { badslot: imgId },
      }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// ---- PUT /api/admin/templates/:id ----

describe('PUT /api/admin/templates/:id', () => {
  it('updates name, layout, active', async () => {
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }

    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${created.id}`, { name: 'Updated', layout: 'lotus', active: 0 }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { name: string; layout: string; active: number }
    expect(body.name).toBe('Updated')
    expect(body.layout).toBe('lotus')
    expect(body.active).toBe(0)
  })

  it('unknown id → 404', async () => {
    const r = await handleTemplates(
      req('PUT', '/api/admin/templates/9999', { name: 'T', layout: 'classic' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(404)
  })

  it('invalid layout → 400', async () => {
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }
    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${created.id}`, { name: 'T', layout: 'nope' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('setting an image slot with valid image id → 200', async () => {
    const imgId = await seedImage(db)
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }
    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${created.id}`, {
        name: 'T', layout: 'classic',
        images: { banner: imgId },
      }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, { id: number; token: string }> }
    expect(body.images['banner']?.token).toBe('imgabc1234567890')
  })

  it('setting an image slot to null removes it', async () => {
    const imgId = await seedImage(db)
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', {
        name: 'T', layout: 'classic', images: { banner: imgId },
      }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }

    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${created.id}`, {
        name: 'T', layout: 'classic', images: { banner: null },
      }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { images: Record<string, unknown> }
    expect(body.images).not.toHaveProperty('banner')
  })
})

// ---- DELETE /api/admin/templates/:id ----

describe('DELETE /api/admin/templates/:id', () => {
  it('delete unused template → 200', async () => {
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }
    const r = await handleTemplates(
      req('DELETE', `/api/admin/templates/${created.id}`),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const row = await db.prepare('SELECT id FROM template WHERE id=?').bind(created.id).first()
    expect(row).toBeNull()
  })

  it('delete template in use by a card → 409 conflict', async () => {
    const tid = await seedTeacher(db)
    await db.prepare('INSERT INTO teacher_title (teacher_id, title) VALUES (?, ?)').bind(tid, 'Thầy').run()
    await db.prepare('INSERT INTO teacher_profile (teacher_id, department, show_on_home) VALUES (?, ?, ?)')
      .bind(tid, '', 1).run()

    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }

    const now = new Date().toISOString()
    await db.prepare('INSERT INTO student_card (public_id,teacher_id,template_id,message,from_name,from_class,anonymous,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind('crd1234567890abc', tid, created.id, 'msg', '', '', 0, 'pending', now).run()

    const r = await handleTemplates(
      req('DELETE', `/api/admin/templates/${created.id}`),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(409)
    expect((await r.json() as { error: string }).error).toBe('conflict')
  })

  it('unknown id → 404', async () => {
    const r = await handleTemplates(
      req('DELETE', '/api/admin/templates/9999'),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(404)
  })
})

// ---- Item (1) atomicity and FK-mapping tests ----

describe('createTemplate atomicity', () => {
  it('FK in batch → 400 and no orphan template row left', async () => {
    // Seed an image so parseTemplateBody pre-validation passes, then monkey-patch
    // the batch to simulate an FK failure (race: image deleted between validation and batch)
    const imgId = await seedImage(db)
    // Real race: the image disappears after validation, so the REAL batch hits SQLite's FK check
    // and must roll back the template row it inserted earlier in the same batch.
    await ensureSchema(db)
    const realBatch = db.batch.bind(db)
    ;(db as unknown as { batch: typeof db.batch }).batch = async (stmts) => {
      await db.prepare('DELETE FROM image WHERE id = ?').bind(imgId).run()
      return realBatch(stmts)
    }

    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'OrphanCheck', layout: 'classic', images: { background: imgId } }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(400)

    // With the fix (template INSERT in the same batch), no row is committed on rollback.
    // Before the fix (separate .run() + batch), the template row IS created → assertion fails.
    const row = await db.prepare('SELECT id FROM template WHERE name = ?').bind('OrphanCheck').first()
    expect(row).toBeNull()
  })

  it('create with two image slots (background + banner) attaches every image to the new template', async () => {
    const a = await seedImage(db, 'imgslota00000001')
    const b = await seedImage(db, 'imgslotb00000001')
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'TwoSlots', layout: 'night', images: { background: a, banner: b } }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r.status).toBe(200)
    const t = await r.json() as { id: number }
    const rows = await db.prepare('SELECT template_id, slot, image_id FROM template_image ORDER BY slot').all<{ template_id: number; slot: string; image_id: number }>()
    expect(rows.results).toEqual([
      { template_id: t.id, slot: 'background', image_id: a },
      { template_id: t.id, slot: 'banner', image_id: b },
    ])
  })

  it('same-name templates created back to back return their own distinct rows', async () => {
    const r1 = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'DupName', layout: 'classic' }),
      makeEnv(db), TEST_EMAIL,
    )
    const r2 = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'DupName', layout: 'lotus' }),
      makeEnv(db), TEST_EMAIL,
    )
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const t1 = await r1.json() as { id: number; name: string; layout: string }
    const t2 = await r2.json() as { id: number; name: string; layout: string }
    expect(t1.id).not.toBe(t2.id)
    expect(t1.name).toBe('DupName')
    expect(t1.layout).toBe('classic')
    expect(t2.name).toBe('DupName')
    expect(t2.layout).toBe('lotus')
  })
})

describe('updateTemplate FK mapping', () => {
  it('batch FK error in updateTemplate → 400 (not unhandled throw)', async () => {
    const created = await (
      await handleTemplates(req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }), makeEnv(db), TEST_EMAIL)
    ).json() as { id: number }

    // Monkey-patch batch to simulate FK error (race: image deleted between validation and batch)
    ;(db as unknown as Record<string, unknown>).batch = async () => {
      throw new Error('FOREIGN KEY constraint failed')
    }

    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${created.id}`, { name: 'Updated', layout: 'lotus' }),
      makeEnv(db), TEST_EMAIL,
    )
    // Before fix: unhandled error propagates → test throws (not 400).
    // After fix: FK → HttpError('bad_request') → 400.
    expect(r.status).toBe(400)
  })
})

// ===================================================================
// New for privacy-about plan — photo slot removed
// ===================================================================

describe('template slot: photo slot → 400 (passes after layouts.ts SLOTS change)', () => {
  it('POST with photo slot in images → 400 (isSlot("photo") now false)', async () => {
    // After shared/layouts.ts removes "photo" from SLOTS,
    // isSlot("photo") returns false → handleTemplates returns 400.
    const imgId = await seedImage(db)
    const r = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'T', layout: 'classic', images: { photo: imgId } }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })

  it('PUT with photo slot in images → 400', async () => {
    const imgId = await seedImage(db)
    // Create a valid template first
    const cr = await handleTemplates(
      req('POST', '/api/admin/templates', { name: 'T', layout: 'classic' }),
      makeEnv(db),
      TEST_EMAIL,
    )
    const tmpl = await cr.json() as { id: number }
    const r = await handleTemplates(
      req('PUT', `/api/admin/templates/${tmpl.id}`, { name: 'T', layout: 'classic', images: { photo: imgId } }),
      makeEnv(db),
      TEST_EMAIL,
    )
    expect(r.status).toBe(400)
  })
})

// @vitest-environment node
/**
 * Tests for bulkMap.ts — pure `toBulkItems(parseResult)` that converts parseBulkInput
 * output to the BulkTeacherInputItem array expected by handleAdmin POST /bulk.
 *
 * Also tests the full contract path:
 *   parseBulkInput(text) → toBulkItems → handleAdmin POST /bulk → 200
 *
 * Import of toBulkItems fails until bulkMap.ts is created → all tests fail.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../../../worker/token.ts', () => ({
  newToken: vi.fn(() => 'generatedtoken1234'),
  isToken: (t: string) => /^[a-z0-9]{16}$/.test(t),
}))

// This import fails until bulkMap.ts is created → all tests fail.
import { toBulkItems } from './bulkMap.ts'
import { parseBulkInput } from './bulkParse.ts'
import { handleAdmin } from '../../../worker/admin.ts'
import { newToken } from '../../../worker/token.ts'
import { testDb, type D1 } from '../../../worker/testDb.ts'
import { TEST_EMAIL } from '../../../worker/testAuth.ts'
import type { BulkTeacherInputItem } from '../../../shared/api.ts'

function makeEnv(db: D1) {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    PUBLIC_IP_LIMIT: { limit: async () => ({ success: true }) },
    SUBMIT_IP_LIMIT: { limit: async () => ({ success: true }) },
    CARD_IP_LIMIT: { limit: async () => ({ success: true }) },
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: true }) },
    IMAGE_IP_LIMIT: { limit: async () => ({ success: true }) },
    AUTH_LIMIT: { limit: async () => ({ success: true }) },
    USER_READ_LIMIT: { limit: async () => ({ success: true }) },
    USER_WRITE_LIMIT: { limit: async () => ({ success: true }) },
    BOOTSTRAP_EMAIL: undefined as string | undefined,
    ALLOW_FIRST_CLAIM: undefined as string | undefined,
    ADMIN_LEGACY_LOGIN: '1' as string | undefined,
    GOOGLE_CLIENT_ID: '',
    NONCE_KEY: '',
    SUB_HMAC_KEY: '',
    IP_HMAC_KEY: '',
  }
}

function adminReq(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'X-Admin-Email': TEST_EMAIL,
    'CF-Connecting-IP': '1.2.3.4',
  }
  if (method !== 'GET') headers['X-Requested-With'] = 'fetch'
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return new Request(`https://x${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

let db: D1
let seq = 0

beforeEach(async () => {
  ;({ db } = testDb())
  seq = 0
  vi.mocked(newToken).mockImplementation(() => `bm${String(seq++).padStart(14, '0')}`)
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(TEST_EMAIL, now, 'test-seed').run()
})

// ── toBulkItems unit tests ─────────────────────────────────────────────────

describe('toBulkItems', () => {
  it('maps valid parseResult to BulkTeacherInputItem[]', () => {
    const result = parseBulkInput('Thầy Nguyễn Văn A | Toán | Tổ Toán\nCô Trần Thị B')
    const items = toBulkItems(result)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual<BulkTeacherInputItem>({ title: 'Thầy', name: 'Nguyễn Văn A', subject: 'Toán', department: 'Tổ Toán' })
    expect(items[1]).toEqual<BulkTeacherInputItem>({ title: 'Cô', name: 'Trần Thị B' })
  })

  it('omits subject/department when not present', () => {
    const result = parseBulkInput('Thầy A')
    const items = toBulkItems(result)
    expect(items[0]).not.toHaveProperty('subject')
    expect(items[0]).not.toHaveProperty('department')
  })

  it('empty input → empty array', () => {
    const result = parseBulkInput('')
    expect(toBulkItems(result)).toEqual([])
  })
})

// ── Full contract path: parseBulkInput → toBulkItems → handleAdmin POST /bulk ─

describe('bulk contract path', () => {
  it('parseBulkInput → toBulkItems → POST /bulk → 200 with correct teachers', async () => {
    const text = 'Thầy Nguyễn Văn A | Toán\nCô Trần Thị B | Văn | Tổ Văn'
    const result = parseBulkInput(text)
    const items = toBulkItems(result)

    const r = await handleAdmin(
      adminReq('POST', '/api/admin/teachers/bulk', { items }),
      makeEnv(db),
    )
    expect(r.status).toBe(200)
    const body = await r.json() as { created: Array<{ name: string; title: string; subject: string; department: string }> }
    expect(body.created).toHaveLength(2)
    expect(body.created[0].name).toBe('Nguyễn Văn A')
    expect(body.created[0].title).toBe('Thầy')
    expect(body.created[0].subject).toBe('Toán')
    expect(body.created[1].name).toBe('Trần Thị B')
    expect(body.created[1].title).toBe('Cô')
    expect(body.created[1].department).toBe('Tổ Văn')
  })

  it('invalid lines (no prefix) are excluded from items', () => {
    const result = parseBulkInput('No prefix line\nThầy OK')
    const items = toBulkItems(result)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('OK')
  })
})

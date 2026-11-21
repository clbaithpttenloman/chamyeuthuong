/**
 * src/api.test.ts — unit tests for messageFor (status → Vietnamese message map).
 *
 * Before fix: messageFor(new Error('oops')) returns 'oops' (raw e.message).
 * After fix:  messageFor(new Error('oops')) returns 'Lỗi kết nối, vui lòng thử lại.'
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, messageFor, logout } from './api'

describe('messageFor', () => {
  it('400 → Dữ liệu không hợp lệ', () => {
    expect(messageFor(new ApiError(400, 'bad_request'))).toBe('Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.')
  })

  it('401 → không có quyền', () => {
    expect(messageFor(new ApiError(401, 'unauthorized'))).toBe('Bạn không có quyền thực hiện thao tác này.')
  })

  it('403 → không có quyền', () => {
    expect(messageFor(new ApiError(403, 'forbidden'))).toBe('Bạn không có quyền thực hiện thao tác này.')
  })

  it('404 → không tìm thấy', () => {
    expect(messageFor(new ApiError(404, 'not_found'))).toBe('Không tìm thấy dữ liệu.')
  })

  it('409 → xung đột', () => {
    expect(messageFor(new ApiError(409, 'conflict'))).toBe('Dữ liệu đã tồn tại hoặc xung đột.')
  })

  it('429 → quá nhiều yêu cầu', () => {
    expect(messageFor(new ApiError(429, 'rate_limited'))).toBe('Quá nhiều yêu cầu. Vui lòng thử lại sau.')
  })

  it('500 → lỗi máy chủ', () => {
    expect(messageFor(new ApiError(500, 'unavailable'))).toBe('Lỗi máy chủ. Vui lòng thử lại sau.')
  })

  it('503 → lỗi máy chủ', () => {
    expect(messageFor(new ApiError(503, 'unavailable'))).toBe('Lỗi máy chủ. Vui lòng thử lại sau.')
  })

  it('non-ApiError Error → Lỗi kết nối (not raw e.message)', () => {
    // Before fix: returns 'Failed to fetch' (raw e.message).
    // After fix: returns the generic connection-error string.
    expect(messageFor(new Error('Failed to fetch'))).toBe('Lỗi kết nối, vui lòng thử lại.')
  })

  it('non-ApiError TypeError → Lỗi kết nối', () => {
    expect(messageFor(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('Lỗi kết nối, vui lòng thử lại.')
  })

  it('string thrown → Lỗi kết nối', () => {
    expect(messageFor('some string error')).toBe('Lỗi kết nối, vui lòng thử lại.')
  })

  it('null → Lỗi kết nối', () => {
    expect(messageFor(null)).toBe('Lỗi kết nối, vui lòng thử lại.')
  })
})

// Security review (frontend): a rejected logout must not look like a successful one.
describe('logout — checks the response status', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))

  it('resolves on 200', async () => {
    respond(200, { ok: true })
    await expect(logout()).resolves.toBeUndefined()
  })
  it('throws ApiError on 403 (CSRF rejection) and 500', async () => {
    respond(403, { error: 'forbidden' })
    await expect(logout()).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    respond(500, { error: 'server_error' })
    await expect(logout()).rejects.toMatchObject({ status: 500 })
  })
  it('sends X-Requested-With', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await logout()
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-Requested-With': 'fetch' })
  })
})

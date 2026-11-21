import { describe, it, expect, vi } from 'vitest'
import { revokeAdminSession } from './signOut.ts'
import { ApiError } from '../../api.ts'

describe('revokeAdminSession — admin sign-out never hides a failed logout', () => {
  it('no Google session → nothing to revoke, ok', async () => {
    const logout = vi.fn()
    expect(await revokeAdminSession(false, logout)).toEqual({ ok: true })
    expect(logout).not.toHaveBeenCalled()
  })
  it('logout succeeds → ok', async () => {
    expect(await revokeAdminSession(true, async () => {})).toEqual({ ok: true })
  })
  it('logout 401 (session already expired) → ok: the admin is already signed out', async () => {
    const r = await revokeAdminSession(true, async () => { throw new ApiError(401, 'unauthorized') })
    expect(r.ok).toBe(true)
  })
  it('logout fails (403/500/network) → not ok, so the UI keeps the signed-in state', async () => {
    const r = await revokeAdminSession(true, async () => { throw new Error('403: forbidden') })
    expect(r.ok).toBe(false)
  })
})

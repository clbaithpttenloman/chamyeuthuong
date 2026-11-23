// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ApiError } from '../api'
import { AUTH_MESSAGES, authMessage } from './authMessages.ts'

describe('authMessage', () => {
  it('maps every known server code to its Vietnamese message', () => {
    for (const [code, text] of Object.entries(AUTH_MESSAGES)) {
      expect(authMessage(new ApiError(400, code))).toBe(text)
    }
  })

  it('unknown server code falls back to the generic message (never raw text)', () => {
    expect(authMessage(new ApiError(500, 'something_new'))).toBe('Có lỗi xảy ra, vui lòng thử lại.')
  })

  it('network failure (not an ApiError) → connection message', () => {
    expect(authMessage(new TypeError('Failed to fetch'))).toBe('Lỗi kết nối, vui lòng thử lại.')
  })

  it('invalid_credentials never says which of username or password was wrong', () => {
    expect(AUTH_MESSAGES.invalid_credentials).not.toMatch(/tên đăng nhập sai|mật khẩu sai/i)
  })
})

// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { initialState, isTextValid, sendReducer, type SendState } from './sendReducer.ts'
import { MAX_FROM_CLASS, MAX_FROM_NAME, MAX_MESSAGE, MAX_NEWLINES } from '../../../shared/api.ts'

// ── initialState ──────────────────────────────────────────────────────────

describe('initialState', () => {
  it('step is 1', () => expect(initialState(null).step).toBe(1))
  it('anonymous is true (Gửi ẩn danh ON by default)', () => expect(initialState(null).anonymous).toBe(true))
  it('text is empty', () => expect(initialState(null).text).toBe(''))
  it('stores preselectedTeacherId in both fields', () => {
    const s = initialState('abc1234567890123')
    expect(s.teacherPublicId).toBe('abc1234567890123')
    expect(s.preselectedTeacherId).toBe('abc1234567890123')
  })
  it('preselected null leaves both fields null', () => {
    const s = initialState(null)
    expect(s.teacherPublicId).toBeNull()
    expect(s.preselectedTeacherId).toBeNull()
  })
})

// ── isTextValid ───────────────────────────────────────────────────────────

describe('isTextValid', () => {
  it('empty string is invalid', () => expect(isTextValid('')).toBe(false))
  it('1 char is valid', () => expect(isTextValid('a')).toBe(true))
  it(`${MAX_MESSAGE} code points is valid`, () => {
    expect(isTextValid('a'.repeat(MAX_MESSAGE))).toBe(true)
  })
  it(`${MAX_MESSAGE + 1} code points is invalid`, () => {
    expect(isTextValid('a'.repeat(MAX_MESSAGE + 1))).toBe(false)
  })
  it(`${MAX_NEWLINES} newlines is valid`, () => {
    expect(isTextValid('a\n'.repeat(MAX_NEWLINES) + 'b')).toBe(true)
  })
  it(`${MAX_NEWLINES + 1} newlines is invalid`, () => {
    expect(isTextValid('a\n'.repeat(MAX_NEWLINES + 1) + 'b')).toBe(false)
  })
  it('multibyte code points count correctly', () => {
    // 🎉 is U+1F389, 1 code point
    const s = '🎉'.repeat(MAX_MESSAGE)
    expect(isTextValid(s)).toBe(true)
    expect(isTextValid(s + '🎉')).toBe(false)
  })
})

// ── SELECT_TEMPLATE ───────────────────────────────────────────────────────

describe('SELECT_TEMPLATE', () => {
  it('no preselected teacher → goes to step 2', () => {
    const s = sendReducer(initialState(null), { type: 'SELECT_TEMPLATE', templateId: 1 })
    expect(s.step).toBe(2)
    expect(s.templateId).toBe(1)
  })

  it('preselected teacher → skips to step 3', () => {
    const s = sendReducer(initialState('abc1234567890123'), { type: 'SELECT_TEMPLATE', templateId: 2 })
    expect(s.step).toBe(3)
    expect(s.templateId).toBe(2)
  })

  it('clears error', () => {
    const base: SendState = { ...initialState(null), error: 'some error' }
    const s = sendReducer(base, { type: 'SELECT_TEMPLATE', templateId: 1 })
    expect(s.error).toBeNull()
  })
})

// ── SELECT_TEACHER ────────────────────────────────────────────────────────

describe('SELECT_TEACHER', () => {
  it('goes to step 3 and stores publicId', () => {
    const base = sendReducer(initialState(null), { type: 'SELECT_TEMPLATE', templateId: 1 })
    const s = sendReducer(base, { type: 'SELECT_TEACHER', publicId: 'tid123456789012' })
    expect(s.step).toBe(3)
    expect(s.teacherPublicId).toBe('tid123456789012')
  })

  it('clears error', () => {
    const base: SendState = { ...initialState(null), step: 2, error: 'err', templateId: 1 }
    const s = sendReducer(base, { type: 'SELECT_TEACHER', publicId: 'tid123456789012' })
    expect(s.error).toBeNull()
  })
})

// ── SET_TEXT ──────────────────────────────────────────────────────────────

describe('SET_TEXT', () => {
  it('stores the text', () => {
    const s = sendReducer(initialState(null), { type: 'SET_TEXT', text: 'Hello' })
    expect(s.text).toBe('Hello')
  })

  it(`clamps to ${MAX_MESSAGE} code points`, () => {
    const long = 'x'.repeat(MAX_MESSAGE + 50)
    const s = sendReducer(initialState(null), { type: 'SET_TEXT', text: long })
    expect([...s.text].length).toBeLessThanOrEqual(MAX_MESSAGE)
  })

  it(`clamps to ${MAX_NEWLINES} newlines`, () => {
    const text = 'line\n'.repeat(MAX_NEWLINES + 2) + 'end'
    const s = sendReducer(initialState(null), { type: 'SET_TEXT', text })
    const count = (s.text.match(/\n/g) ?? []).length
    expect(count).toBeLessThanOrEqual(MAX_NEWLINES)
  })

  it('clears error', () => {
    const base: SendState = { ...initialState(null), error: 'err' }
    const s = sendReducer(base, { type: 'SET_TEXT', text: 'hello' })
    expect(s.error).toBeNull()
  })
})

// ── SET_FROM_NAME / SET_FROM_CLASS ────────────────────────────────────────

describe('SET_FROM_NAME', () => {
  it('stores the name', () => {
    const s = sendReducer(initialState(null), { type: 'SET_FROM_NAME', name: 'Minh Anh' })
    expect(s.fromName).toBe('Minh Anh')
  })

  it(`clamps to ${MAX_FROM_NAME} code points`, () => {
    const s = sendReducer(initialState(null), { type: 'SET_FROM_NAME', name: 'x'.repeat(MAX_FROM_NAME + 5) })
    expect([...s.fromName].length).toBeLessThanOrEqual(MAX_FROM_NAME)
  })
})

describe('SET_FROM_CLASS', () => {
  it('stores the class', () => {
    const s = sendReducer(initialState(null), { type: 'SET_FROM_CLASS', cls: '11A1' })
    expect(s.fromClass).toBe('11A1')
  })

  it(`clamps to ${MAX_FROM_CLASS} code points`, () => {
    const s = sendReducer(initialState(null), { type: 'SET_FROM_CLASS', cls: 'x'.repeat(MAX_FROM_CLASS + 5) })
    expect([...s.fromClass].length).toBeLessThanOrEqual(MAX_FROM_CLASS)
  })
})

// ── SET_ANONYMOUS ─────────────────────────────────────────────────────────

describe('SET_ANONYMOUS', () => {
  it('sets anonymous to false', () => {
    const s = sendReducer(initialState(null), { type: 'SET_ANONYMOUS', anonymous: false })
    expect(s.anonymous).toBe(false)
  })

  it('sets anonymous back to true', () => {
    const base: SendState = { ...initialState(null), anonymous: false }
    const s = sendReducer(base, { type: 'SET_ANONYMOUS', anonymous: true })
    expect(s.anonymous).toBe(true)
  })
})

// ── GO_BACK ───────────────────────────────────────────────────────────────

describe('GO_BACK', () => {
  it('step 2 → step 1', () => {
    const base: SendState = { ...initialState(null), step: 2 }
    expect(sendReducer(base, { type: 'GO_BACK' }).step).toBe(1)
  })

  it('step 3, no preselected teacher → step 2', () => {
    const base: SendState = { ...initialState(null), step: 3, teacherPublicId: 'tid' }
    expect(sendReducer(base, { type: 'GO_BACK' }).step).toBe(2)
  })

  it('step 3, preselected teacher → step 1 (skips teacher picker on way back)', () => {
    const base: SendState = { ...initialState('tid'), step: 3 }
    expect(sendReducer(base, { type: 'GO_BACK' }).step).toBe(1)
  })

  it('step 1, GO_BACK → stays at step 1', () => {
    expect(sendReducer(initialState(null), { type: 'GO_BACK' }).step).toBe(1)
  })

  it('clears error', () => {
    const base: SendState = { ...initialState(null), step: 2, error: 'err' }
    expect(sendReducer(base, { type: 'GO_BACK' }).error).toBeNull()
  })
})

// ── SUBMIT_SUCCESS ────────────────────────────────────────────────────────

describe('SUBMIT_SUCCESS', () => {
  it('goes to step 4', () => {
    const base: SendState = { ...initialState(null), step: 3 }
    expect(sendReducer(base, { type: 'SUBMIT_SUCCESS' }).step).toBe(4)
  })

  it('clears error', () => {
    const base: SendState = { ...initialState(null), step: 3, error: 'err' }
    expect(sendReducer(base, { type: 'SUBMIT_SUCCESS' }).error).toBeNull()
  })
})

// ── SET_ERROR ─────────────────────────────────────────────────────────────

describe('SET_ERROR', () => {
  it('stores the error message', () => {
    const s = sendReducer(initialState(null), { type: 'SET_ERROR', error: 'Lỗi kết nối' })
    expect(s.error).toBe('Lỗi kết nối')
  })

  it('does not change step', () => {
    const base: SendState = { ...initialState(null), step: 3 }
    const s = sendReducer(base, { type: 'SET_ERROR', error: 'err' })
    expect(s.step).toBe(3)
  })
})

// ── RESET ─────────────────────────────────────────────────────────────────

describe('RESET', () => {
  it('returns to initial state with step 1', () => {
    const filled: SendState = {
      step: 4,
      templateId: 2,
      teacherPublicId: 'tid',
      preselectedTeacherId: null,
      text: 'some text',
      fromName: 'Minh',
      fromClass: '11A',
      anonymous: false,
      error: 'err',
    }
    const s = sendReducer(filled, { type: 'RESET' })
    expect(s).toEqual(initialState(null))
  })
})

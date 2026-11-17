// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseBulkInput } from './bulkParse.ts'

describe('parseBulkInput — title extraction', () => {
  it('"Thầy X | Toán" → item with title Thầy, name X, subject Toán', () => {
    const result = parseBulkInput('Thầy Nguyễn Văn A | Toán')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'Nguyễn Văn A', subject: 'Toán', title: 'Thầy' })
    expect(result.invalidLines).toHaveLength(0)
  })

  it('"Cô Y" (no subject) → item with title Cô, name Y', () => {
    const result = parseBulkInput('Cô Trần Thị B')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ name: 'Trần Thị B', title: 'Cô' })
    expect(result.items[0].subject).toBeUndefined()
    expect(result.invalidLines).toHaveLength(0)
  })

  it('"thầy X | Lý" (lowercase prefix) → title normalised to Thầy', () => {
    const result = parseBulkInput('thầy Lê Văn C | Lý')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ title: 'Thầy', name: 'Lê Văn C', subject: 'Lý' })
    expect(result.invalidLines).toHaveLength(0)
  })

  it('"CÔ X | Văn" (all-caps prefix) → title normalised to Cô', () => {
    const result = parseBulkInput('CÔ Phạm Thị D | Văn')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ title: 'Cô', name: 'Phạm Thị D' })
    expect(result.invalidLines).toHaveLength(0)
  })

  it('no title prefix → empty items list, line 1 in invalidLines', () => {
    const result = parseBulkInput('Nguyễn Văn A | Toán')
    expect(result.items).toHaveLength(0)
    expect(result.invalidLines).toContain(1)
  })

  it('name with no pipe and no title → invalid', () => {
    const result = parseBulkInput('Nguyễn Văn A')
    expect(result.items).toHaveLength(0)
    expect(result.invalidLines).toEqual([1])
  })

  it('mixed valid and invalid lines → valid items returned, invalid line numbers listed', () => {
    const result = parseBulkInput(
      'Thầy Nguyễn Văn A | Toán\nTrần Thị B | Văn\nCô Lê Thị C | Hóa',
    )
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({ title: 'Thầy', name: 'Nguyễn Văn A' })
    expect(result.items[1]).toMatchObject({ title: 'Cô', name: 'Lê Thị C' })
    expect(result.invalidLines).toEqual([2])
  })

  it('all invalid → empty items, all line numbers in invalidLines', () => {
    const result = parseBulkInput('Nguyễn Văn A | Toán\nTrần Thị B | Văn')
    expect(result.items).toHaveLength(0)
    expect(result.invalidLines).toEqual([1, 2])
  })

  it('capped at 100 items (excess valid lines are ignored)', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `Thầy Teacher${i} | Toán`).join('\n')
    const result = parseBulkInput(lines)
    expect(result.items).toHaveLength(100)
  })

  it('empty lines are skipped, line numbers match the textarea (blank lines counted)', () => {
    // Line 1 valid, line 2 blank, line 3 invalid
    const result = parseBulkInput('Thầy A | Toán\n\nTrần Thị B')
    expect(result.items).toHaveLength(1)
    expect(result.invalidLines).toEqual([3])
  })

  it('whitespace-only lines are treated as empty and skipped', () => {
    const result = parseBulkInput('Cô Trần Thị B | Văn\n   \nThầy Nguyễn Văn A | Toán')
    expect(result.items).toHaveLength(2)
    expect(result.invalidLines).toHaveLength(0)
  })

  it('title prefix must be followed by a space and a name (not just the word alone)', () => {
    const result = parseBulkInput('Thầy | Toán')
    // "Thầy" followed by nothing (name is empty after removing prefix) → invalid
    expect(result.items).toHaveLength(0)
    expect(result.invalidLines).toContain(1)
  })

  it('subject is optional — pipe absent means no subject', () => {
    const result = parseBulkInput('Cô Lê Thị C')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].subject).toBeUndefined()
  })

  it('subject is trimmed', () => {
    const result = parseBulkInput('Thầy Nguyễn Văn A |  Toán  ')
    expect(result.items[0].subject).toBe('Toán')
  })

  it('name is trimmed (after removing title prefix)', () => {
    const result = parseBulkInput('Thầy   Nguyễn Văn A | Toán')
    // After removing "Thầy " prefix and trimming, name should be "Nguyễn Văn A"
    expect(result.items[0].name).toBe('Nguyễn Văn A')
  })

  it('empty input → empty items and invalidLines', () => {
    const result = parseBulkInput('')
    expect(result.items).toHaveLength(0)
    expect(result.invalidLines).toHaveLength(0)
  })
})

describe('parseBulkInput — department column', () => {
  it('"Thầy X | Toán | Tổ Toán - Tin" → item has department', () => {
    const result = parseBulkInput('Thầy Nguyễn Văn A | Toán | Tổ Toán - Tin')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      name: 'Nguyễn Văn A',
      subject: 'Toán',
      department: 'Tổ Toán - Tin',
      title: 'Thầy',
    })
  })

  it('department is trimmed', () => {
    const result = parseBulkInput('Cô X |  Văn  |  Tổ Văn - Sử  ')
    expect(result.items[0].department).toBe('Tổ Văn - Sử')
    expect(result.items[0].subject).toBe('Văn')
  })

  it('department absent when only two pipes used', () => {
    const result = parseBulkInput('Thầy X | Toán')
    expect(result.items[0].department).toBeUndefined()
  })

  it('empty department pipe → department undefined', () => {
    const result = parseBulkInput('Thầy X | Toán | ')
    expect(result.items[0].department).toBeUndefined()
  })

  it('all three columns in a multi-line input', () => {
    const input = 'Thầy A | Toán | Tổ Toán\nCô B | Văn | Tổ Văn'
    const result = parseBulkInput(input)
    expect(result.items[0].department).toBe('Tổ Toán')
    expect(result.items[1].department).toBe('Tổ Văn')
  })
})

describe('parseBulkInput — line numbers and Unicode forms', () => {
  it('reports line numbers as seen in the textarea, counting blank lines', () => {
    const r = parseBulkInput('Thầy An | Toán\n\nNguyễn Bình\nCô Chi')
    expect(r.invalidLines).toEqual([3])
    expect(r.items.map((i) => i.name)).toEqual(['An', 'Chi'])
  })
  it('accepts a decomposed (NFD) "Thầy" pasted from macOS', () => {
    const r = parseBulkInput('Thầy An'.normalize('NFD'))
    expect(r.invalidLines).toEqual([])
    expect(r.items[0]).toMatchObject({ title: 'Thầy', name: 'An' })
  })
  it('reports lines beyond the 100-item limit instead of dropping them silently', () => {
    const lines = Array.from({ length: 102 }, (_, i) => `Cô N${i}`).join('\n')
    const r = parseBulkInput(lines)
    expect(r.items).toHaveLength(100)
    expect(r.overLimit).toBe(2)
  })
})

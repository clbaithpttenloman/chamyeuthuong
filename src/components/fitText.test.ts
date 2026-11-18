// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { fitText, BASE_SIZE, SHRINK, MAX_STEPS, type FitTarget } from './fitText.ts'

/** A zone whose content height is proportional to its font size (like wrapped text). */
function zone(contentPerCqw: number, clientHeight = 100) {
  const z = {
    style: { fontSize: '' },
    clientHeight,
    sets: 0,
    get scrollHeight() { return parseFloat(this.style.fontSize) * contentPerCqw },
  }
  const style = z.style
  z.style = new Proxy(style, { set(t, k, v) { (t as Record<string | symbol, unknown>)[k] = v; z.sets++; return true } })
  return z as FitTarget & { sets: number }
}

describe('fitText', () => {
  it('starts at the base size for the ratio and leaves text that fits unchanged', () => {
    for (const ratio of ['portrait', 'landscape'] as const) {
      const z = zone(10) // 5.6 × 10 = 56 ≤ 100 → fits at base
      expect(fitText(z, ratio)).toBe(BASE_SIZE[ratio])
      expect(z.style.fontSize).toBe(`${BASE_SIZE[ratio]}cqw`)
      expect(z.sets).toBe(1)
    }
    expect(BASE_SIZE.portrait).toBeGreaterThan(BASE_SIZE.landscape)
  })

  it('shrinks until the text fits, then stops', () => {
    const z = zone(25) // needs size ≤ 4.04: 5.6 → 5.15 → 4.74 → 4.36 → 4.01
    const size = fitText(z, 'portrait')
    expect(size * 25).toBeLessThanOrEqual(101)
    expect(size / SHRINK * 25).toBeGreaterThan(101) // one step earlier did not fit
    expect(z.sets).toBe(5)
  })

  it('never takes more than MAX_STEPS shrink steps, even if the text still overflows', () => {
    const z = zone(10_000)
    const size = fitText(z, 'landscape')
    expect(z.sets).toBe(1 + MAX_STEPS)
    expect(size).toBeCloseTo(BASE_SIZE.landscape * SHRINK ** MAX_STEPS, 6)
  })
})

// @vitest-environment node
/**
 * Tests for src/game/timelines.ts — pure helper functions.
 */
import { describe, it, expect } from 'vitest'
import { sparkleOffset } from './timelines.ts'

// ─── sparkleOffset ────────────────────────────────────────────────────────────

describe('sparkleOffset — distributed around center', () => {
  it('first spark (i=0) has tx = dist (angle 0 → cos=1, sin=0)', () => {
    const { tx, ty } = sparkleOffset(0, 8, 60)
    expect(tx).toBeCloseTo(60, 5)        // cos(0) * 60
    expect(ty).toBeCloseTo(-25, 5)       // sin(0) * 60 - 25 = -25
  })

  it('i=2 out of 8 is at angle π/2 (tx≈0, ty≈60-25=35)', () => {
    const { tx, ty } = sparkleOffset(2, 8, 60)
    expect(tx).toBeCloseTo(0, 4)         // cos(π/2) ≈ 0
    expect(ty).toBeCloseTo(60 - 25, 4)  // sin(π/2) * 60 - 25 = 35
  })

  it('i=4 out of 8 is at angle π (tx = -dist, ty = -25)', () => {
    const { tx, ty } = sparkleOffset(4, 8, 60)
    expect(tx).toBeCloseTo(-60, 4)       // cos(π) * 60 = -60
    expect(ty).toBeCloseTo(-25, 4)       // sin(π) * 60 - 25 ≈ -25
  })

  it('tx magnitude is at most dist for any i', () => {
    for (let i = 0; i < 8; i++) {
      const { tx } = sparkleOffset(i, 8, 60)
      expect(Math.abs(tx)).toBeLessThanOrEqual(60 + 1e-9)
    }
  })

  it('sum of all tx values is approximately 0 (symmetric distribution)', () => {
    const total = 8
    let sumTx = 0
    for (let i = 0; i < total; i++) {
      sumTx += sparkleOffset(i, total, 60).tx
    }
    expect(sumTx).toBeCloseTo(0, 5)
  })

  it('sum of all ty (before -25 offset) is approximately 0', () => {
    const total = 8
    let sumTy = 0
    for (let i = 0; i < total; i++) {
      sumTy += sparkleOffset(i, total, 60).ty + 25  // remove offset to check symmetry
    }
    expect(sumTy).toBeCloseTo(0, 5)
  })

  it('scales proportionally with dist', () => {
    const r1 = sparkleOffset(1, 8, 60)
    const r2 = sparkleOffset(1, 8, 120)
    expect(r2.tx).toBeCloseTo(r1.tx * 2, 5)
    // ty includes -25 offset, so ty_2 ≠ ty_1 * 2; check only tx
  })

  it('total=1 puts single spark at angle 0 → tx=dist, ty=-25', () => {
    const { tx, ty } = sparkleOffset(0, 1, 50)
    expect(tx).toBeCloseTo(50, 5)
    expect(ty).toBeCloseTo(-25, 5)
  })
})

// @vitest-environment node
/**
 * Tests for src/game/cone.ts — 2.5D cone projection math.
 *
 * API CONTRACT (implementer must match exactly):
 *
 *   interface Slot {
 *     rank: number      // 1-based; rank 1 = nearest the star (smallest h)
 *     h: number         // 0..1 from tree tip (0 = tip/star, 1 = foliage base)
 *     theta: number     // radians, angle around the cone axis; 0 = front face
 *   }
 *
 *   interface SceneSize {
 *     width: number     // scene width in pixels
 *     height: number    // scene height in pixels
 *   }
 *
 *   interface Projection {
 *     x: number         // screen x in pixels from left edge
 *     depth: number     // z = cos(theta + phi), range [-1, 1]
 *     scale: number     // scale factor (> 0; larger when depth > 0)
 *     opacity: number   // 0 < opacity <= 1; larger when depth > 0
 *     behind: boolean   // true iff depth < 0
 *   }
 *
 *   // Returns treeSlots slots distributed on the cone.
 *   // Rank 1 is nearest the star (smallest h).
 *   // No two slots share the same (h, theta) position.
 *   // Minimum angular gap between slots at similar heights.
 *   export function slotLayout(treeSlots: number): Slot[]
 *
 *   // Projects a slot onto the screen given spin angle phi and scene dimensions.
 *   // Formulae (ADR-4):
 *   //   depth = cos(theta + phi)
 *   //   x     = size.width/2 + r(h) * sin(theta + phi)
 *   //   scale and opacity increase with depth
 *   //   behind = depth < 0
 *   export function project(slot: Slot, phi: number, size: SceneSize): Projection
 */

import { describe, it, expect } from 'vitest'
import { slotLayout, project } from './cone.ts'

// Local type aliases matching the module contract — remove once cone.ts exists and re-export from there
interface Slot { rank: number; h: number; theta: number }
interface SceneSize { width: number; height: number }
// Projection is only accessed via property reads (not lambda params), so no alias needed

// ─── slotLayout ────────────────────────────────────────────────────────────

describe('slotLayout — count and structure', () => {
  it('returns exactly treeSlots elements for n=5', () => {
    expect(slotLayout(5)).toHaveLength(5)
  })

  it('returns exactly treeSlots elements for n=15 (default)', () => {
    expect(slotLayout(15)).toHaveLength(15)
  })

  it('returns exactly treeSlots elements for n=25 (maximum)', () => {
    expect(slotLayout(25)).toHaveLength(25)
  })

  it('ranks are exactly 1..treeSlots with no gaps or duplicates', () => {
    const slots = slotLayout(10) as unknown as Slot[]
    const ranks = slots.map(s => s.rank).sort((a, b) => a - b)
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('all h values are in [0, 1]', () => {
    for (const rawSlots of [slotLayout(5), slotLayout(15), slotLayout(25)]) {
      for (const s of rawSlots as unknown as Slot[]) {
        expect(s.h).toBeGreaterThanOrEqual(0)
        expect(s.h).toBeLessThanOrEqual(1)
      }
    }
  })

  it('all theta values are in [0, 2π)', () => {
    for (const rawSlots of [slotLayout(5), slotLayout(15), slotLayout(25)]) {
      for (const s of rawSlots as unknown as Slot[]) {
        expect(s.theta).toBeGreaterThanOrEqual(0)
        expect(s.theta).toBeLessThan(2 * Math.PI)
      }
    }
  })
})

describe('slotLayout — rank 1 nearest the star', () => {
  it('rank 1 has the smallest h (highest up, nearest the star)', () => {
    const slots = slotLayout(15) as unknown as Slot[]
    const rank1 = slots.find(s => s.rank === 1)!
    for (const s of slots) {
      if (s.rank !== 1) {
        expect(rank1.h).toBeLessThanOrEqual(s.h)
      }
    }
  })

  it('rank 1 h is strictly smaller than rank-15 h', () => {
    const slots = slotLayout(15) as unknown as Slot[]
    const rank1 = slots.find(s => s.rank === 1)!
    const rank15 = slots.find(s => s.rank === 15)!
    expect(rank1.h).toBeLessThan(rank15.h)
  })

  it('rank 1 h is strictly smaller than rank-5 h (n=5)', () => {
    const slots = slotLayout(5) as unknown as Slot[]
    const rank1 = slots.find(s => s.rank === 1)!
    const rank5 = slots.find(s => s.rank === 5)!
    expect(rank1.h).toBeLessThan(rank5.h)
  })
})

describe('slotLayout — no duplicate positions', () => {
  it.each([5, 10, 15, 20, 25])(
    'no two slots share identical (h, theta) for n=%i',
    (n) => {
      const slots = slotLayout(n) as unknown as Slot[]
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const sameH = Math.abs(slots[i].h - slots[j].h) < 1e-9
          const sameTheta = Math.abs(slots[i].theta - slots[j].theta) < 1e-9
          expect(sameH && sameTheta).toBe(false)
        }
      }
    },
  )
})

describe('slotLayout — minimum angular spacing', () => {
  it.each([5, 10, 15, 20, 25])(
    'slots at similar heights (|Δh| < 0.15) have angular gap > 2π/(n*4) for n=%i',
    (n) => {
      const slots = slotLayout(n) as unknown as Slot[]
      const minGap = (2 * Math.PI) / (n * 4)  // very conservative floor
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          if (Math.abs(slots[i].h - slots[j].h) >= 0.15) continue
          const diff = Math.abs(slots[i].theta - slots[j].theta)
          const angular = Math.min(diff, 2 * Math.PI - diff)
          expect(angular).toBeGreaterThan(minGap)
        }
      }
    },
  )
})

// ─── project — depth formula ────────────────────────────────────────────────

const SIZE: SceneSize = { width: 800, height: 600 }
const makeSlot = (rank: number, h: number, theta: number): Slot => ({ rank, h, theta })

describe('project — depth = cos(theta + phi)', () => {
  it('theta=0, phi=0 → depth=1', () => {
    const p = project(makeSlot(1, 0.5, 0), 0, SIZE)
    expect(p.depth).toBeCloseTo(1, 10)
  })

  it('theta=π, phi=0 → depth=-1', () => {
    const p = project(makeSlot(1, 0.5, Math.PI), 0, SIZE)
    expect(p.depth).toBeCloseTo(-1, 10)
  })

  it('theta=π/2, phi=0 → depth=0', () => {
    const p = project(makeSlot(1, 0.5, Math.PI / 2), 0, SIZE)
    expect(p.depth).toBeCloseTo(0, 10)
  })

  it('theta=π/3, phi=π/6 → depth=cos(π/2)=0', () => {
    const p = project(makeSlot(1, 0.5, Math.PI / 3), Math.PI / 6, SIZE)
    expect(p.depth).toBeCloseTo(Math.cos(Math.PI / 3 + Math.PI / 6), 10)
    expect(p.depth).toBeCloseTo(0, 10)
  })

  it('arbitrary theta and phi → depth matches cos(theta+phi)', () => {
    const theta = 1.2
    const phi = 0.8
    const p = project(makeSlot(2, 0.4, theta), phi, SIZE)
    expect(p.depth).toBeCloseTo(Math.cos(theta + phi), 10)
  })
})

describe('project — x position', () => {
  it('theta=0, phi=0 → x equals scene centre (cx = width/2)', () => {
    const p = project(makeSlot(1, 0.5, 0), 0, SIZE)
    expect(p.x).toBeCloseTo(SIZE.width / 2, 1)
  })

  it('theta=π/2 (right side) → x > cx', () => {
    const p = project(makeSlot(1, 0.5, Math.PI / 2), 0, SIZE)
    expect(p.x).toBeGreaterThan(SIZE.width / 2)
  })

  it('theta=3π/2 (left side) → x < cx', () => {
    const p = project(makeSlot(1, 0.5, (3 * Math.PI) / 2), 0, SIZE)
    expect(p.x).toBeLessThan(SIZE.width / 2)
  })

  it('x is within reasonable bounds (within scene width)', () => {
    for (let i = 0; i < 8; i++) {
      const theta = (i * Math.PI) / 4
      const p = project(makeSlot(1, 0.5, theta), 0, SIZE)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(SIZE.width)
    }
  })
})

describe('project — symmetry (±theta around 0 at phi=0)', () => {
  it('theta=π/4 and theta=7π/4 have equal depth', () => {
    const p1 = project(makeSlot(1, 0.5, Math.PI / 4), 0, SIZE)
    const p2 = project(makeSlot(2, 0.5, (7 * Math.PI) / 4), 0, SIZE)
    expect(p1.depth).toBeCloseTo(p2.depth, 10)
  })

  it('theta=π/4 and theta=7π/4 have mirrored x around centre', () => {
    const p1 = project(makeSlot(1, 0.5, Math.PI / 4), 0, SIZE)
    const p2 = project(makeSlot(2, 0.5, (7 * Math.PI) / 4), 0, SIZE)
    // p1.x + p2.x should equal 2 * cx = width
    expect(p1.x + p2.x).toBeCloseTo(SIZE.width, 1)
  })

  it('theta=π/4 and theta=7π/4 have equal scale', () => {
    const p1 = project(makeSlot(1, 0.5, Math.PI / 4), 0, SIZE)
    const p2 = project(makeSlot(2, 0.5, (7 * Math.PI) / 4), 0, SIZE)
    expect(p1.scale).toBeCloseTo(p2.scale, 6)
  })

  it('theta=π/4 and theta=7π/4 have equal opacity', () => {
    const p1 = project(makeSlot(1, 0.5, Math.PI / 4), 0, SIZE)
    const p2 = project(makeSlot(2, 0.5, (7 * Math.PI) / 4), 0, SIZE)
    expect(p1.opacity).toBeCloseTo(p2.opacity, 6)
  })
})

describe('project — behind flag', () => {
  it('theta=0, phi=0 → behind=false (depth=1)', () => {
    const p = project(makeSlot(1, 0.5, 0), 0, SIZE)
    expect(p.behind).toBe(false)
  })

  it('theta=π, phi=0 → behind=true (depth=-1)', () => {
    const p = project(makeSlot(1, 0.5, Math.PI), 0, SIZE)
    expect(p.behind).toBe(true)
  })

  it('theta=π/2, phi=0 → behind=false (depth=0, not strictly < 0)', () => {
    const p = project(makeSlot(1, 0.5, Math.PI / 2), 0, SIZE)
    expect(p.behind).toBe(false)
  })

  it('theta just past π/2 → behind=true (depth < 0)', () => {
    const p = project(makeSlot(1, 0.5, Math.PI / 2 + 0.01), 0, SIZE)
    expect(p.behind).toBe(true)
  })

  it('behind matches depth < 0 for many angles', () => {
    for (let i = 0; i < 12; i++) {
      const theta = (i * Math.PI) / 6
      const p = project(makeSlot(1, 0.5, theta), 0, SIZE)
      expect(p.behind).toBe(p.depth < 0)
    }
  })
})

describe('project — scale and opacity from depth', () => {
  it('slot at front (depth=1) has larger scale than slot at back (depth=-1)', () => {
    const front = project(makeSlot(1, 0.5, 0), 0, SIZE)      // depth=1
    const back = project(makeSlot(1, 0.5, Math.PI), 0, SIZE) // depth=-1
    expect(front.scale).toBeGreaterThan(back.scale)
  })

  it('slot at front has larger opacity than slot at back', () => {
    const front = project(makeSlot(1, 0.5, 0), 0, SIZE)
    const back = project(makeSlot(1, 0.5, Math.PI), 0, SIZE)
    expect(front.opacity).toBeGreaterThan(back.opacity)
  })

  it('scale is positive even when behind', () => {
    const p = project(makeSlot(1, 0.5, Math.PI), 0, SIZE)
    expect(p.scale).toBeGreaterThan(0)
  })

  it('opacity is positive even when behind', () => {
    const p = project(makeSlot(1, 0.5, Math.PI), 0, SIZE)
    expect(p.opacity).toBeGreaterThan(0)
  })

  it('opacity is at most 1 at any angle', () => {
    for (let i = 0; i < 8; i++) {
      const p = project(makeSlot(1, 0.5, (i * Math.PI) / 4), 0, SIZE)
      expect(p.opacity).toBeLessThanOrEqual(1)
    }
  })

  it('scale increases monotonically as depth increases from -1 to 1', () => {
    // Scan from behind (θ=π) to front (θ=0) → depth goes from -1 to 1
    const depths = [-1, -0.5, 0, 0.5, 1]
    const scales = depths.map(d => {
      const theta = Math.acos(d)  // theta ∈ [0, π]
      return project(makeSlot(1, 0.5, theta), 0, SIZE).scale
    })
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThanOrEqual(scales[i - 1])
    }
  })
})

describe('project — phi shifts x and depth correctly', () => {
  it('adding phi=π to a slot at theta=0 puts it behind', () => {
    const p = project(makeSlot(1, 0.5, 0), Math.PI, SIZE)
    expect(p.depth).toBeCloseTo(-1, 10)
    expect(p.behind).toBe(true)
  })

  it('adding phi=2π to any slot returns same result as phi=0', () => {
    const theta = Math.PI / 5
    const p0 = project(makeSlot(1, 0.5, theta), 0, SIZE)
    const p2pi = project(makeSlot(1, 0.5, theta), 2 * Math.PI, SIZE)
    expect(p0.depth).toBeCloseTo(p2pi.depth, 10)
    expect(p0.x).toBeCloseTo(p2pi.x, 6)
    expect(p0.scale).toBeCloseTo(p2pi.scale, 6)
    expect(p0.opacity).toBeCloseTo(p2pi.opacity, 6)
  })
})

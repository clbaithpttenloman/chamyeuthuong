// @vitest-environment node
/**
 * Tests for the pure layout math in layout.ts (ADR-4).
 *
 * Key invariants:
 *   - Star centre x === tree centre x (tipX is 50 % of imageW)
 *   - Tree base lands exactly on groundSurfaceY
 *   - All box bottoms lie within the ground band [groundTopY, groundSurfaceY]
 *   - No box overflows the viewport horizontally
 *   - Staggered rows increase depth (row 1 y < row 0 y = further back)
 */

import { describe, it, expect } from 'vitest'
import { computeSceneLayout, computeBoxCluster } from './layout.ts'

// Scene sizes to exercise: (sceneW, sceneH, label)
const SCENE_SIZES: Array<[number, number, string]> = [
  [390,  844, 'phone 390×844'],
  [412,  915, 'phone 412×915'],
  [1280, 800, 'desktop 1280×800'],
  [1920, 1080,'desktop 1920×1080'],
  // Wide/short landscape sizes (regression for groundSurfaceY clamping)
  [1000, 400, 'wide landscape 1000×400'],
  [844,  340, 'short landscape 844×340'],
]

for (const [sceneW, sceneH, label] of SCENE_SIZES) {
  describe(`computeSceneLayout — ${label}`, () => {
    // Computed once at describe scope; pure function so safe to do eagerly
    const layout = computeSceneLayout(sceneW, sceneH, 10)
    const { treeRect, groundTopY, groundSurfaceY, starCenter, boxPositions } = layout

    it('star x equals tree centre (tipX / imageW = 0.5)', () => {
      const expected = treeRect.x + treeRect.w * 0.5
      expect(starCenter.x).toBeCloseTo(expected, 4)
    })

    it('tree base lands on groundSurfaceY', () => {
      expect(treeRect.y + treeRect.h).toBeCloseTo(groundSurfaceY, 4)
    })

    it('groundSurfaceY is strictly inside the scene (clamp for wide/short)', () => {
      expect(groundSurfaceY).toBeLessThan(sceneH)
    })

    it('tree top is at or above 0 px from scene top', () => {
      // treeY = groundSurfaceY - treeH; tipY is small relative to treeH
      expect(treeRect.y).toBeGreaterThanOrEqual(0)
    })

    it('star centre is below the site header (~56 px)', () => {
      // TREE_TOP_MIN = 56 px so the star is never hidden under the header.
      // The star sits slightly inside the tree (tipY ≈ 5.6 % of imageH), so
      // starCenter.y = treeY + tipY * treeScale > TREE_TOP_MIN.
      expect(starCenter.y).toBeGreaterThan(56)
    })

    it('star is above groundSurfaceY', () => {
      expect(starCenter.y).toBeLessThan(groundSurfaceY)
    })

    it('tree width fits within 98 % of scene width', () => {
      expect(treeRect.w).toBeLessThanOrEqual(sceneW * 0.981)
    })

    it('foliage midpoint (50 % tree height) is above ground top', () => {
      // Ground must not cover foliage up past the midpoint
      const foliageMid = treeRect.y + treeRect.h * 0.5
      expect(groundTopY).toBeGreaterThan(foliageMid)
    })

    it('ornamentSize in [44, 96]', () => {
      expect(layout.ornamentSize).toBeGreaterThanOrEqual(44)
      expect(layout.ornamentSize).toBeLessThanOrEqual(96)
    })

    it('boxSize in [44, 100]', () => {
      expect(layout.boxSize).toBeGreaterThanOrEqual(44)
      expect(layout.boxSize).toBeLessThanOrEqual(100)
    })

    it('returns 10 box positions', () => {
      expect(boxPositions).toHaveLength(10)
    })

    it('all box bottoms within ground band [groundTopY, groundSurfaceY]', () => {
      for (const p of boxPositions) {
        expect(p.y).toBeLessThanOrEqual(groundSurfaceY + 0.001)
        expect(p.y).toBeGreaterThanOrEqual(groundTopY - 0.001)
      }
    })

    it('all boxes stay inside viewport horizontally', () => {
      for (const p of boxPositions) {
        expect(p.x).toBeGreaterThanOrEqual(p.size / 2 - 0.001)
        expect(p.x).toBeLessThanOrEqual(sceneW - p.size / 2 + 0.001)
      }
    })
  })
}

// ── computeBoxCluster ──────────────────────────────────────────────────────

describe('computeBoxCluster', () => {
  it('returns empty array for 0 gifts', () => {
    expect(computeBoxCluster(390, 600, 0, 50)).toHaveLength(0)
  })

  it('returns exactly count positions for various counts', () => {
    for (const n of [1, 5, 7, 8, 10, 15]) {
      expect(computeBoxCluster(1280, 600, n, 60)).toHaveLength(n)
    }
  })

  it('single gift goes to scene centre x', () => {
    const sceneW = 390
    const positions = computeBoxCluster(sceneW, 600, 1, 50)
    expect(positions[0]!.x).toBeCloseTo(sceneW / 2, 1)
  })

  it('row 0 boxes sit at groundSurfaceY (front row)', () => {
    const groundSurfaceY = 600
    // 10 gifts → rowCount=3, giftsPerRow=4; row 0 = indices 0–3
    const positions = computeBoxCluster(390, groundSurfaceY, 10, 50)
    const giftsPerRow = Math.ceil(10 / 3)
    for (let i = 0; i < giftsPerRow; i++) {
      expect(positions[i]!.y).toBeCloseTo(groundSurfaceY, 5)
      expect(positions[i]!.row).toBe(0)
    }
  })

  it('row 1 y < row 0 y (further back = higher on screen)', () => {
    const groundSurfaceY = 600
    const positions = computeBoxCluster(390, groundSurfaceY, 10, 50)
    const giftsPerRow = Math.ceil(10 / 3)
    expect(positions[giftsPerRow]!.y).toBeLessThan(positions[0]!.y)
    expect(positions[giftsPerRow]!.row).toBe(1)
  })

  it('row 1 boxes are smaller than row 0 boxes', () => {
    const positions = computeBoxCluster(390, 600, 10, 50)
    const giftsPerRow = Math.ceil(10 / 3)
    expect(positions[giftsPerRow]!.size).toBeLessThan(positions[0]!.size)
  })

  it('adjacent row-0 boxes do not overlap more than 50 % of size', () => {
    const positions = computeBoxCluster(1280, 600, 10, 60)
    const row0 = positions.filter(p => p.row === 0)
    for (let i = 0; i < row0.length - 1; i++) {
      const gap = Math.abs(row0[i + 1]!.x - row0[i]!.x)
      expect(gap).toBeGreaterThanOrEqual(row0[i]!.size * 0.5)
    }
  })

  it('all boxes within viewport for phone', () => {
    const sceneW = 390
    const positions = computeBoxCluster(sceneW, 650, 10, 50)
    for (const p of positions) {
      expect(p.x).toBeGreaterThanOrEqual(p.size / 2 - 0.001)
      expect(p.x).toBeLessThanOrEqual(sceneW - p.size / 2 + 0.001)
    }
  })

  it('7 gifts uses 2 rows; 8 gifts uses 3 rows', () => {
    const p7 = computeBoxCluster(390, 600, 7, 50)
    const p8 = computeBoxCluster(390, 600, 8, 50)
    const maxRow7 = Math.max(...p7.map(p => p.row))
    const maxRow8 = Math.max(...p8.map(p => p.row))
    expect(maxRow7).toBe(1)  // rows 0,1
    expect(maxRow8).toBe(2)  // rows 0,1,2
  })
})

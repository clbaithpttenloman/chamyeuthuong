// @vitest-environment node
/**
 * Tests for the pure ornamentTransform helper exported from Scene.tsx.
 * No DOM / React required.
 */
import { describe, it, expect } from 'vitest'
import { ornamentTransform, shouldSnap, type TreeRect } from './Scene.tsx'
import { TREE_GEOMETRY } from './defaultTheme.ts'

const treeRect: TreeRect = { x: 50, y: 10, w: 300, h: 400 }
// treeScale = 300 / 1200 = 0.25

const makeSlot = (h: number, theta: number) => ({ rank: 1, h, theta })

// ─── depth and behind ────────────────────────────────────────────────────────

describe('ornamentTransform — depth and behind', () => {
  it('theta=0, phi=0 → depth=1, behind=false', () => {
    const r = ornamentTransform(makeSlot(0.5, 0), 0, treeRect, TREE_GEOMETRY)
    expect(r.depth).toBeCloseTo(1, 10)
    expect(r.behind).toBe(false)
  })

  it('theta=π, phi=0 → depth=-1, behind=true', () => {
    const r = ornamentTransform(makeSlot(0.5, Math.PI), 0, treeRect, TREE_GEOMETRY)
    expect(r.depth).toBeCloseTo(-1, 10)
    expect(r.behind).toBe(true)
  })

  it('depth = cos(theta + phi) for arbitrary angles', () => {
    const theta = 1.1
    const phi = 0.9
    const r = ornamentTransform(makeSlot(0.4, theta), phi, treeRect, TREE_GEOMETRY)
    expect(r.depth).toBeCloseTo(Math.cos(theta + phi), 10)
  })

  it('behind === depth < 0 for many angles', () => {
    for (let i = 0; i < 12; i++) {
      const theta = (i * Math.PI) / 6
      const r = ornamentTransform(makeSlot(0.5, theta), 0, treeRect, TREE_GEOMETRY)
      expect(r.behind).toBe(r.depth < 0)
    }
  })
})

// ─── scale and opacity ───────────────────────────────────────────────────────

describe('ornamentTransform — scale and opacity', () => {
  it('front (depth=1) has scale=1', () => {
    const r = ornamentTransform(makeSlot(0.5, 0), 0, treeRect, TREE_GEOMETRY)
    expect(r.scale).toBeCloseTo(1, 5)
  })

  it('back (depth=-1) has scale=0.5', () => {
    const r = ornamentTransform(makeSlot(0.5, Math.PI), 0, treeRect, TREE_GEOMETRY)
    expect(r.scale).toBeCloseTo(0.5, 5)
  })

  it('scale is positive even when behind', () => {
    const r = ornamentTransform(makeSlot(0.5, Math.PI), 0, treeRect, TREE_GEOMETRY)
    expect(r.scale).toBeGreaterThan(0)
  })

  it('opacity is at least 0.35 even when behind (min clamp)', () => {
    const r = ornamentTransform(makeSlot(0.5, Math.PI), 0, treeRect, TREE_GEOMETRY)
    expect(r.opacity).toBeGreaterThanOrEqual(0.35)
  })

  it('front has higher scale than back', () => {
    const front = ornamentTransform(makeSlot(0.5, 0), 0, treeRect, TREE_GEOMETRY)
    const back = ornamentTransform(makeSlot(0.5, Math.PI), 0, treeRect, TREE_GEOMETRY)
    expect(front.scale).toBeGreaterThan(back.scale)
  })
})

// ─── tx position ─────────────────────────────────────────────────────────────

describe('ornamentTransform — tx (x screen position)', () => {
  it('theta=0 (front) → tx = tree.x + tipX * scale (sin=0 → no offset)', () => {
    const scale = treeRect.w / TREE_GEOMETRY.imageW  // 0.25
    const expected = treeRect.x + TREE_GEOMETRY.tipX * scale  // 50 + 600*0.25 = 200
    const r = ornamentTransform(makeSlot(0.5, 0), 0, treeRect, TREE_GEOMETRY)
    expect(r.tx).toBeCloseTo(expected, 1)
  })

  it('theta=π/2 → tx > centre (sin(π/2)=1)', () => {
    const centreTx = treeRect.x + TREE_GEOMETRY.tipX * (treeRect.w / TREE_GEOMETRY.imageW)
    const r = ornamentTransform(makeSlot(0.5, Math.PI / 2), 0, treeRect, TREE_GEOMETRY)
    expect(r.tx).toBeGreaterThan(centreTx)
  })

  it('theta=3π/2 → tx < centre (sin(3π/2)=-1)', () => {
    const centreTx = treeRect.x + TREE_GEOMETRY.tipX * (treeRect.w / TREE_GEOMETRY.imageW)
    const r = ornamentTransform(makeSlot(0.5, (3 * Math.PI) / 2), 0, treeRect, TREE_GEOMETRY)
    expect(r.tx).toBeLessThan(centreTx)
  })
})

// ─── ty position ─────────────────────────────────────────────────────────────

describe('ornamentTransform — ty (y screen position)', () => {
  it('h=0 → ty near foliageTopY * scale', () => {
    const scale = treeRect.w / TREE_GEOMETRY.imageW  // 0.25
    const expected = treeRect.y + TREE_GEOMETRY.foliageTopY * scale
    const r = ornamentTransform(makeSlot(0, 0), 0, treeRect, TREE_GEOMETRY)
    expect(r.ty).toBeCloseTo(expected, 1)
  })

  it('h=1 → ty near foliageBaseY * scale', () => {
    const scale = treeRect.w / TREE_GEOMETRY.imageW
    const expected = treeRect.y + TREE_GEOMETRY.foliageBaseY * scale
    const r = ornamentTransform(makeSlot(1, 0), 0, treeRect, TREE_GEOMETRY)
    expect(r.ty).toBeCloseTo(expected, 1)
  })

  it('h=0 has smaller ty than h=1 (higher up the tree)', () => {
    const rTop = ornamentTransform(makeSlot(0, 0), 0, treeRect, TREE_GEOMETRY)
    const rBot = ornamentTransform(makeSlot(1, 0), 0, treeRect, TREE_GEOMETRY)
    expect(rTop.ty).toBeLessThan(rBot.ty)
  })
})

// ─── phi shift ────────────────────────────────────────────────────────────────

describe('ornamentTransform — phi rotates the slot', () => {
  it('phi=2π is equivalent to phi=0', () => {
    const r0 = ornamentTransform(makeSlot(0.5, Math.PI / 4), 0, treeRect, TREE_GEOMETRY)
    const r2 = ornamentTransform(makeSlot(0.5, Math.PI / 4), 2 * Math.PI, treeRect, TREE_GEOMETRY)
    expect(r0.tx).toBeCloseTo(r2.tx, 5)
    expect(r0.ty).toBeCloseTo(r2.ty, 5)
    expect(r0.depth).toBeCloseTo(r2.depth, 10)
  })
})

// ─── shouldSnap ──────────────────────────────────────────────────────────────

describe('shouldSnap', () => {
  it('returns true when focusPublicId is set, not yet snapped, and slot map has the gift', () => {
    expect(shouldSnap({ focusPublicId: 'abc', snapped: false, slotMapHas: true })).toBe(true)
  })

  it('returns false when already snapped', () => {
    expect(shouldSnap({ focusPublicId: 'abc', snapped: true, slotMapHas: true })).toBe(false)
  })

  it('returns false when focusPublicId is undefined (no share link)', () => {
    expect(shouldSnap({ focusPublicId: undefined, snapped: false, slotMapHas: true })).toBe(false)
  })

  it('returns false when slot map does not have the gift yet (tree not loaded)', () => {
    expect(shouldSnap({ focusPublicId: 'abc', snapped: false, slotMapHas: false })).toBe(false)
  })

  it('returns false for all falsy combinations', () => {
    expect(shouldSnap({ focusPublicId: undefined, snapped: true, slotMapHas: false })).toBe(false)
    expect(shouldSnap({ focusPublicId: '', snapped: false, slotMapHas: true })).toBe(false)
  })
})

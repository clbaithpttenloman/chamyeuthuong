// @vitest-environment node
/**
 * Tests for src/game/heartOverrides.ts — optimistic heart-count overrides.
 *
 * API CONTRACT:
 *
 *   interface HeartOverride { count: number; serverAsOf: number }
 *   type OverrideMap = ReadonlyMap<string, HeartOverride>
 *
 *   applyOverride(publicId, serverCount, overrides): number
 *     - Returns max(serverCount, local.count) when an override exists.
 *     - Returns serverCount when no override.
 *
 *   addOverride(overrides, publicId, count, serverAsOf): OverrideMap
 *     - Returns a new map with the entry added/updated.
 *     - Original map unchanged.
 *
 *   reconcileOverrides(overrides, treeGifts, newServerAsOf): OverrideMap
 *     - Drops entries for absent gifts.
 *     - Releases entries when newServerAsOf > local.serverAsOf && serverCount >= local.count.
 *     - Returns same map reference (identity) when nothing changed.
 */

import { describe, it, expect } from 'vitest'
import {
  applyOverride,
  addOverride,
  reconcileOverrides,
  type OverrideMap,
} from './heartOverrides.ts'

const empty: OverrideMap = new Map()

// ── applyOverride ─────────────────────────────────────────────────────────────

describe('applyOverride', () => {
  it('returns serverCount when no override', () => {
    expect(applyOverride('a', 5, empty)).toBe(5)
  })

  it('returns local.count when it is > serverCount', () => {
    const m = new Map([['a', { count: 10, serverAsOf: 100 }]])
    expect(applyOverride('a', 7, m)).toBe(10)
  })

  it('returns serverCount when it is > local.count (no subtraction)', () => {
    const m = new Map([['a', { count: 5, serverAsOf: 100 }]])
    expect(applyOverride('a', 8, m)).toBe(8)
  })

  it('returns local.count when equal to serverCount', () => {
    const m = new Map([['a', { count: 5, serverAsOf: 100 }]])
    expect(applyOverride('a', 5, m)).toBe(5)
  })

  it('no override for a different publicId', () => {
    const m = new Map([['b', { count: 10, serverAsOf: 100 }]])
    expect(applyOverride('a', 3, m)).toBe(3)
  })
})

// ── addOverride ───────────────────────────────────────────────────────────────

describe('addOverride', () => {
  it('adds a new entry', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    expect(m.get('a')).toEqual({ count: 5, serverAsOf: 1000 })
  })

  it('original map is unchanged', () => {
    addOverride(empty, 'a', 5, 1000)
    expect(empty.size).toBe(0)
  })

  it('updates an existing entry', () => {
    const m1 = addOverride(empty, 'a', 5, 1000)
    const m2 = addOverride(m1, 'a', 7, 2000)
    expect(m2.get('a')).toEqual({ count: 7, serverAsOf: 2000 })
    expect(m1.get('a')).toEqual({ count: 5, serverAsOf: 1000 }) // original unchanged
  })

  it('preserves other entries', () => {
    const m1 = addOverride(empty, 'a', 5, 1000)
    const m2 = addOverride(m1, 'b', 3, 2000)
    expect(m2.get('a')).toEqual({ count: 5, serverAsOf: 1000 })
    expect(m2.get('b')).toEqual({ count: 3, serverAsOf: 2000 })
  })
})

// ── reconcileOverrides — release when server confirms ─────────────────────────

describe('reconcileOverrides — release when server confirms', () => {
  it('releases when newServerAsOf > local.serverAsOf AND count >= local.count', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 5 }]
    const result = reconcileOverrides(m, gifts, 2000)
    expect(result.has('a')).toBe(false)
  })

  it('releases when server count exceeds local count', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 7 }]
    const result = reconcileOverrides(m, gifts, 2000)
    expect(result.has('a')).toBe(false)
  })

  it('keeps override when server count < local count (server not caught up)', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 3 }]
    const result = reconcileOverrides(m, gifts, 2000)
    expect(result.get('a')?.count).toBe(5)
  })

  it('keeps override when newServerAsOf === local.serverAsOf (not strictly later)', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 5 }]
    const result = reconcileOverrides(m, gifts, 1000) // same asOf
    expect(result.has('a')).toBe(true)
  })

  it('keeps override when newServerAsOf < local.serverAsOf (clock skew)', () => {
    // Client clock is ahead of server: local.serverAsOf was derived from a future-dated
    // tree response. newServerAsOf is the server's real time, which appears older.
    const m = addOverride(empty, 'a', 5, 5000)
    const gifts = [{ publicId: 'a', heartCount: 5 }]
    const result = reconcileOverrides(m, gifts, 3000) // server asOf is older
    expect(result.has('a')).toBe(true) // keep — server hasn't confirmed with a later asOf
  })
})

// ── reconcileOverrides — drop for absent gifts ────────────────────────────────

describe('reconcileOverrides — drop for absent gifts', () => {
  it('drops override when gift is absent from tree', () => {
    const m = addOverride(empty, 'missing', 5, 1000)
    const gifts = [{ publicId: 'other', heartCount: 2 }]
    const result = reconcileOverrides(m, gifts, 2000)
    expect(result.has('missing')).toBe(false)
  })

  it('keeps overrides for present gifts', () => {
    let m = addOverride(empty, 'a', 5, 1000)
    m = addOverride(m, 'b', 3, 1000)
    const gifts = [
      { publicId: 'a', heartCount: 2 }, // not confirmed yet
      { publicId: 'b', heartCount: 2 }, // not confirmed yet
    ]
    const result = reconcileOverrides(m, gifts, 1500) // asOf equal → no release
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(true)
  })
})

// ── reconcileOverrides — referential equality when unchanged ──────────────────

describe('reconcileOverrides — referential equality', () => {
  it('returns same reference when nothing changes', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 2 }]
    const result = reconcileOverrides(m, gifts, 500) // asOf older → no release
    expect(result).toBe(m)
  })

  it('returns same reference for empty map', () => {
    expect(reconcileOverrides(empty, [], 1000)).toBe(empty)
  })

  it('returns a NEW reference when an entry is released', () => {
    const m = addOverride(empty, 'a', 5, 1000)
    const gifts = [{ publicId: 'a', heartCount: 5 }]
    const result = reconcileOverrides(m, gifts, 2000)
    expect(result).not.toBe(m)
    expect(result.size).toBe(0)
  })
})

// ── reconcileOverrides — progression (hold then release) ─────────────────────

describe('reconcileOverrides — hold-then-release progression', () => {
  it('override held through several responses then released', () => {
    let m = addOverride(empty, 'a', 5, 1000)

    // Poll 1: server asOf 1500, count 4 (not caught up)
    m = reconcileOverrides(m, [{ publicId: 'a', heartCount: 4 }], 1500) as typeof m
    expect(m.has('a')).toBe(true)

    // Poll 2: server asOf 2000, count 5 (confirmed!)
    m = reconcileOverrides(m, [{ publicId: 'a', heartCount: 5 }], 2000) as typeof m
    expect(m.has('a')).toBe(false)
  })
})

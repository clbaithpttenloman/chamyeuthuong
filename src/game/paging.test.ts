// @vitest-environment node
/**
 * Tests for src/game/paging.ts — pure paging reducer.
 * No DOM / React / network.
 */
import { describe, it, expect } from 'vitest'
import { pagingReducer, initialPagingState, type PagingState } from './paging.ts'

type S = PagingState<string>

function fresh(tab: 'hearts' | 'new' = 'hearts'): S {
  return initialPagingState<string>(tab)
}

// ── initialPagingState ────────────────────────────────────────────────────────

describe('initialPagingState', () => {
  it('starts at page 1', () => {
    expect(fresh().page).toBe(1)
  })
  it('starts with empty items', () => {
    expect(fresh().items).toHaveLength(0)
  })
  it('starts with hasMore=true', () => {
    expect(fresh().hasMore).toBe(true)
  })
  it('starts not loading', () => {
    expect(fresh().loading).toBe(false)
  })
  it('starts with no error', () => {
    expect(fresh().error).toBeNull()
  })
  it('starts with rid=0', () => {
    expect(fresh().rid).toBe(0)
  })
  it('uses provided tab', () => {
    expect(fresh('new').tab).toBe('new')
    expect(fresh('hearts').tab).toBe('hearts')
  })
})

// ── tab action ────────────────────────────────────────────────────────────────

describe('pagingReducer — tab action', () => {
  it('resets items, page, error, loading, rid when switching to a different tab', () => {
    const before: S = {
      tab: 'hearts',
      page: 3,
      items: ['x', 'y'],
      hasMore: false,
      loading: true,
      error: 'oops',
      rid: 7,
    }
    const after = pagingReducer(before, { type: 'tab', tab: 'new' })
    expect(after.tab).toBe('new')
    expect(after.page).toBe(1)
    expect(after.items).toHaveLength(0)
    expect(after.hasMore).toBe(true)
    expect(after.loading).toBe(false)
    expect(after.error).toBeNull()
    expect(after.rid).toBe(0)
  })

  it('same tab → referential no-op (state unchanged)', () => {
    const before: S = { ...fresh('hearts'), page: 2, items: ['a'], rid: 1 }
    const after = pagingReducer(before, { type: 'tab', tab: 'hearts' })
    expect(after).toBe(before)
  })

  it('same tab on "new" is also a no-op', () => {
    const before: S = { ...fresh('new'), page: 3, items: ['x', 'y'], rid: 5 }
    const after = pagingReducer(before, { type: 'tab', tab: 'new' })
    expect(after).toBe(before)
  })
})

// ── start action ──────────────────────────────────────────────────────────────

describe('pagingReducer — start action', () => {
  it('sets loading=true', () => {
    const after = pagingReducer(fresh(), { type: 'start', rid: 1 })
    expect(after.loading).toBe(true)
  })

  it('sets rid to the provided value', () => {
    const after = pagingReducer(fresh(), { type: 'start', rid: 42 })
    expect(after.rid).toBe(42)
  })

  it('clears error', () => {
    const before: S = { ...fresh(), error: 'previous error' }
    const after = pagingReducer(before, { type: 'start', rid: 1 })
    expect(after.error).toBeNull()
  })

  it('preserves items', () => {
    const before: S = { ...fresh(), items: ['a', 'b'] }
    const after = pagingReducer(before, { type: 'start', rid: 1 })
    expect(after.items).toEqual(['a', 'b'])
  })
})

// ── ok action ─────────────────────────────────────────────────────────────────

describe('pagingReducer — ok action', () => {
  it('appends data to items', () => {
    const before: S = { ...fresh(), items: ['a'], rid: 1 }
    const after = pagingReducer(before, { type: 'ok', rid: 1, data: ['b', 'c'], pageSize: 24 })
    expect(after.items).toEqual(['a', 'b', 'c'])
  })

  it('loading becomes false', () => {
    const before: S = { ...fresh(), loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'ok', rid: 1, data: [], pageSize: 24 })
    expect(after.loading).toBe(false)
  })

  it('hasMore=true when data.length === pageSize and page < 50', () => {
    const before: S = { ...fresh(), loading: true, rid: 1, page: 1 }
    const data = Array(24).fill('x') as string[]
    const after = pagingReducer(before, { type: 'ok', rid: 1, data, pageSize: 24 })
    expect(after.hasMore).toBe(true)
  })

  it('hasMore=false when data.length < pageSize', () => {
    const before: S = { ...fresh(), loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'ok', rid: 1, data: ['a', 'b'], pageSize: 24 })
    expect(after.hasMore).toBe(false)
  })

  it('hasMore=false when page reaches 50', () => {
    const before: S = { ...fresh(), loading: true, rid: 1, page: 50 }
    const data = Array(24).fill('x') as string[]
    const after = pagingReducer(before, { type: 'ok', rid: 1, data, pageSize: 24 })
    expect(after.hasMore).toBe(false)
  })

  it('stale response (rid mismatch) is a no-op', () => {
    const before: S = { ...fresh(), rid: 5, items: ['existing'] }
    const after = pagingReducer(before, { type: 'ok', rid: 3, data: ['new'], pageSize: 24 })
    expect(after).toBe(before)  // referential equality: same object
    expect(after.items).toEqual(['existing'])
  })

  it('page is NOT changed by ok (stays at the fetched page)', () => {
    const before: S = { ...fresh(), page: 3, rid: 1 }
    const after = pagingReducer(before, { type: 'ok', rid: 1, data: ['x'], pageSize: 24 })
    expect(after.page).toBe(3)
  })
})

// ── err action ────────────────────────────────────────────────────────────────

describe('pagingReducer — err action', () => {
  it('sets error message', () => {
    const before: S = { ...fresh(), loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'err', rid: 1, error: 'something went wrong' })
    expect(after.error).toBe('something went wrong')
  })

  it('loading becomes false', () => {
    const before: S = { ...fresh(), loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'err', rid: 1, error: 'oops' })
    expect(after.loading).toBe(false)
  })

  it('page is NOT advanced (enables retry)', () => {
    const before: S = { ...fresh(), page: 3, loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'err', rid: 1, error: 'oops' })
    expect(after.page).toBe(3)
  })

  it('items are preserved after error', () => {
    const before: S = { ...fresh(), items: ['a', 'b'], loading: true, rid: 1 }
    const after = pagingReducer(before, { type: 'err', rid: 1, error: 'oops' })
    expect(after.items).toEqual(['a', 'b'])
  })

  it('stale error response is a no-op', () => {
    const before: S = { ...fresh(), rid: 5, error: null }
    const after = pagingReducer(before, { type: 'err', rid: 2, error: 'stale' })
    expect(after).toBe(before)
  })
})

// ── more action ───────────────────────────────────────────────────────────────

describe('pagingReducer — more action', () => {
  it('increments page', () => {
    const before: S = { ...fresh(), page: 1, hasMore: true, loading: false }
    const after = pagingReducer(before, { type: 'more' })
    expect(after.page).toBe(2)
  })

  it('no-op when already loading', () => {
    const before: S = { ...fresh(), page: 1, hasMore: true, loading: true }
    const after = pagingReducer(before, { type: 'more' })
    expect(after).toBe(before)
  })

  it('no-op when hasMore is false', () => {
    const before: S = { ...fresh(), page: 1, hasMore: false, loading: false }
    const after = pagingReducer(before, { type: 'more' })
    expect(after).toBe(before)
  })

  it('hasMore becomes false when page reaches 50', () => {
    const before: S = { ...fresh(), page: 49, hasMore: true, loading: false }
    const after = pagingReducer(before, { type: 'more' })
    expect(after.page).toBe(50)
    expect(after.hasMore).toBe(false)
  })

  it('no-op when already at page 50', () => {
    const before: S = { ...fresh(), page: 50, hasMore: false, loading: false }
    const after = pagingReducer(before, { type: 'more' })
    expect(after).toBe(before)
  })

  it('preserves items and other state', () => {
    const before: S = { ...fresh(), page: 2, items: ['a', 'b'], hasMore: true, loading: false }
    const after = pagingReducer(before, { type: 'more' })
    expect(after.items).toEqual(['a', 'b'])
    expect(after.tab).toBe('hearts')
  })
})

// ── Stale-response guard: tab-change mid-flight ────────────────────────────────

describe('stale-response guard: tab-change mid-flight', () => {
  it('response from old tab is ignored after tab switch', () => {
    // Start loading hearts page 1 (rid=1)
    let s = pagingReducer(fresh(), { type: 'start', rid: 1 })
    // User switches to 'new' tab → state resets, rid=0
    s = pagingReducer(s, { type: 'tab', tab: 'new' })
    // New fetch starts (rid=2)
    s = pagingReducer(s, { type: 'start', rid: 2 })
    // Old hearts response arrives (rid=1) — must be ignored
    const after = pagingReducer(s, { type: 'ok', rid: 1, data: ['stale'], pageSize: 24 })
    expect(after.items).toHaveLength(0)  // new tab has no items yet
    expect(after.rid).toBe(2)            // rid unchanged
  })

  it('correct response is applied after stale one is ignored', () => {
    let s = pagingReducer(fresh(), { type: 'start', rid: 1 })
    s = pagingReducer(s, { type: 'tab', tab: 'new' })
    s = pagingReducer(s, { type: 'start', rid: 2 })
    s = pagingReducer(s, { type: 'ok', rid: 1, data: ['stale'], pageSize: 24 })  // stale
    s = pagingReducer(s, { type: 'ok', rid: 2, data: ['real'], pageSize: 24 })   // correct
    expect(s.items).toEqual(['real'])
  })
})

// ── Retry scenario ────────────────────────────────────────────────────────────

describe('retry after error', () => {
  it('component can retry the same page after an error', () => {
    let s = fresh()
    // First fetch attempt
    s = pagingReducer(s, { type: 'start', rid: 1 })
    expect(s.page).toBe(1)
    // Fetch fails
    s = pagingReducer(s, { type: 'err', rid: 1, error: 'network error' })
    expect(s.page).toBe(1)  // page unchanged
    expect(s.error).toBe('network error')
    // Retry: component calls fetch again with new rid (no 'more' dispatch)
    s = pagingReducer(s, { type: 'start', rid: 2 })
    expect(s.page).toBe(1)   // still page 1
    expect(s.loading).toBe(true)
    expect(s.error).toBeNull()
    // Retry succeeds
    s = pagingReducer(s, { type: 'ok', rid: 2, data: ['a', 'b'], pageSize: 24 })
    expect(s.items).toEqual(['a', 'b'])
    expect(s.error).toBeNull()
  })
})

// ── Multi-page scenario ───────────────────────────────────────────────────────

describe('full multi-page scenario', () => {
  it('accumulates items across pages', () => {
    let s = fresh()
    const page1Data = Array(24).fill('p1') as string[]
    const page2Data = Array(10).fill('p2') as string[]

    s = pagingReducer(s, { type: 'start', rid: 1 })
    s = pagingReducer(s, { type: 'ok', rid: 1, data: page1Data, pageSize: 24 })
    expect(s.items).toHaveLength(24)
    expect(s.hasMore).toBe(true)

    s = pagingReducer(s, { type: 'more' })
    expect(s.page).toBe(2)

    s = pagingReducer(s, { type: 'start', rid: 2 })
    s = pagingReducer(s, { type: 'ok', rid: 2, data: page2Data, pageSize: 24 })
    expect(s.items).toHaveLength(34)
    expect(s.hasMore).toBe(false)  // page2 had < 24 items
  })
})

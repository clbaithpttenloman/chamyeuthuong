// @vitest-environment node
/**
 * Tests for src/game/gesture.ts — tap-vs-drag state machine.
 * Pure functions; no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  DRAG_THRESHOLD,
  createGestureState,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  clearClickSuppression,
  shouldSuppressClick,
} from './gesture.ts'

// ── createGestureState ────────────────────────────────────────────────────────

describe('createGestureState', () => {
  it('starts with no active pointer', () => {
    const s = createGestureState()
    expect(s.pointerId).toBeNull()
  })
  it('starts not dragging', () => {
    const s = createGestureState()
    expect(s.isDrag).toBe(false)
  })
  it('starts without click suppression', () => {
    const s = createGestureState()
    expect(s.suppressClick).toBe(false)
  })
})

// ── onPointerDown ─────────────────────────────────────────────────────────────

describe('onPointerDown', () => {
  it('records pointerId and startX', () => {
    const s = onPointerDown(createGestureState(), 150, 1)
    expect(s.pointerId).toBe(1)
    expect(s.startX).toBe(150)
    expect(s.lastX).toBe(150)
  })
  it('resets isDrag and suppressClick', () => {
    const s = onPointerDown({ ...createGestureState(), isDrag: true, suppressClick: true }, 0, 1)
    expect(s.isDrag).toBe(false)
    expect(s.suppressClick).toBe(false)
  })
})

// ── onPointerMove — before threshold ─────────────────────────────────────────

describe('onPointerMove — below threshold (tap)', () => {
  it('dx is null and shouldCapture is false when below threshold', () => {
    let s = onPointerDown(createGestureState(), 100, 1)
    const result = onPointerMove(s, 100 + DRAG_THRESHOLD - 1)
    expect(result.dx).toBeNull()
    expect(result.shouldCapture).toBe(false)
    s = result.state
    expect(s.isDrag).toBe(false)
  })

  it('handles movement exactly at threshold - 1 in both directions', () => {
    for (const delta of [-(DRAG_THRESHOLD - 1), DRAG_THRESHOLD - 1]) {
      const s = onPointerDown(createGestureState(), 200, 1)
      const r = onPointerMove(s, 200 + delta)
      expect(r.dx).toBeNull()
      expect(r.shouldCapture).toBe(false)
    }
  })

  it('no-ops when pointerId is null', () => {
    const s = createGestureState()  // pointerId = null
    const r = onPointerMove(s, 999)
    expect(r.dx).toBeNull()
    expect(r.shouldCapture).toBe(false)
    expect(r.state).toBe(s)
  })
})

// ── onPointerMove — threshold crossing ────────────────────────────────────────

describe('onPointerMove — threshold crossing', () => {
  it('shouldCapture=true and isDrag=true on the first crossing', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerMove(s, 100 + DRAG_THRESHOLD)
    expect(r.shouldCapture).toBe(true)
    expect(r.state.isDrag).toBe(true)
  })

  it('dx is non-null after threshold crossing', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerMove(s, 100 + DRAG_THRESHOLD)
    expect(r.dx).not.toBeNull()
  })

  it('dx equals movement from lastX (which was startX)', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerMove(s, 100 + DRAG_THRESHOLD)
    expect(r.dx).toBe(DRAG_THRESHOLD)
  })

  it('works for leftward movement', () => {
    const s = onPointerDown(createGestureState(), 200, 1)
    const r = onPointerMove(s, 200 - DRAG_THRESHOLD)
    expect(r.shouldCapture).toBe(true)
    expect(r.state.isDrag).toBe(true)
    expect(r.dx).toBe(-DRAG_THRESHOLD)
  })
})

// ── onPointerMove — already dragging ──────────────────────────────────────────

describe('onPointerMove — already dragging', () => {
  function startDrag(startX = 100, firstMoveX = 100 + DRAG_THRESHOLD) {
    let s = onPointerDown(createGestureState(), startX, 1)
    s = onPointerMove(s, firstMoveX).state
    return s
  }

  it('shouldCapture is false after the first crossing', () => {
    const s = startDrag()
    const r = onPointerMove(s, 200)
    expect(r.shouldCapture).toBe(false)
  })

  it('dx is incremental (from lastX, not startX)', () => {
    const s = startDrag(100, 106)  // s.lastX = 106
    const r = onPointerMove(s, 116)
    expect(r.dx).toBe(10)
  })

  it('updates lastX on each move', () => {
    let s = startDrag(100, 106)  // lastX = 106
    s = onPointerMove(s, 120).state  // lastX = 120
    s = onPointerMove(s, 115).state  // lastX = 115
    expect(s.lastX).toBe(115)
  })

  it('dx can be zero (no movement since last frame)', () => {
    const s = startDrag()
    const r = onPointerMove(s, s.lastX)
    expect(r.dx).toBe(0)
  })
})

// ── onPointerUp ──────────────────────────────────────────────────────────────

describe('onPointerUp — after tap (no drag)', () => {
  it('suppressNextClick is false after a tap', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerUp(s)
    expect(r.suppressNextClick).toBe(false)
  })

  it('resets pointerId to null', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerUp(s)
    expect(r.state.pointerId).toBeNull()
  })

  it('suppressClick is false in state after a tap', () => {
    const s = onPointerDown(createGestureState(), 100, 1)
    const r = onPointerUp(s)
    expect(r.state.suppressClick).toBe(false)
  })
})

describe('onPointerUp — after drag', () => {
  function startDrag() {
    let s = onPointerDown(createGestureState(), 100, 1)
    s = onPointerMove(s, 100 + DRAG_THRESHOLD).state
    return s
  }

  it('suppressNextClick is true after a drag', () => {
    const s = startDrag()
    const r = onPointerUp(s)
    expect(r.suppressNextClick).toBe(true)
  })

  it('suppressClick is true in state after a drag', () => {
    const s = startDrag()
    const r = onPointerUp(s)
    expect(r.state.suppressClick).toBe(true)
  })

  it('isDrag is false in state after up (gesture reset)', () => {
    const s = startDrag()
    const r = onPointerUp(s)
    expect(r.state.isDrag).toBe(false)
  })
})

// ── clearClickSuppression ─────────────────────────────────────────────────────

describe('clearClickSuppression', () => {
  it('sets suppressClick to false', () => {
    const s = { ...createGestureState(), suppressClick: true }
    expect(clearClickSuppression(s).suppressClick).toBe(false)
  })

  it('is a no-op when already false', () => {
    const s = createGestureState()
    expect(clearClickSuppression(s).suppressClick).toBe(false)
  })

  it('preserves other fields', () => {
    const s = { ...createGestureState(), pointerId: 5, isDrag: true, suppressClick: true }
    const r = clearClickSuppression(s)
    expect(r.pointerId).toBe(5)
    expect(r.isDrag).toBe(true)
  })
})

// ── Multi-step scenario ───────────────────────────────────────────────────────

describe('full gesture scenarios', () => {
  it('tap: down → small moves → up → suppressNextClick=false', () => {
    let s = onPointerDown(createGestureState(), 100, 1)
    s = onPointerMove(s, 102).state  // below threshold
    const r = onPointerUp(s)
    expect(r.suppressNextClick).toBe(false)
    expect(r.state.isDrag).toBe(false)
  })

  it('drag: down → exceed threshold → up → suppressNextClick=true', () => {
    let s = onPointerDown(createGestureState(), 100, 1)
    let r = onPointerMove(s, 100 + DRAG_THRESHOLD)
    expect(r.shouldCapture).toBe(true)   // capture on first crossing
    s = r.state
    r = onPointerMove(s, 150)
    expect(r.shouldCapture).toBe(false)  // no second capture
    s = r.state
    const up = onPointerUp(s)
    expect(up.suppressNextClick).toBe(true)
  })

  it('new down after drag resets suppress flag', () => {
    // Simulate drag → up → down (new touch)
    let s = onPointerDown(createGestureState(), 100, 1)
    s = onPointerMove(s, 100 + DRAG_THRESHOLD).state
    s = onPointerUp(s).state
    expect(s.suppressClick).toBe(true)

    // New touch
    s = onPointerDown(s, 200, 2)
    expect(s.suppressClick).toBe(false)
    expect(s.isDrag).toBe(false)
  })
})

// ── shouldSuppressClick ───────────────────────────────────────────────────────

describe('shouldSuppressClick', () => {
  it('suppresses mouse/touch clicks (detail >= 1) after a drag', () => {
    const s = { ...createGestureState(), suppressClick: true }
    expect(shouldSuppressClick(s, 1)).toBe(true)
    expect(shouldSuppressClick(s, 2)).toBe(true)
  })

  it('does NOT suppress keyboard Enter/Space activations (detail === 0)', () => {
    const s = { ...createGestureState(), suppressClick: true }
    expect(shouldSuppressClick(s, 0)).toBe(false)
  })

  it('returns false when suppressClick is false regardless of detail', () => {
    const s = createGestureState()   // suppressClick: false
    expect(shouldSuppressClick(s, 1)).toBe(false)
    expect(shouldSuppressClick(s, 0)).toBe(false)
  })

  it('detail=0 is never suppressed even without a prior drag', () => {
    const s = createGestureState()
    expect(shouldSuppressClick(s, 0)).toBe(false)
  })
})

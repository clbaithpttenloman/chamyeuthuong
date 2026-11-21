// @vitest-environment node
/**
 * Pure pointer gesture state machine for the Noel scene (ADR-4).
 *
 * Distinguishes a tap from a horizontal drag without touching the DOM.
 * The Scene component calls the functions below and applies results.
 *
 * ─── CONTRACT ──────────────────────────────────────────────────────────────
 *
 *   createGestureState()          → initial state
 *   onPointerDown(state, x, id)   → { state }  — record start
 *   onPointerMove(state, x)       → { state, shouldCapture, dx }
 *     shouldCapture: true the first frame the threshold is crossed (once)
 *     dx: horizontal delta to feed to the spin machine; null until capturing
 *   onPointerUp(state)            → { state, suppressNextClick }
 *   clearClickSuppression(state)  → state with suppressClick=false
 *
 * ─── TAP VS DRAG ───────────────────────────────────────────────────────────
 *
 *   Threshold: DRAG_THRESHOLD (~6 px total from pointerdown).
 *   Before the threshold the pointer is not captured and dx is null.
 *   On the first frame past the threshold: shouldCapture=true (scene calls
 *   setPointerCapture) and isDrag=true for the rest of the gesture.
 *   After pointerup on a drag: suppressNextClick=true so the click that
 *   browsers synthesise on a touch pointerup doesn't open a gift.
 */

/** Threshold in CSS pixels: total displacement before a drag is declared. */
export const DRAG_THRESHOLD = 6

/** Mutable state for one pointer gesture (tap or drag). */
export interface GestureState {
  /** Current tracked pointer id; null when no gesture in progress. */
  pointerId: number | null
  /** X at pointerdown. */
  startX: number
  /** X at the last processed pointermove. */
  lastX: number
  /** True once the total horizontal displacement exceeds DRAG_THRESHOLD. */
  isDrag: boolean
  /**
   * True after pointerup on a drag; causes the Scene to skip the next click.
   * Reset to false after one click event is consumed.
   */
  suppressClick: boolean
}

/** Result of processing a pointermove event. */
export interface MoveResult {
  state: GestureState
  /**
   * True on the first frame the gesture becomes a drag.
   * The caller should call setPointerCapture(pointerId) exactly once.
   */
  shouldCapture: boolean
  /**
   * Horizontal delta in CSS pixels since the last move event.
   * null before the threshold is crossed (not yet a drag).
   */
  dx: number | null
}

/** Result of processing a pointerup/pointercancel event. */
export interface UpResult {
  state: GestureState
  /** True if the following synthesised click should be ignored. */
  suppressNextClick: boolean
}

/** Create the initial (idle) gesture state. */
export function createGestureState(): GestureState {
  return {
    pointerId: null,
    startX: 0,
    lastX: 0,
    isDrag: false,
    suppressClick: false,
  }
}

/** Record a pointerdown event. Resets any previous gesture. */
export function onPointerDown(
  _prev: GestureState,
  x: number,
  pointerId: number,
): GestureState {
  return {
    pointerId,
    startX: x,
    lastX: x,
    isDrag: false,
    suppressClick: false,
  }
}

/**
 * Process a pointermove event.
 *
 * Returns `{ state, shouldCapture, dx }`:
 *   - If the gesture has not started (pointerId null) → no-op.
 *   - If total displacement < DRAG_THRESHOLD and not yet a drag →
 *     shouldCapture=false, dx=null (tap still possible).
 *   - If total displacement ≥ DRAG_THRESHOLD (first crossing) →
 *     shouldCapture=true (caller must call setPointerCapture), dx from start.
 *   - If already a drag (isDrag) → shouldCapture=false, dx from last position.
 */
export function onPointerMove(state: GestureState, x: number): MoveResult {
  if (state.pointerId === null) {
    return { state, shouldCapture: false, dx: null }
  }

  const totalDx = x - state.startX

  if (state.isDrag) {
    // Already dragging: emit incremental delta
    const dx = x - state.lastX
    return {
      state: { ...state, lastX: x },
      shouldCapture: false,
      dx,
    }
  }

  if (Math.abs(totalDx) < DRAG_THRESHOLD) {
    // Below threshold: still could be a tap
    return { state, shouldCapture: false, dx: null }
  }

  // First crossing: declare drag
  const dx = x - state.lastX
  return {
    state: { ...state, lastX: x, isDrag: true },
    shouldCapture: true,
    dx,
  }
}

/** Process pointerup or pointercancel. Ends the gesture. */
export function onPointerUp(state: GestureState): UpResult {
  const suppressNextClick = state.isDrag
  return {
    state: {
      pointerId: null,
      startX: 0,
      lastX: 0,
      isDrag: false,
      suppressClick: suppressNextClick,
    },
    suppressNextClick,
  }
}

/**
 * Clear the click-suppression flag after consuming one click event.
 * Returns the new state.
 */
export function clearClickSuppression(state: GestureState): GestureState {
  return { ...state, suppressClick: false }
}

/**
 * Returns true when this click event should be suppressed as a pointer-drag artifact.
 *
 * Mouse and touch clicks have `detail >= 1` (number of times the button was pressed).
 * Keyboard Enter/Space activations have `detail === 0`.
 * We only suppress pointer-synthesised clicks (detail > 0) so that a gift button that
 * receives keyboard focus AFTER a drag can still be activated with Enter/Space.
 *
 * Usage in Scene:
 *   onClick={(e) => {
 *     if (shouldSuppressClick(gestureRef.current, e.detail)) {
 *       gestureRef.current = clearClickSuppression(gestureRef.current)
 *       return
 *     }
 *     handleGiftClick(gift)
 *   }}
 */
export function shouldSuppressClick(state: GestureState, detail: number): boolean {
  return state.suppressClick && detail > 0
}

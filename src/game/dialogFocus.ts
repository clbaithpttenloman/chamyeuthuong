// @vitest-environment node
/**
 * Pure dialog focus management (ADR-4, NFR-4).
 *
 * ─── DESIGN ────────────────────────────────────────────────────────────────
 *
 * Every Noel dialog (CreateGift, GiftSheet, Leaderboard, AllGifts, MyGifts)
 * uses the same focus / trap / Esc wiring via `useDialog` (thin hook below).
 *
 * Key invariants:
 *  - `onClose` is read from a ref inside the effect, so the effect runs ONCE
 *    on mount — never re-runs because a parent re-rendered.
 *  - Nested confirms: `pushLayer` / `popLayer` make Esc and Tab target the
 *    innermost open layer first.
 *  - Focus moves into a pushed layer on push, and returns to the opener on pop.
 *
 * ─── EXPORTS (pure) ────────────────────────────────────────────────────────
 *
 *   FOCUSABLE_SEL         — selector string used by all dialogs
 *   getFocusable(el, sel) — query focusable descendants
 *   firstFocusable(el)    — first focusable descendant
 *   tabNext(...)          — next focus target after a Tab/Shift-Tab (pure)
 *   DialogLayer           — { el, onClose }
 *
 * The thin React hook `useDialog` lives in useDialog.ts and imports from here.
 */

/** Selector that covers all interactive elements inside a dialog. */
export const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** A dialog layer: the container element plus its close callback. */
export interface DialogLayer {
  el: HTMLElement
  onClose: () => void
}

/**
 * Returns focusable descendants of `el` matching `selector`.
 * Reads the DOM; not tested directly (use tabNext tests instead).
 */
export function getFocusable(el: HTMLElement, selector = FOCUSABLE_SEL): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(selector))
}

/**
 * Returns the first focusable descendant of `el`, or null.
 */
export function firstFocusable(el: HTMLElement, selector = FOCUSABLE_SEL): HTMLElement | null {
  return el.querySelector<HTMLElement>(selector)
}

/**
 * Given an ordered array of focusable elements, the currently active element,
 * and Tab direction, return the element that should receive focus next
 * (wrapping at first ↔ last).
 *
 * Returns `null` when normal browser Tab handling should proceed (no wrap needed).
 *
 * @param focusable  Ordered list of focusable elements inside the active layer.
 * @param active     The currently focused element (document.activeElement).
 * @param shiftKey   True for Shift+Tab (backward).
 * @param container  The dialog container itself (treated as "before first").
 */
export function tabNext(
  focusable: Element[],
  active: Element | null,
  shiftKey: boolean,
  container: Element,
): Element | null {
  if (!focusable.length) return null
  const first = focusable[0]!
  const last  = focusable[focusable.length - 1]!

  if (shiftKey) {
    // Shift+Tab from first element or the container itself → wrap to last
    if (active === first || active === container) return last
  } else {
    // Tab from last element → wrap to first
    if (active === last) return first
  }
  return null
}

// ── Module-level dialog stack (pure operations) ───────────────────────────────
//
// A module-level stack of active dialog IDs is kept in useDialog.ts (mutable).
// The functions below operate on immutable arrays so they are testable without DOM.
//
// push/pop/top together ensure only the topmost dialog handles Esc and Tab;
// remove-on-unmount is the React useEffect cleanup that calls pop.

/**
 * Returns a new stack with `entry` appended. Pure.
 */
export function dialogStackPush<T>(stack: readonly T[], entry: T): T[] {
  return [...stack, entry]
}

/**
 * Returns a new stack with the last occurrence of `entry` removed.
 * Returns the same array reference when `entry` is not found. Pure.
 */
export function dialogStackPop<T>(stack: readonly T[], entry: T): readonly T[] {
  const i = [...stack].lastIndexOf(entry)
  if (i === -1) return stack
  return [...stack.slice(0, i), ...stack.slice(i + 1)]
}

/**
 * Returns the topmost entry (last element), or `undefined` for an empty stack. Pure.
 */
export function dialogStackTop<T>(stack: readonly T[]): T | undefined {
  return stack[stack.length - 1]
}

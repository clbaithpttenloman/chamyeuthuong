/**
 * src/pages/admin/moderationSelection.ts — pure selection helpers for ModerationSection.
 *
 * toggleAll: when no items are selected, selects the first ≤ MAX_REVIEW_IDS ids and
 *            sets a cap notice when allIds.length > MAX_REVIEW_IDS.
 *            When any items are selected, clears the entire selection.
 *
 * toggleOne: adds id if the selection is below MAX_REVIEW_IDS, removes it if already
 *            selected, or refuses and returns a notice if adding would exceed the cap.
 */
import { MAX_REVIEW_IDS } from '../../../shared/api.ts'

export type ToggleAllResult = {
  selected: Set<number>
  capNotice: string | null
}

export type ToggleOneResult = {
  selected: Set<number>
  notice: string | null
}

/**
 * Toggle the "select all" state.
 * - Any existing selection → clear it.
 * - Empty selection → select first ≤ MAX_REVIEW_IDS ids, with a notice if the list is longer.
 */
export function toggleAll(allIds: number[], current: Set<number>): ToggleAllResult {
  if (current.size > 0) {
    return { selected: new Set(), capNotice: null }
  }
  const ids = allIds.slice(0, MAX_REVIEW_IDS)
  const capNotice =
    allIds.length > MAX_REVIEW_IDS
      ? `Chỉ có thể chọn tối đa ${MAX_REVIEW_IDS} thiệp cùng lúc. Đang chọn ${MAX_REVIEW_IDS} thiệp đầu tiên.`
      : null
  return { selected: new Set(ids), capNotice }
}

/**
 * Toggle a single item in the selection.
 * - Already selected → remove it.
 * - Not selected and below cap → add it.
 * - Not selected and at cap → return unchanged selection with a notice.
 */
export function toggleOne(id: number, current: Set<number>): ToggleOneResult {
  if (current.has(id)) {
    const next = new Set(current)
    next.delete(id)
    return { selected: next, notice: null }
  }
  if (current.size >= MAX_REVIEW_IDS) {
    return {
      selected: current,
      notice: `Chỉ có thể chọn tối đa ${MAX_REVIEW_IDS} thiệp cùng lúc.`,
    }
  }
  const next = new Set(current)
  next.add(id)
  return { selected: next, notice: null }
}

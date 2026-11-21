// @vitest-environment node
/**
 * Pure paging reducer for AllGifts (and similar paginated lists).
 *
 * ─── CONTRACT ──────────────────────────────────────────────────────────────
 *
 *   PagingState<T>   — tab, page, items, hasMore, loading, error, rid
 *   PagingAction<T>  — tab | start | ok | err | more
 *
 *   pagingReducer<T>(state, action) → state   (pure)
 *   initialPagingState<T>()         → PagingState<T>
 *
 * ─── STALE-RESPONSE GUARD ─────────────────────────────────────────────────
 *
 *   `rid` (request id) is a monotonic number.  The component increments its
 *   own counter before each fetch and passes the value in `start`.  `ok` and
 *   `err` include the rid; if it doesn't match `state.rid`, the action is a
 *   no-op (the response is stale — tab changed while the fetch was in flight).
 *
 * ─── PAGE ADVANCE RULES ───────────────────────────────────────────────────
 *
 *   - Page is only incremented by the `more` action.
 *   - `ok` / `err` never change `page`, so a failed page can be retried by
 *     the component calling the fetch function again (without dispatching
 *     `more`).
 *   - `hasMore` becomes false when the last batch was smaller than pageSize,
 *     or when `page` has reached 50.
 *   - `more` is a no-op when loading is true or hasMore is false.
 */

/** Pagination state for a tab-and-page list of items. */
export interface PagingState<T> {
  /** Currently active tab. */
  tab: 'hearts' | 'new'
  /**
   * Page number to fetch next (or the last page fetched).
   * Starts at 1; incremented by `more`.
   * Stays on the failed page after `err` (enabling retry).
   */
  page: number
  /** Accumulated items across all loaded pages. */
  items: T[]
  /** True while a fetch is in progress. */
  loading: boolean
  /** True when more pages may exist (hasMore=false when last batch < pageSize or page=50). */
  hasMore: boolean
  /** Last error message; null when no error. */
  error: string | null
  /**
   * Current active request id.
   * Set by `start`; `ok` / `err` are ignored if their rid doesn't match.
   */
  rid: number
}

export type PagingAction<T> =
  | { type: 'tab'; tab: 'hearts' | 'new' }
  /** Mark a fetch as in-progress for request `rid`. */
  | { type: 'start'; rid: number }
  /** Successful response for request `rid` with `data`; `pageSize` is the expected full-page count. */
  | { type: 'ok'; rid: number; data: T[]; pageSize: number }
  /** Failed response for request `rid`. Page is NOT advanced. */
  | { type: 'err'; rid: number; error: string }
  /** Request the next page (increments page; triggers a new fetch by the component). */
  | { type: 'more' }

const MAX_PAGE = 50

/** Returns the initial paging state for a given tab (default 'hearts'). */
export function initialPagingState<T>(tab: 'hearts' | 'new' = 'hearts'): PagingState<T> {
  return {
    tab,
    page: 1,
    items: [],
    loading: false,
    hasMore: true,
    error: null,
    rid: 0,
  }
}

/** Pure reducer — no side effects. */
export function pagingReducer<T>(state: PagingState<T>, action: PagingAction<T>): PagingState<T> {
  switch (action.type) {
    case 'tab':
      // Same tab → no-op (referential equality lets React bail out).
      if (action.tab === state.tab) return state
      // Different tab: reset everything; new tab starts at page 1.
      return initialPagingState<T>(action.tab)

    case 'start':
      return { ...state, loading: true, error: null, rid: action.rid }

    case 'ok': {
      // Stale-response guard: ignore if rid doesn't match current.
      if (action.rid !== state.rid) return state
      // Append to existing items (tab reset already cleared them).
      const items = [...state.items, ...action.data]
      const hasMore = action.data.length === action.pageSize && state.page < MAX_PAGE
      return { ...state, loading: false, items, hasMore }
    }

    case 'err': {
      if (action.rid !== state.rid) return state
      // Page is intentionally NOT advanced — retry will re-fetch the same page.
      return { ...state, loading: false, error: action.error }
    }

    case 'more': {
      // No-op when already loading or no more pages.
      if (state.loading || !state.hasMore) return state
      // hasMore becomes false immediately at page 50.
      const nextPage = state.page + 1
      const hasMore = nextPage < MAX_PAGE
      return { ...state, page: nextPage, hasMore }
    }
  }
}

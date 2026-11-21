/**
 * src/game/poller.ts — injectable poll-loop with single chain, generation guard,
 * visibility pause/resume, abort/timeout, and backoff (ADR-7).
 *
 * Usage in NoelPage:
 *
 *   const poller = createPoller({ fetch, schedule: setTimeout, clearSchedule: clearTimeout,
 *     isVisible: () => document.visibilityState !== 'hidden', onData, onError, nextDelay })
 *   document.addEventListener('visibilitychange', () => poller.handleVisibilityChange())
 *   return () => {
 *     poller.stop()
 *     document.removeEventListener('visibilitychange', () => poller.handleVisibilityChange())
 *   }
 *
 * Design guarantees:
 *   - Single chain: at most one fetch in-flight at a time (guarded by `currentAbort`).
 *   - Generation guard: results from superseded polls are silently dropped.
 *   - Visibility pause/resume: when hidden the timer is cancelled; on visible a new poll
 *     starts immediately (if none in-flight) — no duplicate chains.
 *   - Abort/timeout: a per-fetch AbortController is armed with a timeout; the in-flight
 *     request is aborted on stop() and on pollNow() when already in-flight.
 *   - pollNow() aborts any in-flight fetch so the new one starts promptly.
 *   - Caller supplies schedule/clearSchedule so the module is fully testable with
 *     fake timers (no real setTimeout inside).
 */

export type TimerId = ReturnType<typeof setTimeout>

export interface PollerOptions<T> {
  /**
   * The fetch function. Receives an AbortSignal that fires on timeout or stop().
   * Should throw on error (the error is forwarded to onError).
   */
  fetch: (signal: AbortSignal) => Promise<T>
  /** Schedule fn after ms milliseconds; returns an opaque timer id. */
  schedule: (fn: () => void, ms: number) => TimerId
  /** Cancel a previously scheduled callback by its timer id. */
  clearSchedule: (id: TimerId) => void
  /** Returns true when polling should run (page is visible). */
  isVisible: () => boolean
  /** Called with each successful data payload. */
  onData: (data: T) => void
  /**
   * Called on each fetch error.
   * Not called for stale responses (generation mismatch) or stop()-aborted fetches.
   */
  onError: (err: unknown) => void
  /**
   * Returns the next poll delay in ms given consecutive failure count.
   * Use nextPollDelay from poll.ts for ADR-7 backoff.
   */
  nextDelay: (failures: number) => number
  /** How long to wait before aborting a hung fetch (default 30 000 ms). */
  timeoutMs?: number
}

export interface Poller {
  /**
   * Call whenever document.visibilityState changes (pause on hidden, resume on visible).
   * NoelPage wires this to a visibilitychange listener; tests call it directly.
   */
  handleVisibilityChange: () => void
  /**
   * Force an immediate poll, cancelling any pending timer.
   * If a fetch is in-flight it is aborted (counted as a failure) and a new one starts.
   */
  pollNow: () => void
  /** Stop the poller, cancel the pending timer, abort any in-flight fetch. */
  stop: () => void
}

export function createPoller<T>(opts: PollerOptions<T>): Poller {
  const timeoutMs = opts.timeoutMs ?? 30_000
  let alive = true
  let failures = 0
  let generation = 0
  let currentAbort: AbortController | null = null
  let timer: TimerId | null = null
  /**
   * When pollNow() is called with an in-flight fetch it sets this flag and aborts the fetch.
   * run() checks this in its post-await cleanup and re-starts immediately.
   */
  let pollImmediatePending = false

  const scheduleNext = (): void => {
    if (!alive || !opts.isVisible()) return
    const delay = opts.nextDelay(failures)
    timer = opts.schedule(() => {
      timer = null
      void run()
    }, delay)
  }

  const run = async (): Promise<void> => {
    // Guard: only one chain at a time; no-op when hidden or stopped.
    if (!alive || currentAbort !== null || !opts.isVisible()) return

    const myGen = ++generation
    const ac = new AbortController()
    currentAbort = ac

    // Arm the per-fetch timeout
    const timeoutId = opts.schedule(() => { ac.abort() }, timeoutMs)

    try {
      const data = await opts.fetch(ac.signal)
      opts.clearSchedule(timeoutId)
      if (alive && myGen === generation) {
        failures = 0
        opts.onData(data)
      }
    } catch (err) {
      opts.clearSchedule(timeoutId)
      if (alive && myGen === generation) {
        failures = Math.min(failures + 1, 10)
        opts.onError(err)
      }
    } finally {
      // Always clear in-flight indicator, even on stale/stop paths
      currentAbort = null
    }

    if (!alive) return

    // If pollNow() arrived during this fetch, restart immediately
    if (pollImmediatePending) {
      pollImmediatePending = false
      void run()
      return
    }

    // Only schedule if our generation wasn't superseded (pollNow() bumps generation)
    if (myGen === generation) {
      scheduleNext()
    }
  }

  // Kick off the first poll
  void run()

  return {
    handleVisibilityChange(): void {
      if (!alive) return
      if (opts.isVisible()) {
        // Page became visible: cancel any pending timer, start immediately if idle
        if (timer !== null) { opts.clearSchedule(timer); timer = null }
        if (currentAbort === null) void run()
        // If a fetch is already in-flight, it will schedule the next one when it completes
      } else {
        // Page became hidden: cancel pending timer; let any in-flight finish
        if (timer !== null) { opts.clearSchedule(timer); timer = null }
      }
    },

    pollNow(): void {
      if (!alive) return
      // Cancel any scheduled timer
      if (timer !== null) { opts.clearSchedule(timer); timer = null }
      if (currentAbort !== null) {
        // A fetch is in-flight: abort it and queue an immediate re-run.
        // run() will check pollImmediatePending after catching the AbortError.
        pollImmediatePending = true
        ++generation // mark current result as stale
        currentAbort.abort()
      } else {
        void run()
      }
    },

    stop(): void {
      alive = false
      if (timer !== null) { opts.clearSchedule(timer); timer = null }
      if (currentAbort !== null) {
        ++generation // prevent in-flight result from reaching onData/onError
        currentAbort.abort()
        currentAbort = null
      }
    },
  }
}

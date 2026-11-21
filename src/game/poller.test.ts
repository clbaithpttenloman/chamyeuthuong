// @vitest-environment node
/**
 * Tests for src/game/poller.ts — createPoller.
 *
 * Uses injectable schedule/clearSchedule instead of real setTimeout so tests
 * run synchronously with explicit timer control. AbortController is global in
 * Node 20+.
 *
 * Key scenarios:
 *  - Initial poll fires immediately when visible.
 *  - After success/failure: schedules next poll with the right delay.
 *  - Hidden on start: no initial fetch.
 *  - handleVisibilityChange to hidden: cancels pending timer.
 *  - handleVisibilityChange to visible (idle): starts fetch immediately.
 *  - Visibility toggle DURING fetch: no duplicate chain on resume.
 *  - pollNow: cancels timer, starts immediately.
 *  - pollNow during in-flight: aborts + re-runs.
 *  - stop: cancels timer, aborts in-flight.
 *  - Timeout: timer fires → fetch aborted → counted as failure.
 *  - Generation guard: stale results not delivered.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createPoller, type TimerId } from './poller.ts'

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockTimer = { id: number; fn: () => void; ms: number; active: boolean }

/** A fake timer queue where we control when callbacks fire. */
function makeTimerQueue() {
  let nextId = 1
  const timers = new Map<number, MockTimer>()

  const schedule = (fn: () => void, ms: number): TimerId => {
    const id = nextId++
    timers.set(id, { id, fn, ms, active: true })
    return id as unknown as TimerId
  }

  const clearSchedule = (id: TimerId): void => {
    const t = timers.get(id as unknown as number)
    if (t) t.active = false
  }

  /** Fire all active timers with delay ≤ ms (in insertion order). */
  const advanceBy = (ms: number): void => {
    const toFire = [...timers.values()].filter((t) => t.active && t.ms <= ms)
    for (const t of toFire) {
      if (!t.active) continue // may have been cleared by a previous timer's callback
      t.active = false
      t.fn()
    }
  }

  /** Fire the first active timer (the most recently scheduled — for timeout tests). */
  const fireNext = (): void => {
    const t = [...timers.values()].find((x) => x.active)
    if (t) { t.active = false; t.fn() }
  }

  const activeCount = (): number => [...timers.values()].filter((t) => t.active).length

  return { schedule, clearSchedule, advanceBy, fireNext, activeCount }
}

/** A deferred promise for controlling fetch resolution. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Drain the microtask queue (lets resolved promises' .then callbacks run). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

// ── Shared base options ───────────────────────────────────────────────────────

function makeOpts<T>(overrides: Partial<Parameters<typeof createPoller<T>>[0]> = {}) {
  const q = makeTimerQueue()
  const onData = vi.fn()
  const onError = vi.fn()
  let visible = true
  const fetchFn = vi.fn()
  return {
    opts: {
      fetch: fetchFn as unknown as (signal: AbortSignal) => Promise<T>,
      schedule: q.schedule,
      clearSchedule: q.clearSchedule,
      isVisible: () => visible,
      onData,
      onError,
      nextDelay: (_f: number) => 15_000,
      timeoutMs: 30_000,
      ...overrides,
    } as Parameters<typeof createPoller<T>>[0],
    q,
    onData,
    onError,
    fetchFn,
    setVisible: (v: boolean) => { visible = v },
  }
}

afterEach(() => { vi.restoreAllMocks() })

// ── Initial poll ──────────────────────────────────────────────────────────────

describe('createPoller — initial poll', () => {
  it('calls fetch immediately when visible', () => {
    const d = deferred<string>()
    const { opts } = makeOpts<string>()
    opts.fetch = () => d.promise
    const fetchSpy = vi.fn(() => d.promise)
    opts.fetch = fetchSpy

    createPoller(opts)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('does NOT call fetch when hidden', () => {
    const { opts, setVisible } = makeOpts<string>()
    setVisible(false)
    const fetchSpy = vi.fn().mockResolvedValue('x')
    opts.fetch = fetchSpy

    createPoller(opts)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── Success path ──────────────────────────────────────────────────────────────

describe('createPoller — success', () => {
  it('calls onData with the resolved value', async () => {
    const d = deferred<string>()
    const { opts, onData } = makeOpts<string>()
    opts.fetch = () => d.promise
    createPoller(opts)

    d.resolve('tree-data')
    await flushMicrotasks()

    expect(onData).toHaveBeenCalledWith('tree-data')
    expect(onData).toHaveBeenCalledOnce()
  })

  it('schedules the next poll after success', async () => {
    const d = deferred<string>()
    const { opts, q } = makeOpts<string>()
    opts.fetch = () => d.promise

    createPoller(opts)
    // 1 active timer = timeout for the in-flight fetch
    expect(q.activeCount()).toBe(1)

    d.resolve('ok')
    await flushMicrotasks()
    // 1 active timer = next poll timer (timeout was cleared)
    expect(q.activeCount()).toBe(1)
  })

  it('does not call onError on success', async () => {
    const d = deferred<string>()
    const { opts, onError } = makeOpts<string>()
    opts.fetch = () => d.promise
    createPoller(opts)
    d.resolve('ok')
    await flushMicrotasks()
    expect(onError).not.toHaveBeenCalled()
  })
})

// ── Failure path ──────────────────────────────────────────────────────────────

describe('createPoller — failure', () => {
  it('calls onError with the rejection', async () => {
    const d = deferred<string>()
    const { opts, onError } = makeOpts<string>()
    opts.fetch = () => d.promise
    createPoller(opts)

    const err = new Error('network error')
    d.reject(err)
    await flushMicrotasks()

    expect(onError).toHaveBeenCalledWith(err)
  })

  it('schedules next poll after failure', async () => {
    const d = deferred<string>()
    const { opts, q } = makeOpts<string>()
    opts.fetch = () => d.promise
    createPoller(opts)

    d.reject(new Error('fail'))
    await flushMicrotasks()
    // timeout timer cleared; next poll timer active
    expect(q.activeCount()).toBe(1)
  })

  it('uses backoff: passes incremented failure count to nextDelay', async () => {
    // First fetch fails
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    let callCount = 0
    const nextDelay = vi.fn(() => 15_000)
    const { opts, q } = makeOpts<string>()
    opts.fetch = () => { callCount++; return callCount === 1 ? d1.promise : d2.promise }
    opts.nextDelay = nextDelay

    const poller = createPoller(opts)
    expect(callCount).toBe(1)

    // Fail the first fetch
    d1.reject(new Error('fail'))
    await flushMicrotasks()

    // nextDelay(1) was called for the next timer
    expect(nextDelay).toHaveBeenLastCalledWith(1)

    // Fire the next-poll timer
    q.advanceBy(15_000)
    await flushMicrotasks()
    expect(callCount).toBe(2)

    // Success resets failure count
    d2.resolve('ok')
    await flushMicrotasks()
    expect(nextDelay).toHaveBeenLastCalledWith(0)

    poller.stop()
  })
})

// ── stop() ────────────────────────────────────────────────────────────────────

describe('createPoller — stop()', () => {
  it('cancels pending timer', async () => {
    const d = deferred<string>()
    const { opts, q } = makeOpts<string>()
    opts.fetch = () => d.promise
    const poller = createPoller(opts)

    d.resolve('ok')
    await flushMicrotasks()
    // next-poll timer is active
    expect(q.activeCount()).toBe(1)

    poller.stop()
    expect(q.activeCount()).toBe(0)
  })

  it('does NOT call onData after stop', async () => {
    const d = deferred<string>()
    const { opts, onData } = makeOpts<string>()
    opts.fetch = () => d.promise
    const poller = createPoller(opts)

    poller.stop()
    d.resolve('late data')
    await flushMicrotasks()

    expect(onData).not.toHaveBeenCalled()
  })

  it('does NOT call onError after stop', async () => {
    const d = deferred<string>()
    const { opts, onError } = makeOpts<string>()
    opts.fetch = () => d.promise
    const poller = createPoller(opts)

    poller.stop()
    d.reject(new Error('late err'))
    await flushMicrotasks()

    expect(onError).not.toHaveBeenCalled()
  })
})

// ── pollNow() ─────────────────────────────────────────────────────────────────

describe('createPoller — pollNow()', () => {
  it('when idle: starts fetch immediately', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    let call = 0
    const { opts, onData, q } = makeOpts<string>()
    opts.fetch = () => { call++; return call === 1 ? d1.promise : d2.promise }

    const poller = createPoller(opts)
    // First fetch started
    expect(call).toBe(1)
    d1.resolve('first')
    await flushMicrotasks()
    // timer scheduled for next poll
    expect(q.activeCount()).toBe(1)

    // pollNow before timer fires
    poller.pollNow()
    // second fetch started immediately (timer cancelled)
    expect(call).toBe(2)
    expect(q.activeCount()).toBe(1) // just the timeout for the new fetch

    d2.resolve('second')
    await flushMicrotasks()
    expect(onData).toHaveBeenNthCalledWith(2, 'second')

    poller.stop()
  })

  it('when in-flight: aborts current fetch, re-runs', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    let call = 0
    const { opts, onData } = makeOpts<string>()
    opts.fetch = (signal) => {
      call++
      if (call === 1) {
        // Let the signal propagate
        const p = new Promise<string>((_res, rej) => {
          signal.addEventListener('abort', () => rej(new DOMException('AbortError', 'AbortError')))
          d1.promise.then(_res, rej)
        })
        return p
      }
      return d2.promise
    }

    const poller = createPoller(opts)
    expect(call).toBe(1) // first fetch started

    // Abort the in-flight fetch
    poller.pollNow()
    await flushMicrotasks()
    // After abort, run() should detect pollImmediatePending and start fetch 2
    expect(call).toBe(2)

    d2.resolve('from poll now')
    await flushMicrotasks()
    expect(onData).toHaveBeenCalledWith('from poll now')

    poller.stop()
  })
})

// ── Visibility — pause ────────────────────────────────────────────────────────

describe('createPoller — visibility', () => {
  it('handleVisibilityChange to hidden: cancels pending timer', async () => {
    const d = deferred<string>()
    const { opts, setVisible, q } = makeOpts<string>()
    opts.fetch = () => d.promise
    const poller = createPoller(opts)

    d.resolve('ok')
    await flushMicrotasks()
    // next-poll timer active
    expect(q.activeCount()).toBe(1)

    setVisible(false)
    poller.handleVisibilityChange()
    expect(q.activeCount()).toBe(0) // timer cancelled
    poller.stop()
  })

  it('handleVisibilityChange to visible when idle: starts fetch immediately', async () => {
    let calls = 0
    const { opts, setVisible } = makeOpts<string>()
    setVisible(false) // start hidden — no initial fetch
    opts.fetch = () => { calls++; return Promise.resolve('ok') }

    const poller = createPoller(opts)
    expect(calls).toBe(0)

    setVisible(true)
    poller.handleVisibilityChange()
    expect(calls).toBe(1) // fetch started synchronously

    await flushMicrotasks()
    poller.stop()
  })

  it('visibility toggle DURING fetch: no duplicate chain', async () => {
    const d = deferred<string>()
    let calls = 0
    const { opts, setVisible } = makeOpts<string>()
    opts.fetch = () => { calls++; return d.promise }

    const poller = createPoller(opts)
    expect(calls).toBe(1) // first fetch in-flight

    // Hide while fetch in-flight
    setVisible(false)
    poller.handleVisibilityChange()

    // Come back visible while fetch still in-flight
    setVisible(true)
    poller.handleVisibilityChange()
    // currentAbort is set → no new fetch started
    expect(calls).toBe(1)

    // Fetch completes
    d.resolve('ok')
    await flushMicrotasks()
    // scheduleNext was called — but isVisible is true, so timer set
    // No second fetch started spontaneously
    expect(calls).toBe(1)

    poller.stop()
  })

  it('when visible and in-flight, then hidden: in-flight result NOT delivered after stop', async () => {
    const d = deferred<string>()
    const { opts, onData, setVisible } = makeOpts<string>()
    opts.fetch = () => d.promise
    const poller = createPoller(opts)

    setVisible(false)
    poller.handleVisibilityChange()
    poller.stop()

    d.resolve('late')
    await flushMicrotasks()
    expect(onData).not.toHaveBeenCalled()
  })
})

// ── Timeout / AbortSignal ─────────────────────────────────────────────────────

describe('createPoller — timeout', () => {
  it('timeout fires → fetch aborted → error counted as failure', async () => {
    const { opts, onError, q } = makeOpts<string>()
    opts.timeoutMs = 5_000
    opts.nextDelay = vi.fn(() => 10_000) as unknown as (f: number) => number
    opts.fetch = (signal) =>
      new Promise<string>((_res, rej) => {
        signal.addEventListener('abort', () => rej(new DOMException('timeout', 'AbortError')))
      })

    const poller = createPoller(opts)
    // 1 active timer: the 5s timeout
    expect(q.activeCount()).toBe(1)

    // Fire the timeout
    q.advanceBy(5_000)
    await flushMicrotasks()

    expect(onError).toHaveBeenCalledOnce()
    // After failure, next-poll timer should be scheduled
    expect(q.activeCount()).toBe(1)
    expect((opts.nextDelay as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(1)

    poller.stop()
  })
})

// ── Generation guard ──────────────────────────────────────────────────────────

describe('createPoller — generation guard', () => {
  it('stale response from before pollNow is not delivered', async () => {
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    let call = 0
    const { opts, onData } = makeOpts<string>()
    opts.fetch = (signal) => {
      call++
      if (call === 1) {
        return new Promise<string>((res, rej) => {
          signal.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError')))
          d1.promise.then(res, rej)
        })
      }
      return d2.promise
    }

    const poller = createPoller(opts)
    // pollNow aborts first fetch
    poller.pollNow()
    await flushMicrotasks()
    // d1 resolves late — stale
    d1.resolve('stale')
    d2.resolve('fresh')
    await flushMicrotasks()

    // Only 'fresh' should be delivered
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('fresh')

    poller.stop()
  })
})

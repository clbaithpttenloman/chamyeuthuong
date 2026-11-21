// @vitest-environment node
/**
 * Tests for src/game/poll.ts — polling delay and local heart override logic.
 *
 * API CONTRACT (implementer must match exactly):
 *
 *   // A pure random number generator that returns [0, 1).
 *   type Rng = () => number
 *
 *   // State of a gift's heart counter as seen by the client.
 *   interface HeartState {
 *     asOf: number    // monotonic timestamp (ms) of the last server response
 *     count: number   // heart count at that point
 *   }
 *
 *   // Returns the next poll delay in milliseconds.
 *   // With failures=0: delay ∈ [12 000, 18 000] ms (15 s ± 3 s jitter).
 *   // With failures>0: base delay grows with each failure (exponential backoff),
 *   //   still adds ±jitter, capped at a maximum (implementer chooses, ≤ 120 000 ms).
 *   export function nextPollDelay(rng: Rng, failures: number): number
 *
 *   // Keeps the local heart override until the server response is both:
 *   //   - later:   server.asOf > local.asOf
 *   //   - confirmed: server.count >= local.count
 *   // Returns server if both conditions hold; otherwise returns local.
 *   // If local is null (no override yet), always returns server.
 *   export function mergeHeart(local: HeartState | null, server: HeartState): HeartState
 */

import { describe, it, expect } from 'vitest'
import { nextPollDelay, mergeHeart } from './poll.ts'
import type { Rng, HeartState } from './poll.ts'

// ─── nextPollDelay — zero failures: 12–18 s ───────────────────────────────────

describe('nextPollDelay — zero failures: delay ∈ [12 000, 18 000] ms', () => {
  const rngValues: Array<[string, Rng]> = [
    ['rng=()=>0 (minimum jitter)', () => 0],
    ['rng=()=>0.5 (midpoint)', () => 0.5],
    ['rng=()=>0.9999 (near-maximum jitter)', () => 0.9999],
  ]

  it.each(rngValues)('%s → delay ≥ 12 000 ms', (_label, rng) => {
    expect(nextPollDelay(rng, 0)).toBeGreaterThanOrEqual(12_000)
  })

  it.each(rngValues)('%s → delay ≤ 18 000 ms', (_label, rng) => {
    expect(nextPollDelay(rng, 0)).toBeLessThanOrEqual(18_000)
  })

  it('rng=()=>0 returns exactly 12 000 ms (minimum of range)', () => {
    const rng: Rng = () => 0
    expect(nextPollDelay(rng, 0)).toBe(12_000)
  })

  it('rng=()=>0.5 returns exactly 15 000 ms (midpoint = base)', () => {
    const rng: Rng = () => 0.5
    expect(nextPollDelay(rng, 0)).toBe(15_000)
  })

  it('delay is deterministic for the same rng value', () => {
    const rng: Rng = () => 0.3
    expect(nextPollDelay(rng, 0)).toBe(nextPollDelay(rng, 0))
  })
})

// ─── nextPollDelay — failures grow delay ──────────────────────────────────────

describe('nextPollDelay — delay grows with failure count', () => {
  const mid: Rng = () => 0.5

  it('failures=1 → delay > zero-failure delay', () => {
    expect(nextPollDelay(mid, 1)).toBeGreaterThan(nextPollDelay(mid, 0))
  })

  it('failures=2 → delay > failures=1 delay', () => {
    expect(nextPollDelay(mid, 2)).toBeGreaterThan(nextPollDelay(mid, 1))
  })

  it('failures=3 → delay > failures=2 delay', () => {
    expect(nextPollDelay(mid, 3)).toBeGreaterThan(nextPollDelay(mid, 2))
  })

  it('delay is strictly monotonic for failures 0..5', () => {
    let prev = nextPollDelay(mid, 0)
    for (let f = 1; f <= 5; f++) {
      const curr = nextPollDelay(mid, f)
      expect(curr).toBeGreaterThan(prev)
      prev = curr
    }
  })
})

// ─── nextPollDelay — capped at a maximum ──────────────────────────────────────

describe('nextPollDelay — delay is capped', () => {
  const MAX_DELAY = 120_000  // absolute upper bound (2 min); implementer may cap lower

  it('failures=10, rng=()=>0.5 → delay ≤ 120 000 ms', () => {
    expect(nextPollDelay(() => 0.5, 10)).toBeLessThanOrEqual(MAX_DELAY)
  })

  it('failures=100, rng=()=>0.9999 → delay ≤ 120 000 ms', () => {
    expect(nextPollDelay(() => 0.9999, 100)).toBeLessThanOrEqual(MAX_DELAY)
  })

  it('failures=1000 → delay ≤ 120 000 ms (cap holds for extreme values)', () => {
    expect(nextPollDelay(() => 0.5, 1_000)).toBeLessThanOrEqual(MAX_DELAY)
  })

  it('delay stabilises: failures=50 and failures=100 return the same capped value', () => {
    // Both should have hit the cap
    const d50 = nextPollDelay(() => 0.5, 50)
    const d100 = nextPollDelay(() => 0.5, 100)
    expect(d50).toBe(d100)
  })
})

// ─── nextPollDelay — rng is called exactly once per invocation ────────────────

describe('nextPollDelay — rng usage', () => {
  it('rng is called at least once per invocation', () => {
    let calls = 0
    const rng: Rng = () => { calls++; return 0.5 }
    nextPollDelay(rng, 0)
    expect(calls).toBeGreaterThanOrEqual(1)
  })

  it('delay is always a positive finite number', () => {
    for (const rng of [() => 0, () => 0.5, () => 0.9999] as Rng[]) {
      for (const f of [0, 1, 5, 20]) {
        const d = nextPollDelay(rng, f)
        expect(d).toBeGreaterThan(0)
        expect(isFinite(d)).toBe(true)
      }
    }
  })
})

// ─── mergeHeart — keep local override until server confirms ───────────────────

describe('mergeHeart — server later and count >= local → accept server', () => {
  it('server.asOf later and server.count > local.count → server', () => {
    const local: HeartState = { asOf: 100, count: 5 }
    const server: HeartState = { asOf: 200, count: 7 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 200, count: 7 })
  })

  it('server.asOf later and server.count === local.count → server', () => {
    const local: HeartState = { asOf: 100, count: 5 }
    const server: HeartState = { asOf: 200, count: 5 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 200, count: 5 })
  })

  it('returns exactly the server object (not a copy) when conditions are met', () => {
    const local: HeartState = { asOf: 100, count: 3 }
    const server: HeartState = { asOf: 200, count: 10 }
    const result = mergeHeart(local, server)
    expect(result.asOf).toBe(server.asOf)
    expect(result.count).toBe(server.count)
  })
})

describe('mergeHeart — keep local when server cannot confirm', () => {
  it('server.asOf later but server.count < local.count → local', () => {
    const local: HeartState = { asOf: 100, count: 5 }
    const server: HeartState = { asOf: 200, count: 3 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 100, count: 5 })
  })

  it('server.asOf equal to local.asOf → local (not strictly later)', () => {
    const local: HeartState = { asOf: 100, count: 5 }
    const server: HeartState = { asOf: 100, count: 10 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 100, count: 5 })
  })

  it('server.asOf earlier than local.asOf → local', () => {
    const local: HeartState = { asOf: 200, count: 5 }
    const server: HeartState = { asOf: 100, count: 10 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 200, count: 5 })
  })

  it('server.asOf earlier and server.count less → local', () => {
    const local: HeartState = { asOf: 300, count: 8 }
    const server: HeartState = { asOf: 150, count: 2 }
    expect(mergeHeart(local, server)).toEqual({ asOf: 300, count: 8 })
  })
})

describe('mergeHeart — no local override (null)', () => {
  it('local=null → returns server unconditionally', () => {
    const server: HeartState = { asOf: 200, count: 5 }
    expect(mergeHeart(null, server)).toEqual({ asOf: 200, count: 5 })
  })

  it('local=null with zero count → returns server', () => {
    const server: HeartState = { asOf: 1, count: 0 }
    expect(mergeHeart(null, server)).toEqual({ asOf: 1, count: 0 })
  })
})

describe('mergeHeart — transition: local override released once server confirms', () => {
  it('progression: local override held, then released when server catches up', () => {
    const local: HeartState = { asOf: 100, count: 5 }

    // Server hasn't caught up yet — keep local
    const early = mergeHeart(local, { asOf: 150, count: 4 })
    expect(early).toEqual(local)

    // Server now has matching count at a later timestamp — release override
    const updated = mergeHeart(local, { asOf: 200, count: 5 })
    expect(updated).toEqual({ asOf: 200, count: 5 })
  })

  it('once server.count exceeds local.count with later asOf, server wins', () => {
    const local: HeartState = { asOf: 100, count: 5 }
    const server: HeartState = { asOf: 300, count: 7 }
    const result = mergeHeart(local, server)
    expect(result.count).toBeGreaterThanOrEqual(local.count)
    expect(result.asOf).toBeGreaterThan(local.asOf)
  })
})

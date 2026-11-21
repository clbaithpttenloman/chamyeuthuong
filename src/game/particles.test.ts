// @vitest-environment node
/**
 * Tests for src/game/particles.ts — pure functions makeParticle and stepParticle.
 */
import { describe, it, expect } from 'vitest'
import { makeParticle, stepParticle, MAX_PARTICLES, type Particle } from './particles.ts'

// Deterministic rng factories
const rngFixed = (v: number) => () => v

// ─── makeParticle ────────────────────────────────────────────────────────────

describe('makeParticle — creates valid particle', () => {
  it('x is within [0, w] for various rng values', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const p = makeParticle(400, 600, rngFixed(v))
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(400)
    }
  })

  it('y is within [0, h] for various rng values', () => {
    for (const v of [0, 0.5, 1]) {
      const p = makeParticle(400, 600, rngFixed(v))
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(600)
    }
  })

  it('r is in [1.5, 4]', () => {
    expect(makeParticle(100, 100, rngFixed(0)).r).toBeCloseTo(1.5, 5)
    expect(makeParticle(100, 100, rngFixed(1)).r).toBeCloseTo(4.0, 5)
    expect(makeParticle(100, 100, rngFixed(0.5)).r).toBeCloseTo(2.75, 5)
  })

  it('speed is in [0.04, 0.10]', () => {
    expect(makeParticle(100, 100, rngFixed(0)).speed).toBeCloseTo(0.04, 5)
    expect(makeParticle(100, 100, rngFixed(1)).speed).toBeCloseTo(0.10, 5)
  })

  it('opacity is in [0.4, 0.9]', () => {
    expect(makeParticle(100, 100, rngFixed(0)).opacity).toBeCloseTo(0.4, 5)
    expect(makeParticle(100, 100, rngFixed(1)).opacity).toBeCloseTo(0.9, 5)
  })

  it('wind magnitude is ≤ 0.015', () => {
    for (const v of [0, 0.5, 1]) {
      const p = makeParticle(100, 100, rngFixed(v))
      expect(Math.abs(p.wind)).toBeLessThanOrEqual(0.015 + 1e-9)
    }
  })

  it('phase is in [0, 2π)', () => {
    for (const v of [0, 0.5, 0.999]) {
      const p = makeParticle(100, 100, rngFixed(v))
      expect(p.phase).toBeGreaterThanOrEqual(0)
      expect(p.phase).toBeLessThan(2 * Math.PI + 1e-9)
    }
  })
})

// ─── stepParticle ────────────────────────────────────────────────────────────

describe('stepParticle — advances particle state', () => {
  const baseP = (): Particle => ({
    x: 100, y: 100, r: 2, speed: 0.05, wind: 0.01, opacity: 0.8, phase: 0,
  })

  it('y increases (falls down) for dt > 0', () => {
    const p = stepParticle(baseP(), 100, 400, 600)
    expect(p.y).toBeGreaterThan(100)
  })

  it('y is unchanged when dt = 0 (wind and speed are zero contribution)', () => {
    const p: Particle = { ...baseP(), wind: 0 }
    // phase increments: sin(0 * dt * 0.002) * 0.015 * 0 = 0 for dt=0
    const p2 = stepParticle(p, 0, 400, 600)
    expect(p2.y).toBeCloseTo(p.y, 10)
    expect(p2.x).toBeCloseTo(p.x, 10)
  })

  it('phase increases proportionally to dt', () => {
    const p = baseP()
    const p2 = stepParticle(p, 100, 400, 600)
    expect(p2.phase).toBeCloseTo(p.phase + 100 * 0.002, 10)
  })

  it('x is affected by wind (no wobble at phase=0)', () => {
    const p: Particle = { ...baseP(), wind: 0.1, phase: 0 }
    const p2 = stepParticle(p, 100, 400, 600)
    // sin(0 + dt*0.002) * 0.015 * dt = sin(0.2) * 0.015 * 100 ≈ 0.299
    const sinContrib = Math.sin(0.2) * 0.015 * 100
    expect(p2.x).toBeCloseTo(100 + 0.1 * 100 + sinContrib, 1)
  })

  it('wraps to top when y exceeds h + r', () => {
    const p: Particle = { ...baseP(), y: 599, speed: 0.1, r: 2 }
    const p2 = stepParticle(p, 100, 400, 600)  // y = 599 + 10 = 609 > 602
    expect(p2.y).toBeCloseTo(-2, 10)
  })

  it('x is reassigned on wrap (not retained)', () => {
    const p: Particle = { ...baseP(), y: 1000, x: 200, r: 2 }
    const p2 = stepParticle(p, 0, 400, 600)
    // y > h + r, so wrap: x is reassigned (Math.random * 400)
    expect(p2.x).toBeGreaterThanOrEqual(0)
    expect(p2.x).toBeLessThanOrEqual(400)
  })

  it('y falls faster with larger speed', () => {
    const slow = stepParticle({ ...baseP(), speed: 0.01 }, 100, 400, 600).y
    const fast = stepParticle({ ...baseP(), speed: 0.1 }, 100, 400, 600).y
    expect(fast).toBeGreaterThan(slow)
  })
})

// ─── MAX_PARTICLES ────────────────────────────────────────────────────────────

describe('MAX_PARTICLES', () => {
  it('is 120', () => {
    expect(MAX_PARTICLES).toBe(120)
  })
})

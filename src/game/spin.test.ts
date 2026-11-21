// @vitest-environment node
/**
 * Tests for src/game/spin.ts — drag/inertia/keyboard spin state machine.
 *
 * API CONTRACT (implementer must match exactly):
 *
 *   interface SpinState {
 *     phi: number       // current rotation angle in radians (unbounded, continuous)
 *     velocity: number  // angular velocity in radians per millisecond
 *   }
 *
 *   interface SpinOptions {
 *     reducedMotion?: boolean  // if true, release() sets velocity=0 (no inertia)
 *   }
 *
 *   interface SpinMachine {
 *     readonly state: SpinState
 *
 *     // Record an incremental pointer drag of `dx` pixels at timestamp `t` (ms).
 *     // Updates phi live (phi += dx * pixelToRad) and buffers (dx, t) for velocity.
 *     drag(dx: number, t: number): void
 *
 *     // Compute velocity from buffered drag events (last ~100 ms window) and set it.
 *     // If reducedMotion, velocity is set to 0 instead.
 *     release(t: number): void
 *
 *     // Advance physics by `dt` milliseconds: phi += velocity * dt; decay velocity.
 *     // Returns the new state.
 *     step(dt: number): SpinState
 *
 *     // Directly advance phi by a fixed angular step (same magnitude each call).
 *     // 'right' increases phi; 'left' decreases phi.
 *     key(direction: 'left' | 'right'): void
 *
 *     // Returns the nearest equivalent target phi such that slotAngle + phi ≈ 0
 *     // (the slot faces front). Chooses the multiple of 2π closest to current phi
 *     // (shortest-path direction). Equivalent to:
 *     //   diff = -slotAngle - phi  (or normalise into [-π, π])
 *     //   return phi + diff (rounded to nearest 2π multiple)
 *     targetFor(slotAngle: number): number
 *   }
 *
 *   export function createSpin(options?: SpinOptions): SpinMachine
 */

import { describe, it, expect } from 'vitest'
import { createSpin } from './spin.ts'

// ─── Initial state ─────────────────────────────────────────────────────────────

describe('createSpin — initial state', () => {
  it('phi starts at 0', () => {
    expect(createSpin().state.phi).toBe(0)
  })

  it('velocity starts at 0', () => {
    expect(createSpin().state.velocity).toBe(0)
  })
})

// ─── drag() — live phi update ─────────────────────────────────────────────────

describe('drag — live phi update', () => {
  it('positive dx increases phi', () => {
    const spin = createSpin()
    spin.drag(100, 0)
    expect(spin.state.phi).toBeGreaterThan(0)
  })

  it('negative dx decreases phi', () => {
    const spin = createSpin()
    spin.drag(-100, 0)
    expect(spin.state.phi).toBeLessThan(0)
  })

  it('drag right then further left brings phi negative', () => {
    const spin = createSpin()
    spin.drag(100, 0)      // phi > 0
    spin.drag(-300, 10)    // net dx = -200, phi < 0
    expect(spin.state.phi).toBeLessThan(0)
  })

  it('equal and opposite drags return phi to near 0', () => {
    const spin = createSpin()
    spin.drag(150, 0)
    spin.drag(-150, 10)
    expect(spin.state.phi).toBeCloseTo(0, 10)
  })

  it('drag moves phi proportionally (double dx → double phi change)', () => {
    const spin1 = createSpin()
    spin1.drag(100, 0)
    const phi1 = spin1.state.phi

    const spin2 = createSpin()
    spin2.drag(200, 0)
    const phi2 = spin2.state.phi

    expect(phi2).toBeCloseTo(2 * phi1, 10)
  })
})

// ─── release() → velocity computed from drag history ─────────────────────────

describe('release — velocity from drag history', () => {
  it('releasing after rightward drag gives positive velocity', () => {
    const spin = createSpin()
    spin.drag(50, 0)
    spin.drag(50, 20)
    spin.drag(50, 40)
    spin.release(40)
    expect(spin.state.velocity).toBeGreaterThan(0)
  })

  it('releasing after leftward drag gives negative velocity', () => {
    const spin = createSpin()
    spin.drag(-50, 0)
    spin.drag(-50, 20)
    spin.drag(-50, 40)
    spin.release(40)
    expect(spin.state.velocity).toBeLessThan(0)
  })

  it('faster drag yields higher velocity magnitude', () => {
    const slow = createSpin()
    slow.drag(10, 0)
    slow.drag(10, 100)
    slow.release(100)
    const slowVel = Math.abs(slow.state.velocity)

    const fast = createSpin()
    fast.drag(10, 0)
    fast.drag(10, 10)
    fast.release(10)
    const fastVel = Math.abs(fast.state.velocity)

    expect(fastVel).toBeGreaterThan(slowVel)
  })

  it('phi is unchanged by release itself', () => {
    const spin = createSpin()
    spin.drag(80, 0)
    spin.drag(80, 30)
    const phiBefore = spin.state.phi
    spin.release(30)
    expect(spin.state.phi).toBeCloseTo(phiBefore, 10)
  })
})

// ─── step() — physics advance ─────────────────────────────────────────────────

describe('step — phi advances with velocity', () => {
  it('positive velocity → phi increases after step', () => {
    const spin = createSpin()
    spin.drag(80, 0)
    spin.drag(80, 30)
    spin.release(30)
    const phi0 = spin.state.phi
    spin.step(16)
    expect(spin.state.phi).toBeGreaterThan(phi0)
  })

  it('negative velocity → phi decreases after step', () => {
    const spin = createSpin()
    spin.drag(-80, 0)
    spin.drag(-80, 30)
    spin.release(30)
    const phi0 = spin.state.phi
    spin.step(16)
    expect(spin.state.phi).toBeLessThan(phi0)
  })

  it('zero velocity → phi unchanged after step', () => {
    const spin = createSpin()
    spin.step(16)
    expect(spin.state.phi).toBe(0)
  })

  it('step returns the updated state', () => {
    const spin = createSpin()
    spin.drag(80, 0)
    spin.release(0)
    const returned = spin.step(16)
    expect(returned.phi).toBe(spin.state.phi)
    expect(returned.velocity).toBe(spin.state.velocity)
  })
})

// ─── Inertia: velocity decays to rest ────────────────────────────────────────

describe('step — inertia decay', () => {
  it('velocity decays toward 0 after many steps (60fps for ~5 s)', () => {
    const spin = createSpin()
    spin.drag(100, 0)
    spin.drag(100, 20)
    spin.drag(100, 40)
    spin.release(40)
    const vel0 = Math.abs(spin.state.velocity)
    expect(vel0).toBeGreaterThan(0)

    for (let i = 0; i < 300; i++) spin.step(16)  // 300 × 16 ms = 4.8 s

    expect(Math.abs(spin.state.velocity)).toBeLessThan(vel0 * 0.001)
  })

  it('velocity after 500 steps is effectively zero (< 1e-6)', () => {
    const spin = createSpin()
    spin.drag(200, 0)
    spin.drag(200, 10)
    spin.release(10)

    for (let i = 0; i < 500; i++) spin.step(16)

    expect(Math.abs(spin.state.velocity)).toBeLessThan(1e-6)
  })

  it('velocity decreases monotonically in absolute value during decay', () => {
    const spin = createSpin()
    spin.drag(80, 0)
    spin.drag(80, 20)
    spin.release(20)

    let prevVelAbs = Math.abs(spin.state.velocity)
    for (let i = 0; i < 50; i++) {
      spin.step(16)
      const curVelAbs = Math.abs(spin.state.velocity)
      expect(curVelAbs).toBeLessThanOrEqual(prevVelAbs)
      prevVelAbs = curVelAbs
    }
  })
})

// ─── key() — fixed-step keyboard spin ────────────────────────────────────────

describe('key — fixed angular steps', () => {
  it('key("right") increases phi', () => {
    const spin = createSpin()
    spin.key('right')
    expect(spin.state.phi).toBeGreaterThan(0)
  })

  it('key("left") decreases phi', () => {
    const spin = createSpin()
    spin.key('left')
    expect(spin.state.phi).toBeLessThan(0)
  })

  it('two key("right") presses add twice the single-press step', () => {
    const spin = createSpin()
    spin.key('right')
    const step = spin.state.phi
    spin.key('right')
    expect(spin.state.phi).toBeCloseTo(2 * step, 10)
  })

  it('key("right") then key("left") returns to original phi', () => {
    const spin = createSpin()
    spin.key('right')
    spin.key('left')
    expect(spin.state.phi).toBeCloseTo(0, 10)
  })

  it('key("left") and key("right") have equal magnitude step', () => {
    const r = createSpin()
    r.key('right')
    const rightStep = r.state.phi

    const l = createSpin()
    l.key('left')
    const leftStep = l.state.phi

    expect(Math.abs(rightStep)).toBeCloseTo(Math.abs(leftStep), 10)
  })

  it('key step size is positive and reasonable (between 1° and 90°)', () => {
    const spin = createSpin()
    spin.key('right')
    const step = spin.state.phi
    expect(step).toBeGreaterThan(Math.PI / 180)      // > 1 degree
    expect(step).toBeLessThan(Math.PI / 2)           // < 90 degrees
  })
})

// ─── targetFor() — rotate to front (shortest path) ───────────────────────────

describe('targetFor — puts slot at front', () => {
  it('target puts slotAngle=0 slot at front from phi=0', () => {
    const spin = createSpin()
    const target = spin.targetFor(0)
    // cos(0 + target) ≈ 1
    expect(Math.cos(0 + target)).toBeCloseTo(1, 5)
  })

  it('target puts slotAngle=π/4 at front from phi=0', () => {
    const spin = createSpin()
    const target = spin.targetFor(Math.PI / 4)
    expect(Math.cos(Math.PI / 4 + target)).toBeCloseTo(1, 5)
  })

  it('target puts slotAngle=π/2 at front from phi=0', () => {
    const spin = createSpin()
    const target = spin.targetFor(Math.PI / 2)
    expect(Math.cos(Math.PI / 2 + target)).toBeCloseTo(1, 5)
  })

  it('target puts slotAngle=π at front from phi=0', () => {
    const spin = createSpin()
    const target = spin.targetFor(Math.PI)
    expect(Math.cos(Math.PI + target)).toBeCloseTo(1, 5)
  })

  it('target puts slot at front after dragging (non-zero phi)', () => {
    const spin = createSpin()
    spin.drag(200, 0)  // phi > 0
    const slotAngle = Math.PI / 3
    const target = spin.targetFor(slotAngle)
    expect(Math.cos(slotAngle + target)).toBeCloseTo(1, 5)
  })
})

describe('targetFor — shortest path (within π of current phi)', () => {
  it('target is within π of current phi=0', () => {
    const spin = createSpin()
    const target = spin.targetFor(Math.PI / 3)
    expect(Math.abs(target - spin.state.phi)).toBeLessThanOrEqual(Math.PI)
  })

  it('target is within π of current phi after dragging', () => {
    const spin = createSpin()
    spin.drag(200, 0)
    const phi = spin.state.phi
    const target = spin.targetFor(Math.PI / 4)
    expect(Math.abs(target - phi)).toBeLessThanOrEqual(Math.PI)
  })

  it('targetFor(0) from phi=0 returns 0 (already at front)', () => {
    const spin = createSpin()
    expect(spin.targetFor(0)).toBeCloseTo(0, 10)
  })

  it('targetFor(π/2) from phi=0 spins left (target = -π/2)', () => {
    const spin = createSpin()
    // Shortest path from 0 to bring π/2 to front: rotate left by π/2
    expect(spin.targetFor(Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 5)
  })

  it('target is consistent: same slotAngle and phi → same target', () => {
    const spin1 = createSpin()
    const spin2 = createSpin()
    expect(spin1.targetFor(1.0)).toBeCloseTo(spin2.targetFor(1.0), 10)
  })
})

// ─── reducedMotion — no inertia on release ────────────────────────────────────

describe('reducedMotion — release sets velocity=0', () => {
  it('release() sets velocity to 0 when reducedMotion=true', () => {
    const spin = createSpin({ reducedMotion: true })
    spin.drag(100, 0)
    spin.drag(100, 20)
    spin.drag(100, 40)
    spin.release(40)
    expect(spin.state.velocity).toBe(0)
  })

  it('phi does not change via step() after release with reducedMotion', () => {
    const spin = createSpin({ reducedMotion: true })
    spin.drag(100, 0)
    spin.release(0)
    const phiAtRelease = spin.state.phi
    spin.step(16)
    expect(spin.state.phi).toBe(phiAtRelease)
  })

  it('drag still moves phi in reducedMotion mode', () => {
    const spin = createSpin({ reducedMotion: true })
    spin.drag(100, 0)
    expect(spin.state.phi).toBeGreaterThan(0)
  })

  it('key() still works in reducedMotion mode', () => {
    const spin = createSpin({ reducedMotion: true })
    spin.key('right')
    expect(spin.state.phi).toBeGreaterThan(0)
  })

  it('without reducedMotion, release gives non-zero velocity', () => {
    const spin = createSpin({ reducedMotion: false })
    spin.drag(100, 0)
    spin.drag(100, 20)
    spin.drag(100, 40)
    spin.release(40)
    expect(spin.state.velocity).not.toBe(0)
  })
})

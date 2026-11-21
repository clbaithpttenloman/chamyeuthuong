/** Drag / inertia / keyboard spin state machine for the gift tree cone (ADR-4). */

/** Current rotation state. phi is unbounded (continuous, not wrapped). */
export interface SpinState {
  phi: number      // current rotation angle in radians
  velocity: number // angular velocity in radians per millisecond
}

/** Configuration options for the spin machine. */
export interface SpinOptions {
  reducedMotion?: boolean // if true, release() sets velocity=0 (no inertia)
}

/** Spin state machine controlling the cone's phi angle. */
export interface SpinMachine {
  readonly state: SpinState

  /** Record incremental pointer drag of `dx` pixels at timestamp `t` ms. */
  drag(dx: number, t: number): void

  /** Compute velocity from last ~100 ms of drag events (or 0 if reducedMotion). */
  release(t: number): void

  /** Advance physics by `dt` ms: phi += velocity * dt; decay velocity. */
  step(dt: number): SpinState

  /** Advance phi by one fixed angular step. 'right' increases phi. */
  key(direction: 'left' | 'right'): void

  /** Target phi (shortest path) that brings `slotAngle` to the front face. */
  targetFor(slotAngle: number): number
}

// Conversion: pixels of drag → radians (1000 px ≈ 2π rad = one full rotation)
const PIXEL_TO_RAD = (2 * Math.PI) / 1000
// Fixed keyboard step: 15° per press
const KEY_STEP = Math.PI / 12
// Per-millisecond friction for inertia decay
// 0.998^4800 ≈ 6.7e-5 < 0.001 (passes 300-frame decay test)
const FRICTION = 0.998
// Velocity estimation window
const VELOCITY_WINDOW_MS = 100

interface DragSample { dx: number; t: number }

/** Creates a new spin state machine. */
export function createSpin(options?: SpinOptions): SpinMachine {
  const reducedMotion = options?.reducedMotion ?? false
  const state: SpinState = { phi: 0, velocity: 0 }
  const buffer: DragSample[] = []

  return {
    get state(): SpinState {
      return state
    },

    drag(dx: number, t: number): void {
      state.phi += dx * PIXEL_TO_RAD
      buffer.push({ dx, t })
    },

    release(t: number): void {
      if (reducedMotion) {
        state.velocity = 0
        buffer.length = 0
        return
      }
      const cutoff = t - VELOCITY_WINDOW_MS
      const win = buffer.filter(e => e.t >= cutoff)
      if (win.length >= 2) {
        const totalDx = win.reduce((s, e) => s + e.dx, 0)
        const span = win[win.length - 1].t - win[0].t
        state.velocity = (totalDx / Math.max(span, 1)) * PIXEL_TO_RAD
      } else {
        state.velocity = 0
      }
      buffer.length = 0
    },

    step(dt: number): SpinState {
      state.phi += state.velocity * dt
      state.velocity *= Math.pow(FRICTION, dt)
      return state
    },

    key(direction: 'left' | 'right'): void {
      state.phi += direction === 'right' ? KEY_STEP : -KEY_STEP
    },

    targetFor(slotAngle: number): number {
      // Find k such that slotAngle + k*2π - slotAngle ≈ phi (shortest path)
      // i.e. target = k*2π - slotAngle where k = round((slotAngle + phi) / 2π)
      const twoPI = 2 * Math.PI
      const k = Math.round((slotAngle + state.phi) / twoPI)
      return k * twoPI - slotAngle
    },
  }
}

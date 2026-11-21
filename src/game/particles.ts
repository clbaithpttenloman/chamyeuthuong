// @vitest-environment node
/**
 * Snow particle system for the Noel scene (ADR-4).
 *
 * makeParticle and stepParticle are pure functions — testable without a DOM.
 * startSnow wires them to a canvas element.
 *
 * Constraints: ≤ MAX_PARTICLES (120); paused when tab hidden; no-op under
 * prefers-reduced-motion. Writes only to canvas context (no layout reads in hot path).
 */

export const MAX_PARTICLES = 120

/** All fields in CSS logical pixels. */
export interface Particle {
  x: number       // current x
  y: number       // current y
  r: number       // radius in px  (1.5–4)
  speed: number   // fall speed px/ms  (0.04–0.10)
  wind: number    // horizontal drift px/ms  (±0.015)
  opacity: number // 0.4–0.9
  phase: number   // wobble phase radians
}

/** Create a particle at a random position within w×h.
 *  rng is injectable for deterministic tests; defaults to Math.random. */
export function makeParticle(w: number, h: number, rng: () => number = Math.random): Particle {
  return {
    x: rng() * w,
    y: rng() * h,
    r: 1.5 + rng() * 2.5,
    speed: 0.04 + rng() * 0.06,
    wind: (rng() - 0.5) * 0.03,
    opacity: 0.4 + rng() * 0.5,
    phase: rng() * 2 * Math.PI,
  }
}

/**
 * Advance a particle by dt ms. Pure — returns a new Particle object.
 * Wraps to the top (y = -r) when the particle falls past the bottom.
 */
export function stepParticle(p: Particle, dt: number, w: number, h: number): Particle {
  const phase = p.phase + dt * 0.002
  const x = p.x + p.wind * dt + Math.sin(phase) * 0.015 * dt
  const y = p.y + p.speed * dt
  if (y > h + p.r) {
    return { ...p, x: Math.random() * w, y: -p.r, phase }
  }
  return { ...p, x, y, phase }
}

/**
 * Start snow on a canvas element.
 * Returns a cleanup function that stops the rAF loop and removes event listeners.
 *
 * - Does nothing (empty cleanup) under prefers-reduced-motion.
 * - count is clamped to MAX_PARTICLES.
 * - Canvas size is synced to its CSS rect on each frame (handles window resize).
 */
export function startSnow(canvas: HTMLCanvasElement, count = 80): () => void {
  if (typeof window === 'undefined') return () => {}
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {}

  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  const n = Math.min(count, MAX_PARTICLES)

  // Initial size sync
  const dpr0 = window.devicePixelRatio || 1
  let { width: cssW, height: cssH } = canvas.getBoundingClientRect()
  if (cssW === 0) cssW = canvas.clientWidth
  if (cssH === 0) cssH = canvas.clientHeight
  canvas.width = Math.round(cssW * dpr0)
  canvas.height = Math.round(cssH * dpr0)
  ctx.setTransform(dpr0, 0, 0, dpr0, 0, 0)
  let w = cssW || 390
  let h = cssH || 600

  let particles: Particle[] = Array.from({ length: n }, () => makeParticle(w, h))

  let rafId = 0
  let lastT = 0
  let visible = document.visibilityState !== 'hidden'

  const handleVisibility = () => {
    visible = document.visibilityState !== 'hidden'
    if (visible && rafId === 0) {
      lastT = 0
      rafId = requestAnimationFrame(loop)
    }
  }
  document.addEventListener('visibilitychange', handleVisibility)

  const loop = (t: number) => {
    rafId = 0
    if (!visible) return

    const dt = lastT > 0 ? Math.min(t - lastT, 50) : 16
    lastT = t

    // Sync canvas size (no-layout: use getBoundingClientRect only)
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const newW = rect.width || w
    const newH = rect.height || h
    if (Math.abs(newW - w) > 0.5 || Math.abs(newH - h) > 0.5) {
      canvas.width = Math.round(newW * dpr)
      canvas.height = Math.round(newH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      w = newW
      h = newH
    }

    ctx.clearRect(0, 0, w, h)

    for (let i = 0; i < particles.length; i++) {
      const p = stepParticle(particles[i], dt, w, h)
      particles[i] = p
      ctx.beginPath()
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255,255,255,${p.opacity.toFixed(2)})`
      ctx.fill()
    }

    rafId = requestAnimationFrame(loop)
  }

  rafId = requestAnimationFrame(loop)

  return () => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    document.removeEventListener('visibilitychange', handleVisibility)
  }
}

/**
 * WAAPI animation helpers for the Noel scene (ADR-4).
 *
 * All animations fall back to simple fades under prefers-reduced-motion.
 * animateBoxOpen returns Promise<void> that resolves when the opening sequence ends.
 *
 * Pure helper functions are exported for unit testing.
 */

/**
 * Pure: compute (tx, ty) for sparkle i out of total at given distance.
 * Sparkles are evenly distributed around a circle, offset upward by 25 px.
 */
export function sparkleOffset(
  i: number,
  total: number,
  dist: number,
): { tx: number; ty: number } {
  const angle = (i / total) * 2 * Math.PI
  return {
    tx: Math.cos(angle) * dist,
    ty: Math.sin(angle) * dist - 25,
  }
}

/** Animate the star with a continuous twinkle (infinite).
 *  Reduced motion: static (opacity 1, no transform). */
export function animateStar(el: Element, reducedMotion: boolean): Animation {
  if (reducedMotion) {
    return el.animate([{ opacity: 1 }], { duration: 1000, fill: 'forwards' })
  }
  return el.animate(
    [
      { transform: 'scale(1) rotate(0deg)', filter: 'brightness(1)', offset: 0 },
      {
        transform: 'scale(1.2) rotate(20deg)',
        filter: 'brightness(1.8) drop-shadow(0 0 10px rgba(255,255,200,0.9))',
        offset: 0.5,
      },
      { transform: 'scale(1) rotate(40deg)', filter: 'brightness(1)', offset: 1 },
    ],
    { duration: 2500, iterations: Infinity, easing: 'ease-in-out' },
  )
}

/**
 * Flash an ornament button when it rotates to front.
 * Reduced motion: instant (no animation).
 */
export function flashOrnament(el: Element, reducedMotion: boolean): Promise<void> {
  if (reducedMotion) return Promise.resolve()
  return (
    el
      .animate(
        [
          { filter: 'brightness(1)', offset: 0 },
          { filter: 'brightness(2.2)', offset: 0.3 },
          { filter: 'brightness(1)', offset: 1 },
        ],
        { duration: 380, easing: 'ease-in-out' },
      )
      .finished.then(() => {}) as Promise<void>
  )
}

/** Elements needed for the box-opening stage. */
export interface BoxOpenStage {
  box: Element     // the closed-box image element
  lid: Element     // the lid element (absolutely positioned above the box)
  sparks: Element  // container for sparkle particles
}

const SPARK_COUNT = 8
const SPARK_DIST = 60

/**
 * Animate the box opening: lid lifts while box shrinks/fades, then sparkles burst.
 * Returns Promise<void> that resolves when all animations complete.
 * Reduced motion: fade the box from opacity 0 → 1 only.
 */
export function animateBoxOpen(stage: BoxOpenStage, reducedMotion: boolean): Promise<void> {
  if (reducedMotion) {
    return stage.box
      .animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 300,
        easing: 'ease-out',
        fill: 'forwards',
      })
      .finished.then(() => {}) as Promise<void>
  }

  const boxClose = stage.box.animate(
    [
      { transform: 'scale(1)', opacity: 1, offset: 0 },
      { transform: 'scale(0.85) translateY(8px)', opacity: 0.5, offset: 0.6 },
      { transform: 'scale(0.6) translateY(16px)', opacity: 0, offset: 1 },
    ],
    { duration: 480, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' },
  )

  const lidLift = stage.lid.animate(
    [
      {
        transform: 'translateX(-50%) translateY(0) rotateX(0deg)',
        opacity: 1,
        offset: 0,
      },
      {
        transform: 'translateX(-50%) translateY(-70px) rotateX(-30deg)',
        opacity: 0,
        offset: 1,
      },
    ],
    { duration: 440, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' },
  )

  const sparkPromises: Promise<void>[] = []
  for (let i = 0; i < SPARK_COUNT; i++) {
    const { tx, ty } = sparkleOffset(i, SPARK_COUNT, SPARK_DIST)
    const spark = document.createElement('div')
    spark.className = 'noel-spark'
    stage.sparks.appendChild(spark)
    const anim = spark.animate(
      [
        { transform: 'translate(-50%,-50%) scale(0)', opacity: 1, offset: 0 },
        {
          transform: `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0.5)`,
          opacity: 0,
          offset: 1,
        },
      ],
      { duration: 650, delay: 80, easing: 'ease-out', fill: 'forwards' },
    )
    sparkPromises.push(
      anim.finished.then(() => { spark.remove() }).catch(() => { spark.remove() }),
    )
  }

  return Promise.all([
    boxClose.finished.then(() => {}).catch(() => {}),
    lidLift.finished.then(() => {}).catch(() => {}),
    ...sparkPromises,
  ]).then(() => {}) as Promise<void>
}

/**
 * Burst hearts from screen coordinates (x, y).
 * Reduced motion: no-op (the heart count still increments via state update).
 */
export function burstHearts(
  x: number,
  y: number,
  reducedMotion: boolean,
  count = 6,
): void {
  if (reducedMotion) return
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div')
    el.className = 'noel-heart-particle'
    el.textContent = '❤️'
    el.style.cssText = `position:fixed;left:${x}px;top:${y}px;pointer-events:none;z-index:999;font-size:1.1rem;line-height:1;transform-origin:center;`
    document.body.appendChild(el)
    const angle = -Math.PI / 2 + ((i - count / 2) / count) * Math.PI * 1.4
    const dist = 50 + Math.random() * 40
    const tx = Math.cos(angle) * dist
    const ty = Math.sin(angle) * dist - 20
    const anim = el.animate(
      [
        { transform: 'translate(0,0) scale(1.2)', opacity: 1 },
        { transform: `translate(${tx}px,${ty}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 820, easing: 'ease-out', fill: 'forwards' },
    )
    anim.finished.then(() => el.remove()).catch(() => el.remove())
  }
}

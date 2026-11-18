/**
 * Shrink a card's writing zone until its text fits (card v3).
 *
 * Sizes are in cqw (card-width units), so the result is the same at every card width: a
 * thumbnail and the full card shrink to the same size. The loop is bounded: at most
 * MAX_STEPS reflows per call; past that the zone clips the end of the text.
 */
import type { Ratio } from '../../shared/layouts.ts'

/** Starting zone font size in cqw per card ratio. */
export const BASE_SIZE: Record<Ratio, number> = { portrait: 5.6, landscape: 4.2 }
export const SHRINK = 0.92
/** 0.92^12 ≈ 0.37 of the base size. */
export const MAX_STEPS = 12

/** The parts of an element fitText touches (an HTMLElement in the browser, a stub in tests). */
export type FitTarget = { style: { fontSize: string }; scrollHeight: number; clientHeight: number }

/** Returns the font size (cqw) it settled on. */
export function fitText(zone: FitTarget, ratio: Ratio): number {
  let size = BASE_SIZE[ratio]
  zone.style.fontSize = `${size}cqw`
  for (let i = 0; i < MAX_STEPS && zone.scrollHeight > zone.clientHeight + 1; i++) {
    size *= SHRINK
    zone.style.fontSize = `${size.toFixed(2)}cqw`
  }
  return size
}

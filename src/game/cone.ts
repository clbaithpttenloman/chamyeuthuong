// @vitest-environment node
/** 2.5D cone projection math for the gift tree scene (ADR-4). */

/** A gift slot on the cone surface. Rank 1 = nearest the star (smallest h). */
export interface Slot {
  rank: number  // 1-based
  h: number     // 0 = tree tip (star), 1 = foliage base
  theta: number // radians [0, 2π), 0 = front face
}

/** Scene viewport dimensions in pixels. */
export interface SceneSize {
  width: number
  height: number
}

/** Screen projection of a slot at spin angle phi. */
export interface Projection {
  x: number       // pixels from left edge
  depth: number   // cos(theta + phi), range [-1, 1]
  scale: number   // > 0; larger when depth > 0
  opacity: number // 0 < opacity ≤ 1; larger when depth > 0
  behind: boolean // true iff depth < 0
}

// Golden angle ≈ 2.3999 rad — maximally uniform angular spacing on the cone
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

/**
 * Distributes `treeSlots` gifts on the cone surface.
 * Rank 1 is nearest the star (smallest h). No position duplicates.
 * Adjacent-rank slots have large angular separation via the golden angle.
 */
export function slotLayout(treeSlots: number): Slot[] {
  const slots: Slot[] = []
  for (let rank = 1; rank <= treeSlots; rank++) {
    // h = rank / (n+1) → rank 1 has minimum h, rank n has maximum h, all in (0,1)
    const h = rank / (treeSlots + 1)
    // Golden angle gives maximally uniform angular distribution with no clustering
    const theta = ((rank - 1) * GOLDEN_ANGLE) % (2 * Math.PI)
    slots.push({ rank, h, theta })
  }
  return slots
}

/**
 * Projects a slot onto screen space given spin angle `phi` and scene `size`.
 *   depth = cos(theta + phi)
 *   x     = width/2 + r(h) * sin(theta + phi)
 *   scale and opacity increase linearly with depth; both positive even when behind
 */
export function project(slot: Slot, phi: number, size: SceneSize): Projection {
  const angle = slot.theta + phi
  const depth = Math.cos(angle)
  // Cone radius at height h: 10%–40% of scene half-width, stays within scene bounds
  const r = size.width * (0.1 + 0.3 * slot.h)
  const x = size.width / 2 + r * Math.sin(angle)
  // Map depth ∈ [-1, 1] → t ∈ [0, 1] for scale/opacity
  const t = (1 + depth) / 2
  const scale = 0.5 + 0.5 * t
  const opacity = 0.5 + 0.5 * t
  return { x, depth, scale, opacity, behind: depth < 0 }
}

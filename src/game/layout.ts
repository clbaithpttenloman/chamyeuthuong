// @vitest-environment node
/**
 * Pure layout math for the Noel scene (ADR-4).
 *
 * computeSceneLayout: given scene container dimensions, compute tree rect,
 * ground surface y, star centre, ornament/box sizes, and box cluster positions.
 * No DOM access — all inputs are plain numbers.
 *
 * Ground model: layer_ground.webp (1920×500) is rendered with
 *   CSS: height: 22%; width: auto; min-width: 104%; object-fit: cover; object-position: top center
 * On narrow viewports the image is height-driven (natural width > min-width),
 * on wide viewports min-width takes over and obj-fit cover scales by width factor.
 * In both cases the snow surface lives at original-image y = 175 px (35% of 500).
 */

import { TREE_GEOMETRY } from './defaultTheme.ts'

const GEO = TREE_GEOMETRY

// Ground image intrinsics (layer_ground.webp)
const GROUND_IMAGE_W = 1920
const GROUND_IMAGE_H = 500
const GROUND_SURFACE_IMAGE_Y = 175        // top 35% of 500 = snow surface
const GROUND_HEIGHT_RATIO   = 0.22        // height: 22% of scene (matches mockup)
const GROUND_MIN_WIDTH_RATIO = 1.04       // min-width: 104%

// Minimum clearance from scene top to star centre (keeps star out of header shadow)
const TREE_TOP_MIN = 8  // px

export interface BoxPosition {
  x: number      // bottom-centre x in scene px
  y: number      // bottom-centre y in scene px
  size: number   // box width = height in px
  row: number    // 0 = front/bottom, 1 = back, 2 = further back
}

export interface SceneLayout {
  treeRect: Readonly<{ x: number; y: number; w: number; h: number }>
  groundTopY: number      // top of the ground img element in scene px
  groundSurfaceY: number  // y-coordinate where gifts stand on the snow
  starCenter: Readonly<{ x: number; y: number }>
  ornamentSize: number    // px; ornament button width = height
  starSize: number        // px; star wrapper width = height
  boxSize: number         // px; box button width = height (row-0 reference)
  boxPositions: ReadonlyArray<BoxPosition>
}

/**
 * Compute scene layout from viewport dimensions and gift count.
 * Pure — no DOM reads.
 *
 * @param sceneW  Scene container width in CSS pixels
 * @param sceneH  Scene container height in CSS pixels
 * @param groundGiftCount  Number of ground-slot gifts (for box cluster)
 */
export function computeSceneLayout(
  sceneW: number,
  sceneH: number,
  groundGiftCount: number,
): SceneLayout {
  // ── Ground ───────────────────────────────────────────────────────────────
  const groundH   = sceneH * GROUND_HEIGHT_RATIO
  const groundTopY = sceneH - groundH

  // Determine which dimension drives obj-fit scale:
  // obj-fit cover uses max(displayW/imageW, displayH/imageH) as scale factor.
  // displayW = max(naturalW, minW); displayH = groundH (fixed by CSS).
  const naturalGroundW = groundH * (GROUND_IMAGE_W / GROUND_IMAGE_H)
  const minGroundW     = sceneW * GROUND_MIN_WIDTH_RATIO
  const displayedGroundW = Math.max(naturalGroundW, minGroundW)

  // With object-position: top center, the content is anchored to the top.
  // Scale factor = displayedGroundW / GROUND_IMAGE_W (width always dominates when
  // min-width is active because that stretches beyond natural aspect ratio).
  const groundScaleX = displayedGroundW / GROUND_IMAGE_W
  const groundSurfaceY = groundTopY + GROUND_SURFACE_IMAGE_Y * groundScaleX

  // ── Tree ─────────────────────────────────────────────────────────────────
  const availH    = groundSurfaceY - TREE_TOP_MIN
  const treeAspect = GEO.imageW / GEO.imageH   // 0.75 (W/H)

  let treeH = availH
  let treeW = treeH * treeAspect
  if (treeW > sceneW * 0.98) {
    treeW = sceneW * 0.98
    treeH = treeW / treeAspect
  }

  const treeX = (sceneW - treeW) / 2
  const treeY = groundSurfaceY - treeH
  const treeRect = { x: treeX, y: treeY, w: treeW, h: treeH }

  // ── Star ─────────────────────────────────────────────────────────────────
  // Map (tipX, tipY) in image pixels → scene pixels.
  // treeW/imageW === treeH/imageH because we maintain exact aspect ratio.
  const treeScaleW = treeW / GEO.imageW
  const treeScaleH = treeH / GEO.imageH
  const starCenter = {
    x: treeX + GEO.tipX * treeScaleW,
    y: treeY + GEO.tipY * treeScaleH,
  }

  // ── Sizes (all proportional to tree width, clamped) ──────────────────────
  const ornamentSize = clamp(44, treeW * 0.13, 96)
  const starSize     = clamp(44, treeW * 0.15, 96)
  const boxSize      = clamp(44, treeW * 0.14, 100)

  // ── Box cluster ───────────────────────────────────────────────────────────
  const boxPositions = computeBoxCluster(sceneW, groundSurfaceY, groundGiftCount, boxSize)

  return {
    treeRect,
    groundTopY,
    groundSurfaceY,
    starCenter,
    ornamentSize,
    starSize,
    boxSize,
    boxPositions,
  }
}

/** Saturating clamp. */
function clamp(min: number, v: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

/**
 * Compute bottom-centre positions for a cluster of gift boxes on the snow.
 *
 * Layout rules:
 * - 2 rows for ≤ 7 gifts; 3 rows otherwise.
 * - Row 0 (front/bottom, largest, widest): rank 1 ground gift (most popular) first.
 * - Subsequent rows step upward (further back), shrinking slightly.
 * - All positions clamped to viewport width with half-box margin.
 */
export function computeBoxCluster(
  sceneW: number,
  groundSurfaceY: number,
  count: number,
  baseSize: number,
): BoxPosition[] {
  if (count === 0) return []

  const cx        = sceneW / 2
  const rowCount  = count <= 7 ? 2 : 3
  const rowSpacing = baseSize * 0.55  // vertical step between rows
  const giftsPerRow = Math.ceil(count / rowCount)

  const positions: BoxPosition[] = []

  for (let i = 0; i < count; i++) {
    const row       = Math.floor(i / giftsPerRow)
    const posInRow  = i % giftsPerRow
    const rowGiftCount = Math.min(giftsPerRow, count - row * giftsPerRow)

    // Back rows: slightly smaller and narrower
    const sizeScale    = 1 - row * 0.1
    const sz           = baseSize * sizeScale
    const spreadFactor = 1 - row * 0.15

    // Max half-spread: limited by scene width and by box density
    const halfSpread = Math.min(
      sceneW * 0.42 * spreadFactor,
      (rowGiftCount - 1) * sz * 0.75,
    )

    // Row 0 at groundSurfaceY; each subsequent row is "further back" = higher on screen
    const y = groundSurfaceY - row * rowSpacing

    const x = rowGiftCount === 1
      ? cx
      : cx - halfSpread + (posInRow / (rowGiftCount - 1)) * halfSpread * 2

    positions.push({
      x: clamp(sz / 2, x, sceneW - sz / 2),
      y,
      size: sz,
      row,
    })
  }

  return positions
}

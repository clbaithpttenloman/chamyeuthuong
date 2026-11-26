/**
 * Default theme: static file URLs for the gift_tree campaign kind.
 * Files live in public/theme/gift_tree/default/ and are served from dist/ after build.
 *
 * Tree geometry constants are the contract the scene's cone math uses.
 * These values match the pixel dimensions of tree.webp exactly.
 */

import { createContext, useContext, useMemo } from 'react'
import type { ThemeAsset } from '../../shared/themeSlots.ts'

const BASE = '/theme/gift_tree/default'

export const DEFAULT_THEME_URLS = {
  sky_portrait:   `${BASE}/sky_portrait.webp`,
  sky_landscape:  `${BASE}/sky_landscape.webp`,
  layer_ground:   `${BASE}/layer_ground.webp`,
  tree:           `${BASE}/tree.webp`,
  star:           `${BASE}/star.webp`,
  ornament_1:     `${BASE}/ornament_1.webp`,
  ornament_2:     `${BASE}/ornament_2.webp`,
  ornament_3:     `${BASE}/ornament_3.webp`,
  ornament_4:     `${BASE}/ornament_4.webp`,
  ornament_5:     `${BASE}/ornament_5.webp`,
  ornament_6:     `${BASE}/ornament_6.webp`,
  box_1_closed:   `${BASE}/box_1_closed.webp`,
  box_2_closed:   `${BASE}/box_2_closed.webp`,
  box_3_closed:   `${BASE}/box_3_closed.webp`,
  box_4_closed:   `${BASE}/box_4_closed.webp`,
  box_5_closed:   `${BASE}/box_5_closed.webp`,
  box_6_closed:   `${BASE}/box_6_closed.webp`,
} as const

/**
 * Tree geometry constants used by the scene's cone math.
 * Match the exact pixel layout of tree.webp (1200×1600).
 */
export const TREE_GEOMETRY = {
  /** Image width in pixels */
  imageW: 1200,
  /** Image height in pixels */
  imageH: 1600,
  /** X coordinate of the tree tip (star centre) in image pixels */
  tipX: 600,
  /** Y coordinate of the tree tip (star centre) in image pixels */
  tipY: 90,
  /** Y of the first foliage pixel at the centre (measured from tree.webp alpha, 2026-11-21).
   *  The star anchor sits ~46 px above it, as in the approved mockup; ornaments start below this. */
  foliageTopY: 136,
  /** Y coordinate of the foliage base in image pixels */
  foliageBaseY: 1310,
  /** Half-width of the foliage at the base in image pixels */
  foliageHalfWidthAtBase: 520,
} as const

export type DefaultThemeSlot = keyof typeof DEFAULT_THEME_URLS

export type ThemeUrls = Record<DefaultThemeSlot, string>

/** Uploaded theme assets for the current campaign, by slot. Empty = all defaults. */
export const ThemeOverridesContext = createContext<Readonly<Record<string, ThemeAsset>>>({})

/** Default URL for every static slot, replaced per slot by the campaign's upload when one exists. */
export function useThemeUrls(): ThemeUrls {
  const overrides = useContext(ThemeOverridesContext)
  return useMemo(() => {
    const out: Record<string, string> = { ...DEFAULT_THEME_URLS }
    for (const [slot, asset] of Object.entries(overrides)) {
      if (slot in DEFAULT_THEME_URLS && asset.url) out[slot] = asset.url
    }
    return out as ThemeUrls
  }, [overrides])
}

/** The upload for a slot that has no default (layer_far, overlay_loop, box_N_open), or null. */
export function useThemeAsset(slot: string): ThemeAsset | null {
  const overrides = useContext(ThemeOverridesContext)
  return overrides[slot] ?? null
}

/**
 * Grid position of one sprite frame as CSS background-position percentages. With the sheet sized to
 * cols×rows containers, these percentages land exactly on cell (col, row).
 */
export function spriteFramePosition(index: number, cols: number, rows: number): { x: string; y: string } {
  const col = index % cols
  const row = Math.floor(index / cols)
  const x = cols > 1 ? (col / (cols - 1)) * 100 : 0
  const y = rows > 1 ? (row / (rows - 1)) * 100 : 0
  return { x: `${x}%`, y: `${y}%` }
}

/** Total frames on a sprite sheet: every cell is one frame (all cells used). */
export function spriteGridTotal(grid: { cols: number; rows: number }): number {
  return grid.cols * grid.rows
}

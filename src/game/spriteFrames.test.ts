// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { spriteFramePosition, spriteGridTotal } from './defaultTheme.ts'
import { SPRITE_HOLD_MS } from './SpriteOpen.tsx'

describe('spriteFramePosition (2×3 sheet: 2 columns, 3 rows)', () => {
  it('frame 0 is the top-left cell, the last frame is the bottom-right cell', () => {
    expect(spriteFramePosition(0, 2, 3)).toEqual({ x: '0%', y: '0%' })
    expect(spriteFramePosition(5, 2, 3)).toEqual({ x: '100%', y: '100%' })
  })

  it('reads left to right, then top to bottom', () => {
    expect(spriteFramePosition(1, 2, 3)).toEqual({ x: '100%', y: '0%' })
    expect(spriteFramePosition(2, 2, 3)).toEqual({ x: '0%', y: '50%' })
  })

  it('a single row or column never divides by zero', () => {
    expect(spriteFramePosition(0, 1, 1)).toEqual({ x: '0%', y: '0%' })
  })
})

describe('sprite constants', () => {
  it('the open animation holds the last frame for a short time before the card shows', () => {
    expect(SPRITE_HOLD_MS).toBeGreaterThan(0)
    expect(SPRITE_HOLD_MS).toBeLessThan(1000)
  })

  it('spriteGridTotal is cols × rows', () => {
    expect(spriteGridTotal({ cols: 4, rows: 4 })).toBe(16)
  })
})

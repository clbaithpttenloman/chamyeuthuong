/**
 * SpriteOpen — plays an uploaded box-opening sprite sheet once (box_N_open). Frame 0 is the closed
 * box and the last frame is the open box. Under prefers-reduced-motion the last frame is shown
 * briefly and the sheet is done. onDone fires after the last frame is held.
 */
import { useEffect, useRef, useState } from 'react'
import { spriteFramePosition } from './defaultTheme.ts'

/** Hold time on the last (open) frame before the card appears. */
export const SPRITE_HOLD_MS = 400

type Props = {
  url: string
  cols: number
  rows: number
  frames: number
  fps: number
  reduced: boolean
  onDone: () => void
}

export default function SpriteOpen({ url, cols, rows, frames, fps, reduced, onDone }: Props) {
  const [frame, setFrame] = useState(reduced ? frames - 1 : 0)
  const doneRef = useRef(onDone)
  doneRef.current = onDone

  useEffect(() => {
    if (reduced) {
      const t = setTimeout(() => doneRef.current(), SPRITE_HOLD_MS)
      return () => clearTimeout(t)
    }
    let index = 0
    let timer: ReturnType<typeof setTimeout>
    const frameMs = 1000 / fps
    const tick = () => {
      if (index >= frames - 1) {
        timer = setTimeout(() => doneRef.current(), SPRITE_HOLD_MS)
        return
      }
      index += 1
      setFrame(index)
      timer = setTimeout(tick, frameMs)
    }
    timer = setTimeout(tick, frameMs)
    return () => clearTimeout(timer)
  }, [url, cols, rows, frames, fps, reduced])

  const pos = spriteFramePosition(frame, cols, rows)
  return (
    <div
      className="gift-sheet-sprite"
      aria-hidden="true"
      style={{
        backgroundImage: `url("${url}")`,
        backgroundSize: `${cols * 100}% ${rows * 100}%`,
        backgroundPosition: `${pos.x} ${pos.y}`,
      }}
    />
  )
}

/**
 * Scene — Noel 2.5D gift tree scene component (ADR-4).
 *
 * ─── CONTRACT (stable; flows task uses this) ───────────────────────────────
 *
 *   export interface TreeGift {
 *     publicId:      string
 *     rank:          number          // 1-based, assigned by rank.ts
 *     place:         'tree' | 'ground'
 *     nickname:      string
 *     className:     string
 *     heartCount:    number
 *     boxStyle:      number          // 1..6
 *     ornamentStyle: number          // 1..6
 *   }
 *
 *   export function Scene(props: SceneProps): JSX.Element
 *
 *   interface SceneProps {
 *     gifts:          TreeGift[]
 *     treeSlots:      number
 *     groundSlots:    number
 *     onOpen:         (publicId: string) => void
 *     focusPublicId?: string   // rotate this gift to front on mount (share link)
 *   }
 *
 * ─── LAYERS (bottom → top) ─────────────────────────────────────────────────
 *   z=0  sky image
 *   z=2  snow canvas
 *   z=3  ornament buttons with depth < 0 (behind tree)
 *   z=4  tree image
 *   z=5  ground layer image
 *   z=6  ornament buttons with depth ≥ 0 (in front of tree)
 *   z=7  ground box buttons
 *   z=8  star
 *
 * ─── NOTES ─────────────────────────────────────────────────────────────────
 *   - rAF loop writes only CSS `transform`, `opacity`, `z-index` (no layout thrash).
 *   - All gift elements are <button> so they receive native keyboard/focus.
 *   - `touch-action: pan-y` on the scene div allows vertical scroll while
 *     horizontal drag goes to the spin machine via pointer capture.
 *   - Visibility pause: rAF stops when document is hidden.
 *   - Reduced motion: no inertia, no intro spin; star is static.
 */

import {
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type ReactNode,
} from 'react'
import { slotLayout, type Slot } from './cone.ts'
import { createSpin } from './spin.ts'
import { startSnow } from './particles.ts'
import { animateStar, flashOrnament } from './timelines.ts'
import { DEFAULT_THEME_URLS, TREE_GEOMETRY } from './defaultTheme.ts'

// ─── Public types ──────────────────────────────────────────────────────────

export interface TreeGift {
  publicId: string
  rank: number
  place: 'tree' | 'ground'
  nickname: string
  className: string
  heartCount: number
  boxStyle: number      // 1..6
  ornamentStyle: number // 1..6
}

interface SceneProps {
  gifts: TreeGift[]
  treeSlots: number
  groundSlots: number
  onOpen: (publicId: string) => void
  focusPublicId?: string
}

// ─── Pure helper (exported for tests) ────────────────────────────────────────

/** Cached tree rect relative to the scene container. */
export interface TreeRect {
  x: number  // px from scene left
  y: number  // px from scene top
  w: number  // px
  h: number  // px
}

/**
 * Compute CSS transform + depth for a tree ornament slot.
 * Pure function: takes slot, phi, and tree rect; returns transform params.
 *
 * Uses TREE_GEOMETRY to map h (0=tip, 1=base) to y in tree-image pixels,
 * then scales to screen pixels using treeRect.w / imageW.
 */
export function ornamentTransform(
  slot: Slot,
  phi: number,
  treeRect: TreeRect,
  geo: typeof TREE_GEOMETRY,
): { tx: number; ty: number; scale: number; opacity: number; behind: boolean; depth: number } {
  const treeScale = treeRect.w / geo.imageW
  const angle = slot.theta + phi
  const depth = Math.cos(angle)

  // Cone radius: scales with foliage half-width at this height
  const r = geo.foliageHalfWidthAtBase * slot.h * treeScale
  const tx = treeRect.x + geo.tipX * treeScale + r * Math.sin(angle)

  // y: map h in [0,1] to tree image y between foliageTopY and foliageBaseY
  const yInImage = geo.foliageTopY + slot.h * (geo.foliageBaseY - geo.foliageTopY)
  const ty = treeRect.y + yInImage * treeScale

  // depth ∈ [-1,1] → t ∈ [0,1]; min opacity 0.35 so behind gifts remain visible
  const t = (1 + depth) / 2
  const scale = 0.5 + 0.5 * t
  const opacity = Math.max(0.35, 0.5 + 0.5 * t)

  return { tx, ty, scale, opacity, behind: depth < 0, depth }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function skyUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_THEME_URLS.sky_portrait
  return window.innerWidth > window.innerHeight
    ? DEFAULT_THEME_URLS.sky_landscape
    : DEFAULT_THEME_URLS.sky_portrait
}

// ─── Component ─────────────────────────────────────────────────────────────

export function Scene({ gifts, treeSlots, groundSlots: _gs, onOpen, focusPublicId }: SceneProps): ReactNode {
  const reduced = useMemo(() => prefersReducedMotion(), [])

  const sceneRef = useRef<HTMLDivElement>(null)
  const treeImgRef = useRef<HTMLImageElement>(null)
  const snowCanvasRef = useRef<HTMLCanvasElement>(null)
  const starRef = useRef<HTMLImageElement>(null)

  // Map publicId → DOM button element
  const ornRefsMap = useRef(new Map<string, HTMLButtonElement>())
  const boxRefsMap = useRef(new Map<string, HTMLButtonElement>())

  // Cached rects (updated by ResizeObserver, written to by layout reads in rAF)
  const treeRectRef = useRef<TreeRect | null>(null)

  // Spin machine (stable; reducedMotion baked in at creation)
  const spinRef = useRef(createSpin({ reducedMotion: reduced }))

  // Pointer capture state
  const dragRef = useRef<{ pointerId: number; lastX: number } | null>(null)

  // Slot layouts for tree gifts
  const slots = useMemo(() => slotLayout(treeSlots), [treeSlots])

  // Split gifts by place
  const treeGifts = useMemo(() => gifts.filter(g => g.place === 'tree'), [gifts])
  const groundGifts = useMemo(() => gifts.filter(g => g.place === 'ground'), [gifts])

  // Map publicId → slot for fast lookup in rAF
  const slotByPublicId = useMemo(() => {
    const m = new Map<string, Slot>()
    for (const g of treeGifts) {
      const s = slots[g.rank - 1]
      if (s) m.set(g.publicId, s)
    }
    return m
  }, [treeGifts, slots])

  // ── Tree rect tracking via ResizeObserver ──────────────────────────────

  useEffect(() => {
    const img = treeImgRef.current
    const scene = sceneRef.current
    if (!img || !scene) return

    const updateRect = () => {
      const treeR = img.getBoundingClientRect()
      const sceneR = scene.getBoundingClientRect()
      treeRectRef.current = {
        x: treeR.left - sceneR.left,
        y: treeR.top - sceneR.top,
        w: treeR.width,
        h: treeR.height,
      }
    }

    const ro = new ResizeObserver(updateRect)
    ro.observe(img)
    ro.observe(scene)
    if (img.complete) updateRect()
    img.addEventListener('load', updateRect)

    return () => {
      ro.disconnect()
      img.removeEventListener('load', updateRect)
    }
  }, [])

  // ── Ground box positioning via ResizeObserver on scene ─────────────────

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    const positionGround = () => {
      const sceneW = scene.clientWidth
      const sceneH = scene.clientHeight
      if (!sceneW || !sceneH) return

      const count = groundGifts.length
      if (count === 0) return

      // Position on the layer_ground: bottom 22% of scene height
      const groundY = sceneH * 0.78
      const margin = sceneW * 0.08
      const usable = sceneW - 2 * margin

      groundGifts.forEach((gift, i) => {
        const el = boxRefsMap.current.get(gift.publicId)
        if (!el) return
        const x = count === 1
          ? sceneW / 2
          : margin + (i / (count - 1)) * usable
        // Write as transform to avoid layout (left/top stay at 0)
        el.style.transform = `translate(${x}px,${groundY}px) translate(-50%,-100%)`
      })
    }

    const ro = new ResizeObserver(positionGround)
    ro.observe(scene)
    positionGround()

    return () => ro.disconnect()
  }, [groundGifts])

  // ── Snow canvas ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = snowCanvasRef.current
    if (!canvas) return
    return startSnow(canvas, 80)
  }, [])

  // ── Star twinkle ───────────────────────────────────────────────────────

  useEffect(() => {
    const star = starRef.current
    if (!star) return
    const anim = animateStar(star, reduced)
    return () => { try { anim.cancel() } catch (_) {} }
  }, [reduced])

  // ── Star position sync (uses same rAF tick) ────────────────────────────

  const updateStarPos = useCallback((treeRect: TreeRect) => {
    const star = starRef.current
    if (!star) return
    const scale = treeRect.w / TREE_GEOMETRY.imageW
    const sx = treeRect.x + TREE_GEOMETRY.tipX * scale
    const sy = treeRect.y + TREE_GEOMETRY.tipY * scale
    // Write transform only (star has position:absolute; left:0; top:0)
    star.style.transform = `translate(${sx}px,${sy}px) translate(-50%,-50%)`
  }, [])

  // ── rAF loop: spin physics + ornament DOM updates ─────────────────────

  useEffect(() => {
    // Intro auto-spin (a small velocity decays naturally over a few seconds)
    if (!reduced) {
      spinRef.current.state.velocity = 0.0007  // rad/ms
    }

    let raf = 0
    let prevT = 0
    let active = document.visibilityState !== 'hidden'

    const handleVisibility = () => {
      active = document.visibilityState !== 'hidden'
      if (active && raf === 0) {
        prevT = 0
        raf = requestAnimationFrame(loop)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    const loop = (t: number) => {
      raf = 0
      if (!active) return

      const dt = prevT > 0 ? Math.min(t - prevT, 50) : 16
      prevT = t

      spinRef.current.step(dt)
      const phi = spinRef.current.state.phi

      const treeRect = treeRectRef.current
      if (treeRect) {
        // Update all ornament buttons via transform only
        for (const [publicId, el] of ornRefsMap.current) {
          const slot = slotByPublicId.get(publicId)
          if (!slot) continue
          const { tx, ty, scale: s, opacity, behind } = ornamentTransform(
            slot, phi, treeRect, TREE_GEOMETRY,
          )
          el.style.transform = `translate(${tx}px,${ty}px) translate(-50%,-50%) scale(${s.toFixed(3)})`
          el.style.opacity = opacity.toFixed(3)
          el.style.zIndex = behind ? '3' : '6'
        }

        updateStarPos(treeRect)
      }

      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)

    return () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [slotByPublicId, updateStarPos, reduced])

  // ── focusPublicId: jump to front on mount ──────────────────────────────

  useEffect(() => {
    if (!focusPublicId) return
    const slot = slotByPublicId.get(focusPublicId)
    if (!slot) return
    const spin = spinRef.current
    spin.state.velocity = 0
    spin.state.phi = spin.targetFor(slot.theta)
  }, [focusPublicId, slotByPublicId])

  // ── Keyboard handler (capturing: intercepts arrow keys even in child buttons) ─

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { spinRef.current.key('left'); e.preventDefault() }
      else if (e.key === 'ArrowRight') { spinRef.current.key('right'); e.preventDefault() }
    }
    scene.addEventListener('keydown', onKey, true)
    return () => scene.removeEventListener('keydown', onKey, true)
  }, [])

  // ── Pointer handlers ───────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return
    const scene = sceneRef.current
    if (!scene) return
    try { scene.setPointerCapture(e.pointerId) } catch (_) { return }
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX }
    // Don't preventDefault: touch-action:pan-y CSS handles vertical scroll
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.lastX
    spinRef.current.drag(dx, e.timeStamp)
    drag.lastX = e.clientX
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    spinRef.current.release(e.timeStamp)
    dragRef.current = null
  }, [])

  // ── Gift activation (click / Enter) ───────────────────────────────────

  const handleGiftClick = useCallback((gift: TreeGift) => {
    const slot = slotByPublicId.get(gift.publicId)
    if (slot) {
      // Snap to front (velocity = 0, phi = target)
      spinRef.current.state.velocity = 0
      spinRef.current.state.phi = spinRef.current.targetFor(slot.theta)
      // Flash the button
      const el = ornRefsMap.current.get(gift.publicId)
      if (el) flashOrnament(el, reduced).catch(() => {})
    }
    onOpen(gift.publicId)
  }, [slotByPublicId, onOpen, reduced])

  // ── Render ─────────────────────────────────────────────────────────────

  const sky = skyUrl()

  return (
    <div
      ref={sceneRef}
      className="noel-scene"
      tabIndex={0}
      aria-label="Cây thông điều ước — dùng phím ← → để xoay"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* z=0 — sky */}
      <img
        src={sky}
        className="noel-sky"
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* z=2 — snow canvas */}
      <canvas
        ref={snowCanvasRef}
        className="noel-snow"
        aria-hidden="true"
      />

      {/* Ornament buttons: initially off-screen (left:-9999px via CSS);
          rAF loop writes transform and z-index each frame.
          z=3 (behind) or z=6 (front) — set dynamically. */}
      {treeGifts.map(gift => {
        const orn = `ornament_${gift.ornamentStyle}` as keyof typeof DEFAULT_THEME_URLS
        return (
          <button
            key={gift.publicId}
            ref={el => {
              if (el) ornRefsMap.current.set(gift.publicId, el)
              else ornRefsMap.current.delete(gift.publicId)
            }}
            className="noel-orn-btn"
            aria-label={`Quà của ${gift.nickname} · ${gift.className} · hạng ${gift.rank} · ${gift.heartCount} tim`}
            data-rank={String(gift.rank)}
            onClick={() => handleGiftClick(gift)}
          >
            <img
              src={DEFAULT_THEME_URLS[orn] ?? DEFAULT_THEME_URLS.ornament_1}
              alt=""
              aria-hidden="true"
              className="noel-orn-img"
              draggable={false}
            />
            {gift.rank <= 3 && (
              <span className="noel-orn-crown" aria-hidden="true">
                {gift.rank === 1 ? '👑' : gift.rank === 2 ? '🥈' : '🥉'}
              </span>
            )}
            <span className="noel-orn-hearts" aria-hidden="true">
              ❤️ {gift.heartCount}
            </span>
          </button>
        )
      })}

      {/* z=4 — tree image (ornaments behind it sit at z=3, in front at z=6) */}
      <img
        ref={treeImgRef}
        src={DEFAULT_THEME_URLS.tree}
        className="noel-tree-img"
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* z=5 — ground layer */}
      <img
        src={DEFAULT_THEME_URLS.layer_ground}
        className="noel-ground"
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* z=7 — ground boxes: positioned via ResizeObserver in a useEffect */}
      {groundGifts.map(gift => {
        const box = `box_${gift.boxStyle}_closed` as keyof typeof DEFAULT_THEME_URLS
        return (
          <button
            key={gift.publicId}
            ref={el => {
              if (el) boxRefsMap.current.set(gift.publicId, el)
              else boxRefsMap.current.delete(gift.publicId)
            }}
            className="noel-box-btn"
            aria-label={`Quà của ${gift.nickname} · ${gift.className} · hạng ${gift.rank} · ${gift.heartCount} tim`}
            onClick={() => onOpen(gift.publicId)}
          >
            <img
              src={DEFAULT_THEME_URLS[box] ?? DEFAULT_THEME_URLS.box_1_closed}
              alt=""
              aria-hidden="true"
              className="noel-box-img"
              draggable={false}
            />
            <span className="noel-orn-hearts" aria-hidden="true">
              ❤️ {gift.heartCount}
            </span>
          </button>
        )
      })}

      {/* z=8 — star: position written by rAF via updateStarPos */}
      <img
        ref={starRef}
        src={DEFAULT_THEME_URLS.star}
        className="noel-star"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    </div>
  )
}

// ─── ScenePreview (dev-only) ──────────────────────────────────────────────────

/**
 * Dev-only preview of the Scene with 25 synthetic gifts.
 * Not wired to any route. Used during development to visually verify the scene
 * before the flows task adds real data.
 */
export function ScenePreview(): ReactNode {
  const fakeGifts: TreeGift[] = Array.from({ length: 25 }, (_, i) => ({
    publicId: `preview-${i + 1}`,
    rank: i + 1,
    place: i < 15 ? 'tree' : 'ground',
    nickname: `HS ${i + 1}`,
    className: `11A${(i % 5) + 1}`,
    heartCount: Math.max(0, (25 - i) * 3),
    boxStyle: ((i % 6) + 1) as TreeGift['boxStyle'],
    ornamentStyle: (((i + 2) % 6) + 1) as TreeGift['ornamentStyle'],
  }))

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#060d1f', zIndex: 0 }}>
      <Scene
        gifts={fakeGifts}
        treeSlots={15}
        groundSlots={10}
        onOpen={(id) => { /* eslint-disable-next-line no-console */ console.log('[ScenePreview] open:', id) }}
      />
    </div>
  )
}

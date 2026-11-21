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
 *   z=7+ ground box buttons (row 0=9, row 1=8, row 2=7)
 *   z=8  star wrapper
 *
 * ─── LAYOUT APPROACH ───────────────────────────────────────────────────────
 *   All pixel dimensions are computed by computeSceneLayout() (layout.ts)
 *   and applied via inline style in a ResizeObserver callback — no CSS
 *   height/width on the tree or box elements.  The ground layer uses
 *   height: 22% / min-width: 104% (matches the approved mockup proportions).
 *
 * ─── STAR POSITION FIX ─────────────────────────────────────────────────────
 *   The star is split into two elements:
 *     - .noel-star-wrap (div): position updated by layout effect (not rAF)
 *     - .noel-star-img (img): WAAPI twinkle animation (scale/filter only)
 *   This prevents the WAAPI `transform` from clobbering the positioning
 *   transform that sits on the wrapper.
 *
 * ─── NOTES ─────────────────────────────────────────────────────────────────
 *   - rAF loop writes only CSS `transform`, `opacity`, `z-index` on ornaments.
 *   - All gift elements are <button> so they receive native keyboard/focus.
 *   - `touch-action: pan-y` on the scene div allows vertical scroll while
 *     horizontal drag goes to the spin machine via pointer capture.
 *   - Visibility pause: rAF stops when document is hidden.
 *   - Reduced motion: no inertia, no intro spin; star is static.
 *   - Intro spin and focusPublicId snap run once (gift→slot map in a ref).
 *   - Behind-tree ornaments: pointer-events:none + tabIndex=-1 so they are
 *     not reachable while they are hidden.
 *   - Tap-vs-drag: pointer is captured only after the DRAG_THRESHOLD (~6px);
 *     click after a drag is suppressed.
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
import { computeSceneLayout, type SceneLayout } from './layout.ts'
import {
  createGestureState,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  clearClickSuppression,
  type GestureState,
} from './gesture.ts'

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

  const sceneRef      = useRef<HTMLDivElement>(null)
  const treeImgRef    = useRef<HTMLImageElement>(null)
  const snowCanvasRef = useRef<HTMLCanvasElement>(null)

  // Star: wrapper handles position; inner img handles WAAPI animation
  const starWrapRef = useRef<HTMLDivElement>(null)
  const starImgRef  = useRef<HTMLImageElement>(null)

  // Map publicId → DOM button element
  const ornRefsMap = useRef(new Map<string, HTMLButtonElement>())
  const boxRefsMap = useRef(new Map<string, HTMLButtonElement>())

  // Layout computed by ResizeObserver; consumed by rAF loop and event handlers
  const layoutRef = useRef<SceneLayout | null>(null)

  // Keep treeRectRef in sync with layout (consumed by ornamentTransform in rAF)
  const treeRectRef = useRef<TreeRect | null>(null)

  // Spin machine (stable; reducedMotion baked in at creation)
  const spinRef = useRef(createSpin({ reducedMotion: reduced }))

  // Gesture state (tap-vs-drag, capture-after-threshold, suppress click)
  const gestureRef = useRef<GestureState>(createGestureState())

  // Slot layouts for tree gifts
  const slots = useMemo(() => slotLayout(treeSlots), [treeSlots])

  // Split gifts by place
  const treeGifts   = useMemo(() => gifts.filter(g => g.place === 'tree'),   [gifts])
  const groundGifts = useMemo(() => gifts.filter(g => g.place === 'ground'), [gifts])

  // Stable ref for slot lookup consumed by the rAF loop and focusPublicId snap.
  // Updated in a separate effect so the rAF loop and the snap effect do NOT need
  // slotByPublicId in their dep arrays — prevents intro re-spin and re-snap on
  // every poll cycle when gifts change.
  const slotByPublicIdRef = useRef(new Map<string, Slot>())
  useEffect(() => {
    const m = new Map<string, Slot>()
    for (const g of treeGifts) {
      const s = slots[g.rank - 1]
      if (s) m.set(g.publicId, s)
    }
    slotByPublicIdRef.current = m
  }, [treeGifts, slots])

  // ── Layout: tree rect + star + boxes + ornament sizes ─────────────────────

  useEffect(() => {
    const scene   = sceneRef.current
    const treeImg = treeImgRef.current
    if (!scene || !treeImg) return

    const applyLayout = () => {
      const sceneW = scene.clientWidth
      const sceneH = scene.clientHeight
      if (!sceneW || !sceneH) return

      const layout = computeSceneLayout(sceneW, sceneH, groundGifts.length)
      layoutRef.current  = layout
      treeRectRef.current = layout.treeRect

      treeImg.style.left   = `${layout.treeRect.x}px`
      treeImg.style.top    = `${layout.treeRect.y}px`
      treeImg.style.width  = `${layout.treeRect.w}px`
      treeImg.style.height = `${layout.treeRect.h}px`

      const starWrap = starWrapRef.current
      if (starWrap) {
        starWrap.style.width     = `${layout.starSize}px`
        starWrap.style.height    = `${layout.starSize}px`
        starWrap.style.transform =
          `translate(${layout.starCenter.x}px, ${layout.starCenter.y}px) translate(-50%, -50%)`
      }

      const ornSize = layout.ornamentSize
      for (const [, el] of ornRefsMap.current) {
        el.style.width  = `${ornSize}px`
        el.style.height = `${ornSize}px`
      }

      const giftsPerRow = Math.ceil(groundGifts.length / (groundGifts.length <= 7 ? 2 : 3))
      groundGifts.forEach((gift, i) => {
        const el  = boxRefsMap.current.get(gift.publicId)
        if (!el) return
        const pos = layout.boxPositions[i]
        if (!pos) return
        el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`
        el.style.width     = `${pos.size}px`
        el.style.height    = `${pos.size}px`
        el.style.zIndex    = String(9 - Math.floor(i / giftsPerRow))
      })
    }

    const ro = new ResizeObserver(applyLayout)
    ro.observe(scene)
    applyLayout()

    return () => ro.disconnect()
  }, [groundGifts])

  // ── Snow canvas ────────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = snowCanvasRef.current
    if (!canvas) return
    return startSnow(canvas, 80)
  }, [])

  // ── Star twinkle (WAAPI on inner img only) ─────────────────────────────

  useEffect(() => {
    const starImg = starImgRef.current
    if (!starImg) return
    const anim = animateStar(starImg, reduced)
    return () => { try { anim.cancel() } catch (_) {} }
  }, [reduced])

  // ── rAF loop: spin physics + ornament DOM updates ─────────────────────
  // Dependencies: [reduced] only.
  // The loop reads slotByPublicIdRef.current each frame so it always uses the
  // latest slot map without needing it in the dep array (avoids intro re-spin).

  useEffect(() => {
    // Intro auto-spin runs once — guard so it doesn't repeat on data changes.
    if (!reduced) {
      spinRef.current.state.velocity = 0.0007  // rad/ms; decays naturally
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
        for (const [publicId, el] of ornRefsMap.current) {
          const slot = slotByPublicIdRef.current.get(publicId)
          if (!slot) continue
          const { tx, ty, scale: s, opacity, behind } = ornamentTransform(
            slot, phi, treeRect, TREE_GEOMETRY,
          )
          el.style.transform     = `translate(${tx}px,${ty}px) translate(-50%,-50%) scale(${s.toFixed(3)})`
          el.style.opacity       = opacity.toFixed(3)
          el.style.zIndex        = behind ? '3' : '6'
          // Behind-tree ornaments: not tappable and not in tab order
          el.style.pointerEvents = behind ? 'none' : ''
          el.tabIndex            = behind ? -1 : 0
        }
      }

      raf = requestAnimationFrame(loop)
    }

    raf = requestAnimationFrame(loop)

    return () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0 }
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [reduced])  // slotByPublicId consumed via ref — not in deps

  // ── focusPublicId: rotate to front ONCE on mount ───────────────────────
  // Dep: [focusPublicId] only — slotByPublicIdRef read via ref so slot-map
  // updates (from polls) don't re-trigger the snap.

  useEffect(() => {
    if (!focusPublicId) return
    const slot = slotByPublicIdRef.current.get(focusPublicId)
    if (!slot) return
    const spin = spinRef.current
    spin.state.velocity = 0
    spin.state.phi = spin.targetFor(slot.theta)
  }, [focusPublicId])

  // ── Keyboard handler ───────────────────────────────────────────────────

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const onKey = (e: KeyboardEvent) => {
      // Ignore modified arrows (Alt/Meta/Ctrl) — they may be browser/OS shortcuts
      if (e.altKey || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowLeft')       { spinRef.current.key('left');  e.preventDefault() }
      else if (e.key === 'ArrowRight') { spinRef.current.key('right'); e.preventDefault() }
    }
    scene.addEventListener('keydown', onKey, true)
    return () => scene.removeEventListener('keydown', onKey, true)
  }, [])

  // ── Pointer handlers (tap-vs-drag via gesture.ts) ─────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return
    // Zero velocity on grab so there's no coasting from a previous swipe
    spinRef.current.state.velocity = 0
    gestureRef.current = onPointerDown(gestureRef.current, e.clientX, e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current
    if (g.pointerId !== e.pointerId) return
    const { state, shouldCapture, dx } = onPointerMove(g, e.clientX)
    gestureRef.current = state
    if (shouldCapture) {
      // First frame past threshold: capture pointer so the scene owns the drag
      try { sceneRef.current?.setPointerCapture(e.pointerId) } catch (_) { return }
    }
    if (dx !== null) {
      spinRef.current.drag(dx, e.timeStamp)
    }
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const g = gestureRef.current
    if (g.pointerId !== e.pointerId) return
    const { state } = onPointerUp(g)
    gestureRef.current = state
    spinRef.current.release(e.timeStamp)
  }, [])

  // ── Gift activation (click / Enter) ───────────────────────────────────

  const handleGiftClick = useCallback((gift: TreeGift) => {
    // Suppress click that follows a drag (pointer-capture synthesises a click)
    if (gestureRef.current.suppressClick) {
      gestureRef.current = clearClickSuppression(gestureRef.current)
      return
    }
    const slot = slotByPublicIdRef.current.get(gift.publicId)
    if (slot) {
      spinRef.current.state.velocity = 0
      spinRef.current.state.phi = spinRef.current.targetFor(slot.theta)
      const el = ornRefsMap.current.get(gift.publicId)
      if (el) flashOrnament(el, reduced).catch(() => {})
    }
    onOpen(gift.publicId)
  }, [onOpen, reduced])

  // Rotate to front when an ornament button gains keyboard focus
  const handleOrnamentFocus = useCallback((gift: TreeGift) => {
    const slot = slotByPublicIdRef.current.get(gift.publicId)
    if (!slot) return
    spinRef.current.state.velocity = 0
    spinRef.current.state.phi = spinRef.current.targetFor(slot.theta)
  }, [])

  // ── Ref callbacks: apply current layout to newly mounted elements ──────

  const makeOrnRef = useCallback((gift: TreeGift) => (el: HTMLButtonElement | null) => {
    if (el) {
      ornRefsMap.current.set(gift.publicId, el)
      const layout = layoutRef.current
      if (layout) {
        el.style.width  = `${layout.ornamentSize}px`
        el.style.height = `${layout.ornamentSize}px`
      }
    } else {
      ornRefsMap.current.delete(gift.publicId)
    }
  }, [])

  const makeBoxRef = useCallback((gift: TreeGift, idx: number) => (el: HTMLButtonElement | null) => {
    if (el) {
      boxRefsMap.current.set(gift.publicId, el)
      const layout = layoutRef.current
      if (layout) {
        const pos = layout.boxPositions[idx]
        if (pos) {
          el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`
          el.style.width     = `${pos.size}px`
          el.style.height    = `${pos.size}px`
        }
      }
    } else {
      boxRefsMap.current.delete(gift.publicId)
    }
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────

  const sky = skyUrl()

  return (
    <div
      ref={sceneRef}
      className="noel-scene"
      role="group"
      aria-label="Cây thông điều ước — dùng phím ← → để xoay"
      tabIndex={0}
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
          rAF loop writes transform, z-index, pointer-events and tabIndex each frame.
          z=3 (behind) or z=6 (front) — set dynamically.
          Behind ornaments: pointer-events:none, tabIndex=-1 (not tappable/focusable). */}
      {treeGifts.map(gift => {
        const orn = `ornament_${gift.ornamentStyle}` as keyof typeof DEFAULT_THEME_URLS
        return (
          <button
            key={gift.publicId}
            ref={makeOrnRef(gift)}
            className="noel-orn-btn"
            data-public-id={gift.publicId}
            aria-label={`Quà của ${gift.nickname} · ${gift.className} · hạng ${gift.rank} · ${gift.heartCount} tim`}
            data-rank={String(gift.rank)}
            onClick={() => handleGiftClick(gift)}
            onFocus={() => handleOrnamentFocus(gift)}
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

      {/* z=4 — tree image: left/top/width/height set by JS layout */}
      <img
        ref={treeImgRef}
        src={DEFAULT_THEME_URLS.tree}
        className="noel-tree-img"
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* z=5 — ground layer: height 22% of scene; min-width 104%; obj-fit cover */}
      <img
        src={DEFAULT_THEME_URLS.layer_ground}
        className="noel-ground"
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* z=7+ — ground boxes: positioned via layout effect (bottom-centre anchor) */}
      {groundGifts.map((gift, i) => {
        const box = `box_${gift.boxStyle}_closed` as keyof typeof DEFAULT_THEME_URLS
        return (
          <button
            key={gift.publicId}
            ref={makeBoxRef(gift, i)}
            className="noel-box-btn"
            data-public-id={gift.publicId}
            aria-label={`Quà của ${gift.nickname} · ${gift.className} · hạng ${gift.rank} · ${gift.heartCount} tim`}
            onClick={() => {
              if (gestureRef.current.suppressClick) {
                gestureRef.current = clearClickSuppression(gestureRef.current)
                return
              }
              onOpen(gift.publicId)
            }}
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

      {/* z=8 — star wrapper (position) + inner img (WAAPI twinkle).
          The split prevents WAAPI transform from clobbering the position transform. */}
      <div
        ref={starWrapRef}
        className="noel-star-wrap"
        aria-hidden="true"
      >
        <img
          ref={starImgRef}
          src={DEFAULT_THEME_URLS.star}
          className="noel-star-img"
          alt=""
          draggable={false}
        />
      </div>
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

/**
 * NoelPage — the Noel "Cây Thông Điều Ước" gift-tree game page.
 *
 * Rendered at /:slug (kind=gift_tree) and /:slug/g/:publicId (share link).
 * Covers the full viewport (position:fixed, z-index:50) overlaying the global App header.
 *
 * Layout (bottom → top):
 *   Scene  — fills the whole screen
 *   Header — campaign name + sign-in button or user menu
 *   Hearts indicator (top-right, visible when signed in)
 *   Action bar — Treo quà / Bảng xếp hạng / Tất cả quà (closed state: hidden)
 *
 * Polling (ADR-7):
 *   GET /api/campaigns/<slug>/tree polled with nextPollDelay only while visible.
 *   Backoff: 1.5× per consecutive failure, capped at 120 s.
 *   Local heart override (mergeHeart) keeps optimistic counts until a later server
 *   response confirms (server.asOf > local.asOf && server.count >= local.count).
 *
 * Closed state (FR-28, AC-3):
 *   When campaign.open is false, the action bar is hidden and "Chiến dịch đã kết thúc"
 *   is shown as a banner.  The tree remains viewable.
 *
 * Part B extension points (render "Sắp có" dialog for now):
 *   handleCreateGift, handleLeaderboard, handleAllGifts
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Scene, type TreeGift } from './Scene.tsx'
import { nextPollDelay, mergeHeart, type HeartState } from './poll.ts'
import {
  getNoelTree,
  getMeForCampaign,
  heartGift,
  reportGift,
  getCampaign,
  getNoelTemplates,
  type NoelTemplate,
  type NoelGift,
  type NoelTreeData,
  type MeUser,
  type ReportReason,
} from '../api.ts'
import { isInAppBrowser } from '../campaign/inAppBrowser.ts'

// GiftSheet is lazy to avoid loading CardView + timelines on first tree render
const GiftSheet = lazy(() => import('./GiftSheet.tsx'))

// GoogleSignIn is lazy to avoid loading GSI logic until actually needed
const GoogleSignIn = lazy(() => import('../auth/GoogleSignIn.tsx'))

// ── Props ─────────────────────────────────────────────────────────────────────

interface NoelPageProps {
  slug: string
  /** Set by the share-link route (/:slug/g/:publicId): opens that gift on mount. */
  focusPublicId?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTreeGift(g: NoelGift): TreeGift {
  return {
    publicId: g.publicId,
    rank: g.rank,
    place: g.place,
    nickname: g.nickname,
    className: g.className,
    heartCount: g.heartCount,
    boxStyle: g.boxStyle,
    ornamentStyle: g.ornamentStyle,
  }
}

/** Returns a gift with its heartCount overridden if a local heart is still pending. */
function applyOverride(gift: NoelGift, overrides: Map<string, HeartState>, serverAsOf: number): NoelGift {
  const local = overrides.get(gift.publicId)
  if (!local) return gift
  const merged = mergeHeart(local, { asOf: serverAsOf, count: gift.heartCount })
  if (merged.count === gift.heartCount) return gift
  return { ...gift, heartCount: merged.count }
}

// ── NoelPage component ────────────────────────────────────────────────────────

export default function NoelPage({ slug, focusPublicId }: NoelPageProps): ReactNode {
  // Campaign metadata
  const [campaignName, setCampaignName] = useState('Cây Thông Điều Ước')
  const [campaignOpen, setCampaignOpen] = useState(true)
  const [treeSlots, setTreeSlots] = useState(15)
  const [groundSlots, setGroundSlots] = useState(10)

  // Card backgrounds of this campaign (loaded once; gifts reference them by template id)
  const [templates, setTemplates] = useState<NoelTemplate[]>([])
  useEffect(() => {
    let alive = true
    getNoelTemplates(slug).then((t) => { if (alive) setTemplates(t) }).catch(() => { /* cards render without a background */ })
    return () => { alive = false }
  }, [slug])

  // Tree data (from polling)
  const [treeData, setTreeData] = useState<NoelTreeData | null>(null)

  // Per-user state (from /api/me?campaign=)
  const [user, setUser] = useState<MeUser | null>(null)
  const [heartsLeft, setHeartsLeft] = useState(5)
  const [heartedIds, setHeartedIds] = useState<Set<string>>(new Set())
  const [myPublicIds] = useState<Set<string>>(new Set()) // Part B: filled by my-gifts API

  // Optimistic heart overrides (publicId → HeartState), ADR-7
  const [localOverrides, setLocalOverrides] = useState<Map<string, HeartState>>(new Map())

  // Open gift ID (null = sheet closed)
  const [openGiftId, setOpenGiftId] = useState<string | null>(focusPublicId ?? null)

  // Sign-in dialog
  const [signInVisible, setSignInVisible] = useState(false)

  // Action bar "sắp có" dialog (Part B placeholder)
  const [comingSoon, setComingSoon] = useState<string | null>(null)

  // ── Fetch campaign metadata ─────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    getCampaign(slug)
      .then((c) => {
        if (!alive) return
        setCampaignName(c.name || 'Cây Thông Điều Ước')
        setCampaignOpen(!!c.open)
        // settings is unknown; extract safely
        const s = c.settings as Record<string, unknown> | null
        if (s && typeof s === 'object') {
          if (typeof s['tree_slots'] === 'number') setTreeSlots(s['tree_slots'])
          if (typeof s['ground_slots'] === 'number') setGroundSlots(s['ground_slots'])
        }
      })
      .catch(() => { /* use defaults */ })
    return () => { alive = false }
  }, [slug])

  // ── Fetch me (per-campaign state) ────────────────────────────────────────
  const refreshMe = useCallback(async () => {
    const me = await getMeForCampaign(slug)
    setUser(me.user)
    setHeartsLeft(me.heartsLeft)
    setHeartedIds(new Set(me.heartedGiftIds))
  }, [slug])

  useEffect(() => {
    refreshMe().catch(() => { /* anonymous defaults stay */ })
  }, [refreshMe])

  // ── Poll tree while visible (ADR-7) ──────────────────────────────────────
  useEffect(() => {
    let alive = true
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const doPoll = async () => {
      if (!alive || document.visibilityState === 'hidden') return
      try {
        const data = await getNoelTree(slug)
        if (!alive) return
        failures = 0
        const serverAsOf = Date.parse(data.asOf)
        // Drop confirmed overrides (server has a later asOf with count ≥ local)
        setLocalOverrides((prev) => {
          if (prev.size === 0) return prev
          const next = new Map(prev)
          for (const [pid, local] of next) {
            const serverGift = data.gifts.find((g) => g.publicId === pid)
            if (!serverGift) continue
            const merged = mergeHeart(local, { asOf: serverAsOf, count: serverGift.heartCount })
            if (merged === local) {
              // local still wins: keep it
            } else {
              // server confirmed: remove override
              next.delete(pid)
            }
          }
          return next.size === prev.size && [...next.entries()].every(([k, v]) => prev.get(k) === v)
            ? prev  // no change → same reference
            : next
        })
        setTreeData(data)
      } catch {
        if (!alive) return
        failures = Math.min(failures + 1, 10)  // cap to prevent infinite growth
      }
      if (!alive) return
      const delay = nextPollDelay(() => Math.random(), failures)
      timer = setTimeout(() => { doPoll().catch(() => {}) }, delay)
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) { clearTimeout(timer); timer = null }
        doPoll().catch(() => {})
      }
    }

    doPoll().catch(() => {})
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [slug])

  // ── Merged gifts: apply local heart overrides (ADR-7) ───────────────────
  const mergedGifts = useMemo<NoelGift[]>(() => {
    if (!treeData) return []
    if (localOverrides.size === 0) return treeData.gifts
    const serverAsOf = Date.parse(treeData.asOf)
    return treeData.gifts.map((g) => applyOverride(g, localOverrides, serverAsOf))
  }, [treeData, localOverrides])

  const sceneGifts = useMemo<TreeGift[]>(() => mergedGifts.map(toTreeGift), [mergedGifts])

  // ── Open / close gift sheet ───────────────────────────────────────────────
  const handleOpen = useCallback((publicId: string) => setOpenGiftId(publicId), [])
  const handleClose = useCallback(() => setOpenGiftId(null), [])
  const handleNavigate = useCallback((publicId: string) => setOpenGiftId(publicId), [])

  const openGift = useMemo(
    () => mergedGifts.find((g) => g.publicId === openGiftId),
    [mergedGifts, openGiftId],
  )

  // ── Heart handler ─────────────────────────────────────────────────────────
  const handleHeart = useCallback(async (publicId: string): Promise<void> => {
    const result = await heartGift(publicId)
    setHeartsLeft(result.heartsLeft)
    setHeartedIds((prev) => new Set([...prev, publicId]))
    setLocalOverrides((prev) => new Map([...prev, [publicId, { asOf: Date.now(), count: result.heartCount }]]))
  }, [])

  // ── Report handler ────────────────────────────────────────────────────────
  const handleReport = useCallback(async (publicId: string, reason: ReportReason): Promise<void> => {
    await reportGift(publicId, reason)
  }, [])

  // ── Sign-in ───────────────────────────────────────────────────────────────
  const handleSignIn = useCallback(() => setSignInVisible(true), [])

  // ── Action bar callbacks (Part B extension points) ────────────────────────
  const handleCreateGift   = useCallback(() => setComingSoon('Treo quà'), [])
  const handleLeaderboard  = useCallback(() => setComingSoon('Bảng xếp hạng'), [])
  const handleAllGifts     = useCallback(() => setComingSoon('Tất cả quà'), [])

  // ── in-app browser detection ──────────────────────────────────────────────
  const isInApp = typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="noel-page">
      {/* ── Scene (fills full page) */}
      <Scene
        gifts={sceneGifts}
        treeSlots={treeSlots}
        groundSlots={groundSlots}
        onOpen={handleOpen}
        focusPublicId={focusPublicId}
      />

      {/* ── Header */}
      <header className="noel-page-header">
        <span className="noel-page-title">{campaignName}</span>
        <div className="noel-page-header-right">
          {user ? (
            <div className="noel-page-user-menu">
              {/* Part B: add dropdown with "Quà của tôi" and "Đăng xuất" */}
              <span className="noel-page-user-name">{user.nickname || 'Tôi'}</span>
            </div>
          ) : isInApp ? (
            <span className="noel-page-inapp-note">Mở bằng Chrome/Safari</span>
          ) : (
            <button
              type="button"
              className="noel-page-signin-btn"
              onClick={handleSignIn}
            >
              Đăng nhập
            </button>
          )}
        </div>
      </header>

      {/* ── Hearts left indicator */}
      {user && (
        <div
          className="noel-page-hearts"
          aria-label={`Còn ${heartsLeft} tim hôm nay`}
        >
          ❤️ ×{heartsLeft}
        </div>
      )}

      {/* ── Action bar (hidden when campaign is closed) */}
      {campaignOpen ? (
        <div
          className="noel-page-actions"
          role="toolbar"
          aria-label="Hành động chiến dịch"
        >
          <button type="button" className="noel-page-action-btn" onClick={handleCreateGift}>
            🎁 Treo quà
          </button>
          <button type="button" className="noel-page-action-btn" onClick={handleLeaderboard}>
            🏆 Bảng xếp hạng
          </button>
          <button type="button" className="noel-page-action-btn" onClick={handleAllGifts}>
            🎄 Tất cả quà
          </button>
        </div>
      ) : (
        <div className="noel-page-closed-banner" role="status">
          Chiến dịch đã kết thúc
        </div>
      )}

      {/* ── Gift Sheet */}
      {openGift && (
        <Suspense fallback={null}>
          <GiftSheet
            gift={openGift}
            allGifts={mergedGifts as Parameters<typeof GiftSheet>[0]['allGifts']}
            slug={slug}
            campaignName={campaignName}
            campaignOpen={campaignOpen}
            user={user}
            heartsLeft={heartsLeft}
            heartedPublicIds={heartedIds}
            myPublicIds={myPublicIds}
            onNavigate={handleNavigate}
            onClose={handleClose}
            onHeart={handleHeart}
            onReport={handleReport}
            onSignIn={handleSignIn}
            templates={templates}
          />
        </Suspense>
      )}

      {/* ── Sign-in dialog */}
      {signInVisible && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Đăng nhập"
          className="noel-signin-backdrop"
          onClick={() => setSignInVisible(false)}
        >
          <div
            className="noel-signin-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="noel-signin-header">
              <h2>Đăng nhập để thả tim</h2>
              <button
                type="button"
                aria-label="Đóng"
                onClick={() => setSignInVisible(false)}
              >
                ✕
              </button>
            </div>
            <Suspense fallback={<p className="admin-loading">Đang tải…</p>}>
              <GoogleSignIn
                onSignedIn={() => {
                  setSignInVisible(false)
                  refreshMe().catch(() => {})
                }}
              />
            </Suspense>
          </div>
        </div>
      )}

      {/* ── "Sắp có" dialog — Part B placeholder */}
      {comingSoon && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${comingSoon} — sắp có`}
          className="noel-coming-soon-backdrop"
          onClick={() => setComingSoon(null)}
        >
          <div
            className="noel-coming-soon-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="noel-coming-soon-text">🌟 {comingSoon} — Sắp có!</p>
            <button type="button" onClick={() => setComingSoon(null)}>
              Đóng
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

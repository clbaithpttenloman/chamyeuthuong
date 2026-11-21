/**
 * NoelPage — the Noel "Cây Thông Điều Ước" gift-tree game page.
 *
 * Rendered at /:slug (kind=gift_tree) and /:slug/g/:publicId (share link).
 * Covers the full viewport (position:fixed, z-index:50) overlaying the global App header.
 *
 * Layout (bottom → top):
 *   Scene  — fills the whole screen
 *   Header — campaign name + sign-in button or user menu dropdown
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
 * Part B: CreateGift, Leaderboard, AllGifts, MyGifts dialogs wired.
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Scene, type TreeGift } from './Scene.tsx'
import { nextPollDelay, mergeHeart, type HeartState } from './poll.ts'
import {
  getNoelTree,
  getMeForCampaign,
  getMyGifts,
  heartGift,
  reportGift,
  getCampaign,
  getNoelTemplates,
  getGiftByPublicId,
  logout,
  type NoelTemplate,
  type NoelGift,
  type NoelGiftFlat,
  type NoelTreeData,
  type MeUser,
  type ReportReason,
} from '../api.ts'
import { isInAppBrowser } from '../campaign/inAppBrowser.ts'

// GiftSheet is lazy to avoid loading CardView + timelines on first tree render
const GiftSheet = lazy(() => import('./GiftSheet.tsx'))
// GoogleSignIn is lazy to avoid loading GSI logic until actually needed
const GoogleSignIn = lazy(() => import('../auth/GoogleSignIn.tsx'))
// Game dialogs — lazy to avoid loading them on initial tree render
const CreateGift = lazy(() => import('./CreateGift.tsx'))
const Leaderboard = lazy(() => import('./Leaderboard.tsx'))
const AllGifts = lazy(() => import('./AllGifts.tsx'))
const MyGifts = lazy(() => import('./MyGifts.tsx'))

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

/** Converts a NoelGiftFlat (no rank/place) to a NoelGift with rank=0 for solo display. */
function flatToNoelGift(g: NoelGiftFlat): NoelGift {
  return { ...g, rank: 0, place: 'ground' }
}

// ── NoelPage component ────────────────────────────────────────────────────────

export default function NoelPage({ slug, focusPublicId }: NoelPageProps): ReactNode {
  // Campaign metadata
  const [campaignName, setCampaignName] = useState('Cây Thông Điều Ước')
  const [campaignOpen, setCampaignOpen] = useState(true)
  const [treeSlots, setTreeSlots] = useState(15)
  const [groundSlots, setGroundSlots] = useState(10)
  const [giftsPerUser, setGiftsPerUser] = useState(3)

  // Card backgrounds of this campaign (loaded once; gifts reference them by template id)
  const [templates, setTemplates] = useState<NoelTemplate[]>([])
  useEffect(() => {
    let alive = true
    getNoelTemplates(slug).then((t) => { if (alive) setTemplates(t) }).catch(() => { /* cards render without a background */ })
    return () => { alive = false }
  }, [slug])

  // Tree data (from polling)
  const [treeData, setTreeData] = useState<NoelTreeData | null>(null)

  // Per-user state
  const [user, setUser] = useState<MeUser | null>(null)
  const [heartsLeft, setHeartsLeft] = useState(5)
  const [heartedIds, setHeartedIds] = useState<Set<string>>(new Set())

  // My gifts (loaded after sign-in and after create/delete)
  const [myGifts, setMyGifts] = useState<Array<NoelGift & { status: string }>>([])

  /** All public IDs of non-deleted gifts belonging to the signed-in user. */
  const myPublicIds = useMemo(
    () => new Set(myGifts.filter((g) => g.status !== 'deleted').map((g) => g.publicId)),
    [myGifts],
  )

  const myGiftCount = useMemo(
    () => myGifts.filter((g) => g.status !== 'deleted').length,
    [myGifts],
  )

  // Optimistic heart overrides (publicId → HeartState), ADR-7
  const [localOverrides, setLocalOverrides] = useState<Map<string, HeartState>>(new Map())

  // Open gift ID (null = sheet closed)
  const [openGiftId, setOpenGiftId] = useState<string | null>(focusPublicId ?? null)

  // Solo gift: for gifts opened from AllGifts/Leaderboard that aren't in the tree
  const [soloGift, setSoloGift] = useState<NoelGift | null>(null)

  // Sign-in dialog
  const [signInVisible, setSignInVisible] = useState(false)

  // Dialog states for Part B flows
  const [showCreateGift, setShowCreateGift] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [showAllGifts, setShowAllGifts] = useState(false)
  const [showMyGifts, setShowMyGifts] = useState(false)

  // User menu dropdown
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // ── Fetch campaign metadata ─────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    getCampaign(slug)
      .then((c) => {
        if (!alive) return
        setCampaignName(c.name || 'Cây Thông Điều Ước')
        setCampaignOpen(!!c.open)
        const s = c.settings as Record<string, unknown> | null
        if (s && typeof s === 'object') {
          if (typeof s['tree_slots'] === 'number') setTreeSlots(s['tree_slots'])
          if (typeof s['ground_slots'] === 'number') setGroundSlots(s['ground_slots'])
          if (typeof s['gifts_per_user'] === 'number') setGiftsPerUser(s['gifts_per_user'])
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

  // ── Load my gifts ─────────────────────────────────────────────────────────
  const refreshMyGifts = useCallback(async () => {
    if (!user) return
    const list = await getMyGifts(slug)
    setMyGifts(list)
  }, [slug, user])

  useEffect(() => {
    if (user) {
      refreshMyGifts().catch(() => {})
    } else {
      setMyGifts([])
    }
  }, [refreshMyGifts, user])

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
              next.delete(pid)
            }
          }
          return next.size === prev.size && [...next.entries()].every(([k, v]) => prev.get(k) === v)
            ? prev
            : next
        })
        setTreeData(data)
      } catch {
        if (!alive) return
        failures = Math.min(failures + 1, 10)
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
  const handleOpen = useCallback((publicId: string) => {
    setSoloGift(null)
    setOpenGiftId(publicId)
  }, [])

  const handleClose = useCallback(() => {
    setOpenGiftId(null)
    setSoloGift(null)
  }, [])

  const handleNavigate = useCallback((publicId: string) => {
    setSoloGift(null)
    setOpenGiftId(publicId)
  }, [])

  // ── Open gift from external sources (AllGifts / Leaderboard) ────────────
  const handleOpenExternalGift = useCallback(
    (publicId: string) => {
      setShowLeaderboard(false)
      setShowAllGifts(false)
      setSoloGift(null)
      setOpenGiftId(publicId)
    },
    [],
  )

  // If openGiftId is set but not in mergedGifts, fetch the gift individually
  useEffect(() => {
    if (!openGiftId) { setSoloGift(null); return }
    if (mergedGifts.some((g) => g.publicId === openGiftId)) {
      setSoloGift(null)
      return
    }
    // Gift not in tree — fetch it individually
    let alive = true
    getGiftByPublicId(openGiftId)
      .then((g: NoelGiftFlat) => {
        if (alive) setSoloGift(flatToNoelGift(g))
      })
      .catch(() => {
        // Gift unavailable (hidden/deleted) — close the sheet
        if (alive) setOpenGiftId(null)
      })
    return () => { alive = false }
  }, [openGiftId, mergedGifts])

  const openGift = useMemo(
    () =>
      mergedGifts.find((g) => g.publicId === openGiftId) ??
      (soloGift?.publicId === openGiftId ? soloGift : undefined),
    [mergedGifts, openGiftId, soloGift],
  )

  // The allGifts list for GiftSheet navigation:
  // If the opened gift is a soloGift (not in tree), only it is in the list (no prev/next).
  // Otherwise, use the full mergedGifts list.
  const allGiftsForSheet = useMemo(
    () => (soloGift && soloGift.publicId === openGiftId ? [soloGift] : mergedGifts),
    [soloGift, openGiftId, mergedGifts],
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

  // ── After sign-in ─────────────────────────────────────────────────────────
  const handleSignedIn = useCallback(() => {
    setSignInVisible(false)
    refreshMe().catch(() => {})
  }, [refreshMe])

  // ── Sign-out ──────────────────────────────────────────────────────────────
  const handleSignOut = useCallback(() => {
    setUser(null)
    setHeartsLeft(5)
    setHeartedIds(new Set())
    setMyGifts([])
    setUserMenuOpen(false)
  }, [])

  // ── Action bar callbacks ──────────────────────────────────────────────────
  const handleCreateGift = useCallback(() => {
    if (!user) { handleSignIn(); return }
    setShowCreateGift(true)
  }, [user, handleSignIn])

  const handleLeaderboard = useCallback(() => setShowLeaderboard(true), [])
  const handleAllGifts = useCallback(() => setShowAllGifts(true), [])

  // ── After gift created ────────────────────────────────────────────────────
  const handleGiftCreated = useCallback(
    (publicId: string) => {
      setShowCreateGift(false)
      // Force a fresh tree poll to pick up the new gift
      setSoloGift(null)
      setOpenGiftId(publicId)
      // Refresh my gifts so quota is updated
      refreshMyGifts().catch(() => {})
    },
    [refreshMyGifts],
  )

  // ── After gift deleted from MyGifts ──────────────────────────────────────
  const handleGiftDeleted = useCallback(
    (publicId: string) => {
      // Remove from local myGifts immediately; polling will update tree
      setMyGifts((prev) => prev.filter((g) => g.publicId !== publicId))
    },
    [],
  )

  // ── Close user menu when clicking outside ────────────────────────────────
  useEffect(() => {
    if (!userMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [userMenuOpen])

  // ── in-app browser detection ──────────────────────────────────────────────
  const isInApp = typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)

  // ── Refs for focus return ─────────────────────────────────────────────────
  const createGiftBtnRef = useRef<HTMLButtonElement | null>(null)
  const leaderboardBtnRef = useRef<HTMLButtonElement | null>(null)
  const allGiftsBtnRef = useRef<HTMLButtonElement | null>(null)
  const myGiftsBtnRef = useRef<HTMLButtonElement | null>(null)

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
            <div className="noel-page-user-menu" ref={userMenuRef}>
              <button
                type="button"
                className="noel-page-user-btn"
                aria-expanded={userMenuOpen}
                aria-haspopup="true"
                aria-label={`Menu người dùng: ${user.nickname || 'Tôi'}`}
                onClick={() => setUserMenuOpen((v) => !v)}
              >
                {user.nickname || 'Tôi'} ▾
              </button>
              {userMenuOpen && (
                <div
                  className="noel-user-dropdown"
                  role="menu"
                  aria-label="Menu người dùng"
                >
                  <button
                    type="button"
                    role="menuitem"
                    ref={myGiftsBtnRef}
                    className="noel-user-menu-item"
                    onClick={() => {
                      setShowMyGifts(true)
                      setUserMenuOpen(false)
                    }}
                  >
                    🎁 Quà của tôi
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="noel-user-menu-item"
                    onClick={async () => {
                      await logout()
                      handleSignOut()
                    }}
                  >
                    Đăng xuất
                  </button>
                </div>
              )}
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
          <button
            type="button"
            className="noel-page-action-btn"
            ref={createGiftBtnRef}
            onClick={handleCreateGift}
          >
            🎁 Treo quà
          </button>
          <button
            type="button"
            className="noel-page-action-btn"
            ref={leaderboardBtnRef}
            onClick={handleLeaderboard}
          >
            🏆 Bảng xếp hạng
          </button>
          <button
            type="button"
            className="noel-page-action-btn"
            ref={allGiftsBtnRef}
            onClick={handleAllGifts}
          >
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
            allGifts={allGiftsForSheet as Parameters<typeof GiftSheet>[0]['allGifts']}
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
              <GoogleSignIn onSignedIn={handleSignedIn} />
            </Suspense>
          </div>
        </div>
      )}

      {/* ── Create Gift dialog */}
      {showCreateGift && (
        <Suspense fallback={null}>
          <CreateGift
            slug={slug}
            campaignName={campaignName}
            campaignOpen={campaignOpen}
            user={user}
            myGiftCount={myGiftCount}
            giftsPerUser={giftsPerUser}
            templates={templates}
            isInApp={isInApp}
            onSignIn={handleSignIn}
            onSuccess={handleGiftCreated}
            onUserUpdated={(nickname, className) => {
              setUser((prev) => prev ? { ...prev, nickname, className } : prev)
            }}
            onClose={() => setShowCreateGift(false)}
            returnFocusRef={createGiftBtnRef}
          />
        </Suspense>
      )}

      {/* ── Leaderboard dialog */}
      {showLeaderboard && (
        <Suspense fallback={null}>
          <Leaderboard
            gifts={mergedGifts}
            onClose={() => setShowLeaderboard(false)}
            onOpenGift={handleOpenExternalGift}
            returnFocusRef={leaderboardBtnRef}
          />
        </Suspense>
      )}

      {/* ── All Gifts dialog */}
      {showAllGifts && (
        <Suspense fallback={null}>
          <AllGifts
            slug={slug}
            onClose={() => setShowAllGifts(false)}
            onOpenGift={handleOpenExternalGift}
            returnFocusRef={allGiftsBtnRef}
          />
        </Suspense>
      )}

      {/* ── My Gifts dialog */}
      {showMyGifts && (
        <Suspense fallback={null}>
          <MyGifts
            slug={slug}
            onClose={() => setShowMyGifts(false)}
            onSignOut={handleSignOut}
            onOpenGift={handleOpenExternalGift}
            onGiftDeleted={handleGiftDeleted}
            returnFocusRef={myGiftsBtnRef}
          />
        </Suspense>
      )}
    </div>
  )
}

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
 *   createPoller from ./poller.ts — single chain, in-flight/generation guard,
 *   visibility pause/resume, backoff, abort/timeout, cleaned up on unmount/slug change.
 *   pollNow() after gift create to surface the new gift promptly.
 *   campaignOpen from each tree response's `open` field.
 *
 * Heart overrides (ADR-7):
 *   Optimistic heart counts via heartOverrides.ts, keyed to server asOf (not client clock).
 *   reconcileHeartRejection handles already_hearted/hearts_exhausted/campaign_closed errors.
 *   heartsLeft refreshed at the next Vietnam midnight (msUntilVietnamMidnight).
 *
 * Solo gift (share link / AllGifts / Leaderboard):
 *   Fetched once per openGiftId change when not in tree; closes only on 404;
 *   override applied; rank 0 not shown (GiftSheet guards it).
 *
 * Closed state (FR-28, AC-3):
 *   When campaign.open is false, the action bar is hidden and "Chiến dịch đã kết thúc"
 *   is shown as a banner.  The tree remains viewable.
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
import type React from 'react'
import { Link } from 'react-router-dom'
import { Scene, type TreeGift } from './Scene.tsx'
import { focusGiftButton } from './focusReturn.ts'
import { nextPollDelay } from './poll.ts'
import {
  applyOverride,
  addOverride,
  reconcileOverrides,
  type OverrideMap,
} from './heartOverrides.ts'
import { msUntilVietnamMidnight, reconcileHeartRejection } from './meRefresh.ts'
import { createPoller, type Poller } from './poller.ts'
import { useDialog } from './useDialog.ts'
import ErrorBoundary from '../components/ErrorBoundary.tsx'
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
  ApiError,
  type NoelTemplate,
  type NoelGift,
  type NoelGiftFlat,
  type NoelTreeData,
  type MeUser,
  type ReportReason,
} from '../api.ts'
import { isInAppBrowser } from '../campaign/inAppBrowser.ts'
import { ThemeOverridesContext } from './defaultTheme.ts'
import type { ThemeAsset } from '../../shared/themeSlots.ts'

// GiftSheet is lazy to avoid loading CardView + timelines on first tree render
const GiftSheet = lazy(() => import('./GiftSheet.tsx'))
/** Path + query of the current page, so sign-in returns the player here. */
function currentPath(): string {
  return window.location.pathname + window.location.search
}
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

/** Converts a NoelGiftFlat (no rank/place) to a NoelGift with rank=0, place='ground'. */
function flatToNoelGift(g: NoelGiftFlat): NoelGift {
  return { ...g, rank: 0, place: 'ground' }
}

// ── Sign-in dialog sub-component (uses useDialog for focus trap) ──────────────

function SignInDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  useDialog({ dialogRef, onCloseRef, returnFocusRef })

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Đăng nhập"
      className="noel-signin-backdrop"
      tabIndex={-1}
      onClick={onClose}
    >
      <div
        className="noel-signin-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="noel-signin-header">
          <h2>Đăng nhập để thả tim</h2>
          <button type="button" aria-label="Đóng" onClick={onClose}>
            ✕
          </button>
        </div>
        <p>Tạo tài khoản bằng tên đăng nhập và mật khẩu, rồi quay lại đây để thả tim.</p>
        <p className="noel-signin-links">
          <Link to={`/dang-nhap?next=${encodeURIComponent(currentPath())}`}>Đăng nhập</Link>{' · '}
          <Link to={`/dang-ky?next=${encodeURIComponent(currentPath())}`}>Đăng ký</Link>
        </p>
      </div>
    </div>
  )
}

// ── NoelPage component ────────────────────────────────────────────────────────

export default function NoelPage({ slug, focusPublicId }: NoelPageProps): ReactNode {
  // Campaign metadata
  const [campaignName, setCampaignName] = useState('Cây Thông Điều Ước')
  const [campaignOpen, setCampaignOpen] = useState(true)
  const [themeOverrides, setThemeOverrides] = useState<Record<string, ThemeAsset>>({})
  const [treeSlots, setTreeSlots] = useState(15)
  const [groundSlots, setGroundSlots] = useState(10)
  const [giftsPerUser, setGiftsPerUser] = useState(3)

  // Templates: load error state so user can retry (review finding)
  const [templates, setTemplates] = useState<NoelTemplate[]>([])
  const [templatesLoadError, setTemplatesLoadError] = useState(false)
  // True once the list has loaded (even if empty), so "no backgrounds" is not shown as "loading".
  const [templatesReady, setTemplatesReady] = useState(false)

  const loadTemplates = useCallback(() => {
    let alive = true
    setTemplatesLoadError(false)
    getNoelTemplates(slug)
      .then((t) => { if (alive) { setTemplates(t); setTemplatesReady(true) } })
      .catch(() => { if (alive) setTemplatesLoadError(true) })
    return () => { alive = false }
  }, [slug])

  useEffect(() => loadTemplates(), [loadTemplates])

  // Tree data (from polling)
  const [treeData, setTreeData] = useState<NoelTreeData | null>(null)
  // Store the most recent server asOf (ms) for override keying; ref for use in heart handler
  const serverAsOfRef = useRef<number>(0)

  // Per-user state
  const [user, setUser] = useState<MeUser | null>(null)
  const [heartsLeft, setHeartsLeft] = useState(5)
  const [heartedIds, setHeartedIds] = useState<Set<string>>(new Set())

  // Refs for heart reconciliation (read in handleHeart without depending on state values)
  const heartsLeftRef = useRef(heartsLeft)
  heartsLeftRef.current = heartsLeft
  const heartedIdsRef = useRef(heartedIds)
  heartedIdsRef.current = heartedIds
  const campaignOpenRef = useRef(campaignOpen)
  campaignOpenRef.current = campaignOpen

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

  // Optimistic heart overrides (publicId → HeartOverride), ADR-7
  const [localOverrides, setLocalOverrides] = useState<OverrideMap>(new Map())

  // Open gift ID (null = sheet closed)
  const [openGiftId, setOpenGiftId] = useState<string | null>(focusPublicId ?? null)
  const openGiftIdRef = useRef<string | null>(null)
  openGiftIdRef.current = openGiftId

  // Solo gift: for gifts opened from AllGifts/Leaderboard that aren't in the tree
  const [soloGift, setSoloGift] = useState<NoelGift | null>(null)
  // Track which ID was last fetched so we don't refetch on every poll
  const soloFetchedForRef = useRef<string | null>(null)
  // Ref kept in sync with soloGift for use inside setLocalOverrides updater
  const soloGiftRef = useRef<NoelGift | null>(null)
  soloGiftRef.current = soloGift

  // Sign-in dialog
  const [signInVisible, setSignInVisible] = useState(false)
  const signinReturnRef = useRef<HTMLButtonElement | null>(null)

  // Dialog states for Part B flows
  const [showCreateGift, setShowCreateGift] = useState(false)
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [showAllGifts, setShowAllGifts] = useState(false)
  const [showMyGifts, setShowMyGifts] = useState(false)

  // User menu dropdown
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)

  // Logout error message
  const [logoutError, setLogoutError] = useState<string | null>(null)

  // Error shown after account deletion when the logout call fails (shown after MyGifts closes)
  const [postSignoutError, setPostSignoutError] = useState<string | null>(null)

  // Poller ref so pollNow() can be called from anywhere
  const pollerRef = useRef<Poller | null>(null)

  // ── Fetch campaign metadata ─────────────────────────────────────────────
  useEffect(() => {
    let alive = true
    getCampaign(slug)
      .then((c) => {
        if (!alive) return
        setCampaignName(c.name || 'Cây Thông Điều Ước')
        setCampaignOpen(!!c.open)
        setThemeOverrides(c.theme ?? {})
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

  // ── Refresh me at Vietnam midnight (heartsLeft resets at 00:00 ICT) ──────
  // Self-rescheduling: after each midnight fires, arm the next one.
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout>
    let alive = true

    function arm(): void {
      timerId = setTimeout(async () => {
        if (!alive) return
        await refreshMe().catch(() => {})
        if (alive) arm()  // re-arm for the next midnight
      }, msUntilVietnamMidnight(Date.now()))
    }

    arm()
    return () => {
      alive = false
      clearTimeout(timerId)
    }
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

  // ── Poll tree while visible (ADR-7) via createPoller ─────────────────────
  useEffect(() => {
    const poller = createPoller<NoelTreeData>({
      fetch: (signal) => getNoelTree(slug, signal),
      schedule: (fn, ms) => setTimeout(fn, ms),
      clearSchedule: (id) => clearTimeout(id),
      isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
      onData: (data) => {
        const newAsOf = Date.parse(data.asOf)
        serverAsOfRef.current = newAsOf
        // Update campaignOpen from each tree response
        setCampaignOpen(data.open)
        // Reconcile overrides: drop for absent gifts or confirmed by server.
        // Pin the solo gift's override so it's not dropped when it's absent from the tree.
        setLocalOverrides((prev) => {
          const sg = soloGiftRef.current
          const pinned = sg ? new Set([sg.publicId]) : undefined
          return reconcileOverrides(prev, data.gifts, newAsOf, pinned)
        })
        setTreeData(data)
      },
      onError: () => { /* use defaults; next poll will retry */ },
      nextDelay: (failures) => nextPollDelay(() => Math.random(), failures),
    })
    pollerRef.current = poller

    const handleVisibility = () => poller.handleVisibilityChange()
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      poller.stop()
      pollerRef.current = null
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [slug])

  // ── Merged gifts: apply local heart overrides (ADR-7) ───────────────────
  const mergedGifts = useMemo<NoelGift[]>(() => {
    if (!treeData) return []
    if (localOverrides.size === 0) return treeData.gifts
    return treeData.gifts.map((g) => ({
      ...g,
      heartCount: applyOverride(g.publicId, g.heartCount, localOverrides),
    }))
  }, [treeData, localOverrides])

  // Ref for checking inTree in solo fetch without adding mergedGifts to deps
  const mergedGiftsRef = useRef(mergedGifts)
  mergedGiftsRef.current = mergedGifts

  const sceneGifts = useMemo<TreeGift[]>(() => mergedGifts.map(toTreeGift), [mergedGifts])

  // ── Open / close gift sheet ───────────────────────────────────────────────
  const handleOpen = useCallback((publicId: string) => {
    setSoloGift(null)
    soloFetchedForRef.current = null
    setOpenGiftId(publicId)
  }, [])

  const handleClose = useCallback(() => {
    const shown = openGiftIdRef.current
    setOpenGiftId(null)
    setSoloGift(null)
    soloFetchedForRef.current = null
    // After the dialog unmounts, put keyboard focus back on that gift (or the "Tất cả quà" button).
    requestAnimationFrame(() => focusGiftButton(document, shown, allGiftsBtnRef.current))
  }, [])

  const handleNavigate = useCallback((publicId: string) => {
    setSoloGift(null)
    soloFetchedForRef.current = null
    setOpenGiftId(publicId)
  }, [])

  // ── Open gift from external sources (AllGifts / Leaderboard) ────────────
  const handleOpenExternalGift = useCallback(
    (publicId: string) => {
      setShowLeaderboard(false)
      setShowAllGifts(false)
      setSoloGift(null)
      soloFetchedForRef.current = null
      setOpenGiftId(publicId)
    },
    [],
  )

  // ── Solo gift fetch: once per openGiftId when not in tree ────────────────
  // Split into two effects:
  // Effect A: responds to openGiftId change — fetches the gift if not in tree.
  // Effect B: responds to mergedGifts change — clears soloGift if it arrived in tree.
  useEffect(() => {
    if (!openGiftId) {
      setSoloGift(null)
      soloFetchedForRef.current = null
      return
    }
    // If the gift is already in the current tree, no fetch needed
    if (mergedGiftsRef.current.some((g) => g.publicId === openGiftId)) {
      setSoloGift(null)
      soloFetchedForRef.current = null
      return
    }
    // Already fetched for this id — don't re-fetch
    if (soloFetchedForRef.current === openGiftId) return

    soloFetchedForRef.current = openGiftId
    let alive = true
    getGiftByPublicId(openGiftId)
      .then((g: NoelGiftFlat) => { if (alive) setSoloGift(flatToNoelGift(g)) })
      .catch((err: unknown) => {
        if (!alive) return
        // Close only on 404 (gift hidden/deleted); leave open on transient errors
        if (err instanceof ApiError && err.status === 404) {
          setOpenGiftId(null)
          setSoloGift(null)
          soloFetchedForRef.current = null
        }
        // For other errors: soloGift stays null; sheet remains open with no content
      })
    return () => { alive = false }
  }, [openGiftId]) // intentionally excludes mergedGifts — effect A only on id change

  // Effect B: when a solo gift appears in the tree, clear soloGift
  useEffect(() => {
    if (!soloGift) return
    if (mergedGifts.some((g) => g.publicId === soloGift.publicId)) {
      setSoloGift(null)
      soloFetchedForRef.current = null
    }
  }, [mergedGifts, soloGift])

  // ── Computed: open gift for the GiftSheet ────────────────────────────────
  const openGift = useMemo(() => {
    if (!openGiftId) return undefined
    // Check in merged tree first
    const inTree = mergedGifts.find((g) => g.publicId === openGiftId)
    if (inTree) return inTree
    // Apply override to solo gift too
    if (soloGift?.publicId === openGiftId) {
      const count = applyOverride(soloGift.publicId, soloGift.heartCount, localOverrides)
      if (count === soloGift.heartCount) return soloGift
      return { ...soloGift, heartCount: count }
    }
    return undefined
  }, [mergedGifts, openGiftId, soloGift, localOverrides])

  // The allGifts list for GiftSheet navigation:
  // If the opened gift is a soloGift (not in tree), only it is in the list (no prev/next).
  // Otherwise, use the full mergedGifts list.
  const allGiftsForSheet = useMemo(
    () => (soloGift && soloGift.publicId === openGiftId ? [soloGift] : mergedGifts),
    [soloGift, openGiftId, mergedGifts],
  )

  // ── Heart handler ─────────────────────────────────────────────────────────
  const handleHeart = useCallback(async (publicId: string): Promise<void> => {
    try {
      const result = await heartGift(publicId)
      setHeartsLeft(result.heartsLeft)
      setHeartedIds((prev) => new Set([...prev, publicId]))
      setLocalOverrides((prev) => addOverride(prev, publicId, result.heartCount, serverAsOfRef.current))
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      const reconciled = reconcileHeartRejection(
        code,
        publicId,
        heartedIdsRef.current,
        heartsLeftRef.current,
        campaignOpenRef.current,
      )
      setHeartedIds(reconciled.heartedIds as Set<string>)
      setHeartsLeft(reconciled.heartsLeft)
      setCampaignOpen(reconciled.campaignOpen)
      if (reconciled.needsRefreshMe) refreshMe().catch(() => {})
      throw err
    }
  }, [refreshMe])

  // ── Report handler ────────────────────────────────────────────────────────
  const handleReport = useCallback(async (publicId: string, reason: ReportReason): Promise<void> => {
    await reportGift(publicId, reason)
  }, [])

  // ── Sign-in ───────────────────────────────────────────────────────────────
  // The sign-in button ref is used for focus return
  const signinBtnRef = useRef<HTMLButtonElement | null>(null)
  const handleSignIn = useCallback(() => {
    signinReturnRef.current = signinBtnRef.current
    setSignInVisible(true)
  }, [])

  // ── After sign-in ─────────────────────────────────────────────────────────
  // ── Close sign-in ─────────────────────────────────────────────────────────
  const handleCloseSignIn = useCallback(() => setSignInVisible(false), [])

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

  // ── Stable onClose handlers for each dialog ───────────────────────────────
  const handleCloseCreateGift = useCallback(() => setShowCreateGift(false), [])
  const handleCloseLeaderboard = useCallback(() => setShowLeaderboard(false), [])
  const handleCloseAllGifts = useCallback(() => setShowAllGifts(false), [])
  const handleCloseMyGifts = useCallback(() => setShowMyGifts(false), [])

  // ── After gift created ────────────────────────────────────────────────────
  const handleGiftCreated = useCallback(
    (publicId: string) => {
      setShowCreateGift(false)
      setSoloGift(null)
      soloFetchedForRef.current = null
      setOpenGiftId(publicId)
      // Poll immediately to surface the new gift
      pollerRef.current?.pollNow()
      // Refresh my gifts so quota is updated
      refreshMyGifts().catch(() => {})
    },
    [refreshMyGifts],
  )

  // ── User updated callback ─────────────────────────────────────────────────
  const handleUserUpdated = useCallback((nickname: string, className: string) => {
    setUser((prev) => prev ? { ...prev, nickname, className } : prev)
  }, [])

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

  // ── Logout handler ────────────────────────────────────────────────────────
  const handleLogout = useCallback(async () => {
    setLogoutError(null)
    try {
      await logout()
    } catch {
      setLogoutError('Đăng xuất thất bại. Vui lòng thử lại.')
      return
    }
    handleSignOut()
  }, [handleSignOut])

  // ── in-app browser detection ──────────────────────────────────────────────
  const isInApp = typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)

  // ── Refs for focus return ─────────────────────────────────────────────────
  const createGiftBtnRef = useRef<HTMLButtonElement | null>(null)
  const leaderboardBtnRef = useRef<HTMLButtonElement | null>(null)
  const allGiftsBtnRef = useRef<HTMLButtonElement | null>(null)
  // myGiftsBtnRef points to the ALWAYS-MOUNTED user-menu trigger button (not the menu item,
  // which is only in the DOM while the dropdown is open and would be gone when MyGifts unmounts).
  const myGiftsBtnRef = useRef<HTMLButtonElement | null>(null)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ThemeOverridesContext.Provider value={themeOverrides}>
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
                ref={myGiftsBtnRef}
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
                    className="noel-user-menu-item"
                    onClick={() => {
                      setShowMyGifts(true)
                      setUserMenuOpen(false)
                    }}
                  >
                    🎁 Quà của tôi
                  </button>
                  {logoutError && (
                    <p className="noel-logout-error" role="alert" style={{ fontSize: '0.8rem', color: '#ef4444', padding: '0 0.5rem' }}>
                      {logoutError}
                    </p>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="noel-user-menu-item"
                    onClick={() => { void handleLogout() }}
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
              ref={signinBtnRef}
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
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được hộp quà. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
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
        </ErrorBoundary>
      )}

      {/* ── Sign-in dialog (focus-managed via useDialog) */}
      {signInVisible && (
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được đăng nhập. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
          <SignInDialog
            onClose={handleCloseSignIn}
            returnFocusRef={signinReturnRef as React.RefObject<HTMLElement | null>}
          />
        </ErrorBoundary>
      )}

      {/* ── Create Gift dialog */}
      {showCreateGift && (
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
          <Suspense fallback={null}>
            <CreateGift
              slug={slug}
              campaignName={campaignName}
              campaignOpen={campaignOpen}
              user={user}
              myGiftCount={myGiftCount}
              giftsPerUser={giftsPerUser}
              templates={templates}
              templatesLoadError={templatesLoadError}
              templatesReady={templatesReady}
              onRetryTemplates={loadTemplates}
              isInApp={isInApp}
              onSignIn={handleSignIn}
              onSuccess={handleGiftCreated}
              onUserUpdated={handleUserUpdated}
              onClose={handleCloseCreateGift}
              returnFocusRef={createGiftBtnRef}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* ── Leaderboard dialog */}
      {showLeaderboard && (
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
          <Suspense fallback={null}>
            <Leaderboard
              gifts={mergedGifts}
              onClose={handleCloseLeaderboard}
              onOpenGift={handleOpenExternalGift}
              returnFocusRef={leaderboardBtnRef}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* ── All Gifts dialog */}
      {showAllGifts && (
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
          <Suspense fallback={null}>
            <AllGifts
              slug={slug}
              onClose={handleCloseAllGifts}
              onOpenGift={handleOpenExternalGift}
              returnFocusRef={allGiftsBtnRef}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* ── My Gifts dialog */}
      {showMyGifts && (
        <ErrorBoundary fallback={<p style={{ padding: '1rem', color: '#ef4444' }}>Không tải được. <button type="button" onClick={() => window.location.reload()}>Tải lại</button></p>}>
          <Suspense fallback={null}>
            <MyGifts
              slug={slug}
              onClose={handleCloseMyGifts}
              onSignOut={handleSignOut}
              onOpenGift={handleOpenExternalGift}
              onGiftDeleted={handleGiftDeleted}
              onLogoutError={(msg) => setPostSignoutError(msg)}
              returnFocusRef={myGiftsBtnRef}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* ── Post-signout error (shown after account deletion with failed logout) */}
      {postSignoutError && (
        <div role="alert" className="noel-page-post-signout-error" style={{ position: 'fixed', bottom: '5rem', left: '50%', transform: 'translateX(-50%)', background: '#fef2f2', border: '1px solid #ef4444', borderRadius: '0.5rem', padding: '0.75rem 1rem', zIndex: 60, maxWidth: '90vw', textAlign: 'center' }}>
          <span>{postSignoutError}</span>
          <button type="button" aria-label="Đóng thông báo" style={{ marginLeft: '0.75rem', background: 'none', border: 'none', cursor: 'pointer', fontSize: '1rem' }} onClick={() => setPostSignoutError(null)}>✕</button>
        </div>
      )}
    </div>
    </ThemeOverridesContext.Provider>
  )
}

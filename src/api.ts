/**
 * Typed fetch client for the backend API.
 *
 * Public endpoints: no auth headers.
 * Admin endpoints (/api/admin/*): session cookie + X-Requested-With (CSRF).
 * Auth/session endpoints (/api/auth/*, /api/me): X-Requested-With only (session cookie).
 * Campaign public endpoints (/api/campaigns/*): plain fetch, no auth.
 */
import type {
  AboutContent,
  AdminCard,
  AdminTemplate,
  AdminTeacher,
  AdminTeacherInput,
  AdminTemplateInput,
  BulkTeacherInputItem,
  BulkTeacherRequest,
  QrResponse,
  ReviewRequest,
  SubmitCardRequest,
  TemplatePublic,
  WallResponse,
  WishPublic,
} from '../shared/api.ts'

export type { AboutContent, AdminCard, AdminTemplate, AdminTeacher, AdminTeacherInput, AdminTemplateInput,
  BulkTeacherInputItem, BulkTeacherRequest,
  QrResponse, ReviewRequest, SubmitCardRequest, TemplatePublic,
  WallResponse, WishPublic }

// Keep these types for ImageLibrary, WishLibrary, AdminsSection (unchanged)
export type ImageRow = {
  id: number
  token: string
  name: string
  mime: string
  size: number
  created_at: string
  created_by: string
  used_by: number
}

export type WishRow = {
  id: number
  title: string
  body: string
  created_at: string
  created_by: string
}

export type AdminRow = {
  id: number
  email: string
  created_at: string
  created_by: string
}

// ── Auth / session types ──────────────────────────────────────────────────

/** Signed-in user shape returned by /api/me and the account endpoints (ADR-9). */
export type MeUser = {
  id?: number
  username?: string | null
  nickname: string
  className: string
  banned?: boolean
  isAdmin: boolean
  mustChangePassword?: boolean
}

// ── Campaign types ────────────────────────────────────────────────────────

/** Public campaign shape returned by /api/campaigns/active and /api/campaigns/<slug>. */
export type CampaignData = {
  slug: string
  kind: string
  name: string
  tagline: string
  content: unknown
  themeColors: unknown
  settings: unknown
  startsAt: string
  endsAt: string
  status: string
  open: boolean
}

/** Campaign row returned by GET /api/admin/campaigns. */
export type AdminCampaignRow = {
  id: number
  slug: string
  kind: string
  name: string
  tagline: string
  starts_at: string
  ends_at: string
  status: string
  created_at: string
  created_by: string
}

/** Input shape for POST /api/admin/campaigns and PATCH /api/admin/campaigns/<id>. */
export type AdminCampaignInput = {
  slug?: string
  kind?: string
  name?: string
  tagline?: string
  content?: string
  theme_colors?: string
  settings?: string
  starts_at?: string
  ends_at?: string
}

/** Full campaign row returned by GET /api/admin/campaigns/<id> (includes content/settings/theme_colors). */
export type AdminCampaignFullRow = {
  id: number
  slug: string
  kind: string
  name: string
  tagline: string
  content: string
  theme_colors: string
  settings: string
  starts_at: string
  ends_at: string
  status: string
  created_at: string
  created_by: string
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`)
  }
}

/**
 * Map an ApiError (or any caught value) to a user-facing Vietnamese message.
 * Use this everywhere raw error.message would otherwise surface to the UI.
 * Non-ApiError (network errors, TypeError, etc.) → generic connection-error message.
 */
export function messageFor(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 400) return 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.'
    if (e.status === 401 || e.status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
    if (e.status === 404) return 'Không tìm thấy dữ liệu.'
    if (e.status === 409) return 'Dữ liệu đã tồn tại hoặc xung đột.'
    if (e.status === 429) return 'Quá nhiều yêu cầu. Vui lòng thử lại sau.'
    if (e.status >= 500) return 'Lỗi máy chủ. Vui lòng thử lại sau.'
  }
  return 'Lỗi kết nối, vui lòng thử lại.'
}

// ── Core fetch helpers ────────────────────────────────────────────────────

/** Admin fetch: the session cookie carries the admin identity; X-Requested-With guards CSRF. */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-Requested-With': 'fetch',
  }
  return fetch(path, { ...init, headers })
}

/** Session/auth fetch: adds X-Requested-With only (session arrives via cookie). */
async function sessionFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-Requested-With': 'fetch',
  }
  return fetch(path, { ...init, headers })
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let code = 'unknown'
    try {
      const body = await res.json() as { error?: string }
      code = body.error ?? 'unknown'
    } catch { /* ignore */ }
    throw new ApiError(res.status, code)
  }
  return res
}

/** Throws ApiError with the server's error code for any non-2xx response. */
async function sessionExpectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let code = 'unknown'
    try {
      const body = await res.json() as { error?: string }
      code = body.error ?? 'unknown'
    } catch { /* ignore */ }
    throw new ApiError(res.status, code)
  }
  return res
}

// ── Public API (no auth) ──────────────────────────────────────────────────

export async function getWall(): Promise<WallResponse> {
  return (await expectOk(await fetch('/api/wall'))).json() as Promise<WallResponse>
}

export async function getTemplates(): Promise<TemplatePublic[]> {
  return (await expectOk(await fetch('/api/templates'))).json() as Promise<TemplatePublic[]>
}

export async function getPublicWishes(): Promise<WishPublic[]> {
  return (await expectOk(await fetch('/api/wishes'))).json() as Promise<WishPublic[]>
}

export async function submitCard(body: SubmitCardRequest): Promise<{ status: 'pending' }> {
  return (await expectOk(await fetch('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))).json() as Promise<{ status: 'pending' }>
}

export async function getQr(token: string): Promise<QrResponse> {
  return (await expectOk(await fetch(`/api/qr/${encodeURIComponent(token)}`))).json() as Promise<QrResponse>
}

/** GET /api/about — public About content. */
export async function getAbout(): Promise<AboutContent> {
  return (await expectOk(await fetch('/api/about'))).json() as Promise<AboutContent>
}

// ── Campaign public API (no auth, cached by server) ───────────────────────

/** GET /api/campaigns/active — the currently active campaign, or throws 404. */
export async function getActiveCampaign(): Promise<CampaignData> {
  return (await expectOk(await fetch('/api/campaigns/active'))).json() as Promise<CampaignData>
}

/** GET /api/campaigns/<slug> — a specific campaign by slug, or throws 404. */
export async function getCampaign(slug: string): Promise<CampaignData> {
  return (await expectOk(await fetch(`/api/campaigns/${encodeURIComponent(slug)}`))).json() as Promise<CampaignData>
}

// ── Auth / session API ────────────────────────────────────────────────────

/** GET /api/auth/nonce — returns a one-time nonce and the Google client ID for the sign-in flow. */
export async function getNonce(): Promise<{ nonce: string; clientId: string }> {
  const res = await sessionExpectOk(await fetch('/api/auth/nonce', {
    headers: { 'X-Requested-With': 'fetch' },
  }))
  const data = await res.json() as { nonce: string; clientId?: string }
  return { nonce: data.nonce, clientId: data.clientId ?? '' }
}

/** POST /api/auth/google — verify Google credential, create session, return user. */
export async function signInWithGoogle(credential: string): Promise<MeUser> {
  const res = await sessionExpectOk(await sessionFetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  }))
  const data = await res.json() as { user: MeUser }
  return data.user
}

/** POST /api/auth/logout — revoke current session cookie (best-effort). */
/** POST /api/auth/logout. Throws ApiError when the server does not confirm, so the UI never
 *  shows "signed out" while the session cookie is still valid (shared computers). */
export async function logout(): Promise<void> {
  await sessionExpectOk(await sessionFetch('/api/auth/logout', { method: 'POST' }))
}

/** GET /api/me — returns current signed-in user (or null) and isAdmin flag. */
export async function getMe(): Promise<{ user: MeUser | null; isAdmin: boolean }> {
  const res = await fetch('/api/me', { headers: { 'X-Requested-With': 'fetch' } })
  if (!res.ok) return { user: null, isAdmin: false }
  return res.json() as Promise<{ user: MeUser | null; isAdmin: boolean }>
}

/** POST /api/auth/register — creates the account and signs it in. */
export async function register(input: { username: string; password: string; nickname: string; className: string }): Promise<MeUser> {
  const res = await sessionExpectOk(await sessionFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
  return (await res.json() as { user: MeUser }).user
}

/** POST /api/auth/login — signs in with username and password. */
export async function login(input: { username: string; password: string }): Promise<MeUser> {
  const res = await sessionExpectOk(await sessionFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
  return (await res.json() as { user: MeUser }).user
}

/** POST /api/me/password — changes the password; the server issues a new session cookie. */
export async function changePassword(input: { current: string; next: string }): Promise<MeUser> {
  const res = await sessionExpectOk(await sessionFetch('/api/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
  return (await res.json() as { user: MeUser }).user
}

export type AdminAccount = { userId: number; username: string | null; nickname: string; grantedAt: string; grantedBy: string }
export type AuditRow = { id: number; actor: number | null; action: string; targetUserId: number | null; at: string }

/** GET /api/admin/admins — every account with the admin role. */
export async function listAdminAccounts(): Promise<AdminAccount[]> {
  return (await expectOk(await apiFetch('/api/admin/admins'))).json() as Promise<AdminAccount[]>
}

/** POST /api/admin/admins {username} — grants the admin role to an existing account. */
export async function grantAdminRole(username: string): Promise<void> {
  await expectOk(await apiFetch('/api/admin/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }))
}

/** DELETE /api/admin/admins/<userId> — revokes the admin role. */
export async function revokeAdminRole(userId: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/admins/${userId}`, { method: 'DELETE' }))
}

/** POST /api/admin/users/<id>/password — returns the one-time temporary password. */
export async function resetUserPassword(userId: number): Promise<string> {
  const res = await expectOk(await apiFetch(`/api/admin/users/${userId}/password`, { method: 'POST' }))
  return (await res.json() as { tempPassword: string }).tempPassword
}

/** GET /api/admin/audit — newest 200 audit rows. */
export async function listAuditRows(): Promise<AuditRow[]> {
  return (await expectOk(await apiFetch('/api/admin/audit'))).json() as Promise<AuditRow[]>
}

/** PUT /api/me — update nickname (1–30 chars) and className (≤10 chars). */
export async function updateMe(nickname: string, className: string): Promise<void> {
  await sessionExpectOk(await sessionFetch('/api/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, className }),
  }))
}

// ── Admin campaign API ────────────────────────────────────────────────────

/** GET /api/admin/campaigns — list all campaigns. Requires Google session. */
export async function listAdminCampaigns(): Promise<AdminCampaignRow[]> {
  const data = await (await expectOk(await apiFetch('/api/admin/campaigns'))).json() as { campaigns: AdminCampaignRow[] }
  return data.campaigns
}

/** POST /api/admin/campaigns — create a new campaign. Requires Google session. */
export async function createAdminCampaign(input: AdminCampaignInput): Promise<{ id: number }> {
  return (await expectOk(await apiFetch('/api/admin/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))).json() as Promise<{ id: number }>
}

/** PATCH /api/admin/campaigns/<id> — update an existing campaign. Requires Google session. */
export async function updateAdminCampaign(id: number, input: AdminCampaignInput): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/campaigns/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))
}

/** POST /api/admin/campaigns/<id>/activate — activate a campaign (closes the current active one). */
export async function activateAdminCampaign(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/campaigns/${id}/activate`, { method: 'POST' }))
}

/** GET /api/admin/campaigns/<id> — fetch the full campaign row including content/settings/theme_colors. */
export async function getAdminCampaign(id: number): Promise<AdminCampaignFullRow> {
  return (await expectOk(await apiFetch(`/api/admin/campaigns/${id}`))).json() as Promise<AdminCampaignFullRow>
}

/** POST /api/admin/campaigns/<id>/close — close a campaign. */
export async function closeAdminCampaign(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/campaigns/${id}/close`, { method: 'POST' }))
}

// ── Admin teachers ────────────────────────────────────────────────────────

export async function listAdminTeachers(): Promise<AdminTeacher[]> {
  return (await expectOk(await apiFetch('/api/admin/teachers'))).json() as Promise<AdminTeacher[]>
}

export async function createAdminTeacher(input: AdminTeacherInput): Promise<AdminTeacher> {
  return (await expectOk(await apiFetch('/api/admin/teachers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))).json() as Promise<AdminTeacher>
}

export async function updateAdminTeacher(id: number, input: Partial<AdminTeacherInput>): Promise<AdminTeacher> {
  return (await expectOk(await apiFetch(`/api/admin/teachers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))).json() as Promise<AdminTeacher>
}

export async function deleteAdminTeacher(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/teachers/${id}`, { method: 'DELETE' }))
}

export async function rotateAdminTeacher(id: number): Promise<{ token: string }> {
  return (await expectOk(await apiFetch(`/api/admin/teachers/${id}/rotate`, {
    method: 'POST',
  }))).json() as Promise<{ token: string }>
}

export async function bulkAdminTeachers(items: BulkTeacherInputItem[]): Promise<{ created: AdminTeacher[] }> {
  return (await expectOk(await apiFetch('/api/admin/teachers/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items } satisfies BulkTeacherRequest),
  }))).json() as Promise<{ created: AdminTeacher[] }>
}

// ── Admin templates ───────────────────────────────────────────────────────

export async function listAdminTemplates(): Promise<AdminTemplate[]> {
  return (await expectOk(await apiFetch('/api/admin/templates'))).json() as Promise<AdminTemplate[]>
}

export async function createAdminTemplate(input: AdminTemplateInput): Promise<AdminTemplate> {
  return (await expectOk(await apiFetch('/api/admin/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))).json() as Promise<AdminTemplate>
}

export async function updateAdminTemplate(id: number, input: Partial<AdminTemplateInput>): Promise<AdminTemplate> {
  return (await expectOk(await apiFetch(`/api/admin/templates/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }))).json() as Promise<AdminTemplate>
}

export async function deleteAdminTemplate(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/templates/${id}`, { method: 'DELETE' }))
}

// ── Admin moderation ──────────────────────────────────────────────────────

export type ListCardsParams = {
  status?: 'pending' | 'approved' | 'hidden'
  teacher?: number
  after?: number
  before?: number
}

export async function listAdminCards(params: ListCardsParams = {}): Promise<AdminCard[]> {
  const q = new URLSearchParams()
  if (params.status) q.set('status', params.status)
  if (params.teacher != null) q.set('teacher', String(params.teacher))
  if (params.after != null) q.set('after', String(params.after))
  if (params.before != null) q.set('before', String(params.before))
  const qs = q.toString()
  return (await expectOk(await apiFetch(`/api/admin/cards${qs ? `?${qs}` : ''}`))).json() as Promise<AdminCard[]>
}

export async function updateAdminCard(id: number, status: 'approved' | 'hidden'): Promise<AdminCard> {
  return (await expectOk(await apiFetch(`/api/admin/cards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }))).json() as Promise<AdminCard>
}

export async function bulkReviewCards(req: ReviewRequest): Promise<void> {
  await expectOk(await apiFetch('/api/admin/cards/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }))
}

export async function deleteAdminCard(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/cards/${id}`, { method: 'DELETE' }))
}

// ── Admin management ──────────────────────────────────────────────────────

export async function listAdmins(): Promise<AdminRow[]> {
  return (await expectOk(await apiFetch('/api/admin/admins'))).json() as Promise<AdminRow[]>
}

export async function addAdmin(email: string): Promise<AdminRow> {
  return (await expectOk(await apiFetch('/api/admin/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }))).json() as Promise<AdminRow>
}

export async function removeAdmin(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/admins/${id}`, { method: 'DELETE' }))
}

// ── Images ────────────────────────────────────────────────────────────────

export async function listImages(): Promise<ImageRow[]> {
  return (await expectOk(await apiFetch('/api/admin/images'))).json() as Promise<ImageRow[]>
}

export async function uploadImage(blob: Blob, name: string): Promise<ImageRow> {
  return (await expectOk(await apiFetch(
    `/api/admin/images?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob },
  ))).json() as Promise<ImageRow>
}

export async function deleteImage(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/images/${id}`, { method: 'DELETE' }))
}

// ── Wishes (admin) ────────────────────────────────────────────────────────

export async function listWishes(): Promise<WishRow[]> {
  return (await expectOk(await apiFetch('/api/admin/wishes'))).json() as Promise<WishRow[]>
}

export async function createWish(title: string, body: string): Promise<WishRow> {
  return (await expectOk(await apiFetch('/api/admin/wishes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  }))).json() as Promise<WishRow>
}

export async function updateWish(id: number, title: string, body: string): Promise<WishRow> {
  return (await expectOk(await apiFetch(`/api/admin/wishes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  }))).json() as Promise<WishRow>
}

export async function deleteWish(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/wishes/${id}`, { method: 'DELETE' }))
}

// ── About (admin) ─────────────────────────────────────────────────────────

/** GET /api/admin/about — read current About content (admin auth). */
export async function getAdminAbout(): Promise<AboutContent> {
  return (await expectOk(await apiFetch('/api/admin/about'))).json() as Promise<AboutContent>
}

/** PUT /api/admin/about — replace About content (admin auth). Returns stored content. */
export async function putAdminAbout(body: AboutContent): Promise<AboutContent> {
  return (await expectOk(await apiFetch('/api/admin/about', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))).json() as Promise<AboutContent>
}

// ── Admin moderation API (Phase 2) ────────────────────────────────────────────
//
// All routes require a Google session (ADR-3: new admin routes, no legacy path).
// Typed-email sessions → 401; handle with giftModerationErrorMessage from moderationHelpers.ts.

/** Gift item returned by GET /api/admin/gifts?status=reported|hidden. */
export type AdminGiftItem = {
  id: number
  publicId: string
  campaignId: number
  userId: number
  status: 'visible' | 'hidden_auto' | 'hidden_admin' | 'deleted'
  reportCount: number
  heartCount: number
  nickname: string
  className: string
  message: string
  createdAt: string
  layout: string
  font: string
  ink: string
  backgroundTemplateId: number | null
  /** True when the gift owner's account is currently banned. */
  userBanned: boolean
  /** Unacknowledged reports by reason (banned reporters excluded). */
  reportReasons: { inappropriate: number; spam: number; other: number }
}

/**
 * GET /api/admin/gifts?status=reported|hidden
 * reported → gifts with report_count ≥ 1 and not deleted (review queue).
 * hidden   → gifts with status hidden_auto or hidden_admin.
 */
export async function listAdminGifts(status: 'reported' | 'hidden'): Promise<AdminGiftItem[]> {
  return (await expectOk(await apiFetch(`/api/admin/gifts?status=${status}`))).json() as Promise<AdminGiftItem[]>
}

/**
 * PATCH /api/admin/gifts/<id>  { status: 'visible'|'hidden_admin'|'deleted' }
 * restore (→ visible): acknowledges existing reports, resets report_count.
 */
export async function updateAdminGiftStatus(
  id: number,
  status: 'visible' | 'hidden_admin' | 'deleted',
): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/gifts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  }))
}

/**
 * PATCH /api/admin/users/<id>  { banned: true|false }
 * ban=true:  saves status_before_ban, hides visible gifts to hidden_admin, deletes hearts
 *            with recounts, revokes sessions. Admin cannot ban themselves (→ 403).
 * ban=false: restores gift status from status_before_ban; hearts NOT restored.
 */
export async function banAdminUser(userId: number, banned: boolean): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ banned }),
  }))
}

// ── Admin tombstones (ADR-8: ban evasion; decision 2026-11-21) ───────────────

/** Tombstone entry returned by GET /api/admin/tombstones. */
export type AdminTombstoneItem = {
  id: number
  createdAt: string
}

/**
 * GET /api/admin/tombstones — list banned_identity tombstones (id + createdAt only).
 * These are accounts that were deleted while banned; sign-in with the same Google sub
 * is blocked. "Gỡ khóa" calls deleteAdminTombstone to allow the account to be recreated.
 * Requires Google session.
 */
export async function listAdminTombstones(): Promise<AdminTombstoneItem[]> {
  const data = await (await expectOk(await apiFetch('/api/admin/tombstones'))).json() as { tombstones: AdminTombstoneItem[] }
  return data.tombstones
}

/**
 * DELETE /api/admin/tombstones/<id> — remove a tombstone so the user can sign in again.
 * Requires Google session.
 */
export async function deleteAdminTombstone(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/tombstones/${id}`, { method: 'DELETE' }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Noel player API — gift_tree campaign reads and writes
// All writes need X-Requested-With: fetch (session cookie sent automatically).
// ══════════════════════════════════════════════════════════════════════════════

/** A gift item returned as part of the tree response. */
export type NoelGift = {
  rank: number
  place: 'tree' | 'ground'
  publicId: string
  heartCount: number
  nickname: string
  className: string
  boxStyle: number
  ornamentStyle: number
  layout: string
  backgroundTemplateId: number | null
  font: string
  ink: string
  message: string
  createdAt: string
}

/** A gift item without rank/place (from gift-by-id and gift-list endpoints). */
export type NoelGiftFlat = Omit<NoelGift, 'rank' | 'place'>

/** Response from GET /api/campaigns/<slug>/tree (ADR-7). */
export type NoelTreeData = {
  asOf: string
  /** Whether the campaign is currently accepting new gifts and hearts. */
  open: boolean
  gifts: NoelGift[]
  totals: { visible: number }
}

/** Response from GET /api/me?campaign=<slug> — includes per-campaign state. */
export type MeForCampaign = {
  user: MeUser | null
  isAdmin: boolean
  heartsLeft: number
  heartedGiftIds: string[]
}

/** Active template as returned by GET /api/campaigns/<slug>/templates. */
export type NoelTemplate = {
  id: number
  name: string
  layout: string
  /** slot → image token, as in the 20/11 template list (background only today). */
  images: Record<string, string>
}

/** Response from POST /api/gifts/<publicId>/heart. */
export type HeartResponse = {
  heartCount: number
  heartsLeft: number
  rank: number
}

/** Report reason enum. */
export type ReportReason = 'inappropriate' | 'spam' | 'other'

/**
 * GET /api/campaigns/<slug>/tree — polled every ~15 s while visible (ADR-7).
 * Cache-Control: public, max-age=5 on the server.
 */
export async function getNoelTree(slug: string, signal?: AbortSignal): Promise<NoelTreeData> {
  const url = `/api/campaigns/${encodeURIComponent(slug)}/tree?x=${Math.random().toString(36).slice(2)}`
  return (await expectOk(await fetch(url, signal ? { signal } : undefined))).json() as Promise<NoelTreeData>
}

/**
 * GET /api/me?campaign=<slug> — returns user, heartsLeft, heartedGiftIds.
 * Falls back gracefully (returns anonymous state) on network errors.
 */
export async function getMeForCampaign(slug: string): Promise<MeForCampaign> {
  const res = await fetch(`/api/me?campaign=${encodeURIComponent(slug)}`, {
    headers: { 'X-Requested-With': 'fetch' },
  })
  if (!res.ok) return { user: null, isAdmin: false, heartsLeft: 5, heartedGiftIds: [] }
  return res.json() as Promise<MeForCampaign>
}

/**
 * GET /api/campaigns/<slug>/templates — returns active templates for the campaign.
 * Used to look up template names for gift cards.
 */
export async function getNoelTemplates(slug: string): Promise<NoelTemplate[]> {
  return (await expectOk(await fetch(`/api/campaigns/${encodeURIComponent(slug)}/templates`))).json() as Promise<NoelTemplate[]>
}

/**
 * GET /api/gifts/<publicId> — fetch a single gift by public id.
 * Returns 404 for hidden/deleted gifts (except to owner/admin).
 */
export async function getGiftByPublicId(publicId: string): Promise<NoelGiftFlat> {
  return (await expectOk(await fetch(`/api/gifts/${encodeURIComponent(publicId)}`))).json() as Promise<NoelGiftFlat>
}

/**
 * POST /api/gifts/<publicId>/heart — give a heart to a gift (ADR-7).
 * Throws ApiError on failure (codes: gift_not_found, campaign_closed, banned,
 * own_gift, already_hearted, hearts_exhausted, rate_limited).
 */
export async function heartGift(publicId: string): Promise<HeartResponse> {
  return (await sessionExpectOk(await sessionFetch(`/api/gifts/${encodeURIComponent(publicId)}/heart`, { method: 'POST' }))).json() as Promise<HeartResponse>
}

/**
 * POST /api/gifts/<publicId>/report — report a gift (ADR-8).
 * Throws ApiError on failure (codes: gift_not_found, campaign_closed, banned,
 * already_reported, rate_limited).
 */
export async function reportGift(publicId: string, reason: ReportReason): Promise<void> {
  await sessionExpectOk(await sessionFetch(`/api/gifts/${encodeURIComponent(publicId)}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  }))
}

/**
 * GET /api/me/gifts?campaign=<slug> — returns the signed-in user's own gifts with rank.
 * Extension point for Part B (my-gifts flow).
 */
export async function getMyGifts(slug: string): Promise<Array<NoelGift & { status: string }>> {
  const res = await sessionFetch(`/api/me/gifts?campaign=${encodeURIComponent(slug)}`)
  if (!res.ok) return []
  const data = await res.json() as { gifts: Array<NoelGift & { status: string }> }
  return data.gifts ?? []
}

// ── Noel player write API (Part B) ────────────────────────────────────────────

/** Input shape for POST /api/campaigns/<slug>/gifts. */
export type CreateGiftInput = {
  boxStyle: number
  ornamentStyle: number
  layout: string
  backgroundTemplateId: number
  font: string
  ink: string
  message: string
  nickname: string
  className: string
}

/**
 * POST /api/campaigns/<slug>/gifts — create a gift (FR-19, AC-10).
 * Throws ApiError on failure (codes: limit_reached 409, daily_limit 429,
 * campaign_closed 409, banned 403, bad_request 400, unauthorized 401, rate_limited 429).
 */
export async function createGift(
  slug: string,
  input: CreateGiftInput,
): Promise<{ publicId: string }> {
  return (
    await sessionExpectOk(
      await sessionFetch(`/api/campaigns/${encodeURIComponent(slug)}/gifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
  ).json() as Promise<{ publicId: string }>
}

/**
 * DELETE /api/gifts/<publicId> — owner deletes their own visible gift (ADR-8).
 * Throws ApiError on failure (codes: not_found 404, pending_review 409, unauthorized 401).
 */
export async function deleteMyGift(publicId: string): Promise<void> {
  await sessionExpectOk(
    await sessionFetch(`/api/gifts/${encodeURIComponent(publicId)}`, { method: 'DELETE' }),
  )
}

/**
 * DELETE /api/me — delete the signed-in user's account (FR-13, ADR-8).
 * Throws ApiError on failure (codes: pending_review 409 — has hidden gifts).
 */
export async function deleteMyAccount(): Promise<void> {
  await sessionExpectOk(await sessionFetch('/api/me', { method: 'DELETE' }))
}

/**
 * GET /api/campaigns/<slug>/gifts?sort=hearts|new&page= — paginated gift list (24/page).
 * Throws ApiError for 400 (invalid page); returns [] for other errors.
 */
export async function getGiftList(
  slug: string,
  sort: 'hearts' | 'new',
  page: number,
): Promise<NoelGiftFlat[]> {
  const url = `/api/campaigns/${encodeURIComponent(slug)}/gifts?sort=${sort}&page=${page}`
  const res = await fetch(url)
  if (!res.ok) {
    let code = 'unknown'
    try {
      const b = (await res.json()) as { error?: string }
      code = b.error ?? 'unknown'
    } catch { /* ignore */ }
    throw new ApiError(res.status, code)
  }
  const data = (await res.json()) as { gifts: NoelGiftFlat[] }
  return data.gifts ?? []
}

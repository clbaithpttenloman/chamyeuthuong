/**
 * Typed fetch client for the backend API.
 *
 * Public endpoints: no auth headers.
 * Admin endpoints (/api/admin/*): X-Admin-Email + X-Requested-With (CSRF).
 */
import type {
  AboutContent,
  AdminCard,
  AdminTeacher,
  AdminTeacherInput,
  AdminTemplate,
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

export type { AboutContent, AdminCard, AdminTeacher, AdminTeacherInput, AdminTemplate, AdminTemplateInput,
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

// ── sessionStorage email helpers ─────────────────────────────────────────

const EMAIL_KEY = 'adminEmail'

export function getAdminEmail(): string | null {
  return sessionStorage.getItem(EMAIL_KEY)
}

export function setAdminEmail(email: string): void {
  sessionStorage.setItem(EMAIL_KEY, email)
}

export function clearAdminEmail(): void {
  sessionStorage.removeItem(EMAIL_KEY)
}

// ── Core fetch helpers ────────────────────────────────────────────────────

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    'X-Requested-With': 'fetch',
  }
  const email = getAdminEmail()
  if (email) headers['X-Admin-Email'] = email
  return fetch(path, { ...init, headers })
}

async function expectOk(res: Response): Promise<Response> {
  if (!res.ok) {
    if (res.status === 401) clearAdminEmail()
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

// Typed fetch client for the backend API.
// Admin routes require an admin email (X-Admin-Email: <email>).
// Every /api/admin/* request also includes X-Requested-With: fetch as
// CSRF defence in depth.

export type TeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  message: string
  status: 'draft' | 'published'
  created_at: string
  layout: string
  title: 'Thầy' | 'Cô' | null
  images: Partial<Record<string, { id: number; token: string }>>
}

export type CardData = {
  name: string
  subject: string
  message: string
  layout: string
  title: 'Thầy' | 'Cô' | null
  images: Partial<Record<string, string>>  // slot → image token
}

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

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`)
  }
}

// ── sessionStorage email helpers ─────────────────────────────────────────

const EMAIL_KEY = 'adminEmail'

/** Read the stored admin email, or null if not set. */
export function getAdminEmail(): string | null {
  return sessionStorage.getItem(EMAIL_KEY)
}

/** Store the admin email (trim and lower-case before calling). Called by Admin.tsx on form submit. */
export function setAdminEmail(email: string): void {
  sessionStorage.setItem(EMAIL_KEY, email)
}

/** Clear the stored email (sign-out or 401 response). Called by Admin.tsx and expectOk. */
export function clearAdminEmail(): void {
  sessionStorage.removeItem(EMAIL_KEY)
}

// ── Core fetch helpers ────────────────────────────────────────────────────

/** All admin API calls go through here; X-Admin-Email + CSRF headers always present. */
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
    } catch { /* ignore parse errors */ }
    throw new ApiError(res.status, code)
  }
  return res
}

/** Fetch a public card by its token. Returns null for 404. */
export async function getCard(token: string): Promise<CardData | null> {
  const res = await fetch(`/api/card/${encodeURIComponent(token)}`)
  if (res.status === 404) return null
  await expectOk(res)
  return res.json() as Promise<CardData>
}

/** List all teachers (requires admin email). */
export async function listTeachers(): Promise<TeacherRow[]> {
  return (await expectOk(await apiFetch('/api/admin/teachers'))).json() as Promise<TeacherRow[]>
}

/** Create a teacher with a card. */
export async function createTeacher(data: {
  name: string
  subject?: string
  message?: string
  layout?: string
  images?: Partial<Record<string, number>>
  status?: string
  title: 'Thầy' | 'Cô'
}): Promise<TeacherRow> {
  return (await expectOk(await apiFetch('/api/admin/teachers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }))).json() as Promise<TeacherRow>
}

/** Update a teacher's card fields. Layout and images are optional partial updates. */
export async function updateTeacher(
  id: number,
  data: {
    name: string
    subject: string
    message: string
    status: string
    layout?: string
    images?: Partial<Record<string, number | null>>
    title?: 'Thầy' | 'Cô'
  },
): Promise<TeacherRow> {
  return (await expectOk(await apiFetch(`/api/admin/teachers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }))).json() as Promise<TeacherRow>
}

/** Issue a new QR token for a teacher. */
export async function rotateTeacherToken(id: number): Promise<{ token: string }> {
  return (await expectOk(await apiFetch(`/api/admin/teachers/${id}/rotate`, {
    method: 'POST',
  }))).json() as Promise<{ token: string }>
}

/** Delete a teacher and their card. */
export async function deleteTeacher(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/teachers/${id}`, { method: 'DELETE' }))
}

// ── Admin management ─────────────────────────────────────────────────────────

export type AdminRow = {
  id: number
  email: string
  created_at: string
  created_by: string
}

/** List all admins (requires admin email). */
export async function listAdmins(): Promise<AdminRow[]> {
  return (await expectOk(await apiFetch('/api/admin/admins'))).json() as Promise<AdminRow[]>
}

/** Add an admin by email. Throws ApiError 409 on duplicate, 400 on invalid email. */
export async function addAdmin(email: string): Promise<AdminRow> {
  return (await expectOk(await apiFetch('/api/admin/admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  }))).json() as Promise<AdminRow>
}

/** Remove an admin by id. Throws ApiError 409 if last admin, 404 if unknown. */
export async function removeAdmin(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/admins/${id}`, { method: 'DELETE' }))
}

// ── Images ───────────────────────────────────────────────────────────────────

/** List all images in the library (metadata only, no image data). */
export async function listImages(): Promise<ImageRow[]> {
  return (await expectOk(await apiFetch('/api/admin/images'))).json() as Promise<ImageRow[]>
}

/**
 * Upload an image to the library.
 * Sends raw bytes as the request body with the blob's MIME type as Content-Type.
 * The name is passed as a query parameter (≤ 80 chars).
 */
export async function uploadImage(blob: Blob, name: string): Promise<ImageRow> {
  return (await expectOk(await apiFetch(
    `/api/admin/images?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': blob.type },
      body: blob,
    },
  ))).json() as Promise<ImageRow>
}

/** Delete an image from the library. Throws ApiError 409 if the image is in use. */
export async function deleteImage(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/images/${id}`, { method: 'DELETE' }))
}

// ── Wishes ───────────────────────────────────────────────────────────────────

/** List all wishes in the library. */
export async function listWishes(): Promise<WishRow[]> {
  return (await expectOk(await apiFetch('/api/admin/wishes'))).json() as Promise<WishRow[]>
}

/** Create a new wish. title ≤ 80, body ≤ 600, both non-empty. */
export async function createWish(title: string, body: string): Promise<WishRow> {
  return (await expectOk(await apiFetch('/api/admin/wishes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  }))).json() as Promise<WishRow>
}

/** Update a wish. */
export async function updateWish(id: number, title: string, body: string): Promise<WishRow> {
  return (await expectOk(await apiFetch(`/api/admin/wishes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  }))).json() as Promise<WishRow>
}

/** Delete a wish by id. */
export async function deleteWish(id: number): Promise<void> {
  await expectOk(await apiFetch(`/api/admin/wishes/${id}`, { method: 'DELETE' }))
}

// ── Bulk create ───────────────────────────────────────────────────────────────

/** Create up to 100 teachers in a single batch (all-or-nothing). */
export async function bulkCreateTeachers(data: {
  items: Array<{ name: string; subject?: string; message?: string; title: 'Thầy' | 'Cô' }>
  layout?: string
  images?: Partial<Record<string, number>>
  status?: string
}): Promise<{ created: TeacherRow[] }> {
  return (await expectOk(await apiFetch('/api/admin/teachers/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }))).json() as Promise<{ created: TeacherRow[] }>
}

// Typed fetch client for the backend API.
// Admin routes are protected by Cloudflare Access (JWT in Cf-Access-Jwt-Assertion).
// Every /api/admin/* request includes X-Requested-With: fetch as CSRF protection.

export type TeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  message: string
  status: 'draft' | 'published'
  created_at: string
}

export type CardData = {
  name: string
  subject: string
  message: string
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`)
  }
}

/** All admin API calls go through here; the CSRF header is always present. */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
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

/** List all teachers (requires Access JWT via Cloudflare Access). */
export async function listTeachers(): Promise<TeacherRow[]> {
  return (await expectOk(await apiFetch('/api/admin/teachers'))).json() as Promise<TeacherRow[]>
}

/** Create a teacher with a draft card. */
export async function createTeacher(name: string, subject?: string): Promise<TeacherRow> {
  return (await expectOk(await apiFetch('/api/admin/teachers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, subject }),
  }))).json() as Promise<TeacherRow>
}

/** Update a teacher's card fields. */
export async function updateTeacher(
  id: number,
  data: { name: string; subject: string; message: string; status: string },
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

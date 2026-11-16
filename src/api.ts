// Typed fetch client for the backend API.
// A 401 response automatically clears the stored admin token so callers
// can re-render to the login form by checking getToken() === null.

export type TeacherRow = {
  id: number
  token: string
  name: string
  subject: string
  message: string
  status: 'draft' | 'published'
  created_at: string
  updated_at?: string
}

export type CardData = {
  name: string
  subject: string
  message: string
}

const SESSION_KEY = 'admin_token'

export function getToken(): string | null {
  return sessionStorage.getItem(SESSION_KEY)
}

export function setToken(token: string): void {
  sessionStorage.setItem(SESSION_KEY, token)
}

export function clearToken(): void {
  sessionStorage.removeItem(SESSION_KEY)
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`${status}: ${code}`)
  }
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const tok = getToken()
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (tok) headers['Authorization'] = `Bearer ${tok}`
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) clearToken()
  return res
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

/** List all teachers (requires admin token in sessionStorage). */
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

export type ErrorCode = 'bad_request' | 'unauthorized' | 'not_found' | 'too_long' | 'rate_limited' | 'method' | 'unavailable'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  too_long: 413,
  method: 405,
  rate_limited: 429,
  unavailable: 503,
}

/** Security headers required on every /api/* response (plan: Threat Model). */
const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: BASE_HEADERS })

export const error = (code: ErrorCode): Response =>
  new Response(JSON.stringify({ error: code }), { status: STATUS[code], headers: BASE_HEADERS })

/** Thrown by readJson when the body is too large or invalid JSON. */
export class HttpError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(code)
  }
}

/**
 * Reads the request body up to `limit` bytes and parses it as JSON.
 * Throws HttpError('too_long') if the body exceeds `limit`.
 * Throws HttpError('bad_request') if the body is not valid JSON.
 * Returns an empty object if the body is absent or empty.
 */
export async function readJson<T>(request: Request, limit: number): Promise<T> {
  const body = request.body
  if (!body) return {} as T

  const reader = body.getReader()
  let total = 0
  const chunks: Uint8Array[] = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      reader.cancel().catch(() => {})
      throw new HttpError('too_long')
    }
    chunks.push(value)
  }

  if (total === 0) return {} as T

  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(all))
    if (parsed === null || Array.isArray(parsed)) throw new HttpError('bad_request')
    return parsed as T
  } catch (e) {
    if (e instanceof HttpError) throw e
    throw new HttpError('bad_request')
  }
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'too_long'
  | 'rate_limited'
  | 'method'
  | 'unavailable'
  | 'conflict'

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  too_long: 413,
  method: 405,
  rate_limited: 429,
  unavailable: 503,
  conflict: 409,
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

/**
 * Reads the raw request body as bytes, up to `limit` bytes.
 * Early-rejects on Content-Length > limit (plan § Amendments).
 * Throws HttpError('bad_request') if the body exceeds `limit` bytes actually read.
 * Returns an empty Uint8Array when the body is absent.
 */
export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const cl = request.headers.get('Content-Length')
  if (cl !== null) {
    const len = parseInt(cl, 10)
    if (!isNaN(len) && len > limit) throw new HttpError('bad_request')
  }

  const body = request.body
  if (!body) return new Uint8Array(0)

  const reader = body.getReader()
  let total = 0
  const chunks: Uint8Array[] = []

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      reader.cancel().catch(() => {})
      throw new HttpError('bad_request')
    }
    chunks.push(value)
  }

  const all = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return all
}

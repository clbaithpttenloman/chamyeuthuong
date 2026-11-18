/**
 * worker/about.ts — About content endpoints.
 *
 * Public:  GET  /api/about        — PUBLIC_IP_LIMIT, falls back to ABOUT_SEED on bad stored JSON
 * Admin:   GET  /api/admin/about  — returns stored content (or seed fallback)
 *          PUT  /api/admin/about  — full replace with validation; sets updated_at / updated_by
 *
 * Validation is shared between PUT and GET-on-read so a corrupt row never serves bad data.
 * Text helpers are imported from shared/text.ts (same rules as submit.ts).
 */
import { error, json, HttpError } from './http.ts'
import { ensureSchema } from './schema.ts'
import { ABOUT_SEED } from './aboutSeed.ts'
import {
  hasControlCharsSingleLine,
  hasControlCharsMultiline,
  hasLoneSurrogate,
} from '../shared/text.ts'
import {
  ABOUT_HEADING_MAX, ABOUT_INTRO_MAX,
  ABOUT_STATS_MAX, ABOUT_STAT_VALUE_MAX, ABOUT_STAT_LABEL_MAX,
  ABOUT_STEPS_MAX, ABOUT_STEP_WHEN_MAX, ABOUT_STEP_TEXT_MAX,
  ABOUT_MEMBERS_MAX, ABOUT_MEMBER_NAME_MAX, ABOUT_MEMBER_ROLE_MAX,
  ABOUT_BODY_MAX, ABOUT_NEWLINES_MAX,
  type AboutContent,
} from '../shared/api.ts'
import type { Env } from './types.ts'

/** All recognised top-level keys for the about content. */
const ABOUT_KEYS = new Set(['heading', 'intro', 'stats', 'stepsHeading', 'steps', 'membersHeading', 'members'])

/** Newline count in a string. */
function countNewlines(s: string): number {
  return (s.match(/\n/g) ?? []).length
}

/**
 * Validates and normalises an AboutContent payload.
 * Returns the normalised object on success, or throws HttpError('bad_request').
 * Also used on DB read to validate stored content; throws for invalid shape.
 */
function validateAbout(raw: unknown): AboutContent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError('bad_request')
  const obj = raw as Record<string, unknown>

  // No unknown keys
  for (const key of Object.keys(obj)) {
    if (!ABOUT_KEYS.has(key)) throw new HttpError('bad_request')
  }

  // ---- heading ----
  const heading = typeof obj.heading === 'string' ? obj.heading.normalize('NFC').trim() : null
  if (!heading || heading.length < 1 || heading.length > ABOUT_HEADING_MAX) throw new HttpError('bad_request')
  if (hasControlCharsSingleLine(heading) || hasLoneSurrogate(heading)) throw new HttpError('bad_request')

  // ---- intro ----
  const intro = typeof obj.intro === 'string' ? obj.intro.normalize('NFC').trim() : null
  if (!intro || intro.length < 1 || intro.length > ABOUT_INTRO_MAX) throw new HttpError('bad_request')
  if (hasControlCharsMultiline(intro) || hasLoneSurrogate(intro)) throw new HttpError('bad_request')
  if (countNewlines(intro) > ABOUT_NEWLINES_MAX) throw new HttpError('bad_request')

  // ---- stats ----
  if (!Array.isArray(obj.stats) || obj.stats.length > ABOUT_STATS_MAX) throw new HttpError('bad_request')
  const stats = (obj.stats as unknown[]).map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError('bad_request')
    const st = s as Record<string, unknown>
    const value = typeof st.value === 'string' ? st.value.normalize('NFC').trim() : null
    const label = typeof st.label === 'string' ? st.label.normalize('NFC').trim() : null
    if (!value || value.length < 1 || value.length > ABOUT_STAT_VALUE_MAX) throw new HttpError('bad_request')
    if (!label || label.length < 1 || label.length > ABOUT_STAT_LABEL_MAX) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(value) || hasLoneSurrogate(value)) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(label) || hasLoneSurrogate(label)) throw new HttpError('bad_request')
    return { value, label }
  })

  // ---- stepsHeading ----
  const stepsHeading = typeof obj.stepsHeading === 'string' ? obj.stepsHeading.normalize('NFC').trim() : null
  if (!stepsHeading || stepsHeading.length < 1 || stepsHeading.length > ABOUT_HEADING_MAX) throw new HttpError('bad_request')
  if (hasControlCharsSingleLine(stepsHeading) || hasLoneSurrogate(stepsHeading)) throw new HttpError('bad_request')

  // ---- steps ----
  if (!Array.isArray(obj.steps) || obj.steps.length > ABOUT_STEPS_MAX) throw new HttpError('bad_request')
  const steps = (obj.steps as unknown[]).map((s) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError('bad_request')
    const st = s as Record<string, unknown>
    const when = typeof st.when === 'string' ? st.when.normalize('NFC').trim() : null
    const title = typeof st.title === 'string' ? st.title.normalize('NFC').trim() : null
    const text = typeof st.text === 'string' ? st.text.normalize('NFC').trim() : ''
    if (!when || when.length < 1 || when.length > ABOUT_STEP_WHEN_MAX) throw new HttpError('bad_request')
    if (!title || title.length < 1 || title.length > ABOUT_HEADING_MAX) throw new HttpError('bad_request')
    if (text.length > ABOUT_STEP_TEXT_MAX) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(when) || hasLoneSurrogate(when)) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(title) || hasLoneSurrogate(title)) throw new HttpError('bad_request')
    if (text && (hasControlCharsMultiline(text) || hasLoneSurrogate(text))) throw new HttpError('bad_request')
    if (countNewlines(text) > ABOUT_NEWLINES_MAX) throw new HttpError('bad_request')
    return { when, title, text }
  })

  // ---- membersHeading ----
  const membersHeading = typeof obj.membersHeading === 'string' ? obj.membersHeading.normalize('NFC').trim() : null
  if (!membersHeading || membersHeading.length < 1 || membersHeading.length > ABOUT_HEADING_MAX) throw new HttpError('bad_request')
  if (hasControlCharsSingleLine(membersHeading) || hasLoneSurrogate(membersHeading)) throw new HttpError('bad_request')

  // ---- members ----
  if (!Array.isArray(obj.members) || obj.members.length > ABOUT_MEMBERS_MAX) throw new HttpError('bad_request')
  const members = (obj.members as unknown[]).map((m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new HttpError('bad_request')
    const mt = m as Record<string, unknown>
    const name = typeof mt.name === 'string' ? mt.name.normalize('NFC').trim() : null
    const role = typeof mt.role === 'string' ? mt.role.normalize('NFC').trim() : null
    if (!name || name.length < 1 || name.length > ABOUT_MEMBER_NAME_MAX) throw new HttpError('bad_request')
    if (!role || role.length < 1 || role.length > ABOUT_MEMBER_ROLE_MAX) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(name) || hasLoneSurrogate(name)) throw new HttpError('bad_request')
    if (hasControlCharsSingleLine(role) || hasLoneSurrogate(role)) throw new HttpError('bad_request')
    return { name, role }
  })

  return { heading, intro, stats, stepsHeading, steps, membersHeading, members }
}

/**
 * Read about content from D1. Returns the seed if the row is absent, corrupt, or wrong-shaped.
 */
async function readAbout(db: Env['DB']): Promise<AboutContent> {
  await ensureSchema(db)
  const row = await db
    .prepare("SELECT value FROM site_content WHERE key = 'about'")
    .first<{ value: string }>()
  if (!row) return ABOUT_SEED
  try {
    const parsed: unknown = JSON.parse(row.value)
    return validateAbout(parsed)
  } catch {
    return ABOUT_SEED
  }
}

/**
 * GET /api/about — public endpoint, rate-limited via PUBLIC_IP_LIMIT.
 */
export async function handleAbout(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return error('method')

  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const { success } = await env.PUBLIC_IP_LIMIT.limit({ key: ip })
  if (!success) return error('rate_limited')

  const content = await readAbout(env.DB)
  return json(content)
}

/**
 * GET /api/admin/about  — returns current stored content (or seed fallback).
 * PUT /api/admin/about  — full replace: validates, stores, returns stored content.
 * Auth has already been checked by handleAdmin; `email` is the authenticated caller.
 */
export async function handleAdminAbout(request: Request, env: Env, email: string): Promise<Response> {
  const { method } = request

  if (method === 'GET') {
    const content = await readAbout(env.DB)
    return json(content)
  }

  if (method !== 'PUT') return error('method')

  // ---- PUT ----
  // Body size check (≤ 16 KB)
  const cl = request.headers.get('Content-Length')
  if (cl !== null) {
    const len = parseInt(cl, 10)
    if (!isNaN(len) && len > ABOUT_BODY_MAX) return error('bad_request')
  }

  const bodyText = await request.text().catch(() => '')
  if (bodyText.length > ABOUT_BODY_MAX) return error('bad_request')

  let parsed: unknown
  try { parsed = JSON.parse(bodyText) } catch { return error('bad_request') }

  let content: AboutContent
  try {
    content = validateAbout(parsed)
  } catch (e) {
    if (e instanceof HttpError) return error(e.code)
    return error('bad_request')
  }

  const now = new Date().toISOString()
  const valueJson = JSON.stringify(content)

  await ensureSchema(env.DB)
  await env.DB
    .prepare(
      'INSERT INTO site_content (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
    )
    .bind('about', valueJson, now, email)
    .run()

  return json(content)
}

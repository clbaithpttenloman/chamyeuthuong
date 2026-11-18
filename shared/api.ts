/**
 * Shared API types, constants, and helpers for the student cards platform.
 * Used by both the worker (backend) and the React frontend.
 */

// ---- Constants ----

/** Maximum message length in Unicode code points. */
export const MAX_MESSAGE = 300
/** Maximum fromName length in Unicode code points. */
export const MAX_FROM_NAME = 40
/** Maximum fromClass length in Unicode code points. */
export const MAX_FROM_CLASS = 10
/** Maximum newlines allowed in message. */
export const MAX_NEWLINES = 5
/** Global pending card cap. */
export const PENDING_CAP = 2000
/** Per-teacher pending card cap. */
export const PENDING_CAP_PER_TEACHER = 200
/** Maximum cards returned per page (approved/hidden list, QR page). */
export const PAGE_SIZE = 200
/** Maximum IDs in a bulk review request. */
export const MAX_REVIEW_IDS = 200

// ---- AboutContent constants ----

/** Maximum length for heading / stepsHeading / membersHeading / step title fields. */
export const ABOUT_HEADING_MAX = 80
/** Maximum length for the intro paragraph. */
export const ABOUT_INTRO_MAX = 600
/** Maximum number of stat entries. */
export const ABOUT_STATS_MAX = 6
/** Maximum length for a stat value string. */
export const ABOUT_STAT_VALUE_MAX = 12
/** Maximum length for a stat label string. */
export const ABOUT_STAT_LABEL_MAX = 40
/** Maximum number of step entries. */
export const ABOUT_STEPS_MAX = 20
/** Maximum length for a step "when" string. */
export const ABOUT_STEP_WHEN_MAX = 20
/** Maximum length for a step "text" (body) — may be empty. */
export const ABOUT_STEP_TEXT_MAX = 400
/** Maximum number of member entries. */
export const ABOUT_MEMBERS_MAX = 40
/** Maximum length for a member name. */
export const ABOUT_MEMBER_NAME_MAX = 60
/** Maximum length for a member role. */
export const ABOUT_MEMBER_ROLE_MAX = 60
/** Maximum JSON body size for the about payload (16 KB). */
export const ABOUT_BODY_MAX = 16384
/** Maximum newlines allowed in multiline about fields (intro, steps[].text). */
export const ABOUT_NEWLINES_MAX = 10

// ---- Public card types ----

/**
 * Public card shape returned by all public endpoints.
 * Raw name/class fields are never returned; use `from` instead.
 */
export type PublicCard = {
  publicId: string
  layout: string
  images: Record<string, string>  // slot → imageToken
  message: string
  /** Server-constructed display string; see formatFrom(). */
  from: string
  createdAt: string
}

/** Teacher summary in the wall response (show_on_home=1 only). */
export type WallTeacher = {
  id: number
  title: string | null
  name: string
  subject: string
  department: string
  cardCount: number
}

/** Response from GET /api/wall */
export type WallResponse = {
  teachers: WallTeacher[]
  totals: { teachers: number; cards: number }
}

/** Teacher profile in the QR endpoint response (no publicId — the token IS the private key). */
export type TeacherProfile = {
  id: number
  title: string | null
  name: string
  subject: string
  department: string
}

/** Response from GET /api/qr/:token */
export type QrResponse = {
  teacher: TeacherProfile
  /** All approved cards, newest first, max 200. */
  cards: PublicCard[]
  total: number
}

/** Active template as returned by GET /api/templates */
export type TemplatePublic = {
  id: number
  name: string
  layout: string
  images: Record<string, string>  // slot → imageToken
}

/** Wish as returned by GET /api/wishes (created_by is never returned). */
export type WishPublic = {
  id: number
  title: string
  body: string
}

/**
 * Request body for POST /api/cards.
 * Exactly one of teacherId or teacherToken must be present:
 *   - teacherId (positive integer): only teachers with show_on_home = 1
 *   - teacherToken (16-char QR token): any teacher (used by ?t=<token> flow)
 * Providing both or neither → 400.
 */
export type SubmitCardRequest = {
  teacherId?: number
  teacherToken?: string
  templateId: number
  message: string
  fromName?: string
  fromClass?: string
  anonymous?: boolean
}

// ---- AboutContent ----

/** Shape of the site's "about" content stored in D1 and served by GET /api/about. */
export type AboutContent = {
  heading: string
  intro: string
  stats: Array<{ value: string; label: string }>
  stepsHeading: string
  steps: Array<{ when: string; title: string; text: string }>
  membersHeading: string
  members: Array<{ name: string; role: string }>
}

// ---- Admin types ----

/** Teacher record in admin API responses. */
export type AdminTeacher = {
  id: number
  token: string
  title: 'Thầy' | 'Cô' | null
  name: string
  subject: string
  department: string
  showOnHome: 0 | 1
  cardCounts: { pending: number; approved: number; hidden: number }
  created_at: string
}

/** Input body for creating a teacher (title required). */
export type AdminTeacherInput = {
  title: 'Thầy' | 'Cô'
  name: string
  subject?: string
  department?: string
  showOnHome?: 0 | 1
}

/** One item in a bulk teacher-add request (showOnHome defaults to 1 for all). */
export type BulkTeacherInputItem = {
  title: 'Thầy' | 'Cô'
  name: string
  subject?: string
  department?: string
}

/** Request body for POST /api/admin/teachers/bulk */
export type BulkTeacherRequest = {
  items: BulkTeacherInputItem[]
}

/** Template record in admin API responses. */
export type AdminTemplate = {
  id: number
  name: string
  layout: string
  active: 0 | 1
  images: Record<string, { id: number; token: string }>
  created_at: string
  created_by: string
}

/** Input body for creating/updating a template. */
export type AdminTemplateInput = {
  name: string
  layout: string
  active?: 0 | 1
  images?: Record<string, number | null>  // slot → imageId (null removes slot)
}

/** Card record in admin moderation API (includes raw student-submitted fields). */
export type AdminCard = {
  id: number
  publicId: string
  teacherId: number
  templateId: number
  message: string
  fromName: string
  fromClass: string
  anonymous: boolean
  status: 'pending' | 'approved' | 'hidden'
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  teacher: { id: number; name: string; title: string | null }
  template: { id: number; name: string; layout: string }
}

/** Body for POST /api/admin/cards/review (bulk status change via json_each). */
export type ReviewRequest = {
  ids: number[]
  status: 'approved' | 'hidden'
}

/** API error code returned in { error: ... } response bodies. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'too_long'
  | 'rate_limited'
  | 'method'
  | 'unavailable'
  | 'conflict'

// ---- Helpers ----

/**
 * Build the public `from` string shown on a card.
 *
 * Rules (plan § Decision: Public API):
 * - `anonymous` is true OR `fromName` is blank → "Một bạn học sinh"
 *   - with non-blank `fromClass`: "Một bạn học sinh · {class}"
 * - Otherwise (named, non-anonymous):
 *   - with non-blank `fromClass`: "{name} · {class}"
 *   - without `fromClass`: "{name}"
 *
 * The separator ` · ` uses Unicode MIDDLE DOT (U+00B7).
 */
export function formatFrom(opts: { fromName: string; fromClass: string; anonymous: boolean }): string {
  const name = opts.fromName.trim()
  const cls = opts.fromClass.trim()
  if (opts.anonymous || !name) {
    return cls ? `Một bạn học sinh · ${cls}` : 'Một bạn học sinh'
  }
  return cls ? `${name} · ${cls}` : name
}

/**
 * Build the subject label shown on teacher tiles and card headings.
 * Returns 'GV môn: <subject>' when subject is non-empty, '' otherwise.
 */
export function subjectLabel(subject: string): string {
  const s = subject.trim()
  return s ? `GV môn: ${s}` : ''
}

/** Lowercase, NFC, collapse spaces, drop a leading "tổ " — for comparing môn and tổ. */
const norm = (v: string) => v.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/^tổ /, '')

/**
 * Department line for a teacher tile. Returns "" when it only repeats the
 * subject (e.g. môn "Toán", tổ "Toán" or "Tổ Toán"), so the tile shows one line.
 */
export function departmentLabel(subject: string, department: string): string {
  const d = department.trim()
  if (!d) return ''
  return subject.trim() && norm(subject) === norm(d) ? '' : d
}

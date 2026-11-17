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
/** Maximum cards returned per page (approved/hidden list, teacher page). */
export const PAGE_SIZE = 200
/** Maximum IDs in a bulk review request. */
export const MAX_REVIEW_IDS = 200

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

/**
 * Card in the wall `latest` list — adds a teacher reference.
 * The teacher's private QR token is NEVER included.
 */
export type WallLatestCard = PublicCard & {
  teacher: { publicId: string; title: string | null; name: string }
}

/** Teacher summary in the wall response. */
export type WallTeacher = {
  publicId: string
  title: string | null
  name: string
  subject: string
  department: string
  cardCount: number
}

/** Response from GET /api/wall */
export type WallResponse = {
  teachers: WallTeacher[]
  /** Up to 6 items, one per teacher (show_on_home=1 only), newest first. */
  latest: WallLatestCard[]
  totals: { teachers: number; cards: number }
}

/** Teacher profile included in teacher-page and QR responses. */
export type TeacherProfile = {
  publicId: string
  title: string | null
  name: string
  subject: string
  department: string
}

/** Response from GET /api/teachers/:publicId */
export type TeacherPageResponse = {
  teacher: TeacherProfile
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

/** Request body for POST /api/cards */
export type SubmitCardRequest = {
  teacherPublicId: string
  templateId: number
  message: string
  fromName?: string
  fromClass?: string
  anonymous?: boolean
}

/** Response from GET /api/qr/:token */
export type QrResponse = {
  teacher: TeacherProfile
  card: PublicCard | null
  total: number
}

// ---- Admin types ----

/** Teacher record in admin API responses. */
export type AdminTeacher = {
  id: number
  token: string
  publicId: string
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
  teacher: { id: number; publicId: string; name: string; title: string | null }
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

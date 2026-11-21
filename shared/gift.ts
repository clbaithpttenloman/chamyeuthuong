/**
 * shared/gift.ts — gift text validation shared between worker and client.
 *
 * No worker imports — keep this module pure so the client can import it.
 *
 * Usage:
 *   import { validateGiftText, MAX_GIFT_MESSAGE, MAX_GIFT_NICKNAME, MAX_GIFT_CLASSNAME } from '../shared/gift.ts'
 *
 *   const result = validateGiftText({ message, nickname, className })
 *   if (!result.ok) { return; // result.field names the failing field }
 *   const { message: msg, nickname: nick, className: cls } = result.value
 */

import {
  hasControlCharsSingleLine,
  hasControlCharsMultiline,
  hasLoneSurrogate,
} from './text.ts'
import { MAX_MESSAGE, MAX_FROM_CLASS } from './api.ts'

// ── Limits (export so the client can display them) ────────────────────────────

/** Maximum gift message length in Unicode code points (from shared/api.ts MAX_MESSAGE). */
export const MAX_GIFT_MESSAGE = MAX_MESSAGE    // 300

/** Maximum gift sender nickname length in Unicode code points. */
export const MAX_GIFT_NICKNAME = 30

/** Maximum gift sender class name length in Unicode code points (from shared/api.ts MAX_FROM_CLASS). */
export const MAX_GIFT_CLASSNAME = MAX_FROM_CLASS  // 10

// ── Types ─────────────────────────────────────────────────────────────────────

/** Normalized, validated gift text fields. */
export type ValidatedGiftText = { message: string; nickname: string; className: string }

type GiftTextInput = { message: string; nickname: string; className: string }

/** Returned by validateGiftText on success. */
export type GiftTextOk = { ok: true; value: ValidatedGiftText }

/** Returned by validateGiftText on the first field that fails validation. */
export type GiftTextFail = { ok: false; field: 'message' | 'nickname' | 'className' }

/** Union result of validateGiftText. */
export type GiftTextResult = GiftTextOk | GiftTextFail

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates and normalises gift text fields.
 *
 * Rules applied to every field:
 *   - Unicode NFC normalisation + trim
 *   - Reject empty-after-trim
 *   - Code-point length check (not UTF-16 code-unit length)
 *   - Reject control / bidi / zero-width / lone-surrogate characters (shared/text.ts)
 *
 * message:   1–300 code points, multiline allowed (control chars except \n rejected)
 * nickname:  1–30 code points, single-line
 * className: 0–10 code points, single-line (empty string is valid — field is optional)
 *
 * Returns { ok: true, value } on success with normalised strings.
 * Returns { ok: false, field } naming the first field that fails.
 */
export function validateGiftText(input: GiftTextInput): GiftTextResult {
  // ── message ───────────────────────────────────────────────────────────────
  const message = input.message.normalize('NFC').trim()
  if (!message) return { ok: false, field: 'message' }
  if ([...message].length > MAX_GIFT_MESSAGE) return { ok: false, field: 'message' }
  if (hasControlCharsMultiline(message) || hasLoneSurrogate(message)) return { ok: false, field: 'message' }

  // ── nickname ──────────────────────────────────────────────────────────────
  const nickname = input.nickname.normalize('NFC').trim()
  if (!nickname) return { ok: false, field: 'nickname' }
  if ([...nickname].length > MAX_GIFT_NICKNAME) return { ok: false, field: 'nickname' }
  if (hasControlCharsSingleLine(nickname) || hasLoneSurrogate(nickname)) return { ok: false, field: 'nickname' }

  // ── className (optional — empty string is valid) ──────────────────────────
  const className = input.className.normalize('NFC').trim()
  if ([...className].length > MAX_GIFT_CLASSNAME) return { ok: false, field: 'className' }
  if (className.length > 0 && (hasControlCharsSingleLine(className) || hasLoneSurrogate(className))) {
    return { ok: false, field: 'className' }
  }

  return { ok: true, value: { message, nickname, className } }
}

/**
 * shared/text.ts — string validation helpers for user-submitted text.
 *
 * Extracted from worker/submit.ts so they can be reused in worker/about.ts
 * and anywhere else that needs to validate user-visible text fields.
 * All functions are pure; no side effects.
 */

/**
 * Invisible or text-direction characters that could hide or disguise content.
 * U+200D (zero-width joiner) and variation selectors are allowed because
 * emoji such as 👩‍🏫 and ❤️ need them.
 */
const INVISIBLE =
  '\\u00AD\\u034F\\u061C\\u180E\\u200B\\u200C\\u200E\\u200F\\u2028\\u2029' +
  '\\u202A-\\u202E\\u2060-\\u2069\\u3164\\uFEFF\\uFFA0'

/**
 * Pattern for multi-line fields (message, intro, steps[].text).
 * Rejects control characters EXCEPT \n (U+000A), and invisible/bidi chars.
 * Allows \n so callers can count and limit newlines separately.
 */
const REJECT_MULTILINE_RE = new RegExp(
  `[\\x00-\\x09\\x0B-\\x1F\\x7F\\x80-\\x9F${INVISIBLE}]|[\\u{E0000}-\\u{E007F}]`,
  'u',
)

/**
 * Pattern for single-line fields (name/class, heading, role, etc.).
 * Rejects ALL control characters including \n, plus invisible/bidi chars.
 */
const REJECT_SINGLELINE_RE = new RegExp(
  `[\\x00-\\x1F\\x7F\\x80-\\x9F${INVISIBLE}]|[\\u{E0000}-\\u{E007F}]`,
  'u',
)

/** A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * Returns true iff `text` contains control or invisible characters that
 * should be rejected in a **multi-line** field (newlines are allowed).
 *
 * Use for: message, intro, steps[].text.
 */
export function hasControlCharsMultiline(text: string): boolean {
  return REJECT_MULTILINE_RE.test(text)
}

/**
 * Returns true iff `text` contains control or invisible characters that
 * should be rejected in a **single-line** field (newlines are NOT allowed).
 *
 * Use for: name, class, heading, label, title, role, etc.
 */
export function hasControlCharsSingleLine(text: string): boolean {
  return REJECT_SINGLELINE_RE.test(text)
}

/**
 * Returns true iff `text` contains a lone surrogate (invalid Unicode code unit sequence).
 * Lone surrogates can corrupt database storage and must be rejected at the boundary.
 */
export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE_RE.test(text)
}

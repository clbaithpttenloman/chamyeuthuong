/**
 * Fill placeholders in a wish body template.
 *
 * Supported placeholders (all using replacer functions so `$` chars are safe):
 *   {tên}      — replaced with `vars.name` (case-insensitive)
 *   {môn}      — replaced with `vars.subject` or '' (case-insensitive)
 *   {Thầy/Cô}  — exact-case; replaced with `vars.title` or 'Thầy/Cô' (fallback)
 *   {thầy/cô}  — exact-case; replaced with lower-cased title or 'thầy/cô' (fallback)
 *
 * After substitution, runs of two or more consecutive spaces are collapsed to one.
 */
export function fillWish(
  body: string,
  vars: { name: string; subject?: string; title?: string },
): string {
  const subject = vars.subject ?? ''
  const titleUpper = vars.title ?? null   // 'Thầy' | 'Cô' | null
  const titleLower = titleUpper ? titleUpper.toLowerCase() : null

  let result = body
    .replace(/\{Thầy\/Cô\}/g, () => titleUpper ?? 'Thầy/Cô')
    .replace(/\{thầy\/cô\}/g, () => titleLower ?? 'thầy/cô')
    .replace(/\{tên\}/gi, () => vars.name)
    .replace(/\{môn\}/gi, () => subject)
  // Collapse extra spaces introduced by an empty substitution
  result = result.replace(/  +/g, ' ')
  return result
}

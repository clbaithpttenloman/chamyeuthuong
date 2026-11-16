/**
 * Fill placeholders in a wish body template.
 *
 * Replaces every occurrence of `{tên}` (case-insensitive) with `vars.name` and
 * every occurrence of `{môn}` (case-insensitive) with `vars.subject` (defaults to
 * empty string when absent). After substitution, runs of two or more consecutive
 * spaces are collapsed to one space.
 *
 * Uses replacer functions rather than string literals so that `$` characters in
 * `name` or `subject` are never interpreted as back-references.
 */
export function fillWish(body: string, vars: { name: string; subject?: string }): string {
  const subject = vars.subject ?? ''
  let result = body
    .replace(/\{tên\}/gi, () => vars.name)
    .replace(/\{môn\}/gi, () => subject)
  // Collapse extra spaces introduced by an empty substitution
  result = result.replace(/  +/g, ' ')
  return result
}

/**
 * scripts/check-headers.ts — post-build check for dist/_headers.
 *
 * Verifies that the built _headers file contains all required strict security
 * header lines (including the Google GSI origins needed for the sign-in button)
 * and that no non-GSI accounts.google.com origin appears.
 *
 * Run with: node scripts/check-headers.ts
 * Exits 1 if any required line is missing or any forbidden pattern is found.
 *
 * Also exports checkHeaders() for unit testing (scripts/check-headers.test.ts).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HEADERS_PATH = 'dist/_headers'

/** Full set of lines that must appear verbatim in _headers. */
const REQUIRED_LINES: readonly string[] = [
  // Global security headers on /*
  // Google GSI origins are required for the sign-in button (see docs/tech.md § Google sign-in).
  "Content-Security-Policy: default-src 'self'; img-src 'self' data:; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  // GSI loads cross-origin from accounts.google.com; Google recommends this policy, and
  // no-referrer breaks the button's origin check. Paths (card tokens) still never leave
  // the site: cross-origin requests get the origin only.
  'Referrer-Policy: strict-origin-when-cross-origin',
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
  // Site-wide noindex (plan § Amendments: single X-Robots-Tag: noindex on /*)
  'X-Robots-Tag: noindex',
]

/**
 * Validate the content of a _headers file.
 *
 * Returns a (possibly empty) array of human-readable error strings.
 * An empty array means the headers are valid.
 */
export function checkHeaders(content: string): string[] {
  const errors: string[] = []

  // 1. All required lines must appear exactly once (counted, not just present).
  for (const line of REQUIRED_LINES) {
    let count = 0
    let start = 0
    while ((start = content.indexOf(line, start)) !== -1) {
      count++
      start += line.length
    }
    if (count === 0) {
      errors.push(`missing: ${JSON.stringify(line)}`)
    } else if (count > 1) {
      errors.push(`duplicate (${count}×): ${JSON.stringify(line)}`)
    }
  }

  // 1b. Count every occurrence of "X-Robots-Tag" (any value) — only one is allowed.
  const allRobotsTagCount = (content.match(/X-Robots-Tag/gi) ?? []).length
  if (allRobotsTagCount > 1) {
    errors.push(`duplicate (${allRobotsTagCount}×): X-Robots-Tag appears more than once (all values combined)`)
  }

  // 1c. Exactly one Referrer-Policy of any value (a second, e.g. no-referrer, would override).
  const referrerCount = (content.match(/Referrer-Policy/gi) ?? []).length
  if (referrerCount > 1) {
    errors.push(`duplicate (${referrerCount}×): Referrer-Policy appears more than once (all values combined)`)
  }

  // 2. Any accounts.google.com origin WITHOUT the /gsi/ path is forbidden.
  //    The GSI paths (accounts.google.com/gsi/...) are required (checked above);
  //    any broader google.com origin (bare domain or non-/gsi/ path) is not allowed.
  if (/accounts\.google\.com(?!\/gsi\/)/.test(content)) {
    errors.push(
      `forbidden: accounts.google.com found without /gsi/ path — ` +
        `only accounts.google.com/gsi/* origins are permitted (see docs/tech.md)`,
    )
  }

  // 3. Wildcard (*) in any of these directives is forbidden.
  if (/(script|frame|connect|style)-src[^;]*\*/.test(content)) {
    errors.push(
      `forbidden: wildcard (*) source in script-src / frame-src / connect-src / style-src`,
    )
  }

  return errors
}

// Run the check when this script is invoked directly (node scripts/check-headers.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let content: string
  try {
    content = readFileSync(HEADERS_PATH, 'utf-8')
  } catch {
    console.error(`check-headers: cannot read ${HEADERS_PATH} — did you run npm run build?`)
    process.exit(1)
  }

  const errors = checkHeaders(content)
  if (errors.length > 0) {
    console.error(`check-headers: ${HEADERS_PATH} has issues:`)
    for (const e of errors) console.error(`  ${e}`)
    process.exit(1)
  }

  console.log(`check-headers: ${HEADERS_PATH} OK`)
}

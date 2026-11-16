/**
 * scripts/check-headers.ts — post-build check for dist/_headers.
 *
 * Verifies that the built _headers file contains all required strict security
 * header lines and that no Google accounts origin appears (Google Sign-In was
 * removed; this rule guards against accidental re-introduction).
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
  "Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy: no-referrer',
  'X-Content-Type-Options: nosniff',
  'X-Frame-Options: DENY',
  // noindex sections
  '/admin',
  '/t/*',
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

  // 1. All required lines must be present (exact substring match).
  for (const line of REQUIRED_LINES) {
    if (!content.includes(line)) {
      errors.push(`missing: ${JSON.stringify(line)}`)
    }
  }

  // 2. Any accounts.google.com origin is forbidden — Google Sign-In was removed
  //    and this rule prevents accidental re-introduction.
  if (/accounts\.google\.com/.test(content)) {
    errors.push(
      `forbidden: accounts.google.com found in headers — ` +
        `Google Sign-In was removed (restore via tag sso-google-signin if needed)`,
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

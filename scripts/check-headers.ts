/**
 * scripts/check-headers.ts — post-build check for dist/_headers.
 *
 * Verifies that the built _headers file contains all required security header
 * lines (including the GIS CSP additions) and that no over-broad Google source
 * (bare https://accounts.google.com or wildcard) is present in GIS directives.
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
  "Content-Security-Policy: default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; frame-src https://accounts.google.com/gsi/; connect-src 'self' https://accounts.google.com/gsi/; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'",
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

  // 2. Bare https://accounts.google.com (not immediately followed by /) is
  //    forbidden — it would allow any path on that origin, not just the GIS
  //    client script / frame / connect / style paths.
  if (/https:\/\/accounts\.google\.com(?!\/)/.test(content)) {
    errors.push(
      `forbidden: bare 'https://accounts.google.com' source found — ` +
        `must include a path such as /gsi/client`,
    )
  }

  // 3. Wildcard (*) in any GIS-related directive is forbidden.
  if (/(script|frame|connect|style)-src[^;]*\*/.test(content)) {
    errors.push(
      `forbidden: wildcard (*) source in a GIS-related CSP directive ` +
        `(script-src / frame-src / connect-src / style-src)`,
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

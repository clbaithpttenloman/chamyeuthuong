/**
 * Post-build check: verifies that dist/_headers contains the full security header set from the plan.
 * Run with: node scripts/check-headers.ts
 * Exits 1 if any required line is missing.
 */
import { readFileSync } from 'node:fs'

const HEADERS_PATH = 'dist/_headers'

let content: string
try {
  content = readFileSync(HEADERS_PATH, 'utf-8')
} catch {
  console.error(`check-headers: cannot read ${HEADERS_PATH} — did you run npm run build?`)
  process.exit(1)
}

const REQUIRED = [
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

const missing = REQUIRED.filter((line) => !content.includes(line))
if (missing.length > 0) {
  console.error(`check-headers: ${HEADERS_PATH} is missing required lines:`)
  for (const line of missing) console.error(`  ${JSON.stringify(line)}`)
  process.exit(1)
}

console.log(`check-headers: ${HEADERS_PATH} OK`)

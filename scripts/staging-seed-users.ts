/**
 * scripts/staging-seed-users.ts — dev-only staging load-test seed tool
 *
 * Generates SQL to insert N load-test users + sessions into the staging D1 database.
 * The script NEVER executes the SQL — it writes a file and prints the wrangler command.
 *
 * USAGE
 *   node scripts/staging-seed-users.ts [--users 200] [--hours 6]
 *   node scripts/staging-seed-users.ts --cleanup
 *
 * OPTIONS
 *   --users N    Number of users to seed (default 200, max 2000)
 *   --hours N    Session expiry in hours from now (default 6, max 24)
 *   --cleanup    Print SQL + command to delete all loadtest-* rows
 *   --database N Must match the staging database_name if supplied (safety guard)
 *
 * SAFETY RULES
 *   1. staging database_id must NOT be PLACEHOLDER_STAGING_D1_DATABASE_ID
 *   2. staging database_id must NOT equal production database_id
 *   3. --database <name>, if passed, must exactly match staging database_name
 *
 * LOAD TEST
 *   See docs/runbooks/staging.md → "Load test: hearts" (k6 script, pass criteria, drift check).
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Constants ─────────────────────────────────────────────────────────────────

const PLACEHOLDER_ID = 'PLACEHOLDER_STAGING_D1_DATABASE_ID'

/**
 * Maximum byte size for a single SQL statement sent to D1.
 * D1's hard limit is 100 KB; we stay well below it.
 * Exported so tests can verify no generated statement exceeds this.
 */
export const SQL_BYTE_LIMIT = 80_000

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DbConfig {
  binding: string
  database_name: string
  database_id: string
}

export interface StagingConfig {
  stagingDb: DbConfig
  prodDb: DbConfig
}

export interface UserSeed {
  googleSub: string
  email: string
  nickname: string
  createdAt: string    // ISO 8601
  token: string        // raw base64url (goes to tokens.txt)
  tokenHash: string    // SHA-256 hex (stored in session.token_hash)
  expiresAt: string    // ISO 8601
}

// ── JSONC comment stripper ────────────────────────────────────────────────────

/**
 * Strip `//` and `/* … *\/` comments from a JSONC string.
 * Correctly handles comment-like sequences inside string literals.
 */
export function stripJsonComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '"') {
      // String literal: copy verbatim until the closing unescaped quote.
      out += c
      i++
      while (i < src.length) {
        const sc = src[i]!
        out += sc
        if (sc === '\\') {
          i++
          if (i < src.length) { out += src[i]!; i++ }
          continue
        }
        if (sc === '"') { i++; break }
        i++
      }
    } else if (c === '/' && i + 1 < src.length && src[i + 1] === '/') {
      // Line comment: skip to end of line.
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && i + 1 < src.length && src[i + 1] === '*') {
      // Block comment: skip to closing `*/`.
      i += 2
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  return out
}

// ── Config ────────────────────────────────────────────────────────────────────

interface WranglerJsonc {
  d1_databases?: DbConfig[]
  env?: { staging?: { d1_databases?: DbConfig[] } }
}

/** Read and parse wrangler.jsonc, returning prod + staging DB configs. */
export function readStagingConfig(configPath: string): StagingConfig {
  const raw = readFileSync(configPath, 'utf-8')
  const cfg = JSON.parse(stripJsonComments(raw)) as WranglerJsonc
  const prodDb = cfg.d1_databases?.[0]
  if (!prodDb?.database_id) throw new Error('Cannot read d1_databases[0] from wrangler.jsonc')
  const stagingDb = cfg.env?.staging?.d1_databases?.[0]
  if (!stagingDb?.database_id) throw new Error('Cannot read env.staging.d1_databases[0] from wrangler.jsonc')
  return { stagingDb, prodDb }
}

/**
 * Validate that it is safe to seed the staging database.
 * Throws with a "REFUSED:" prefix on any safety violation.
 *
 * @param config  - parsed staging + prod DB config
 * @param cliArgs - raw CLI args (process.argv.slice(2)) to check for --database
 */
export function validateConfig(config: StagingConfig, cliArgs: string[]): void {
  const { stagingDb, prodDb } = config

  if (stagingDb.database_id === PLACEHOLDER_ID) {
    throw new Error(
      `REFUSED: staging database_id is still the placeholder "${PLACEHOLDER_ID}".\n` +
      `Create the staging DB first:\n` +
      `  npx wrangler d1 create cham-yeu-thuong-staging\n` +
      `Then update env.staging.d1_databases[0].database_id in wrangler.jsonc.`,
    )
  }

  if (stagingDb.database_id === prodDb.database_id) {
    throw new Error(
      `REFUSED: staging database_id equals production database_id (${prodDb.database_id}).\n` +
      `Seeding load-test users into the production database is not allowed.`,
    )
  }

  for (let i = 0; i < cliArgs.length - 1; i++) {
    if (cliArgs[i] === '--database') {
      const given = cliArgs[i + 1]!
      if (given !== stagingDb.database_name) {
        throw new Error(
          `REFUSED: --database "${given}" does not match staging database_name ` +
          `"${stagingDb.database_name}".\n` +
          `Only the staging database may be targeted by this script.`,
        )
      }
    }
  }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/**
 * SHA-256 hex hash of a UTF-8 string.
 * Produces identical output to worker/session.ts `sha256Hex()`,
 * which uses `crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))`.
 */
export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Base64url-encoded 32-byte random token (same format as worker/session.ts createSession). */
function generateToken(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

// ── User generation ───────────────────────────────────────────────────────────

/**
 * Generate n load-test user seeds.
 *
 * @param n          - number of users (1–2000)
 * @param expiresAt  - when sessions expire
 * @param createdAt  - user/session creation time (should be 2 days ago so reports count)
 */
export function generateUsers(n: number, expiresAt: Date, createdAt: Date): UserSeed[] {
  const createdAtStr = createdAt.toISOString()
  const expiresAtStr = expiresAt.toISOString()
  const users: UserSeed[] = []
  for (let i = 1; i <= n; i++) {
    const sub = `loadtest-${randomBytes(8).toString('hex')}`
    const token = generateToken()
    users.push({
      googleSub: sub,
      email: `loadtest-${i}@example.invalid`,
      nickname: `Thử ${i}`,
      createdAt: createdAtStr,
      token,
      tokenHash: sha256Hex(token),
      expiresAt: expiresAtStr,
    })
  }
  return users
}

// ── SQL generation ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Split `rows` into batched SQL statements, each below SQL_BYTE_LIMIT bytes.
 * Each statement is: `prefix + rows.join(sep) + suffix + ";"`.
 *
 * @param prefix - SQL up to and including the first row (e.g. "INSERT … VALUES\n")
 * @param rows   - individual row fragments
 * @param sep    - separator between rows (e.g. ",\n" or "\nUNION ALL\n")
 * @param suffix - SQL after the last row (e.g. "")
 */
export function batchRows(
  prefix: string,
  rows: string[],
  sep: string,
  suffix: string,
): string[] {
  const stmts: string[] = []
  const overhead = Buffer.byteLength(prefix + suffix + ';', 'utf8')
  let batch: string[] = []
  let batchBytes = overhead

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(row + sep, 'utf8')
    if (batch.length > 0 && batchBytes + rowBytes > SQL_BYTE_LIMIT) {
      stmts.push(prefix + batch.join(sep) + suffix + ';')
      batch = []
      batchBytes = overhead
    }
    batch.push(row)
    batchBytes += rowBytes
  }
  if (batch.length > 0) stmts.push(prefix + batch.join(sep) + suffix + ';')
  return stmts
}

/**
 * Generate all SQL statements needed to seed the given users.
 * Returns an array of complete statements (each ending in ';').
 * Every statement is guaranteed to be below SQL_BYTE_LIMIT bytes.
 *
 * User rows are batched as multi-value INSERTs.
 * Session rows use INSERT … SELECT … UNION ALL … to look up the auto-increment
 * user id by google_sub without needing it in advance.
 */
export function generateSQLStatements(users: UserSeed[]): string[] {
  // ── app_user inserts ──────────────────────────────────────────────────────
  const userRows = users.map(
    (u) =>
      `  ('${esc(u.googleSub)}','${esc(u.email)}','${esc(u.nickname)}',` +
      `'LT',NULL,0,'${u.createdAt}','${u.createdAt}')`,
  )
  const userPrefix =
    'INSERT INTO app_user ' +
    '(google_sub, email, nickname, class_name, hd, banned, created_at, last_seen_at)\n' +
    'VALUES\n'
  const userStmts = batchRows(userPrefix, userRows, ',\n', '')

  // ── session inserts ───────────────────────────────────────────────────────
  // Referencing google_sub avoids needing the auto-increment id in advance.
  const sessionRows = users.map(
    (u) =>
      `SELECT '${u.tokenHash}',id,'${u.expiresAt}','${u.createdAt}',''` +
      ` FROM app_user WHERE google_sub='${esc(u.googleSub)}'`,
  )
  const sessionPrefix =
    'INSERT INTO session (token_hash, user_id, expires_at, created_at, ip_hash)\n'
  const sessionStmts = batchRows(sessionPrefix, sessionRows, '\nUNION ALL\n', '')

  return [...userStmts, ...sessionStmts]
}

/**
 * SQL to remove all load-test rows in FK-safe order.
 *
 * Deletion order (referential integrity):
 *   report  (REFERENCES gift ON DELETE CASCADE, REFERENCES app_user ON DELETE CASCADE)
 *   heart   (REFERENCES gift ON DELETE CASCADE, REFERENCES app_user ON DELETE CASCADE)
 *   gift    (REFERENCES app_user — no ON DELETE clause, so must go before app_user)
 *   session (REFERENCES app_user ON DELETE CASCADE — explicit for clarity)
 *   app_user
 */
export function cleanupSQL(): string {
  const byUser = `user_id IN (SELECT id FROM app_user WHERE google_sub LIKE 'loadtest-%')`
  const bySub = `google_sub LIKE 'loadtest-%'`
  return [
    '-- Clean up load-test rows; order is FK-safe (see staging-seed-users.ts cleanupSQL)',
    `DELETE FROM report WHERE ${byUser};`,
    `DELETE FROM heart WHERE ${byUser};`,
    `DELETE FROM gift WHERE ${byUser};`,
    `DELETE FROM session WHERE ${byUser};`,
    `DELETE FROM app_user WHERE ${bySub};`,
  ].join('\n')
}

// ── CLI helpers ───────────────────────────────────────────────────────────────

function die(msg: string): never {
  process.stderr.write(`ERROR: ${msg}\n`)
  process.exit(1)
}

function parseIntArg(args: string[], flag: string, def: number): number {
  const idx = args.indexOf(flag)
  if (idx < 0) return def
  const v = parseInt(args[idx + 1] ?? '', 10)
  if (!Number.isFinite(v)) die(`${flag} requires an integer argument`)
  return v
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2)
  const __dir = dirname(fileURLToPath(import.meta.url))
  const configPath = join(__dir, '..', 'wrangler.jsonc')

  // Validate config — die() if anything is wrong (never returns on error)
  const config = (() => {
    try {
      const c = readStagingConfig(configPath)
      validateConfig(c, args)
      return c
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e))
    }
  })()

  const isCleanup = args.includes('--cleanup')
  const nUsers = parseIntArg(args, '--users', 200)
  const hours = parseIntArg(args, '--hours', 6)

  if (!isCleanup) {
    if (nUsers < 1 || nUsers > 2000) die(`--users must be 1–2000, got ${nUsers}`)
    if (hours < 1 || hours > 24) die(`--hours must be 1–24, got ${hours}`)
  }

  const tempDir = join(tmpdir(), `staging-seed-${Date.now()}-${randomBytes(4).toString('hex')}`)
  mkdirSync(tempDir, { recursive: true })

  const { database_name } = config.stagingDb
  const applyBase = `npx wrangler d1 execute ${database_name} --env staging --remote --file`

  if (isCleanup) {
    const sql = cleanupSQL()
    const sqlFile = join(tempDir, 'cleanup.sql')
    writeFileSync(sqlFile, sql + '\n', 'utf-8')
    process.stdout.write(`SQL file: ${sqlFile}\n`)
    process.stdout.write(`\nApply with:\n  ${applyBase} ${sqlFile}\n`)
    return
  }

  const now = new Date()
  const createdAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) // 2 days ago
  const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000)

  const users = generateUsers(nUsers, expiresAt, createdAt)
  const stmts = generateSQLStatements(users)

  const header = [
    `-- staging-seed-users: ${nUsers} load-test users, sessions expire in ${hours}h`,
    `-- Generated: ${now.toISOString()}`,
    `-- Cleanup:   node scripts/staging-seed-users.ts --cleanup`,
    '',
  ].join('\n')

  const sqlFile = join(tempDir, 'seed.sql')
  const tokensFile = join(tempDir, 'tokens.txt')

  writeFileSync(sqlFile, header + stmts.join('\n') + '\n', 'utf-8')
  writeFileSync(tokensFile, users.map((u) => u.token).join('\n') + '\n', 'utf-8')
  chmodSync(tokensFile, 0o600)

  process.stdout.write(`SQL file:    ${sqlFile}\n`)
  process.stdout.write(`Tokens file: ${tokensFile} (chmod 0600, one token per line)\n`)
  process.stdout.write(`\nApply with:\n  ${applyBase} ${sqlFile}\n`)
  process.stdout.write(`\nSeeded ${nUsers} users. Sessions expire in ${hours}h (${expiresAt.toISOString()}).\n`)
}

// Run only when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (e) {
    process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
    process.exit(1)
  }
}

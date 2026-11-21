/**
 * scripts/stagingSeed.test.ts
 *
 * Unit tests for the pure, side-effect-free parts of staging-seed-users.ts:
 *   1. Config validation — refuses placeholder ID, refuses staging === prod ID,
 *      refuses --database mismatch
 *   2. sha256Hex — matches worker/session.ts (crypto.subtle.digest) behavior
 *   3. SQL batching — no statement exceeds SQL_BYTE_LIMIT bytes
 *   4. Cleanup SQL order — referential-integrity-safe delete order
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SQL_BYTE_LIMIT,
  batchRows,
  cleanupSQL,
  generateSQLStatements,
  generateUsers,
  sha256Hex,
  stripJsonComments,
  validateConfig,
} from './staging-seed-users.ts'

// ── 1. Config validation ──────────────────────────────────────────────────────

describe('validateConfig', () => {
  const realProdId = '9e58f935-fb6f-4c1f-be0b-21a9183ba483'
  const validStaging = {
    binding: 'DB',
    database_name: 'cham-yeu-thuong-staging',
    database_id: 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb',
  }
  const validProd = {
    binding: 'DB',
    database_name: 'cham-yeu-thuong',
    database_id: realProdId,
  }

  it('refuses PLACEHOLDER_STAGING_D1_DATABASE_ID', () => {
    expect(() =>
      validateConfig(
        {
          stagingDb: { ...validStaging, database_id: 'PLACEHOLDER_STAGING_D1_DATABASE_ID' },
          prodDb: validProd,
        },
        [],
      ),
    ).toThrow(/REFUSED/)
  })

  it('refuses when staging database_id equals production database_id', () => {
    expect(() =>
      validateConfig(
        {
          stagingDb: { ...validStaging, database_id: realProdId },
          prodDb: validProd,
        },
        [],
      ),
    ).toThrow(/REFUSED/)
  })

  it('refuses --database <name> that does not match staging database_name', () => {
    expect(() =>
      validateConfig({ stagingDb: validStaging, prodDb: validProd }, [
        '--database',
        'cham-yeu-thuong', // production name
      ]),
    ).toThrow(/REFUSED/)
  })

  it('passes with a valid, distinct staging config and no --database flag', () => {
    expect(() =>
      validateConfig({ stagingDb: validStaging, prodDb: validProd }, []),
    ).not.toThrow()
  })

  it('passes when --database matches the staging database_name exactly', () => {
    expect(() =>
      validateConfig({ stagingDb: validStaging, prodDb: validProd }, [
        '--database',
        'cham-yeu-thuong-staging',
      ]),
    ).not.toThrow()
  })
})

// ── 2. sha256Hex — matches worker/session.ts ──────────────────────────────────

describe('sha256Hex', () => {
  it('matches Node.js createHash sha256 for a known input', () => {
    const input = 'loadtest-token-abc123xyz'
    expect(sha256Hex(input)).toBe(
      createHash('sha256').update(input, 'utf8').digest('hex'),
    )
  })

  it('matches known SHA-256 test vectors', () => {
    // SHA-256('') = e3b0c44298fc1c149afbf4c8996fb924…
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    // SHA-256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e…
    expect(sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('matches crypto.subtle.digest (identical to worker/session.ts behavior)', async () => {
    const input = 'base64url-test-token-XYZ-789'
    const buf = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(input),
    )
    const subtleHex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    expect(sha256Hex(input)).toBe(subtleHex)
  })
})

// ── 3. SQL batching — no statement exceeds SQL_BYTE_LIMIT ─────────────────────

describe('batchRows', () => {
  it('splits a large row array so each statement stays below SQL_BYTE_LIMIT', () => {
    // Each row is ~1 KB; 100 rows ≈ 100 KB, so batchRows must split into at least 2 statements.
    const bigVal = 'x'.repeat(1000)
    const rows = Array.from({ length: 100 }, (_, i) => `  ('row-${i}','${bigVal}')`)
    const stmts = batchRows('INSERT INTO t (a,b)\nVALUES\n', rows, ',\n', '')
    expect(stmts.length).toBeGreaterThan(1)
    for (const s of stmts) {
      expect(Buffer.byteLength(s, 'utf8')).toBeLessThan(SQL_BYTE_LIMIT)
    }
  })

  it('returns a single statement for a small row array', () => {
    const rows = ['  (1,2)', '  (3,4)']
    const stmts = batchRows('INSERT INTO t (a,b) VALUES\n', rows, ',\n', '')
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toContain('(1,2)')
    expect(stmts[0]).toContain('(3,4)')
  })
})

describe('generateSQLStatements', () => {
  it('every statement is below SQL_BYTE_LIMIT bytes at maximum user count (2000)', () => {
    const expiresAt = new Date(Date.now() + 3_600_000)
    const createdAt = new Date(Date.now() - 2 * 86_400_000)
    const users = generateUsers(2000, expiresAt, createdAt)
    const stmts = generateSQLStatements(users)
    expect(stmts.length).toBeGreaterThan(2) // confirms batching occurred
    for (const s of stmts) {
      expect(Buffer.byteLength(s, 'utf8')).toBeLessThan(SQL_BYTE_LIMIT)
    }
  })

  it('generates both app_user and session INSERT statements', () => {
    const users = generateUsers(5, new Date(Date.now() + 3_600_000), new Date())
    const stmts = generateSQLStatements(users)
    expect(stmts.some((s) => s.startsWith('INSERT INTO app_user'))).toBe(true)
    expect(stmts.some((s) => s.startsWith('INSERT INTO session'))).toBe(true)
  })

  it('session statements reference google_sub for user_id lookup', () => {
    const users = generateUsers(2, new Date(Date.now() + 3_600_000), new Date())
    const stmts = generateSQLStatements(users)
    const sessionStmt = stmts.find((s) => s.startsWith('INSERT INTO session'))
    expect(sessionStmt).toBeDefined()
    expect(sessionStmt).toContain('FROM app_user WHERE google_sub=')
  })
})

// ── 4. Cleanup SQL order — FK-safe ───────────────────────────────────────────

describe('cleanupSQL', () => {
  const sql = cleanupSQL()

  it('deletes report before gift (report references gift and app_user)', () => {
    expect(sql.indexOf('DELETE FROM report')).toBeLessThan(sql.indexOf('DELETE FROM gift'))
  })

  it('deletes heart before gift (heart references gift and app_user)', () => {
    expect(sql.indexOf('DELETE FROM heart')).toBeLessThan(sql.indexOf('DELETE FROM gift'))
  })

  it('deletes gift before session (gift references app_user with no cascade)', () => {
    expect(sql.indexOf('DELETE FROM gift')).toBeLessThan(sql.indexOf('DELETE FROM session'))
  })

  it('deletes session before app_user', () => {
    expect(sql.indexOf('DELETE FROM session')).toBeLessThan(sql.indexOf('DELETE FROM app_user'))
  })

  it('targets rows by google_sub LIKE loadtest-%', () => {
    expect(sql).toContain("google_sub LIKE 'loadtest-%'")
  })
})

// ── Bonus: stripJsonComments (critical to config reading) ─────────────────────

describe('stripJsonComments', () => {
  it('removes single-line // comments', () => {
    const json = '{\n  "a": 1 // trailing comment\n}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ a: 1 })
  })

  it('removes block /* … */ comments', () => {
    const json = '{"a": /* mid */ 1}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ a: 1 })
  })

  it('preserves slashes inside string literals', () => {
    const json = '{"url": "https://example.com"}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ url: 'https://example.com' })
  })

  it('preserves escaped quotes inside string literals', () => {
    const json = '{"s": "say \\"hello\\""}'
    expect(JSON.parse(stripJsonComments(json))).toEqual({ s: 'say "hello"' })
  })
})

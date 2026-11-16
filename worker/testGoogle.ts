/**
 * Test helpers for Google Sign-In ID-token authentication.
 * Provides key-pair generation, JWT signing, local JWKS resolvers, and env builders
 * so auth tests run without any network calls.
 */
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose'
import type { CryptoKey, LocalJWKSet } from 'jose'
import { testDb, type D1 } from './testDb.ts'

// ---- Constants ----

/** Google ID token client ID (must end with .apps.googleusercontent.com). */
export const TEST_CLIENT_ID = 'test-client-123.apps.googleusercontent.com'

/** Default test email: a standard Gmail address. */
export const TEST_EMAIL = 'admin@gmail.com'

/** Workspace email paired with TEST_HD for hd-domain tests. */
export const TEST_EMAIL_WORKSPACE = 'admin@workspace.example.com'

/** Workspace hd claim value paired with TEST_EMAIL_WORKSPACE. */
export const TEST_HD = 'workspace.example.com'

// ---- Lazy key pairs (generated once per test run) ----

type KP = { privateKey: CryptoKey; publicKey: CryptoKey }
let _kp1: KP | null = null
let _kp2: KP | null = null

async function kp1(): Promise<KP> {
  if (!_kp1) _kp1 = await generateKeyPair('RS256', { extractable: true })
  return _kp1
}

async function kp2(): Promise<KP> {
  if (!_kp2) _kp2 = await generateKeyPair('RS256', { extractable: true })
  return _kp2
}

// ---- JWKS helpers ----

/** One-key local JWKS (kid: 'k1'). Use for most auth tests. */
export async function localJwks(): Promise<LocalJWKSet> {
  const { publicKey } = await kp1()
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1' }
  return createLocalJWKSet({ keys: [jwk] })
}

/** Two-key local JWKS (kid: 'k1' and 'k2'). Use for kid-selection tests. */
export async function twoKeyJwks(): Promise<LocalJWKSet> {
  const { publicKey: pk1 } = await kp1()
  const { publicKey: pk2 } = await kp2()
  const jwk1 = { ...(await exportJWK(pk1)), kid: 'k1' }
  const jwk2 = { ...(await exportJWK(pk2)), kid: 'k2' }
  return createLocalJWKSet({ keys: [jwk1, jwk2] })
}

// ---- JWT signing helpers ----

export type SignOpts = {
  kid?: string       // default: 'k1' (or 'k2' when useK2 is true)
  noIat?: boolean    // skip setIssuedAt()
  noExp?: boolean    // skip setExpirationTime()
  useK2?: boolean    // sign with kp2 private key (useful for wrong-key tests)
}

/**
 * Sign a JWT with exactly the given claims payload.
 * Sets iat and exp automatically unless noIat/noExp are set, or the caller provides them.
 * Caller is responsible for all claims (iss, aud, email, email_verified, etc.).
 */
export async function signJwt(
  claims: Record<string, unknown>,
  opts: SignOpts = {},
): Promise<string> {
  const { privateKey } = opts.useK2 ? await kp2() : await kp1()
  const kid = opts.kid ?? (opts.useK2 ? 'k2' : 'k1')

  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid })
  if (!opts.noIat && !('iat' in claims)) builder = builder.setIssuedAt()
  if (!opts.noExp && !('exp' in claims)) builder = builder.setExpirationTime('1h')
  return builder.sign(privateKey)
}

/**
 * Convenience: sign a valid Google ID token with standard test claims and optional overrides.
 * Default payload: { iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID,
 *                    email: TEST_EMAIL, email_verified: true, iat, exp }.
 */
export async function validJwt(
  overrides: Record<string, unknown> = {},
  opts: SignOpts = {},
): Promise<string> {
  return signJwt(
    {
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_ID,
      email: TEST_EMAIL,
      email_verified: true,
      ...overrides,
    },
    opts,
  )
}

// ---- Env type and builder (Google auth interface) ----

/**
 * Env shape required by worker/auth.ts (Google Sign-In).
 * Note: ACCESS_* fields are absent — auth.ts uses GOOGLE_CLIENT_ID.
 */
export type GoogleEnv = {
  GOOGLE_CLIENT_ID: string
  AUTH_DEV_MODE?: string
  AUTH_DEV_JWKS_URL?: string
  ADMIN_FAIL_LIMIT: { limit(opts: { key: string }): Promise<{ success: boolean }> }
  DB: D1
  BOOTSTRAP_EMAIL?: string
  ALLOW_FIRST_CLAIM?: string
}

type GoogleEnvOpts = {
  /** Override GOOGLE_CLIENT_ID. Pass '' to simulate missing/empty. */
  clientId?: string
  /** Set AUTH_DEV_MODE. Pass '1' to enable dev mode. */
  devMode?: string
  /** Set AUTH_DEV_JWKS_URL. Only honored by auth.ts when AUTH_DEV_MODE === '1'. */
  devJwksUrl?: string
  /** Whether the rate-limit check succeeds (default true). */
  failLimit?: boolean
  /** Provide a specific D1 instance. Defaults to a fresh empty testDb. */
  db?: D1
  /** Set BOOTSTRAP_EMAIL in env. */
  bootstrapEmail?: string
  /** Set ALLOW_FIRST_CLAIM in env. Pass '1' to enable open first-user claim. */
  allowFirstClaim?: string
}

/**
 * Build a minimal env for direct requireAdmin tests (Google auth interface).
 * Example: requireAdmin(req, googleEnv({ db }), deps)
 */
export function googleEnv(opts: GoogleEnvOpts = {}): GoogleEnv {
  return {
    GOOGLE_CLIENT_ID: opts.clientId !== undefined ? opts.clientId : TEST_CLIENT_ID,
    AUTH_DEV_MODE: opts.devMode,
    AUTH_DEV_JWKS_URL: opts.devJwksUrl,
    ADMIN_FAIL_LIMIT: { limit: async () => ({ success: opts.failLimit ?? true }) },
    DB: opts.db ?? testDb().db,
    BOOTSTRAP_EMAIL: opts.bootstrapEmail,
    ALLOW_FIRST_CLAIM: opts.allowFirstClaim,
  }
}

/**
 * Seed an admin row for the given email (default TEST_EMAIL) in a D1-compatible DB.
 * Use in beforeEach / test setup to simulate an already-registered admin.
 */
export async function seedAdmin(db: D1, email = TEST_EMAIL): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare('INSERT INTO admin (email, created_at, created_by) VALUES (?, ?, ?)')
    .bind(email.toLowerCase().trim(), now, 'test-seed')
    .run()
}

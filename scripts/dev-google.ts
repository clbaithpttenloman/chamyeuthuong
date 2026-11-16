/**
 * scripts/dev-google.ts — local Google Sign-In mock for development.
 *
 * NOT for production. Generates an RSA key pair in memory, serves a JWKS on
 * http://127.0.0.1:8788/certs, prints .dev.vars lines and a signed 1-hour
 * Google-shaped ID token, then keeps running to serve the JWKS.
 *
 * Usage:
 *   npm run dev:google
 *
 * Copy the printed .dev.vars lines into .dev.vars, then start the worker:
 *   npx wrangler dev
 *
 * Export DEV_GOOGLE_TOKEN before curl smoke tests:
 *   export DEV_GOOGLE_TOKEN=<printed value>
 *   curl -H "Authorization: Bearer $DEV_GOOGLE_TOKEN" http://localhost:8787/api/admin/teachers
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const KID = randomUUID()
// Random client id that ends with .apps.googleusercontent.com, as Google issues
const CLIENT_ID = `${randomUUID().replace(/-/g, '')}.apps.googleusercontent.com`
const EMAIL = 'dev@gmail.com'
const JWKS_PORT = 8788
const JWKS_URL = `http://127.0.0.1:${JWKS_PORT}/certs`

const { privateKey, publicKey } = await generateKeyPair('RS256')

// Build JWKS — include kid and alg so the worker's decodeProtectedHeader check passes
const jwk = await exportJWK(publicKey)
const jwks = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] })

// Sign a 1-hour Google-shaped ID token
const now = Math.floor(Date.now() / 1000)
const token = await new SignJWT({
  email: EMAIL,
  email_verified: true,
})
  .setProtectedHeader({ alg: 'RS256', kid: KID })
  .setIssuer('https://accounts.google.com')
  .setAudience(CLIENT_ID)
  .setIssuedAt(now)
  .setExpirationTime(now + 60 * 60)
  .sign(privateKey)

// Print .dev.vars lines — paste these into .dev.vars for wrangler dev
console.log('# Paste into .dev.vars (never commit this file):')
console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`)
console.log(`AUTH_DEV_MODE=1`)
console.log(`AUTH_DEV_JWKS_URL=${JWKS_URL}`)
console.log(`# first local request (with a valid token) becomes admin when table is empty`)
console.log(`ALLOW_FIRST_CLAIM=1`)
console.log('')
// Print the token separately — export it in your shell, do NOT put it in .dev.vars
console.log('# Export in your shell (do NOT commit or put in .dev.vars):')
console.log(`DEV_GOOGLE_TOKEN=${token}`)
console.log('')
console.log('# JWKS server running — keep this process alive while developing.')
console.log(`# Then: npx wrangler dev`)

// Serve JWKS — only on localhost, only on /certs
const server = createServer((req, res) => {
  if (req.url === '/certs') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(jwks)
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
})

server.listen(JWKS_PORT, '127.0.0.1')

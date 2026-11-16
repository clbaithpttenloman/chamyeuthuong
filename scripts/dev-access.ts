/**
 * scripts/dev-access.ts — local Cloudflare Access mock for development.
 *
 * NOT for production. Generates an RSA key pair in memory, serves a JWKS on
 * http://127.0.0.1:8788/cdn-cgi/access/certs, prints .dev.vars lines and a
 * signed 12-hour JWT, then keeps running to serve the JWKS.
 *
 * Usage:
 *   npm run dev:access
 *
 * Copy the printed lines into .dev.vars, then start the worker:
 *   npx wrangler dev
 *
 * Export DEV_ACCESS_JWT before starting Vite so the proxy injects the header:
 *   export DEV_ACCESS_JWT=<printed value> && npm run dev
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const KID = randomUUID()
const AUD = randomUUID()
const DOMAIN = 'http://127.0.0.1:8788'
const EMAIL = 'dev@example.com'

const { privateKey, publicKey } = await generateKeyPair('RS256')

// Build JWKS — include kid and alg so decodeProtectedHeader checks pass in auth.ts
const jwk = await exportJWK(publicKey)
const jwks = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] })

// Sign a 12-hour JWT matching what Cloudflare Access would issue
const now = Math.floor(Date.now() / 1000)
const jwt = await new SignJWT({ email: EMAIL })
  .setProtectedHeader({ alg: 'RS256', kid: KID })
  .setIssuer(DOMAIN)
  .setAudience(AUD)
  .setIssuedAt(now)
  .setExpirationTime(now + 12 * 60 * 60)
  .sign(privateKey)

// Print .dev.vars lines — paste these into .dev.vars for wrangler dev
console.log('# Paste into .dev.vars (never commit this file):')
console.log(`ACCESS_TEAM_DOMAIN=${DOMAIN}`)
console.log(`ACCESS_AUD=${AUD}`)
console.log(`ALLOW_FIRST_CLAIM=1`)
console.log(`# first local request (with a valid JWT) becomes admin`)
console.log(`ACCESS_DEV_MODE=1`)
console.log('')
// Print the JWT separately — export it in your shell, do NOT put it in .dev.vars
console.log('# Export in your shell (do NOT commit or put in .dev.vars):')
console.log(`DEV_ACCESS_JWT=${jwt}`)
console.log('')
console.log('# JWKS server running — keep this process alive while developing.')
console.log('# Then: export DEV_ACCESS_JWT=<value above> && npm run dev')

// Serve JWKS — only on localhost, only on the certs path
const server = createServer((req, res) => {
  if (req.url === '/cdn-cgi/access/certs') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(jwks)
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
})

server.listen(8788, '127.0.0.1')

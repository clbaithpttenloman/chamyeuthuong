# Google Sign-In Setup & Configuration — Phase 1 Campaign Platform

This runbook covers setting up Google Cloud OAuth for the campaign platform's Google sign-in flow.

---

## Overview

**What it does:** Users sign in with their Google account. The Worker verifies the ID token locally (no redirect), creates a session cookie, and the user is authenticated for creating gifts (Phase 2), hearts (Phase 2), reports (Phase 2), and (if admin) managing campaigns.

**What we store:** Google `sub` (subject identifier, ≈ user id), email, last-seen time. No Google tokens are stored; every permission is re-checked on each request using the verified email and `sub` (Phase 2 adds banning logic).

**Admin sign-in:** Same flow, but `admin` list is checked to see if the email is allowed and Google is authoritative for it. Admin privileges are checked on every request, so removing an email from the admin list takes effect immediately.

**Session management:** 32-byte random token stored HttpOnly in `__Host-cyt_s` cookie (Secure, SameSite=Lax, Path=/, 14-day expiry). Worker stores the SHA-256 hash in D1; presented token is always hashed before comparison. At most 10 sessions per user (oldest deleted on new sign-in); expired rows are purged on sign-in. No fixation risk: signing in deletes any previously-presented session token before creating a new one.

---

## Google Cloud Setup (One-Time)

### Step 1: Create or Select a Google Cloud Project

1. Visit [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note the **Project ID** (e.g., `my-school-noel`)

### Step 2: Enable Google Sign-In

1. Go to **APIs & Services** → **Library**
2. Search for **"Google Identity Services"** (not "Google Sign-In API" — that is deprecated)
3. Click **Enable**

### Step 3: Create an OAuth 2.0 Web Client

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Web application**
4. **Authorized JavaScript origins** — add all origins where the sign-in button will appear:
   - **Production custom domain** (not yet chosen): `https://<your-production-domain.com>` (e.g., `https://noel.truongtenloman.edu.vn`)
   - **Staging workers.dev**: `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev`
   - **Dev localhost**: `http://localhost:5173` (Vite default), `http://localhost:3000` (if different)
5. Do **NOT** add Authorized redirect URIs — we use the popup flow, not redirects
6. Click **Create**

### Step 4: Copy the Client ID

The OAuth 2.0 Client ID appears (e.g., `1234567890-abcdefghijklmnop.apps.googleusercontent.com`).

---

## Cloudflare Configuration

### Production (`wrangler.jsonc` `vars`)

```jsonc
{
  "vars": {
    "GOOGLE_CLIENT_ID": "1234567890-abcdefghijklmnop.apps.googleusercontent.com"
  }
}
```

Deploy:
```bash
git add wrangler.jsonc
git commit -m "Set production Google client ID"
git push
```

### Staging (`wrangler.jsonc` `env.staging.vars`)

Create a **separate OAuth client** in Google Cloud for staging (same steps 1–3 above, but add `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev` as an authorized origin).

```jsonc
{
  "env": {
    "staging": {
      "vars": {
        "GOOGLE_CLIENT_ID": "9876543210-zyxwvutsrqponmlk.apps.googleusercontent.com"
      }
    }
  }
}
```

Deploy:
```bash
npx wrangler deploy --env staging
```

### Local Dev (`.dev.vars`)

```
GOOGLE_CLIENT_ID=1234567890-abcdefghijklmnop.apps.googleusercontent.com
```

(Use the production client ID for local testing; the origin `http://localhost:5173` is already in the production client's authorized list.)

---

## API Endpoints

All writes need `X-Requested-With: fetch` and are refused with 403 when `Sec-Fetch-Site: cross-site`. Responses are `Cache-Control: no-store`. No CORS headers are sent. Errors are `{ "error": "<code>" }`.

| Endpoint | Auth | Limit | Result |
|---|---|---|---|
| `GET /api/auth/nonce` | none | `PUBLIC_READ_LIMIT` 3,000/60 s per IP | `{ nonce, clientId }` + cookie `__Host-cyt_n` (5 min) |
| `POST /api/auth/google` | none | `AUTH_LIMIT` 300/60 s per IP on failures; `AUTH_SUB_LIMIT` 10/60 s per Google sub on successes | `{ user }` + cookie `__Host-cyt_s` (14 days) |
| `POST /api/auth/logout` | session | `USER_WRITE_LIMIT` 10/60 s | `{ ok: true }`, session row deleted, cookie cleared |
| `GET /api/me` | optional | `USER_READ_LIMIT` 120/60 s (user id, or IP signed out) | `{ user, isAdmin }`, `user` is `null` when signed out |
| `PUT /api/me` | session | `USER_WRITE_LIMIT` | body `{ nickname, className }` → `{ ok: true }` |
| `DELETE /api/me` | session | `USER_WRITE_LIMIT` | deletes **all** the user's sessions and their account, clears the cookie → `{ ok: true }` |

`nonce` is `<32 hex random>.<expiry epoch>.<HMAC-SHA256 hex>` signed with `NONCE_KEY`. The same value goes in `__Host-cyt_n`; the button passes it to `google.accounts.id.initialize({ client_id, nonce, … })` and the ID token must carry it.

`POST /api/auth/google` body `{ "credential": "<ID token>" }`. Checks: ≤ 4 KB, RS256 against `https://www.googleapis.com/oauth2/v3/certs`, issuer `accounts.google.com` or `https://accounts.google.com`, audience `GOOGLE_CLIENT_ID`, not expired, `iat` not in the future and ≤ 1 h old (checked in code, 60 s clock tolerance), `email_verified: true`, nonce equal to the cookie. Any failure → 401 `unauthorized`; the nonce cookie is cleared after every attempt, so the button fetches a fresh nonce before a retry. A new Google account gets an `app_user` row; a returning one has its email and `hd` refreshed. Google tokens are not stored.

`user` is `{ "nickname": "Minh", "className": "11A1", "isAdmin": false }`. Email and Google sub are never returned.

`PUT /api/me`: `nickname` required, 1–30 characters; `className` optional, ≤ 10. Both are trimmed and NFC-normalised; control, bidi and invisible characters are refused (400 `bad_request`).

---

## Secrets & Configuration

The sign-in flow uses three secrets to prevent replay and CSRF attacks:

| Secret | Purpose | Length | Phase 1 Use |
|--------|---------|--------|-----------|
| `NONCE_KEY` | Signs nonces for sign-in requests (5 min timeout per nonce) | ≥ 32 bytes | Used for `/api/auth/nonce` and POST validation |
| `SUB_HMAC_KEY` | Hashes Google subs in ban tombstones (never rotated during a campaign) | ≥ 32 bytes | Reserved; used in Phase 2 |
| `IP_HMAC_KEY` | Will hash IPs for abuse handling | ≥ 32 bytes | Reserved; used in Phase 2 |

### Generate Secrets (Non-Interactive)

```bash
# Production
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put SUB_HMAC_KEY
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HMAC_KEY

# Staging (use --env flag)
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put SUB_HMAC_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HMAC_KEY --env staging
```

### Local Dev (`.dev.vars`)

```
NONCE_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SUB_HMAC_KEY=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
IP_HMAC_KEY=abcdefedcba0123456789abcdefedcba0123456789abcdefedcba0123456789
```

(Any 64-char hex values work for local dev; they are never exposed.)

### What Happens When Secrets Are Missing

- **Missing `GOOGLE_CLIENT_ID`**: sign-in returns 401 `unauthorized`, logs `auth: misconfigured`
- **Missing `NONCE_KEY`**: sign-in returns 401 `unauthorized`, logs `auth: misconfigured`
- **Missing `NONCE_KEY` on `GET /api/auth/nonce`**: 503, so the button cannot load.
- **`SUB_HMAC_KEY`, `IP_HMAC_KEY`**: not read in Phase 1; setting them now is harmless and saves a step in Phase 2.

Only `NONCE_KEY` (secret) and `GOOGLE_CLIENT_ID` (var) are required for Phase 1. Local dev works with `.dev.vars` placeholders.

---

## Admin Sign-In

**Phase 1 transition:** admins can sign in via either method:
- **Google (preferred, enforced eventually):** any signed-in user whose email is in the `admin` list (and Google is authoritative for that email) is an admin
- **Typed email** (only on the old 20/11 admin routes, while `ADMIN_LEGACY_LOGIN="1"`): no verification; every use logs `admin: legacy login used`. Campaign routes and adding/removing admins need Google.

**Google authority check:** Google is authoritative for an email if:
- Email ends with `@gmail.com` (case-insensitive), **OR**
- `email_verified` is true AND `hd` is set (Workspace domain, Google verified the domain)

**Other emails** (e.g., `admin@school.edu` without Workspace): Google does not vouch for it ("ownership may have changed"), so it cannot be used for admin login even if in the `admin` list.

**Admin sub pinning:**

On a Google admin's first sign-in, `admin.google_sub` is pinned to the verified `sub`. A recycled email cannot inherit the admin role if a different Google account signs in — the second account is refused (403 `forbidden`).

**Example scenario:**

1. Email `giao-vien@gmail.com` is an admin; signs in with Google account A (sub = `abc123`)
2. `admin.google_sub = 'abc123'` is pinned
3. Email owner loses access to account A and uses account B (sub = `xyz789`)
4. Sign-in attempt with account B fails: sub mismatch (403 `forbidden`)
5. To allow account B, another admin unpins the email, then B signs in (and is pinned):
   ```bash
   npx wrangler d1 execute cham-yeu-thuong --remote --command "UPDATE admin SET google_sub = NULL WHERE email = 'giao-vien@gmail.com'"
   ```

**Removal timing:**

Before **Phase 2 production deploy (by 5/12)**:

1. Every admin must have signed in with Google on production
2. Check logs: no `admin: legacy login used` lines in the last 48 h
3. Remove `ADMIN_LEGACY_LOGIN` and `BOOTSTRAP_EMAIL` from the production `vars` in `wrangler.jsonc` (staging never had them)
4. Deploy
5. After deploy: legacy email header is rejected on all admin endpoints (401)

---

## CSP & Headers (Public Headers)

The file `public/_headers` declares security headers. Google Sign-In requires:

```
script-src https://accounts.google.com/gsi/client
frame-src https://accounts.google.com/gsi/
connect-src https://accounts.google.com/gsi/
style-src https://accounts.google.com/gsi/style
```

`npm run build` runs `scripts/check-headers.ts`, which fails the build if this CSP line changes, if any other `accounts.google.com` path appears, or if a wildcard or bare `https:` source is added. `Referrer-Policy` is `strict-origin-when-cross-origin` (Google's recommendation for the button; other sites still get only the origin).

---

## Troubleshooting

### "Google button doesn't load" (blank iframe area)

**Causes:**
- CSP violation (`script-src` doesn't include Google)
- Wrong `client_id` (check `GET /api/auth/nonce` returns the right value)
- Unauthorized JavaScript origin in Google Cloud Console

**Check:**
1. Browser console for CSP violations
2. `GET /api/auth/nonce` response: is `clientId` populated?
3. Current origin in Google Cloud Console: authorized?

### "Sign-in fails after clicking the button" (401 error in UI)

**Causes:**
- `GOOGLE_CLIENT_ID` misconfigured or empty
- `NONCE_KEY` not set (or empty string)
- Nonce expired (> 5 min between button initialization and click)
- ID token verification failed (wrong signature, audience, issuer, or max age)

**Check:**
1. Wrangler logs: `auth: misconfigured`?
2. Post `/api/auth/google` with a fake token: does it fail with 401?
3. Try refreshing the page (fetches fresh nonce)

### "Sign-in works on dev but fails on production"

**Causes:**
- Different `GOOGLE_CLIENT_ID` on prod vs dev (check `vars` in both)
- Production origin not authorized in Google Cloud Console
- Staging and production use different clients but environment is confused

**Check:**
1. `GET /api/auth/nonce` on both envs: are client IDs different?
2. Google Cloud Console: is the production domain in the authorized origins?
3. Browser URL: matches an authorized origin exactly (no extra path, no www mismatch)?

### Sign-in returns 401 after the page was open a while

**Cause:** the nonce is older than 5 minutes, or its cookie was cleared (another tab signed in). The button fetches a new nonce after a failure, so the second click usually works.

**Fix:** reload the page and sign in again (fetches fresh nonce).

---

## Operational Runbook

### Daily During Campaign

No ongoing action needed. Sessions are 14 days; signed-in users stay logged in.

**Monitor:** logs for `auth: misconfigured` (means a secret is unset — not expected during normal operation).

### Pre-Launch Checklist

- [ ] Google Cloud OAuth client created with correct JavaScript origins
- [ ] `GOOGLE_CLIENT_ID` set in `wrangler.jsonc` (prod, staging)
- [ ] `NONCE_KEY` secret set (`SUB_HMAC_KEY`, `IP_HMAC_KEY` optional until Phase 2)
- [ ] CSP headers in `public/_headers` verified (grep for `gsi/`)
- [ ] Test flow: `/admin` → "Đăng nhập bằng Google" → choose account → signed in (the button is only on `/admin` in Phase 1)
- [ ] Test admin: admin email → sign in → admin dashboard loads
- [ ] Check logs: no `auth: misconfigured` on sign-in

### Phase 2 Checklist (Remove Legacy Admin Login)

By **5/12** (before Phase 2 production deploy):

- [ ] All admins have signed in with Google on production
- [ ] Logs show no `admin: legacy login used` for 48 h
- [ ] Remove `ADMIN_LEGACY_LOGIN` and `BOOTSTRAP_EMAIL` from `wrangler.jsonc` `vars`
- [ ] Deploy
- [ ] Verify: the typed-email login on `/admin` now gets 401; Google sign-in works
- [ ] Update admin runbook: remove legacy email path documentation

---

## Reference: Token Validation

Every ID token is checked for:

| Claim | Check | Standard |
|-------|-------|----------|
| `alg` (header) | RS256 only | RSA signature |
| `kid` (header) | non-empty string | key identifier |
| `aud` (payload) | must equal `GOOGLE_CLIENT_ID` | audience |
| `iss` | must be `accounts.google.com` or `https://accounts.google.com` | issuer |
| `exp` | not in the past (clock tolerance 60 s) | expires |
| `iat` | must be in the past (not future), within 1 h max age | issued-at |
| `email` | string | email address |
| `email_verified` | must be `true` | email verified by Google |
| `sub` | required, string | user identifier |
| `nonce` | must match the cookie value (signed HMAC) | anti-replay |
| `hd` | optional, Workspace domain | hosted domain |

**Source:** Plan ADR-3, `docs/tech.md` (Google sign-in section), `worker/google.ts` (implementation).


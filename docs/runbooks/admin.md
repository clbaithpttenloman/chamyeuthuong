# Admin Operations Runbook

Admin access is protected by **Google Sign-In** with identity-based authorization in D1. Admins are stored in an `admin` table; the first person to log in can claim the admin role via a bootstrap email or open claim.

---

## Create a Google OAuth Client

To enable admin sign-in, you must create a Google OAuth client ID (Web application type). This is done **once** in the Google Cloud Console:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **APIs & Services** > **Credentials**
3. Click **+ Create Credentials** > **OAuth client ID**
4. Select **Web application**
5. **Authorized JavaScript origins**: add your site hostname(s):
   - Production: `https://yourdomain.com`
   - Local dev: `http://localhost:5173`
   - (both can be listed; the OAuth consent screen must have been published at least once)
6. Leave **Authorized redirect URIs** empty (Sign-In v3 doesn't use redirect URIs)
7. Click **Create**
8. Copy the **Client ID** (format: `123456789-abc.apps.googleusercontent.com`)
   - **Do NOT copy the client secret** — it is not used by this application

### OAuth Consent Screen Publishing Status

- **Testing**: only email addresses listed as "test users" can sign in
- **In production**: any Google account can sign in (for basic scopes like email)

For a small admin list, either mode works:
- **Testing mode** (simpler): use test user emails in the Google console, and ensure those same emails are also in the `admin` table in D1
- **In production**: anyone can pass Google Sign-In, but the D1 admin list gates who becomes an admin

You can change the publishing status in **APIs & Services** > **OAuth consent screen** > **User type** > **Edit**.

---

## Deploy and Configure

### Set GOOGLE_CLIENT_ID

The client ID goes in two places (must be equal; see mismatch symptoms below):

1. **Worker** (`wrangler.jsonc`): `vars.GOOGLE_CLIENT_ID`
   ```jsonc
   "vars": {
     "GOOGLE_CLIENT_ID": "123456789-abc.apps.googleusercontent.com"
   }
   ```

2. **Frontend** (Vite build): `VITE_GOOGLE_CLIENT_ID` environment variable or build variable
   - Local dev: create `.env` in the project root
     ```
     VITE_GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
     ```
   - Deployed: set as a [Cloudflare build environment variable](https://developers.cloudflare.com/workers/wrangler/environments/#environment-variables)
     (Workers & Pages > Settings > Environment variables)

**Mismatch symptom**: every sign-in attempt returns 401. Check that both values are identical.

### First Deploy Order

1. **Push the repo** to your Git-connected Worker.
   - `GOOGLE_CLIENT_ID` is unset in `wrangler.jsonc`, so the first deploy fails closed: public pages work, `/api/admin/*` returns 401.

2. **Add the OAuth client origins** (if not already done).
   - Google Cloud Console > **APIs & Services** > **Credentials** > your client > edit
   - Ensure your site's hostname and `http://localhost:5173` are in **Authorized JavaScript origins**

3. **Set `GOOGLE_CLIENT_ID` and choose a bootstrap method**.
   - Edit `wrangler.jsonc` (or use a build environment variable) to set `GOOGLE_CLIENT_ID`.
   - Choose **one** of the following for first-admin bootstrap:
     - **`BOOTSTRAP_EMAIL`** (recommended): set this to one email address (e.g., `admin@gmail.com`). Only that person can claim the empty admin table. Stays safe if left in place.
     - **`ALLOW_FIRST_CLAIM=1`** (open claim): set temporarily with `wrangler secret put ALLOW_FIRST_CLAIM`. Any verified Google user can claim. Delete after the first admin is confirmed.

   ```jsonc
   "vars": {
     "GOOGLE_CLIENT_ID": "123456789-abc.apps.googleusercontent.com",
     "BOOTSTRAP_EMAIL": "admin@gmail.com"
   }
   ```

4. **Commit and push**, then wait for the deployment to finish.

5. **Open `/admin`** right away and sign in with Google.
   - You should see the admin list (initially empty).
   - Refresh the page; you should appear in the list.
   - If you see 401, check the logs: `admin: misconfigured` means `GOOGLE_CLIENT_ID` is missing or malformed.

6. **Remove the bootstrap variable** if you used `ALLOW_FIRST_CLAIM`.
   ```bash
   wrangler secret delete ALLOW_FIRST_CLAIM
   npx wrangler deploy
   ```
   (If you used `BOOTSTRAP_EMAIL`, it may stay; it only gates an empty table.)

---

## Who Can Be an Admin

- **Gmail accounts** (`@gmail.com` addresses) — verified with `email_verified: true` claim
- **Google Workspace accounts** — verified with `hd` (hosted domain) claim + `email_verified: true`
- **NOT accepted**: `@googlemail.com`, personal Google accounts without a Workspace domain

**Session lifetime**: about one hour. After that, the admin must sign in again (the UI shows the sign-in button on 401).

---

## Managing Admins

### Adding an Admin

1. Log in to `/admin` as an existing admin
2. Scroll to **Quản trị viên** (Admins)
3. Click **+ Thêm quản trị viên** (Add admin)
4. Enter the email address
5. Click **Thêm** (Add)
6. The admin appears in the list immediately

Email must be a valid Gmail or Google Workspace address.

### Removing an Admin

1. Log in to `/admin`
2. Scroll to **Quản trị viên**
3. Click **Xóa** (Remove) next to the admin
4. **Blocked**: the last admin cannot be removed

Removed admins get a 401 on the next request (not an admin anymore).

### Recovery When the Only Admin Loses Access

If your Google account is deleted or compromised and you're the only admin:

1. Update `BOOTSTRAP_EMAIL` in `wrangler.jsonc` to a new recovery address (or use `wrangler secret put` if you deploy from a laptop).
2. **Delete the admin table** from D1:
   ```bash
   npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"
   ```
3. Deploy the new `BOOTSTRAP_EMAIL`.
4. Sign in with the recovery email; you become the first admin again.
5. Add other admins via the admin page.

---

## Local Development

### Real Google Button

If you've added `http://localhost:5173` to your OAuth client's **Authorized JavaScript origins**:

1. Create `.env` in the project root:
   ```
   VITE_GOOGLE_CLIENT_ID=<your-real-client-id>
   ```

2. Run `npm run dev`

3. The real Google "Sign in with Google" button appears on `/admin`

4. Sign in with any Google account that passes the OAuth consent screen publishing status

### Token-Free Testing (Dev Mode)

For automated tests and curl smoke tests without the browser, use the local Google mock:

1. Run `npm run dev:google` in one terminal.
   - It prints:
     - `.dev.vars` lines to copy (GOOGLE_CLIENT_ID, AUTH_DEV_MODE, AUTH_DEV_JWKS_URL, ALLOW_FIRST_CLAIM)
     - `DEV_GOOGLE_TOKEN` for curl
   - The process keeps running to serve JWKS

2. Copy the `.dev.vars` lines into `.dev.vars` (gitignored).

3. Run `npm run worker:dev` in another terminal.

4. Test with curl:
   ```bash
   export DEV_GOOGLE_TOKEN=<value from npm run dev:google>
   curl -H "Authorization: Bearer $DEV_GOOGLE_TOKEN" http://localhost:8787/api/admin/teachers
   ```

**Never set `AUTH_DEV_MODE=1` in production** — it is for local development only.

---

## Deployment Environments

### Git-Connected Deploy (Cloudflare Git integration)

Configuration lives in `wrangler.jsonc`:

```jsonc
"vars": {
  "GOOGLE_CLIENT_ID": "123456789-abc.apps.googleusercontent.com",
  "BOOTSTRAP_EMAIL": "admin@gmail.com"
}
```

Commit and push to trigger a build and deploy.

### Laptop Deploy

Use the Wrangler CLI:

```bash
# Set GOOGLE_CLIENT_ID (public, can be in vars or secrets)
wrangler secret put GOOGLE_CLIENT_ID
# Paste: 123456789-abc.apps.googleusercontent.com

# Set BOOTSTRAP_EMAIL
wrangler secret put BOOTSTRAP_EMAIL
# Paste: admin@gmail.com

# Deploy
npx wrangler deploy
```

---

## Database

The database `cham-yeu-thuong` and its ID (`9e58f935-fb6f-4c1f-be0b-21a9183ba483`) are pinned in `wrangler.jsonc`. Tables are created automatically on the first request by `ensureSchema(db)` in `worker/schema.ts` — no migration step needed.

To use a different account or database:
```bash
npx wrangler d1 create cham-yeu-thuong
# Update database_id in wrangler.jsonc
```

---

## Error Codes

| Status | Code | Reason |
|--------|------|--------|
| 401 | `unauthorized` | Not signed in, not an admin, expired token, token for an unverified email, token for a non-Gmail/non-Workspace address, misconfigured client ID, or rate limited |
| 403 | `forbidden` | Missing or invalid `X-Requested-With: fetch` header (CSRF check) or cross-site request |
| 429 | `rate_limited` | Too many failed attempts from your IP (30 attempts per 60 s) |
| 503 | `unavailable` | Database error |

**Common issue: 401 `admin: misconfigured`**
- `GOOGLE_CLIENT_ID` is missing, empty, or doesn't end with `.apps.googleusercontent.com`
- For local dev: `AUTH_DEV_MODE=1` is set but `AUTH_DEV_JWKS_URL` is missing or malformed

**Common issue: every sign-in returns 401**
- `GOOGLE_CLIENT_ID` in the Worker does not match `VITE_GOOGLE_CLIENT_ID` in the frontend (check both values are identical)
- Your Google account is not on the OAuth consent screen's test users list (if in Testing mode)
- Your email is not in the `admin` table in D1

---

## Token Rotation and Card Management

See the **Local development** section in `README.md` for QR code generation and token rotation instructions.


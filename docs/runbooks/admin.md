# Admin Operations Runbook

## Cloudflare Access Setup

Admin access is protected by **Cloudflare Access** with Google SSO or One-time PIN. The Worker verifies the JWT and checks the admin email list. No OAuth code in the repo.

### First-time dashboard setup

These steps are performed **once** in the Cloudflare dashboard (outside the repo):

1. **Enable Zero Trust**
   - Go to `https://dash.cloudflare.com/?to=/:account/zero-trust`
   - Click "Activate account" if you haven't already (free up to 50 users)

2. **Choose a login method**
   - Navigate to **Authentication** > **Login methods**
   - Option A: **Google OAuth** — add Google as an IdP and set up Google Cloud credentials
   - Option B: **One-time PIN** (simpler if you don't want to set up OAuth) — users receive a PIN via email

3. **Create a self-hosted Access application**
   - Go to **Applications** > **Self-hosted**
   - Click **Add an application**
   - **Application name**: e.g., "Chạm yêu thương admin"
   - **Subdomain**: leave empty (not used for self-hosted)
   - **Domain**: your site's hostname (e.g., `cham-yeu-thuong.example.com`)
     - If you haven't set a custom domain yet, use the `workers.dev` hostname (see "workers.dev considerations" below)
   - **Application type**: `Self-hosted`
   - Click **Next**

4. **Configure the application policy**
   - Application URLs: add two routes:
     - `/admin*` (covers `/admin` and `/admin/anything`)
     - `/api/admin/*` (covers all admin API endpoints)
   - Policy name: "Admin emails"
     - **Rule type**: `Include` > **Emails** > paste your admin email addresses (one per line, or comma-separated)
     - **Session duration**: 8 hours (or your preferred duration)
   - Click **Next** to finish

5. **Copy the integration details**
   - After creation, you'll see the application page
   - Click **Settings** and scroll to find:
     - **Team domain**: looks like `https://<team>.cloudflareaccess.com` — copy this
     - **Application Audience tag**: a UUID like `abc123...` — copy this
   - (The Worker also needs `ADMIN_EMAILS` — see "Secrets" below)

6. **Access application CORS settings**
   - In the application settings, leave **CORS** and **Bypass OPTIONS** both **OFF** — the Worker handles CSRF protection via the `X-Requested-With` header

### First Deploy

#### 1. Create the D1 database

On first deploy, Wrangler auto-provisions the D1 database. After deployment, capture the database ID and pin it in `wrangler.jsonc`:

```bash
npx wrangler deploy
```

After the deploy succeeds, Cloudflare displays the database ID. Update `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "cham-yeu-thuong", "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
]
```

Then deploy again to pin it:

```bash
npx wrangler deploy
```

#### 2. Apply migrations

```bash
wrangler d1 migrations apply cham-yeu-thuong --remote
```

This creates the `teacher` and `card` tables in production.

#### 3. Set the three required secrets

Use `wrangler secret put` to store the three secrets (kept out of git):

```bash
wrangler secret put ACCESS_TEAM_DOMAIN
# Paste: https://<team>.cloudflareaccess.com

wrangler secret put ACCESS_AUD
# Paste: <application-audience-tag>

wrangler secret put ADMIN_EMAILS
# Paste: admin1@example.com, admin2@example.com, admin3@example.com
# (comma-separated, will be trimmed and lowercased)
```

All three are required. If any is missing or malformed, the admin API returns 401 and logs the fixed string `admin: misconfigured`.

**Important**: `ACCESS_DEV_MODE` must **never** be set in production. It's for local development only (`.dev.vars`).

#### 4. Verify

Visit `/admin` on your deployed domain. After Access login (Google or One-time PIN), the admin dashboard should load and show the empty teacher list.

#### 5. workers.dev considerations

If you have a **custom domain** (e.g., `cham-yeu-thuong.example.com`):
- Add a second Access application for the `workers.dev` hostname (`<name>.<account>.workers.dev`) covering the same routes, OR
- Set `"workers_dev": false` in `wrangler.jsonc` and redeploy to disable the `workers.dev` URL entirely
- Either approach prevents unauthenticated requests from bypassing Access via the `.workers.dev` route

If you don't have a **custom domain yet**:
- Deploy to `workers.dev` first
- In the dashboard setup (step 3), use your `workers.dev` hostname as the domain
- After you later add a custom domain, create a second Access application for the old `workers.dev` route

---

## Admin operations

### Adding an admin

1. In the Cloudflare dashboard, navigate to the Access application
2. Edit the policy to include the new email address
3. Redeploy the Worker with the updated `ADMIN_EMAILS` secret:

   ```bash
   wrangler secret put ADMIN_EMAILS
   # Paste: existing@example.com, newemail@example.com
   ```

The new admin can log in after both changes are done.

### Removing an admin

1. In the Cloudflare dashboard, edit the policy to remove the email address
2. Redeploy the Worker with the updated `ADMIN_EMAILS` secret
3. (Optional) Revoke any active sessions by going to **Access** > **Sessions** in Zero Trust and clicking "Revoke"

The removed email will no longer have access.

### Revoking a session

An admin's login session lasts for the **session duration** set in the Access policy (default 8 hours). To log someone out immediately:

1. Go to Cloudflare Zero Trust dashboard
2. Navigate to **Access** > **Sessions**
3. Find the admin's session and click **Revoke**
4. They must log in again

---

## Card token rotation

When a card's QR code is leaked or needs to change:

1. Log in to `/admin`
2. Find the teacher in the list
3. Click **Đổi mã** (rotate token)
4. The old URL (`/t/old-token`) returns 404
5. Print a new QR code with the new token

---

## Observability

**Workers Logs and real-time tail are intentionally disabled** to keep fixed-string logging only (no tokens, names or messages appear in logs).

If a Worker request fails, Cloudflare's standard observability shows:
- HTTP status and method
- Response time
- Rate limit and resource metrics

For debugging during development:
```bash
npm run worker:dev
```

Errors appear in the terminal where `wrangler dev` is running.

---

## Printing QR codes

1. Log in to the admin page (`/admin`)
2. Create or edit a teacher to publish their card
3. Click **QR** to display the code in the browser
4. Click **Tải PNG** to save as PNG
5. Print the PNG

The QR code encodes the public card URL (e.g., `https://domain/t/token`). A teacher scans it with a phone camera to read their personalized message.

---

## Local development

See the **Local development** section in `README.md` for step-by-step instructions on running the dev Access mock (`npm run dev:access`), starting the Worker and frontend, and testing the admin flow locally.

**Never set `ACCESS_DEV_MODE=1` in production** — it is for local development only and must stay in `.dev.vars`.

---

## Error codes

When the admin API fails, the response includes an error code. Common ones:

| Status | Code | Reason |
|--------|------|--------|
| 401 | `unauthorized` | Not signed in via Access, not in the allowed email list, or JWT misconfigured |
| 403 | `forbidden` | Missing `X-Requested-With: fetch` header on a non-GET request, or cross-site request detected |
| 429 | `rate_limited` | Too many failed attempts from your IP in the last 60 seconds |

If you see 401, check:
- You're logged in to Cloudflare Access (the login page at `/` should not appear for `/admin`)
- Your email is listed in the policy (ask an admin to verify)
- The three secrets are correctly set (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`)

If you see 403, check:
- You're using a modern browser (Edge, Chrome, Firefox, Safari) — old browsers may not send the required headers

If you see 429, wait a minute and try again.

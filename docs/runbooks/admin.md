# Admin Operations Runbook

## Admins in D1

Admins are stored in the `admin` table in D1 and managed via the admin page (`/admin`). No static email list.

### First-time bootstrap

On first deploy, the first person to log in via Cloudflare Access becomes the admin. This requires either:
- **`BOOTSTRAP_EMAIL`**: set this secret to a specific email address; only that person can claim admin
- **`ALLOW_FIRST_CLAIM`**: set this variable to `1` (open claim); any Access-verified user can claim admin (Superset-style)

Set **one** of these via the Wrangler CLI for the first deploy only. After the first admin is confirmed in `/admin`, remove the variable and redeploy. See "First Deploy" below for the exact steps.

Leftover flags are inert once an admin exists: they are only checked when the admin table is empty.

---

## Cloudflare Access Setup

Admin access is protected by **Cloudflare Access** with Google SSO or One-time PIN. The Worker verifies the JWT and checks the admin table. No OAuth code in the repo.

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

4. **Configure the application policy — allow-list only**
   - Application URLs: add two routes:
     - `/admin*` (covers `/admin` and `/admin/anything`)
     - `/api/admin/*` (covers all admin API endpoints)
   - Policy name: "Allow-list"
     - **Rule type**: `Include` > **Emails** > paste the email addresses you want to allow initially (one per line, or comma-separated)
     - **Session duration**: 8 hours (or your preferred duration)
   - Click **Next** to finish
   - **Important**: the Access policy is your first gate; use an allow-list, not "everyone with a Google account"

5. **Copy the integration details**
   - After creation, you'll see the application page
   - Click **Settings** and scroll to find:
     - **Team domain**: looks like `https://<team>.cloudflareaccess.com` — copy this
     - **Application Audience tag**: a UUID like `abc123...` — copy this
   - (These become the secrets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` below)

6. **Access application CORS settings**
   - In the application settings, leave **CORS** and **Bypass OPTIONS** both **OFF** — the Worker handles CSRF protection via the `X-Requested-With` header

### First Deploy

#### 1. Create the allow-list Access policy (required before first deploy)

**The Access policy must be an allow-list, not "everyone with a Google account".** This is the first gate: only people on the list can reach the Worker at all. See "First-time dashboard setup" above; make sure step 4 creates a policy with an allow-list.

The Worker will dynamically create the first admin based on the claim variables (see step 4 below). The Access policy gates _who can reach the endpoint_; the claim variables gate _who can become the first admin_ without needing to be in the DB yet.

#### 2. D1 database

The database `cham-yeu-thuong` already exists and its ID (`9e58f935-fb6f-4c1f-be0b-21a9183ba483`) is pinned in `wrangler.jsonc`, so every deploy uses it. To use a different account or database, create one with `npx wrangler d1 create cham-yeu-thuong` and replace `database_id` in `wrangler.jsonc`.

#### 3. Apply migrations

```bash
wrangler d1 migrations apply cham-yeu-thuong --remote
```

This creates the `teacher`, `card`, and `admin` tables in production.

#### 4. Set the two required secrets

Use the Wrangler CLI (`wrangler secret put`) to store secrets (kept out of git):

```bash
wrangler secret put ACCESS_TEAM_DOMAIN
# Paste: https://<team>.cloudflareaccess.com

wrangler secret put ACCESS_AUD
# Paste: <application-audience-tag>
```

**Do not use `wrangler.jsonc` for secrets** — that file is version-controlled. Secrets are set **only via the CLI**.

#### 5. Set ONE claim variable (via CLI) for first bootstrap

Choose **one** and set it with `wrangler secret put`:

**Option A: Specific email (recommended for recovery)**
```bash
wrangler secret put BOOTSTRAP_EMAIL
# Paste: admin@example.com
```
Only this exact email (after trimming and lowercasing) can claim the first-admin slot.

**Option B: Open claim**
```bash
wrangler secret put ALLOW_FIRST_CLAIM
# Paste: 1
```
Any verified Access user can claim the first-admin slot (open, Superset-style).

Set the variable that matches your needs. Do **not** set both; if `BOOTSTRAP_EMAIL` is set, it takes precedence and `ALLOW_FIRST_CLAIM` is ignored.

After setting one of these, deploy:

```bash
npx wrangler deploy
```

#### 6. Verify first-admin bootstrap

1. Visit `/admin` on your deployed domain
2. After Access login, you'll be redirected to the admin page
3. The page should load and show **Quản trị viên** section with zero admins
4. Refresh the page or open `/api/admin/admins` in a new tab
5. **You should now appear in the admin list** (if your email matched the claim gate)
6. If you see 401 or an empty list after refresh, check the logs:
   - "admin: misconfigured" → neither claim variable was set correctly
   - "admin: bootstrap" → you successfully claimed admin (good!)

#### 7. Remove the claim variable and redeploy

```bash
# Remove the variable (choose whichever you set):
wrangler secret delete BOOTSTRAP_EMAIL
# or
wrangler secret delete ALLOW_FIRST_CLAIM

# Redeploy to commit the removal
npx wrangler deploy
```

The first admin is now in the DB. The claim variables are inert for future logins (only read when the table is empty). You can now add more admins via the admin page.

---

## Managing admins

### Adding an admin

1. Log in to `/admin` with an existing admin account
2. Scroll to **Quản trị viên** section
3. Enter the new admin's email address
4. Click **Thêm** (add)
5. The new admin appears in the list immediately.
6. **Also add their email to the Access policy** (Zero Trust > Access > Applications > your app > Policies). Access is the first gate: someone who is not on the Access allow-list never reaches the Worker, so being in the admin list alone is not enough.

### Removing an admin

1. Log in to `/admin` with an existing admin account
2. Scroll to **Quản trị viên** section
3. Find the admin you want to remove
4. Click **Xóa** (delete) next to their name
5. **Blocked**: the last admin cannot be removed (the UI and API both prevent this)

Removing an admin from the DB _does not_ revoke their Access session (they remain logged in for the session duration). To force logout:

1. Go to Cloudflare Zero Trust dashboard
2. Navigate to **Access** > **Sessions**
3. Find the admin's session and click **Revoke**
4. They must log in again

If you also want to stop them from reaching the site at all, remove their email from the Access policy. Until then they can still pass Access but will see 401 when trying to access `/admin` or any API endpoint (not an admin anymore).

### Recovery when the only admin loses access

If your Gmail account is deleted or compromised and you're the only admin:

1. Set a new BOOTSTRAP_EMAIL via the CLI:
   ```bash
   wrangler secret put BOOTSTRAP_EMAIL
   # Paste: recovery@example.com (your new email)
   ```
   Make sure `ALLOW_FIRST_CLAIM` is **not set** (delete it if it is).

2. Delete the admin table via D1:
   ```bash
   wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"
   ```

3. Redeploy:
   ```bash
   npx wrangler deploy
   ```

4. Log in via Access with the recovery email address

5. You should now become the new first admin

6. Remove the `BOOTSTRAP_EMAIL`:
   ```bash
   wrangler secret delete BOOTSTRAP_EMAIL
   npx wrangler deploy
   ```

**Common error after first deploy**: "401 Unauthorized" with a log line `admin: misconfigured`. This means neither `BOOTSTRAP_EMAIL` nor `ALLOW_FIRST_CLAIM` was set. Set one of them and redeploy.

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
| 400 | `bad_request` | Invalid email format or missing required fields |
| 401 | `unauthorized` | Not signed in via Access, not an admin, or not in the allow-list |
| 403 | `forbidden` | Missing `X-Requested-With: fetch` header or cross-site request detected |
| 404 | `not_found` | Teacher or admin ID not found |
| 409 | `conflict` | Duplicate email (add admin) or last admin (remove admin) |
| 414 | `too_long` | Request body too large |
| 429 | `rate_limited` | Too many failed attempts from your IP in the last 60 seconds |
| 405 | `method` | HTTP method not allowed for this endpoint |
| 503 | `unavailable` | Server error or database issue |

If you see 401, check:
- You're logged in to Cloudflare Access (the login page should not appear for `/admin`)
- Your email is in the Access allow-list policy (ask an admin to verify)
- The two secrets are correctly set (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`)

If you see 403, check:
- You're using a modern browser (Edge, Chrome, Firefox, Safari) — old browsers may not send the required headers

If you see 409 when removing an admin, check:
- You're not trying to remove the last admin (another admin must exist first)

If you see 429, wait a minute and try again.

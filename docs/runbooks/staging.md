# Staging Environment Setup & Operations — Phase 1 Campaign Platform

This runbook covers setting up and using the staging environment for load testing and pre-launch smoke tests before deploying to production.

---

## Overview

**Staging environment:** A separate Cloudflare Worker, D1 database, and rate-limit namespace (3000s instead of 2000s) that mirrors production configuration but is isolated from live data.

**Purpose:** Load test the platform under event-like traffic, verify real-phone performance, and run comprehensive smoke tests before the production launch.

**Constraints (Phase 1):**
- No legacy admin login (`ADMIN_LEGACY_LOGIN` not set; no `BOOTSTRAP_EMAIL`)
- Staging admins are seeded manually with `wrangler d1 execute`
- No first-admin bootstrap; explicit seed is required

**Destroying:** After tests, run `npx wrangler delete --env staging` and `npx wrangler d1 delete cham-yeu-thuong-staging` to clean up (marked destructive below).

---

## Setup (One-Time)

### Step 1: Create Staging D1 Database

```bash
npx wrangler d1 create cham-yeu-thuong-staging
```

Output shows:
```
✓ Successfully created DB "cham-yeu-thuong-staging" in region WNAM
[uuid] Database ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Note the **Database ID**.

### Step 2: Update `wrangler.jsonc`

Replace `PLACEHOLDER_STAGING_D1_DATABASE_ID` with the actual ID from Step 1:

```jsonc
{
  "env": {
    "staging": {
      "name": "cham-yeu-thuong-staging",
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "cham-yeu-thuong-staging",
          "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        }
      ]
    }
  }
}
```

### Step 3: Create Staging OAuth Client (Google Cloud)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select the same project as production
3. **APIs & Services** → **Credentials** → **Create OAuth 2.0 Client ID** (Web application)
4. **Authorized JavaScript origins:**
   - `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev`
   - `http://localhost` and `http://localhost:8787` (Google asks for both forms when testing locally)
5. No redirect URIs
6. Copy the **Client ID**

### Step 4: Set Staging Secrets & Vars

```jsonc
{
  "env": {
    "staging": {
      "vars": {
        "GOOGLE_CLIENT_ID": "<staging-oauth-client-id>"
        // ADMIN_LEGACY_LOGIN and BOOTSTRAP_EMAIL intentionally absent
      }
    }
  }
}
```

Commit this change:

```bash
git add wrangler.jsonc
git commit -m "Add staging environment config"
```

**Set secrets** (only `NONCE_KEY` is read in Phase 1):

```bash
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put SUB_HMAC_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HMAC_KEY --env staging
```

(These are separate from production secrets.)

### Step 5: Deploy Staging

```bash
npx wrangler deploy --env staging
```

Verify deployment succeeded:

```bash
curl https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/
```

You should see the frontend (SPA index.html).

### Step 6: Seed Staging Admin

Unlike production, staging has no bootstrap email. Admins are seeded explicitly with `wrangler d1 execute`.

```bash
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command \
  "INSERT INTO admin (email, created_at, created_by) VALUES ('you@example.com', datetime('now'), 'seed')"
```

Repeat for each admin:

```bash
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command \
  "INSERT INTO admin (email, created_at, created_by) VALUES ('another-admin@gmail.com', datetime('now'), 'seed')"
```

**Verify:**

```bash
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command "SELECT email FROM admin"
```

---

## Using Staging

### Access the Staging Site

**Frontend:** `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/`

**Admin:** `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/admin`

### Testing Google Sign-In on Staging

1. Visit the site
2. Press the sign-in button
3. Select a Google account (use your personal account for testing)
4. After sign-in, you can create campaigns, manage users, etc.

**Note:** Campaign admin endpoints require a Google session (no legacy email header). If you see "Vui lòng đăng nhập bằng Google" on the admin page, it means you are not signed in.

### Load testing (public reads)

```bash
ab -n 1000 -c 100 https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/campaigns/active
```

Most of these are served from the 5 s in-isolate cache. Gift endpoints arrive in Phase 2.

### Real phones

On an iPhone and an older Android phone: open `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/admin`, sign in with Google, open the Chiến dịch tab. Then open the same link inside Zalo or Messenger: the page must show the "mở bằng trình duyệt" guide instead of the Google button (Google blocks sign-in in in-app browsers).

---

## Verification checklist

Set `S=https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev` and copy your session cookie from the browser after signing in (`__Host-cyt_s`, DevTools → Application → Cookies) into `C`.

- [ ] **Campaign 1 exists:** `curl -s $S/api/campaigns/active` → `"slug":"20-11"`, `"open":true`.
- [ ] **Sign-in:** `/admin` → "Đăng nhập bằng Google" → admin sections load; `curl -s $S/api/auth/nonce` shows the staging `clientId`.
- [ ] **No typed-email login on staging:** `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Admin-Email: you@example.com' $S/api/admin/teachers` → `401`.
- [ ] **Campaign API** (snake_case body; new campaigns are drafts):
  ```bash
  curl -s -X POST $S/api/admin/campaigns -H "Cookie: __Host-cyt_s=$C" -H 'X-Requested-With: fetch' -H 'Content-Type: application/json' \
    -d '{"slug":"thu-nghiem","kind":"gift_tree","name":"Thử nghiệm","starts_at":"2026-12-01T00:00:00Z","ends_at":"2026-12-24T16:59:59Z"}'
  curl -s $S/api/campaigns/thu-nghiem                       # 404 while draft
  curl -s -X POST $S/api/admin/campaigns/<id>/activate -H "Cookie: __Host-cyt_s=$C" -H 'X-Requested-With: fetch'
  curl -s -X POST $S/api/admin/campaigns/1/activate -H "Cookie: __Host-cyt_s=$C" -H 'X-Requested-With: fetch'   # back to 20/11
  ```
- [ ] **Sub pinning:** set a different pinned sub for your admin email, sign in again → the admin sections are refused; then unpin:
  ```bash
  npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command "UPDATE admin SET google_sub = 'someone-else' WHERE email = 'you@gmail.com'"
  npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command "UPDATE admin SET google_sub = NULL WHERE email = 'you@gmail.com'"
  ```
- [ ] **One 429 per new limit class** (proves each binding is wired; limits are per Cloudflare location and approximate, so send a little more than the limit):
  ```bash
  # USER_WRITE_LIMIT 10/60 s
  for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code} ' -X PUT $S/api/me -H "Cookie: __Host-cyt_s=$C" -H 'X-Requested-With: fetch' -H 'Content-Type: application/json' -d '{"nickname":"Thử","className":"10A1"}'; done; echo
  # USER_READ_LIMIT 120/60 s
  seq 1 200 | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: __Host-cyt_s=$C" $S/api/me | sort | uniq -c
  # AUTH_LIMIT 300/60 s (failed sign-ins)
  seq 1 400 | xargs -P 40 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'X-Requested-With: fetch' -H 'Content-Type: application/json' -d '{"credential":"x"}' $S/api/auth/google | sort | uniq -c
  # PUBLIC_READ_LIMIT 3,000/60 s (cache misses only, so use distinct slugs)
  seq 1 3500 | xargs -P 100 -I{} curl -s -o /dev/null -w '%{http_code}\n' $S/api/campaigns/khong-co-{} | sort | uniq -c
  ```
  Each block should show some `429`. `AUTH_SUB_LIMIT` (10 successful sign-ins per minute per account) is covered by tests only.

After the 429 checks, wait a minute before using staging again. Rate-limit counters are separate from production (namespaces 3001–3010).

---

## Cleanup

**⚠️ DESTRUCTIVE — This deletes all staging data and the Worker.**

After testing, free up resources:

### Delete Staging Worker

```bash
npx wrangler delete --env staging --dry-run   # check it names cham-yeu-thuong-staging
npx wrangler delete --env staging
```

`wrangler delete` has no skip-confirmation flag; run it yourself in a terminal and answer the prompt.

### Delete Staging Database

```bash
npx wrangler d1 delete cham-yeu-thuong-staging --skip-confirmation
```

Check the name twice: never run this with `cham-yeu-thuong` (production).

### Clean Up `wrangler.jsonc` (Optional)

Remove the `env.staging` block if you won't need staging again, or leave it for future testing.

---

## Troubleshooting

### "403 Forbidden" on Admin Endpoints

**Cause:** signed in with Google, but the email is not in the staging `admin` table, Google is not authoritative for it (not `@gmail.com` and no Workspace `hd`), or its pinned `google_sub` belongs to another account. Also returned for a write without `X-Requested-With: fetch` or with `Sec-Fetch-Site: cross-site`.

**Fix:** seed the email (Step 6), use a Gmail/Workspace account, and send the header on writes:

```bash
curl -H "X-Requested-With: fetch" https://...
```

### "401 Unauthorized" on Admin Endpoints

**Cause:** no valid Google session (not signed in, session expired, or cookie not sent). Staging has no typed-email login, so `X-Admin-Email` always gets 401.

**Fix:** sign in again on `/admin` and copy the fresh `__Host-cyt_s` cookie.

### "Database doesn't exist" on `wrangler d1 execute`

**Cause:** D1 database not created, or wrong database ID in `wrangler.jsonc`.

**Fix:** Check the ID:

```bash
npx wrangler d1 list
```

Copy the correct **ID** and update `wrangler.jsonc`.

### Load Test Shows "Worker CPU exceeded" (Free Plan)

**Cause:** Decoding base64 images on the free tier exceeds 10 ms CPU budget under load.

**Fix:**
1. Test on a plan with higher limits (Paid, Workers)
2. Or reduce image size/count in staging setup

---

## Operational Notes

### Staging Costs

- **D1 storage:** ~1–10 MB (negligible)
- **Worker invocations:** free (on free tier, with limits)
- **Outbound bandwidth:** negligible
- **Teardown savings:** total cost is $0 unless you deploy to a Paid plan or use R2

### Keeping Staging Minimal

- Only seed essential admins (2–3)
- Do not upload many theme images (testing doesn't need the full 15 MB campaign cap)
- Delete staging after each test cycle to keep account clean

### Metrics to Collect (Load Test)

- Latency (p50, p95, p99)
- Throughput (requests/second)
- Error rate (4xx, 5xx)
- CPU time (if available)
- Worker cold start time

Export results for comparison before/after optimizations.

---

## Phase 1 Campaign Platform

**Difference from student cards model:** Campaigns replace the static 20/11 structure. Campaign 1 (slug `20-11`) is the migrated 20/11 event; admins create additional campaigns with their own dates, content, and theme settings (Phase 3). Phase 1 has minimal campaign admin UI (content, dates, status; settings with defaults). No gifts or hearts in Phase 1 — those are Phase 2 (Noel game).

**Sign-in in Phase 1:** Identical to the student cards admin flow — Google-only for new campaign CRUD, legacy email header stays on for 20/11 admin endpoints while `ADMIN_LEGACY_LOGIN="1"`. Before Phase 2 production deploy, the flag must be removed after every admin has signed in with Google and the log shows no `admin: legacy login used` for 48 h.


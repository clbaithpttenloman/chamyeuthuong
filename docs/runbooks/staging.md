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

**Set secrets** (Phase 2 requires all three):

```bash
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put SUB_HMAC_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HMAC_KEY --env staging
```

(These are separate from production secrets.)

### Step 5: Deploy and Test

```bash
npx wrangler deploy --env staging
```

Verify staging is working:
```bash
curl https://cham-yeu-thuong-staging.<account>.workers.dev/api/campaigns/active
# Should return 200 with campaign info (or empty if none created yet)
```

---

## Seed Users for Load Testing (Phase 2)

### Seed load-test users (staging only)

`scripts/staging-seed-users.ts` writes SQL for N test users with one session each and prints the command to apply it. It never runs SQL itself, and it refuses to run while `env.staging` still has `PLACEHOLDER_STAGING_D1_DATABASE_ID` or the production database id.

```bash
node scripts/staging-seed-users.ts --users 600 --hours 6
# prints: <tmp>/seed.sql, <tmp>/tokens.txt (one session token per line, mode 0600)
# and the command to apply it, for example:
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --file <tmp>/seed.sql
```

Users are `loadtest-…` with accounts dated 2 days back (so their reports count). Remove them afterwards:

```bash
node scripts/staging-seed-users.ts --cleanup   # prints the SQL and the command; review, then run it
```

The cleanup deletes the test users' reports, hearts, gifts, sessions and accounts. Gifts of real staging users that the test users hearted keep a stale `heart_count`; staging only, acceptable.

### Load test: hearts (NFR-3)

Goal: about **50 requests/s for 60 s on the staging Worker + D1 with 0 × 5xx**. Business answers (`already_hearted` 409, `hearts_exhausted` 429) are expected and are not errors; count them separately. Each account may give 5 hearts per Vietnam day and 20 heart requests per minute, so spread the load over many accounts: 600 accounts × 5 hearts = 3,000 requests.

1. Seed 600 users (above) and activate the Noel campaign on staging with dates covering now.
2. Give each test account one gift so there is something to heart (the k6 script below does it in its setup, 6 gifts per minute per account is the limit, so one each is fine).
3. Run k6 (install k6 separately; it is not a project dependency). Save as a local file outside the repo, e.g. `<tmp>/hearts.js`:

```javascript
import http from 'k6/http'
import { check } from 'k6'
const BASE = __ENV.BASE                  // https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev
const SLUG = __ENV.SLUG || 'noel-2026'
const TOKENS = open(__ENV.TOKENS).trim().split('\n')
const H = (t) => ({ headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Cookie: `__Host-cyt_s=${t}` } })
export const options = { scenarios: { hearts: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1s', duration: '60s', preAllocatedVUs: 100 } } }
export function setup() {
  const t = JSON.parse(http.get(`${BASE}/api/campaigns/${SLUG}/templates`).body)[0]
  for (const tok of TOKENS) http.post(`${BASE}/api/campaigns/${SLUG}/gifts`, JSON.stringify({ boxStyle: 1, ornamentStyle: 1, layout: t.layout, backgroundTemplateId: t.id, font: 'patrick-hand', ink: '#1d3fa6', message: 'Thử tải', nickname: 'Thử', className: 'LT' }), H(tok))
  const ids = []
  for (let p = 1; p <= 25; p++) { const g = JSON.parse(http.get(`${BASE}/api/campaigns/${SLUG}/gifts?sort=new&page=${p}`).body); if (!g.gifts || !g.gifts.length) break; ids.push(...g.gifts.map((x) => x.publicId)) }
  return { ids }
}
export default function (data) {
  const i = (__VU * 1000 + __ITER) % TOKENS.length
  const gift = data.ids[Math.floor(Math.random() * data.ids.length)]
  const r = http.post(`${BASE}/api/gifts/${gift}/heart`, '{}', H(TOKENS[i]))
  check(r, { 'no 5xx': (x) => x.status < 500 })
}
```

```bash
k6 run -e BASE=https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev -e TOKENS=<tmp>/tokens.txt <tmp>/hearts.js
```

Field names match `POST /api/campaigns/<slug>/gifts` and the list response `{ gifts }` (checked against `worker/gifts.ts` and `worker/tree.ts`, 2026-11-21). Pass: the `no 5xx` check is 100 %. Afterwards confirm in D1 that counters did not drift:

```bash
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command "SELECT COUNT(*) AS drift FROM gift g WHERE g.heart_count != (SELECT COUNT(*) FROM heart h WHERE h.gift_id = g.id)"
# expect drift = 0
```

### Load test: tree reads from one IP

Goal: 1,200 requests/minute from one IP for 2 minutes, **0 × 429** (a whole school behind one IP). Tree reads are answered from a 5 s per-instance cache and only cache misses count against `TREE_READ_LIMIT` (3,000/min per IP).

```bash
# 20 requests/s for 120 s (hey: -q is per worker, so 1 worker × 20 qps)
hey -z 120s -c 1 -q 20 https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/campaigns/noel-2026/tree
```

Pass: every response is 200 (hey prints the status-code distribution).

---

## Pre-Launch Verification

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


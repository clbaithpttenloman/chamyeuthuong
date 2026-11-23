# Staging Environment Setup & Operations — Phase 2b Campaign Platform

This runbook covers setting up and using the staging environment for load testing and pre-launch smoke tests before deploying to production.

---

## Overview

**Staging environment:** A separate Cloudflare Worker, D1 database, and rate-limit namespace (3000s instead of 2000s) that mirrors production configuration but is isolated from live data.

**Purpose:** Load test the platform under event-like traffic, verify real-phone performance, and run comprehensive smoke tests before the production launch.

**Key differences from production (Phase 2b):**
- Staging D1 schema is fresh (no production data)
- Secrets are unique values (not shared with production)
- First account registered on staging becomes admin
- Seed script creates test accounts with password identities
- Rate limits use 3000-series namespace IDs (vs 2000-series production)

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
      ],
      "vars": {
        "REGISTER_IP_DAILY": "3000",
        "REGISTER_GLOBAL_DAILY": "30000"
      }
    }
  }
}
```

### Step 3: Set Staging Secrets

**All three secrets are required** (they differ from production and are only used in staging):

```bash
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put PASSWORD_PEPPER --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put IP_HMAC_KEY --env staging
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put SUB_HMAC_KEY --env staging
```

### Step 4: Deploy and Test

```bash
npx wrangler deploy --env staging
```

Verify staging is working:
```bash
curl https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/campaigns/active
# Should return 200 with campaign info (or empty if none created yet)
```

---

## Seed Test Accounts for Load Testing

### Register the first admin

Visit the staging site and register your first account via `/dang-ky`. This account auto-becomes admin.

### Seed load-test users (staging only)

`scripts/staging-seed-users.ts` writes SQL for N test users with password identities and sessions. It never runs SQL itself.

```bash
node scripts/staging-seed-users.ts --users 600 --hours 6
# prints: <tmp>/seed.sql, <tmp>/tokens.txt (one session token per line, mode 0600)
# and the command to apply it, for example:
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --file <tmp>/seed.sql
```

Users are `loadtest_<n>` with accounts dated 2 days back (so their reports count). Remove them afterwards:

```bash
node scripts/staging-seed-users.ts --cleanup
```

---

## Pre-Launch Verification

### Real-phone smoke test

On an iPhone and an older Android phone: open the staging site URL (`https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/`), sign in with `/dang-nhap`, create a gift, give hearts, check the leaderboard. Verify ≥ 50 fps on Android with 20+ gifts and snow particles.

### Load test: hearts (NFR-3)

Goal: **50 requests/s for 60 s with 0 × 5xx**. Business answers (`already_hearted` 409, `hearts_exhausted` 429) are expected; count them separately. Each account may give 5 hearts per Vietnam day, so spread the load over many accounts: 600 accounts × 5 hearts = 3,000 requests.

1. Seed 600 users (above) and activate the Noel campaign on staging with dates covering now.
2. Give each test account one gift (k6 script below does this in setup).
3. Run k6 (install k6 separately; it is not a project dependency). Save as a local file, e.g. `<tmp>/hearts.js`:

```javascript
import http from 'k6/http'
import { check } from 'k6'
const BASE = __ENV.BASE
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

Pass: the `no 5xx` check is 100%. Afterwards confirm in D1 that counters did not drift:

```bash
npx wrangler d1 execute cham-yeu-thuong-staging --env staging --remote --command "SELECT COUNT(*) AS drift FROM gift g WHERE g.heart_count != (SELECT COUNT(*) FROM heart h WHERE h.gift_id = g.id)"
# expect drift = 0
```

### Load test: tree reads from one IP

Goal: 1,200 requests/minute from one IP for 2 minutes, **0 × 429** (a whole school behind one IP). Tree reads are answered from a 5 s per-instance cache and only cache misses count against `TREE_READ_LIMIT` (3,000/min per IP).

```bash
# 20 requests/s for 120 s
hey -z 120s -c 1 -q 20 https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/campaigns/noel-2026/tree
```

Pass: every response is 200.

---

## Using Staging

### Access the Staging Site

**Frontend:** `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/`

**Admin:** `https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/admin`

### Register a test account

```bash
curl -X POST -H "Content-Type: application/json" -H "X-Requested-With: fetch" \
  -d '{"username":"testuser1","password":"TestPass123!","nickname":"Test","className":"10A"}' \
  https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/auth/register
```

### Sign in

```bash
curl -X POST -H "Content-Type: application/json" -H "X-Requested-With: fetch" \
  -c cookies.txt \
  -d '{"username":"testuser1","password":"TestPass123!"}' \
  https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/auth/login
```

### Test admin endpoints

```bash
curl -b cookies.txt -H "X-Requested-With: fetch" \
  https://cham-yeu-thuong-staging.<account-subdomain>.workers.dev/api/admin/admins
```

---

## Verification Checklist

- [ ] **Staging D1 created:** `npx wrangler d1 list` shows `cham-yeu-thuong-staging`
- [ ] **Secrets set:** `printf '%s' "$(openssl rand -hex 32)"` three times for the three secrets
- [ ] **First admin registered:** visit `/dang-ky`, register, visit `/admin` and confirm you are admin
- [ ] **Campaign active:** `curl -s $S/api/campaigns/active` shows the Noel campaign with `"open":true`
- [ ] **Load test passed:** 50 req/s hearts with 0 × 5xx, tree reads with 0 × 429
- [ ] **Real phones tested:** iPhone and Android, both ≥ 50 fps

---

## Cleanup

**⚠️ DESTRUCTIVE — This deletes all staging data and the Worker.**

After testing, free up resources:

### Delete Staging Worker

```bash
npx wrangler delete --env staging --dry-run
npx wrangler delete --env staging
```

### Delete Staging Database

```bash
npx wrangler d1 delete cham-yeu-thuong-staging --skip-confirmation
```

**Check the name twice: never run this with `cham-yeu-thuong` (production).**

---

## Troubleshooting

### "schema: stale app_user" on staging

**Cause:** Staging D1 was created from an earlier branch with the Phase 1 `app_user` schema (with `google_sub` column).

**Fix:** Recreate the staging D1:

```bash
npx wrangler d1 delete cham-yeu-thuong-staging --skip-confirmation
# Then go back to Step 1 of Setup to create a fresh one
```

### "401 Unauthorized" on admin endpoints

**Cause:** No valid session (not signed in, session expired, or cookie not sent).

**Fix:** Sign in again on `/dang-nhap` and use the fresh `__Host-cyt_s` cookie.

### "Database doesn't exist" on `wrangler d1 execute`

**Cause:** D1 database not created, or wrong database ID in `wrangler.jsonc`.

**Fix:** Check the ID:

```bash
npx wrangler d1 list
```

Copy the correct **ID** and update `wrangler.jsonc`.

### Load test shows "Worker CPU exceeded"

**Cause:** Free-plan limits exceeded under load.

**Fix:** Test on a Paid plan or reduce load.

---

## Operational Notes

### Staging Costs

- **D1 storage:** ~1–10 MB (negligible)
- **Worker invocations:** free (on free tier, with limits)
- **Outbound bandwidth:** negligible
- **Teardown savings:** total cost is $0 unless on a Paid plan

### Keeping Staging Minimal

- Only seed test admins and accounts needed for testing
- Delete staging after each test cycle to keep account clean


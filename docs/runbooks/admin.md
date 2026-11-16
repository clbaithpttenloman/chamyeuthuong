# Admin Operations Runbook

Admin access is protected by a typed email (sent as `X-Admin-Email` header) checked against a D1 `admin` table. The first person to log in claims the admin role via a bootstrap email or open claim.

---

## ⚠️ Important: Email is NOT verified

The admin email is typed in the browser and sent to the Worker — **there is no identity verification**. Anyone who knows or guesses an admin email can edit or delete cards and add themselves as an admin. This is accepted risk R1.

**Mitigation:**
- Keep admin emails **private** — do not share them publicly.
- Rate limit (30 requests per 60 s per IP) slows down guessing.
- The SSO version is preserved in git (`tag sso-google-signin`, `commit cec9a58`) and can be restored at any time.

---

## How Admin Login Works

1. User opens `/admin` and sees a form asking for their email.
2. User types an email and clicks **Đăng nhập** (Sign in).
3. The page stores the email in `sessionStorage` (tab-local storage, cleared when tab closes).
4. On every API request, the email is sent as the `X-Admin-Email` header.
5. The Worker checks it against the `admin` table:
   - If found → request proceeds; admin can manage teachers and cards.
   - If not found → **401 Unauthorized** with message "Email này chưa có quyền quản trị" (This email does not have admin permissions).
6. To sign out, click **Đổi email** — the stored email is cleared and the form appears again.

---

## First Deploy (Git-connected Cloudflare)

### 1. Choose a Bootstrap Method

Before the first deploy, decide how the first admin will claim the role:

- **`BOOTSTRAP_EMAIL`** (recommended): Set this to one specific email address (e.g., `admin@yourdomain.com`). Only that exact email can claim the empty admin table. Safe to keep set — it stays inert once the table has any admin.
- **`ALLOW_FIRST_CLAIM=1`** (temporary open claim): Any email can claim. Set only as a temporary secret, delete immediately after the first admin is confirmed.

### 2. Configure wrangler.jsonc

Edit `wrangler.jsonc` and set **one** of the above:

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "admin@yourdomain.com"
  }
}
```

Or for `ALLOW_FIRST_CLAIM`, add it later as a secret (see step 5 below).

### 3. Commit and Push

```bash
git add wrangler.jsonc
git commit -m "Configure admin bootstrap"
git push
```

Wait for Cloudflare to build and deploy.

### 4. Open `/admin` and Sign In Immediately

As soon as the deploy finishes, open your site's `/admin` page and type the email you configured in `BOOTSTRAP_EMAIL`.

- If you see the admin list (initially empty) and your email appears after refresh, the first claim worked. ✓
- If you see 401 "Email này chưa có quyền quản trị", check:
  - The email in the form matches exactly (case-insensitive, but whitespace matters).
  - Check the Worker logs for "admin: misconfigured" (usually means `BOOTSTRAP_EMAIL` was not set).

### 5. If Using `ALLOW_FIRST_CLAIM=1`

If you chose the temporary open claim:

1. Set the secret (one time):
   ```bash
   wrangler secret put ALLOW_FIRST_CLAIM
   # Paste: 1
   ```

2. Deploy:
   ```bash
   npx wrangler deploy
   ```

3. Open `/admin` and type **any email address**. That email becomes the first admin.

4. **Delete the secret immediately**:
   ```bash
   wrangler secret delete ALLOW_FIRST_CLAIM
   npx wrangler deploy
   ```

---

## Adding Admins

Once the first admin is confirmed:

1. Log in to `/admin` with your email.
2. Scroll to **Quản trị viên** (Admins) section.
3. Click **+ Thêm quản trị viên** (Add admin).
4. Type the new admin's email and click **Thêm** (Add).
5. The email is normalised (trimmed, lowercased) and must match the server's pattern (ASCII, exactly one `@`, valid domain). The new admin appears in the list immediately.
6. The new admin can now sign in with that email.

---

## Removing Admins

1. Log in to `/admin`.
2. Scroll to **Quản trị viên**.
3. Click **Xóa** (Remove) next to an admin.
4. **Note**: the last admin cannot be removed — you must add another admin first.

A removed admin gets a 401 on their next request.

---

## Recovery: Regain Access When Locked Out

If you are the only admin and have lost access (email changed, forgot the email, etc.), you must manually reset the admin table:

### Step 1: Update `BOOTSTRAP_EMAIL`

Set `BOOTSTRAP_EMAIL` in `wrangler.jsonc` to a new email address (your current email or a recovery email):

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "recovery@yourdomain.com"
  }
}
```

For laptop deploys (non-Git), set it as a secret instead:
```bash
wrangler secret put BOOTSTRAP_EMAIL
# Paste: recovery@yourdomain.com
```

### Step 2: Delete the Admin Table

Run:
```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"
```

This empties the `admin` table. The schema remains intact.

### Step 3: Deploy (if using wrangler.jsonc)

```bash
npx wrangler deploy
```

### Step 4: Sign In

Open `/admin` and type the recovery email. You become the first admin again.

### Step 5: Add Other Admins

Once signed in, add other admins through the admin page as usual.

---

## Local Development

### Option 1: Real Backend + Email Form

For quick local testing with the actual form:

1. Create `.dev.vars` (gitignored):
   ```
   BOOTSTRAP_EMAIL=you@example.com
   ```
   Or use `ALLOW_FIRST_CLAIM=1` for open claim during dev.

2. Run the Worker in one terminal:
   ```bash
   npm run worker:dev
   ```

3. Run Vite in another terminal:
   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173/admin` and type the email from `.dev.vars`.

The database is local (SQLite in-memory during dev, or persisted if configured). Tables are auto-created on first request.

### Option 2: Curl Tests (No Browser)

For automated tests:

1. Create `.dev.vars`:
   ```
   BOOTSTRAP_EMAIL=test@example.com
   ```

2. Run:
   ```bash
   npm run worker:dev
   ```

3. Test with curl:
   ```bash
   curl -H "X-Admin-Email: test@example.com" \
        -H "X-Requested-With: fetch" \
        http://localhost:8787/api/admin/teachers
   ```

---

## Card Token Management

Each teacher has a unique token (16 random characters). This token is the secret part of the public card URL (`/t/:token`).

### Rotate a Token

If a token is compromised or you want to change the URL:

1. Log in to `/admin`.
2. Find the teacher and click **Xoay lại mã** (Rotate token).
3. A new 16-character token is generated.
4. The old URL (`/t/<old-token>`) returns 404.
5. The new URL (`/t/<new-token>`) shows the card.

### QR Codes

Each card URL has a QR code:

1. Click **Hiển thị mã QR** (Show QR) to view the code in the dashboard.
2. Click **Tải xuống** (Download) to save as PNG.

QR codes are generated client-side (no server upload). They are static for a given URL.

---

## Error Responses

| Status | Code | Reason |
|--------|------|--------|
| 401 | `unauthorized` | Missing, invalid, or unknown email; or empty admin table without `BOOTSTRAP_EMAIL` / `ALLOW_FIRST_CLAIM` configured (check logs for "admin: misconfigured") |
| 403 | `forbidden` | Missing or invalid `X-Requested-With: fetch` header (CSRF defense) or cross-site request |
| 429 | `rate_limited` | Too many requests from your IP (30 per 60 s for admin endpoints) |
| 503 | `unavailable` | Database error |

---

## Deployment Environments

### Git-Connected Deploy (Cloudflare Pages/Workers integration)

Configuration lives in `wrangler.jsonc`. Commit changes and push to trigger a build and deploy.

```bash
git add wrangler.jsonc
git commit -m "Update admin config"
git push
```

### Laptop Deploy

Use the Wrangler CLI:

```bash
# Set BOOTSTRAP_EMAIL as a secret
wrangler secret put BOOTSTRAP_EMAIL
# Paste: admin@yourdomain.com

# Deploy
npx wrangler deploy
```

---

## Database Schema

The database `cham-yeu-thuong` is pinned in `wrangler.jsonc` with ID `9e58f935-fb6f-4c1f-be0b-21a9183ba483`. Tables are created automatically by `worker/schema.ts` on the first request (idempotent `CREATE TABLE IF NOT EXISTS`).

```sql
teacher (id PRIMARY KEY, token UNIQUE, name, subject, created_at)
card (teacher_id FOREIGN KEY, message, status ∈ {draft, published}, updated_at)
admin (id PRIMARY KEY, email UNIQUE, created_at, created_by)
```

To inspect or manually query:

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT email FROM admin"
```

---

## Security Notes

- **Email normalisation**: emails are trimmed, lowercased, and validated (ASCII-only, ≤254 chars, exactly one `@`, valid domain structure). Invalid emails return 401.
- **No HTML injection**: admin email is never embedded in HTML output without escaping.
- **CSRF defense**: all admin API calls require the custom `X-Requested-With: fetch` header (not present in cross-site requests).
- **Rate limit**: 30 requests per 60 s per IP to `/api/admin/*` prevents brute-force email guessing (slowed by ~2 s per attempt on a single IP).
- **Session storage**: email is stored in `sessionStorage` (tab-local, cleared when tab closes) and never persisted to IndexedDB or localStorage.


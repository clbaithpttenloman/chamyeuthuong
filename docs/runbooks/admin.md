# Admin Operations Runbook — Student Cards Platform

---

## Privacy Model: Private Cards, Private QR Tokens

**The problem:** student cards are personal messages to teachers. They should not be discoverable via public searches or browsing.

**The solution:** each teacher gets one private QR link that shows their approved cards only.

### How It Works

- **Home page** (`/`): shows only teacher names, subjects, and card counts. No card content. Links point to `/gui-thiep?thay=<id>` to send a card.
- **QR page** (`/t/<token>`): private link (one per teacher, 16-char random token). Shows a random approved card + "View all" button. This URL stays in browser history and Cloudflare logs, so **open on trusted devices only**.
- **Send page** (`/gui-thiep`): students can pick a teacher from the wall list (by numeric id), or use `?thay=<id>` or `?t=<token>` query params (the latter from the private QR link).
- **No public teacher pages:** `/thay-co/*` and the `publicId` field are removed. Cards are only readable via the private QR link.

### Risk: QR Link Leakage

If a QR link is accidentally shared publicly or forwarded beyond the intended teacher:
- The token is exposed
- Anyone with the URL can see that teacher's cards
- The token cannot be revoked retroactively (already shared)

**Mitigation:** `Rotate` button generates a new token. The old QR link becomes invalid immediately; create a new QR and distribute it.

### Example Flow

1. Admin prints QR codes and hands them to teachers (or emails the `/t/<token>` URL)
2. Teacher scans QR → sees their cards + gets a "Send card" button
3. Students visit home (`/`) → see teacher list → click a tile → send flow
4. Or students use a teacher's private QR → see their cards → click "Send"
5. Card is pending until admin approves
6. Approved card shows up on that teacher's QR page

---

## ⚠️ Important: Email is NOT Verified

The admin email is typed in the browser and sent to the Worker as the `X-Admin-Email` header — **there is no identity verification**. Anyone who knows or guesses an admin email can edit cards, delete teachers, approve/hide content, and add more admins. This is **accepted risk R1** (see plan and decisions).

**Mitigation:**
- Keep admin emails **private** — do not share publicly
- Rate limit (60 requests per 60 s per IP) slows guessing; doubled from 30/60 to allow upload sessions
- Disable `BOOTSTRAP_EMAIL` after first admin is claimed
- Remove `ALLOW_FIRST_CLAIM` secret immediately after initial setup
- SSO version preserved in git (`tag sso-google-signin`, commit cec9a58) if a future OAuth deployment is needed

---

## First Deploy

### Step 1: Choose Bootstrap Method

Before the first deploy, set **one** of these in `wrangler.jsonc`:

**Option A: `BOOTSTRAP_EMAIL` (recommended)**

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "admin@school.edu"
  }
}
```

- Only this email can claim the empty admin table
- Stays inert once an admin exists
- Safe to leave in the config

**Option B: `ALLOW_FIRST_CLAIM=1` (temporary)**

```bash
wrangler secret put ALLOW_FIRST_CLAIM
# Paste: 1
```

- Any email can claim the first admin slot
- Delete immediately after setup

### Step 2: Deploy

```bash
git add wrangler.jsonc
git commit -m "Bootstrap admin config"
git push
# OR
npx wrangler deploy
```

### Step 3: Sign In

Visit `/admin` and type the bootstrap email. The admin list appears — you are the first admin. ✓

### Step 4: Clean Up

If using `ALLOW_FIRST_CLAIM`:
```bash
wrangler secret delete ALLOW_FIRST_CLAIM
npx wrangler deploy
```

---

## Setup Workflow (Day Before 20/11)

### 1. Claim Admin (First Deploy)

- Visit `/admin`
- Type bootstrap email
- Confirm access to admin dashboard

### 2. Add Teachers

In **Thầy cô** section:

**Option A: Bulk Add (recommended for 50+ teachers)**

Click **Tạo hàng loạt**, paste a list (one line per teacher):

```
Thầy Nguyễn Văn A | Toán | Tổ Toán - Tin
Cô Trần Thị B | Văn | Tổ Văn - Sử - Địa
Thầy Lê Văn C | Tiếng Anh | Tổ Tiếng Anh
```

Format: `Thầy|Cô Name | Subject | Department`

- **Thầy/Cô:** required, case-insensitive
- **Name:** required (before first `|`)
- **Subject:** optional (between `|` characters)
- **Department:** optional (after second `|`)
- **Limit:** 1–100 rows; all-or-nothing (any error → nothing inserted)
- All created with `showOnHome = 1` (shown on wall)

Click **Tạo** → all teachers added atomically.

**Option B: Add One at a Time**

Click **+ Thêm giáo viên**, fill form, click **Thêm**.

### 3. Upload Images

In **Thư viện ảnh**:

1. Drag-and-drop or click to select JPEG/PNG/WebP
2. Browser compresses: max 1280 px, ≤ 300 KB (metadata stripped)
3. Server validates:
   - File signature (magic bytes) matches declared MIME
   - Pixel dimensions: each ≤ 4096 px, ≤ 8 MP total
   - Body ≤ 300 KB counted on bytes read
   - Name 1–80 ASCII chars, no control characters
4. Caps: 200 images, 40 MB total (base64 D1 storage ~1.33× raw size)

**Validation errors:**
- "Sai loại tệp" — file signature doesn't match JPEG/PNG/WebP
- "Tệp quá lớn" — > 300 KB
- "Kích thước ảnh quá lớn" — pixel dims exceed limits or total > 8 MP
- "Đã đạt giới hạn thư viện" — 200 images or 40 MB cap hit

### 4. Create Templates

In **Mẫu thiệp**:

1. Click **+ Tạo mẫu**
2. Enter **name** (≤ 60 chars)
3. Pick **layout**: lotus, spring, night, classic, minimal
4. Assign images:
   - **background** — full-card cover (optional)
   - **banner** — top image (optional)
5. Set **active** flag (on by default; off hides from students)
6. Click **Tạo**

Live preview shows the layout with sample text and images in real-time.

**Later:** click **Chỉnh sửa** to edit, click **Xóa** to remove (fails with 409 if any card uses it — deactivate instead).

### 5. Print QR Codes & Distribute Privately

In **Thầy cô** section:

For each teacher:
1. Click **Hiển thị mã QR** — QR code appears
2. Click **Tải xuống** — saves as PNG
3. **Distribute privately** to the teacher (email, print handout, etc.)
   - Do NOT post on public social media or the class chat
   - Each teacher keeps their QR private
   - Students either access the home page, or the teacher shares their link in person

Each QR encodes the teacher's private 16-char token (e.g., `/t/abc1234567890xyz`).

**Rotate token (if leaked):** click **Xoay lại mã** to generate a new token. Old QR link stops working immediately; create a new QR and redistribute. URLs stay in browser history and Cloudflare logs, so only open the QR on trusted devices.

### 6. Share the Home URL Publicly

- Post the home page link (`https://your-site.com/`) in the class chat, school website, etc.
- Do **not** post teacher's private QR links publicly
- Students can access the public home page, or the teacher can share their private link if students ask

---

## Student Workflow (20/11 Day)

### What Students See

1. **Home** (`/`): wall showing only teacher names, subjects, and card counts (no card content)
2. **Send flow** (`/gui-thiep`): pick a teacher from the wall or use `?thay=<id>` / `?t=<token>` query params
3. **QR page** (`/t/:token`): random approved card from that teacher, "View all", empty state if no cards
4. Write message (1–300 chars, max 5 newlines) + optional name/class; `Anonymous` on by default

### What Students Cannot See (Until Approved)

- Pending cards are **never public**
- Not listed on wall, teacher page, or QR
- Cannot be found by direct URL

---

## Moderation Workflow (During/After 20/11)

### The Duyệt thiệp (Review Cards) Tab

**Default view:** pending cards, **oldest first** (handle backlog first).

**Filters:**
- Status: pending, approved, hidden
- Teacher: filter to one teacher (optional)

**Card preview:**
- Thumbnail (layout + images)
- Student name or "Một bạn học sinh" (if anonymous)
- Class (if given)
- Message excerpt

### Single Approval

1. Find the pending card in the list
2. Click **Approve** (or **Duyệt**)
3. Status changes to `approved` immediately
4. Card appears on wall, teacher page, QR

### Single Hide

1. Click **Hide** (or **Ẩn**)
2. Card is removed from all public queries
3. Still stored in D1 but **does not count against the pending cap**

### Single Delete

1. Click **Delete** (or **Xóa**)
2. Card is removed permanently (not reversible)
3. Frees up quota space

### Bulk Approve (≤ 200 Cards)

1. Use **checkbox** column to select cards (or **Select All** if showing ≤ 200)
2. Choose **Approve** from the bulk action menu
3. All selected cards set to `approved` in one request

**Pending card cap:** global 2000, per-teacher 200.

When the cap is hit:
- New submissions get **409 Conflict**: "đang có quá nhiều thiệp chờ duyệt"
- **Solution:** delete old spam to free space (hidden cards stay stored, pending ones count against the cap)

### Managing the Pending Queue

Students' first instinct is to send many cards. Use bulk actions:

1. **Filter by teacher** if one teacher is getting spam
2. **Filter by status=pending** to see only approvals needed
3. **Select multiple** (checkbox) and **approve** in bulk
4. **Or hide/delete** spam

**Delete vs. Hide:**
- **Delete**: removes card permanently, frees quota space (count against pending cap drops)
- **Hide**: card stays in D1 but removed from public queries, **does not free quota** (count stays high)

Use **delete** for spam. Use **hide** for genuinely inappropriate cards the teacher might want to see later.

---

## Admin Sections

### Duyệt thiệp (Review Cards)

- **List**: filter by status (pending oldest-first, approved/hidden newest-first) and teacher
- **Single action**: approve, hide, delete
- **Bulk action**: select up to 200, approve or hide all at once
- **Pagination**: cursor-based (oldest first for pending, newest first for others)

### Mẫu thiệp (Templates)

- **Create**: name, layout (5 presets), image slots
- **Edit**: update name, layout, images, active flag
- **Deactivate**: `active = 0` hides from students but keeps existing cards rendering
- **Delete**: fails with 409 if any card uses it — deactivate first or remove all cards

### Thầy cô (Teachers)

- **List**: teachers with pending/approved/hidden card counts, `showOnHome` toggle
- **Create**: title (Thầy/Cô, required), name, subject, department
- **Bulk add**: paste list `Thầy|Cô Name | Subject | Department` (1–100)
- **Edit**: name, subject, department, `showOnHome`
- **Rotate QR**: generates new private token (old QR invalid, new `/t/<token>` page URL created)
- **Delete**: removes teacher and all their cards

### Thư viện lời chúc (Wish Library)

- **List**: 12 example wishes (seeded on first deploy)
- **Create**: title, body (can include placeholders `{Thầy/Cô}`, `{thầy/cô}`, `{tên}`, `{môn}`)
- **Edit**: update title or body
- **Delete**: always allowed (existing cards keep stored copy)

Wishes are used in the student send flow as suggestions.

### Giới thiệu CLB (About)

Edit the club timeline, members, and statistics shown on `/ve-clb-ai`:

- **Form:** add/remove/reorder stats, steps, members
- **Live preview:** see changes as you edit
- **Persistence:** saved to D1; visible on public About page immediately

**Fields:**
- **Heading** (≤ 80 chars): e.g. "CLB AI - THPT Ten Lơ Man"
- **Intro** (≤ 600 chars, max 10 newlines): club's mission or description
- **Stats** (0–6): key metrics like "2 ngày phát triển", "5 mẫu giao diện"
  - Each stat: value (≤ 12 chars) and label (≤ 40 chars)
- **Steps heading** (≤ 80 chars): e.g. "Quá trình thực hiện"
- **Steps** (0–20): timeline events
  - When (≤ 20 chars): date or period, e.g. "16/11/2026"
  - Title (≤ 80 chars): e.g. "Khởi tạo dự án"
  - Text (≤ 400 chars, max 10 newlines): description
- **Members heading** (≤ 80 chars): e.g. "Thành viên"
- **Members** (0–40): team members
  - Name (≤ 60 chars)
  - Role (≤ 60 chars)

**Seeded content** (visible on first deploy):
- Timeline from commit history (2 days of development)
- Stats: 2 days, 5 templates, 20/11 (the day of the event)
- Members: Vũ Ngọc Diệp (Chủ nhiệm CLB), Kiro Coding Agent (Thiết kế & phát triển)

The seeded content is inserted once (INSERT OR IGNORE) and never overwrites edits. To reset to seed: re-enter the content manually in the form (or use the D1 delete command below).

### Thư viện ảnh (Image Library)

- **List**: thumbnails, name, MIME, size, usage count, created date
- **Upload**: JPEG/PNG/WebP, browser compresses ≤ 300 KB
  - Server validates: magic bytes, pixel dims, file size, EXIF rejection
- **Delete**: fails with 409 if used by any card

### Quản trị viên (Admins)

- **List**: all admins with email and sign-up date
- **Add**: type email, click Add (normalized: trim, lowercase)
- **Remove**: cannot remove the last admin (blocked with 409)

To change your email:
1. Click **Đổi email** (top-right menu)
2. Stored email is cleared and login form appears
3. Type a new email

---

## Email Normalisation & Recovery

### Email Normalisation

Emails are normalized before storage:
- Trimmed whitespace
- Lowercased
- ASCII-only
- Exactly one `@` symbol
- ≤ 254 characters
- Valid domain (rough regex)

Example: `  ADMIN@EXAMPLE.COM  ` → `admin@example.com`

### Regain Access (Locked Out)

#### Step 1: Update Bootstrap Email

Edit `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "recovery@school.edu"
  }
}
```

Or set it as a secret for laptop deploys:

```bash
wrangler secret put BOOTSTRAP_EMAIL
# Paste: recovery@school.edu
```

#### Step 2: Empty Admin Table

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"
```

#### Step 3: Deploy

```bash
npx wrangler deploy
```

#### Step 4: Sign In

Visit `/admin` and type the recovery email. You become the first admin again.

---

## Rate Limits & School NAT

All students on school Wi-Fi share one IP. Per-IP rate limits apply:

| Endpoint | Limit | Impact |
|---|---|---|
| `POST /api/cards` | 20 per 60 s | **tight on 20/11** |
| `GET /api/qr/:token` | 60 per 60 s | QR scanners |
| Public reads | 120 per 60 s | generous |
| Admin requests | 60 per 60 s | upload sessions + R1 brake |

### Raise Limits for the Event

Edit `wrangler.jsonc`:

```jsonc
{
  "ratelimits": [
    { "name": "SUBMIT_IP_LIMIT", "namespace_id": "2005", "simple": { "limit": 60, "period": 60 } },
    { "name": "CARD_IP_LIMIT", "namespace_id": "2001", "simple": { "limit": 120, "period": 60 } }
  ]
}
```

Then deploy:

```bash
git add wrangler.jsonc
git commit -m "Raise rate limits for 20/11 event"
git push
# Or: npx wrangler deploy
```

---

## Image Management

### Upload & Validation

Browser side:
- Max 1280 px
- Re-encode to WebP or JPEG, ≤ 300 KB
- EXIF/GPS stripped by canvas re-encoding

Server side:
- File signature (magic bytes) must match JPEG/PNG/WebP
- Pixel dimensions: each ≤ 4096 px, total ≤ 8 MP
- File size: ≤ 300 KB counted on bytes read
- No EXIF/eXIf/EXIF chunks (privacy rejection)
- Name: 1–80 ASCII chars, no control characters

### Deletion & Caching

- **Deleting from D1:** image removed from database
- **Edge cache:** Cloudflare caches images for 1 year (`immutable`)
- **Browser cache:** cached for 1 year on user device
- **To replace immediately:** upload a new image and switch the template reference (old URL remains cached)

### Privacy Note

Uploaded photos may carry GPS, camera model, date, time, and other metadata in EXIF.

**Browser mitigation:** admin panel re-encodes every image via canvas (strips EXIF by default).

**Direct API uploads:** server rejects files with EXIF chunks (app/json sends as base64, so EXIF is visible and rejected).

**Template images are public:** images attached to an active template are served to anyone at `/api/image/<token>` (16-char random token), because every student sees the templates when writing a card. Do not upload photos of people who have not agreed. Student cards themselves are private and readable only through the teacher's QR link.

**Recommendation:** include photo privacy expectations in the school's Terms of Use before launching.

---

## Database Inspection

### Check Admin Count

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT COUNT(*) FROM admin"
```

### List All Admins

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT email, created_at FROM admin"
```

### Check Pending Card Count

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT COUNT(*) FROM student_card WHERE status = 'pending'"
```

### Check Teacher Count

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT COUNT(*) FROM teacher"
```

### Reset About Content to Seed

If the About page is corrupted or you want to reset it to the original timeline and members:

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM site_content WHERE key='about'"
```

With no stored row, `/api/about` serves the seed from `worker/aboutSeed.ts` right away; the row is re-inserted on the next Worker cold start. The production run needs Wrangler logged in (`npx wrangler login`).

---

## Local Development

### Setup

Create `.dev.vars` (gitignored):

**Option 1: Bootstrap Email**
```
BOOTSTRAP_EMAIL=you@example.com
```

**Option 2: Allow Any Email**
```
ALLOW_FIRST_CLAIM=1
```

### Run

Terminal 1:
```bash
npm run worker:dev
```

Terminal 2:
```bash
npm run dev
```

Visit `http://localhost:5173` (frontend) and `/admin` to sign in.

### Local D1 Database

Tables are created automatically on the first request via idempotent `CREATE TABLE IF NOT EXISTS` statements.

**If you have an old local D1 database** (from before this privacy model plan):
- Old schema may have `teacher_profile.public_id` and `template_image.slot='photo'`
- `ensureSchema` only runs `CREATE TABLE IF NOT EXISTS`, so it never alters existing tables. The old NOT NULL `teacher_profile.public_id` column stays, and creating a teacher then fails. The production D1 was created with the new schema, so this only affects local state.
- To get a fresh schema:

```bash
# Remove local D1 state
rm -rf .wrangler/state

# Restart worker
npm run worker:dev
```

The next request will re-initialize with the new schema (no `public_id`, slots are `background` and `banner` only).

### Curl Tests

```bash
curl -H "X-Admin-Email: you@example.com" \
     -H "X-Requested-With: fetch" \
     http://localhost:8787/api/admin/teachers

curl -H "X-Admin-Email: you@example.com" \
     -H "X-Requested-With: fetch" \
     -H "Content-Type: application/json" \
     -d '{"title":"Thầy","name":"Test"}' \
     http://localhost:8787/api/admin/teachers
```

---

## Operational Notes

### Schema & Tables

Tables are created automatically on the first request via `ensureSchema` in `worker/schema.ts` (idempotent `CREATE TABLE IF NOT EXISTS`). No migration step needed.

**New tables:**
- `teacher_profile` — `department`, `show_on_home` flag
- `template` — layout + active flag
- `template_image` — slot → image mapping (slots: `background`, `banner`)
- `student_card` — pending/approved/hidden status, student fields, review metadata
- `site_content` — About page content

**Unchanged tables:**
- `teacher`, `teacher_title`, `image`, `wish`, `admin`, `meta`

### Atomic Guarantees

- **Bulk add teachers:** all-or-nothing (any error → nothing inserted)
- **Bulk review cards:** all-or-nothing (all cards set to status in one SQL statement)
- **Submit card:** checks teacher exists, template active, and pending cap in one atomic INSERT…SELECT

### URL Tokens

- **Private QR token:** 16-char random ([a-z0-9], ~82 bits), stored in `teacher.token`, appears in `/t/:token`
- **Card public ID:** 16-char random, stored in `student_card.public_id`, appears in API responses and moderation UI

Private tokens never appear in public responses.

### Cascade & Constraints

- **Delete teacher:** cascades to `teacher_profile`, `student_card` (all their cards deleted)
- **Delete template:** fails with 409 if any card uses it
- **Delete image:** fails with 409 if used by any template

---

## Error Messages (Admin UI)

| Code | Meaning | Action |
|---|---|---|
| 400 bad_request | Invalid input | Check required fields, lengths, formats |
| 401 unauthorized | Unknown email | Type a different email or contact the first admin |
| 403 forbidden | CSRF token missing | Refresh the page and try again |
| 404 not_found | ID not found | Teacher/template/image was deleted; refresh |
| 409 conflict | Constraint violated | Delete in-use image first, or cap exceeded |
| 429 rate_limited | Too many requests | Wait 60 seconds; share IP with others (school NAT) |
| 503 unavailable | Database error | Retry or contact support |

---

## First-Deploy Checklist

- [ ] Deploy from Git or via `wrangler deploy`
- [ ] Sign in to `/admin` with bootstrap email
- [ ] Upload a test image (confirm it appears in library)
- [ ] Create a template with the test image
- [ ] Create a teacher
- [ ] Test send flow: `/gui-thiep?thay=<id>` → pick template → submit
- [ ] Confirm card is pending (not visible on wall)
- [ ] Approve the pending card
- [ ] Confirm card now appears on wall and teacher page
- [ ] Scan QR code on phone → random card appears
- [ ] Try invalid upload: SVG, mismatched type, oversized dims → all get 400 errors
- [ ] Delete test teacher → all their cards removed
- [ ] Note image response time (first decode may be slow on cold Worker)

---

## Known Limitations & Workarounds

### Image Cache Can't Be Purged Immediately

**Problem:** deleted images remain cached for up to 1 year (Cloudflare + browser).

**Workaround:** upload a new image and switch the template reference instead of deleting.

### Rate Limit on Shared IP

**Problem:** 20 card submissions per minute for the whole school may be tight on 20/11.

**Workaround:** raise `SUBMIT_IP_LIMIT` in `wrangler.jsonc` (documented in Rate Limits section).

### Image CPU Decode on Free Plan

**Problem:** Workers free plan allows 10 ms CPU per request; a 300 KB base64 decode takes ~10 ms.

**Workaround:** if CPU exceeds limit on free tier, lower image cap to 150–200 KB or migrate to R2 (`SHORTCUT:` see `worker/images.ts`).

### Email-Based Admin (Risk R1)

**Problem:** no identity verification; anyone guessing an admin email can edit content.

**Mitigation:** rate limit (60 req/min), keep emails private, enable bootstrap only at first deploy, SSO version in git (`tag sso-google-signin`).

---

## Recovery Steps

### Locked Out

1. Update `BOOTSTRAP_EMAIL` in `wrangler.jsonc`
2. Delete all admins: `npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"`
3. Deploy: `npx wrangler deploy`
4. Sign in with recovery email

### Card Stuck in Pending

1. Go to `/admin` → Duyệt thiệp
2. Find the card
3. Click **Approve** or **Delete**

### Card Accidentally Deleted

Not recoverable (delete is permanent). Apologize and ask the student to re-send.

### Image Remains Cached After Deletion

1. Upload a new image with a different name
2. Switch the template reference to the new image URL
3. Old URL remains cached for up to 1 year

---

## Handoff to School

When handing off to the school's own admins:

1. **Document:** email them this runbook
2. **Add admins:** log in to `/admin` and add their emails (they will be normalized)
3. **Describe moderation:** pending card workflow, bulk actions, hide vs. delete
4. **Set rate limits:** if needed for their event, they edit `wrangler.jsonc` and deploy
5. **Test:** do a full dry run (upload image, create template, send card, approve)
6. **Monitor:** on the event day, check admin dashboard for pending cards and moderate as needed

---

## Support Contacts

- **Technical issues:** check error messages in admin dashboard
- **Rate limit raised:** edit `wrangler.jsonc`, deploy via Cloudflare or Git
- **Email recovery:** use bootstrap recovery steps above
- **Database inspection:** use `wrangler d1 execute` commands
- **Source code:** see `README.md` for architecture and API docs

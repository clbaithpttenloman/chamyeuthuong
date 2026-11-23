# Admin Operations Runbook — Campaigns, Moderation & Deployment

---

## Accounts (Phase 2b)

### Sign-In

**Players and admins register and sign in with a username and password** (Phase 2b, ADR-9).

- **Register:** `/dang-ky` — username (3–20 chars: a–z, 0–9, _), password (8–128 chars), nickname, class. **The first account registered on an empty database automatically becomes an admin.**
- **Sign in:** `/dang-nhap` — username, password. 10 wrong attempts lock the username for 15 minutes.
- **Forgot password:** Ask an admin to reset it via the admin page.

### First Admin (Production Cut-Over)

**Pre-check:** `SELECT COUNT(*) FROM app_user` must be 0 (or the table does not exist).

**Procedure:**
1. Create a Time Travel bookmark on the production D1 (Cloudflare Dashboard → D1 → select database → **Time Travel** tab). Name it `pre-noel-production` for reference.
2. Deploy the new Worker code: `git push && npx wrangler deploy`
3. Test the registration on a preview URL (if available, requires preview deployments enabled) **that uses the production D1**:
   - Visit the preview URL and open `/dang-ky`
   - Register a test account with a unique username (e.g., `testadmin2026`)
   - Sign in and visit `/admin` — confirm you see the admin dashboard
4. If the admin dashboard loaded, you have successfully registered the first account as admin. Delete this test account from the admin page and proceed.
5. **If the admin dashboard shows 403 or lists other admins:** someone else registered first. Roll back immediately:
   - In Cloudflare Workers, switch to the previous Worker version
   - Restore the D1 bookmark (this discards all account registrations since the bookmark)
   - Repeat the procedure (or rendezvous with colleagues to avoid a registration race)
6. If the race was lost and rollback is complete, re-deploy and try again, unannounced, at a quieter time.
7. After successful first registration, the other admins register and are granted admin roles in the admin page by the first admin.

**Important:** Rolling back the Worker code re-enables the old typed-email login for the 20/11 endpoints only. The admin table is never modified by Phase 2b code, so a rollback is fully reversible.

### Secrets (Never Rotate)

**Required secrets** (Cloudflare Workers → Environments → Production → Secrets):

- `PASSWORD_PEPPER`: 32 random hex characters (use `printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put PASSWORD_PEPPER`). Never rotate this — rotating the pepper invalidates every password, and there is no recovery except admin-issued resets for every user.
- `IP_HMAC_KEY`: 32 random hex characters. Used for registration rate-limit tracking (per IP, per day). Can be rotated if needed (old IP hashes are blanked after 30 days anyway).
- `SUB_HMAC_KEY`: 32 random hex characters. Used for creating ban tombstones (deletion + ban evasion prevention). Never rotate this — rotating it invalidates all existing tombstones, so banned users can register again.

**Backup:** Keep backups of all three secrets in the club's password manager. If lost, there is no recovery path; re-deploying with new secrets will invalidate passwords/bans.

**Staging:** Use different secret values for staging (randomized, documented separately for load tests).

### Registration Rate Limits

Configured in `wrangler.jsonc`:
- **REGISTER_IP_DAILY**: 300 (default) accounts per IP per calendar day (Vietnam time)
- **REGISTER_GLOBAL_DAILY**: 2,000 (default) total accounts per day globally

A school behind one NAT (all students sharing one IP) can register at 300/day. If the limit is hit during on-ramp, raise these variables in `wrangler.jsonc` and redeploy: `wrangler deploy`.

If you need to adjust limits mid-event, edit `wrangler.jsonc`:
```jsonc
{
  "vars": {
    "REGISTER_IP_DAILY": "500",
    "REGISTER_GLOBAL_DAILY": "5000"
  }
}
```

Then: `git add wrangler.jsonc && git commit -m "Raise registration caps" && git push`

### Step 1: Create the Campaign

In `/admin`, go to **Chiến dịch** → **Tạo chiến dịch**:

- **Tên:** Noel 2026
- **Tên ngắn:** noel-2026 (lowercase, alphanumeric + hyphen only)
- **Loại:** Gift tree
- **Ngày bắt đầu:** 10/12/2026 00:00, entered in Vietnam time in the editor (stored as `2026-12-09T17:00:00Z`)
- **Ngày kết thúc:** 24/12/2026 23:59 Vietnam time (stored as `2026-12-24T16:59:59Z`; Vietnam is UTC+7)
- **Trạng thái:** Draft (will activate on launch day)
- **Nội dung:** Campaign home text; example: "🎄 Cây Thông Điều Ước. Treo những lời chúc cho bạn bè, thầy cô. Chúng ta chọn những phần quà (Tim) cho nhau."
- **Màu chủ đề:** Set theme colors (defaults OK for now; Phase 3 adds a theme editor)

Save as draft.

### Step 2: Configure Gift Tree Settings

Go to **Mẫu thiệp** (Templates) → select the Noel campaign:

Create or assign templates that will be available for students to choose backgrounds when creating gifts. Each template is a layout + background image. Templates are now per-campaign.

**Gift tree campaign settings** (API-configurable, no UI yet):
- `tree_slots`: 15 (gifts ranked 1–15 displayed on the tree, near the star first)
- `ground_slots`: 10 (gifts ranked 16–25 on the ground below the tree)
- `hearts_per_day`: 5 (each player gets 5 hearts per Vietnam day)
- `heart_min_account_age_hours`: 24 (0–72). A new account must be this old before it can give hearts. Set 0 for a test campaign; keep the default for the live event so students cannot farm hearts with fresh accounts.
- `gifts_per_user`: 3 (each player can create 3 non-deleted gifts in the campaign)
- `report_threshold`: 3 (when 3 distinct users report a gift, it auto-hides)

You can set these via SQL after the campaign is created:

```sql
UPDATE campaign SET settings = json_object(
  'tree_slots', 15,
  'ground_slots', 10,
  'hearts_per_day', 5,
  'gifts_per_user', 3,
  'report_threshold', 3
) WHERE slug = 'noel-2026';
```

### Step 3: Activate on Launch Day

On 10/12 at 00:00 local time:

1. In `/admin` → **Chiến dịch**, select the draft Noel 2026
2. Click **Kích hoạt**
3. The 20/11 campaign automatically becomes **Closed** (only one active campaign at a time)
4. Students can now create gifts, see the tree, and give hearts

### Step 4: Manage on-Call Moderation

See `docs/runbooks/moderation.md`.

### Rollback

If Noel 2026 needs to be taken offline before 24/12 23:59:

1. In `/admin` → **Chiến dịch**, click **Đóng** on the Noel campaign
2. (Optional) **Kích hoạt** the 20/11 campaign again

**Important:** Previous code (before Phase 2) does not know about `gift`, `heart`, `report`, `banned_identity` tables. A true rollback via Time Travel should be taken **before** deploying Phase 2. After Phase 2 deploy, all DB changes are forward-only; reverting the code leaves the new tables in place but orphaned. Rolling back the entire site requires a Time Travel restore to a pre-Phase 2 timestamp.

---

## Noel Campaign Setup (Phase 2b, Launch 10/12/2026)

### New Tables (Phase 2b)

Automatically created on first Phase 2b request; no manual SQL needed:

```sql
-- User accounts (username + password identity)
app_user (
  id PK, nickname, class_name, banned 0|1, created_at, last_seen_at
)

-- User identities (password, Google later)
user_identity (
  id PK, user_id FK, provider (password|google), subject, 
  email (Google only), hd (Google only), ip_hash (password registration tracking),
  created_at, last_used_at,
  UNIQUE(provider, subject)
)

-- Password hashes (PBKDF2-SHA256)
password_credential (
  user_id PK FK, hash, salt, iterations, must_change 0|1, temp_expires_at,
  failed_count, locked_until, updated_at
)

-- Admin role (role on the user, not the email)
admin_role (
  user_id PK FK→app_user, granted_at, granted_by
)

-- Admin audit log (kept 180 days)
admin_audit (
  id PK, actor_user_id, action, target_user_id NULL, at,
  INDEX admin_audit_at ON admin_audit(at)
)

-- Ban tombstones (deletion + ban evasion prevention)
banned_identity (
  sub_hmac PK, created_at
  -- sub_hmac = HMAC(SUB_HMAC_KEY, provider || ':' || subject)
)

-- Campaign (gift tree, 20/11, etc.)
campaign (
  id PK, slug UNIQUE, kind (teacher_cards|gift_tree), name, tagline,
  content JSON, theme_colors JSON, settings JSON,
  starts_at, ends_at, status (draft|active|closed), created_at, created_by,
  UNIQUE INDEX one_active ON campaign(status) WHERE status = 'active'
)

-- Noel gifts
gift (
  id PK, public_id UNIQUE, campaign_id FK, user_id FK, box_style, ornament_style,
  layout, background_template_id FK, font, ink, message, nickname, class_name,
  heart_count, report_count, status (visible|hidden_auto|hidden_admin|deleted),
  status_before_ban, created_at,
  INDEX gift_rank ON gift(campaign_id, status, heart_count DESC, created_at)
)

-- Daily hearts
heart (
  gift_id FK CASCADE, user_id FK CASCADE, day TEXT, created_at,
  PRIMARY KEY(gift_id, user_id),
  INDEX heart_user_day ON heart(user_id, day)
)

-- Gift reports
report (
  gift_id FK CASCADE, user_id FK CASCADE, reason (inappropriate|spam|other),
  acknowledged 0|1, created_at,
  PRIMARY KEY(gift_id, user_id)
)
```

### Existing Tables — New Columns

```sql
ALTER TABLE template ADD COLUMN campaign_id INTEGER NOT NULL DEFAULT 1
ALTER TABLE wish ADD COLUMN campaign_id INTEGER NOT NULL DEFAULT 1
ALTER TABLE student_card ADD COLUMN campaign_id INTEGER NOT NULL DEFAULT 1
-- (Indexes added after the ADD COLUMN steps)

-- Production 20/11 admin table is left untouched (not read, not written)
ALTER TABLE admin ... -- unchanged
```

### Stale Branch Databases

If you have a local or staging D1 from an earlier branch build (with Phase 1's `app_user(google_sub, email, hd)` columns):

**The schema check will refuse to start:**
```
ERROR: schema: stale app_user (recreate this database, docs/runbooks/staging.md)
```

**Solution:** Recreate the staging D1 and re-seed. See `docs/runbooks/staging.md`.

---

## Deploy & Launch Checklist

### Pre-Deploy (5–7 days before 10/12)

- [ ] **Time Travel bookmark:** Go to Cloudflare → D1 → select `cham-yeu-thuong` (production) → **Time Travel** tab → set bookmark for the latest backup before Phase 2b deploy. Name it `pre-noel-rollback`. This is your "undo" if Phase 2b needs to be reverted.
- [ ] **Secrets set** on production: `PASSWORD_PEPPER`, `IP_HMAC_KEY` (both required), `SUB_HMAC_KEY` (required), each with `printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put <NAME>`. Back them up in the club's password manager immediately.
- [ ] **Registration caps** checked in `wrangler.jsonc` (default 300 per IP per day, 2000 global): raise if needed for launch day volume
- [ ] **Staging D1 recreated** (Phase 1 database with the old `app_user` schema will be rejected; recreate and re-seed per `docs/runbooks/staging.md`)

### Deploy Day (10/12, before 00:00)

- [ ] Code is reviewed (all gates passed; no outstanding issues)
- [ ] Staging load test passed (see `docs/runbooks/staging.md`)
- [ ] Real-phone performance checked: ≥ 50 fps on a mid-range Android with 25 gifts and snow
- [ ] Secrets verified: `PASSWORD_PEPPER`, `IP_HMAC_KEY`, `SUB_HMAC_KEY` are set on production
- [ ] Run: `git push && npx wrangler deploy`
- [ ] Verify: `/` loads and shows Noel campaign home (or 20/11 if Noel is still draft); `/dang-nhap` loads
- [ ] **Register the first admin account** (see "First Admin (Production Cut-Over)" section above)
- [ ] Grant other admins in `/admin` → **Quản trị viên** tab
- [ ] Test: create a gift, give a heart, report a gift, view the tree, check the leaderboard
- [ ] Monitor: check Cloudflare analytics dashboard for errors, latency spikes, rate-limit triggers

### Post-Launch Checks (10/12–11/12)

- [ ] **On-call admin:** Every few hours, spot-check `/admin` → **Kiểm duyệt quà** for reported gifts. Expect 0–5 in the first day; respond within 2 hours.
- [ ] **Real-world load:** Monitor `/api/campaigns/noel-2026/tree` cache hit rate (should be >95% if tree updates every 5 s but students poll every 15 s). Check Cloudflare Analytics for 429 rate-limit responses; if any, raise limits in `wrangler.jsonc`.
- [ ] **Error rates:** Check Cloudflare Logs for 5xx errors. If any appear, investigate and rollback if needed (see Rollback below).
- [ ] **Real phones:** Ask a few students to test on their phones (especially Android) and report any UI glitches.

### Campaign Close (24/12 23:59 UTC)

No action needed; the campaign automatically becomes "closed" at the `ends_at` timestamp. Students can no longer create gifts, give hearts, or report. Moderation (hide, ban, delete) continues to work so admins can manage the final leaderboard.

### Rollback (if needed)

**Immediate (code issue, not data):** 
- In Cloudflare Workers, switch to the previous Worker version
- Or: `git revert <commit> && git push && npx wrangler deploy`

**Full rollback (corruption, data loss):** 
- Use Cloudflare Time Travel to restore the DB to the pre-Phase-2b bookmark
- This requires access to Cloudflare Dashboard
- **Destructive:** all Phase 2b data (accounts, gifts, hearts, reports) are lost
- After rollback, the old typed-email admin login is re-enabled for the 20/11 endpoints only

---

## Privacy Model: Private QR Tokens (20/11 Legacy)

**The problem:** student cards are personal messages to teachers. They should not be discoverable via public searches or browsing.

**The solution:** each teacher gets one private QR link that shows their approved cards only.

### How It Works

- **Home page** (`/`): intro, total teachers and approved cards, and a "Gửi thiệp" button. No teacher list and no card content. Links of the form `/gui-thiep?thay=<id>` still preselect a teacher.
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

1. Admin registers a username/password account (first account auto-becomes admin)
2. Other admins register and are granted admin roles in the admin page
3. Admins configure campaigns, templates, images
4. During the event, admins moderate gifts and manage users

---

## Setup Workflow (Before Campaign Launch)

Schema changes run automatically on the first request after a deploy. Before deploying, follow **Schema upgrades** under Local Development below (Time Travel restore point, orphan check).

---

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
- All created with `chức vụ = Giáo viên` (default) and `showOnHome = 1` (shown on wall)

Click **Tạo** → all teachers added atomically.

**To set role to Hiệu trưởng, Phó hiệu trưởng or Giám thị:** bulk add first, then edit each teacher individually in the admin form (search for their name, click **Chỉnh sửa**, change **Chức vụ** dropdown, save).

**Option B: Add One at a Time**

Click **+ Thêm giáo viên**, fill form (choose **Chức vụ** from dropdown: "Giáo viên" is default, or pick "Hiệu trưởng" / "Phó hiệu trưởng" / "Giám thị"), click **Thêm**.

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
3. Pick **layout**: doc-giua, doc-duoi, doc-tren, ngang-giua, ngang-phai, ngang-trai
4. Upload or assign **background image** (required for preview, but can be null):
   - Portrait: 960×1280 px; leave the dashed writing zone clear
   - Landscape: 1280×960 px; leave the dashed writing zone clear
5. Set **active** flag (on by default; off hides from students)
6. Click **Tạo**

Live preview shows the layout with sample text and the background image in real-time. The writing zone is highlighted with a dashed border so you can verify the image leaves it clear.

**Later:** click **Chỉnh sửa** to edit, click **Xóa** to remove (fails with 409 if any card uses it — deactivate instead).

**Layout mapping (legacy):** old templates in the database with ids `classic`, `lotus`, `spring`, `minimal` are read as `doc-giua` (center portrait); `night` is read as `ngang-giua` (center landscape). Only the six new ids above are accepted for new templates.

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

1. **Home** (`/`): intro, counters and the "Gửi thiệp" button (no teacher list, no card content)
2. **Send flow** (`/gui-thiep`): pick a template, then find the teacher in step 2 (search by name or môn, filter by tổ), or arrive with `?thay=<id>` / `?t=<token>`
3. **QR page** (`/t/:token`): random approved card from that teacher, "Thiệp khác", "Xem tất cả", empty state if no cards. No send button: the page is for the teacher to read
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
4. Card appears on the teacher's QR page (and counts toward the home page total)

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

## Student Choices: Fonts and Ink (Card v3)

### Fonts

Students choose from seven fonts when writing a card. Each font is self-hosted (no CDN):

| Font ID | Label | Preview |
|---|---|---|
| patrick-hand | Bút bi (default) | Casual handwriting |
| pangolin | Bút dạ | Soft marker |
| itim | Chữ tròn | Round letters |
| mali | Nét mảnh | Delicate strokes |
| charm | Thư pháp | Calligraphy |
| be-vietnam-pro | Chữ in | Clean sans-serif |
| lora | Có chân | Serif with elegance |

All fonts have full Vietnamese support (unicode-range subset, 400 weight). Fonts are loaded via @fontsource, so browsers only download the glyphs they use. **Why not Dancing Script?** It renders Vietnamese combining marks (like "ẫ" in "trưởng") incorrectly — the grave accent renders as a hook.

### Ink Colours

Students choose one of four ink colours:

| Hex | Label | Usage |
|---|---|---|
| #1d3fa6 | Xanh (default) | Blue |
| #1c1917 | Đen | Black |
| #6b21a8 | Tím | Purple |
| Custom | Màu khác | Any #rrggbb via colour picker |

Existing cards (before card v3) default to Bút bi + Xanh if font/ink columns are missing.

### Moderation Thumbnail

The moderation thumbnail shows the student's message on a **plain white background** (not the template background), in the chosen font and ink. This ensures review is text-focused and doesn't depend on tiny thumbnail image quality.

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

---

## Recovery: Locked-Out Sole Admin (Phase 2b)

If the sole admin is locked out or deleted, use this recovery SQL to grant admin to an existing user:

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command \
  "INSERT INTO admin_role (user_id, granted_at, granted_by) \
   SELECT user_id, strftime('%Y-%m-%dT%H:%M:%SZ','now'), 'operator' \
   FROM user_identity WHERE provider = 'password' AND subject = '<username>';"
```

Replace `<username>` with the target account's username. This grants the admin role without changing the password. If no other account exists, register a new one first, then grant it.

---

## Rate Limits & School NAT

All students on school Wi-Fi share one IP. Per-IP rate limits apply:

| Endpoint | Limit | Impact |
|---|---|---|
| `POST /api/auth/register` | 20 per 60 s, 300 per IP per day, 2000 global per day | registration on-ramp |
| `POST /api/auth/login` | 10 per 60 s per IP, then per username | sign-in attempts |
| `POST /api/campaigns/<slug>/gifts` | 6 per day per user | create gifts |
| `POST /api/gifts/<id>/heart` | 20 per 60 s per user | give hearts |
| Public reads | 3000 per 60 s per IP (cache misses only) | browsing |
| Admin requests | 10 per 60 s per user | moderation + config |

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

**Option 1: Bootstrap with placeholder secrets (simplest for local testing)**
```
PASSWORD_PEPPER=local_test_pepper_32chars_exactly
IP_HMAC_KEY=local_test_ip_hmac_key_32chars_xxx
SUB_HMAC_KEY=local_test_sub_hmac_key_32chars_xx
```

(Local-only placeholders; use real random keys in staging/production: `printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put <NAME>`)

### Run

Terminal 1:
```bash
npm run worker:dev
```

Terminal 2:
```bash
npm run dev
```

Visit `http://localhost:5173` (frontend) and `/dang-nhap` to sign in.

### Local D1 Database

Tables are created automatically on the first request via idempotent `CREATE TABLE IF NOT EXISTS` statements.

**If you have an old local D1 database** (from before Phase 2b, with the old `app_user` schema):
- The schema check will refuse to start with error `schema: stale app_user (recreate this database, docs/runbooks/staging.md)`
- To start fresh:

```bash
rm -rf .wrangler/state
# Restart npm run worker:dev
```
npm run worker:dev
```

The next request creates all tables from scratch.

### Schema upgrades (automatic)

`ensureSchema` creates missing tables and then runs the upgrade steps in `worker/schema.ts` (`UPGRADES`). Each step checks the live table shape and only rebuilds a table if it is old. The rebuild runs as one D1 transaction: if it fails, nothing changes, the request returns 503, the log shows `schema: upgrade failed`, and the next request retries.

Steps, in order (each is its own batch; the Worker re-checks the table after a step runs):

1. **Drop `public_id`.** A database created by commit 4d3a5df (the first production deploy) has `teacher_profile.public_id TEXT UNIQUE NOT NULL`; newer code no longer writes it, so adding teachers failed with 503. Runs only if `public_id` exists and `role` does not. The Worker copies `teacher_id`, `department` and `show_on_home` into a new `teacher_profile` built from the current DDL, so every row also gets `role = 'Giáo viên'`.
2. **Add `role` (chức vụ).** Runs only if `role` is missing (databases without `public_id` from before this feature): `ALTER TABLE teacher_profile ADD COLUMN role ... DEFAULT 'Giáo viên'`. On production at 4d3a5df this step is skipped, because step 1 already created the column.
3. **Add `font` to student_card.** Card v3 feature (2026-11-18): `ALTER TABLE student_card ADD COLUMN font TEXT NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32)`. Existing cards get Bút bi (patrick-hand).
4. **Add `ink` to student_card.** Card v3 feature (2026-11-18): `ALTER TABLE student_card ADD COLUMN ink TEXT NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')`. Existing cards get blue (#1d3fa6).
5. **Role list (Giám thị).** Runs after steps 1–4, only if the stored `CREATE TABLE teacher_profile` text lacks the current role CHECK (SQLite cannot alter a CHECK). One batch copies all four columns into a new `teacher_profile` with the four-role CHECK, drops the old table and renames. Every row keeps its role. A `schema: upgrade failed` right after the Giám thị deploy comes from this step.

**Production (f7cc60e at the time of writing):** all columns exist, so the Giám thị deploy runs only step 5 (once), then nothing on later cold starts. Verified on workerd with a database created by f7cc60e.

**One-time seed (after schema steps):** Six flower backgrounds (one per layout, ~18–23 KB WebP, tokens `seedbg0000000001`–`6`) + six active example templates ("Hoa hồng · Dọc – giữa" …). Guarded by meta flag `images_seeded`; INSERT-only, never overwrites. Added even if admin templates exist; admins can turn the templates off or delete them (an image still used by a template cannot be deleted). The six images count toward the 200-image / 40 MB library caps. Failure logs `schema: seed images failed` and the site keeps working; that line (repeated on new instances) is the signal to investigate. To regenerate the images, see the header of `worker/seedImages.ts` (source: `docs/design/card-v3-mockup.html`).

If two Worker instances start at the same moment, one can fail a step with "duplicate column name". That request returns 503 and logs `schema: upgrade failed` once; the next request sees the column and continues. One such log line right after a deploy is not a stuck deploy; repeated lines are.

**Template_image CHECK:** On fresh DBs, CHECK limits slots to `background` only. Old DBs keep their old CHECK. Old banner/photo links stay in the table but are ignored on reads, not counted in an image's "used by", and deleted together with their image; writes accept only `background`.

**Before deploying a release that contains an upgrade step:**

```bash
# 1. Note the restore point (Time Travel: 7 days on Free, 30 days on Paid)
npx wrangler d1 time-travel info cham-yeu-thuong

# 2. Check for orphan profile rows (should be 0; non-zero would make the copy fail)
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT count(*) AS n FROM teacher_profile WHERE teacher_id NOT IN (SELECT id FROM teacher)"
```

After deploy:
1. The Cloudflare build succeeded.
2. `/gui-thiep` shows the six example templates; old templates show as "Dọc – giữa" (or "Ngang – giữa" for Đêm sao).
3. Write a card with Thư pháp + Tím: the preview shows that font and colour; after approval the teacher's QR page shows the same.
4. `/admin` → Mẫu thiệp: the editor preview shows the dashed writing zone.
5. Adding a teacher still works.
6. Editing a teacher to **Chức vụ: Giám thị** saves; their tile shows "Giám thị" only (no môn/tổ).

**Rollback:** roll forward with a fix. After step 5, redeploying f7cc60e keeps working only until someone saves a Giám thị role; after that, the old code rejects that teacher's role on edit (400) because it does not know the value. Redeploying 4d3a5df after the upgrade breaks, because that code still reads `public_id` and expects no font/ink columns. If you must go back, restore the database together with the old code (destructive, overwrites all data written since):

```bash
npx wrangler d1 time-travel restore cham-yeu-thuong --bookmark=<bookmark from step 1>
```


### Curl Tests

```bash
# Register a test account
curl -X POST -H "Content-Type: application/json" -H "X-Requested-With: fetch" \
  -d '{"username":"testadmin","password":"TestPass123!","nickname":"Test","className":"10A"}' \
  http://localhost:8787/api/auth/register

# Sign in and save session cookie
curl -X POST -H "Content-Type: application/json" -H "X-Requested-With: fetch" \
  -c cookies.txt \
  -d '{"username":"testadmin","password":"TestPass123!"}' \
  http://localhost:8787/api/auth/login

# Admin requests (require session cookie and X-Requested-With header)
curl -b cookies.txt -H "X-Requested-With: fetch" \
  http://localhost:8787/api/admin/admins
```

---

## Campaigns (Phase 1)

A **campaign** is one event on the site. 20/11 is campaign 1 (slug `20-11`, kind `teacher_cards`); Noel 2026 will be a `gift_tree` campaign. Status is `draft`, `active` or `closed`, and at most one campaign is `active` (partial unique index). A campaign is **open** when it is `active` **and** now is between `starts_at` and `ends_at`; nothing changes status automatically.

Campaign endpoints need **Google sign-in**: the typed-email login is refused there (401). Sign in on `/admin` with "Đăng nhập bằng Google" (see `docs/runbooks/google-signin.md`).

### Campaign editor (`/admin` → Chiến dịch)
1. **Tạo chiến dịch**: slug (2–32 chars, `a-z`, `0-9`, `-`; reserved: admin, api, t, gui-thiep, ve-clb-ai, assets, theme, g), kind, name (required, ≤ 120), tagline (≤ 200), content JSON, start and end in Vietnam time (stored as UTC `YYYY-MM-DDTHH:MM:SSZ`), and for `gift_tree` the settings (ranges shown in the form). A new campaign is always **draft**.
2. **Sửa**: loads the full campaign; saving changes only the fields you edit. Slug, kind and status cannot be changed here.
3. **Kích hoạt** (asks for confirmation): closes the currently active campaign and activates this one in one transaction. Activating Noel closes 20/11 — new cards then get "campaign_closed", while 20/11 pages stay readable.
4. **Đóng**: sets the campaign to `closed`. With no active campaign, `/` shows the most recently closed one, read-only.

Content JSON shape (what `/` reads):

```json
{ "home": { "kicker": "Ngày Nhà giáo Việt Nam 20/11/2026", "heading": "Gửi thầy cô muôn vàn lời tri ân", "body": "…" } }
```

**Campaign 1 window:** created as `active` from 2026-01-01T00:00:00Z to 2026-12-31T23:59:59Z. After that it is no longer open (new cards → 409 `campaign_closed`) unless you edit the end date.

**Caching:** public campaign reads are cached 5 s per Worker instance, and "not found" answers up to 30 s. After creating or activating a campaign, wait 30 s before announcing its link.

**Delete** (API only, no button): `DELETE /api/admin/campaigns/<id>` → 409 `campaign_protected` for campaign 1 or the active campaign, 409 `campaign_has_rows` if templates, wishes or cards belong to it.

### Campaign admin API

All need a Google admin session cookie and, for writes, `X-Requested-With: fetch`. Bodies are JSON with snake_case keys; `status` is refused on POST and PATCH (use activate/close). Errors: 400 `bad_request` (invalid field), 401 not signed in with Google, 403 not an admin, 404 `not_found` (unknown id), 409 as above.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/admin/campaigns` | `{ campaigns: [{ id, slug, kind, name, tagline, starts_at, ends_at, status, created_at, created_by }] }` |
| POST | `/api/admin/campaigns` | `{ slug, kind, name, tagline?, content?, theme_colors?, settings?, starts_at, ends_at }` → 201 `{ id }` (draft) |
| GET | `/api/admin/campaigns/<id>` | full row incl. `content`, `theme_colors`, `settings` |
| PATCH | `/api/admin/campaigns/<id>` | any of `name, tagline, content, theme_colors, settings, starts_at, ends_at` → `{ ok: true }` |
| POST | `/api/admin/campaigns/<id>/activate` | closes the previous active → `{ ok: true }` |
| POST | `/api/admin/campaigns/<id>/close` | → `{ ok: true }` |
| DELETE | `/api/admin/campaigns/<id>` | → `{ ok: true }` or 409 |

Public (no sign-in): `GET /api/campaigns/active` (active campaign, else the most recent closed one with `open: false`, 404 if none) and `GET /api/campaigns/<slug>` (`draft` → 404; only the exact path, no trailing slash). Response: `{ slug, kind, name, tagline, content, themeColors, settings, startsAt, endsAt, status, open }`, `Cache-Control: public, max-age=5`.

`POST /api/cards` returns **409 `{"error":"campaign_closed"}`** when campaign 1 is not open (other 20/11 responses are unchanged).

### User data deletion requests (NFR-6, within 7 days)
Users can delete their own account with `DELETE /api/me` (no button until Phase 2). For a request by message, delete by the user's Google email (removes their sessions and account; admin rows are not touched):

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM session WHERE user_id IN (SELECT id FROM app_user WHERE email = 'student@gmail.com'); DELETE FROM app_user WHERE email = 'student@gmail.com';"
```

---

## Phase 1 deploy checklist (campaigns + Google sign-in)

Deploy **not before 23/11 and by 27/11**, outside event traffic. Production is currently at 4cb51a3 (Giám thị). Deploy = merge `campaign-platform` into `master` and push.

### Before
- [ ] Google OAuth client created and `GOOGLE_CLIENT_ID` set in `wrangler.jsonc` vars (`docs/runbooks/google-signin.md`). Without it, sign-in is refused and the button shows "chưa được cấu hình".
- [ ] Secret `NONCE_KEY` set on production (without it the sign-in button cannot load: `GET /api/auth/nonce` → 503):
  ```bash
  printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put NONCE_KEY
  ```
  `SUB_HMAC_KEY` is required from Phase 2 (ban tombstones): without it Google sign-in fails closed (503) and unbanning or deleting a banned account fails. `IP_HMAC_KEY` is not read yet.
- [ ] Staging deployed and checked (`docs/runbooks/staging.md`), including one 429 per new limit class.
- [ ] Upgrade smoke **locally**: a git worktree of `4cb51a3` with `wrangler dev --persist-to <tmp>`, create data, then this branch on the same `--persist-to` state (method in `.kiro/delivery/2026-11-18-campaign-platform/phases/phase-1-campaigns-signin/smoke.md`). Never restore the production database for a test.
- [ ] Note the restore point: `npx wrangler d1 time-travel info cham-yeu-thuong`
- [ ] Orphan check is 0: `npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT count(*) AS n FROM teacher_profile WHERE teacher_id NOT IN (SELECT id FROM teacher)"`
- [ ] Once a custom domain exists: Cloudflare WAF rate-limiting rule on `/api/auth/*` (the Worker limits are per location and approximate).

### After
- [ ] `/`, `/gui-thiep`, `/t/<token>` work as before; `/` shows the 20/11 home.
- [ ] `GET /api/campaigns/active` → slug `20-11`, `open: true`.
- [ ] `GET /api/auth/nonce` → `clientId` is the real client ID.
- [ ] `/admin`: Google sign-in works; the typed-email login still works for the 20/11 sections; Chiến dịch tab lists `20-11`.
- [ ] Write a card: it is accepted (pending).
- [ ] Logs: no `schema: upgrade failed`. A single line right after deploy can be a race; repeated lines are not.
- [ ] If indexes are missing after a crashed upgrade (reads slower, nothing else), create them:
  ```bash
  npx wrangler d1 execute cham-yeu-thuong --remote --command "CREATE INDEX IF NOT EXISTS idx_template_campaign_id ON template(campaign_id); CREATE INDEX IF NOT EXISTS idx_wish_campaign_id ON wish(campaign_id); CREATE INDEX IF NOT EXISTS idx_student_card_campaign_id ON student_card(campaign_id);"
  ```

### Rollback
Roll forward with a fix. The previous code keeps working on the upgraded database (the new columns have defaults and the new tables are ignored), so redeploying `4cb51a3` is safe. Restoring the database (`npx wrangler d1 time-travel restore cham-yeu-thuong --bookmark=<restore point>`) is destructive: it loses everything written since.

### Two admin login methods
Both stay for the whole campaign platform: the typed email for the 20/11 sections, and Google for everything new (campaigns, admin list changes, and in Phase 2 gift moderation, users and theme). Google sign-in only works after the OAuth client and `NONCE_KEY` are set (`docs/runbooks/google-signin.md`), and **must be set up before the Noel launch** or nobody can moderate gifts. Removing the typed-email login is a separate, later feature.

### Schema & Tables

Tables are created automatically on the first request via `ensureSchema` in `worker/schema.ts` (idempotent `CREATE TABLE IF NOT EXISTS`). No migration step needed.

**New tables:**
- `teacher_profile` — `department`, `show_on_home` flag, `role` (chức vụ)
- `template` — layout + active flag
- `template_image` — slot → image mapping (slot: `background` only; legacy banner/photo kept in old DBs but ignored on reads)
- `student_card` — pending/approved/hidden status, student fields (font, ink), review metadata
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
- [ ] Create a teacher with default role (Giáo viên)
- [ ] Create a school leader (Hiệu trưởng or Phó hiệu trưởng) teacher; verify "Chức vụ" column shows the role
- [ ] Test send flow: `/gui-thiep?thay=<id>` → pick template → submit
- [ ] Confirm card is pending (not visible on wall)
- [ ] Approve the pending card
- [ ] Confirm card now appears on wall with "Giáo viên: {subject}" label for regular teacher, role-only label for leader
- [ ] Scan QR code on phone for the leader → random card appears with leader's role in header (no subject/department)
- [ ] Scan QR code for regular teacher → card shows "Giáo viên: {subject}" in header
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

**Problem:** With typed-email login, no identity verification; anyone guessing an admin email can edit content. This was superseded by username/password accounts in Phase 2b.

**Mitigation (Phase 2b):** passwords, rate limits, login lockout (10 failures → 15 min lock), session management. Sole admin recovery uses SQL (see "Recovery: Locked-Out Sole Admin" section).

---

## Recovery Steps

### Locked-Out Player or Admin

1. The account is locked for 15 minutes after 10 wrong password attempts
2. Wait 15 minutes or ask an admin to reset the password
3. Temporary password is shown once; user must change it on first sign-in

### Password Reset by Admin

1. Go to `/admin` → **Quản trị viên** → Users
2. Find the user and click **Đặt lại mật khẩu**
3. The temporary password is shown once (never logged)
4. User receives the password out of band (in person or via secure channel)

### Card Stuck in Pending

1. Go to `/admin` → Kiểm duyệt quà
2. Find the gift
3. Click **Khôi phục** (restore), **Ẩn** (hide), or **Xóa** (delete)

### Gift Accidentally Deleted

Not recoverable (delete is permanent). Apologize and ask the user to recreate it.

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

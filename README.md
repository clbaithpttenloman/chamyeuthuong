# Chạm yêu thương — Campaign Platform with Accounts & Student Cards

**Mission:** Technology creates wishes; emotion creates meaning.  
**Built by:** CLB AI — THPT Ten Lơ Man  
**Active Campaign:** Noel 2026 (gift tree, 10/12–24/12). Past: 20/11 (teacher cards).

A platform that runs different campaigns. **Phase 2b** (Noel) is a 2.5D wish tree: players and admins sign in with a username and password; players create gifts (card inside a decorative box on the tree) and give hearts to others' gifts. Gifts are ranked by hearts and placed on the tree. Admins moderate reports, manage users, and reset passwords.

**Phase 1** (campaigns) remains for campaign setup and 20/11 admin routes (cards, templates, teachers). Google sign-in is optional and not yet configured.

**Tech stack:** Vite + React + TypeScript (frontend), Cloudflare Workers + D1 (backend), deployed to Cloudflare.

## Site Structure

**Routes (Phase 2b — Noel):**

| Route | Purpose |
|---|---|
| `/dang-ky` | Register — username, password, nickname, class. |
| `/dang-nhap` | Sign in — username, password. |
| `/` | Home — Noel intro, player sign-in button, "Treo quà" (create gift), "Bảng xếp hạng" (leaderboard), "Tất cả quà" (all gifts). No sign-in required to view. |
| `/:slug` | Campaign home by slug (e.g., `/noel-2026`). Kind determines component: `gift_tree` → Noel scene, `teacher_cards` → 20/11 home (legacy). Drafts and unknown slugs show 404. Reserved: `admin`, `api`, `t`, `gui-thiep`, `ve-clb-ai`, `assets`, `theme`, `g`, `dang-ky`, `dang-nhap` |
| `/:slug/g/:publicId` | Share link — opens the tree with that gift already opened. Sign-out users can view; actions (heart, report) prompt sign-in. |
| `/admin` | Admin dashboard — campaigns, gift moderation, users (ban/unban, password reset, grant admin), audit log. Username/password sign-in required. |

**(Phase 1 legacy routes — still working):**

| Route | Purpose |
|---|---|
| `/gui-thiep` | Send flow — 20/11 campaign only (backwards-compat). Pick teacher → template → write → submit. Uses typed-email admin for post-approval. |
| `/t/:token` | QR page — teacher's private link; shows their cards. 20/11 campaign only. |
| `/ve-clb-ai` | About — club info, timeline, members. |

**Default theme files:** Static assets regenerated from the approved mockup, served from `public/theme/gift_tree/default/` (built into `dist/`, CDN-cached). New templates can be uploaded by admins; Phase 3 feature.

---

## How It Works

### Noel Player Journey (Phase 2b)

1. **Register** (`/dang-ky`) — username (3–20 chars: a–z, 0–9, _), password (8–128 chars), nickname, class. First account auto-becomes admin.
2. **Sign in** (`/dang-nhap`) — username, password. 10 wrong attempts lock the username for 15 minutes. If you forgot your password, ask an admin to reset it.
3. **Visit home** (`/`) — read the intro, view leaderboard preview; no sign-in required to browse
4. **Create a gift** — "Treo quà": choose box style → ornament style → write a card (message, nickname, class) → see preview → hang it on the tree (slot auto-assigned by hearts after creation)
5. **View the tree** — 3D tree that spins (drag/swipe or ←/→ keys). Top 15 gifts by hearts on the tree; next 10 on the ground; rest in "Tất cả quà"
6. **Open a gift** — tap/click or keyboard; shows card, sender, hearts, rank, and action buttons
7. **Give hearts** — up to 5 per day; hearts refresh at Vietnam midnight; locked in once given. Accounts younger than 24 hours cannot give hearts.
8. **Report or delete** — report inappropriate gifts (needs 3 reports to auto-hide); delete your own visible gifts to free a slot
9. **Share** — each gift has a share link (`/:slug/g/:publicId`) that opens it directly
10. **My gifts** — view your own gifts and delete them individually
11. **Account** — change password or delete your account and all gifts (admin moderation queue must be empty first)

**Admin moderation** (on-call during 10/12–24/12):
- Queue: gifts awaiting review (auto-hidden by 3 reports, or admin-hidden)
- Actions: restore (acknowledges reports), hide, delete, or ban the user
- User ban: hides all their gifts, removes their hearts (recounted), signs them out; ban can be undone
- Banned users: staying permanently banned (a deleted banned account leaves a tombstone; a new sign-in with that username stays banned)
- Password reset: generate a temporary 72-hour password, shown once, displayed only to the admin
- Admins: list by username, grant by username, revoke by user id, self/last-admin guards in place
- Audit: read-only log of admin actions (last 200, kept 180 days)

### 20/11 Student Journey (Phase 1 legacy)

1. **Visit home** (`/`) — read the intro and press "Gửi thiệp" (or open `/gui-thiep?thay=<id>` to preselect a teacher)
2. **Pick a template** — from active templates (layout + background)
3. **Find the teacher** — search by name or môn, filter by tổ
4. **Write a message** — 1–300 characters, max 5 newlines, trimmed, no control characters
5. **Optional: name and class** — `anonymous` is on by default; turn it off to show `"Name · Class"` or `"Name"`
6. **Choose font and ink**, check the preview
7. **Submit** → `POST /api/cards` sends the card as **pending**
8. Confirmation: "Đã gửi thành công!" (redirects to home)
9. **Card is hidden** until an admin approves it
10. **Approved**: appears on that teacher's QR page; visible to anyone with the QR link

### Admin Workflow (Setup Order)

1. **Deploy** the site
2. **Register the first account** — go to `/dang-ky`, create a username and password. This account auto-becomes admin. Verify in `/admin`.
3. **Grant other admins** — in the admin page, **Quản trị viên** tab, grant admin role by username
4. Create campaigns, templates, and moderate as needed

### Admin Moderation

**Duyệt thiệp** (Review cards):
- Default tab shows **pending** cards, oldest first
- Filter by status: pending, approved, hidden
- Filter by teacher
- Approve or hide one card, or **select up to 200** and bulk approve/hide
- **Delete** removes a card entirely
- **Hide** keeps it in D1 but removes it from all public queries (does not count against the pending cap)
- **Delete spam** instead of hiding (pending cap is 2000 global, 200 per teacher; hidden cards stay stored but don't count)
- **409 Conflict**: "đang có quá nhiều thiệp chờ duyệt" means the cap is hit; delete old spam to free space

---

## Admin Dashboard Sections

### **Duyệt thiệp** (Review Cards)

- **List**: pending (oldest first), approved, hidden — filter by status and teacher
- **Single action**: approve, hide, or delete one card
- **Bulk action**: select up to 200 cards and approve/hide all at once
- **Card preview**: thumbnail (layout + images), student name (anonymous shows "Một bạn học sinh"), class, and message excerpt

### **Mẫu thiệp** (Templates)

- **Create**: name (≤ 60 chars), pick layout, upload or assign one background image (the card face), active flag
- **List**: grid of active templates only; click to edit
- **Edit**: update name, layout, background image, toggle active
- **Delete**: 409 if any card uses it; deactivate instead to hide from students while keeping existing cards rendering
- **Active/inactive**: students pick active only; inactive cards stay rendered in approved cards

**Card v3 Model:** a template = name + layout + one background image. The layout determines the card ratio (portrait 3:4 or landscape 4:3) and the writing zone position and size (as % of the card). The background image is shown at 100% as the card face; text is written directly on it. Students do not choose images; admins pick one background per template. The card is rendered at actual card dimensions (960×1280 or 1280×960 px), so layout and text sizing are identical on QR pages, moderation thumbnails, and printed cards.

**Layouts** (from `shared/layouts.ts`) — card v3 (physical-card model):

| ID | Name | Ratio | Writing Zone |
|---|---|---|---|
| `doc-giua` | Dọc – giữa | 3:4 (portrait) | center 72% × 68% |
| `doc-duoi` | Dọc – nửa dưới | 3:4 (portrait) | lower 82% × 50% |
| `doc-tren` | Dọc – nửa trên | 3:4 (portrait) | upper 82% × 50% |
| `ngang-giua` | Ngang – giữa | 4:3 (landscape) | center 64% × 72% |
| `ngang-phai` | Ngang – nửa phải | 4:3 (landscape) | right 47% × 82% |
| `ngang-trai` | Ngang – nửa trái | 4:3 (landscape) | left 47% × 82% |

**Layouts (legacy mapping):** old templates created with ids `classic`, `lotus`, `spring`, `minimal` are read as `doc-giua` (center portrait); `night` is read as `ngang-giua` (center landscape). Mapping is read-time only; new templates accept only the six ids above.

**Image Slot**:
- `background` — the entire card face (960×1280 for portrait, 1280×960 for landscape). Background is shown at 100% as the card face. Text is written directly on it in the layout's writing zone. Admins should upload images that leave the zone clear.

### **Thầy cô** (Teachers)

- **List**: all teachers with card counts (pending, approved, hidden), `show_on_home` toggle, QR display, **chức vụ** (role)
- **Create**: title (Thầy/Cô, required), name, subject, department, **chức vụ** (default Giáo viên), `show_on_home` toggle
- **Bulk add**: paste list `Thầy|Cô Tên | Môn | Tổ` (1–100 rows, all-or-nothing); all created with `chức vụ = Giáo viên` and `show_on_home = 1`. To change role, edit each teacher individually after bulk add.
- **Edit**: name, subject, department, **chức vụ**, toggle `show_on_home`
- **QR code**: each teacher has a unique 16-char random token that encodes their private card page (`/t/<token>`). Download and distribute privately (printed/emailed). QR link stays in browser history and Cloudflare logs — open on trusted devices only.
- **Rotate QR**: generates new token (old QR invalid; teacher's card page URL changes but that's why it's private)
- **Delete**: removes teacher and all their cards (cascade)
- **Nhận thiệp mới** (`showOnHome`): the teacher's on/off switch for new cards. On: listed in the send page's teacher picker and counted on the home page. Off: not listed, so students cannot send new cards; approved cards stay readable on the QR page. Hidden teachers are not in the picker, so students cannot choose them; the API still accepts `teacherToken` (`/gui-thiep?t=<token>`), but no page links to it. The teacher's QR page (`/t/<token>`) is for reading only: a random card, "Thiệp khác" and "Xem tất cả", with no send button
- **Chức vụ (Role)**: select one of "Giáo viên" (default), "Hiệu trưởng", "Phó hiệu trưởng", "Giám thị". Every role except Giáo viên is shown by chức vụ only on tiles/cards; regular teachers show "Giáo viên: {môn}" or "Giáo viên" if no môn. Their subject and department are hidden from display labels but still used for wishes and filters.

### **Thư viện lời chúc** (Wish Library)

- **List**: 12 example wishes seeded; title, body, usage count
- **Create**: title (≤ 80 chars), body (≤ 600 chars, can include placeholders `{Thầy/Cô}`, `{thầy/cô}`, `{tên}`, `{môn}`)
- **Edit**: update title or body
- **Delete**: always allowed (existing cards keep their stored message)
- **Cap**: 200 wishes per instance

**Placeholder replacement** (`fillWish`):
- `{Thầy/Cô}` → "Thầy" or "Cô" (capitalized, before name or sentence start)
- `{thầy/cô}` → "thầy" or "cô" (mid-sentence)
- `{tên}` → teacher's name
- `{môn}` → subject (or empty if missing)

### **Thư viện ảnh** (Image Library)

- **Upload**: JPEG/PNG/WebP, browser compresses max 1280 px and ≤ 300 KB
  - Server validates: magic bytes match type, pixel dims ≤ 4096 each, ≤ 8 MP total, ≤ 300 KB
  - Metadata (EXIF, GPS) stripped by browser re-encoding
  - Name: 1–80 chars, no control characters
- **List**: thumbnails with name, MIME, size, usage count, creation date
- **Delete**: 409 if used by any card; remove reference first
- **Limits**: 200 images max, 40 MB total (base64 D1 storage ~1.33× size)

### **Quản trị viên** (Admins)

- **List**: all admins with email, sign-up date, added by
- **Add**: type email, click Add; email is normalized (trim, lowercase)
- **Remove**: cannot remove the last admin; blocked with 409

---

## Public API — Phase 2 (Noel)

All JSON endpoints; rate limit first, before DB.

### GET /api/campaigns/active
Rate limit: **3,000/60 s per IP** (after memo cache miss)

Returns the active campaign metadata (public fields only).

```json
{
  "id": 2,
  "slug": "noel-2026",
  "kind": "gift_tree",
  "name": "Noel 2026",
  "tagline": "Cây Thông Điều Ước",
  "open": true,
  "starts_at": "2026-12-10T00:00:00Z",
  "ends_at": "2026-12-24T16:59:59Z",
  "settings": {
    "tree_slots": 15,
    "ground_slots": 10,
    "hearts_per_day": 5,
    "gifts_per_user": 3,
    "report_threshold": 3
  }
}
```

- `open`: true if campaign status='active' AND now BETWEEN starts_at and ends_at
- Unknown slug or no active campaign → 404

### GET /api/campaigns/:slug
Returns campaign by slug (public fields only; drafts → 404).

### GET /api/campaigns/:slug/tree
Rate limit: **3,000/60 s per IP** (cache miss only)

Memoised gift-tree snapshot: top ranked gifts for rendering.

```json
{
  "asOf": "2026-12-10T12:34:56Z",
  "gifts": [
    {
      "id": "a1b2c3d4e5f6g7h8",
      "rank": 1,
      "hearts": 5,
      "nickname": "Tester",
      "class": "11A",
      "created_at": "2026-12-10T12:30:00Z"
    }
  ],
  "totals": {
    "tree": 15,
    "ground": 10
  },
  "open": true
}
```

- `id`: public gift ID (16 chars, safe for URLs)
- `rank`: 1–25 (tree + ground); higher rank = more hearts
- First 15 gifts are on tree, next 10 on ground
- `asOf`: timestamp of the memo snapshot; clients keep local heart overrides until a response with later `asOf`
- `open`: false if campaign is closed (hearts frozen, but moderation continues)
- Memoised for 5 seconds; `Cache-Control: public, max-age=5`

### GET /api/campaigns/:slug/gifts?sort=hearts|new&page=1…50
Rate limit: **300/60 s per IP** (`LIST_READ_LIMIT`, cache misses only; pages are cached 5 s per slug + sort + page; any `sort` other than `new` means `hearts`)

Paginated gift list (offset pagination, 24 per page).

```json
{
  "gifts": [
    {
      "id": "a1b2c3d4e5f6g7h8",
      "rank": 1,
      "hearts": 5,
      "nickname": "Tester",
      "class": "11A",
      "created_at": "2026-12-10T12:30:00Z"
    }
  ],
  "page": 1,
  "total": 87
}
```

- `sort=hearts` (default) or `sort=new` (oldest first)
- Memoised per slug+sort+page for 5 seconds
- `page` 1…50 (page 51+ → 400); each page shows up to 24 gifts

### GET /api/gifts/:publicId
Rate limit: **300/60 s per IP** (`LIST_READ_LIMIT`, every request; not cached because owners and admins may see hidden gifts)

Single gift by public ID (share link target).

```json
{
  "id": "a1b2c3d4e5f6g7h8",
  "rank": 1,
  "hearts": 5,
  "nickname": "Tester",
  "class": "11A",
  "message": "Chúc mừng.",
  "font": "patrick-hand",
  "ink": "#1d3fa6",
  "layout": "doc-giua",
  "backgroundImage": "xxxxxxxx",
  "created_at": "2026-12-10T12:30:00Z"
}
```

- 404 if hidden/deleted (except owner and admin)
- Memoised for 5 seconds

### POST /api/campaigns/:slug/gifts
Rate limit: **6/60 s per user** (GIFT_LIMIT)

Create a gift and hang it on the tree.

**Request:**
```json
{
  "box_style": 1,
  "ornament_style": 2,
  "layout": "doc-giua",
  "background_template_id": 1,
  "font": "patrick-hand",
  "ink": "#1d3fa6",
  "message": "Chúc bạn Noel vui vẻ!",
  "nickname": "Tester",
  "class_name": "11A"
}
```

**Response (201):**
```json
{
  "publicId": "a1b2c3d4e5f6g7h8",
  "rank": 26
}
```

- Requires session cookie (signed-in user)
- `message`: 1–300 code points, required, no control chars
- `nickname`: 1–30 code points, required
- `class_name`: 0–10 code points, optional
- `box_style`, `ornament_style`: 1–6, required
- `layout`: must exist in this campaign's templates, required
- `font`: one of FONTS list; defaults patrick-hand
- `ink`: lowercase `#rrggbb`; defaults `#1d3fa6`
- **409** `limit_reached` if user has 3 non-deleted gifts already
- **429** `daily_limit` if user created 6 gifts today (Vietnam day)
- **409** `campaign_closed` if campaign not open
- **403** `banned` if user is banned
- **401** if signed out

### DELETE /api/gifts/:publicId
Rate limit: **10/60 s per user** (USER_WRITE_LIMIT)

Delete a gift (owner only).

- Own visible gift → 200; the gift becomes `deleted` and its message, nickname and class are blanked
- Own hidden gift, or a visible gift with open counted reports → **409** `pending_review` (an admin reviews it first)
- Someone else's or unknown → **404**
- **409** `campaign_closed` after the campaign ends (the final order changes only through moderation)
- **403** `banned`

### POST /api/gifts/:publicId/heart
Rate limit: **20/60 s per user** (HEART_LIMIT)

Give a heart to a gift (once per gift, max 5 per day).

**Request:** empty body `{}`

**Response (200):**
```json
{
  "heartCount": 6,
  "heartsLeft": 2,
  "rank": 3
}
```

- Requires session cookie
- **404** `gift_not_found` (hidden, deleted, or unknown)
- **409** `campaign_closed` if campaign closed
- **403** `own_gift` if it's the user's own gift
- **409** `already_hearted` if user already gave a heart to this gift
- **429** `hearts_exhausted` if user gave 5 hearts today already
- **403** `banned` if user is banned
- Error diagnosis in order (check that order for priority)

### POST /api/gifts/:publicId/report
Rate limit: **10/60 s per user** (REPORT_LIMIT)

Report a gift as inappropriate.

**Request:**
```json
{
  "reason": "inappropriate"
}
```

- `reason`: `inappropriate` | `spam` | `other`, required
- **404** `gift_not_found` (hidden, deleted, unknown)
- **409** `campaign_closed`
- **403** `banned`
- **403** `own_gift` (you cannot report your own gift)
- **409** `already_reported` if user already reported this gift
- **429** `reports_exhausted` after 10 reports in one Vietnam day
- When the campaign's `report_threshold` (default 3) counted reports is reached, the gift is hidden (`hidden_auto`) and appears in the admin queue
- Reports from accounts younger than 24 h at report time, or from banned users, are stored but not counted

### GET /api/me?campaign=:slug
Rate limit: **120/60 s per user or IP** (USER_READ_LIMIT)

Get signed-in user profile for a campaign.

```json
{
  "user": {
    "id": 1,
    "nickname": "Tester",
    "class_name": "11A"
  },
  "isAdmin": false,
  "heartsLeft": 3,
  "heartedGiftIds": ["a1b2c3d4", "e5f6g7h8"],
  "open": true
}
```

- `isAdmin`: true if user's email is in the admin list and Google is authoritative
- `heartsLeft`: 5 - (hearts given today); resets at Vietnam midnight
- `heartedGiftIds`: public IDs of gifts this user has hearted
- `open`: campaign is effectively open
- Signed out → `user: null`, `isAdmin: false`
- No cache; `Cache-Control: no-store`

### GET /api/me/gifts?campaign=:slug
Rate limit: **120/60 s per user or IP** (USER_READ_LIMIT)

Get signed-in user's gifts in a campaign.

```json
[
  {
    "id": "a1b2c3d4e5f6g7h8",
    "rank": 1,
    "hearts": 5,
    "status": "visible",
    "message": "…",
    "created_at": "…"
  }
]
```

- `status`: `visible` | `hidden_auto` | `hidden_admin` | `deleted`
- Ordered by hearts DESC, created_at ASC
- Signed out → 401
- No cache; `Cache-Control: no-store`

### PUT /api/me
Rate limit: **10/60 s per user** (USER_WRITE_LIMIT)

Update user profile (nickname, class_name).

**Request:**
```json
{
  "nickname": "New Nickname",
  "class_name": "12B"
}
```

- Requires session cookie
- Updates immediately

### DELETE /api/me
Rate limit: **10/60 s per user** (USER_WRITE_LIMIT)

Delete user account and all gifts, hearts, reports.

**Response (200):**
```json
{
  "deleted": true
}
```

- Requires session cookie
- **409** `pending_review` if user has any hidden gift (awaiting moderation)
- Sessions are revoked
- If user is banned: `banned_identity` row created; next sign-in stays banned
- **503** if `SUB_HMAC_KEY` not set (no tombstone can be written)

### Admin Endpoints (Google Sign-In Required)

#### GET /api/admin/gifts?status=reported|hidden
Google admin only (the typed-email login gets 401). Returns at most 200 gifts; the header `X-Truncated: 1` means the list was cut.

```json
[
  {
    "id": 1,
    "publicId": "a1b2c3d4e5f6g7h8",
    "campaignId": 2,
    "userId": 7,
    "userBanned": false,
    "status": "hidden_auto",
    "reportCount": 3,
    "heartCount": 5,
    "nickname": "Minh",
    "className": "11A",
    "message": "…",
    "createdAt": "2026-12-11T02:00:00.000Z",
    "layout": "doc-giua",
    "font": "patrick-hand",
    "ink": "#1d3fa6",
    "backgroundTemplateId": 4,
    "reportReasons": { "inappropriate": 2, "spam": 1, "other": 0 },
    "reportsFromNewAccounts": 0
  }
]
```

Reporter identities are never returned.

#### PATCH /api/admin/gifts/:id
Change gift status.

**Request:**
```json
{
  "status": "visible"
}
```

- Status: `visible` (restore; acknowledges the gift's reports) | `hidden_admin` | `deleted`
- **404** unknown or already deleted gift; **409** `owner_banned` when restoring a gift whose owner is banned (unban the owner instead)

#### PATCH /api/admin/users/:id
Ban or unban a user.

**Request:**
```json
{
  "banned": 1
}
```

#### GET /api/admin/tombstones
Get banned-account tombstones.

#### DELETE /api/admin/tombstones/:id
Remove a tombstone.

---

## Public API — Phase 1 (20/11)

All JSON endpoints; rate limit first, before DB.
Rate limit: **120/60 s per IP**

Returns: `{ teachers: [...], totals: {...} }`

Teachers with `show_on_home = 1` only; no card content. Response shows teacher profile and approved card count.

```json
{
  "teachers": [
    {
      "id": 1,
      "title": "Thầy",
      "name": "Nguyễn Văn Khoa",
      "subject": "Toán",
      "department": "Tổ Toán - Tin",
      "role": "Giáo viên",
      "cardCount": 5
    }
  ],
  "totals": {
    "teachers": 15,
    "cards": 42
  }
}
```

- Only `show_on_home = 1` teachers and their approved card counts
- `id` is numeric; used to construct `/gui-thiep?thay=<id>` send links
- `role` is one of: `"Giáo viên"` (default), `"Hiệu trưởng"`, `"Phó hiệu trưởng"`, `"Giám thị"`
- **Display on tiles:** `roleLabel(role, subject)` returns:
  - `"Hiệu trưởng"`, `"Phó hiệu trưởng"` or `"Giám thị"` (môn ignored)
  - `"Giáo viên: {subject}"` for teachers with subject
  - `"Giáo viên"` for teachers without subject
- **Department display:** `departmentLabel(role, subject, department)` returns empty string for leaders; otherwise the department unless it repeats the subject (normalized comparison)
- No card content, no "latest" cards strip

### GET /api/qr/:token
Rate limit: **60/60 s per IP** (blunts QR scanners)

Private teacher QR token → approved cards + teacher profile

```json
{
  "teacher": {
    "id": 1,
    "title": "Thầy",
    "name": "Nguyễn Văn Khoa",
    "subject": "Toán",
    "department": "Tổ Toán - Tin",
    "role": "Giáo viên"
  },
  "cards": [
    {
    "cards": [
    {
      "publicId": "gzz8y7pvsmkrc6mc",
      "layout": "doc-giua",
      "images": {
        "background": "uuy01p4h10is8946"
      },
      "font": "charm",
      "ink": "#6b21a8",
      "message": "Em cảm ơn thầy...",
      "from": "Minh Anh · 11A1",
      "createdAt": "2026-11-17T15:15:25Z"
    }
  ],
  "total": 42
}
```

- Only `status = 'approved'` cards, newest first, max 200
- `total`: count of all approved cards (may exceed 200)
- `role` is one of: `"Giáo viên"`, `"Hiệu trưởng"`, `"Phó hiệu trưởng"`, `"Giám thị"`
- `layout` is one of the six new layout ids (old ids are resolved at read time)
- `font` and `ink` are the student's choices; if missing from old cards, defaults are applied
- `images` contains only `background`
- Unknown/malformed token → 404
- Private token never appears in any response
- Response header `X-Robots-Tag: noindex` and `Referrer-Policy: strict-origin-when-cross-origin` (Google sign-in needs the origin; paths never leave the site)

### GET /api/templates
Rate limit: **120/60 s per IP**

Returns: array of active templates

```json
[
  {
    "id": 1,
    "name": "Hoa hồng · Dọc – giữa",
    "layout": "doc-giua",
    "images": {
      "background": "uuy01p4h10is8946"
    }
  }
]
```

- Only `active = 1` templates
- Images: only `background` slot (16-char token)

### GET /api/wishes
Rate limit: **120/60 s per IP**

Returns: array of all wishes

```json
[
  {
    "id": 1,
    "title": "Chúc Mừng 20/11",
    "body": "Kính chúc {Thầy/Cô} {tên} sức khỏe dồi dào…"
  }
]
```

- Never includes `created_by` (admin only)

### GET /api/about
Rate limit: **120/60 s per IP**

Returns: About content from D1 (timeline, members, stats), or seed content if database is empty/corrupted.

```json
{
  "heading": "CLB AI - THPT Ten Lơ Man",
  "intro": "Em chúc bạn...",
  "stats": [
    { "value": "2", "label": "ngày phát triển" },
    { "value": "5", "label": "mẫu giao diện" }
  ],
  "stepsHeading": "Quá trình thực hiện",
  "steps": [
    {
      "when": "16/11/2026",
      "title": "Khởi tạo dự án",
      "text": "..."
    }
  ],
  "membersHeading": "Thành viên",
  "members": [
    { "name": "Vũ Ngọc Diệp", "role": "Chủ nhiệm CLB" },
    { "name": "Kiro Coding Agent", "role": "Thiết kế & phát triển" }
  ]
}
```

- Editable in admin dashboard (`/admin` → "Giới thiệu CLB")
- Public: always shows current stored content (or seed if corrupted)

### GET /api/templates
See above.

### GET /api/image/:token
Rate limit: **300/60 s per IP**

Raw image bytes (JPEG/PNG/WebP)

**Headers:**
- `Content-Type: image/jpeg | image/png | image/webp`
- `Cache-Control: public, max-age=31536000, immutable`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cross-Origin-Resource-Policy: same-origin`
- `X-Robots-Tag: noindex`

- Cached at Cloudflare edge (immutable, 1-year TTL)
- Unknown/malformed token → 404

### POST /api/cards
Rate limit: **20/60 s per IP** (tight for school NAT on 20/11; raise in wrangler.jsonc if needed)

**Request:**
```json
{
  "teacherId": 1,
  "templateId": 1,
  "message": "Em cảm ơn thầy dạy em.",
  "fromName": "Minh Anh",
  "fromClass": "11A1",
  "anonymous": false,
  "font": "charm",
  "ink": "#6b21a8"
}
```

**Or with private QR token (for `/gui-thiep?t=<token>` flow):**
```json
{
  "teacherToken": "abc1234567890xyz",
  "templateId": 1,
  "message": "...",
  "fromName": "...",
  "fromClass": "...",
  "anonymous": false,
  "font": "charm",
  "ink": "#6b21a8"
}
```

**Response:**
```json
{
  "status": "pending"
}
```

- Status code: **201** on success; **never returns the card**
- `Content-Type` must be `application/json` (optional `; charset=utf-8`), else **400**
- Body ≤ 2 KB
- Exactly one of `teacherId` or `teacherToken` must be present; providing both or neither → **400**
- `teacherId`: positive integer (only teachers with `show_on_home = 1`)
- `teacherToken`: 16-char random token (any teacher, used by private QR links)
- Unknown teacher → **404**
- `message`: 1–300 code points, max 5 newlines, required
- `fromName`: ≤ 40 code points, optional; if `anonymous = true` stored as empty
- `fromClass`: ≤ 10 code points, optional
- `anonymous`: boolean, optional, defaults false
- `font`: optional, exact member of FONTS list (patrick-hand, pangolin, itim, mali, charm, be-vietnam-pro, lora); absent defaults to patrick-hand; invalid or null → **400**
- `ink`: optional, lowercase hex `#rrggbb`; absent defaults to #1d3fa6 (blue); invalid or null → **400**
- Strings: NFC-normalized, trimmed
- Rejected: control characters (except `\n` in message), zero-width characters, format characters, lone surrogates
- Inactive/unknown template → **400**
- Global pending cap (2000) or per-teacher cap (200) hit → **409** `"đang có quá nhiều thiệp chờ duyệt"`
- Rate limit exceeded → **429**
- Other errors: **400**

---

## Admin API

All endpoints require a session cookie from `/api/auth/login` (username/password sign-in). All admin endpoints check for the `admin_role` row; last admin cannot be revoked or deleted. Admin actions are logged in the audit table.

Rate limit: **10/60 s per user** (admin-specific limits), plus a global **60/60 s per IP** rate limit.

All admin endpoints require `X-Requested-With: fetch` header (CSRF defense) and `Sec-Fetch-Site` to be `same-origin` or absent.

### Authentication

#### POST /api/auth/register
Register a new account.

**Request:**
```json
{
  "username": "example",
  "password": "mypassword123",
  "nickname": "Example Name",
  "className": "11A"
}
```

- `username`: 3–20 lowercase alphanumeric + underscore; not in reserved list (admin, quantri, root, system, clbai, giamthi, support); required
- `password`: 8–128 characters, must not contain the username, normalized to NFC (Vietnamese keyboard compatibility); required
- `nickname`: 1–30 characters; optional
- `className`: ≤ 10 characters; optional
- **201** on success (sets session cookie, redirects to home or `?next=`)
- **409** `username_taken` if username exists
- **429** `register_limit` if daily cap (300/IP, 2000 global) exceeded
- **400** for invalid input

#### POST /api/auth/login
Sign in with username and password.

**Request:**
```json
{
  "username": "example",
  "password": "mypassword123"
}
```

- **200** on success (sets session cookie)
- **401** `invalid_credentials` for unknown user, wrong password, or locked username (all return the same error)
- **429** for rate limit exceeded (10/60 s per IP, then per username once verified)
- **403** `banned` if the account is banned
- **403** `password_change_required` if password was reset by an admin and must be changed before other actions

#### POST /api/auth/logout
Clear the session.

- **200** on success
- No request body needed

### User Profile & Account

#### GET /api/me?campaign=<slug>
Get the signed-in user's profile and state.

**Response:**
```json
{
  "user": {
    "id": 123,
    "username": "example",
    "nickname": "Example Name",
    "className": "11A",
    "banned": 0
  },
  "isAdmin": 1,
  "mustChangePassword": 0,
  "heartsLeft": 3,
  "heartedGiftIds": [1, 2, 5],
  "created_at": "2026-12-10T08:00:00Z"
}
```

- `username` (string): the account's username
- `isAdmin` (1 or 0): whether the signed-in user is an admin
- `mustChangePassword` (1 or 0): password must be changed before other actions (after admin reset)
- `heartsLeft` (number): hearts remaining today for this campaign
- `heartedGiftIds` (array): IDs of gifts this user has hearted today
- **200** on success
- **401** if not signed in
- **Cache-Control: no-store** (never cached)

#### PUT /api/me
Update profile.

**Request:**
```json
{
  "nickname": "New Name",
  "className": "12B"
}
```

- `nickname`: 1–30 characters; optional
- `className`: ≤ 10 characters; optional
- **200** on success
- **401** if not signed in
- **403** `password_change_required` if password must be changed
- Rate limited (10/60 s per user)

#### POST /api/me/password
Change password (requires current password).

**Request:**
```json
{
  "current": "oldpassword123",
  "next": "newpassword456"
}
```

- `current`: verified against the credential
- `next`: same validation as registration (8–128 chars, no username in it, NFC normalized)
- **200** on success (revokes all other sessions, creates a new one)
- **401** `invalid_credentials` if `current` is wrong
- **403** `password_change_required` (this endpoint is allowed even with the flag set)
- **429** for rate limit
- Counts wrong attempts toward the 10-attempt lockout

#### DELETE /api/me
Delete your account.

**Request:**
```json
{
  "password": "mypassword123"
}
```

- Requires password verification
- Deletes all gifts, hearts, reports, and identities
- Writes a ban tombstone for each identity so a new registration with the same username stays banned
- **204** on success
- **401** `invalid_credentials` if password is wrong
- **409** `pending_review` if any of your gifts are still in moderation (hidden or reported)
- **409** `last_admin` if you are the last admin
- **403** `password_change_required`
- **429** for rate limit

### Admin: Users & Admins

#### GET /api/admin/admins
List admins by username.

**Response:**
```json
[
  {
    "id": 123,
    "username": "example",
    "nickname": "Example Name",
    "granted_at": "2026-12-10T08:00:00Z"
  }
]
```

- `granted_at`: when the admin role was granted
- **200** on success
- **401** if not signed in
- **403** if not an admin

#### POST /api/admin/admins
Grant admin role to a user by username.

**Request:**
```json
{
  "username": "newadmin"
}
```

- `username`: must exist; unknown username → **404**
- **200** on success
- **401** / **403** (not admin)
- **409** if the user already is an admin

#### DELETE /api/admin/admins/<id>
Revoke admin role.

- `id`: user ID
- **204** on success
- **401** / **403** (not admin)
- **409** if this is the last admin
- **409** if the user is not an admin

#### POST /api/admin/users/<id>/password
Generate a temporary password (admin reset).

**Response:**
```json
{
  "temporaryPassword": "abc123def456gh"
}
```

- Generates a 12-character temporary password, valid for 72 hours
- User must change it on first sign-in (enforced by `mustChangePassword`)
- Revokes all of that user's current sessions
- **200** on success
- **401** / **403** (not admin)
- **409** if the user is yourself
- Password is shown once and never logged or stored in plain text

#### PATCH /api/admin/users/<id>
Ban or unban a user.

**Request:**
```json
{
  "banned": 1
}
```

- **200** on success
- **401** / **403** (not admin)
- **409** `is_admin` if trying to ban an admin (revoke admin first)
- When banning: hides all gifts, removes hearts (recounts), revokes sessions
- When unbanning: restores gift visibility, re-adds hearts

### Admin: Gifts & Reports

#### GET /api/admin/gifts?status=<status>
List gifts by status.

**Query:**
- `status`: one of `reported`, `hidden` (auto-hidden + admin-hidden), `all`
- **200** array of gifts with metadata
- **401** / **403** (not admin)

#### PATCH /api/admin/gifts/<id>
Update gift status (restore, hide, delete).

**Request:**
```json
{
  "status": "visible|hidden|deleted"
}
```

- `status`: target status
- Restore: sets `status='visible'`, acknowledges all reports, resets `report_count` to 0
- Delete: removes the gift entirely
- **200** on success
- **401** / **403** (not admin)
- **404** if gift not found
- Audit logged

### Admin: Audit Log

#### GET /api/admin/audit
Read the newest 200 audit rows (no paging parameter).

**Response:**
```json
[
  {
    "id": 1,
    "action": "grant_admin",
    "actor_username": "admin1",
    "target_username": "user2",
    "at": "2026-12-10T08:00:00Z"
  }
]
```

- Actions: `first_account`, `reset_password`, `grant_admin`, `revoke_admin`, `ban`, `unban`, `delete_gift`
- **200** array of audit rows
- **401** / **403** (not admin)

### Authentication Errors (all endpoints)

#### GET /api/admin/teachers
List all teachers with card counts.

```json
[
  {
    "id": 1,
    "token": "xus7sivp0zztkyv7",
    "title": "Thầy",
    "name": "Nguyễn Văn Khoa",
    "subject": "Toán",
    "department": "Tổ Toán - Tin",
    "role": "Giáo viên",
    "showOnHome": 1,
    "cardCounts": {
      "pending": 2,
      "approved": 5,
      "hidden": 1
    },
    "created_at": "2026-11-17T15:14:38Z"
  }
]
```

- `token`: 16-char unique per teacher; never exposed to students
- `id`: numeric identifier; internal use only
- `role`: one of `"Giáo viên"` (default), `"Hiệu trưởng"`, `"Phó hiệu trưởng"`, `"Giám thị"`

#### POST /api/admin/teachers
Create one teacher.

**Request:**
```json
{
  "title": "Thầy",
  "name": "Nguyễn Văn A",
  "subject": "Tiếng Anh",
  "department": "Tổ Tiếng Anh",
  "role": "Giáo viên",
  "showOnHome": 1
}
```

- `title` (Thầy/Cô): **required**
- `role`: optional; one of `"Giáo viên"`, `"Hiệu trưởng"`, `"Phó hiệu trưởng"`, `"Giám thị"` (any other value or non-string → 400); omitted defaults to `"Giáo viên"`
- Others: optional
- `showOnHome` defaults to 1

#### PUT /api/admin/teachers/:id
Update teacher.

**Request:**
```json
{
  "name": "Nguyễn Văn A",
  "subject": "Tiếng Anh",
  "department": "Tổ Tiếng Anh",
  "role": "Hiệu trưởng",
  "showOnHome": 0,
  "title": "Thầy"
}
```

- `role`: optional; one of `"Giáo viên"`, `"Hiệu trưởng"`, `"Phó hiệu trưởng"`, `"Giám thị"` (invalid value → 400); omitted leaves role unchanged
- Unknown teacher ID → **400**

#### DELETE /api/admin/teachers/:id
Remove teacher and cascade all their cards.

#### POST /api/admin/teachers/:id/rotate
Generate new QR token.

```json
{
  "token": "abc1234567890xyz"
}
```

- Old QR (with old token) becomes invalid immediately
- New token creates a new private card page URL `/t/<new-token>`

#### POST /api/admin/teachers/bulk
Create 1–100 teachers atomically.

**Request:**
```json
{
  "items": [
    { "title": "Thầy", "name": "Nguyễn Văn A", "subject": "Toán", "department": "Tổ Toán - Tin" },
    { "title": "Cô", "name": "Trần Thị B", "subject": "Văn" }
  ]
}
```

- 1–100 items, body ≤ 64 KB
- `title` (Thầy/Cô): **required** per item
- All created with `showOnHome = 1`
- All-or-nothing: any error → nothing inserted

### Templates

#### GET /api/admin/templates
List all templates.

```json
[
  {
    "id": 1,
    "name": "Hoa hồng · Dọc – giữa",
    "layout": "doc-giua",
    "active": 1,
    "images": {
      "background": { "id": 1, "token": "seedbg0000000001" }
    },
    "created_at": "2026-11-17T15:15:25Z",
    "created_by": "seed"
  }
]
```

#### POST /api/admin/templates
Create template.

**Request:**
```json
{
  "name": "Hoa hồng · Dọc – giữa",
  "layout": "doc-giua",
  "active": 1,
  "images": {
    "background": 1
  }
}
```

- `name`: ≤ 60 chars, required
- `layout`: one of the six layout ids (doc-giua, doc-duoi, doc-tren, ngang-giua, ngang-phai, ngang-trai); required
- `active`: 0 or 1, defaults to 1
- `images`: `{ "background": <image id> | null }` (`null` removes it). `banner: null` from an old admin tab is ignored; any other key, or `banner`/`photo` with an id → **400**
- Returns created template with full image metadata

#### PUT /api/admin/templates/:id
Update template.

**Request:** same shape as POST

#### DELETE /api/admin/templates/:id
Delete template.

- **409** if any card uses it
- Deactivate (`active = 0`) instead to hide from students

### Moderation

#### GET /api/admin/cards?status=pending|approved|hidden[&teacher=<id>][&after=<id>|&before=<id>]
List cards with raw student fields.

```json
[
  {
    "id": 1,
    "publicId": "gzz8y7pvsmkrc6mc",
    "teacherId": 1,
    "templateId": 1,
    "message": "Em cảm ơn thầy dạy em yêu môn Toán.\nChúc thầy 20/11 lạ lùng!",
    "fromName": "Minh Anh",
    "fromClass": "11A1",
    "anonymous": false,
    "status": "pending",
    "createdAt": "2026-11-17T15:15:25Z",
    "reviewedAt": null,
    "reviewedBy": null,
    "teacher": {
      "id": 1,
      "name": "Nguyễn Văn Khoa",
      "title": "Thầy"
    },
    "template": {
      "id": 1,
      "name": "Hoa hồng · Dọc – giữa",
      "layout": "doc-giua"
    }
  }
]
```

- `status=pending` ordered oldest first (to handle backlog)
- `status=approved|hidden` ordered newest first
- `teacher` filter: optional, single teacher ID
- Cursor paging: `after=<id>` (for pending) or `before=<id>` (for approved/hidden)
- Max 200 per page

#### PUT /api/admin/cards/:id
Change card status.

**Request:**
```json
{
  "status": "approved"
}
```

- Status: `pending`, `approved`, or `hidden`
- Sets `reviewed_at` and `reviewed_by` (email)

#### POST /api/admin/cards/review
Bulk approve/hide (up to 200).

**Request:**
```json
{
  "ids": [1, 2, 5],
  "status": "approved"
}
```

- Max 200 IDs
- Uses `json_each` to avoid 100-parameter bind limit
- Sets `reviewed_at` and `reviewed_by` for all
- Unknown/invalid status → **400**

#### DELETE /api/admin/cards/:id
Remove card (not reversible).

### Images

#### GET /api/admin/images
List image metadata (not bytes).

```json
[
  {
    "id": 1,
    "token": "seedbg0000000001",
    "name": "Hoa hồng · Dọc – giữa",
    "mime": "image/webp",
    "size": 18024,
    "created_at": "2026-11-17T15:14:38Z",
    "created_by": "seed",
    "used_by": 1
  }
]
```

- `used_by`: count of template_image rows with slot='background' (not cards)

#### POST /api/admin/images?name=<name>
Upload image.

**Request:** raw bytes with `Content-Type: image/jpeg | image/png | image/webp`

**Response:**
```json
{
  "id": 1,
  "token": "seedbg0000000001",
  "name": "Hoa hồng · Dọc – giữa",
  "mime": "image/webp",
  "size": 18024,
  "created_at": "2026-11-17T15:14:38Z",
  "created_by": "seed"
}
```

- Server validation:
  - Magic bytes must match declared MIME
  - Pixel dimensions: each ≤ 4096 px, total ≤ 8 MP
  - Body ≤ 300 KB counted on bytes read
  - Name 1–80 chars ASCII, no control chars
  - EXIF/eXIf/EXIF chunks rejected (privacy)
- Caps: 200 images, 40 MB total → **409** if exceeded
- Browser strips EXIF via re-encoding (canvas)

#### DELETE /api/admin/images/:id
Delete image.

- **409** if used by any template or in any card; remove references first
- Unknown ID → **200** (no permission check)

### Wishes

#### GET /api/admin/wishes
List wishes (12 example seeds included).

```json
[
  {
    "id": 1,
    "title": "Chúc Mừng 20/11",
    "body": "Kính chúc {Thầy/Cô} {tên} sức khỏe dồi dào…",
    "created_at": "2026-11-17T15:14:38Z",
    "created_by": "bootstrap"
  }
]
```

#### POST /api/admin/wishes
Create wish.

**Request:**
```json
{
  "title": "Mới",
  "body": "Em chúc {thầy/cô} dạy vui vẻ."
}
```

- `title`, `body`: required, non-empty
- `title` ≤ 80 chars, `body` ≤ 600 chars
- Cap: 200 wishes → **409**

#### PUT /api/admin/wishes/:id
Update wish.

**Request:** same as POST

#### DELETE /api/admin/wishes/:id
Delete wish.

- Always allowed (even if used by cards; they keep stored copy)

### About

#### GET /api/admin/about
Returns current About content (from D1, or seed if empty/corrupted).

```json
{
  "heading": "CLB AI - THPT Ten Lơ Man",
  "intro": "Em chúc bạn...",
  "stats": [
    { "value": "2", "label": "ngày phát triển" }
  ],
  "stepsHeading": "Quá trình thực hiện",
  "steps": [
    { "when": "16/11/2026", "title": "Khởi tạo", "text": "..." }
  ],
  "membersHeading": "Thành viên",
  "members": [
    { "name": "Vũ Ngọc Diệp", "role": "Chủ nhiệm CLB" }
  ]
}
```

#### PUT /api/admin/about
Replace entire About content.

**Request:** full content object (same shape as GET response)

**Validation:**
- `heading`: 1–80 chars, required
- `intro`: 1–600 chars, required, max 10 newlines
- `stats`: 0–6 items; each has `value` (1–12 chars) and `label` (1–40 chars)
- `stepsHeading`: 1–80 chars, required
- `steps`: 0–20 items; each has `when` (1–20 chars), `title` (1–80 chars), `text` (0–400 chars, max 10 newlines)
- `membersHeading`: 1–80 chars, required
- `members`: 0–40 items; each has `name` (1–60 chars) and `role` (1–60 chars)
- Body ≤ 16 KB
- All strings: NFC-normalized, trimmed, no control characters (except `\n` in `intro` and `steps[].text`)
- Unknown keys → **400**
- Invalid values → **400**

Returns the stored content (or seed if new).

Sets `updated_at` and `updated_by` (admin email) on update.

### Admins

#### GET /api/admin/admins
List admins.

```json
[
  {
    "id": 1,
    "email": "clbaithpttenloman@gmail.com",
    "created_at": "2026-11-17T15:14:38Z",
    "created_by": "bootstrap"
  }
]
```

#### POST /api/admin/admins
Add admin.

**Request:**
```json
{
  "email": "admin@example.com"
}
```

- Email normalized (trim, lowercase, ASCII, ≤254 chars, exactly one @)
- Duplicate → **409**

#### DELETE /api/admin/admins/:id
Remove admin.

- Cannot remove last admin → **409**

---

## Error Responses

All errors: `{ error: "<code>" }`

| Status | Code | Reason |
|--------|------|--------|
| 400 | `bad_request` | Invalid fields, unknown template/image/wish, inactive template, empty message on publish, wrong Content-Type, body too large, extra JSON keys |
| 401 | `unauthorized` | Missing/invalid/unknown admin email |
| 403 | `forbidden` | Missing `X-Requested-With: fetch` header or cross-site request |
| 404 | `not_found` | Teacher/card/image/wish/admin not found; malformed public ID or token |
| 405 | `method` | HTTP method not allowed; OPTIONS on public routes |
| 409 | `conflict` | Duplicate email, last admin, image in use, template in use, pending cap exceeded, wish cap exceeded, image cap exceeded |
| 413 | `payload_too_large` | Request body exceeds limit |
| 414 | `uri_too_long` | URL too long |
| 429 | `rate_limited` | Rate limit exceeded per IP |
| 503 | `unavailable` | Database error |

---

## Limits

### Input Limits

| Field | Max | Notes |
|---|---|---|
| Message | 300 code points | max 5 newlines, 1–300 chars required |
| From name | 40 code points | optional |
| From class | 10 code points | optional |
| Wish title | 80 chars | non-empty |
| Wish body | 600 chars | can include placeholders |
| Template name | 60 chars | required |
| Image name | 80 ASCII chars | no control characters |
| Image file | 300 KB | bytes read |
| Image dimensions | 4096 × 4096 px max | ≤ 8 MP total |
| About heading / stepsHeading / membersHeading | 80 chars | required |
| About intro | 600 chars | required, max 10 newlines |
| About stats | 6 items max | each value 1–12 chars, label 1–40 chars |
| About steps | 20 items max | each when 1–20 chars, title 1–80 chars, text 0–400 chars (max 10 newlines) |
| About members | 40 items max | each name 1–60 chars, role 1–60 chars |
| About body | 16 KB | JSON payload |
| Pending cards list | 200 per page | cursor pagination |
| Teacher page cards | 200 | max returned from /api/qr/:token |
| Wishes count | 200 | per instance |
| Images count | 200 | per instance |
| Images total | 40 MB raw | base64 storage ~1.33× size |

### Rate Limits (Per IP, Per Minute)

| Endpoint | Limit | Purpose |
|---|---|---|
| Public reads (wall, templates, wishes, about) | 120 | generous for school NAT |
| POST /api/cards | 20 | tight; raise for 20/11 |
| GET /api/qr/:token | 60 | blunts QR scanners |
| GET /api/image/:token | 300 | fast card loads |
| All /api/admin/* | 60 | upload sessions + R1 brake |

**School NAT consideration:** all students on school Wi-Fi share one IP. 20 card submissions per minute may be tight on 20/11 (about 1 submission per 3 seconds for the whole school). Raise in `wrangler.jsonc` if needed (documented in admin runbook).

---

## Data Model

### New Tables (Card v3 Student Cards Model)

```sql
teacher_profile(
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  department   TEXT NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1)),
  role         TEXT NOT NULL DEFAULT 'Giáo viên' CHECK (role IN ('Giáo viên','Hiệu trưởng','Phó hiệu trưởng','Giám thị'))
)

template(
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  layout     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
)

template_image(
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL CHECK (slot IN ('background')),
  image_id    INTEGER NOT NULL REFERENCES image(id) ON DELETE RESTRICT,
  PRIMARY KEY (template_id, slot)
)

student_card(
  id          INTEGER PRIMARY KEY,
  public_id   TEXT UNIQUE NOT NULL,
  teacher_id  INTEGER NOT NULL REFERENCES teacher(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE RESTRICT,
  message     TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 300),
  from_name   TEXT NOT NULL DEFAULT '' CHECK (length(from_name) <= 40),
  from_class  TEXT NOT NULL DEFAULT '' CHECK (length(from_class) <= 10),
  anonymous   INTEGER NOT NULL DEFAULT 0 CHECK (anonymous IN (0,1)),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','hidden')),
  created_at  TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  font        TEXT NOT NULL DEFAULT 'patrick-hand' CHECK (length(font) <= 32),
  ink         TEXT NOT NULL DEFAULT '#1d3fa6' CHECK (ink GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
)

site_content(
  key        TEXT PRIMARY KEY CHECK (key IN ('about')),
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
)
```

### Unchanged Tables

- `teacher(id, token UNIQUE, name, subject, created_at)` — `token` is the private QR identifier
- `teacher_title(teacher_id PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE, title)`
- `image(id, token UNIQUE, name, mime, size, data, created_at, created_by)` (base64 TEXT)
- `wish(id, title, body, created_at, created_by)`
- `admin(id, email UNIQUE, created_at, created_by)`
- `meta(key PRIMARY KEY, value)` (schema seeding)

---

## Local Development

### Setup

```bash
nvm use
npm install
```

Create `.dev.vars` (gitignored):
```
PASSWORD_PEPPER=local_test_pepper_32chars_exactly
IP_HMAC_KEY=local_test_ip_hmac_key_32chars_xxx
SUB_HMAC_KEY=local_test_sub_hmac_key_32chars_xx
```

(Local-only placeholders; use real random keys in staging/production via `npx wrangler secret put`)

### Run

Terminal 1 — Worker:
```bash
npm run worker:dev
```

Terminal 2 — Vite:
```bash
npm run dev
```

Visit `http://localhost:5173` for the frontend, and `/dang-nhap` to sign in.

Tables are created automatically on the first request. The first account registered becomes admin.

**Schema upgrades:** tables are created with `CREATE TABLE IF NOT EXISTS`, and `ensureSchema` then runs the upgrade steps in `worker/schema.ts` (`UPGRADES`). Phase 2b: drop stale `app_user(google_sub)` and create `user_identity`, `password_credential`, `admin_role` tables. Any future column change needs its own upgrade step. Before deploying one, follow "Schema upgrades" in `docs/runbooks/admin.md` (Time Travel restore point). To start a local database from scratch:

```bash
rm -rf .wrangler/state
# Restart npm run worker:dev
```

The next request creates all tables from scratch.

### Local Development

Create `.dev.vars` (gitignored):
```
PASSWORD_PEPPER=PLACEHOLDER_LOCAL_PEPPER
IP_HMAC_KEY=PLACEHOLDER_LOCAL_IP_HMAC_KEY
SUB_HMAC_KEY=PLACEHOLDER_LOCAL_SUB_HMAC_KEY
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

Tables are created automatically on the first request.

**If you have an old local D1 database** (from before Phase 2b, with the `google_sub` column in `app_user`):

```bash
rm -rf .wrangler/state
# Restart npm run worker:dev
```

The staging D1 also needs to be recreated (see `docs/runbooks/staging.md`).

### Curl Examples

```bash
# Register
curl -X POST -H "Content-Type: application/json" \
     -d '{"username":"example","password":"mypassword123","nickname":"Example","className":"11A"}' \
     http://localhost:8787/api/auth/register

# Sign in and get session cookie
curl -X POST -H "Content-Type: application/json" \
     -d '{"username":"example","password":"mypassword123"}' \
     -c cookies.txt \
     http://localhost:8787/api/auth/login

# Check profile (requires session)
curl -b cookies.txt http://localhost:8787/api/me

# Admin endpoints (require admin role + session + X-Requested-With header)
curl -b cookies.txt \
     -H "X-Requested-With: fetch" \
     http://localhost:8787/api/admin/admins
```

---

## Build & Deploy

### Build

```bash
npm run build
```

Runs TypeScript check, Vite bundle, and header validation.

### Deploy

```bash
npx wrangler deploy
```

See `docs/runbooks/admin.md` for first-deploy setup (production cut-over sequence).

---

## Site Configuration

### noindex Header

All routes are behind `X-Robots-Tag: noindex` (via `public/_headers`).

The school can remove this later by editing `_headers`.

### Robots.txt

`public/robots.txt` blocks all crawlers (advisory only; server returns noindex).

---

## Architecture

- **Frontend:** Vite + React + React Router
- **Backend:** Cloudflare Workers + D1 (SQLite on Cloudflare)
- **Static:** Vite build output served by Workers
- **Images:** base64 TEXT in D1 with immutable edge caching (1 year)
- **Rate limits:** per-IP, per-username, per-user, via Cloudflare rate-limiting bindings
- **Auth:** username + password (PBKDF2-SHA256), session cookie (HttpOnly, 14 days)

**How the Worker runs:**
- All `/api/*` routes → Worker (checked before static assets)
- Everything else → static files from `dist/`
- Single Page Application: unmatched routes → `index.html`

---

## Dependencies

See `package.json` for exact pinned versions (no ranges).

- **Runtime:** react, react-dom, react-router-dom, qrcode, seven @fontsource fonts (patrick-hand, pangolin, itim, mali, charm, be-vietnam-pro, lora) for student font choices, all with Vietnamese coverage, all SIL OFL. See docs/tech.md and docs/runbooks/admin.md for details.
- **Dev:** TypeScript, Vite, Vitest, ESLint (with react-hooks plugin, typescript-eslint), Wrangler

All versions pinned exactly; upgrades follow the 7-day quarantine.

---

## npm Scripts

```bash
npm run dev              # Vite dev server (http://localhost:5173)
npm run build            # TypeScript check + Vite bundle + header validation
npm run preview          # Vite preview (production bundle)
npm run lint             # ESLint on src/
npm test                 # ESLint src/ + Vitest run
npm run worker:dev       # Wrangler dev (http://localhost:8787)
npm run deploy           # Wrangler deploy to Cloudflare
```

---

## Security Notes

- **Card privacy:** only holders of the private QR token can read a teacher's cards. The public `/api/wall` returns teacher names and card counts (used by the send page's picker and the home counters), never card content.
- **Admin email:** unverified (risk R1); only brake is rate limit (60 req/min)
- **Student anonymity:** anonymous flag defaults on; raw name/class shown only after approval
- **Input validation:** control characters, zero-width chars, surrogates rejected; newlines capped at 5
- **Moderation:** every card pending until approved; hidden cards removed from queries (not count against cap); delete to free pending quota
- **Images:** EXIF/GPS/ICC stripped by browser re-encoding; server-side magic-bytes validation
- **CSRF:** all admin requests require `X-Requested-With: fetch` header
- **Foreign keys:** cascade on teacher delete; RESTRICT on template/image use
- **Tokens:** QR token is 16-char random ([a-z0-9], ~82 bits); never appears in public responses or logs

---

## Privacy & Compliance

- **Site-wide noindex** (advisory; students can opt-in to search indexing later)
- **Photo consent:** photos carry potential EXIF metadata; school should get consent before launching
- **QR tokens:** are private URLs; keep them confidential. Cloudflare logs all requests (check their privacy policy)
- **Pending caps:** 2000 global, 200 per teacher — prevents unbounded spam; must be deleted to free space
- **Data retention:** no automatic deletion; school must have a retention policy

See `docs/runbooks/admin.md` for recovery steps, privacy model details, and operational instructions.

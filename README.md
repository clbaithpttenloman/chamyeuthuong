# Chạm yêu thương — AI Club Student Cards Platform

**Mission:** Technology creates wishes; emotion creates meaning.  
**Built by:** CLB AI — THPT Ten Lơ Man  
**Date:** 20/11/2026

A platform where students send personalized cards to teachers. Admins create card **templates** (layout + images); students pick a template, choose a teacher, and write a wish. Every card is pending until approved. Teachers access their cards via a private QR code.

**Tech stack:** Vite + React + TypeScript (frontend), Cloudflare Workers + D1 (backend), deployed to Cloudflare.

## Site Structure

| Route | Purpose |
|---|---|
| `/` | Home — teacher wall showing approved card count per teacher, teacher count, total cards |
| `/gui-thiep` | Send flow — pick teacher → pick template → write message → submit (4 steps). From query `?thay=<id>` or `?t=<token>` |
| `/t/:token` | QR page — teacher's private QR token; shows a random approved card + "View all" + empty state. One link per teacher, distributed privately |
| `/ve-clb-ai` | About — club timeline, members, stats from database |
| `/admin` | Admin dashboard — moderation, templates, teachers, wishes, images, admins (email typed, risk R1) |

Home `/` and About `/ve-clb-ai` text is in `/src/content/site.json`; About content (timeline, members) is stored in D1 and edited via `/admin`.

---

## How It Works

### Student Journey

1. **Visit home** (`/`) — see the teacher wall with card counts per teacher
2. **Click a teacher tile** or visit `/gui-thiep?thay=<id>` → send flow
3. **Alternatively:** if a teacher shared their private QR link, scan it or visit `/t/<token>`, which also has "Gửi thiệp" button linking to `/gui-thiep?t=<token>`
4. **Pick a template** — from active templates (layout + images)
5. **Write a message** — 1–300 characters, max 5 newlines, trimmed, no control characters
6. **Optional: name and class** — `anonymous` is on by default; turn it off to show `"Name · Class"` or `"Name"`
7. **Submit** → `POST /api/cards` sends the card as **pending**
8. Confirmation: "Đã gửi thành công!" (redirects to home)
9. **Card is hidden** until an admin approves it
10. **Approved**: appears on that teacher's QR page; visible to anyone with the QR link

### Admin Workflow (Setup Order)

1. **Deploy** the site
2. **Claim admin** — go to `/admin`, type the bootstrap email (or set `ALLOW_FIRST_CLAIM=1`)
3. **Add teachers** — bulk paste list `Thầy|Cô Tên | Môn | Tổ` (1–100) or add one at a time
4. **Upload images** — JPG/PNG/WebP, max 1280 px, ≤ 300 KB (browser compresses, strips EXIF)
5. **Create templates** — pick layout, assign images to slots (`background`, `banner`), set active
6. **Print QR codes** — from the Thầy cô section; each QR is a private link to that teacher's card page. `Rotate` gives a new token (old QR becomes invalid)
7. **Distribute QR privately** — email, print, or hand to each teacher. Students access the public home page (`/`), or use the private QR to see that teacher's cards
8. **Share the site link** (`/`) — students send cards
9. **Moderate on 20/11** — approve or hide pending cards in "Duyệt thiệp"

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

- **Create**: name (≤ 60 chars), pick layout (5 presets), assign images to slots (`background`, `banner`), active flag
- **List**: grid of active templates only; click to edit
- **Edit**: update name, layout, images, toggle active
- **Delete**: 409 if any card uses it; deactivate instead to hide from students while keeping existing cards rendering
- **Active/inactive**: students pick active only; inactive cards stay rendered in approved cards

**Layouts** (from `shared/layouts.ts`):
- `lotus` — Hoa sen (Lotus)
- `spring` — Mùa xuân (Spring)
- `night` — Đêm sao (Starry night)
- `classic` — Cổ điển (Classic)
- `minimal` — Tối giản (Minimal)

**Image Slots**:
- `background` — full-card cover; text sits on translucent panel
- `banner` — wide image at the top

### **Thầy cô** (Teachers)

- **List**: all teachers with card counts (pending, approved, hidden), `show_on_home` toggle, QR display
- **Create**: title (Thầy/Cô, required), name, subject, department, `show_on_home` toggle
- **Bulk add**: paste list `Thầy|Cô Tên | Môn | Tổ` (1–100 rows, all-or-nothing); all created with `show_on_home = 1`
- **Edit**: name, subject, department, toggle `show_on_home`
- **QR code**: each teacher has a unique 16-char random token that encodes their private card page (`/t/<token>`). Download and distribute privately (printed/emailed). QR link stays in browser history and Cloudflare logs — open on trusted devices only.
- **Rotate QR**: generates new token (old QR invalid; teacher's card page URL changes but that's why it's private)
- **Delete**: removes teacher and all their cards (cascade)
- **Show on home**: toggle to hide/show on the wall

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

## Public API

All JSON endpoints; rate limit first, before DB.

### GET /api/wall
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
    "department": "Tổ Toán - Tin"
  },
  "cards": [
    {
      "publicId": "gzz8y7pvsmkrc6mc",
      "layout": "lotus",
      "images": {
        "background": "uuy01p4h10is8946",
        "banner": "aaz02p5i11jt9j57"
      },
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
- Unknown/malformed token → 404
- Private token never appears in any response
- Response header `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`

### GET /api/templates
Rate limit: **120/60 s per IP**

Returns: array of active templates

```json
[
  {
    "id": 1,
    "name": "Hoa sen hồng",
    "layout": "lotus",
    "images": {
      "background": "uuy01p4h10is8946",
      "banner": "aaz02p5i11jt9j57"
    }
  }
]
```

- Only `active = 1` templates
- Images: slot → 16-char token

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
  "anonymous": false
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
  "anonymous": false
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
- Strings: NFC-normalized, trimmed
- Rejected: control characters (except `\n` in message), zero-width characters, format characters, lone surrogates
- Inactive/unknown template → **400**
- Global pending cap (2000) or per-teacher cap (200) hit → **409** `"đang có quá nhiều thiệp chờ duyệt"`
- Rate limit exceeded → **429**
- Other errors: **400**

---

## Admin API

All endpoints behind `requireAdmin` (typed email sent as `X-Admin-Email` header, checked against D1).

Rate limit: **60/60 s per IP** (doubled from 30/60 to allow upload sessions).

All admin endpoints require `X-Requested-With: fetch` header (CSRF defense).

### Teachers

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

#### POST /api/admin/teachers
Create one teacher.

**Request:**
```json
{
  "title": "Thầy",
  "name": "Nguyễn Văn A",
  "subject": "Tiếng Anh",
  "department": "Tổ Tiếng Anh",
  "showOnHome": 1
}
```

- `title` (Thầy/Cô): **required**
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
  "showOnHome": 0,
  "title": "Thầy"
}
```

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
    "name": "Hoa sen hồng",
    "layout": "lotus",
    "active": 1,
    "images": {
      "background": { "id": 1, "token": "uuy01p4h10is8946" },
      "banner": { "id": 2, "token": "aaz02p5i11jt9j57" }
    },
    "created_at": "2026-11-17T15:15:25Z",
    "created_by": "clbaithpttenloman@gmail.com"
  }
]
```

#### POST /api/admin/templates
Create template.

**Request:**
```json
{
  "name": "Hoa sen hồng",
  "layout": "lotus",
  "active": 1,
  "images": {
    "background": 1,
    "banner": 2
  }
}
```

- `name`: ≤ 60 chars, required
- `layout`: one of lotus, spring, night, classic, minimal; required
- `active`: 0 or 1, defaults to 1
- `images`: object mapping slot → image ID (1–200) or null (empty slot). Valid slots: `background`, `banner`
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
      "name": "Hoa sen hồng",
      "layout": "lotus"
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
    "token": "uuy01p4h10is8946",
    "name": "banner.png",
    "mime": "image/png",
    "size": 136,
    "created_at": "2026-11-17T15:14:38Z",
    "created_by": "clbaithpttenloman@gmail.com",
    "used_by": 3
  }
]
```

- `used_by`: count of template_image rows (not cards)

#### POST /api/admin/images?name=<name>
Upload image.

**Request:** raw bytes with `Content-Type: image/jpeg | image/png | image/webp`

**Response:**
```json
{
  "id": 1,
  "token": "uuy01p4h10is8946",
  "name": "banner.png",
  "mime": "image/png",
  "size": 136,
  "created_at": "2026-11-17T15:14:38Z",
  "created_by": "clbaithpttenloman@gmail.com"
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

### New Tables (Student Cards Model)

```sql
teacher_profile(
  teacher_id   INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  department   TEXT NOT NULL DEFAULT '',
  show_on_home INTEGER NOT NULL DEFAULT 1 CHECK (show_on_home IN (0,1))
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
  slot        TEXT NOT NULL CHECK (slot IN ('background','banner')),
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
  reviewed_by TEXT
)
-- Indexes on (teacher_id, status) and (status, created_at)

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
BOOTSTRAP_EMAIL=you@example.com
```

Or to allow any email to claim first admin:
```
ALLOW_FIRST_CLAIM=1
```

### Run

Terminal 1 — Worker:
```bash
npm run worker:dev
```

Terminal 2 — Vite:
```bash
npm run dev
```

Visit `http://localhost:5173` for the frontend, and `/admin` to sign in.

Tables are created automatically on the first request.

**Schema upgrades:** tables are created with `CREATE TABLE IF NOT EXISTS`, and `ensureSchema` then runs the upgrade steps in `worker/schema.ts` (`UPGRADES`). Today that drops `teacher_profile.public_id` from databases created by 4d3a5df, including production. Any future column change needs its own upgrade step. Before deploying one, follow "Schema upgrades" in `docs/runbooks/admin.md` (Time Travel restore point). To start a local database from scratch:

```bash
rm -rf .wrangler/state
# Restart npm run worker:dev
```

The next request creates all tables from scratch.

### Testing

```bash
npm test
```

Runs `eslint src` and `vitest run` on unit tests.

### Curl Examples

```bash
curl -H "X-Admin-Email: you@example.com" \
     -H "X-Requested-With: fetch" \
     http://localhost:8787/api/admin/teachers

curl -H "Content-Type: application/json" \
     -d '{"teacherId":1,"templateId":1,"message":"Em cảm ơn thầy."}' \
     http://localhost:8787/api/cards
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

See `docs/runbooks/admin.md` for first-deploy setup (bootstrap email, initial admin, adding teachers).

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
- **Rate limits:** per-IP, per-minute, via Cloudflare rate-limiting bindings
- **Auth:** typed email (unverified, risk R1) checked against D1 admin list

**How the Worker runs:**
- All `/api/*` routes → Worker (checked before static assets)
- Everything else → static files from `dist/`
- Single Page Application: unmatched routes → `index.html`

---

## Dependencies

See `package.json` for exact pinned versions (no ranges).

- **Runtime:** react, react-dom, react-router-dom, qrcode, @fontsource/be-vietnam-pro and @fontsource/lora (self-hosted fonts with Vietnamese coverage, SIL OFL; see docs/tech.md)
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

- **Card privacy:** only holders of the private QR token can read a teacher's cards. The public wall shows only card counts, not content.
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

# AI - Chạm yêu thương

**Thông điệp:** Công nghệ tạo lời chúc - Tình cảm tạo nên ý nghĩa.
**Đơn vị thực hiện:** CLB AI - THPT Ten Lơ Man
**Ngày:** 20/11/2026

Website gửi lời chúc cho thầy cô (Vite + React + TypeScript, Cloudflare Workers + D1). Each teacher has a personalized card with a custom layout, images, and a wish message. Admins can manage cards individually or in bulk, maintain a library of wishes, and curate the image library.

## Three site parts

| Route | Content |
|---|---|
| `/` | Home — shared welcome for all teachers |
| `/t/:token` | Card page — individual teacher's card with layout, images, and message (fetched from API) |
| `/ve-clb-ai` | About — club introduction and project timeline |
| `/admin` | Admin dashboard — manage thiệp (cards), wish library, image library, and admins (requires typed email verification) |

Home and About text are in `src/content/site.json`.

## Layouts and Image Slots

Each card renders one of **five preset layouts** in `shared/layouts.ts`:

| Layout ID | Vietnamese Name |
|-----------|-----------------|
| `classic` | Cổ điển |
| `lotus` | Hoa sen |
| `spring` | Mùa xuân |
| `night` | Đêm sao |
| `minimal` | Tối giản |

Every layout renders **three optional image slots** — the admin can upload custom images for each slot:

- **`background`** — full-card cover image; the text sits on a translucent panel for contrast
- **`banner`** — wide image at the top of the card
- **`photo`** — round photo positioned above the teacher's name

Layout styling is in `src/styles.css` (`.card--<id>` classes); image URLs are built from unguessable 16-character tokens.

## Admin Dashboard

Access `/admin` in the browser. A form asks for the admin's email; once verified, the dashboard displays five sections:

### Thiệp (Cards)

- **List**: show all teachers, card status (draft/published), current layout, and token
- **Create**: pick a layout, choose images from the library (slot pickers show thumbnails), select a wish template or write custom text, preview with **CardView**, then publish or save as draft
- **Edit**: update layout, images, or message; toggle status
- **Copy URL**: show the public card URL (`/t/:token`)
- **Show QR**: display the QR code (generated client-side, no upload)
- **Rotate token**: issue a new 16-char token; old URL returns 404
- **Delete**: remove the teacher and all associated data (cascades to layout, images, wishes)

### Tạo hàng loạt (Bulk Create)

- Paste a list: one `Thầy Tên | Môn` or `Cô Tên | Môn` per line (Thầy/Cô required), up to 100 rows, body ≤ 64 KB
- Pick a shared **wish template** (auto-fills message for all created cards via `fillWish` placeholder replacement)
- Pick a shared **layout** and **image set** (same images applied to every card)
- Create as drafts or publish all at once
- Returns: list of created teachers with tokens
- All-or-nothing atomicity: if any row fails, nothing is inserted

### Thư viện lời chúc (Wish Library)

- **List**: 12 example wishes (Vietnamese, Teachers' Day theme, with `{Thầy/Cô}`, `{thầy/cô}`, `{tên}` and `{môn}` placeholders for personalization)
- **Create**: title (≤ 80 chars), body (≤ 600 chars, non-empty)
- **Edit**: update title or body
- **Delete**: remove (always allowed, even if used by published cards)
- **Cap**: max 200 wishes per instance

Example wishes include:
- "Kính chúc {Thầy/Cô} {tên} sức khỏe dồi dào và hạnh phúc…"
- "Chúc {thầy/cô} {tên} dạy môn {môn} luôn tràn đầy năng lượng…"

Every teacher has a required **Thầy/Cô** title, shown before the name on the card ("Kính gửi Thầy Nguyễn Văn A") and in the admin list. `fillWish(body, { name, subject, title })` replaces `{Thầy/Cô}` with `Thầy`/`Cô`, `{thầy/cô}` with `thầy`/`cô` (exact case; `Thầy/Cô` / `thầy/cô` when no title is set yet), and `{tên}`, `{môn}` (case-insensitive) with the name and subject; a missing subject becomes empty and double spaces are collapsed.

### Thư viện ảnh (Image Library)

- **Upload**: drag-and-drop or click to select JPEG/PNG/WebP
  - Browser compresses: max 1280 px, ≤ 300 KB (WebP with JPEG fallback, shrinking quality then size)
  - Metadata (Exif) is stripped by re-encoding through canvas
  - Server-side validation: magic bytes must match declared type, pixel dimensions ≤ 4096 each, total pixels ≤ 8 MP, body ≤ 300 KB counted on bytes read, name 1–80 chars, no control characters
  - Upload failure messages in Vietnamese (type, size, quota, in-use)
- **List**: thumbnails, name, size, mime, created date, `used_by` count (image metadata only, never the raw bytes)
- **Delete**: fails with 409 `conflict` if any published card uses the image; remove the image reference from the card first
- **Limits**: 200 images max, 40 MB total (raw size; base64 D1 storage is ~1.33× larger)

#### Privacy Note

Photos may carry GPS or other metadata in EXIF. Browser-side re-encoding via canvas drops metadata. The server cannot enforce this (URLs are public anyway), so document privacy expectations in the school's Terms of Use.

### Quản trị viên (Admins)

- **List**: all admins with email, sign-up date, and who added them
- **Add**: type an email, click **Thêm** (add); email is normalised (trimmed, lowercased)
- **Remove**: click **Xóa** next to an admin (blocked if it is the last admin)

To change email or sign out, click **Đổi email** — the stored email is cleared and the form appears again.

## Architecture

**Frontend (React + Vite):** static assets served by Cloudflare Workers.

**Worker (`worker/`) + D1:**
- Public API: `GET /api/card/:token` (card JSON with layout and image tokens) and `GET /api/image/:token` (image bytes with immutable caching)
- Admin API: `/api/admin/teachers` (CRUD + bulk create), `/api/admin/images` (upload/list/delete), `/api/admin/wishes` (CRUD), `/api/admin/admins` (list/add/remove)
- All admin endpoints require `X-Admin-Email` header (checked against D1 admin list)
- Rate limits:
  - **CARD_IP_LIMIT**: 60 requests per 60 s per IP for `GET /api/card/*` (school NAT = many viewers on one IP)
  - **ADMIN_FAIL_LIMIT**: 60 requests per 60 s per IP for all `/api/admin/*` endpoints (upload sessions make many calls; also the only brake on guessing admin emails — accepted risk R1)
  - **IMAGE_IP_LIMIT**: 300 requests per 60 s per IP for `GET /api/image/*` (fast card loads + edge caching blunt scanners)

**Database:** Tables are created automatically on the first request via `ensureSchema` in `worker/schema.ts` (idempotent `CREATE TABLE IF NOT EXISTS`).

```sql
teacher (id, token UNIQUE, name, subject, created_at)
card (teacher_id, message, status ∈ {draft, published}, updated_at)
card_style (teacher_id PRIMARY KEY, layout)
card_image (teacher_id, slot ∈ {background,banner,photo}, image_id, PRIMARY KEY (teacher_id, slot))
image (id, token UNIQUE, name, mime ∈ {image/jpeg,image/png,image/webp}, size ≤ 300 KB, data as base64 TEXT)
wish (id, title, body, created_at, created_by)
admin (id, email UNIQUE, created_at, created_by)
meta (key PRIMARY KEY, value) — tracks schema seeding
```

Each teacher has one card. The card has one optional layout and 0–3 images (one per slot). Image data is stored as base64 TEXT in D1 (no R2 required). Seeds: 12 example wishes inserted once on first deploy.

Admins are stored in D1; on first deploy, the person who types the bootstrap email becomes the first admin.

## API

### Public

| Endpoint | Method | Auth | Response |
|----------|--------|------|----------|
| `/api/card/:token` | GET | none | `{ title, name, subject, message, layout, images: { [slot]: <token> } }` for published card (`title` is `Thầy`, `Cô` or `null`), or 404 |
| `/api/image/:token` | GET | none | raw image bytes (JPEG/PNG/WebP) with `Cache-Control: public, max-age=31536000, immutable` or 404 |

**Public image response headers:**
- `Content-Type`: derived from the stored image mime (never user-controlled)
- `Cache-Control: public, max-age=31536000, immutable`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cross-Origin-Resource-Policy: same-origin`
- `X-Robots-Tag: noindex`

**Cached images stay in browser/edge caches for up to one year after deletion.** To replace an image, upload a new one and switch the card's reference (the old URL will remain cached).

### Admin (all endpoints require `X-Admin-Email` header)

**Teachers:**

| Endpoint | Method | Purpose | Body / Notes |
|----------|--------|---------|------|
| `/api/admin/teachers` | GET | List all teachers with card data | — |
| `/api/admin/teachers` | POST | Create one teacher + draft card | `{ title, name, subject?, message?, layout?, images?, status? }` — `title` (`Thầy` or `Cô`) required; status defaults to `draft`; `published` requires non-empty message |
| `/api/admin/teachers/:id` | PUT | Update teacher and card | `{ name, subject, message, status, title?, layout?, images? }` — title/layout/images omitted = no change; `images` keys present set the value (null = remove, number = set existing image id); unknown id → 400 |
| `/api/admin/teachers/:id` | DELETE | Delete teacher (cascades layout, images) | — |
| `/api/admin/teachers/:id/rotate` | POST | Issue new token | — |
| `/api/admin/teachers/bulk` | POST | Create 1–100 teachers atomically | `{ items: [{ title, name, subject?, message? }], layout?, images?, status? }` — `title` (`Thầy`/`Cô`) required per item; all-or-nothing; body ≤ 64 KB; shared layout and images applied to every created card |

**Images:**

| Endpoint | Method | Purpose | Details |
|----------|--------|---------|---------|
| `/api/admin/images` | GET | List image metadata (never data) | Returns array of `{ id, token, name, mime, size, created_at, created_by, used_by }` (used_by = count of cards using this image) |
| `/api/admin/images?name=<name>` | POST | Upload a new image | Body = raw bytes; `Content-Type: image/jpeg\|image/png\|image/webp` (exact); name ≤ 80 chars, no control chars; validation: magic bytes must match type, pixel dims ≤ 4096 each, ≤ 8 MP total, body ≤ 300 KB; caps: 200 images, 40 MB total → 409 `conflict` when exceeded |
| `/api/admin/images/:id` | DELETE | Delete image | 409 `conflict` if any card uses it; 200 if unused or unknown (no permission check on unknown) |

**Wishes:**

| Endpoint | Method | Purpose | Notes |
|----------|--------|---------|-------|
| `/api/admin/wishes` | GET | List wishes | 12 examples seeded; never deleted on restart |
| `/api/admin/wishes` | POST | Create wish | title ≤ 80, body ≤ 600 (both non-empty); cap 200 wishes → 409 `conflict` |
| `/api/admin/wishes/:id` | PUT | Update wish | title, body same rules |
| `/api/admin/wishes/:id` | DELETE | Delete wish | allowed always (even if used by cards) |

**Admins:**

| Endpoint | Method | Purpose | Notes |
|----------|--------|---------|-------|
| `/api/admin/admins` | GET | List all admins | `{ id, email, created_at, created_by }` |
| `/api/admin/admins` | POST | Add new admin | body `{ email }` — normalised; must match email pattern |
| `/api/admin/admins/:id` | DELETE | Remove admin | 409 `conflict` if last admin |

**Error responses** are JSON `{ error: "<code>" }`:

| Status | Code | Reason |
|--------|------|--------|
| 400 | `bad_request` | Invalid or missing fields, unknown image/wish id, invalid layout/slot, published with empty message |
| 401 | `unauthorized` | Missing, invalid, or unknown email |
| 403 | `forbidden` | Cross-site or missing `X-Requested-With: fetch` header |
| 404 | `not_found` | Teacher/admin/image/wish ID not found |
| 409 | `conflict` | Duplicate email (add admin), last admin (remove), in-use image (delete), or caps exceeded (200 images, 40 MB, 200 wishes) |
| 413 | `payload_too_large` | Request body exceeds limit (4 KB for JSON, 300 KB for images, 64 KB for bulk) |
| 414 | `too_long` | Request body declared Content-Length exceeds limit before any read |
| 429 | `rate_limited` | Rate limit exceeded per IP |
| 405 | `method` | HTTP method not allowed |
| 503 | `unavailable` | Database error |

## Local development

```bash
# Setup
nvm use
npm install
```

Create `.dev.vars` (gitignored):
```
BOOTSTRAP_EMAIL=you@example.com
```

Run the Worker in one terminal:
```bash
npm run worker:dev
```

The Worker listens on `http://localhost:8787`. Tables are created automatically on the first request.

Run Vite in another terminal:
```bash
npm run dev
```

Visit `http://localhost:5173/admin` and type the email from `.dev.vars`. The first email to log in becomes the admin.

For curl smoke tests:
```bash
curl -H "X-Admin-Email: you@example.com" \
     -H "X-Requested-With: fetch" \
     http://localhost:8787/api/admin/teachers
```

### Testing

```bash
npm test
```

Runs unit tests for token generation, auth, public card fetch, and admin CRUD on a local D1 database.

## Build

```bash
npm run build
```

TypeScript type-check, Vite bundle, and security header validation.

## Deploy

See `docs/runbooks/admin.md` for first-time setup and ongoing operations.

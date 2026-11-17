# Admin Operations Runbook

Admin access is protected by a typed email (sent as `X-Admin-Email` header) checked against a D1 `admin` table. The first person to log in claims the admin role via a bootstrap email or open claim.

---

## ⚠️ Important: Email is NOT verified

The admin email is typed in the browser and sent to the Worker — **there is no identity verification**. Anyone who knows or guesses an admin email can edit or delete cards and add themselves as an admin. This is accepted risk R1.

**Mitigation:**
- Keep admin emails **private** — do not share them publicly.
- Rate limit (60 requests per 60 s per IP) slows down guessing (doubled from 30 to accommodate upload sessions).
- The SSO version is preserved in git (`tag sso-google-signin`, `commit cec9a58`) and can be restored at any time.

---

## Creating a Thiệp (Card)

Each card displays one teacher's name, subject, and a personalized message with a layout and custom images.

### Step 1: Choose a Layout

Open **Thiệp** section, click **+ Tạo mới** (Create new), or click **Chỉnh sửa** (Edit) on an existing teacher.

The **layout picker** shows five preset designs:
- **Cổ điển** (Classic) — simple, formal
- **Hoa sen** (Lotus) — Vietnamese traditional
- **Mùa xuân** (Spring) — vibrant and warm
- **Đêm sao** (Starry night) — elegant evening theme
- **Tối giản** (Minimal) — clean and modern

Pick one; it applies the CSS styling to the card.

### Step 2: Choose Images for Three Slots

Each layout has three **optional image slots**:
- **`background`** — full-card cover; text sits on a translucent panel for contrast
- **`banner`** — wide image at the top
- **`photo`** — round photo above the name

For each slot:
1. Click the slot picker
2. Browse the **Thư viện ảnh** (Image library) thumbnails
3. Click to select, or **upload a new image**:
   - Drag-and-drop or click to select JPEG/PNG/WebP
   - Browser compresses: max 1280 px, ≤ 300 KB (WebP, JPEG fallback, shrinking quality then size)
   - Metadata (Exif, GPS) is stripped by re-encoding
4. Omit a slot to leave it empty

### Step 3: Pick a Wish Template

Open the **wish picker** and select one from the **Thư viện lời chúc** (Wish library). If the wish contains placeholders:
- `{Thầy/Cô}` → `Thầy` or `Cô` (capitalised; use it before a name or at the start of a sentence)
- `{thầy/cô}` → `thầy` or `cô` (mid-sentence)
- `{tên}` → teacher's name
- `{môn}` → subject

they are automatically replaced. Choose **Thầy** or **Cô** for every teacher first (the field is required); until you do, the preview shows "Thầy/Cô". The card heading shows the prefix too, for example "Kính gửi Thầy Nguyễn Văn A". If no wish matches, click **Custom** to type a message directly.

### Step 4: Live Preview

The **CardView** preview at the bottom of the form shows the layout, images, and message in real-time as you edit.

### Step 5: Publish or Save as Draft

- **Nháp** (Draft): saves the card but does not make it public
- **Xuất bản** (Publish): makes the card visible via the public URL

Publishing requires a **non-empty message** — if the message field is blank, publishing fails with a validation error.

---

## Bulk Create Thiệp (Tạo hàng loạt)

Create many cards at once from a list of names and subjects.

### Step 1: Paste the List

Open **Tạo hàng loạt** section. In the textarea, paste one teacher per line in the format:

```
Thầy Tên | Môn
Cô Tên | Môn
```

Example:
```
Thầy Nguyễn Văn A | Toán
Cô Trần Thị B | Văn
Thầy Lê Văn C | Tiếng Anh
```

- **Thầy/Cô is required** at the start of every line (upper or lower case). Lines without it are listed by line number and nothing is created until they are fixed.
- **Limit**: 1–100 rows, body ≤ 64 KB; extra lines are reported, not silently dropped
- **Required**: name (before `|`)
- **Optional**: subject (after `|`); if omitted, the card has no subject

### Step 2: Pick Shared Settings

All created cards will have the same:
- **Layout** (one of the five presets)
- **Wish template** (shared message for all cards)
- **Images** (same background/banner/photo for all cards)
- **Status** (draft or published)

### Step 3: Create

Click **Tạo** (Create). The system parses the list, validates each row, and inserts all atomically. If any row fails, nothing is created (all-or-nothing).

### Step 4: Published or Draft

- **Draft**: cards are created but not visible to the public
- **Published**: cards are immediately visible via `/t/:token`

---

## Thư viện lời chúc (Wish Library)

Maintain a library of example wishes and custom messages for the cards.

### View and Use Wishes

Open **Thư viện lời chúc**. The list shows title, body, created info, and how many cards use each wish.

Click a wish to use it in a card editor or bulk create. Wishes with placeholders `{Thầy/Cô}`, `{thầy/cô}`, `{tên}` and `{môn}` are personalized per teacher when applied.

### Add a New Wish

1. Click **+ Thêm** (Add)
2. Enter **Title** (≤ 80 chars)
3. Enter **Body** (≤ 600 chars; can include `{Thầy/Cô}`, `{thầy/cô}`, `{tên}` and `{môn}` placeholders)
4. Click **Lưu** (Save)

**Limit**: 200 wishes per instance.

### Edit a Wish

1. Click **Chỉnh sửa** (Edit)
2. Update title or body
3. Click **Cập nhật** (Update)

Note: existing cards keep their old message (they store a copy, not a reference).

### Delete a Wish

1. Click **Xóa** (Delete)
2. Confirm

The wish is deleted immediately. Cards already using it keep the old message.

---

## Thư viện ảnh (Image Library)

Upload, organize, and manage images for card slots.

### Upload Images

1. Open **Thư viện ảnh**
2. Click the upload area or drag-and-drop
3. Select a JPEG, PNG, or WebP file

The browser compresses the image (max 1280 px, ≤ 300 KB, strips metadata). Server validates:
- **Type**: exact match to declared MIME (image/jpeg, image/png, or image/webp)
- **Magic bytes**: file signature must match the type
- **Dimensions**: width and height each ≤ 4096 px; total ≤ 8 MP
- **File size**: ≤ 300 KB counted on bytes read
- **Limits**: max 200 images, 40 MB total

Upload fails with a Vietnamese error message if validation fails:
- **Sai loại tệp** (Wrong type)
- **Tệp quá lớn** (File too large)
- **Kích thước ảnh quá lớn** (Image dimensions too large)
- **Đã đạt giới hạn thư viện** (Library limit reached)

### View and Use Images

The library shows thumbnails with name, type, size, "used by" count, and creation info.

Click a thumbnail to select it for a card slot.

### Delete Images

Click **Xóa** (Delete). The delete succeeds only if the image is **not used by any published card**:
- Not in use → 200 OK, image removed
- In use → 409 error, "Ảnh này đang được sử dụng, không thể xóa" (This image is in use and cannot be deleted)

To delete an in-use image:
1. Find all cards using it
2. Edit each card and remove the image reference
3. Return to the library and delete the image

---

## Image Upload: Browser-Side Compression and Server Validation

**Browser side** (before upload):
- Max dimensions: 1280 px
- Re-encode to WebP (or JPEG if unsupported) with progressive quality reduction until ≤ 300 KB
- Metadata (Exif, GPS, ICC profile) is stripped when re-encoding

**Server side** (after upload):
- Exact `Content-Type` header match
- Magic bytes must match the declared MIME type
- Pixel dimensions: both width and height ≤ 4096 px; total ≤ 8 MP
- File size: ≤ 300 KB
- Name: 1–80 chars, ASCII, no control characters
- **Metadata rejection**: JPEG with APP1 `Exif`, PNG with `eXIf` chunk, or WebP with `EXIF` chunk are rejected (privacy; browser UI re-encodes to remove it)
- Atomic caps: 200 images max, 40 MB total (raw bytes; base64 D1 storage is ~1.33× larger)

**Consequences:**
- Direct API uploads with mismatched magic bytes → 400 `bad_request`
- Exif-carrying JPEG exported directly (not re-encoded by admin UI) → 400 `bad_request`

---

## ⚠️ Image Cache After Deletion / Replacement

Deleted images are removed from D1, but cached copies at Cloudflare and in user browsers can live for **up to one year** with `Cache-Control: public, max-age=31536000, immutable`.

**To replace an image used in live cards:**
1. Upload a new image
2. Edit the card to use the new image URL
3. The old image URL will remain cached for up to a year until natural expiration

---

## Photo Privacy Note

Uploaded photos may carry **EXIF metadata** such as GPS location, camera model, date, time, and other identifiable data.

**Browser-side mitigation (admin UI):**
- The admin panel re-encodes every image through HTML canvas, which strips EXIF by default

**Direct API uploads (no browser):**
- Direct uploads with EXIF are rejected with a message to re-export (server detects the APP1 segment)

**Published card URLs:**
- Once images are published, the URLs are public (16-char unguessable tokens)
- Guardians and students see the photos; privacy depends on trust in the school and informed consent

**Recommendation**: include photo privacy expectations and opt-in consent in the school's Terms of Use before launching.

---

## How Admin Login Works

1. Open `/admin` and see a form asking for your email
2. Type an email and click **Đăng nhập** (Sign in)
3. The page stores the email in `sessionStorage` (tab-local, cleared when tab closes)
4. Every API request sends the email as `X-Admin-Email` header
5. The Worker checks it against the `admin` table:
   - Found → request proceeds
   - Not found → **401 Unauthorized**
6. Click **Đổi email** to sign out and clear the stored email

---

## First Deploy (Git-connected Cloudflare)

### 1. Choose a Bootstrap Method

Before first deploy, set **one** of these in `wrangler.jsonc`:

- **`BOOTSTRAP_EMAIL`** (recommended): only this email can claim an empty admin table; stays inert once an admin exists
- **`ALLOW_FIRST_CLAIM=1`** (temporary): any email can claim; delete immediately after

### 2. Configure wrangler.jsonc

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "admin@yourdomain.com"
  }
}
```

Or use `ALLOW_FIRST_CLAIM` as a secret (see step 5 below).

### 3. Commit and Push

```bash
git add wrangler.jsonc
git commit -m "Configure admin bootstrap"
git push
```

### 4. Open `/admin` and Sign In

As soon as deploy finishes, open `/admin` and type the bootstrap email. If you see the admin list, the first claim worked. ✓

### 5. If Using `ALLOW_FIRST_CLAIM=1`

```bash
wrangler secret put ALLOW_FIRST_CLAIM
# Paste: 1

npx wrangler deploy

# Open /admin and type any email (becomes first admin)

wrangler secret delete ALLOW_FIRST_CLAIM
npx wrangler deploy
```

---

## Adding Admins

1. Log in to `/admin`
2. Scroll to **Quản trị viên** (Admins)
3. Click **+ Thêm quản trị viên** (Add admin)
4. Type the new email and click **Thêm** (Add)
5. The new admin can now sign in

---

## Removing Admins

1. Log in to `/admin`
2. Scroll to **Quản trị viên**
3. Click **Xóa** (Remove) next to an admin
4. Note: cannot remove the last admin

---

## Recovery: Regain Access When Locked Out

### Step 1: Update `BOOTSTRAP_EMAIL` in wrangler.jsonc

```jsonc
{
  "vars": {
    "BOOTSTRAP_EMAIL": "recovery@yourdomain.com"
  }
}
```

Or as a secret for laptop deploys:
```bash
wrangler secret put BOOTSTRAP_EMAIL
# Paste: recovery@yourdomain.com
```

### Step 2: Empty the Admin Table

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "DELETE FROM admin"
```

### Step 3: Deploy

```bash
npx wrangler deploy
```

### Step 4: Sign In

Open `/admin` and type the recovery email. You become the first admin again.

---

## Local Development

### Option 1: Email Form

1. Create `.dev.vars` (gitignored):
   ```
   BOOTSTRAP_EMAIL=you@example.com
   ```

2. Run Worker:
   ```bash
   npm run worker:dev
   ```

3. In another terminal, run Vite:
   ```bash
   npm run dev
   ```

4. Open `http://localhost:5173/admin` and type the email

### Option 2: Curl Tests

```bash
npm run worker:dev

curl -H "X-Admin-Email: test@example.com" \
     -H "X-Requested-With: fetch" \
     http://localhost:8787/api/admin/teachers
```

---

## Card Token Management

Each teacher has a unique 16-char token for the public URL `/t/:token`.

### Rotate a Token

1. Log in to `/admin`
2. In **Thiệp**, click **Xoay lại mã** (Rotate token)
3. A new token is generated; old URL returns 404

### QR Codes

1. Click **Hiển thị mã QR** (Show QR) to view
2. Click **Tải xuống** (Download) to save as PNG

QR codes are generated client-side (no upload).

---

## First-Deploy Verification Checklist

1. **Upload a small PNG** — confirm it saves and shows in the library
2. **Publish a card** — confirm public `/t/:token` URL works and shows the image
3. **Try invalid uploads**: SVG, type mismatch, oversized dimensions, 320 KB file → all should get 400 errors
4. **Delete in-use image** → should get 409; remove reference and retry → should succeed
5. **Bulk create 100 teachers** → should complete atomically
6. **Note image response time** — first fetch may be slow on cold Worker; subsequent fetches are cached

### Known Production Constraints

- **IMAGE_IP_LIMIT**: 300 requests per 60 s per IP for `GET /api/image/:token`. This allows fast card loads (typically 2–4 images per card) while blunting scanners. With the 1-year browser cache, repeated viewers rarely re-fetch.
- **CARD_IP_LIMIT**: 60 requests per 60 s per IP for `GET /api/card/:token`. Behind a school NAT all phones share one IP, so if more than about 60 people open thiệp within one minute from the school Wi-Fi, some get 429 ("try again"). Mobile data avoids it. Raise the limit in `wrangler.jsonc` if this happens on 20/11.
- **Cache API**: it caches only on a custom domain. On `*.workers.dev` (and in `wrangler dev`) it does nothing, so every image request decodes from D1; check the image response time after the first deploy.
- **Image decoding CPU**: a 288 KB decode takes ~10 ms on local runtime; free plan allows 10 ms per request; if this hits the limit, lower the image cap from 300 KB to 150–200 KB or use R2 (SHORTCUT: see `worker/images.ts`)
- **D1 batch limits**: 100-item bulk create uses ~25 SQL statements; D1 free plan supports 100 per transaction, no issue
- **Multi-admin rate sharing**: multiple admins behind one NAT (one IP) share the 60 requests per 60 s admin budget; a busy editing session may hit the limit
- **Wish seeds**: 12 example wishes are inserted once; if deleted and restarted, seeds return

---

## Error Responses

| Status | Code | Reason |
|--------|------|--------|
| 400 | `bad_request` | Invalid fields, unknown image/wish, invalid layout/slot, published with empty message |
| 401 | `unauthorized` | Missing/invalid/unknown email; or empty admin table without `BOOTSTRAP_EMAIL` |
| 403 | `forbidden` | Missing `X-Requested-With: fetch` header or cross-site request |
| 404 | `not_found` | Teacher/image/wish/admin ID not found |
| 409 | `conflict` | Duplicate email (add admin), last admin (remove), in-use image (delete), caps exceeded |
| 413 | `payload_too_large` | Request body exceeds limit |
| 414 | `uri_too_long` | URL or Content-Length too long |
| 429 | `rate_limited` | Too many requests from IP (60 per 60 s admin, 300 per 60 s images) |
| 503 | `unavailable` | Database error |

---

## Deployment Environments

### Git-Connected Deploy

```bash
git add wrangler.jsonc
git commit -m "Update config"
git push
```

### Laptop Deploy

```bash
wrangler secret put BOOTSTRAP_EMAIL
# Paste: admin@yourdomain.com

npx wrangler deploy
```

---

## Database Schema

Tables are created automatically by `worker/schema.ts` (idempotent `CREATE TABLE IF NOT EXISTS`). Database is pinned in `wrangler.jsonc`.

```sql
teacher (id, token UNIQUE, name, subject, created_at)
card (teacher_id, message, status, updated_at)
card_style (teacher_id PRIMARY KEY, layout)
card_image (teacher_id, slot, image_id, PRIMARY KEY (teacher_id, slot), FK image_id ON DELETE RESTRICT)
image (id, token UNIQUE, name, mime, size, data as base64, created_at, created_by)
wish (id, title, body, created_at, created_by)
admin (id, email UNIQUE, created_at, created_by)
meta (key PRIMARY KEY, value)
```

Inspect the database:

```bash
npx wrangler d1 execute cham-yeu-thuong --remote --command "SELECT email FROM admin"
```

---

## Security Notes

- **Email normalisation**: trimmed, lowercased, ASCII-only, ≤254 chars, exactly one `@`, valid domain
- **No HTML injection**: email never embedded without escaping
- **CSRF defense**: all admin calls require custom `X-Requested-With: fetch` header
- **Rate limit**: 60 requests per 60 s per IP slows email guessing
- **Session storage**: `sessionStorage` (tab-local, cleared on close); never persisted to localStorage
- **Image validation**: magic bytes checked, dimensions validated, Exif/eXIf/EXIF rejected, served with `nosniff` and sandboxing CSP
- **Foreign keys**: deleting a teacher cascades; deleting an image fails (409) if in use
- **Atomic caps**: 200 images, 40 MB total, 200 wishes — enforced with single SELECT COUNT before INSERT

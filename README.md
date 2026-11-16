# AI - Chạm yêu thương

**Thông điệp:** Công nghệ tạo lời chúc - Tình cảm tạo nên ý nghĩa.
**Đơn vị thực hiện:** CLB AI - THPT Ten Lơ Man
**Ngày:** 20/11/2026

Website gửi lời chúc cho thầy cô (Vite + React + TypeScript, Cloudflare Workers + D1).

## Three site parts

| Route | Content |
|---|---|
| `/` | Home — shared welcome for all teachers |
| `/t/:token` | Card page — individual teacher's wish, fetched from the API |
| `/ve-clb-ai` | About — club introduction and project timeline |
| `/admin` | Admin dashboard — manage teachers and cards (requires typed email verification) |

Home and About text are in `src/content/site.json`.

## Architecture

**Frontend (React + Vite):** static assets served by Cloudflare Workers.

**Worker (`worker/`) + D1:**
- Public API `GET /api/card/:token` — returns `{ name, subject, message }` for a published card
- Admin API `/api/admin/*` — CRUD for teachers and cards, requires an admin email sent in `X-Admin-Email` header, checked against the D1 admin list
- Rate limits: 60 requests per 60 s per IP for public cards, 30 requests per 60 s per IP for admin (blunts brute force)

**Database:** Tables are created automatically on the first request via `ensureSchema` in `worker/schema.ts` (idempotent `CREATE TABLE IF NOT EXISTS`).
```sql
teacher (id, token, name, subject, created_at)
card (teacher_id, message, status ∈ {draft, published}, updated_at)
admin (id, email, created_at, created_by)
```

Each teacher has one card. The `token` is the public QR secret (16 random chars, rotatable).

Admins are stored in D1; on first deploy, the first person to type a bootstrap email becomes the admin.

## API

### Public

| Endpoint | Method | Auth | Response |
|----------|--------|------|----------|
| `/api/card/:token` | GET | none | `{ name, subject, message }` or 404 |

### Admin (requires admin email: X-Admin-Email header)

**Teachers:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/teachers` | GET | List all teachers with cards |
| `/api/admin/teachers` | POST | Create a teacher + empty draft card |
| `/api/admin/teachers/:id` | PUT | Update name, subject, message, status |
| `/api/admin/teachers/:id` | DELETE | Delete teacher and card |
| `/api/admin/teachers/:id/rotate` | POST | Issue a new token for the teacher |

**Admins:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/admins` | GET | List all admins (email, created_at, created_by) |
| `/api/admin/admins` | POST | Add a new admin (body: `{ email }`) |
| `/api/admin/admins/:id` | DELETE | Remove an admin (blocked if it is the last admin) |

**Error responses** are JSON `{ error: "<code>" }` with status codes:

| Status | Code | Reason |
|--------|------|--------|
| 400 | `bad_request` | Invalid or missing fields |
| 401 | `unauthorized` | Missing, invalid, or unknown email |
| 403 | `forbidden` | Cross-site or missing `X-Requested-With: fetch` header |
| 404 | `not_found` | Teacher/admin ID not found |
| 409 | `conflict` | Duplicate email (add admin) or last admin (remove admin) |
| 414 | `too_long` | Request body too large |
| 429 | `rate_limited` | Rate limit exceeded (30 requests per 60 s per IP) |
| 405 | `method` | HTTP method not allowed for this endpoint |
| 503 | `unavailable` | Server error or database issue |

### Admin page

Access `/admin` in the browser. A form asks for the admin's email. Once typed and verified by the API, the dashboard shows:

**Teachers:**

- **List teachers**: shows all teachers, card status (draft/published), and token
- **Add teacher**: creates a teacher with an empty draft card
- **Edit**: update name, subject, message; toggle status to publish
- **Copy URL**: show the public card URL (`/t/:token`)
- **Show QR**: display the QR code for the public URL (generated client-side, no upload)
- **Download QR**: save as PNG
- **Rotate token**: issue a new token (old URL returns 404)
- **Delete**: remove the teacher and card

**Admins:**

- **List admins**: shows all admins, their email, when they joined, and who added them
- **Add admin**: enter an email address and click **Thêm** (add); email is normalised (trimmed, lowercased); new admin appears immediately
- **Remove admin**: click **Xóa** next to an admin name to remove them (blocked for the last admin)

To change email or sign out, click **Đổi email** — the stored email is cleared and the form appears again.

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

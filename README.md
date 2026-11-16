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
| `/admin` | Admin dashboard — manage teachers and cards (requires `ADMIN_TOKEN`) |

Home and About text are in `src/content/site.json`.

## Architecture

**Frontend (React + Vite):** static assets served by Cloudflare Workers.

**Worker (`worker/`) + D1:**
- Public API `GET /api/card/:token` — returns `{ name, subject, message }` for a published card
- Admin API `/api/admin/*` — CRUD for teachers and cards, requires `Authorization: Bearer <ADMIN_TOKEN>`
- Rate limits: 60 requests per 60 s per IP for public cards, 30 bad attempts per 60 s per IP for admin (blunts brute force)

**Database (`migrations/0001_init.sql`):**
```sql
teacher (id, token, name, subject, created_at)
card (teacher_id, message, status ∈ {draft, published}, updated_at)
```

Each teacher has one card. The `token` is the public QR secret (16 random chars, rotatable).

## API

### Public

| Endpoint | Method | Auth | Response |
|----------|--------|------|----------|
| `/api/card/:token` | GET | none | `{ name, subject, message }` or 404 |

### Admin (requires `Authorization: Bearer <ADMIN_TOKEN>`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/teachers` | GET | List all teachers with cards |
| `/api/admin/teachers` | POST | Create a teacher + empty draft card |
| `/api/admin/teachers/:id` | PUT | Update name, subject, message, status |
| `/api/admin/teachers/:id` | DELETE | Delete teacher and card |
| `/api/admin/teachers/:id/rotate` | POST | Issue a new token for the teacher |

Responses are JSON `{ error: "<code>" }` on error (codes: `bad_request`, `unauthorized`, `not_found`, `too_long`, `rate_limited`, `method`, `unavailable`).

### Admin page

Access `/admin` in the browser. Enter the `ADMIN_TOKEN` once (kept in `sessionStorage` for the tab duration).

- **List teachers**: shows all teachers, card status (draft/published), and token
- **Add teacher**: creates a teacher with an empty draft card
- **Edit**: update name, subject, message; toggle status to publish
- **Copy URL**: show the public card URL (`/t/:token`)
- **Show QR**: display the QR code for the public URL (generated client-side, no upload)
- **Download QR**: save as PNG
- **Rotate token**: issue a new token (old URL returns 404)
- **Delete**: remove the teacher and card

## Local development

```bash
# Setup
nvm use
npm install
```

Create `.dev.vars` (gitignored):
```
ADMIN_TOKEN=<dev-token>
```

Generate a dev token:
```bash
openssl rand -base64 32
```

Then run both processes in separate terminals:

```bash
# Terminal 1: apply migrations and start the Worker
npm run db:migrate:local
npm run worker:dev
```

The Worker listens on `http://localhost:8787`.

```bash
# Terminal 2: start Vite (proxies /api to localhost:8787)
npm run dev
```

Visit `http://localhost:5173`.

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

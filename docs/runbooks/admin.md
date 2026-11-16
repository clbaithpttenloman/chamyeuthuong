# Admin Operations Runbook

## First Deploy

### 1. Create the D1 database

On first deploy, Wrangler auto-provisions the D1 database. After deployment, capture the database ID and pin it in `wrangler.jsonc`:

```bash
npx wrangler deploy
```

After the deploy succeeds, Cloudflare displays the database ID. Update `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "cham-yeu-thuong", "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" }
]
```

Then deploy again to pin it:

```bash
npx wrangler deploy
```

### 2. Apply migrations

```bash
wrangler d1 migrations apply cham-yeu-thuong --remote
```

This creates the `teacher` and `card` tables in production.

### 3. Set the admin token

Generate a strong random token (at least 32 characters):

```bash
openssl rand -base64 32
```

Store it as a Wrangler secret:

```bash
wrangler secret put ADMIN_TOKEN
```

Paste the token when prompted. The secret is encrypted and never stored locally.

### 4. Verify

Visit the admin page at `/admin` on your deployed domain. Enter the token you just set. You should see an empty list of teachers.

---

## Printing QR codes

1. Log in to the admin page (`/admin`)
2. Create or edit a teacher to publish their card
3. Click **"Show QR"** to display the code in the browser
4. Click **"Download QR"** to save as PNG
5. Print the PNG

The QR code encodes the public card URL (e.g., `https://domain/t/token`). A teacher scans it with a phone camera to read their personalized message.

---

## Rotating a card token

When a card's QR code is leaked or needs to change:

1. Log in to admin
2. Find the teacher
3. Click **"Rotate token"**
4. The old URL (`/t/old-token`) returns 404
5. Print a new QR code with the new token

---

## Rotating the admin token

If the `ADMIN_TOKEN` is compromised or needs to change:

1. Generate a new token:

   ```bash
   openssl rand -base64 32
   ```

2. Update the secret:

   ```bash
   wrangler secret put ADMIN_TOKEN
   ```

3. Paste the new token when prompted
4. Existing admin browser sessions remain logged in (the old token in `sessionStorage` remains valid until the page is reloaded or the tab is closed)
5. After reload, the admin page requires the new token

---

## Observability

**Workers Logs and real-time tail are intentionally disabled** to keep fixed-string logging only (no tokens, names or messages appear in logs).

If a Worker request fails, Cloudflare's standard observability shows:
- HTTP status and method
- Response time
- Rate limit and resource metrics

For debugging during development:
```bash
npm run worker:dev
```

Errors appear in the terminal where `wrangler dev` is running.

---

## Upgrade path: Cloudflare Access

The current admin token is a shared secret. For per-person identity and revocation:

1. Set up **Cloudflare Access** on the domain
2. Require authentication for `/admin` and `/api/admin/*`
3. Remove the Bearer token check (or keep it as defense-in-depth)

This requires dashboard setup outside the repo and is recommended for long-term deployments.

// Writes one QR PNG per card to qr/<id>.png. Usage: SITE_URL=https://example.workers.dev npm run qr
import { mkdirSync, readFileSync } from 'node:fs'
import QRCode from 'qrcode'
import type { Card } from '../src/cards.ts'

const cards: Card[] = JSON.parse(readFileSync('src/content/cards.json', 'utf8'))

const base = process.env.SITE_URL?.replace(/\/$/, '')
if (!base) {
  console.error('Set SITE_URL, e.g. SITE_URL=https://cham-yeu-thuong.example.workers.dev npm run qr')
  process.exit(1)
}
mkdirSync('qr', { recursive: true })
for (const c of cards) {
  await QRCode.toFile(`qr/${c.id}.png`, `${base}/t/${c.id}`, { width: 600, margin: 2 })
  console.log(`qr/${c.id}.png  ${c.name}`)
}

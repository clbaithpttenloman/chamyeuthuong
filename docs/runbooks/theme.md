# Runbook: Ảnh chủ đề cây thông (Theme uploads)

Admins replace the artwork of the Noel gift tree, one slot at a time, from **Admin → Chủ đề cây thông**.
A slot with no upload keeps the default image in `public/theme/gift_tree/default/`.

## Before you upload

Each slot has a fixed size, format and size limit. The admin page lists them on every card.

| Slot | Size (px) | Format | Background | Max size |
|---|---|---|---|---|
| sky_portrait (nền dọc) | 1080×1920 | JPEG, PNG, WebP | opaque | 600 KB |
| sky_landscape (nền ngang) | 1920×1080 | JPEG, PNG, WebP | opaque | 600 KB |
| layer_ground (tuyết trước) | 1920×500 | PNG, WebP | transparent | 400 KB |
| tree (cây thông) | 1200×1600 | PNG, WebP | transparent | 800 KB |
| star (ngôi sao) | 256×256 | PNG, WebP | transparent | 300 KB |
| ornament_1..6 (đồ trang trí) | 256×256 | PNG, WebP | transparent | 150 KB |
| box_1..6_closed (hộp quà) | 512×512 | PNG, WebP | transparent | 200 KB |

Rules that apply to every upload:

- **Static images only.** Animated GIF, animated WebP and APNG are refused.
- **No metadata.** EXIF, XMP, PNG text chunks (tEXt, zTXt, iTXt) and JPEG comments or Photoshop segments are refused,
  because they can carry location and author data. Export without metadata before upload.
- The server reads the real file. A renamed file or a wrong extension does not pass.

## Upload

1. Open **Admin → Chủ đề cây thông** and choose the campaign (drafts are listed).
2. Pick a file on the slot card. The server checks it and shows every failed rule in Vietnamese.
3. A saved slot shows «Đang dùng ảnh tải lên». Use **Dùng mặc định** to remove the upload.

Uploads take effect on the game page within about 5 seconds (public campaign cache).

## Limits

- **15 MB per campaign** in total, across all slots. A full campaign refuses new uploads with
  «Chiến dịch đã hết dung lượng ảnh chủ đề». Reset a slot to default to free space.
- Images are stored in D1 as base64 in the `theme_image` table. Replacing a slot removes the old row in the same
  transaction.
- Public image reads share the per-IP limit of `IMAGE_IP_LIMIT` (300 requests per 60 s), the same limit as the 20/11 image endpoint.
  Browsers cache each image for a year, so a normal visit fetches each uploaded slot once.

### Removing an image

Deleting or replacing a slot stops new page loads from using the old image. Browsers and the Worker's edge cache keep
a copy of each served image for up to one year, and this admin page cannot purge those copies. Do not upload an image
that must never be seen, even briefly.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| Kích thước phải W×H | Wrong pixel size | Resize to the size on the card. |
| Ảnh phải có nền trong suốt / không được có nền trong suốt | Transparency does not match the slot | Export with or without alpha. |
| Ảnh động chưa được hỗ trợ | Animated file | Export a single frame as PNG or WebP. |
| Ảnh có siêu dữ liệu (EXIF, XMP, chú thích văn bản) | Metadata present | Re-export without metadata. |
| Ảnh vượt quá dung lượng | File larger than the slot limit | Compress, or reduce the pixel size within the rule. |
| Chiến dịch đã hết dung lượng | 15 MB campaign total reached | Reset large slots to default. |

## Verify after an upload

```bash
curl -s https://<host>/api/campaigns/<slug> | python3 -c "import json,sys; print(json.load(sys.stdin)['theme'])"
```

The output lists each uploaded slot as `/api/theme-image/<token>`. Open that URL and check the image has the expected size.
The admin route `GET /api/admin/campaigns/<id>/theme` returns the same map for drafts (needs an admin session).

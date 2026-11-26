# Runbook: Ảnh chủ đề cây thông (Theme uploads)

Admins replace the artwork of the Noel gift tree, one slot at a time, from **Admin → Chủ đề cây thông**.
Every slot accepts an upload. A slot with no upload uses its default, where one exists:

- **Static slots** (sky, ground, tree, ornaments, closed boxes): the default is the image shipped in
  `public/theme/gift_tree/default/`.
- **Star**: the default is the static star. An upload can replace it with an animation.
- **Opening boxes** (`box_N_open`): no upload means the game uses its built-in opening animation.
- **Far layer and overlay** (`layer_far`, `overlay_loop`): no upload means nothing is shown.

An admin can replace any upload with another file, or remove it. Removing an upload restores the default
(for slots that have one) or the empty state.

## What each slot needs

Each card in the admin page lists these rules. Sizes are in pixels. Files are checked by their real content,
not by name.

| Slot | Size | Files | Background | Animation | Max size |
|---|---|---|---|---|---|
| `sky_portrait` (nền dọc) | 1080×1920 | JPEG, PNG, WebP | opaque | none | 600 KB |
| `sky_landscape` (nền ngang) | 1920×1080 | JPEG, PNG, WebP | opaque | none | 600 KB |
| `layer_far` (cảnh xa) | 1920×600 | PNG, WebP | transparent | none | 400 KB |
| `layer_ground` (tuyết trước) | 1920×500 | PNG, WebP | transparent | none | 400 KB |
| `tree` (cây thông) | 1200×1600 | PNG, WebP | transparent | none | 800 KB |
| `star` (ngôi sao) | 256×256 | PNG, WebP, GIF | transparent | GIF or WebP loop, up to 24 frames (a still is allowed) | 300 KB |
| `ornament_1`…`ornament_6` | 256×256 | PNG, WebP | transparent | none | 150 KB each |
| `box_1_closed`…`box_6_closed` | 512×512 | PNG, WebP | transparent | none | 200 KB each |
| `box_1_open`…`box_6_open` | 512×512 per cell; the sheet is 2–4 cells per side, 6–16 frames, at most 2048×2048 | PNG, WebP | transparent | sprite sheet, read left to right, top to bottom; plays once when the gift opens; **fps 12–30, typed in the admin page on upload** | 1 MB each |
| `overlay_loop` (hiệu ứng phủ) | 540×960 | WebP, GIF | transparent | GIF or WebP loop, up to 30 frames | 800 KB |

Rules for every upload:

- **Metadata is refused.** EXIF, XMP, PNG text chunks (tEXt, zTXt, iTXt), GIF comments and other application
  blocks, and JPEG comments or Photoshop segments can contain location or author data. Export without metadata.
- **APNG is refused.** Export an animated PNG as GIF or WebP.
- **Animations are decoded in memory.** frames × width × height × 4 must stay under 64 MB. The limits above keep every slot under it.
- **The campaign total is 15 MB**, across all slots. The sum of the maxima is about 12 MB, so a campaign with every slot
  uploaded at its maximum still fits.

## Sprite sheets: how to lay out a box opening

1. Draw the box closed in the top-left cell and the box open in the last cell. Frames in between show the lid moving.
2. Use one 512×512 cell per frame. Pick a grid of 2–4 columns and 2–4 rows with 6–16 cells in total: 2×3, 3×2, 3×3, 4×3, 4×4 and so on.
3. Leave no cell that is meant to be a frame empty. Every cell counts as one frame.
4. Export as PNG or WebP with transparency. Upload the sheet, then type the fps (12–30) in the field on the card before choosing the file.

## Upload

1. Open **Admin → Chủ đề cây thông** and choose the campaign (drafts are listed).
2. For a sprite slot, set the fps first. Then choose the file on the slot card.
3. The server checks the file and shows every failed rule in Vietnamese.
4. A saved slot shows what it uses: for example «Đang dùng lưới 2×3 (6 khung, 24 fps)». Use **Dùng mặc định**
   (or **Xóa ảnh** for slots without a default) to remove the upload.

Uploads take effect on the game page within about 5 seconds (public campaign cache).

## Limits

- **15 MB per campaign** in total across all slots. A full campaign refuses new uploads with
  «Chiến dịch đã hết dung lượng ảnh chủ đề». Remove or shrink a slot to free space.
- Files are stored in D1 as base64. A row is limited to 2 MB, and the largest slot needs about 1.4 MB as base64.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| Kích thước phải W×H | Wrong pixel size for a still or loop | Resize to the size on the card. |
| Lưới phải có 2–4 ô mỗi cạnh và 6–16 khung hình | Sprite sheet grid outside the rule | Change the grid to 2–4 cells per side and 6–16 cells in total. |
| Lưới khung hình phải có kích thước bội số 512 px | Sprite sheet size not a multiple of 512 | Use whole 512 px cells, at most 2048 px per side. |
| Khai báo tốc độ từ 12 đến 30 | fps missing or outside 12–30 | Type the fps in the field, then upload again. |
| Ảnh động có N khung hình, tối đa M | Loop has too many frames | Remove frames, or lower the frame rate in the source. |
| Ảnh động quá lớn khi giải nén | Frames × size above 64 MB | Reduce the size or the frame count. |
| APNG chưa được hỗ trợ | Animated PNG | Export as GIF or animated WebP. |
| Ảnh có siêu dữ liệu | Metadata in the file | Re-export without metadata. |
| Ảnh vượt quá dung lượng | File larger than the slot limit | Compress, or reduce the size within the rule. |
| Chiến dịch đã hết dung lượng | 15 MB campaign total reached | Remove large slots, or shrink them. |

## Removing an image

Deleting or replacing a slot stops new page loads from using the old image. Browsers and the Worker's edge cache keep
a copy of each served image for up to one year, and this admin page cannot purge those copies. Do not upload an image
that must never be seen, even briefly.

## Verify after an upload

```bash
curl -s https://<host>/api/campaigns/<slug> | python3 -c "import json,sys; print(json.load(sys.stdin)['theme'])"
```

Each uploaded slot is listed with its `url`, `frames`, `fps`, `cols` and `rows`. Open the `url` and check the image
has the expected size. The admin route `GET /api/admin/campaigns/<id>/theme` returns the same map for drafts (needs an admin session).

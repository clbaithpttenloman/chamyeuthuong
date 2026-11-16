# AI - Chạm yêu thương

**Thông điệp:** Công nghệ tạo lời chúc - Tình cảm tạo nên ý nghĩa.
**Đơn vị thực hiện:** CLB AI - THPT Ten Lơ Man
**Ngày:** 20/11/2026

Website tĩnh (Vite + React + TypeScript), triển khai bằng Cloudflare Workers static assets, giống repo `phamhuuthien`. Không có Worker hay cơ sở dữ liệu.

## Ba phần của website

| Route | Nội dung |
|---|---|
| `/` | Trang chủ chung cho toàn thể thầy cô |
| `/t/:id` | Thiệp riêng của từng thầy cô, mở bằng mã QR cá nhân |
| `/ve-clb-ai` | Giới thiệu CLB AI và quá trình thực hiện |

## Nội dung nằm trong JSON

- `src/content/cards.json`: danh sách thiệp. Thêm một thầy cô là thêm một phần tử `{ id, name, subject, message }`.
- `src/content/site.json`: chữ ở trang chủ, trang giới thiệu, tiêu đề, ngày.

`id` là mã ngẫu nhiên gồm chữ thường và số, tối thiểu 8 ký tự (ví dụ `k7m2xq9p`). Đừng dùng tên hay số thứ tự, vì ai biết URL cũng mở được thiệp. `robots.txt` chặn `/t/` khỏi công cụ tìm kiếm.

## Lệnh

```bash
nvm use && npm install
npm run dev        # chạy thử
npm test           # kiểm tra cards.json (id duy nhất, định dạng, không rỗng)
npm run build      # tsc + vite build vào dist/
SITE_URL=https://<domain> npm run qr   # tạo qr/<id>.png cho từng thiệp
npm run deploy     # wrangler deploy (cần wrangler login)
```

Thư mục `qr/` được tạo ra khi chạy `npm run qr` và không commit.

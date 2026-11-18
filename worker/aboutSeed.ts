/**
 * worker/aboutSeed.ts — seed content for the site_content 'about' row.
 *
 * ABOUT_SEED is built from the commit history (16–17/11/2026) and the owner's input.
 * The seed text is apostrophe-free; the SQL generator doubles any single quote to be safe.
 */
import type { AboutContent } from '../shared/api.ts'

export const ABOUT_SEED: AboutContent = {
  heading: 'CLB AI - THPT Ten Lơ Man',
  intro:
    'Các bạn học sinh CLB AI xây dựng trang này như một món quà cho ngày Nhà giáo Việt Nam 20/11.\n' +
    'Trí tuệ nhân tạo giúp viết code, nhưng tình cảm mới là điều tạo nên ý nghĩa thực sự.',
  stats: [
    { value: '2', label: 'ngày phát triển' },
    { value: '5', label: 'mẫu giao diện thiệp' },
    { value: '20/11', label: 'ngày trao gửi' },
  ],
  stepsHeading: 'Quá trình thực hiện',
  steps: [
    {
      when: '16/11/2026',
      title: 'Khởi tạo dự án',
      text: 'Trang tĩnh và bản phác thảo ba trang đầu tiên.',
    },
    {
      when: '16/11/2026',
      title: 'Máy chủ và cơ sở dữ liệu',
      text: 'Cloudflare Worker + D1, mã QR riêng cho từng giáo viên.',
    },
    {
      when: '16/11/2026',
      title: 'Đăng nhập quản trị',
      text: 'Thử Cloudflare Access và Google Sign-In, chọn email nhập tay tạm thời.',
    },
    {
      when: '16/11/2026',
      title: 'Thiết kế thiệp',
      text: 'Năm bố cục, thư viện ảnh, thư viện lời chúc, tạo hàng loạt.',
    },
    { when: '17/11/2026', title: 'Danh xưng Thầy/Cô', text: 'Thêm danh xưng Thầy hoặc Cô trước tên mọi thầy cô và trong lời chúc mẫu.' },
    {
      when: '17/11/2026',
      title: 'Nền tảng gửi thiệp',
      text: 'Mẫu thiệp, học sinh viết, CLB duyệt.',
    },
    {
      when: '17/11/2026',
      title: 'Hoàn thiện giao diện',
      text: 'Font chữ tiếng Việt, thiệp riêng tư.',
    },
    {
      when: '20/11/2026',
      title: 'Trao gửi',
      text: 'Thầy cô mở thiệp qua mã QR của mình.',
    },
  ],
  membersHeading: 'Thành viên',
  members: [
    { name: 'Vũ Ngọc Diệp', role: 'Chủ nhiệm CLB' },
    { name: 'Kiro Coding Agent', role: 'Thiết kế & phát triển' },
  ],
}

/**
 * Returns an INSERT OR IGNORE SQL statement that seeds the about content row.
 * Any single quotes in the JSON are doubled (SQL standard escaping).
 * Accepts an optional content parameter (defaults to ABOUT_SEED) for testing
 * custom content including apostrophes.
 */
export function aboutSeedSql(content: AboutContent = ABOUT_SEED): string {
  const json = JSON.stringify(content).replace(/'/g, "''")
  return `INSERT OR IGNORE INTO site_content (key, value, updated_at, updated_by) VALUES ('about', '${json}', '2026-11-20T00:00:00.000Z', 'seed')`
}

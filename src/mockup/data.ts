/**
 * Fake data for the platform mockup — Revision 2 (template model).
 * No API calls; all data lives here.
 *
 * Model:
 *   Template — admin-created, { id, name, layout }
 *   Teacher  — { id, title, name, subject, department }
 *   Card     — student-made, { templateId, teacherId, message, fromName?, fromClass?, anonymous, status, createdAt }
 */
import { fillWish } from '../../shared/wish.ts'

// ── Types ──────────────────────────────────────────────────────────────────

export type Template = {
  id: number
  name: string
  layout: string
}

export type Teacher = {
  id: number
  title: 'Thầy' | 'Cô'
  name: string
  subject: string
  department: string
}

export type CardStatus = 'pending' | 'approved' | 'hidden'

export type Card = {
  id: number
  templateId: number
  teacherId: number
  message: string
  fromName?: string
  fromClass?: string
  anonymous: boolean
  status: CardStatus
  createdAt: string // relative display string for mockup
}

// ── Constants ──────────────────────────────────────────────────────────────

export const DEPARTMENTS = [
  'Tổ Toán - Tin',
  'Tổ Lý - Hóa - Sinh',
  'Tổ Văn - Sử - Địa',
  'Tổ Ngoại ngữ',
  'Tổ Thể dục - GDQP',
]

// ── Templates (8) — covering all 5 layouts ────────────────────────────────

export const TEMPLATES: Template[] = [
  { id: 1, name: 'Hoa sen hồng',         layout: 'lotus'   },
  { id: 2, name: 'Đêm sao tri ân',       layout: 'night'   },
  { id: 3, name: 'Cổ điển thanh lịch',   layout: 'classic' },
  { id: 4, name: 'Mùa xuân tươi mới',    layout: 'spring'  },
  { id: 5, name: 'Giản dị chân thành',   layout: 'minimal' },
  { id: 6, name: 'Vườn hoa hồng',        layout: 'lotus'   },
  { id: 7, name: 'Bầu trời đêm',         layout: 'night'   },
  { id: 8, name: 'Nét cổ điển vàng',     layout: 'classic' },
]

// ── Teachers (12) ─────────────────────────────────────────────────────────

export const TEACHERS: Teacher[] = [
  { id: 1,  title: 'Thầy', name: 'Nguyễn Văn Khoa',  subject: 'Toán',       department: 'Tổ Toán - Tin'       },
  { id: 2,  title: 'Cô',   name: 'Trần Thị Lan',      subject: 'Tin học',    department: 'Tổ Toán - Tin'       },
  { id: 3,  title: 'Thầy', name: 'Lê Minh Tuấn',      subject: 'Vật Lý',    department: 'Tổ Lý - Hóa - Sinh'  },
  { id: 4,  title: 'Cô',   name: 'Phạm Thị Hoa',      subject: 'Hóa học',   department: 'Tổ Lý - Hóa - Sinh'  },
  { id: 5,  title: 'Cô',   name: 'Nguyễn Thị Mai',    subject: 'Sinh học',  department: 'Tổ Lý - Hóa - Sinh'  },
  { id: 6,  title: 'Thầy', name: 'Hoàng Đức Vinh',    subject: 'Ngữ văn',   department: 'Tổ Văn - Sử - Địa'   },
  { id: 7,  title: 'Cô',   name: 'Vũ Thị Thu',        subject: 'Lịch sử',   department: 'Tổ Văn - Sử - Địa'   },
  { id: 8,  title: 'Cô',   name: 'Đinh Thị Phương',   subject: 'Địa lý',    department: 'Tổ Văn - Sử - Địa'   },
  { id: 9,  title: 'Thầy', name: 'Bùi Quang Huy',     subject: 'Tiếng Anh', department: 'Tổ Ngoại ngữ'        },
  { id: 10, title: 'Cô',   name: 'Lý Thị Kim Anh',    subject: 'Tiếng Anh', department: 'Tổ Ngoại ngữ'        },
  { id: 11, title: 'Thầy', name: 'Đặng Văn Hải',      subject: 'Thể dục',   department: 'Tổ Thể dục - GDQP'   },
  { id: 12, title: 'Cô',   name: 'Phan Thị Thảo',     subject: 'GDQP',      department: 'Tổ Thể dục - GDQP'   },
]

// ── Wish body templates with placeholders ─────────────────────────────────

export const WISH_TEMPLATES = [
  'Kính chúc {Thầy/Cô} {tên} luôn dồi dào sức khỏe, hạnh phúc và tiếp tục là ngọn đèn sáng dẫn đường cho chúng em.',
  'Em xin gửi lời tri ân sâu sắc đến {Thầy/Cô} {tên}. Nhờ {thầy/cô} mà em yêu môn {môn} hơn rất nhiều.',
  'Chúc {Thầy/Cô} {tên} có một ngày 20/11 thật ý nghĩa, tràn đầy niềm vui bên gia đình và học trò.',
  'Những bài giảng của {Thầy/Cô} {tên} sẽ mãi là hành trang quý báu theo em suốt cuộc đời.',
  'Em cảm ơn {Thầy/Cô} {tên} đã luôn kiên nhẫn và tận tâm với chúng em. Chúc {thầy/cô} mãi mãi hạnh phúc!',
  'Kính chúc {Thầy/Cô} {tên} có nhiều sức khoẻ để tiếp tục cống hiến cho sự nghiệp trồng người cao quý.',
]

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build the signature line shown on a card. */
export function sigLine(card: Card): string {
  if (card.anonymous) return 'Một bạn học sinh'
  const parts: string[] = []
  if (card.fromName) parts.push(card.fromName)
  if (card.fromClass) parts.push(card.fromClass)
  return parts.length ? parts.join(' · ') : 'Học sinh'
}

/** Get the layout string for a card via its template. */
export function cardLayout(card: Card): string {
  return TEMPLATES.find((t) => t.id === card.templateId)?.layout ?? 'classic'
}

// ── Cards (37) ────────────────────────────────────────────────────────────

function f(tplIdx: number, t: Teacher): string {
  return fillWish(WISH_TEMPLATES[tplIdx], { name: t.name, subject: t.subject, title: t.title })
}

const T = TEACHERS

export const CARDS: Card[] = [
  // Teacher 1 — Thầy Khoa · Toán (3 approved + 1 pending)
  { id: 1,  templateId: 3, teacherId: 1,  message: f(0, T[0]), fromName: 'Minh Anh',   fromClass: '11A1', anonymous: false, status: 'approved', createdAt: '2 giờ trước'   },
  { id: 2,  templateId: 1, teacherId: 1,  message: f(3, T[0]), fromName: undefined,    fromClass: '12A5', anonymous: true,  status: 'approved', createdAt: '5 giờ trước'   },
  { id: 3,  templateId: 4, teacherId: 1,  message: 'Thầy Khoa là người thầy tuyệt vời nhất! Em sẽ nhớ mãi những giờ Toán vui vẻ.', fromName: 'Trung Kiên', fromClass: '11A3', anonymous: false, status: 'approved', createdAt: '1 ngày trước' },
  { id: 4,  templateId: 8, teacherId: 1,  message: 'Chúc thầy năm mới vui vẻ và hạnh phúc bên gia đình!', fromName: 'Hoàng Long', fromClass: '10A5', anonymous: false, status: 'pending', createdAt: '30 phút trước' },
  // Teacher 2 — Cô Lan · Tin học (3 approved + 1 pending)
  { id: 5,  templateId: 1, teacherId: 2,  message: f(1, T[1]), fromName: 'Hà Linh',    fromClass: '10A2', anonymous: false, status: 'approved', createdAt: '3 giờ trước'   },
  { id: 6,  templateId: 4, teacherId: 2,  message: 'Nhờ có cô Lan mà em biết lập trình. Em yêu môn Tin từ đó!', fromName: 'Phúc Bảo', fromClass: '11A2', anonymous: false, status: 'approved', createdAt: '1 ngày trước' },
  { id: 7,  templateId: 5, teacherId: 2,  message: f(4, T[1]), fromName: undefined,    fromClass: undefined, anonymous: true, status: 'approved', createdAt: '4 giờ trước'  },
  { id: 8,  templateId: 3, teacherId: 2,  message: f(2, T[1]), fromName: undefined,    fromClass: undefined, anonymous: true, status: 'pending',  createdAt: '45 phút trước' },
  // Teacher 3 — Thầy Tuấn · Vật Lý (3 approved + 1 hidden)
  { id: 9,  templateId: 2, teacherId: 3,  message: f(4, T[2]), fromName: undefined,    fromClass: '12A1', anonymous: true,  status: 'approved', createdAt: '4 giờ trước'   },
  { id: 10, templateId: 7, teacherId: 3,  message: 'Thầy Tuấn giảng bài rất hay và dễ hiểu. Chúc thầy luôn vui và khỏe!', fromName: 'Ngọc Hân', fromClass: '12A3', anonymous: false, status: 'approved', createdAt: '6 giờ trước' },
  { id: 11, templateId: 3, teacherId: 3,  message: f(5, T[2]), fromName: 'Gia Huy',    fromClass: '11A4', anonymous: false, status: 'approved', createdAt: '8 giờ trước'   },
  { id: 12, templateId: 2, teacherId: 3,  message: 'Chúc thầy luôn vui vẻ và hạnh phúc!', fromName: 'Ẩn danh', fromClass: '10A1', anonymous: false, status: 'hidden', createdAt: '2 ngày trước' },
  // Teacher 4 — Cô Hoa · Hóa học (3 approved + 1 pending)
  { id: 13, templateId: 6, teacherId: 4,  message: f(0, T[3]), fromName: 'Gia Bảo',    fromClass: '11A4', anonymous: false, status: 'approved', createdAt: '2 giờ trước'   },
  { id: 14, templateId: 1, teacherId: 4,  message: 'Cô Hoa dạy Hóa rất dễ hiểu. Nhờ cô mà em vượt qua kỳ thi.', fromName: undefined, fromClass: '12A2', anonymous: true, status: 'approved', createdAt: '1 ngày trước' },
  { id: 15, templateId: 5, teacherId: 4,  message: f(2, T[3]), fromName: 'Thanh Thư',  fromClass: '11A1', anonymous: false, status: 'approved', createdAt: '3 giờ trước'   },
  { id: 16, templateId: 6, teacherId: 4,  message: 'Cô ơi, cô dạy Hóa rất hay và vui. Em chúc cô 20/11 hạnh phúc và sức khỏe!', fromName: undefined, fromClass: undefined, anonymous: true, status: 'pending', createdAt: '1 giờ trước' },
  // Teacher 5 — Cô Mai · Sinh học (3 approved)
  { id: 17, templateId: 4, teacherId: 5,  message: f(2, T[4]), fromName: 'Thu Trang',  fromClass: '10A1', anonymous: false, status: 'approved', createdAt: '5 giờ trước'   },
  { id: 18, templateId: 1, teacherId: 5,  message: 'Cô Mai là người truyền cảm hứng. Nhờ cô mà em yêu thích nghiên cứu sinh học!', fromName: 'Khánh Linh', fromClass: '12A2', anonymous: false, status: 'approved', createdAt: '4 giờ trước' },
  { id: 19, templateId: 4, teacherId: 5,  message: f(0, T[4]), fromName: 'Minh Châu',  fromClass: '11A3', anonymous: false, status: 'approved', createdAt: '7 giờ trước'   },
  // Teacher 6 — Thầy Vinh · Ngữ văn (2 approved + 1 pending)
  { id: 20, templateId: 3, teacherId: 6,  message: f(3, T[5]), fromName: 'Lê Phương',  fromClass: '11A5', anonymous: false, status: 'approved', createdAt: '7 giờ trước'   },
  { id: 21, templateId: 8, teacherId: 6,  message: 'Thầy Vinh dạy văn hay như kể chuyện. Em nhớ mãi tiết học về thơ Xuân Quỳnh.', fromName: 'Minh Khôi', fromClass: '12A4', anonymous: false, status: 'approved', createdAt: '1 ngày trước' },
  { id: 22, templateId: 3, teacherId: 6,  message: f(0, T[5]), fromName: 'Yến Nhi',    fromClass: '10A2', anonymous: false, status: 'pending',  createdAt: '20 phút trước' },
  // Teacher 7 — Cô Thu · Lịch sử (1 approved + 1 hidden)
  { id: 23, templateId: 1, teacherId: 7,  message: f(1, T[6]), fromName: undefined,    fromClass: undefined, anonymous: true, status: 'approved', createdAt: '3 giờ trước'  },
  { id: 24, templateId: 6, teacherId: 7,  message: 'Cô Thu giảng lịch sử rất hay. Em thích nhất tiết học về thời đại Hùng Vương.', fromName: 'Việt Khôi', fromClass: '11A3', anonymous: false, status: 'hidden', createdAt: '1 ngày trước' },
  // Teacher 8 — Cô Phương · Địa lý (0 approved, 2 pending)
  { id: 25, templateId: 5, teacherId: 8,  message: 'Cảm ơn cô đã cho chúng em thấy thế giới rộng lớn qua từng bài học địa lý.', fromName: 'Hải Nam', fromClass: '10A3', anonymous: false, status: 'pending', createdAt: '8 giờ trước' },
  { id: 26, templateId: 4, teacherId: 8,  message: f(5, T[7]), fromName: undefined,    fromClass: undefined, anonymous: true, status: 'pending',  createdAt: '2 giờ trước'  },
  // Teacher 9 — Thầy Huy · Tiếng Anh (3 approved + 1 pending)
  { id: 27, templateId: 4, teacherId: 9,  message: f(0, T[8]), fromName: 'Bích Ngọc',  fromClass: '11A1', anonymous: false, status: 'approved', createdAt: '1 giờ trước'   },
  { id: 28, templateId: 8, teacherId: 9,  message: 'Thank you teacher Huy for making English class so fun and engaging!', fromName: 'Việt Anh', fromClass: '12A5', anonymous: false, status: 'approved', createdAt: '4 giờ trước' },
  { id: 29, templateId: 4, teacherId: 9,  message: 'Nhờ thầy mà em không còn sợ tiếng Anh nữa. Cảm ơn thầy rất nhiều!', fromName: 'Lan Anh', fromClass: '10A4', anonymous: false, status: 'approved', createdAt: '6 giờ trước' },
  { id: 30, templateId: 1, teacherId: 9,  message: 'Thầy Huy dạy tiếng Anh rất nhiệt tình. Chúc thầy mạnh khỏe và hạnh phúc!', fromName: undefined, fromClass: undefined, anonymous: true, status: 'pending', createdAt: '15 phút trước' },
  // Teacher 10 — Cô Kim Anh · Tiếng Anh (2 approved + 1 hidden)
  { id: 31, templateId: 1, teacherId: 10, message: f(2, T[9]), fromName: undefined,    fromClass: '10A4', anonymous: true,  status: 'approved', createdAt: '6 giờ trước'   },
  { id: 32, templateId: 6, teacherId: 10, message: f(4, T[9]), fromName: 'Minh Tâm',   fromClass: '11A2', anonymous: false, status: 'approved', createdAt: '5 giờ trước'   },
  { id: 33, templateId: 4, teacherId: 10, message: f(1, T[9]), fromName: 'An Nhiên',   fromClass: '10A1', anonymous: false, status: 'hidden',   createdAt: '1 ngày trước'  },
  // Teacher 11 — Thầy Hải · Thể dục (1 approved + 1 pending)
  { id: 34, templateId: 2, teacherId: 11, message: f(4, T[10]), fromName: 'Quốc Bảo',  fromClass: '11A3', anonymous: false, status: 'approved', createdAt: '2 giờ trước'   },
  { id: 35, templateId: 7, teacherId: 11, message: 'Chúc thầy Hải luôn khoẻ mạnh và tiếp tục truyền cảm hứng thể thao cho bọn em!', fromName: 'Trọng Khải', fromClass: '11A5', anonymous: false, status: 'pending', createdAt: '10 phút trước' },
  // Teacher 12 — Cô Thảo · GDQP (2 approved)
  { id: 36, templateId: 5, teacherId: 12, message: f(5, T[11]), fromName: 'Minh Nhật', fromClass: '12A1', anonymous: false, status: 'approved', createdAt: '3 giờ trước'   },
  { id: 37, templateId: 2, teacherId: 12, message: 'Cô Thảo dạy GDQP rất nghiêm túc nhưng cũng rất tâm lý với học sinh.', fromName: undefined, fromClass: undefined, anonymous: true, status: 'approved', createdAt: '2 giờ trước' },
]

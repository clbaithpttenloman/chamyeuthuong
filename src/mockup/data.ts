/**
 * Fake data for the platform mockup.
 * No API calls — all data lives here.
 */
import { fillWish } from '../../shared/wish.ts'

export type Teacher = {
  id: number
  title: 'Thầy' | 'Cô'
  name: string
  subject: string
  department: string
  layout: string
  message: string
}

export type NoteStatus = 'pending' | 'approved' | 'hidden'

export type Note = {
  id: number
  teacherId: number
  text: string
  displayName: string | null
  className: string
  relativeTime: string
  status: NoteStatus
}

export const DEPARTMENTS = [
  'Tổ Toán - Tin',
  'Tổ Lý - Hóa - Sinh',
  'Tổ Văn - Sử - Địa',
  'Tổ Ngoại ngữ',
  'Tổ Thể dục - GDQP',
]

export const TEACHERS: Teacher[] = [
  { id: 1, title: 'Thầy', name: 'Nguyễn Văn Khoa', subject: 'Toán', department: 'Tổ Toán - Tin', layout: 'classic', message: 'Cảm ơn thầy đã kiên nhẫn dẫn chúng em qua từng bài toán khó. Chúc thầy luôn mạnh khỏe và vui với nghề.' },
  { id: 2, title: 'Cô', name: 'Trần Thị Lan', subject: 'Tin học', department: 'Tổ Toán - Tin', layout: 'spring', message: 'Cảm ơn cô đã mở cho chúng em cánh cửa công nghệ. Chúc cô một ngày 20/11 thật ấm áp.' },
  { id: 3, title: 'Thầy', name: 'Lê Minh Tuấn', subject: 'Vật Lý', department: 'Tổ Lý - Hóa - Sinh', layout: 'night', message: 'Nhờ thầy, những định luật khô khan trở nên gần gũi. Chúc thầy luôn dồi dào sức khỏe.' },
  { id: 4, title: 'Cô', name: 'Phạm Thị Hoa', subject: 'Hóa học', department: 'Tổ Lý - Hóa - Sinh', layout: 'lotus', message: 'Cảm ơn cô vì những giờ Hóa đầy thú vị. Chúc cô luôn hạnh phúc và bình an.' },
  { id: 5, title: 'Cô', name: 'Nguyễn Thị Mai', subject: 'Sinh học', department: 'Tổ Lý - Hóa - Sinh', layout: 'spring', message: 'Cô đã dạy chúng em yêu sự sống quanh mình. Kính chúc cô sức khỏe và niềm vui.' },
  { id: 6, title: 'Thầy', name: 'Hoàng Đức Vinh', subject: 'Ngữ văn', department: 'Tổ Văn - Sử - Địa', layout: 'classic', message: 'Cảm ơn thầy đã dạy chúng em biết cảm nhận từng trang văn. Chúc thầy luôn an vui.' },
  { id: 7, title: 'Cô', name: 'Vũ Thị Thu', subject: 'Lịch sử', department: 'Tổ Văn - Sử - Địa', layout: 'lotus', message: 'Nhờ cô, mỗi trang sử đều sống động. Kính chúc cô ngày 20/11 thật nhiều niềm vui.' },
  { id: 8, title: 'Cô', name: 'Đinh Thị Phương', subject: 'Địa lý', department: 'Tổ Văn - Sử - Địa', layout: 'minimal', message: 'Cảm ơn cô đã cho chúng em thấy thế giới rộng lớn. Chúc cô luôn khỏe và hạnh phúc.' },
  { id: 9, title: 'Thầy', name: 'Bùi Quang Huy', subject: 'Tiếng Anh', department: 'Tổ Ngoại ngữ', layout: 'spring', message: 'Thank you, teacher! Cảm ơn thầy đã giúp chúng em tự tin nói tiếng Anh. Chúc thầy luôn vui.' },
  { id: 10, title: 'Cô', name: 'Lý Thị Kim Anh', subject: 'Tiếng Anh', department: 'Tổ Ngoại ngữ', layout: 'lotus', message: 'Cảm ơn cô đã là cầu nối đưa chúng em đến với thế giới. Kính chúc cô sức khỏe.' },
  { id: 11, title: 'Thầy', name: 'Đặng Văn Hải', subject: 'Thể dục', department: 'Tổ Thể dục - GDQP', layout: 'night', message: 'Cảm ơn thầy đã truyền cho chúng em tinh thần thể thao. Chúc thầy luôn khỏe mạnh.' },
  { id: 12, title: 'Cô', name: 'Phan Thị Thảo', subject: 'GDQP', department: 'Tổ Thể dục - GDQP', layout: 'minimal', message: 'Cảm ơn cô đã dạy chúng em lòng yêu nước và kỷ luật. Kính chúc cô an vui.' },
]

/** Wish body templates with {Thầy/Cô}, {tên}, {môn} placeholders. */
export const WISH_TEMPLATES = [
  'Kính chúc {Thầy/Cô} {tên} luôn dồi dào sức khỏe, hạnh phúc và tiếp tục là ngọn đèn sáng dẫn đường cho chúng em.',
  'Em xin gửi lời tri ân sâu sắc đến {Thầy/Cô} {tên}. Nhờ {thầy/cô} mà em yêu môn {môn} hơn rất nhiều.',
  'Chúc {Thầy/Cô} {tên} có một ngày 20/11 thật ý nghĩa, tràn đầy niềm vui bên gia đình và học trò.',
  'Những bài giảng của {Thầy/Cô} {tên} sẽ mãi là hành trang quý báu theo em suốt cuộc đời.',
  'Em cảm ơn {Thầy/Cô} {tên} đã luôn kiên nhẫn và tận tâm với chúng em. Chúc {thầy/cô} mãi mãi hạnh phúc!',
  'Kính chúc {Thầy/Cô} {tên} có nhiều sức khoẻ để tiếp tục cống hiến cho sự nghiệp trồng người cao quý.',
]

function filled(tplIdx: number, t: Teacher): string {
  return fillWish(WISH_TEMPLATES[tplIdx], { name: t.name, subject: t.subject, title: t.title })
}

const T = TEACHERS

export const NOTES: Note[] = [
  // Teacher 1 — Thầy Khoa
  { id: 1, teacherId: 1, text: filled(0, T[0]), displayName: 'Minh Anh', className: '11A1', relativeTime: '2 giờ trước', status: 'approved' },
  { id: 2, teacherId: 1, text: filled(3, T[0]), displayName: null, className: '12A5', relativeTime: '5 giờ trước', status: 'approved' },
  { id: 3, teacherId: 1, text: 'Thầy Khoa là người thầy tuyệt vời nhất! Em sẽ nhớ mãi những giờ Toán vui vẻ.', displayName: 'Trung Kiên', className: '11A3', relativeTime: '1 ngày trước', status: 'approved' },
  // Teacher 2 — Cô Lan
  { id: 4, teacherId: 2, text: filled(1, T[1]), displayName: 'Hà Linh', className: '10A2', relativeTime: '3 giờ trước', status: 'approved' },
  { id: 5, teacherId: 2, text: 'Nhờ có cô Lan mà em biết lập trình. Em yêu môn Tin từ đó!', displayName: 'Phúc Bảo', className: '11A2', relativeTime: '1 ngày trước', status: 'approved' },
  // Teacher 3 — Thầy Tuấn
  { id: 6, teacherId: 3, text: filled(4, T[2]), displayName: null, className: '12A1', relativeTime: '4 giờ trước', status: 'approved' },
  { id: 7, teacherId: 3, text: 'Thầy Tuấn giảng bài rất hay và dễ hiểu. Chúc thầy luôn vui và khỏe!', displayName: 'Ngọc Hân', className: '12A3', relativeTime: '6 giờ trước', status: 'approved' },
  // Teacher 4 — Cô Hoa
  { id: 8, teacherId: 4, text: filled(0, T[3]), displayName: 'Gia Bảo', className: '11A4', relativeTime: '2 giờ trước', status: 'approved' },
  { id: 9, teacherId: 4, text: 'Cô Hoa dạy Hóa rất dễ hiểu. Nhờ cô mà em vượt qua kỳ thi.', displayName: null, className: '12A2', relativeTime: '1 ngày trước', status: 'approved' },
  // Teacher 5 — Cô Mai
  { id: 10, teacherId: 5, text: filled(2, T[4]), displayName: 'Thu Trang', className: '10A1', relativeTime: '5 giờ trước', status: 'approved' },
  { id: 11, teacherId: 5, text: 'Cô Mai là người thầy truyền cảm hứng. Nhờ cô mà em yêu thích nghiên cứu sinh học!', displayName: 'Khánh Linh', className: '12A2', relativeTime: '4 giờ trước', status: 'approved' },
  // Teacher 6 — Thầy Vinh
  { id: 12, teacherId: 6, text: filled(3, T[5]), displayName: 'Lê Phương', className: '11A5', relativeTime: '7 giờ trước', status: 'approved' },
  { id: 13, teacherId: 6, text: 'Thầy Vinh dạy văn hay như kể chuyện. Em nhớ mãi tiết học về thơ Xuân Quỳnh.', displayName: 'Minh Khôi', className: '12A4', relativeTime: '1 ngày trước', status: 'approved' },
  // Teacher 7 — Cô Thu
  { id: 14, teacherId: 7, text: filled(1, T[6]), displayName: null, className: '11A2', relativeTime: '3 giờ trước', status: 'approved' },
  // Teacher 8 — Cô Phương
  { id: 15, teacherId: 8, text: filled(5, T[7]), displayName: 'Hải Nam', className: '10A3', relativeTime: '8 giờ trước', status: 'approved' },
  // Teacher 9 — Thầy Huy
  { id: 16, teacherId: 9, text: filled(0, T[8]), displayName: 'Bích Ngọc', className: '11A1', relativeTime: '1 giờ trước', status: 'approved' },
  { id: 17, teacherId: 9, text: 'Thank you teacher Huy for making English class so fun and engaging!', displayName: 'Việt Anh', className: '12A5', relativeTime: '4 giờ trước', status: 'approved' },
  // Teacher 10 — Cô Kim Anh
  { id: 18, teacherId: 10, text: filled(2, T[9]), displayName: null, className: '10A4', relativeTime: '6 giờ trước', status: 'approved' },
  { id: 19, teacherId: 10, text: filled(4, T[9]), displayName: 'Minh Tâm', className: '11A2', relativeTime: '5 giờ trước', status: 'approved' },
  // Teacher 11 — Thầy Hải
  { id: 20, teacherId: 11, text: filled(4, T[10]), displayName: 'Quốc Bảo', className: '11A3', relativeTime: '2 giờ trước', status: 'approved' },
  // Teacher 12 — Cô Thảo
  { id: 21, teacherId: 12, text: filled(5, T[11]), displayName: 'Minh Nhật', className: '12A1', relativeTime: '3 giờ trước', status: 'approved' },
  { id: 22, teacherId: 12, text: 'Cô Thảo dạy GDQP rất nghiêm túc nhưng cũng rất tâm lý với học sinh.', displayName: null, className: '10A5', relativeTime: '2 giờ trước', status: 'approved' },
  // Pending notes
  { id: 23, teacherId: 1, text: 'Thầy là người thầy tuyệt vời! Chúc thầy năm mới vui vẻ hạnh phúc bên gia đình.', displayName: 'Hoàng Long', className: '10A5', relativeTime: '30 phút trước', status: 'pending' },
  { id: 24, teacherId: 2, text: filled(3, T[1]), displayName: null, className: '11A4', relativeTime: '45 phút trước', status: 'pending' },
  { id: 25, teacherId: 4, text: 'Cô ơi, cô dạy Hóa rất hay và vui. Em chúc cô 20/11 hạnh phúc và sức khỏe!', displayName: 'Thanh Thư', className: '11A1', relativeTime: '1 giờ trước', status: 'pending' },
  { id: 26, teacherId: 6, text: filled(0, T[5]), displayName: 'Yến Nhi', className: '10A2', relativeTime: '20 phút trước', status: 'pending' },
  { id: 27, teacherId: 9, text: 'Thầy Huy dạy tiếng Anh rất nhiệt tình. Chúc thầy mạnh khỏe và hạnh phúc!', displayName: null, className: '12A3', relativeTime: '15 phút trước', status: 'pending' },
  { id: 28, teacherId: 11, text: 'Chúc thầy Hải luôn khoẻ mạnh và tiếp tục truyền cảm hứng thể thao cho bọn em!', displayName: 'Trọng Khải', className: '11A5', relativeTime: '10 phút trước', status: 'pending' },
  // Hidden notes
  { id: 29, teacherId: 3, text: 'Chúc thầy luôn vui vẻ và hạnh phúc!', displayName: 'Ẩn danh', className: '10A1', relativeTime: '2 ngày trước', status: 'hidden' },
  { id: 30, teacherId: 7, text: 'Cô Thu giảng lịch sử rất hay. Em thích nhất tiết học về thời đại Hùng Vương.', displayName: 'Việt Khôi', className: '11A3', relativeTime: '1 ngày trước', status: 'hidden' },
]

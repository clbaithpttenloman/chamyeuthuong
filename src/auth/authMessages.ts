/**
 * Vietnamese messages for account errors (ADR-9). Keys are the server's error codes.
 * Unknown codes fall back to a generic message, so a new server code never shows raw text.
 */
import { ApiError } from '../api'

export const AUTH_MESSAGES: Record<string, string> = {
  username_invalid: 'Tên đăng nhập chỉ gồm 3–20 ký tự: chữ thường a–z, số hoặc dấu gạch dưới (_).',
  username_reserved: 'Tên đăng nhập này không được dùng.',
  username_taken: 'Tên đăng nhập này đã có người dùng.',
  password_invalid: 'Mật khẩu không hợp lệ.',
  password_too_short: 'Mật khẩu cần ít nhất 8 ký tự.',
  password_too_long: 'Mật khẩu tối đa 128 ký tự.',
  password_contains_username: 'Mật khẩu không được chứa tên đăng nhập.',
  password_common: 'Mật khẩu quá phổ biến, hãy chọn mật khẩu khác.',
  invalid_credentials:
    'Sai tên đăng nhập hoặc mật khẩu. Nếu đã nhập sai nhiều lần, hãy chờ 15 phút hoặc nhờ quản trị viên đặt lại mật khẩu.',
  rate_limited: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.',
  register_limit: 'Hôm nay đã đủ lượt đăng ký, vui lòng thử lại vào ngày mai.',
  banned: 'Tài khoản này đã bị khóa.',
  misconfigured: 'Hệ thống chưa sẵn sàng, vui lòng thử lại sau.',
  password_change_required: 'Bạn cần đổi mật khẩu trước khi tiếp tục.',
  forbidden: 'Yêu cầu không hợp lệ, vui lòng tải lại trang.',
  bad_request: 'Thông tin chưa đúng, vui lòng kiểm tra lại.',
  too_long: 'Dữ liệu quá lớn.',
  unavailable: 'Có lỗi xảy ra, vui lòng thử lại.',
}

const GENERIC = 'Có lỗi xảy ra, vui lòng thử lại.'

/** Message for any error thrown by the account API calls. */
export function authMessage(e: unknown): string {
  if (e instanceof ApiError) return AUTH_MESSAGES[e.code] ?? GENERIC
  return 'Lỗi kết nối, vui lòng thử lại.'
}

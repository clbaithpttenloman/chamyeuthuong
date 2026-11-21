/**
 * src/game/errors.ts — Vietnamese user-facing messages for every API error code
 * returned by worker/gifts.ts, worker/tree.ts, and worker/me.ts.
 *
 * Usage: errorMessage('campaign_closed') → 'Chiến dịch đã kết thúc.'
 */

export const ERROR_MESSAGES: Record<string, string> = {
  // ── Gift / heart errors (ADR-7, AC-12) ────────────────────────────────
  gift_not_found:    'Không tìm thấy quà.',
  already_hearted:   'Bạn đã thả tim cho quà này rồi.',
  own_gift:          'Không thể thả tim cho quà của chính mình.',
  hearts_exhausted:  'Bạn đã dùng hết tim hôm nay — quay lại vào ngày mai nhé!',

  // ── Campaign errors (AC-3, AC-15, FR-6) ───────────────────────────────
  campaign_closed:   'Chiến dịch đã kết thúc.',

  // ── User / account errors (ADR-8) ─────────────────────────────────────
  banned:            'Tài khoản của bạn đã bị khoá.',
  already_reported:  'Bạn đã báo cáo quà này rồi.',
  pending_review:    'Quà đang chờ kiểm duyệt, không thể thực hiện thao tác này.',

  // ── Gift creation errors (AC-10, FR-19) ───────────────────────────────
  limit_reached:     'Bạn đã tạo đủ số quà cho phép trong chiến dịch này.',
  daily_limit:       'Bạn đã tạo quá nhiều quà hôm nay — thử lại vào ngày mai.',

  // ── Report errors ─────────────────────────────────────────────────────────
  reports_exhausted: 'Bạn đã báo cáo quá nhiều hôm nay — thử lại vào ngày mai.',
  owner_banned:      'Không thể khôi phục quà: tài khoản chủ sở hữu đang bị khoá.',

  // ── Generic HTTP errors ────────────────────────────────────────────────
  rate_limited:      'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
  bad_request:       'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.',
  unauthorized:      'Vui lòng đăng nhập để tiếp tục.',
  forbidden:         'Bạn không có quyền thực hiện thao tác này.',
  not_found:         'Không tìm thấy.',
  misconfigured:     'Lỗi cấu hình máy chủ. Vui lòng liên hệ quản trị viên.',
  method:            'Phương thức không được hỗ trợ.',
}

/**
 * Returns the Vietnamese message for an API error code.
 * Falls back to a generic error message for unknown codes.
 */
export function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Đã có lỗi xảy ra. Vui lòng thử lại.'
}

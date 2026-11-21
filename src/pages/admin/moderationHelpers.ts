/**
 * src/pages/admin/moderationHelpers.ts — pure logic helpers for gift moderation (Phase 2).
 *
 * Action availability by status, confirm texts, error map, status labels.
 * No DOM, no React, no side effects — fully unit-testable.
 * All UI text is Vietnamese.
 */

export type GiftStatus = 'visible' | 'hidden_auto' | 'hidden_admin' | 'deleted'
export type GiftModerationAction = 'restore' | 'hide' | 'delete'
export type UserModerationAction = 'ban' | 'unban'

/**
 * Which moderation actions are available for a gift in the given status.
 *
 * Rules (ADR-8):
 *   restore — when the gift is not visible (it has been hidden by reports or admin)
 *   hide    — when the gift is visible (admin hide) or hidden_auto (admin can re-hide)
 *             hidden_admin gifts have already been explicitly hidden, so "hide" is a no-op
 *   delete  — always available except when already deleted
 */
export function availableGiftActions(status: GiftStatus): GiftModerationAction[] {
  const actions: GiftModerationAction[] = []
  if (status !== 'visible') actions.push('restore')
  if (status === 'visible' || status === 'hidden_auto') actions.push('hide')
  if (status !== 'deleted') actions.push('delete')
  return actions
}

/**
 * Confirm text for a gift moderation action.
 * Describes the consequence so the admin is fully informed before confirming.
 */
export function giftActionConfirmText(action: GiftModerationAction): string {
  switch (action) {
    case 'restore':
      return 'Khôi phục quà này? Quà sẽ hiển thị lại trên cây và báo cáo cũ sẽ được đánh dấu đã xem xét.'
    case 'hide':
      return 'Ẩn quà này? Quà sẽ bị ẩn khỏi cây và không còn hiển thị với người dùng.'
    case 'delete':
      return 'Xoá vĩnh viễn quà này? Hành động không thể hoàn tác.'
  }
}

/**
 * Confirm text for banning or unbanning a user.
 * Describes consequences: ban hides all gifts and removes hearts; unban restores gifts but NOT hearts.
 */
export function userActionConfirmText(action: UserModerationAction): string {
  switch (action) {
    case 'ban':
      return 'Khoá người dùng này? Toàn bộ quà đang hiển thị của họ sẽ bị ẩn, tim sẽ bị xoá và phiên đăng nhập sẽ bị thu hồi.'
    case 'unban':
      return 'Mở khoá người dùng này? Các quà đã ẩn do bị khoá sẽ được khôi phục. Tim không được hoàn lại.'
  }
}

/**
 * Map an HTTP error (status + code) to a Vietnamese message shown in the UI.
 *
 * 401 — typed-email sessions cannot moderate gifts (Google session required per ADR-8).
 *       Returns a specific hint to sign in with Google.
 */
export function giftModerationErrorMessage(status: number, code: string): string {
  if (status === 401) {
    return 'Kiểm duyệt quà yêu cầu đăng nhập bằng Google. Vui lòng đăng nhập bằng Google ở phần đăng nhập trên.'
  }
  if (status === 403) return 'Không có quyền thực hiện thao tác này.'
  if (status === 404) return 'Không tìm thấy quà hoặc người dùng.'
  if (status === 429) return 'Quá nhiều yêu cầu. Vui lòng thử lại sau.'
  return ERROR_CODE_MESSAGES[code] ?? 'Lỗi kết nối, vui lòng thử lại.'
}

/** Vietnamese messages for specific API error codes. */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  bad_request: 'Yêu cầu không hợp lệ.',
  not_found: 'Không tìm thấy dữ liệu.',
  forbidden: 'Không có quyền thực hiện thao tác này.',
  conflict: 'Thao tác xung đột, hãy tải lại trang.',
  unavailable: 'Dịch vụ tạm thời không khả dụng. Thử lại sau.',
}

/** Vietnamese label for a gift status. Shown in the UI badge next to each gift. */
export function giftStatusLabel(status: GiftStatus): string {
  switch (status) {
    case 'visible': return 'Hiển thị'
    case 'hidden_auto': return 'Ẩn tự động'
    case 'hidden_admin': return 'Ẩn bởi quản trị'
    case 'deleted': return 'Đã xoá'
  }
}

/** "2 không phù hợp, 1 spam" — reasons with a count of 0 are left out; "" when none. */
export function reportReasonsText(r: { inappropriate: number; spam: number; other: number } | undefined): string {
  if (!r) return ''
  const parts: string[] = []
  if (r.inappropriate) parts.push(`${r.inappropriate} không phù hợp`)
  if (r.spam) parts.push(`${r.spam} spam`)
  if (r.other) parts.push(`${r.other} lý do khác`)
  return parts.join(', ')
}

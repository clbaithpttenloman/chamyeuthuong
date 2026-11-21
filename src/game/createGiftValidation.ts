/**
 * src/game/createGiftValidation.ts — pure step-validation for the CreateGift dialog.
 *
 * No DOM, no React — unit-testable.
 * Text validation delegates to validateGiftText from shared/gift.ts so the same
 * rules (NFC + trim, code-point lengths, control/bidi/surrogate rejection) apply
 * on both client and server.
 */
import { LAYOUTS } from '../../shared/layouts.ts'
import { FONTS, isInkInput } from '../../shared/fonts.ts'
import { validateGiftText } from '../../shared/gift.ts'

export type StepError = string | null

/** True if the box-style value is valid (1–6 integer). */
export function validateBox(boxStyle: unknown): StepError {
  if (
    typeof boxStyle !== 'number' ||
    !Number.isInteger(boxStyle) ||
    boxStyle < 1 ||
    boxStyle > 6
  ) {
    return 'Chọn kiểu hộp quà.'
  }
  return null
}

/** True if the ornament-style value is valid (1–6 integer). */
export function validateOrnament(ornamentStyle: unknown): StepError {
  if (
    typeof ornamentStyle !== 'number' ||
    !Number.isInteger(ornamentStyle) ||
    ornamentStyle < 1 ||
    ornamentStyle > 6
  ) {
    return 'Chọn kiểu vật trang trí.'
  }
  return null
}

/**
 * Validates all card-editor fields in one call (layout, background, font, ink, message).
 *
 * Message validation uses validateGiftText from shared/gift.ts (NFC + trim,
 * code-point length, control/bidi/surrogate rejection) — the same rules as the server.
 *
 * @param availableTemplateIds  When provided, the backgroundTemplateId must be present
 *                              in this list. This catches the case where the user's
 *                              selected template was removed while they were on the step.
 */
export function validateCard(params: {
  layout: string | null
  backgroundTemplateId: number | null
  font: string | null
  ink: string | null
  message: string
  availableTemplateIds?: ReadonlyArray<number>
}): StepError {
  if (!params.layout || !LAYOUTS.some((l) => l.id === params.layout)) return 'Chọn kiểu bố cục.'
  if (!params.backgroundTemplateId) return 'Chọn ảnh nền cho thiệp.'
  if (
    params.availableTemplateIds !== undefined &&
    params.availableTemplateIds.length > 0 &&
    !params.availableTemplateIds.includes(params.backgroundTemplateId)
  ) {
    return 'Ảnh nền đã chọn không còn khả dụng. Vui lòng chọn lại.'
  }
  if (!params.font || !FONTS.some((f) => f.id === params.font)) return 'Chọn font chữ.'
  if (!params.ink || !isInkInput(params.ink)) return 'Chọn màu mực.'

  // Message validation: delegate to shared/gift.ts for identical rules to server
  // (NFC + trim, code-point length, control/bidi/surrogate).
  // We pass a dummy nickname/className — only the message field is checked here.
  const textResult = validateGiftText({ message: params.message, nickname: 'x', className: '' })
  if (!textResult.ok && textResult.field === 'message') {
    if (!params.message.normalize('NFC').trim()) return 'Nhập lời chúc (1–300 ký tự).'
    return 'Lời chúc tối đa 300 ký tự hoặc chứa ký tự không hợp lệ.'
  }

  return null
}

/**
 * Validates the name fields (nickname 1–30 code points, className 0–10 code points).
 *
 * Uses validateGiftText from shared/gift.ts so rules are identical to the server:
 * NFC + trim, code-point counting, control/bidi/surrogate rejection.
 */
export function validateName(params: { nickname: string; className: string }): StepError {
  // Build a minimal message placeholder so validateGiftText can run
  const result = validateGiftText({
    message: 'placeholder',
    nickname: params.nickname,
    className: params.className,
  })
  if (!result.ok) {
    switch (result.field) {
      case 'nickname': {
        const trimmed = params.nickname.normalize('NFC').trim()
        if (!trimmed) return 'Nhập tên hiển thị.'
        if ([...trimmed].length > 30) return 'Tên tối đa 30 ký tự.'
        return 'Tên chứa ký tự không hợp lệ.'
      }
      case 'className': {
        const trimmed = params.className.normalize('NFC').trim()
        if ([...trimmed].length > 10) return 'Lớp tối đa 10 ký tự.'
        return 'Lớp chứa ký tự không hợp lệ.'
      }
      default:
        return 'Thông tin không hợp lệ.'
    }
  }
  return null
}

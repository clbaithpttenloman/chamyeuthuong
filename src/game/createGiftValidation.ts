/**
 * src/game/createGiftValidation.ts — pure step-validation for the CreateGift dialog.
 *
 * No DOM, no React — unit-testable.
 * Mirrors the server-side checks in worker/gifts.ts so the UI can give
 * immediate inline feedback before hitting the API.
 */
import { LAYOUTS } from '../../shared/layouts.ts'
import { FONTS, isInkInput } from '../../shared/fonts.ts'

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

/** Validates all card-editor fields in one call (layout, background, font, ink, message). */
export function validateCard(params: {
  layout: string | null
  backgroundTemplateId: number | null
  font: string | null
  ink: string | null
  message: string
}): StepError {
  if (!params.layout || !LAYOUTS.some((l) => l.id === params.layout)) return 'Chọn kiểu bố cục.'
  if (!params.backgroundTemplateId) return 'Chọn ảnh nền cho thiệp.'
  if (!params.font || !FONTS.some((f) => f.id === params.font)) return 'Chọn font chữ.'
  if (!params.ink || !isInkInput(params.ink)) return 'Chọn màu mực.'
  if (!params.message || params.message.length === 0) return 'Nhập lời chúc (1–300 ký tự).'
  if (params.message.length > 300) return 'Lời chúc tối đa 300 ký tự.'
  return null
}

/** Validates the name fields (nickname 1–30, className 0–10 codepoints). */
export function validateName(params: { nickname: string; className: string }): StepError {
  if (!params.nickname || params.nickname.trim().length === 0) return 'Nhập tên hiển thị.'
  if ([...params.nickname].length > 30) return 'Tên tối đa 30 ký tự.'
  if ([...params.className].length > 10) return 'Lớp tối đa 10 ký tự.'
  return null
}

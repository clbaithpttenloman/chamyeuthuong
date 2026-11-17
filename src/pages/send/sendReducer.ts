/**
 * Pure reducer for the 4-step card-sending flow.
 *
 * Steps:
 *   1 — Chọn mẫu thiệp
 *   2 — Chọn thầy cô  (skipped when preselectedTeacherId is set)
 *   3 — Viết lời chúc
 *   4 — Đã gửi (pending)
 *
 * Network calls happen in the component; this module contains only
 * deterministic state transitions.
 */
import { MAX_FROM_CLASS, MAX_FROM_NAME, MAX_MESSAGE, MAX_NEWLINES } from '../../../shared/api.ts'

export type SendStep = 1 | 2 | 3 | 4

export type SendState = {
  step: SendStep
  templateId: number | null
  teacherPublicId: string | null
  /** Set from ?thay query param; null if not provided. */
  preselectedTeacherId: string | null
  text: string
  fromName: string
  fromClass: string
  /** "Gửi ẩn danh" — ON by default per plan. */
  anonymous: boolean
  error: string | null
}

export type SendAction =
  | { type: 'SELECT_TEMPLATE'; templateId: number }
  | { type: 'SELECT_TEACHER'; publicId: string }
  | { type: 'SET_TEXT'; text: string }
  | { type: 'SET_FROM_NAME'; name: string }
  | { type: 'SET_FROM_CLASS'; cls: string }
  | { type: 'SET_ANONYMOUS'; anonymous: boolean }
  | { type: 'GO_BACK' }
  | { type: 'SUBMIT_SUCCESS' }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' }

export function initialState(preselectedTeacherId: string | null): SendState {
  return {
    step: 1,
    templateId: null,
    teacherPublicId: preselectedTeacherId,
    preselectedTeacherId,
    text: '',
    fromName: '',
    fromClass: '',
    anonymous: true,  // "Gửi ẩn danh" ON by default
    error: null,
  }
}

/** Returns true when the current text passes all constraints. */
export function isTextValid(text: string): boolean {
  if (!text.trim()) return false  // empty or whitespace-only after trim
  const cp = [...text].length
  if (cp > MAX_MESSAGE) return false
  const newlines = (text.match(/\n/g) ?? []).length
  return newlines <= MAX_NEWLINES
}

export function sendReducer(state: SendState, action: SendAction): SendState {
  switch (action.type) {
    case 'SELECT_TEMPLATE': {
      // Skip teacher step when a teacher was preselected via ?thay
      const nextStep: SendStep = state.preselectedTeacherId !== null ? 3 : 2
      return { ...state, templateId: action.templateId, step: nextStep, error: null }
    }

    case 'SELECT_TEACHER':
      return { ...state, teacherPublicId: action.publicId, step: 3, error: null }

    case 'SET_TEXT': {
      // Clamp to MAX_MESSAGE code points; preserve up to MAX_NEWLINES newlines
      const clamped = [...action.text].slice(0, MAX_MESSAGE).join('')
      // Count newlines in the clamped text and hard-clamp if over limit
      const lines = clamped.split('\n')
      const trimmed = lines.slice(0, MAX_NEWLINES + 1).join('\n')
      return { ...state, text: trimmed, error: null }
    }

    case 'SET_FROM_NAME': {
      const clamped = [...action.name].slice(0, MAX_FROM_NAME).join('')
      return { ...state, fromName: clamped }
    }

    case 'SET_FROM_CLASS': {
      const clamped = [...action.cls].slice(0, MAX_FROM_CLASS).join('')
      return { ...state, fromClass: clamped }
    }

    case 'SET_ANONYMOUS':
      return { ...state, anonymous: action.anonymous }

    case 'GO_BACK': {
      if (state.step === 2) return { ...state, step: 1, error: null }
      if (state.step === 3) {
        // If teacher was preselected, go back to template picker (step 1)
        // Otherwise go back to teacher picker (step 2)
        const prev: SendStep = state.preselectedTeacherId !== null ? 1 : 2
        return { ...state, step: prev, error: null }
      }
      return state
    }

    case 'SUBMIT_SUCCESS':
      return { ...state, step: 4, error: null }

    case 'SET_ERROR':
      return { ...state, error: action.error }

    case 'RESET':
      return initialState(null)

    default:
      return state
  }
}

/**
 * CreateGift — multi-step dialog to create a Noel gift (FR-19, AC-10).
 *
 * Steps:
 *   box       → choose gift-box style (1–6)
 *   ornament  → choose ornament style (1–6)
 *   card      → card editor (layout, background template, font, ink, message 1–300)
 *   name      → nickname (1–30) + class (≤ 10); pre-filled from profile
 *   preview   → CardView with giftToCardViewProps mapping
 *   wrap      → "Gói quà" animation while API call runs
 *   success   → auto-close, parent refreshes tree and focuses new gift
 *
 * Shows:
 *   - Remaining gift quota: "Bạn còn N/M quà" in the header
 *   - Every server error via errors.ts
 *   - Closed campaign → disabled with reason
 *   - Signed out → sign-in prompt (in-app browsers get the guide)
 *
 * Accessibility (NFR-4):
 *   - role="dialog" aria-modal="true" labelled by step title
 *   - Esc key closes
 *   - Focus trapped; returned to trigger on close
 *   - prefers-reduced-motion: fade-only wrap, no scale bounce
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import CardView from '../components/CardView.tsx'
import { DEFAULT_THEME_URLS } from './defaultTheme.ts'
import { giftToCardViewProps } from './giftHelpers.ts'
import { errorMessage } from './errors.ts'
import {
  createGift,
  updateMe,
  ApiError,
  type MeUser,
  type NoelTemplate,
} from '../api.ts'
import {
  validateBox,
  validateOrnament,
  validateCard,
  validateName,
} from './createGiftValidation.ts'
import { LAYOUTS } from '../../shared/layouts.ts'
import { FONTS, INKS, DEFAULT_FONT, DEFAULT_INK } from '../../shared/fonts.ts'
import site from '../content/site.json'
import { useDialog } from './useDialog.ts'

// InAppBrowserGuide is lazy to avoid loading it in normal flows
const InAppBrowserGuide = lazy(() => import('./InAppBrowserGuide.tsx'))

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'box' | 'ornament' | 'card' | 'name' | 'preview' | 'wrap' | 'success'

interface Draft {
  boxStyle: number | null
  ornamentStyle: number | null
  layout: string
  backgroundTemplateId: number | null
  font: string
  ink: string
  message: string
  nickname: string
  className: string
}

export interface CreateGiftProps {
  slug: string
  campaignName: string
  campaignOpen: boolean
  /** Reason campaign is closed (for the disabled banner). */
  closedReason?: string
  user: MeUser | null
  /** Number of non-deleted gifts the user already has. */
  myGiftCount: number
  /** Maximum gifts per user from campaign settings. */
  giftsPerUser: number
  templates: ReadonlyArray<NoelTemplate>
  /** True when the template fetch failed (shows an error with a retry button). */
  templatesLoadError?: boolean
  /** True once the template list has loaded, even when it is empty. */
  templatesReady?: boolean
  /** Called to retry loading templates. */
  onRetryTemplates?: () => void
  /** Whether the user is using an in-app browser. */
  isInApp: boolean
  onSignIn: () => void
  /**
   * Called on successful gift creation.
   * Parent should: close dialog, force a tree refresh, open the new gift.
   */
  onSuccess: (publicId: string) => void
  /**
   * Called when the user completes onboarding (saves profile).
   * Parent updates its user state.
   */
  onUserUpdated?: (nickname: string, className: string) => void
  onClose: () => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

const STEP_TITLES: Record<Step, string> = {
  box: 'Chọn hộp quà',
  ornament: 'Chọn vật trang trí',
  card: 'Viết lời chúc',
  name: 'Tên của bạn',
  preview: 'Xem trước',
  wrap: 'Đang gói quà…',
  success: 'Đã treo quà! 🎁',
}

const WIZARD_STEPS: Step[] = ['box', 'ornament', 'card', 'name', 'preview']

// ── Component ─────────────────────────────────────────────────────────────────

export default function CreateGift({
  slug,
  campaignName,
  campaignOpen,
  closedReason,
  user,
  myGiftCount,
  giftsPerUser,
  templates,
  templatesLoadError,
  templatesReady = false,
  onRetryTemplates,
  isInApp,
  onSignIn,
  onSuccess,
  onUserUpdated,
  onClose,
  returnFocusRef,
}: CreateGiftProps): ReactNode {
  const reduced = prefersReducedMotion()
  const dialogRef = useRef<HTMLDivElement>(null)
  const wrapBoxRef = useRef<HTMLDivElement>(null)
  const titleId = 'create-gift-title'

  // onClose ref so the focus-trap effect runs once (not on every parent render)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  // Focus trap + Esc, runs once on mount
  useDialog({ dialogRef, onCloseRef, returnFocusRef })

  // ── Draft state ───────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>(() => {
    // If limit reached, start on a "disabled" view
    if (!campaignOpen) return 'box'
    if (myGiftCount >= giftsPerUser) return 'box'
    return 'box'
  })

  const [draft, setDraft] = useState<Draft>({
    boxStyle: null,
    ornamentStyle: null,
    layout: 'doc-giua',
    backgroundTemplateId: templates.length > 0 ? templates[0]!.id : null,
    font: DEFAULT_FONT,
    ink: DEFAULT_INK,
    message: '',
    nickname: user?.nickname ?? '',
    className: user?.className ?? '',
  })

  const [stepError, setStepError] = useState<string | null>(null)
  const [wrapError, setWrapError] = useState<string | null>(null)

  // Update prefill when user changes (e.g. after sign-in)
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      nickname: d.nickname || user?.nickname || '',
      className: d.className || user?.className || '',
    }))
  }, [user?.nickname, user?.className])

  // Update default template when templates load
  useEffect(() => {
    if (templates.length > 0 && !draft.backgroundTemplateId) {
      setDraft((d) => ({ ...d, backgroundTemplateId: templates[0]!.id }))
    }
  }, [templates]) // eslint-disable-line react-hooks/exhaustive-deps

  const needsOnboarding = !user?.nickname

  // ── Wrap animation ────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'wrap') return
    const el = wrapBoxRef.current
    if (!el || reduced) return
    el.animate(
      [
        { transform: 'scale(0.8) rotate(-5deg)', opacity: 0.5 },
        { transform: 'scale(1.3) rotate(5deg)', opacity: 1 },
        { transform: 'scale(1.0) rotate(0deg)', opacity: 1 },
      ],
      { duration: 700, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', fill: 'forwards', iterations: 1 },
    )
  }, [step, reduced])

  // ── Navigation helpers ────────────────────────────────────────────────
  const goBack = useCallback(() => {
    setStepError(null)
    setWrapError(null)
    setStep((s) => {
      const idx = WIZARD_STEPS.indexOf(s)
      return idx > 0 ? WIZARD_STEPS[idx - 1]! : s
    })
  }, [])

  const validateAndAdvance = useCallback(() => {
    setStepError(null)
    let err: string | null = null
    switch (step) {
      case 'box':      err = validateBox(draft.boxStyle); break
      case 'ornament': err = validateOrnament(draft.ornamentStyle); break
      case 'card':     err = validateCard({
        ...draft,
        availableTemplateIds: templates.length > 0 ? templates.map((t) => t.id) : undefined,
      }); break
      case 'name':     err = validateName(draft); break
      case 'preview':  break
    }
    if (err) { setStepError(err); return }
    const idx = WIZARD_STEPS.indexOf(step)
    if (idx < WIZARD_STEPS.length - 1) {
      setStep(WIZARD_STEPS[idx + 1]!)
    }
  }, [step, draft, templates])

  // ── Gift submission ───────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    // Final validation
    const nameErr = validateName(draft)
    if (nameErr) { setStepError(nameErr); setStep('name'); return }
    const cardErr = validateCard({
      ...draft,
      availableTemplateIds: templates.length > 0 ? templates.map((t) => t.id) : undefined,
    })
    if (cardErr) { setStepError(cardErr); setStep('card'); return }

    setStep('wrap')
    setWrapError(null)
    const start = Date.now()
    const MIN_MS = reduced ? 300 : 1400

    // Trim text fields before sending (matches server-side NFC + trim behaviour)
    const trimmedNickname = draft.nickname.normalize('NFC').trim()
    const trimmedClassName = draft.className.normalize('NFC').trim()
    const trimmedMessage = draft.message.normalize('NFC').trim()

    try {
      // Onboarding: save profile if nickname was blank
      if (needsOnboarding && trimmedNickname) {
        await updateMe(trimmedNickname, trimmedClassName)
        onUserUpdated?.(trimmedNickname, trimmedClassName)
      }

      const result = await createGift(slug, {
        boxStyle: draft.boxStyle!,
        ornamentStyle: draft.ornamentStyle!,
        layout: draft.layout,
        backgroundTemplateId: draft.backgroundTemplateId!,
        font: draft.font,
        ink: draft.ink,
        message: trimmedMessage,
        nickname: trimmedNickname,
        className: trimmedClassName,
      })

      // Ensure the wrap animation plays for at least MIN_MS
      const elapsed = Date.now() - start
      if (elapsed < MIN_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, MIN_MS - elapsed))
      }

      setStep('success')
      setTimeout(() => onSuccess(result.publicId), 1200)
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown'
      setWrapError(errorMessage(code))
      setStep('preview')
    }
  }, [slug, draft, templates, reduced, needsOnboarding, onUserUpdated, onSuccess])

  // ── Render helpers ────────────────────────────────────────────────────
  const remaining = giftsPerUser - myGiftCount
  const limitReached = remaining <= 0

  // Build preview card props from draft
  const previewTemplate = templates.find((t) => t.id === draft.backgroundTemplateId)
  const previewCardProps = giftToCardViewProps({
    gift: {
      publicId: 'preview',
      rank: 0,
      layout: draft.layout,
      font: draft.font,
      ink: draft.ink,
      message: draft.message || '…',
      nickname: draft.nickname || '(Tên của bạn)',
      className: draft.className,
      heartCount: 0,
      backgroundTemplateId: draft.backgroundTemplateId,
    },
    campaignName,
    backgroundToken: previewTemplate?.images.background ?? null,
    stamp: `${site.title} · Noel`,
  })

  const stepIdx = WIZARD_STEPS.indexOf(step)

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="noel-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="noel-dialog create-gift-dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="noel-dialog-header">
          <div className="create-gift-header-left">
            <h2 id={titleId} className="noel-dialog-title">
              {STEP_TITLES[step]}
            </h2>
            {user && step !== 'wrap' && step !== 'success' && (
              <span className="create-gift-quota">
                Bạn còn{' '}
                <strong>{Math.max(0, remaining)}</strong>/{giftsPerUser} quà
              </span>
            )}
          </div>
          <button
            type="button"
            className="noel-dialog-close"
            aria-label="Đóng"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* ── Signed-out state ─────────────────────────────────────── */}
        {!user && (
          <div className="create-gift-signin">
            {isInApp ? (
              <Suspense fallback={null}>
                <InAppBrowserGuide />
              </Suspense>
            ) : (
              <>
                <p>Đăng nhập để treo quà lên cây.</p>
                <button type="button" className="noel-action-btn" onClick={onSignIn}>
                  Đăng nhập
                </button>
              </>
            )}
          </div>
        )}

        {/* ── Campaign closed ───────────────────────────────────────── */}
        {user && !campaignOpen && (
          <div className="create-gift-closed" role="status">
            <p>{closedReason ?? 'Chiến dịch đã kết thúc.'}</p>
          </div>
        )}

        {/* ── Limit reached ─────────────────────────────────────────── */}
        {user && campaignOpen && limitReached && (
          <div className="create-gift-limit" role="status">
            <p>Bạn đã treo đủ {giftsPerUser} quà trong chiến dịch này.</p>
          </div>
        )}

        {/* ── Wizard steps (only when user is signed in, campaign open, limit not reached) */}
        {user && campaignOpen && !limitReached && (
          <>
            {/* Step indicator */}
            {stepIdx >= 0 && (
              <div
                className="create-gift-steps"
                aria-label={`Bước ${stepIdx + 1} / ${WIZARD_STEPS.length}`}
              >
                {WIZARD_STEPS.map((s, i) => (
                  <span
                    key={s}
                    className={
                      'create-gift-step-dot' +
                      (i === stepIdx ? ' create-gift-step-dot--active' : '') +
                      (i < stepIdx ? ' create-gift-step-dot--done' : '')
                    }
                    aria-hidden="true"
                  />
                ))}
              </div>
            )}

            {/* Error banner */}
            {(stepError || wrapError) && (
              <p className="create-gift-error" role="alert">
                {stepError ?? wrapError}
              </p>
            )}

            {/* ── Step: Box ────────────────────────────────────────── */}
            {step === 'box' && (
              <StylePicker
                label="Chọn kiểu hộp quà"
                count={6}
                selected={draft.boxStyle}
                urlFor={(i) =>
                  DEFAULT_THEME_URLS[`box_${i}_closed` as keyof typeof DEFAULT_THEME_URLS] ??
                  DEFAULT_THEME_URLS.box_1_closed
                }
                altFor={(i) => `Hộp quà ${i}`}
                onChange={(v) => setDraft((d) => ({ ...d, boxStyle: v }))}
              />
            )}

            {/* ── Step: Ornament ───────────────────────────────────── */}
            {step === 'ornament' && (
              <StylePicker
                label="Chọn kiểu trang trí"
                count={6}
                selected={draft.ornamentStyle}
                urlFor={(i) =>
                  DEFAULT_THEME_URLS[`ornament_${i}` as keyof typeof DEFAULT_THEME_URLS] ??
                  DEFAULT_THEME_URLS.ornament_1
                }
                altFor={(i) => `Vật trang trí ${i}`}
                onChange={(v) => setDraft((d) => ({ ...d, ornamentStyle: v }))}
              />
            )}

            {/* ── Step: Card editor ────────────────────────────────── */}
            {step === 'card' && (
              <CardEditor
                draft={draft}
                templates={templates}
                templatesLoadError={!!templatesLoadError}
                templatesReady={templatesReady}
                onRetryTemplates={onRetryTemplates}
                onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              />
            )}

            {/* ── Step: Name ───────────────────────────────────────── */}
            {step === 'name' && (
              <NameStep
                nickname={draft.nickname}
                className={draft.className}
                needsOnboarding={needsOnboarding}
                onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
              />
            )}

            {/* ── Step: Preview ────────────────────────────────────── */}
            {step === 'preview' && (
              <div className="create-gift-preview">
                <CardView
                  card={previewCardProps.card}
                  layout={previewCardProps.layout}
                  images={previewCardProps.images}
                  from={previewCardProps.from}
                  font={previewCardProps.font}
                  ink={previewCardProps.ink}
                  toLine={previewCardProps.toLine}
                  subLine={previewCardProps.subLine}
                  stamp={previewCardProps.stamp}
                  headingLevel="h2"
                />
                <p className="create-gift-preview-meta">
                  {draft.nickname}
                  {draft.className ? ` · ${draft.className}` : ''}
                </p>
              </div>
            )}

            {/* ── Step: Wrap animation ─────────────────────────────── */}
            {step === 'wrap' && (
              <div className="create-gift-wrap" aria-live="polite" aria-label="Đang gói quà…">
                <div ref={wrapBoxRef} className="create-gift-wrap-box" aria-hidden="true">
                  <img
                    src={
                      DEFAULT_THEME_URLS[
                        `box_${draft.boxStyle ?? 1}_closed` as keyof typeof DEFAULT_THEME_URLS
                      ] ?? DEFAULT_THEME_URLS.box_1_closed
                    }
                    alt=""
                    draggable={false}
                  />
                </div>
                <p className="create-gift-wrap-text">Đang gói quà…</p>
              </div>
            )}

            {/* ── Step: Success ────────────────────────────────────── */}
            {step === 'success' && (
              <div className="create-gift-success" role="status">
                <p className="create-gift-success-emoji" aria-hidden="true">🎁</p>
                <p className="create-gift-success-text">Quà đã được treo lên cây!</p>
              </div>
            )}

            {/* ── Navigation buttons ───────────────────────────────── */}
            {step !== 'wrap' && step !== 'success' && (
              <div className="create-gift-nav">
                {stepIdx > 0 && (
                  <button
                    type="button"
                    className="create-gift-back-btn"
                    onClick={goBack}
                  >
                    ← Quay lại
                  </button>
                )}

                {step === 'preview' ? (
                  <button
                    type="button"
                    className="create-gift-submit-btn noel-action-btn"
                    onClick={() => { void handleSubmit() }}
                  >
                    🎁 Gói quà
                  </button>
                ) : (
                  <button
                    type="button"
                    className="create-gift-next-btn noel-action-btn"
                    disabled={step === 'card' && (!!templatesLoadError || (templatesReady && templates.length === 0))}
                    onClick={validateAndAdvance}
                  >
                    Tiếp theo →
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** Grid picker for box styles or ornament styles (1–6). */
function StylePicker({
  label,
  count,
  selected,
  urlFor,
  altFor,
  onChange,
}: {
  label: string
  count: number
  selected: number | null
  urlFor: (i: number) => string
  altFor: (i: number) => string
  onChange: (value: number) => void
}): ReactNode {
  return (
    <div className="create-gift-style-picker">
      <p className="create-gift-picker-label">{label}</p>
      <div
        className="create-gift-style-grid"
        role="radiogroup"
        aria-label={label}
      >
        {Array.from({ length: count }, (_, i) => i + 1).map((i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={selected === i}
            aria-label={altFor(i)}
            className={
              'create-gift-style-item' +
              (selected === i ? ' create-gift-style-item--selected' : '')
            }
            onClick={() => onChange(i)}
          >
            <img src={urlFor(i)} alt="" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  )
}

/** Card editor: layout, background template, font, ink, message. */
function CardEditor({
  draft,
  templates,
  templatesLoadError,
  templatesReady,
  onRetryTemplates,
  onChange,
}: {
  draft: Draft
  templates: ReadonlyArray<NoelTemplate>
  templatesLoadError: boolean
  templatesReady: boolean
  onRetryTemplates?: () => void
  onChange: (patch: Partial<Draft>) => void
}): ReactNode {
  return (
    <div className="create-gift-card-editor">
      {/* Layout */}
      <section className="create-gift-editor-section">
        <p className="create-gift-editor-label">Kiểu bố cục</p>
        <div className="create-gift-layout-row">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={draft.layout === l.id}
              className={
                'create-gift-layout-btn' +
                (draft.layout === l.id ? ' create-gift-layout-btn--active' : '')
              }
              onClick={() => onChange({ layout: l.id })}
            >
              {l.name}
            </button>
          ))}
        </div>
      </section>

      {/* Background template */}
      <section className="create-gift-editor-section">
        <p className="create-gift-editor-label">Ảnh nền</p>
        {templatesLoadError ? (
          <div className="create-gift-template-error" role="alert">
            <span>Không tải được ảnh nền.</span>
            {onRetryTemplates && (
              <button type="button" className="create-gift-retry-btn" onClick={onRetryTemplates}>
                Thử lại
              </button>
            )}
          </div>
        ) : templates.length > 0 ? (
          <div className="create-gift-bg-row">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={draft.backgroundTemplateId === t.id}
                className={
                  'create-gift-bg-btn' +
                  (draft.backgroundTemplateId === t.id ? ' create-gift-bg-btn--active' : '')
                }
                onClick={() => onChange({ backgroundTemplateId: t.id })}
                aria-label={t.name}
              >
                {t.images.background ? (
                  <img
                    src={`/api/image/${t.images.background}`}
                    alt={t.name}
                    className="create-gift-bg-thumb"
                  />
                ) : (
                  <span>{t.name}</span>
                )}
              </button>
            ))}
          </div>
        ) : templatesReady ? (
          <p className="create-gift-editor-hint" role="status">
            Chiến dịch này chưa có ảnh nền. Quản trị viên cần tạo mẫu thiệp cho chiến dịch trong trang quản lý.
          </p>
        ) : (
          <p className="create-gift-editor-hint">Đang tải ảnh nền…</p>
        )}
      </section>

      {/* Font */}
      <section className="create-gift-editor-section">
        <p className="create-gift-editor-label">Font chữ</p>
        <div className="create-gift-font-row">
          {FONTS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={draft.font === f.id}
              className={
                'create-gift-font-btn' +
                (draft.font === f.id ? ' create-gift-font-btn--active' : '')
              }
              style={{ fontFamily: f.stack }}
              onClick={() => onChange({ font: f.id })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      {/* Ink */}
      <section className="create-gift-editor-section">
        <p className="create-gift-editor-label">Màu mực</p>
        <div className="create-gift-ink-row">
          {INKS.map((ink) => (
            <button
              key={ink.value}
              type="button"
              aria-pressed={draft.ink === ink.value}
              aria-label={ink.label}
              className={
                'create-gift-ink-btn' +
                (draft.ink === ink.value ? ' create-gift-ink-btn--active' : '')
              }
              style={{ background: ink.value }}
              onClick={() => onChange({ ink: ink.value })}
            />
          ))}
        </div>
      </section>

      {/* Message — bug #2: use the chosen card font, not browser-default monospace */}
      <section className="create-gift-editor-section">
        <label htmlFor="create-gift-message" className="create-gift-editor-label">
          Lời chúc
        </label>
        <textarea
          id="create-gift-message"
          className="create-gift-message"
          style={{ fontFamily: FONTS.find((f) => f.id === draft.font)?.stack ?? 'inherit' }}
          value={draft.message}
          onChange={(e) => onChange({ message: e.target.value })}
          maxLength={300}
          rows={5}
          placeholder="Viết lời chúc Giáng sinh của bạn…"
        />
        <span
          className={
            'create-gift-msg-counter' +
            (draft.message.length > 280 ? ' create-gift-msg-counter--warn' : '')
          }
          aria-live="polite"
          aria-label={`${draft.message.length} / 300 ký tự`}
        >
          {draft.message.length}/300
        </span>
      </section>
    </div>
  )
}

/** Name step: nickname + className inputs. */
function NameStep({
  nickname,
  className,
  needsOnboarding,
  onChange,
}: {
  nickname: string
  className: string
  needsOnboarding: boolean
  onChange: (patch: { nickname?: string; className?: string }) => void
}): ReactNode {
  return (
    <div className="create-gift-name-step">
      {needsOnboarding && (
        <p className="create-gift-onboarding-note">
          Nhập tên hiển thị của bạn để bắt đầu! Tên này sẽ được lưu vào hồ sơ.
        </p>
      )}
      <label htmlFor="create-gift-nickname" className="create-gift-field-label">
        Tên hiển thị <span aria-hidden="true">*</span>
        <input
          id="create-gift-nickname"
          type="text"
          className="create-gift-input"
          value={nickname}
          onChange={(e) => onChange({ nickname: e.target.value })}
          maxLength={30}
          required
          autoComplete="nickname"
          placeholder="Tên của bạn"
        />
        <small>1–30 ký tự</small>
      </label>
      <label htmlFor="create-gift-class" className="create-gift-field-label">
        Lớp
        <input
          id="create-gift-class"
          type="text"
          className="create-gift-input"
          value={className}
          onChange={(e) => onChange({ className: e.target.value })}
          maxLength={10}
          autoComplete="off"
          placeholder="VD: 12A1"
        />
        <small>Tùy chọn, tối đa 10 ký tự</small>
      </label>
    </div>
  )
}

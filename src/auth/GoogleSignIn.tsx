/**
 * src/auth/GoogleSignIn.tsx — Google Identity Services sign-in button.
 *
 * Loads the GSI script and fetches the nonce + Google client ID from
 * GET /api/auth/nonce (which now returns { nonce, clientId }).
 * No build-time env var needed for the client ID — it is delivered at runtime via GET /api/auth/nonce.
 *
 * Shows the in-app browser guide (AC-6) when isInAppBrowser(navigator.userAgent) is true.
 * Shows the nickname/class onboarding form (FR-10) when the new user has no nickname.
 * Shows the existing Vietnamese note when clientId is empty (not configured).
 *
 * FR-8, FR-10, FR-12, AC-6; docs/tech.md § "Google sign-in + sessions".
 */
import { useEffect, useRef, useState } from 'react'
import { isInAppBrowser } from '../campaign/inAppBrowser.ts'
import { getNonce, messageFor, signInWithGoogle } from '../api.ts'
import OnboardingForm from './OnboardingForm.tsx'

// window.google is declared in src/vite-env.d.ts (GsiInitConfig, Window extension).

type Props = {
  /** Called after successful sign-in AND onboarding (if applicable). */
  onSignedIn: () => void
}

// ── In-app browser guide ──────────────────────────────────────────────────

function InAppBrowserGuide() {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(window.location.href).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 2000) },
      () => { /* clipboard not available — user can copy manually */ },
    )
  }

  return (
    <div>
      <p>
        Trình duyệt trong ứng dụng không hỗ trợ đăng nhập bằng Google.
        Hãy mở trang này bằng <strong>Chrome</strong> hoặc <strong>Safari</strong>.
      </p>
      <div className="form-actions">
        <button type="button" onClick={handleCopy} aria-label="Sao chép liên kết trang">
          {copied ? 'Đã sao chép!' : 'Sao chép liên kết'}
        </button>
      </div>
      <p><small>Dán vào thanh địa chỉ của Chrome hoặc Safari để mở.</small></p>
    </div>
  )
}

// ── Load GSI script on demand ─────────────────────────────────────────────

function loadGsiScript(): Promise<void> {
  return new Promise((resolve) => {
    if (window.google?.accounts?.id) { resolve(); return }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      if (window.google?.accounts?.id) resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => resolve()
    document.head.appendChild(script)
  })
}

// ── GoogleSignIn component ────────────────────────────────────────────────

export default function GoogleSignIn({ onSignedIn }: Props) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  // undefined = still loading from API; '' = no client ID configured; non-empty = ready
  const [clientId, setClientId] = useState<string | undefined>(undefined)

  // Keep ref in sync so the GIS callback always uses the latest onSignedIn.
  const onSignedInRef = useRef(onSignedIn)
  useEffect(() => { onSignedInRef.current = onSignedIn }, [onSignedIn])

  const inApp = isInAppBrowser(navigator.userAgent)

  useEffect(() => {
    if (inApp) return
    let cancelled = false

    void (async () => {
      try {
        await loadGsiScript()
        if (cancelled) return

        const { nonce, clientId: cid } = await getNonce()
        if (cancelled) return

        setClientId(cid)

        if (!cid || !buttonRef.current) return

        window.google!.accounts.id.initialize({
          client_id: cid,
          nonce,
          ux_mode: 'popup',
          use_fedcm_for_button: true,
          context: 'signin',
          callback: async ({ credential }: { credential: string }) => {
            setLoading(true)
            setError(null)
            try {
              const user = await signInWithGoogle(credential)
              if (!user.nickname) {
                setNeedsOnboarding(true)
              } else {
                onSignedInRef.current()
              }
            } catch (e) {
              setError(messageFor(e))
            } finally {
              setLoading(false)
            }
          },
        })

        if (buttonRef.current) {
          window.google!.accounts.id.renderButton(buttonRef.current, {
            type: 'standard',
            text: 'signin_with',
            locale: 'vi',
          })
        }
      } catch (e) {
        if (!cancelled) {
          setClientId('')  // treat fetch failure as unconfigured
          setError(messageFor(e))
        }
      }
    })()

    return () => { cancelled = true }
    // inApp is derived from navigator.userAgent — stable across renders
  }, [inApp])

  if (inApp) return <InAppBrowserGuide />

  // Still loading nonce/clientId from server
  if (clientId === undefined) return null

  if (!clientId) {
    return (
      <p className="admin-loading">
        Google Sign-In chưa được cấu hình (client ID chưa đặt).
      </p>
    )
  }

  if (needsOnboarding) {
    return <OnboardingForm onDone={() => onSignedInRef.current()} />
  }

  return (
    <div>
      {error && <p className="admin-signin-error" role="alert">{error}</p>}
      {loading && <p className="admin-loading">Đang xử lý…</p>}
      <div ref={buttonRef} aria-label="Nút đăng nhập bằng Google" />
    </div>
  )
}

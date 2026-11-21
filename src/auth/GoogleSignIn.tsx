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
import { GSI_SCRIPT_LOAD_ERROR, signInFailureNeedsNonceRefresh } from './googleSignInHelpers.ts'

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
          Sao chép liên kết
        </button>
        {copied && <p role="status">Đã sao chép!</p>}
      </div>
      <p><small>Dán vào thanh địa chỉ của Chrome hoặc Safari để mở.</small></p>
    </div>
  )
}

// ── Load GSI script on demand ─────────────────────────────────────────────

function loadGsiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) { resolve(); return }
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(GSI_SCRIPT_LOAD_ERROR)), { once: true })
      if (window.google?.accounts?.id) resolve()
      return
    }
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.onload = () => resolve()
    // Remove a failed tag so the next mount adds a fresh one instead of waiting on a dead tag.
    script.onerror = () => { script.remove(); reject(new Error(GSI_SCRIPT_LOAD_ERROR)) }
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

  // undefined until the server answers; the nonce is bound to this page load.
  const [nonce, setNonce] = useState<string | undefined>(undefined)

  // Step 1: load the GSI script, then fetch { nonce, clientId }.
  // Errors from script load and nonce fetch are separated so the right message is shown.
  useEffect(() => {
    if (inApp) return
    let cancelled = false
    void (async () => {
      // Load the script first — onerror now rejects the promise
      try {
        await loadGsiScript()
      } catch (e) {
        if (!cancelled) {
          setClientId('')
          setError(e instanceof Error && e.message ? e.message : GSI_SCRIPT_LOAD_ERROR)
        }
        return
      }
      if (cancelled) return
      // Fetch nonce + clientId from server
      try {
        const r = await getNonce()
        if (cancelled) return
        setNonce(r.nonce)
        setClientId(r.clientId)
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

  // Step 2: render the button once the container exists. It mounts only after clientId is
  // set (smoke F4: rendering in step 1 found a null ref and never retried).
  useEffect(() => {
    if (!clientId || !nonce || needsOnboarding || !buttonRef.current) return
    window.google!.accounts.id.initialize({
      client_id: clientId,
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
          // Nonce is single-use: server clears it after every attempt.
          // Always refresh so the user can retry without reloading the page.
          if (signInFailureNeedsNonceRefresh(e)) {
            try {
              const r = await getNonce()
              // Updating nonce triggers this useEffect to re-initialize GIS
              setNonce(r.nonce)
            } catch {
              // If nonce refresh fails, the user will need to reload.
              // The error message already shown guides them.
            }
          }
        } finally {
          setLoading(false)
        }
      },
    })
    window.google!.accounts.id.renderButton(buttonRef.current, {
      type: 'standard',
      text: 'signin_with',
      locale: 'vi',
    })
  }, [clientId, nonce, needsOnboarding])

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
      {loading && <p className="admin-loading" role="status">Đang xử lý…</p>}
      <div role="group" ref={buttonRef} aria-label="Nút đăng nhập bằng Google" />
    </div>
  )
}

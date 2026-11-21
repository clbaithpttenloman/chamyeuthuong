/**
 * InAppBrowserGuide — shown inside dialogs when the user is on an in-app browser.
 *
 * In-app browsers (Zalo, Facebook, Instagram, TikTok, Line…) block Google Sign-In.
 * This component tells the user to open the page in Chrome or Safari, with a
 * one-tap "copy link" helper.
 *
 * AC-6; src/auth/GoogleSignIn.tsx has the same guide in the full sign-in flow.
 *
 * Changes (review cycle 1):
 *  - `navigator.clipboard?.writeText` guard: not all in-app browsers expose the
 *    Clipboard API. Fallback shows the URL in a read-only <input> with select-on-focus.
 *  - Status region is always mounted (role="status") so screen readers announce
 *    the "Đã sao chép!" message even on the first copy.
 */
import { useRef, useState, type ReactNode } from 'react'

export default function InAppBrowserGuide(): ReactNode {
  const [copied, setCopied] = useState(false)
  const [showFallback, setShowFallback] = useState(false)
  const fallbackInputRef = useRef<HTMLInputElement>(null)

  async function handleCopy() {
    const url = window.location.href

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        setShowFallback(false)
        setTimeout(() => setCopied(false), 2000)
        return
      } catch {
        // Clipboard API present but failed (e.g. permission denied) → fallback
      }
    }

    // Fallback: show the URL in a read-only input for manual copy
    setShowFallback(true)
    // Focus the input on next frame so the user can immediately copy
    setTimeout(() => {
      fallbackInputRef.current?.select()
    }, 0)
  }

  return (
    <div className="inapp-guide">
      <p>
        Trình duyệt trong ứng dụng không hỗ trợ đăng nhập bằng Google.
        Hãy mở trang này bằng <strong>Chrome</strong> hoặc <strong>Safari</strong>.
      </p>
      <div className="inapp-guide-actions">
        <button type="button" onClick={handleCopy} aria-label="Sao chép liên kết trang">
          Sao chép liên kết
        </button>
        {/* Status region always mounted so screen readers announce changes */}
        <p role="status" className="inapp-guide-status" aria-live="polite">
          {copied ? 'Đã sao chép!' : ''}
        </p>
      </div>
      {showFallback && (
        <div className="inapp-guide-fallback">
          <label htmlFor="inapp-guide-url">Liên kết (sao chép thủ công):</label>
          <input
            id="inapp-guide-url"
            ref={fallbackInputRef}
            type="text"
            readOnly
            value={typeof window !== 'undefined' ? window.location.href : ''}
            onFocus={(e) => e.currentTarget.select()}
            className="inapp-guide-url-input"
          />
        </div>
      )}
      <p><small>Dán vào thanh địa chỉ của Chrome hoặc Safari để mở.</small></p>
    </div>
  )
}

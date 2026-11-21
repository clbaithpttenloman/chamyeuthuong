/**
 * InAppBrowserGuide — shown inside dialogs when the user is on an in-app browser.
 *
 * In-app browsers (Zalo, Facebook, Instagram, TikTok, Line…) block Google Sign-In.
 * This component tells the user to open the page in Chrome or Safari, with a
 * one-tap "copy link" helper.
 *
 * AC-6; src/auth/GoogleSignIn.tsx has the same guide in the full sign-in flow.
 */
import { useState, type ReactNode } from 'react'

export default function InAppBrowserGuide(): ReactNode {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => { /* clipboard unavailable — user copies manually */ },
    )
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
        {copied && <p role="status">Đã sao chép!</p>}
      </div>
      <p><small>Dán vào thanh địa chỉ của Chrome hoặc Safari để mở.</small></p>
    </div>
  )
}

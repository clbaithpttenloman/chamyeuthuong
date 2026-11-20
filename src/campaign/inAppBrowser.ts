/**
 * src/campaign/inAppBrowser.ts — in-app browser detection.
 *
 * Returns true when the UA belongs to a known in-app browser that blocks Google Sign-In.
 * Detection is case-insensitive and best-effort (no official list; tested against real UAs).
 *
 * Markers (from docs/tech.md § "Embedded in-app browsers"):
 *   Zalo, FBAN, FBAV, FB_IAB (Facebook/Messenger), Instagram, " Line/", musical_ly,
 *   BytedanceWebview (TikTok), "; wv)" (Android WebView flag).
 *
 * FR-12, AC-6; docs/tech.md § "Embedded in-app browsers".
 */
export function isInAppBrowser(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return (
    ua.includes('zalo') ||
    ua.includes('fban') ||
    ua.includes('fbav') ||
    ua.includes('fb_iab') ||
    ua.includes('instagram') ||
    ua.includes(' line/') ||
    ua.includes('musical_ly') ||
    ua.includes('bytedancewebview') ||
    ua.includes('; wv)')
  )
}

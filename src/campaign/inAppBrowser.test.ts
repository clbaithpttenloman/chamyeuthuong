// @vitest-environment node
/**
 * Tests for src/campaign/inAppBrowser.ts — in-app browser detection (red phase)
 *
 * The module does not exist yet; all tests fail until it is implemented.
 *
 * Contract: isInAppBrowser(userAgent: string): boolean
 *   Returns true (case-insensitive) when the UA contains any of:
 *     Zalo, FBAN, FBAV, FB_IAB, Instagram, ` Line/`, musical_ly,
 *     BytedanceWebview, `; wv)` (Android WebView marker)
 *   Returns false for normal Chrome/Safari/Edge/Firefox UAs.
 *
 * FR-12, AC-6; docs/tech.md § "Embedded in-app browsers".
 */
import { describe, it, expect } from 'vitest'
import { isInAppBrowser } from './inAppBrowser.ts'

// ── Positive: in-app browser UAs → true ──────────────────────────────────────

describe('isInAppBrowser — in-app browser UAs → true', () => {
  it.each([
    [
      'Zalo iOS (marker: Zalo)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20G75 Zalo/23.9.1.r2 Mobile',
    ],
    [
      'Zalo Android (marker: Zalo)',
      'Mozilla/5.0 (Linux; Android 12; SM-A325F Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36 Zalo/23.9.1',
    ],
    [
      'Facebook iOS (marker: FBAN/FBIOS)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20G75 [FBAN/FBIOS;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/16.6;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
    ],
    [
      'Facebook Android (marker: FBAV)',
      'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36 FBAV/376.0.0.21.106',
    ],
    [
      'Messenger Android (marker: FB_IAB)',
      'Mozilla/5.0 (Linux; Android 11; Pixel 4 Build/RQ3A.210805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Mobile Safari/537.36 FB_IAB/FB4A;FBAV/369.0.0.0.95',
    ],
    [
      'Instagram iOS (marker: Instagram)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/19F77 Instagram 234.0.0.19.106',
    ],
    [
      'Instagram Android (marker: Instagram)',
      'Mozilla/5.0 (Linux; Android 12; SM-G991B Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36 Instagram 269.0.0.18.75',
    ],
    [
      'LINE iOS (marker: ` Line/`)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20A362 Safari/604.1 Line/12.19.0',
    ],
    [
      'TikTok Android (marker: musical_ly)',
      'Mozilla/5.0 (Linux; Android 12; SM-A325F Build/SP1A.210812.016) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/95.0.4638.74 Mobile Safari/537.36 musical_ly/270306180 JsSdk/2.0',
    ],
    [
      'TikTok Android (marker: BytedanceWebview)',
      'Mozilla/5.0 (Linux; Android 11; Pixel 4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36 BytedanceWebview/1.0.0',
    ],
    [
      'Android WebView (marker: ; wv))',
      'Mozilla/5.0 (Linux; Android 12; SM-A325F Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/95.0.4638.74 Mobile Safari/537.36',
    ],
  ])('%s', (_label, ua) => {
    expect(isInAppBrowser(ua)).toBe(true)
  })
})

// ── Case-insensitivity ────────────────────────────────────────────────────────

describe('isInAppBrowser — detection is case-insensitive', () => {
  it('detects lowercase "zalo" in a wholly-lowercase UA', () => {
    expect(
      isInAppBrowser(
        'mozilla/5.0 (linux; android 12; sm-a325f build/sp1a.210812.016) applewebkit/537.36 (khtml, like gecko) version/4.0 chrome/95.0 mobile safari/537.36 zalo/23.9.1',
      ),
    ).toBe(true)
  })

  it('detects lowercase "fban" in a wholly-lowercase UA', () => {
    expect(
      isInAppBrowser(
        'mozilla/5.0 (iphone; cpu iphone os 16_6 like mac os x) applewebkit/605.1.15 (khtml, like gecko) mobile/20g75 [fban/fbios;fbdv/iphone14,2;fbmd/iphone]',
      ),
    ).toBe(true)
  })

  it('detects lowercase "instagram" in a wholly-lowercase UA', () => {
    expect(
      isInAppBrowser(
        'mozilla/5.0 (iphone; cpu iphone os 15_5 like mac os x) applewebkit/605.1.15 (khtml, like gecko) mobile/19f77 instagram 234.0.0.19.106',
      ),
    ).toBe(true)
  })

  it('detects lowercase " line/" (marker includes leading space)', () => {
    // Real LINE UA lowercased: "... safari/604.1 line/12.19.0"
    // The leading space before "line/" must be present to match.
    expect(
      isInAppBrowser(
        'mozilla/5.0 (iphone; cpu iphone os 16_0 like mac os x) applewebkit/605.1.15 (khtml, like gecko) mobile/20a362 safari/604.1 line/12.19.0',
      ),
    ).toBe(true)
  })
})

// ── Negative: standard browser UAs → false ───────────────────────────────────

describe('isInAppBrowser — standard browser UAs → false', () => {
  it.each([
    [
      'Chrome Android',
      'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Mobile Safari/537.36',
    ],
    [
      'Safari iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    ],
    [
      'Edge desktop',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 Edg/107.0.1418.42',
    ],
    [
      'Firefox desktop',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:106.0) Gecko/20100101 Firefox/106.0',
    ],
    [
      'Chrome desktop',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36',
    ],
    ['empty string', ''],
  ])('%s returns false', (_label, ua) => {
    expect(isInAppBrowser(ua)).toBe(false)
  })
})

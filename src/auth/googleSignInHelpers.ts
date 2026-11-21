/**
 * src/auth/googleSignInHelpers.ts — pure helpers for GoogleSignIn.
 *
 * Extracted from the React component so retry/error logic can be unit-tested
 * without a browser or React environment.
 *
 * No React, no DOM, no network dependencies.
 *
 * FR-8, ADR-3; docs/tech.md § "Google sign-in + sessions".
 */

/** Vietnamese error message shown when the GSI script fails to load. */
export const GSI_SCRIPT_LOAD_ERROR =
  'Không tải được nút đăng nhập Google. Vui lòng tải lại trang.'

/**
 * Returns true when a sign-in failure should trigger a nonce refresh before retry.
 *
 * The server clears the nonce cookie after every sign-in attempt (success or failure)
 * and nonces expire after 5 minutes.  Therefore a retry always needs a fresh nonce —
 * this is the fail-safe decision: we refresh regardless of the error type.
 */
export function signInFailureNeedsNonceRefresh(_error: unknown): boolean {
  return true
}

/**
 * Admin sign-out: revoke the Google session first. When the server does not confirm, the
 * caller must keep the signed-in UI (the session cookie is still valid; shared computers).
 */
export async function revokeAdminSession(
  hasGoogleSession: boolean,
  logout: () => Promise<void>,
): Promise<{ ok: boolean }> {
  if (!hasGoogleSession) return { ok: true }
  try {
    await logout()
    return { ok: true }
  } catch (e) {
    // 401: the session is already gone (expired or revoked), so the admin is signed out.
    if ((e as { status?: number } | null)?.status === 401) return { ok: true }
    return { ok: false }
  }
}

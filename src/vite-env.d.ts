/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google OAuth client ID for the Google Identity Services button. Set via VITE_GOOGLE_CLIENT_ID. */
  readonly VITE_GOOGLE_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Minimal Google Identity Services types for window.google (src/auth/GoogleSignIn.tsx). */
interface GsiInitConfig {
  client_id: string
  callback(response: { credential: string }): void
  nonce: string
  ux_mode?: string
  use_fedcm_for_button?: boolean
  context?: string
}

interface Window {
  google?: {
    accounts: {
      id: {
        initialize(config: GsiInitConfig): void
        renderButton(parent: HTMLElement, options: Record<string, unknown>): void
      }
    }
  }
}

/// <reference types="vite/client" />

interface ImportMetaEnv {
  // The Google client ID is delivered via GET /api/auth/nonce — no build-time env var needed.
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

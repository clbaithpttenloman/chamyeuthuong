/**
 * src/gis.ts — thin wrapper around Google Identity Services.
 *
 * Loads https://accounts.google.com/gsi/client on demand (call loadGis()
 * once; subsequent calls return the same promise). No new dependency — the
 * script tag is inserted at runtime from the admin page only.
 */

// Minimal types for the google.accounts.id API surface we use.
export type GisCredentialResponse = {
  credential: string
  select_by: string
}

type GisInitConfig = {
  client_id: string
  callback: (response: GisCredentialResponse) => void
  auto_select?: boolean
}

type GisButtonOptions = {
  theme?: 'outline' | 'filled_blue' | 'filled_black'
  size?: 'large' | 'medium' | 'small'
  text?: string
  shape?: 'rectangular' | 'pill' | 'circle' | 'square'
  locale?: string
  width?: number
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: GisInitConfig): void
          renderButton(parent: HTMLElement, options: GisButtonOptions): void
          disableAutoSelect(): void
        }
      }
    }
  }
}

function api() {
  const g = window.google?.accounts.id
  if (!g) throw new Error('GIS not loaded')
  return g
}

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'
let _loadPromise: Promise<void> | null = null

/** Load the GIS script once; subsequent calls return the same promise. */
export function loadGis(): Promise<void> {
  if (_loadPromise) return _loadPromise
  _loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('GIS script load failed'))
    document.head.appendChild(script)
  })
  return _loadPromise
}

export function gisInitialize(config: GisInitConfig): void {
  api().initialize(config)
}

export function gisRenderButton(parent: HTMLElement, options: GisButtonOptions = {}): void {
  api().renderButton(parent, options)
}

export function gisDisableAutoSelect(): void {
  api().disableAutoSelect()
}

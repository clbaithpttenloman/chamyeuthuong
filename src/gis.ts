/**
 * src/gis.ts — Google Identity Services loader.
 *
 * Loads https://accounts.google.com/gsi/client on demand (call loadGis()
 * once; subsequent calls return the same promise). Resets the cached promise
 * on failure so the next call retries. No new dependency — the script tag is
 * inserted at runtime from the admin page only.
 */

export type GisCredentialResponse = {
  credential: string
  select_by: string
}

type GisInitConfig = {
  client_id: string
  callback: (response: GisCredentialResponse) => void
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
          prompt(): void
        }
      }
    }
  }
}

const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client'
let _loadPromise: Promise<void> | null = null

/**
 * Load the GIS script once; subsequent calls return the same promise.
 * On failure the promise cache is reset so the next call retries.
 */
export function loadGis(): Promise<void> {
  if (_loadPromise) return _loadPromise
  _loadPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SCRIPT_URL
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      _loadPromise = null  // reset so the next loadGis() call retries
      reject(new Error('GIS script load failed'))
    }
    document.head.appendChild(script)
  })
  return _loadPromise
}

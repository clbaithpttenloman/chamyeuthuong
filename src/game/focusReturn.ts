/**
 * Focus return after the gift sheet closes (keyboard users land back on the gift).
 */

type Focusable = { focus(): void }
type Root = { querySelector(selector: string): Focusable | null }

const PUBLIC_ID = /^[a-z0-9]{16}$/

/**
 * Focuses the scene button for `publicId` (`[data-public-id]`). When the gift is not on the
 * tree (opened from a list) or the id is not public-id shaped, focuses `fallback` instead.
 * Returns true when the gift button was found.
 */
export function focusGiftButton(root: Root, publicId: string | null, fallback: Focusable | null): boolean {
  const btn = publicId && PUBLIC_ID.test(publicId) ? root.querySelector(`[data-public-id="${publicId}"]`) : null
  if (btn) {
    btn.focus()
    return true
  }
  fallback?.focus()
  return false
}

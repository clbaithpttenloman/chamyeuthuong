/**
 * useDialog — thin React hook for Noel dialog focus management (ADR-4, NFR-4).
 *
 * Installs the focus trap and Esc handler ONCE on mount (empty-dep effect),
 * reading `onCloseRef.current` at event time so the handler never re-runs when
 * the parent re-renders (which would steal focus every ~15 s poll cycle).
 *
 * Nested confirm support:
 *   - `pushLayer(el, onClose)` — add an inner layer (confirm dialog); Esc and
 *     Tab now target `el` first; focus moves into `el`.
 *   - `popLayer(returnTo?)` — remove the top layer; focus returns to `returnTo`
 *     (or the base dialog if omitted).
 *
 * Usage:
 *
 *   const onCloseRef = useRef(props.onClose)
 *   useEffect(() => { onCloseRef.current = props.onClose })
 *
 *   const { pushLayer, popLayer } = useDialog({
 *     dialogRef,
 *     onCloseRef,
 *     returnFocusRef,
 *   })
 *
 *   // When a confirm opens:
 *   pushLayer(confirmEl, () => setShowConfirm(false), openerEl)
 *   // When the confirm closes (useEffect watching the flag):
 *   popLayer(openerEl)
 */
import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import { getFocusable, tabNext, type DialogLayer } from './dialogFocus.ts'

// ── Public API ────────────────────────────────────────────────────────────────

export interface UseDialogOpts {
  /** The dialog's root div ref (receives focus on open). */
  dialogRef: React.RefObject<HTMLDivElement | null>
  /** Stable ref to the close callback — updated each render, never in deps. */
  onCloseRef: React.RefObject<() => void>
  /** Element to return focus to when the dialog unmounts. */
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

export interface UseDialogResult {
  /**
   * Push a nested layer (confirm dialog).
   *
   * @param el        The confirm container (must be in the DOM).
   * @param onClose   Called when this layer's Esc is pressed.
   * @param opener    Optional element to return focus to when the layer is popped.
   */
  pushLayer: (el: HTMLElement, onClose: () => void, opener?: HTMLElement | null) => void
  /**
   * Remove the top nested layer.
   *
   * @param returnTo  Optional element to focus after pop (overrides stored opener).
   */
  popLayer: (returnTo?: HTMLElement | null) => void
}

// ── Implementation ────────────────────────────────────────────────────────────

interface StackEntry extends DialogLayer {
  opener: HTMLElement | null
}

export function useDialog({ dialogRef, onCloseRef, returnFocusRef }: UseDialogOpts): UseDialogResult {
  const layerStack = useRef<StackEntry[]>([])

  // Focus dialog on open; return focus on unmount.
  // Uses a separate effect so the cleanup (focus return) is decoupled from the
  // keydown handler (which must run only once, on mount).
  useEffect(() => {
    dialogRef.current?.focus()
    const returnTarget = returnFocusRef?.current ?? null
    return () => { returnTarget?.focus() }
  // returnFocusRef is stable; .current is captured once to avoid reading a
  // different element if the ref changes (edge case in hot-reload, not runtime).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Install keydown trap ONCE on mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        const top = layerStack.current[layerStack.current.length - 1]
        if (top) {
          // Close innermost layer first
          top.onClose()
        } else {
          onCloseRef.current()
        }
        return
      }

      if (e.key !== 'Tab') return

      // Determine the active container: top layer or base dialog
      const top = layerStack.current[layerStack.current.length - 1]
      const container = top?.el ?? dialogRef.current
      if (!container) return

      const focusable = getFocusable(container)
      const next = tabNext(focusable, document.activeElement, e.shiftKey, container)
      if (next) {
        e.preventDefault()
        ;(next as HTMLElement).focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pushLayer = useCallback((
    el: HTMLElement,
    onClose: () => void,
    opener: HTMLElement | null = null,
  ) => {
    layerStack.current.push({ el, onClose, opener })
    el.focus()
  }, [])

  const popLayer = useCallback((returnTo?: HTMLElement | null) => {
    const top = layerStack.current.pop()
    const target = returnTo !== undefined ? returnTo : top?.opener
    target?.focus()
  }, [])

  return { pushLayer, popLayer }
}

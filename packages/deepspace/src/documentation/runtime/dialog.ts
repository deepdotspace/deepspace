import { useEffect, type RefObject } from 'react'

/** Shared keyboard/focus contract for the documentation search, assistant, and mobile navigation. */
export function useDialogFocus(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  trap = true,
  restoreId?: string,
): void {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const element = ref.current
    const frame = window.requestAnimationFrame(() => {
      const target = element?.querySelector<HTMLElement>('[data-autofocus]')
        ?? element?.querySelector<HTMLElement>('button,a,input,textarea')
      target?.focus()
    })
    const keydown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (!trap || event.key !== 'Tab' || !element) return
      const focusable = Array.from(element.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', keydown)
      const restoreTarget = restoreId
        ? document.getElementById(restoreId)
        : previous?.isConnected && previous !== document.body && !element?.contains(previous)
          ? previous
          : null
      restoreTarget?.focus()
    }
  }, [onClose, open, ref, restoreId, trap])
}

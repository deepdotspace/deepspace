/** Copy text while preserving focus when the Clipboard API is unavailable. */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // A user gesture can still copy through the document when access is withheld.
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.position = 'fixed'
  textarea.style.inset = '0 auto auto 0'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  activeElement?.focus({ preventScroll: true })
  if (!copied) throw new Error('Unable to copy text')
}

export function externalProps(href: string): { target?: '_blank'; rel?: 'noopener noreferrer' } {
  return isExternal(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {}
}

export function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

export function safeStorageGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

export function safeStorageSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* storage is optional */ }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * useLongPress — Touch-based long-press detection for web.
 *
 * Returns event handlers (onTouchStart, onTouchEnd, onTouchMove) to
 * attach to any element. Fires the callback after `delay` ms of
 * sustained touch. Cancels if the finger moves beyond `threshold` px
 * or lifts before the timer fires.
 *
 * Only active on touch devices — mouse events are not intercepted,
 * so desktop hover behavior is unaffected.
 */

import { useRef, useCallback } from 'react'

interface UseLongPressOptions {
  delay?: number
  threshold?: number
}

export function useLongPress(
  callback: () => void,
  { delay = 500, threshold = 10 }: UseLongPressOptions = {}
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startPos.current = null
  }, [])

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      firedRef.current = false
      const touch = e.touches[0]
      startPos.current = { x: touch.clientX, y: touch.clientY }
      timerRef.current = setTimeout(() => {
        firedRef.current = true
        callback()
        timerRef.current = null
      }, delay)
    },
    [callback, delay]
  )

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current || timerRef.current === null) return
      const touch = e.touches[0]
      const dx = touch.clientX - startPos.current.x
      const dy = touch.clientY - startPos.current.y
      if (Math.sqrt(dx * dx + dy * dy) > threshold) {
        clear()
      }
    },
    [threshold, clear]
  )

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (firedRef.current) {
        e.preventDefault()
      }
      clear()
    },
    [clear]
  )

  return { onTouchStart, onTouchMove, onTouchEnd }
}

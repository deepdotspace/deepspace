/**
 * Floating dismissible guest banner for DeepSpace apps.
 *
 * Shows a non-intrusive prompt for signed-out users to sign in or sign up.
 * Dismiss state is persisted in sessionStorage so it stays hidden for the
 * duration of the browsing session.
 *
 * Styled with shadcn semantic tokens (bg-card, text-foreground, etc.) so it
 * themes along with the host app.
 */

import React, { useEffect, useState } from 'react'
import { useAuth } from './hooks'

const DEFAULT_STORAGE_KEY = 'deepspace-guest-banner-dismissed'
const DEFAULT_MESSAGE = "You're browsing as a guest. Sign in to unlock all features."

export interface GuestBannerProps {
  message?: string
  storageKey?: string
  /** Called when the user clicks "Sign in". */
  onSignIn?: () => void
}

export function GuestBanner({
  message = DEFAULT_MESSAGE,
  storageKey = DEFAULT_STORAGE_KEY,
  onSignIn,
}: GuestBannerProps): React.ReactElement | null {
  const { isLoaded, isSignedIn } = useAuth()
  const [mounted, setMounted] = useState(false)

  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return sessionStorage.getItem(storageKey) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (isLoaded && !isSignedIn && !dismissed) {
      requestAnimationFrame(() => setMounted(true))
    }
  }, [dismissed, isLoaded, isSignedIn])

  if (!isLoaded || isSignedIn || dismissed) return null

  const handleDismiss = (): void => {
    try {
      sessionStorage.setItem(storageKey, '1')
    } catch {
      // best effort
    }
    setDismissed(true)
  }

  return (
    <>
      <style>{`
        @keyframes ds-guest-banner-in {
          from { opacity: 0; transform: translateY(-12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div
        role="banner"
        data-testid="guest-banner"
        className="fixed top-3 inset-x-3 z-[99998] mx-auto flex max-w-[700px] items-center gap-3.5 rounded-2xl border border-border bg-card/95 px-4 py-3 text-sm leading-snug text-foreground shadow-card-hover backdrop-blur-xl sm:gap-4"
        style={{
          opacity: mounted ? 1 : 0,
          animation: mounted
            ? 'ds-guest-banner-in 0.35s cubic-bezier(0.25, 1, 0.5, 1) forwards'
            : 'none',
          pointerEvents: mounted ? 'auto' : 'none',
        }}
      >
        <span
          aria-hidden
          className="hidden h-2 w-2 shrink-0 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)] sm:inline-block"
        />

        <span className="min-w-0 flex-1 font-medium text-muted-foreground">
          {message}
        </span>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            data-testid="guest-banner-signin"
            onClick={onSignIn}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 sm:text-sm"
          >
            Sign in
          </button>

          <button
            type="button"
            data-testid="guest-banner-dismiss"
            onClick={handleDismiss}
            aria-label="Dismiss banner"
            className="flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}

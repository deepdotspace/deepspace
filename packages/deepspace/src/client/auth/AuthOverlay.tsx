/**
 * Full-page frosted-glass auth overlay for deployed DeepSpace apps.
 *
 * Primary: OAuth (GitHub, Google).
 * Secondary: Email/password sign-in (for test accounts created via CLI/API).
 * Styled with shadcn semantic tokens so it themes along with the host app.
 */

import React, { useState } from 'react'
import { useAuth } from './hooks'
import { signIn } from './client'

interface AuthOverlayProps {
  /** Called when the user clicks the close button. If omitted, overlay is not closeable. */
  onClose?: () => void
  /** Which OAuth providers to show. Defaults to both. */
  providers?: Array<'github' | 'google'>
}

export function AuthOverlay({
  onClose,
  providers = ['github', 'google'],
}: AuthOverlayProps = {}): React.ReactElement | null {
  const { isLoaded, isSignedIn } = useAuth()
  const [showEmailForm, setShowEmailForm] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (!isLoaded || isSignedIn) return null

  const handleSocial = (provider: 'github' | 'google') => {
    setLoading(true)
    window.location.href = `/api/auth/social-redirect?provider=${provider}`
  }

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await signIn.email({ email, password })
      if (result.error) {
        setError(result.error.message ?? 'Sign in failed')
        setLoading(false)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <>
      <style>{`
        @keyframes ds-auth-overlay-in {
          from { opacity: 0 }
          to   { opacity: 1 }
        }
        @keyframes ds-auth-card-in {
          from { opacity: 0; transform: translateY(16px) scale(0.97) }
          to   { opacity: 1; transform: translateY(0) scale(1) }
        }
      `}</style>

      <div
        data-testid="auth-overlay"
        onClick={onClose ? (e) => { if (e.target === e.currentTarget) onClose() } : undefined}
        className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/55 backdrop-blur-2xl"
        style={{
          opacity: 0,
          animation: 'ds-auth-overlay-in 0.4s ease forwards',
        }}
      >
        <div
          className="relative mx-6 w-full max-w-[380px] rounded-2xl border border-border bg-card p-8 text-center shadow-card-hover sm:p-9"
          style={{
            opacity: 0,
            animation: 'ds-auth-card-in 0.45s cubic-bezier(0.25, 1, 0.5, 1) 0.08s forwards',
          }}
        >
          {onClose && (
            <button
              data-testid="auth-overlay-close"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              ✕
            </button>
          )}

          <h2 className="mb-2 text-[22px] font-bold leading-snug text-foreground">
            Sign in to DeepSpace
          </h2>

          <p className="mb-6 text-sm leading-snug text-muted-foreground">
            Sync your data across devices
          </p>

          {/* OAuth buttons */}
          <div className="flex flex-col gap-2">
            {providers.includes('github') && (
              <OAuthButton onClick={() => handleSocial('github')} disabled={loading} icon={<GitHubIcon />}>
                Continue with GitHub
              </OAuthButton>
            )}
            {providers.includes('google') && (
              <OAuthButton onClick={() => handleSocial('google')} disabled={loading} icon={<GoogleIcon />}>
                Continue with Google
              </OAuthButton>
            )}
          </div>

          <Divider />

          {!showEmailForm ? (
            <button
              type="button"
              data-testid="auth-email-toggle"
              onClick={() => setShowEmailForm(true)}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-transparent px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2" y="4" width="20" height="16" rx="2" />
                <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
              </svg>
              Sign in with email
            </button>
          ) : (
            <form onSubmit={handleEmailSignIn} className="text-left">
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="mb-3 block w-full rounded-lg border border-border bg-secondary px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="current-password"
                className={`block w-full rounded-lg border border-border bg-secondary px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none ${error ? 'mb-3' : 'mb-5'}`}
              />

              {error && (
                <div className="mb-4 text-center text-sm text-destructive">{error}</div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="block w-full rounded-lg bg-primary px-5 py-3 text-[15px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
              >
                {loading ? 'Please wait…' : 'Sign in'}
              </button>
            </form>
          )}

          <p className="mt-5 text-xs leading-snug text-muted-foreground">
            By continuing, you agree to the DeepSpace{' '}
            <a
              href="https://deep.space/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="https://deep.space/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Privacy Policy
            </a>
            .
          </p>

          <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" opacity="0.5" aria-hidden>
              <circle cx="12" cy="12" r="10" />
            </svg>
            Powered by DeepSpace
          </div>
        </div>
      </div>
    </>
  )
}

// ────────────────────────────────────────────────────────────────────
// Local components
// ────────────────────────────────────────────────────────────────────

function OAuthButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void
  disabled: boolean
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-secondary px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent disabled:cursor-wait disabled:opacity-60"
    >
      {icon}
      {children}
    </button>
  )
}

function Divider() {
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
      <div className="h-px flex-1 bg-border" />
      or
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

// Google logo uses Google's brand colors — these are required by Google's
// brand guidelines and intentionally not theme-reactive.
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  )
}

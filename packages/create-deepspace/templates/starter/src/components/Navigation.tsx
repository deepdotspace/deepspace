/** Top nav — brand, primary links, role badge, account menu. */

import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AuthOverlay, useAuthProfileReady, signOut } from 'deepspace'
import { ChevronDown, LogOut, Menu, X } from 'lucide-react'
import { APP_NAME, ROLE_CONFIG, type Role } from '../constants'
import { nav } from '../nav'
import { cn } from '../lib/utils'

export default function Navigation() {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  const profileReady = !isSignedIn || (!userLoading && !!user)
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'
  const roleConfig =
    ROLE_CONFIG[userRole as Role] ?? { title: 'Anonymous', badgeVariant: 'secondary' }

  // Close any open menus when navigating
  useEffect(() => {
    setMobileMenuOpen(false)
    setUserMenuOpen(false)
  }, [location.pathname])

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  return (
    <>
      <nav
        data-testid="app-navigation"
        className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl"
      >
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          {/* Brand — primary-tinted dot + name. Replace the dot with your logo. */}
          <Link to="/home" className="flex items-center gap-2 shrink-0">
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span className="text-sm font-semibold tracking-tight text-foreground">
              {APP_NAME}
            </span>
          </Link>

          {/* Primary nav (desktop) */}
          <div className="hidden md:flex items-center gap-0.5">
            {visibleNav.map((item) => {
              const active = location.pathname.startsWith(item.path)
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-full px-3.5 py-1.5 text-sm font-medium transition-all duration-150',
                    active
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Right cluster */}
          <div className="flex items-center gap-2">
            {isSignedIn && !profileReady ? (
              <div data-testid="nav-role-loading" className="hidden h-5 w-16 animate-pulse rounded-full bg-muted sm:block" />
            ) : (
              <span
                data-testid="nav-role-badge"
                className={cn(
                  'hidden sm:inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                  roleConfig.badgeVariant === 'warning'
                    ? 'bg-warning/15 text-warning ring-1 ring-inset ring-warning/30'
                    : roleConfig.badgeVariant === 'default'
                      ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/30'
                      : 'bg-secondary text-muted-foreground ring-1 ring-inset ring-border',
                )}
              >
                {roleConfig.title}
              </span>
            )}

            {!isLoaded ? (
              <div className="h-8 w-20 animate-pulse rounded-full bg-muted" />
            ) : isSignedIn && !profileReady ? (
              <div className="flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pl-1 pr-2.5">
                <div className="h-6 w-6 animate-pulse rounded-full bg-muted" />
                <div className="hidden h-4 w-20 animate-pulse rounded-md bg-muted sm:block" />
              </div>
            ) : isSignedIn && user ? (
              <div className="relative">
                <button
                  onClick={() => setUserMenuOpen((prev) => !prev)}
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  className="group flex items-center gap-2 rounded-full border border-border bg-card/60 pl-1 pr-2.5 py-1 text-sm transition-colors hover:bg-card hover:border-border"
                >
                  <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-muted text-[11px] font-semibold text-muted-foreground ring-1 ring-inset ring-border">
                    {user.imageUrl ? (
                      <img
                        src={user.imageUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-full w-full rounded-full object-cover"
                      />
                    ) : (
                      (user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()
                    )}
                  </span>
                  <span
                    data-testid="nav-user-name"
                    className="hidden max-w-[120px] truncate text-foreground sm:inline"
                  >
                    {user.name || user.email}
                  </span>
                  <ChevronDown
                    className={cn(
                      'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
                      userMenuOpen && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
                {userMenuOpen && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setUserMenuOpen(false)}
                      aria-hidden
                    />
                    <div
                      role="menu"
                      className="absolute right-0 top-[calc(100%+6px)] z-50 w-56 overflow-hidden rounded-xl border border-border bg-card shadow-[0_2px_8px_-2px_rgba(0,0,0,0.10)]"
                    >
                      <div className="border-b border-border px-3 py-2.5">
                        <div className="truncate text-sm font-medium text-foreground">
                          {user.name || 'Signed in'}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {user.email}
                        </div>
                      </div>
                      <button
                        role="menuitem"
                        onClick={() => { setUserMenuOpen(false); signOut() }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      >
                        <LogOut className="h-3.5 w-3.5" aria-hidden />
                        Sign out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                data-testid="nav-sign-in-button"
                onClick={() => setShowAuthModal(true)}
                className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                Sign in
              </button>
            )}

            <button
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground md:hidden"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? (
                <X className="h-4 w-4" aria-hidden />
              ) : (
                <Menu className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        <div
          className={cn(
            'overflow-hidden border-t border-border bg-background/95 backdrop-blur-xl transition-[max-height,opacity] duration-200 ease-out md:hidden',
            mobileMenuOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0',
          )}
        >
          <div className="space-y-0.5 px-3 py-2">
            {visibleNav.map((item) => {
              const active = location.pathname.startsWith(item.path)
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  {item.label}
                </Link>
              )
            })}
          </div>
        </div>
      </nav>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </>
  )
}

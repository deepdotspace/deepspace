/**
 * AppSidebar — collapsible left rail wired to the app's mechanisms:
 * nav.ts-driven links (role/dev filtering), sign-in via <AuthOverlay>,
 * account menu with sign-out. Restyle freely; keep the data-testid hooks
 * (`app-navigation`, `nav-sign-in-button`, `nav-user-name`, `nav-user-email`)
 * — the shipped tests rely on them. `nav-user-email` is the one that carries
 * an identity the test can check exactly: a display name is optional, the
 * email is the credential the session was opened with.
 *
 * Fixed-icon collapse: only the rail's width animates (216px ↔ 64px).
 * Every icon is a fixed-size `shrink-0` first flex child at a constant
 * left offset, labels fade via opacity and the rail clips them — no icon
 * moves when the rail opens or closes. Collapsed, the logo mark expands
 * the rail; expanded, it links to the landing page at `/` and a separate
 * button collapses.
 *
 * Mobile (<md): the rail becomes an off-canvas drawer (always expanded)
 * behind a backdrop, opened from <SidebarMobileHeader>.
 */

import { useEffect, useState, type ReactElement } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AuthOverlay, useAuthProfileReady, signOut } from 'deepspace'
import {
  Box,
  ChevronDown,
  Home,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { APP_NAME } from '../../constants'
import type { Role } from '../../constants'
import { nav } from '../../nav'
import { cn } from '../../lib/utils'
import { ThemeToggle } from '../shell/ThemeToggle'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../ui'

/** Icon per nav route; keeps nav.ts as plain data (feature-added entries get the fallback). */
const NAV_ICONS: Record<string, LucideIcon> = {
  '/home': Home,
  '/settings': Settings,
}

const COLLAPSE_KEY = 'sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean) {
  try {
    localStorage.setItem(COLLAPSE_KEY, String(value))
  } catch { /* private mode — state just won't persist */ }
}

/** Right-side tooltip for the collapsed rail; passthrough otherwise. */
function RailTip({ show, label, children }: { show: boolean; label: string; children: ReactElement }) {
  if (!show) return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

interface AppSidebarProps {
  mobileOpen: boolean
  onMobileClose: () => void
}

export function AppSidebar({ mobileOpen, onMobileClose }: AppSidebarProps) {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()

  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [showAuthModal, setShowAuthModal] = useState(false)

  const profileReady = !isSignedIn || (!userLoading && !!user)
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'

  // In the mobile drawer the rail is always the expanded layout.
  const labelsHidden = collapsed && !mobileOpen

  // Close the drawer when navigating.
  useEffect(() => {
    onMobileClose()
  }, [location.pathname, onMobileClose])

  // Escape closes the drawer.
  useEffect(() => {
    if (!mobileOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileOpen, onMobileClose])

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      writeCollapsed(!prev)
      return !prev
    })
  }

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onMobileClose} aria-hidden />
      )}

      <nav
        data-testid="app-navigation"
        aria-label="Primary"
        className={cn(
          'flex h-full flex-col overflow-hidden border-r border-border bg-shell px-3 pb-3 pt-3',
          // `visibility` rides the transition so the closed drawer finishes its
          // slide-out, THEN leaves the tab order / a11y tree — without it the
          // off-screen drawer's links and buttons stay keyboard-focusable
          // while invisible (Tab reaches controls the user can't see).
          'transition-[width,transform,visibility] duration-200 ease-out',
          // Mobile: off-canvas drawer, always expanded width.
          'fixed inset-y-0 left-0 z-50 w-[216px]',
          mobileOpen ? 'translate-x-0 shadow-lg' : '-translate-x-full max-md:invisible',
          // Desktop: in-flow rail on the shell background, width animates.
          'md:static md:z-auto md:translate-x-0 md:border-r-0 md:bg-transparent md:shadow-none',
          collapsed ? 'md:w-16' : 'md:w-[216px]',
        )}
      >
        {/* Header — the mark doubles as the toggle: collapsed it expands the
            rail, expanded it links to the landing page and the button on the
            right collapses. Fixed h-8 so the row keeps its height when the
            collapse button unmounts — nothing below shifts even 1px. */}
        <div className="mb-4 flex h-8 items-center justify-between gap-1">
          <RailTip show={labelsHidden} label="Expand sidebar">
            <Link
              to="/"
              onClick={(e) => {
                if (labelsHidden) {
                  e.preventDefault()
                  toggleCollapsed()
                  return
                }
                if (mobileOpen) onMobileClose()
              }}
              aria-label={labelsHidden ? 'Expand sidebar' : `${APP_NAME} landing page`}
              className="flex min-w-0 items-center gap-[10px] rounded-md px-[2px]"
            >
              <span className="flex size-[26px] flex-none items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                {APP_NAME.charAt(0).toUpperCase()}
              </span>
              <span
                className="truncate text-sm font-semibold text-foreground transition-opacity duration-150"
                style={{ opacity: labelsHidden ? 0 : 1 }}
              >
                {APP_NAME}
              </span>
            </Link>
          </RailTip>

          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              className="hidden size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:inline-flex"
            >
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>

        {/* Nav — icons are fixed-size first flex children at a constant
            offset; labels fade and the rail clips them. */}
        <div className="flex flex-col gap-0.5">
          {visibleNav.map((item) => {
            const Icon = NAV_ICONS[item.path] ?? Box
            const active = location.pathname.startsWith(item.path)
            return (
              <RailTip key={item.path} show={labelsHidden} label={item.label}>
                <Link
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-[10px] rounded-md px-[10px] py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-[15px] shrink-0" aria-hidden />
                  <span
                    className="whitespace-nowrap transition-opacity duration-150"
                    style={{ opacity: labelsHidden ? 0 : 1 }}
                  >
                    {item.label}
                  </span>
                </Link>
              </RailTip>
            )
          })}
        </div>

        <div className="flex-1" />

        <div className="pb-1">
          <ThemeToggle collapsed={labelsHidden} />
        </div>

        {/* Account row: skeleton while the profile loads, account menu when
            signed in, sign-in button when signed out. */}
        {!isLoaded ? null : isSignedIn && !profileReady ? (
          <div className="flex items-center gap-[10px] px-[10px] py-2">
            <div className="size-[26px] shrink-0 animate-pulse rounded-full bg-muted" />
            <div
              className="h-4 w-24 animate-pulse rounded-md bg-muted transition-opacity duration-150"
              style={{ opacity: labelsHidden ? 0 : 1 }}
            />
          </div>
        ) : isSignedIn && user ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  aria-label="Account menu"
                  className="flex w-full items-center gap-[10px] rounded-md px-[10px] py-2 text-left text-sm transition-colors hover:bg-muted"
                >
                  <Avatar className="size-[26px] shrink-0 ring-1 ring-inset ring-border">
                    <AvatarImage src={user.imageUrl ?? undefined} referrerPolicy="no-referrer" />
                    <AvatarFallback className="text-[11px]">
                      {(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <span
                    className="flex min-w-0 flex-1 items-center gap-1 transition-opacity duration-150"
                    style={{ opacity: labelsHidden ? 0 : 1 }}
                  >
                    <span data-testid="nav-user-name" className="truncate text-foreground">
                      {user.name || user.email}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  </span>
                </button>
              }
            />
            <DropdownMenuContent side="top" align="start" className="w-56">
              <DropdownMenuLabel>
                <div className="truncate font-medium text-foreground">{user.name || 'Signed in'}</div>
                <div
                  data-testid="nav-user-email"
                  className="truncate text-xs font-normal text-muted-foreground"
                >
                  {user.email}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => signOut()}>
                <LogOut aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <RailTip show={labelsHidden} label="Sign in">
            <button
              type="button"
              data-testid="nav-sign-in-button"
              onClick={() => setShowAuthModal(true)}
              className="flex w-full items-center gap-[10px] rounded-md bg-primary px-[10px] py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              <LogIn className="size-[15px] shrink-0" aria-hidden />
              <span
                className="whitespace-nowrap transition-opacity duration-150"
                style={{ opacity: labelsHidden ? 0 : 1 }}
              >
                Sign in
              </span>
            </button>
          </RailTip>
        )}
      </nav>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </>
  )
}

/** Minimal mobile top bar (<md) — hamburger + app name. */
export function SidebarMobileHeader({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <div className="flex h-12 flex-none items-center gap-3 border-b border-border bg-shell px-3 md:hidden">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Menu size={18} aria-hidden />
      </button>
      <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
    </div>
  )
}

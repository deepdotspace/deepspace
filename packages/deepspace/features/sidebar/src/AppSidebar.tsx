/**
 * AppSidebar -- collapsible left navigation sidebar.
 *
 * Features:
 * - Collapsed (52px): icon-only with right-side tooltips
 * - Expanded (240px): icons + labels + user chip
 * - Mobile (<=768px): overlay drawer with backdrop
 * - Collapse state persisted to localStorage
 * - Role-based nav filtering via useUser()
 * - Active state via react-router-dom useLocation
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { PanelLeft, Zap, Menu } from 'lucide-react'
import { useUser } from 'deepspace'
import { ROLES, ROLE_CONFIG, type Role } from 'deepspace'

// ============================================================================
// CSS injection
// ============================================================================

const SIDEBAR_CSS = `@layer base {
  .app-shell {
    height: 100%;
    display: flex;
    overflow: hidden;
    background: color-mix(in srgb, var(--color-card) 40%, var(--color-background));
    padding: 8px 8px 8px 0;
  }
  .app-content {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--color-background);
    border-radius: 12px;
    border: 1px solid var(--color-border);
  }
  .sidebar {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex-shrink: 0;
    transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .sidebar.collapsed { overflow: visible; }
  .sidebar-logo-row {
    display: flex;
    align-items: center;
    height: 52px;
    padding: 0 8px;
    flex-shrink: 0;
  }
  .sidebar-logo-btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border: none;
    background: none;
    border-radius: 8px;
    cursor: pointer;
    padding: 0;
    color: var(--color-primary);
    transition: background 0.15s, color 0.15s;
  }
  .sidebar-logo-btn:hover {
    background: color-mix(in srgb, var(--color-muted) 60%, transparent);
    color: var(--color-foreground);
  }
  .sidebar-logo-text {
    font-size: 15px;
    font-weight: 700;
    color: var(--color-foreground);
    letter-spacing: -0.3px;
    white-space: nowrap;
    margin-left: 4px;
    opacity: 1;
    transition: opacity 150ms ease;
  }
  .sidebar-collapse-btn {
    margin-left: auto;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    border-radius: 6px;
    color: var(--color-muted-foreground);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.15s, background 0.15s;
  }
  .sidebar-collapse-btn:hover {
    color: var(--color-foreground);
    background: color-mix(in srgb, var(--color-muted) 60%, transparent);
  }
  .sidebar-nav-section {
    display: flex;
    flex-direction: column;
    padding: 8px 8px;
    gap: 2px;
    flex-shrink: 0;
  }
  .sidebar-nav-item {
    display: flex;
    align-items: center;
    height: 36px;
    padding: 0;
    border: none;
    background: none;
    border-radius: 8px;
    color: var(--color-muted-foreground);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
    font-family: inherit;
    overflow: hidden;
  }
  .sidebar-nav-item:hover {
    background: color-mix(in srgb, var(--color-muted) 60%, transparent);
    color: var(--color-foreground);
  }
  .sidebar-nav-item.active {
    background: color-mix(in srgb, var(--color-primary) 15%, transparent);
    color: var(--color-primary);
    font-weight: 600;
  }
  .sidebar-nav-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .sidebar-nav-label {
    margin-left: 4px;
    opacity: 1;
    transition: opacity 150ms ease;
  }
  .sidebar-user-section {
    margin-top: auto;
    padding: 8px 8px;
    flex-shrink: 0;
    border-top: 1px solid color-mix(in srgb, var(--color-border) 50%, transparent);
  }
  .sidebar-user-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    overflow: hidden;
    transition: background 0.15s;
  }
  .sidebar-user-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    flex-shrink: 0;
    object-fit: cover;
  }
  .sidebar-user-avatar-fallback {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    background: color-mix(in srgb, var(--color-muted) 60%, transparent);
    color: var(--color-muted-foreground);
  }
  .sidebar-user-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    opacity: 1;
    transition: opacity 150ms ease;
  }
  .sidebar-user-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sidebar-user-role {
    font-size: 11px;
    color: var(--color-muted-foreground);
    text-transform: capitalize;
  }
  .sidebar.collapsed .sidebar-logo-text,
  .sidebar.collapsed .sidebar-collapse-btn,
  .sidebar.collapsed .sidebar-nav-label { opacity: 0; pointer-events: none; }
  .sidebar.collapsed .sidebar-user-info { opacity: 0; pointer-events: none; }
  .sidebar.collapsed .sidebar-user-chip { padding: 0; justify-content: center; }
  .sidebar.collapsed .sidebar-nav-section { overflow: visible; }
  .sidebar.collapsed .sidebar-nav-item { overflow: visible; }
  .sidebar-tooltip-right { position: relative; }
  .sidebar-tooltip-right::before,
  .sidebar-tooltip-right::after {
    position: absolute;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 0.15s ease, visibility 0.15s ease, transform 0.15s ease;
    z-index: 10100;
  }
  .sidebar-tooltip-right::before {
    content: '';
    top: 50%;
    left: 100%;
    transform: translateY(-50%) translateX(-2px);
    border: 6px solid transparent;
    border-right-color: var(--color-card);
  }
  .sidebar-tooltip-right::after {
    content: attr(data-tooltip);
    top: 50%;
    left: calc(100% + 10px);
    transform: translateY(-50%) translateX(-4px);
    padding: 6px 10px;
    background: var(--color-card);
    color: var(--color-foreground);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    border: 1px solid var(--color-border);
  }
  .sidebar-tooltip-right:hover::before,
  .sidebar-tooltip-right:hover::after {
    opacity: 1;
    visibility: visible;
    transform: translateY(-50%) translateX(0);
  }
  .sidebar-mobile-header { display: none; }
  .sidebar-mobile-backdrop { display: none; }
}
@media (max-width: 768px) {
  .app-shell { padding: 0; }
  .app-content { border-radius: 0; border: none; }
  .sidebar-mobile-header {
    display: flex;
    align-items: center;
    height: 48px;
    padding: 0 12px;
    gap: 12px;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--color-card) 40%, var(--color-background));
    border-bottom: 1px solid var(--color-border);
  }
  .sidebar-mobile-hamburger {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    border-radius: 8px;
    color: var(--color-muted-foreground);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    transition: color 0.15s, background 0.15s;
  }
  .sidebar-mobile-hamburger:hover {
    color: var(--color-foreground);
    background: var(--color-muted);
  }
  .sidebar-mobile-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-foreground);
  }
  .sidebar-mobile-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 998;
    background: rgba(0, 0, 0, 0.4);
    animation: sidebarBackdropFadeIn 0.2s ease;
  }
  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 999;
    width: 260px !important;
    background: color-mix(in srgb, var(--color-card) 40%, var(--color-background));
    transform: translateX(-100%);
    transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: none;
  }
  .sidebar.mobile-open {
    transform: translateX(0);
    box-shadow: 4px 0 24px rgba(0, 0, 0, 0.15);
  }
  .sidebar.collapsed { width: 260px !important; }
  .sidebar.collapsed .sidebar-logo-text,
  .sidebar.collapsed .sidebar-nav-label { opacity: 1; pointer-events: auto; }
  .sidebar.collapsed .sidebar-user-info { opacity: 1; pointer-events: auto; }
  .sidebar-collapse-btn { display: none; }
}
@keyframes sidebarBackdropFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}`

let sidebarCssInjected = false

function useSidebarCSS() {
  useEffect(() => {
    if (sidebarCssInjected) return
    sidebarCssInjected = true
    const style = document.createElement('style')
    style.textContent = SIDEBAR_CSS
    document.head.appendChild(style)
    return () => {
      document.head.removeChild(style)
      sidebarCssInjected = false
    }
  }, [])
}

// ============================================================================
// Types
// ============================================================================

export interface SidebarNavItem {
  path: string
  label: string
  icon: ReactNode
  roles: Role[]
}

interface AppSidebarProps {
  appName: string
  navItems: SidebarNavItem[]
  isMobileOpen: boolean
  onMobileClose: () => void
  /** When set and sidebar is expanded, the logo links to this path. */
  logoHref?: string
}

// ============================================================================
// localStorage helpers
// ============================================================================

const STORAGE_KEY = 'app-sidebar-collapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch { /* storage unavailable (private mode/quota): non-critical */ }
}

// ============================================================================
// Mobile header
// ============================================================================

interface MobileHeaderProps {
  appName: string
  onOpenMenu: () => void
}

export function SidebarMobileHeader({ appName, onOpenMenu }: MobileHeaderProps) {
  useSidebarCSS()

  return (
    <div className="sidebar-mobile-header">
      <button
        type="button"
        className="sidebar-mobile-hamburger"
        onClick={onOpenMenu}
        aria-label="Open menu"
      >
        <Menu size={18} />
      </button>
      <span className="sidebar-mobile-title">{appName}</span>
    </div>
  )
}

// ============================================================================
// AppSidebar
// ============================================================================

export function AppSidebar({ appName, navItems, isMobileOpen, onMobileClose, logoHref }: AppSidebarProps) {
  useSidebarCSS()

  const location = useLocation()
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'

  const [isCollapsed, setIsCollapsed] = useState(readCollapsed)
  const [logoHovered, setLogoHovered] = useState(false)

  const sidebarWidth = isCollapsed ? 52 : 240

  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const roleConfig = ROLE_CONFIG[userRole] ?? ROLE_CONFIG[ROLES.VIEWER]

  const visibleNavItems = isAdmin
    ? navItems
    : navItems.filter(item => item.roles.includes(userRole))

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => {
      const next = !prev
      writeCollapsed(next)
      return next
    })
  }, [])

  // Close mobile drawer on route change
  useEffect(() => {
    onMobileClose()
  }, [location.pathname, onMobileClose])

  const handleLogoClick = () => {
    if (isMobileOpen) {
      onMobileClose()
    } else if (isCollapsed) {
      toggleCollapsed()
    }
  }

  const showTooltip = isCollapsed && !isMobileOpen

  const sidebarClasses = [
    'sidebar',
    isCollapsed ? 'collapsed' : '',
    isMobileOpen ? 'mobile-open' : '',
  ].filter(Boolean).join(' ')

  return (
    <>
      {isMobileOpen && (
        <div className="sidebar-mobile-backdrop" onClick={onMobileClose} />
      )}

      <nav
        className={sidebarClasses}
        style={{ width: sidebarWidth }}
      >
        {/* Logo row */}
        <div className="sidebar-logo-row">
          {isCollapsed && !isMobileOpen ? (
            <button
              type="button"
              className={`sidebar-logo-btn ${showTooltip ? 'sidebar-tooltip-right' : ''}`}
              onClick={handleLogoClick}
              data-tooltip={showTooltip ? 'Open Sidebar' : undefined}
              onMouseEnter={() => setLogoHovered(true)}
              onMouseLeave={() => setLogoHovered(false)}
            >
              {showTooltip && logoHovered ? (
                <PanelLeft size={18} />
              ) : (
                <Zap size={18} />
              )}
            </button>
          ) : logoHref ? (
            <Link to={logoHref} className="sidebar-logo-btn">
              <Zap size={18} />
            </Link>
          ) : (
            <button type="button" className="sidebar-logo-btn" onClick={handleLogoClick}>
              <Zap size={18} />
            </button>
          )}
          {logoHref && !isCollapsed ? (
            <Link to={logoHref} className="sidebar-logo-text">{appName}</Link>
          ) : (
            <span className="sidebar-logo-text">{appName}</span>
          )}
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={toggleCollapsed}
            title="Collapse sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>

        {/* Navigation items */}
        <div className="sidebar-nav-section">
          {visibleNavItems.map(item => {
            const isActive = location.pathname === item.path
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`sidebar-nav-item ${isActive ? 'active' : ''} ${showTooltip ? 'sidebar-tooltip-right' : ''}`}
                data-tooltip={showTooltip ? item.label : undefined}
              >
                <span className="sidebar-nav-icon">{item.icon}</span>
                <span className="sidebar-nav-label">{item.label}</span>
              </Link>
            )
          })}
        </div>

        {/* User chip pinned to bottom */}
        {user && (
          <div className="sidebar-user-section">
            <div className="sidebar-user-chip">
              {user.imageUrl ? (
                <img
                  src={user.imageUrl}
                  alt=""
                  className="sidebar-user-avatar"
                />
              ) : (
                <div className="sidebar-user-avatar-fallback">
                  {user.name?.[0]?.toUpperCase() ?? '?'}
                </div>
              )}
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{user.name}</span>
                <span className="sidebar-user-role">{roleConfig.title}</span>
              </div>
            </div>
          </div>
        )}
      </nav>
    </>
  )
}

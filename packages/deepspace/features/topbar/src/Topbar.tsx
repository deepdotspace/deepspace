/**
 * Topbar Component - Horizontal Navigation Bar
 *
 * A top navigation bar with:
 * - Logo/brand area
 * - Horizontal nav links
 * - Search (optional)
 * - User menu
 * - Notification bell
 */

import React, { useState, useRef, useEffect, type ReactNode } from 'react'

// ============================================================================
// Types
// ============================================================================

export interface NavItem {
  id: string
  label: string
  path?: string
  icon?: ReactNode
  badge?: number | string
  onClick?: () => void
}

interface TopbarProps {
  /** Logo or brand element */
  logo?: ReactNode
  /** Navigation items */
  navItems?: NavItem[]
  /** Currently active item ID */
  activeId?: string
  /** Callback when nav item clicked */
  onNavigate?: (item: NavItem) => void
  /** Show search input */
  showSearch?: boolean
  /** Search placeholder */
  searchPlaceholder?: string
  /** Search callback */
  onSearch?: (query: string) => void
  /** Notification count */
  notificationCount?: number
  /** Notification click handler */
  onNotificationClick?: () => void
  /** User info */
  user?: {
    name?: string
    email?: string
    imageUrl?: string
  }
  /** User menu items */
  userMenuItems?: Array<{
    id: string
    label: string
    icon?: ReactNode
    onClick?: () => void
    danger?: boolean
  }>
  /** Custom right-side content */
  rightContent?: ReactNode
  /** Sticky positioning */
  sticky?: boolean
}

// ============================================================================
// Icons
// ============================================================================

function SearchIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function BellIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function ChevronDownIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

// ============================================================================
// Dropdown Menu
// ============================================================================

interface DropdownProps {
  trigger: ReactNode
  children: ReactNode
  align?: 'left' | 'right'
}

function Dropdown({ trigger, children, align = 'right' }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      {isOpen && (
        <div
          className={`
            absolute top-full mt-2 min-w-[200px] bg-card rounded-lg border border-border
            shadow-lg py-1 z-50
            ${align === 'right' ? 'right-0' : 'left-0'}
          `}
        >
          {children}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Topbar Component
// ============================================================================

export default function Topbar({
  logo,
  navItems = [],
  activeId,
  onNavigate,
  showSearch = false,
  searchPlaceholder = 'Search...',
  onSearch,
  notificationCount,
  onNotificationClick,
  user,
  userMenuItems = [],
  rightContent,
  sticky = true,
}: TopbarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    onSearch?.(searchQuery)
  }

  return (
    <header
      className={`
        bg-card/80 backdrop-blur-xl border-b border-border z-40
        ${sticky ? 'sticky top-0' : ''}
      `}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Logo + Nav */}
          <div className="flex items-center gap-8">
            {logo && (
              <div className="flex-shrink-0">
                {logo}
              </div>
            )}

            {navItems.length > 0 && (
              <nav className="hidden md:flex items-center gap-1">
                {navItems.map((item) => {
                  const isActive = activeId === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        item.onClick?.()
                        onNavigate?.(item)
                      }}
                      className={`
                        flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
                        ${isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                        }
                      `}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                      {item.badge !== undefined && (
                        <span className={`
                          text-xs px-1.5 py-0.5 rounded-full
                          ${isActive ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}
                        `}>
                          {item.badge}
                        </span>
                      )}
                    </button>
                  )
                })}
              </nav>
            )}
          </div>

          {/* Right: Search, Notifications, User */}
          <div className="flex items-center gap-3">
            {showSearch && (
              <form onSubmit={handleSearch} className="hidden sm:block">
                <div className="relative">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={searchPlaceholder}
                    className="
                      w-64 pl-10 pr-4 py-2 text-sm
                      bg-muted border border-border rounded-lg
                      text-foreground placeholder:text-muted-foreground
                      focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary
                    "
                  />
                </div>
              </form>
            )}

            {rightContent}

            {onNotificationClick && (
              <button
                onClick={onNotificationClick}
                className="relative p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <BellIcon />
                {notificationCount !== undefined && notificationCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center text-[10px] font-bold text-destructive-foreground bg-destructive rounded-full px-1">
                    {notificationCount > 99 ? '99+' : notificationCount}
                  </span>
                )}
              </button>
            )}

            {user && (
              <Dropdown
                trigger={
                  <button className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted transition-colors">
                    {user.imageUrl ? (
                      <img src={user.imageUrl} alt="" className="w-8 h-8 rounded-full" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                        <span className="text-sm font-medium text-primary">
                          {user.name?.[0]?.toUpperCase() || user.email?.[0]?.toUpperCase() || '?'}
                        </span>
                      </div>
                    )}
                    <span className="hidden lg:block text-sm text-muted-foreground">
                      {user.name || user.email}
                    </span>
                    <ChevronDownIcon className="text-muted-foreground" />
                  </button>
                }
              >
                <div className="px-4 py-3 border-b border-border">
                  <div className="text-sm font-medium text-foreground">{user.name}</div>
                  {user.email && (
                    <div className="text-xs text-muted-foreground truncate">{user.email}</div>
                  )}
                </div>

                <div className="py-1">
                  {userMenuItems.map((item) => (
                    <button
                      key={item.id}
                      onClick={item.onClick}
                      className={`
                        w-full flex items-center gap-3 px-4 py-2 text-sm text-left transition-colors
                        ${item.danger
                          ? 'text-destructive hover:bg-destructive/10'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                        }
                      `}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              </Dropdown>
            )}
          </div>
        </div>
      </div>

      {navItems.length > 0 && (
        <div className="md:hidden border-t border-border px-4 py-2 overflow-x-auto">
          <div className="flex gap-1">
            {navItems.map((item) => {
              const isActive = activeId === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    item.onClick?.()
                    onNavigate?.(item)
                  }}
                  className={`
                    flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors
                    ${isActive
                      ? 'bg-primary/10 text-primary font-medium'
                      : 'text-muted-foreground'
                    }
                  `}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </header>
  )
}

// ============================================================================
// Example Logo Component
// ============================================================================

export function ExampleLogo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center">
        <svg className="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
      </div>
      {!collapsed && <span className="text-lg font-semibold text-foreground">My App</span>}
    </div>
  )
}

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { DocsNavigationNode, DocsRuntimeData } from '../types'
import { externalProps, isExternal, safeStorageGet, safeStorageSet } from './browser'
import { useDialogFocus } from './dialog'
import {
  ChevronDownIcon,
  CloseIcon,
  ExternalIcon,
  MenuIcon,
  MoonIcon,
  OrbitMark,
  SearchIcon,
  SunIcon,
  SystemIcon,
} from './icons'

type ThemeMode = 'light' | 'dark' | 'system'

export function DocsHeader({
  data,
  onMenuOpen,
  onSearchOpen,
}: {
  data: DocsRuntimeData
  onMenuOpen: () => void
  onSearchOpen: () => void
}): ReactElement {
  return (
    <header className="docs-header">
      <a
        className="docs-brand"
        href={data.config.theme.logoHref ?? '/'}
        aria-label={`${data.config.name} documentation home`}
        {...externalProps(data.config.theme.logoHref ?? '/')}
      >
        <BrandLogo data={data} />
      </a>
      <div className="docs-header-center">
        <button className="docs-search-trigger" type="button" onClick={onSearchOpen} aria-label="Search documentation">
          <SearchIcon />
          <span>Search documentation</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="docs-top-links" aria-label="Product navigation">
        {data.config.links.map((link) => (
          <a key={`${link.label}:${link.href}`} href={link.href} {...externalProps(link.href)}>
            {link.label}
            {isExternal(link.href) && <ExternalIcon />}
          </a>
        ))}
      </nav>
      <div className="docs-mobile-actions">
        <button className="docs-icon-button" type="button" onClick={onSearchOpen} aria-label="Search documentation"><SearchIcon /></button>
        <button className="docs-icon-button" type="button" onClick={onMenuOpen} aria-label="Open documentation navigation"><MenuIcon /></button>
      </div>
    </header>
  )
}

function BrandLogo({ data }: { data: DocsRuntimeData }): ReactElement {
  const { logo, logoDark } = data.config.theme
  if (logo) {
    return (
      <>
        <img className="docs-brand-logo docs-brand-logo-light" src={logo} alt="" />
        <img className="docs-brand-logo docs-brand-logo-dark" src={logoDark ?? logo} alt="" />
        <span className="docs-brand-product">Docs</span>
      </>
    )
  }
  return (
    <>
      <span className="docs-brand-mark"><OrbitMark /></span>
      <span className="docs-brand-name">{data.config.name}</span>
      <span className="docs-brand-product">Docs</span>
    </>
  )
}

export function DesktopSidebar({ data }: { data: DocsRuntimeData }): ReactElement {
  return (
    <aside className="docs-sidebar" aria-label="Documentation navigation">
      <nav className="docs-page-tree">
        <NavigationTree activeRoute={data.page.route} nodes={data.navigation} />
      </nav>
      <div className="docs-sidebar-footer">
        {!data.config.theme.strictMode && <ThemeControls defaultMode={data.config.theme.defaultMode ?? 'system'} />}
        {data.config.footer.length > 0 && (
          <nav aria-label="Documentation footer">
            {data.config.footer.map((link) => (
              <a key={`${link.label}:${link.href}`} href={link.href} {...externalProps(link.href)}>{link.label}</a>
            ))}
          </nav>
        )}
        <span>Built on DeepSpace</span>
      </div>
    </aside>
  )
}

function NavigationTree({
  activeRoute,
  depth = 0,
  nodes,
}: {
  activeRoute: string
  depth?: number
  nodes: DocsNavigationNode[]
}): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'group') {
          const active = containsRoute(node, activeRoute)
          if (depth === 0) {
            return (
              <section className="docs-nav-section" key={`group:${node.label}`}>
                <h2>{node.label}</h2>
                <NavigationTree activeRoute={activeRoute} depth={depth + 1} nodes={node.items} />
              </section>
            )
          }
          return (
            <details className="docs-nav-folder" key={`group:${node.label}`} open={active}>
              <summary><span>{node.label}</span><ChevronDownIcon /></summary>
              <div><NavigationTree activeRoute={activeRoute} depth={depth + 1} nodes={node.items} /></div>
            </details>
          )
        }
        const href = node.kind === 'page' ? node.route : node.href
        const active = node.kind === 'page' && node.route === activeRoute
        return (
          <a
            aria-current={active ? 'page' : undefined}
            className={active ? 'docs-nav-link is-active' : 'docs-nav-link'}
            href={href}
            key={`${node.kind}:${href}`}
            {...externalProps(href)}
          >
            <span>{node.label}</span>
            {isExternal(href) && <ExternalIcon />}
          </a>
        )
      })}
    </>
  )
}

export function MobileNavigation({
  data,
  onClose,
  open,
}: {
  data: DocsRuntimeData
  onClose: () => void
  open: boolean
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, dialogRef, onClose)
  if (!open) return null
  return (
    <div className="docs-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <div className="docs-mobile-nav" role="dialog" aria-modal="true" aria-label="Documentation navigation" ref={dialogRef}>
        <header>
          <a
            aria-label={`${data.config.name} documentation home`}
            className="docs-brand"
            href={data.config.theme.logoHref ?? '/'}
            {...externalProps(data.config.theme.logoHref ?? '/')}
          >
            <BrandLogo data={data} />
          </a>
          <button className="docs-icon-button" type="button" onClick={onClose} aria-label="Close documentation navigation" data-autofocus><CloseIcon /></button>
        </header>
        <nav className="docs-page-tree"><NavigationTree activeRoute={data.page.route} nodes={data.navigation} /></nav>
        <footer>
          {!data.config.theme.strictMode && <ThemeControls defaultMode={data.config.theme.defaultMode ?? 'system'} />}
          {data.config.footer.map((link) => <a key={`${link.label}:${link.href}`} href={link.href} {...externalProps(link.href)}>{link.label}</a>)}
        </footer>
      </div>
    </div>
  )
}

function ThemeControls({ defaultMode }: { defaultMode: ThemeMode }): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(defaultMode)
  useEffect(() => {
    const saved = safeStorageGet('deepspace-docs-theme') as ThemeMode | null
    if (saved === 'light' || saved === 'dark' || saved === 'system') setMode(saved)
  }, [])
  useEffect(() => applyThemeMode(mode), [mode])
  const choose = (next: ThemeMode): void => {
    setMode(next)
    safeStorageSet('deepspace-docs-theme', next)
  }
  return (
    <div className="docs-theme-controls" role="group" aria-label="Theme preference">
      <button aria-pressed={mode === 'system'} aria-label="Use system theme" onClick={() => choose('system')} type="button"><SystemIcon /></button>
      <button aria-pressed={mode === 'light'} aria-label="Use light theme" onClick={() => choose('light')} type="button"><SunIcon /></button>
      <button aria-pressed={mode === 'dark'} aria-label="Use dark theme" onClick={() => choose('dark')} type="button"><MoonIcon /></button>
    </div>
  )
}

function containsRoute(node: Extract<DocsNavigationNode, { kind: 'group' }>, route: string): boolean {
  return node.items.some((item) => item.kind === 'page'
    ? item.route === route
    : item.kind === 'group' && containsRoute(item, route))
}

function applyThemeMode(mode: ThemeMode): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const apply = (): void => {
    document.documentElement.dataset.themeMode = mode
    document.documentElement.dataset.theme = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
  }
  apply()
  media.addEventListener?.('change', apply)
  return () => media.removeEventListener?.('change', apply)
}

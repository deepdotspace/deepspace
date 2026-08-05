import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { DocumentationNavigationNode, DocumentationRuntimeData } from '../types'
import { documentationPublicPath } from '../routing'
import { documentationSubject } from '../text'
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

export function DocumentationHeader({
  data,
  onMenuOpen,
  onSearchOpen,
}: {
  data: DocumentationRuntimeData
  onMenuOpen: () => void
  onSearchOpen: () => void
}): ReactElement {
  return (
    <header className="documentation-header">
      <a
        className="documentation-brand"
        href={data.config.theme.logoHref ?? documentationPublicPath(data.basePath, '/')}
        aria-label={`${documentationSubject(data.config.name)} home`}
        {...externalProps(data.config.theme.logoHref ?? documentationPublicPath(data.basePath, '/'))}
      >
        <BrandLogo data={data} />
      </a>
      <div className="documentation-header-center">
        <button className="documentation-search-trigger" type="button" onClick={onSearchOpen} aria-label="Search documentation">
          <SearchIcon />
          <span>Search documentation</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
      <nav className="documentation-top-links" aria-label="Product navigation">
        {data.config.links.map((link) => (
          <a key={`${link.label}:${link.href}`} href={link.href} {...externalProps(link.href)}>
            {link.label}
            {isExternal(link.href) && <ExternalIcon />}
          </a>
        ))}
      </nav>
      <div className="documentation-mobile-actions">
        <button className="documentation-icon-button" type="button" onClick={onSearchOpen} aria-label="Search documentation"><SearchIcon /></button>
        <button className="documentation-icon-button" type="button" onClick={onMenuOpen} aria-label="Open documentation navigation"><MenuIcon /></button>
      </div>
    </header>
  )
}

function BrandLogo({ data }: { data: DocumentationRuntimeData }): ReactElement {
  const { logo, logoDark } = data.config.theme
  if (logo) {
    return (
      <>
        <img className="documentation-brand-logo documentation-brand-logo-light" src={logo} alt="" />
        <img className="documentation-brand-logo documentation-brand-logo-dark" src={logoDark ?? logo} alt="" />
        <span className="documentation-brand-product">Documentation</span>
      </>
    )
  }
  return (
    <>
      <span className="documentation-brand-mark"><OrbitMark /></span>
      <span className="documentation-brand-name">{data.config.name}</span>
    </>
  )
}

export function DesktopSidebar({ data }: { data: DocumentationRuntimeData }): ReactElement {
  return (
    <aside className="documentation-sidebar" aria-label="Documentation navigation">
      <nav className="documentation-page-tree">
        <NavigationTree activeRoute={data.page.route} basePath={data.basePath} nodes={data.navigation} />
      </nav>
      <div className="documentation-sidebar-footer">
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
  basePath,
  depth = 0,
  nodes,
}: {
  activeRoute: string
  basePath: string
  depth?: number
  nodes: DocumentationNavigationNode[]
}): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        if (node.kind === 'group') {
          const active = containsRoute(node, activeRoute)
          if (depth === 0) {
            return (
              <section className="documentation-nav-section" key={`group:${node.label}`}>
                <h2>{node.label}</h2>
                <NavigationTree activeRoute={activeRoute} basePath={basePath} depth={depth + 1} nodes={node.items} />
              </section>
            )
          }
          return (
            <details className="documentation-nav-folder" key={`group:${node.label}`} open={active}>
              <summary><span>{node.label}</span><ChevronDownIcon /></summary>
              <div><NavigationTree activeRoute={activeRoute} basePath={basePath} depth={depth + 1} nodes={node.items} /></div>
            </details>
          )
        }
        const href = node.kind === 'page' ? documentationPublicPath(basePath, node.route) : node.href
        const active = node.kind === 'page' && node.route === activeRoute
        return (
          <a
            aria-current={active ? 'page' : undefined}
            className={active ? 'documentation-nav-link is-active' : 'documentation-nav-link'}
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
  data: DocumentationRuntimeData
  onClose: () => void
  open: boolean
}): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(open, dialogRef, onClose)
  if (!open) return null
  return (
    <div className="documentation-modal-layer" role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) onClose()
    }}>
      <div className="documentation-mobile-nav" role="dialog" aria-modal="true" aria-label="Documentation navigation" ref={dialogRef}>
        <header>
          <a
            aria-label={`${documentationSubject(data.config.name)} home`}
            className="documentation-brand"
            href={data.config.theme.logoHref ?? documentationPublicPath(data.basePath, '/')}
            {...externalProps(data.config.theme.logoHref ?? documentationPublicPath(data.basePath, '/'))}
          >
            <BrandLogo data={data} />
          </a>
          <button className="documentation-icon-button" type="button" onClick={onClose} aria-label="Close documentation navigation" data-autofocus><CloseIcon /></button>
        </header>
        <nav className="documentation-page-tree"><NavigationTree activeRoute={data.page.route} basePath={data.basePath} nodes={data.navigation} /></nav>
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
    const saved = safeStorageGet('deepspace-documentation-theme') as ThemeMode | null
    if (saved === 'light' || saved === 'dark' || saved === 'system') setMode(saved)
  }, [])
  useEffect(() => applyThemeMode(mode), [mode])
  const choose = (next: ThemeMode): void => {
    setMode(next)
    safeStorageSet('deepspace-documentation-theme', next)
  }
  return (
    <div className="documentation-theme-controls" role="group" aria-label="Theme preference">
      <button aria-pressed={mode === 'system'} aria-label="Use system theme" onClick={() => choose('system')} type="button"><SystemIcon /></button>
      <button aria-pressed={mode === 'light'} aria-label="Use light theme" onClick={() => choose('light')} type="button"><SunIcon /></button>
      <button aria-pressed={mode === 'dark'} aria-label="Use dark theme" onClick={() => choose('dark')} type="button"><MoonIcon /></button>
    </div>
  )
}

function containsRoute(node: Extract<DocumentationNavigationNode, { kind: 'group' }>, route: string): boolean {
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

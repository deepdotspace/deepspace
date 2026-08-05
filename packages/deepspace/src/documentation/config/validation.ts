import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { DocumentationError } from '../types'

export function validateLinks(
  links: Array<{ label: string; href: string }>,
  field: string,
  configPath: string,
): void {
  for (const link of links) {
    if (!/^(?:https?:\/\/|mailto:|\/|#)/i.test(link.href)) {
      throw new DocumentationError(
        `Unsafe ${field} link: ${link.href}`,
        'documentation_config_invalid',
        [{ code: 'unsafe_link', message: `${field}: ${link.href}`, file: configPath }],
      )
    }
  }
}

export function safeChildPath(appDir: string, configured: string, field: string, configPath: string): string {
  if (isAbsolute(configured)) {
    throw new DocumentationError(
      `documentation.json ${field} must be relative to the app directory`,
      'documentation_path_invalid',
      [{ code: 'absolute_path', message: `${field}: ${configured}`, file: configPath }],
    )
  }
  const path = resolve(appDir, configured)
  const rel = relative(appDir, path)
  if (rel === '..' || rel.startsWith(`..${pathSeparator()}`)) {
    throw new DocumentationError(
      `documentation.json ${field} escapes the app directory`,
      'documentation_path_invalid',
      [{ code: 'path_escape', message: `${field}: ${configured}`, file: configPath }],
    )
  }
  if (existsSync(path)) {
    const realRoot = realpathSync(appDir)
    const realPath = realpathSync(path)
    const realRelative = relative(realRoot, realPath)
    if (realRelative === '..' || realRelative.startsWith(`..${pathSeparator()}`)) {
      throw new DocumentationError(
        `documentation.json ${field} resolves outside the app directory`,
        'documentation_path_invalid',
        [{ code: 'path_symlink_escape', message: `${field}: ${configured}`, file: configPath }],
      )
    }
  }
  return path
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${pathSeparator()}`)
}

export function validateRedirects(redirects: Record<string, string>, configPath: string): void {
  for (const [from, to] of Object.entries(redirects)) {
    if (!from.startsWith('/') || !to.startsWith('/')) {
      throw new DocumentationError(
        `Redirects must use absolute site paths: ${from} -> ${to}`,
        'documentation_redirect_invalid',
        [{ code: 'redirect_path', message: `${from} -> ${to}`, file: configPath }],
      )
    }
    if (from === to) {
      throw new DocumentationError(
        `Redirect points to itself: ${from}`,
        'documentation_redirect_invalid',
        [{ code: 'redirect_loop', message: from, file: configPath }],
      )
    }
    const seen = new Set([from])
    let cursor: string | undefined = to
    while (cursor && redirects[cursor]) {
      if (seen.has(cursor)) {
        throw new DocumentationError(
          `Redirect loop includes ${cursor}`,
          'documentation_redirect_invalid',
          [{ code: 'redirect_loop', message: [...seen, cursor].join(' -> '), file: configPath }],
        )
      }
      seen.add(cursor)
      cursor = redirects[cursor]
    }
  }
}

export function humanize(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

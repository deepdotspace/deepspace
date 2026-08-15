import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { documentationPublicPath } from './routing'
import type { DocumentationFontConfig, ResolvedDocumentationTheme } from './types'

export interface DocumentationBundledFont {
  family: string
  fileName: string
  /** Variable axis range, so one file serves every weight the stylesheet asks for. */
  weight: string
}

export const DOCUMENTATION_BUNDLED_BODY_FONT: DocumentationBundledFont = {
  family: 'Inter',
  fileName: 'inter-variable.woff2',
  weight: '100 900',
}

export const DOCUMENTATION_BUNDLED_MONO_FONT: DocumentationBundledFont = {
  family: 'Geist Mono',
  fileName: 'geist-mono-variable.woff2',
  weight: '100 900',
}

export const DOCUMENTATION_BUNDLED_FONTS: readonly DocumentationBundledFont[] = [
  DOCUMENTATION_BUNDLED_BODY_FONT,
  DOCUMENTATION_BUNDLED_MONO_FONT,
]

export interface DocumentationResolvedFont {
  family: string
  source: string
  weight: string
  format: string
  /** Set when the bytes come from this package rather than the app's media directory. */
  bundled?: DocumentationBundledFont
}

/**
 * One ordered list of faces the page must load, whether they are bundled with the
 * SDK or supplied by the app. `renderFontFaces`, `renderFontPreloads`, and the
 * build's asset emission all read this so a face can never be declared without
 * its bytes being written, or written without being declared.
 *
 * A slot the author configured without a `source` names a font they provide
 * themselves (system-installed or a custom stylesheet); it contributes no face.
 */
export function resolveDocumentationFonts(
  theme: ResolvedDocumentationTheme,
  basePath: string,
): DocumentationResolvedFont[] {
  const resolved: DocumentationResolvedFont[] = []
  const seen = new Set<string>()
  const add = (font: DocumentationResolvedFont): void => {
    const key = `${font.family}:${font.source}:${font.weight}`
    if (seen.has(key)) return
    seen.add(key)
    resolved.push(font)
  }
  const addAuthored = (font: DocumentationFontConfig | undefined, fallbackFamily: string): void => {
    if (!font?.source || !validFontSource(font.source)) return
    add({
      family: safeFontFamily(font.family, fallbackFamily),
      source: font.source,
      weight: safeFontWeight(font.weight),
      format: safeFontFormat(font.format),
    })
  }
  const addBundled = (bundled: DocumentationBundledFont): void => add({
    family: bundled.family,
    source: bundledFontHref(basePath, bundled),
    weight: bundled.weight,
    format: 'woff2',
    bundled,
  })

  // An absent heading slot inherits the body family, so it needs no face of its own.
  if (theme.bodyFont) addAuthored(theme.bodyFont, DOCUMENTATION_BUNDLED_BODY_FONT.family)
  else addBundled(DOCUMENTATION_BUNDLED_BODY_FONT)
  addAuthored(theme.headingFont, DOCUMENTATION_BUNDLED_BODY_FONT.family)
  if (theme.monoFont) addAuthored(theme.monoFont, DOCUMENTATION_BUNDLED_MONO_FONT.family)
  else addBundled(DOCUMENTATION_BUNDLED_MONO_FONT)
  return resolved
}

export function bundledFontHref(basePath: string, font: DocumentationBundledFont): string {
  return documentationPublicPath(basePath, `/assets/fonts/${font.fileName}`)
}

/**
 * The build copies these woff2 files to `dist/fonts`, so one module-relative
 * path serves both a published install and a source checkout.
 */
export function readBundledFont(font: DocumentationBundledFont): Uint8Array {
  const path = fileURLToPath(new URL(`./fonts/${font.fileName}`, import.meta.url))
  if (!existsSync(path)) {
    throw new Error(`${font.fileName} is missing from this deepspace installation; reinstall the package`)
  }
  return readFileSync(path)
}

/** Guard against CSS injection through a configured family name. */
export function safeFontFamily(
  value: string | undefined,
  fallback = DOCUMENTATION_BUNDLED_BODY_FONT.family,
): string {
  return value && /^[a-z0-9 ,.'-]{1,80}$/i.test(value) ? value : fallback
}

export function validFontSource(value: string): boolean {
  return /^(?:\/[a-z0-9_./%-]+|https:\/\/[^\s"'()<>]+)$/i.test(value)
}

function safeFontWeight(value: DocumentationFontConfig['weight']): string {
  if (typeof value === 'number') return String(value)
  return /^(?:normal|bold|[1-9]00|[1-9]00\s+[1-9]00)$/i.test(String(value ?? '')) ? String(value) : 'normal'
}

function safeFontFormat(value: string | undefined): string {
  return value && /^[a-z0-9-]{2,20}$/i.test(value) ? value : ''
}

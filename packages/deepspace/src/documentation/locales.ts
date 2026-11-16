import { joinSiteUrl } from './routing'
import type {
  DocumentationLanguageAlternate,
  DocumentationPage,
  DocumentationRuntimeLocalization,
} from './types'

/**
 * The `hreflang` forms Google accepts: an ISO 639-1 language, then an optional
 * ISO 15924 script and an optional ISO 3166-1 alpha-2 region. Numeric regions
 * such as `es-419` are deliberately rejected.
 */
export const DOCUMENTATION_LOCALE_CODE_PATTERN = /^[a-z]{2}(?:-[a-z]{4})?(?:-[a-z]{2})?$/i

/** `zh-hans-cn` → `zh-Hans-CN`: language lowercase, script title case, region uppercase. */
export function canonicalLocaleCode(code: string): string {
  return code
    .split('-')
    .map((part, index) => {
      if (index === 0) return part.toLowerCase()
      if (part.length === 4) return `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`
      return part.toUpperCase()
    })
    .join('-')
}

/** The source folder and public route prefix for a locale. */
export function localePrefix(code: string): string {
  return code.toLowerCase()
}

/** Place a default-locale logical route under a locale prefix. */
export function localizedRoute(prefix: string, route: string): string {
  return route === '/' ? `/${prefix}` : `/${prefix}${route}`
}

/** The locale a logical route belongs to: its first segment's prefix, else the default. */
export function localeForRoute(
  route: string,
  localization: Pick<DocumentationRuntimeLocalization, 'locales'>,
): string | undefined {
  const first = route.split('/')[1] ?? ''
  const match = localization.locales.find((locale) => locale.prefix !== '' && locale.prefix === first)
  return (match ?? localization.locales[0])?.code
}

/**
 * A page's language versions as absolute `hreflang` links, itself included, plus
 * `x-default` for the default-locale version; undefined for a single-version page.
 * Every version shares one alternate set, so the links are reciprocal by
 * construction. The page head and the sitemap both use this list.
 */
export function pageLanguageAlternates(
  page: Pick<DocumentationPage, 'alternates'>,
  baseUrl: string,
): DocumentationLanguageAlternate[] | undefined {
  const [defaultVersion] = page.alternates ?? []
  if (!page.alternates || !defaultVersion) return undefined
  return [
    ...page.alternates.map((alternate) => ({
      hreflang: alternate.locale,
      href: joinSiteUrl(baseUrl, alternate.route),
    })),
    { hreflang: 'x-default', href: joinSiteUrl(baseUrl, defaultVersion.route) },
  ]
}

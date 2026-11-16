import type { z } from 'zod'
import type { themeObjectSchema } from './config/schema'

export const DOCUMENTATION_CONFIG_FILE = 'documentation.json'
export const DOCUMENTATION_MANIFEST_VERSION = 2

export type DocumentationAssistantAccess = 'disabled' | 'public' | 'authenticated'
export type DocumentationMcpAccess = 'disabled' | 'public'
export const DOCUMENTATION_CONTEXTUAL_ACTIONS = [
  'copy',
  'view',
  'assistant',
  'chatgpt',
  'claude',
  'mcp',
  'add-mcp',
  'cursor',
  'vscode',
] as const
export type DocumentationContextualAction = (typeof DOCUMENTATION_CONTEXTUAL_ACTIONS)[number]
export const DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS: readonly DocumentationContextualAction[] =
  DOCUMENTATION_CONTEXTUAL_ACTIONS

export interface DocumentationFontConfig {
  family: string
  weight?: number | string
  source?: string
  format?: string
}

/**
 * The `theme` object as authored in documentation.json — exactly the keys
 * the config schema accepts under `theme.*`, derived from that schema so
 * the two can never drift. Everything else (fonts, background decoration,
 * styling, logo href) is configured through the Mintlify-style top-level
 * keys and only exists on the resolved theme.
 */
export type DocumentationThemeConfig = z.infer<typeof themeObjectSchema>

/**
 * The fully resolved theme after config loading merges `theme.*` with the
 * Mintlify top-level keys (`colors`, `logo`, `favicon`, `appearance`,
 * `background`, `fonts`, `styling`). This is what the template and runtime
 * consume; it is an output shape, never accepted as `theme.*` input.
 */
export interface ResolvedDocumentationTheme extends DocumentationThemeConfig {
  backgroundDark?: string
  backgroundDecoration?: 'none' | 'gradient' | 'grid'
  bodyFont?: DocumentationFontConfig
  headingFont?: DocumentationFontConfig
  monoFont?: DocumentationFontConfig
  codeBlockMode?: 'dark' | 'system'
  eyebrowStyle?: 'section' | 'breadcrumbs' | 'none'
  logoHref?: string
}

export interface DocumentationLinkConfig {
  label: string
  href: string
}

export interface DocumentationNavGroup {
  group: string
  pages: DocumentationNavigationItem[]
}

export type DocumentationNavigationItem = string | DocumentationLinkConfig | DocumentationNavGroup

export const DOCUMENTATION_OPENAPI_SAMPLE_LANGUAGES = ['curl', 'javascript', 'python', 'go'] as const
export type DocumentationOpenApiSampleLanguage = (typeof DOCUMENTATION_OPENAPI_SAMPLE_LANGUAGES)[number]
export type DocumentationOpenApiSampleDefaults = 'required' | 'all'

export interface DocumentationOpenApiExamplesConfig {
  languages: DocumentationOpenApiSampleLanguage[]
  defaults: DocumentationOpenApiSampleDefaults
  autogenerate: boolean
}

export const DEFAULT_DOCUMENTATION_OPENAPI_EXAMPLES = {
  languages: ['curl', 'python', 'javascript', 'go'],
  defaults: 'all',
  autogenerate: true,
} as const satisfies Omit<DocumentationOpenApiExamplesConfig, 'languages'> & {
  languages: readonly DocumentationOpenApiSampleLanguage[]
}

export interface DocumentationOpenApiConfig {
  source: string
  route?: string
  label?: string
  playground?: boolean
  baseUrl?: string
  examples?: DocumentationOpenApiExamplesConfig
}

export interface DocumentationAssistantConfig {
  access: DocumentationAssistantAccess
  model?: string
  suggestions?: string[]
}

export interface DocumentationMcpConfig {
  access: DocumentationMcpAccess
}

export interface DocumentationContextualConfig {
  actions: DocumentationContextualAction[]
}

export interface DocumentationSeoConfig {
  noindex?: boolean
  ogImage?: string
  metaTags?: Record<string, string>
}

export interface DocumentationLocale {
  /** Canonical BCP 47 casing, used verbatim as the `hreflang` and `lang` value. */
  code: string
  /** Switcher label, written in the locale's own language. */
  label: string
}

export interface DocumentationAlternateLocale extends DocumentationLocale {
  /** Lowercased code: the source folder and public route prefix. */
  prefix: string
  /** Navigation group and link labels, keyed by their default-locale label. */
  navigationLabels: Record<string, string>
}

export interface DocumentationLocalesConfig {
  default: DocumentationLocale
  alternates: DocumentationAlternateLocale[]
}

export interface DocumentationConfig {
  $schema?: string
  name: string
  description?: string
  source: string
  output: string
  url?: string
  /** Explicit custom hostnames that mount this documentation at `/`. */
  domains: string[]
  theme: ResolvedDocumentationTheme
  navigation?: DocumentationNavigationItem[]
  links: DocumentationLinkConfig[]
  footer: DocumentationLinkConfig[]
  redirects: Record<string, string>
  openapi: DocumentationOpenApiConfig[]
  assistant: DocumentationAssistantConfig
  mcp: DocumentationMcpConfig
  contextual: DocumentationContextualConfig
  seo: DocumentationSeoConfig
  /** Absent unless the site opts into translated pages. */
  locales?: DocumentationLocalesConfig
}

export interface DocumentationFrontmatter {
  title?: string
  description?: string
  slug?: string
  hidden?: boolean
  noindex?: boolean
  /** Translations only: the hash of the default-locale source they were translated from. */
  sourceHash?: string
}

export interface DocumentationHeading {
  depth: number
  id: string
  text: string
}

export interface DocumentationPage {
  sourcePath: string
  relativePath: string
  route: string
  title: string
  description?: string
  hidden: boolean
  noindex: boolean
  markdown: string
  html: string
  text: string
  headings: DocumentationHeading[]
  sourceFormat: 'markdown' | 'mdx' | 'generated'
  kind: 'page' | 'openapi'
  openapi?: DocumentationOpenApiOperation
  /**
   * MDX pages only: the authored source with references resolved and the
   * shell-owned H1 removed, which the executable runtime compiles.
   */
  mdxSource?: string
  /** Set only on translations; default-locale pages carry no locale. */
  locale?: string
  /** Every published language version of this page, itself included, when it has more than one. */
  alternates?: DocumentationPageAlternate[]
  translation?: DocumentationTranslationSource
}

export interface DocumentationPageAlternate {
  locale: string
  route: string
}

export interface DocumentationTranslationSource {
  sourceRoute: string
  /** The default-locale source changed after this translation recorded its `sourceHash`. */
  stale: boolean
}

export interface DocumentationNavigationPage {
  kind: 'page'
  route: string
  label: string
}

export interface DocumentationNavigationLink {
  kind: 'link'
  href: string
  label: string
}

export interface DocumentationNavigationGroup {
  kind: 'group'
  label: string
  items: DocumentationNavigationNode[]
}

export type DocumentationNavigationNode = DocumentationNavigationPage | DocumentationNavigationLink | DocumentationNavigationGroup

export interface DocumentationOpenApiParameter {
  name: string
  in: string
  required: boolean
  description?: string
  schema?: unknown
  example?: unknown
}

export interface DocumentationOpenApiResponse {
  status: string
  description: string
  schema?: unknown
}

export interface DocumentationOpenApiCodeSample {
  language: string
  label: string
  syntax: string
  code: string
  generated: boolean
}

export interface DocumentationOpenApiOperation {
  method: string
  path: string
  operationId: string
  summary: string
  description?: string
  tags: string[]
  parameters: DocumentationOpenApiParameter[]
  requestBody?: unknown
  responses: DocumentationOpenApiResponse[]
  security?: unknown
  baseUrl?: string
  playground: boolean
  codeSamples: DocumentationOpenApiCodeSample[]
}

export interface DocumentationSearchEntry {
  route: string
  title: string
  description?: string
  /** Carries ids so search can offer section results, not only whole pages. */
  headings: DocumentationHeading[]
  text: string
}

export interface DocumentationAssistantChunk {
  id: string
  route: string
  title: string
  heading?: string
  text: string
}

export interface DocumentationGraph {
  config: DocumentationConfig
  pages: DocumentationPage[]
  navigation: DocumentationNavigationNode[]
  /** Per-locale navigation keyed by locale code, derived from `navigation`. */
  localizedNavigation?: Record<string, DocumentationNavigationNode[]>
  sourceHash: string
}

export interface DocumentationBuildManifest {
  version: typeof DOCUMENTATION_MANIFEST_VERSION
  sourceHash: string
  outputHash: string
  /** Version of the `deepspace` package that compiled this output. */
  sdkVersion: string
  name: string
  pageCount: number
  /** Authored pages plus configured redirect entry points. */
  routes: string[]
  /** Exact non-HTML artifacts that may be served from the public mount. */
  resources: string[]
  assistant: DocumentationAssistantConfig
  mcp: DocumentationMcpConfig
  domains: string[]
  /** Default public mount on the ordinary app hostname. */
  basePath: string
}

export interface DocumentationDiagnostic {
  code: string
  message: string
  file?: string
  line?: number
}

export interface DocumentationValidationResult {
  appDir: string
  configPath: string
  sourceDir: string
  outputDir: string
  graph: DocumentationGraph
  warnings: DocumentationDiagnostic[]
}

export interface DocumentationBuildResult extends DocumentationValidationResult {
  manifest: DocumentationBuildManifest
  files: string[]
}

export interface DocumentationRuntimePageLink {
  route: string
  title: string
}

export interface DocumentationRuntimePage {
  route: string
  title: string
  description?: string
  html: string
  headings: DocumentationHeading[]
  kind: DocumentationPage['kind']
  markdownUrl: string
  openapi?: DocumentationOpenApiOperation
}

export interface DocumentationRuntimeLocale extends DocumentationLocale {
  /** Route prefix without slashes; empty for the default locale. */
  prefix: string
  /** Where the switcher lands when the current page has no version in this locale. */
  home?: string
}

/** Site-wide language context for one locale's pages. */
export interface DocumentationRuntimeLocalization {
  locale: string
  /** Default locale first, then the alternates in configuration order. */
  locales: DocumentationRuntimeLocale[]
}

export interface DocumentationRuntimeData {
  /** Public mount (`/docs` on an app host, empty on an explicit documentation domain). */
  basePath: string
  config: Pick<
    DocumentationConfig,
    'name' | 'description' | 'theme' | 'links' | 'footer' | 'assistant' | 'mcp' | 'contextual'
  >
  page: DocumentationRuntimePage
  navigation: DocumentationNavigationNode[]
  breadcrumbs: string[]
  previous?: DocumentationRuntimePageLink
  next?: DocumentationRuntimePageLink
  localization?: DocumentationRuntimeLocalization
  alternates?: DocumentationPageAlternate[]
  translation?: Pick<DocumentationTranslationSource, 'sourceRoute' | 'stale'>
}

export type DocumentationRuntimeRouteData = Omit<
  DocumentationRuntimeData,
  'config' | 'navigation' | 'localization'
>

export interface DocumentationLanguageAlternate {
  hreflang: string
  href: string
}

/** Small per-route payload used by the hydrated documentation router. */
export interface DocumentationRuntimeRouteDocument {
  canonical: string | null
  data: DocumentationRuntimeRouteData
  description: string | null
  openGraph: Record<'og:title' | 'og:description' | 'og:url', string | null>
  robots: string | null
  title: string
  /** Absolute `hreflang` alternates; absent when the page has a single language version. */
  languageAlternates?: DocumentationLanguageAlternate[]
}

export class DocumentationError extends Error {
  readonly code: string
  readonly diagnostics: DocumentationDiagnostic[]

  constructor(message: string, code: string, diagnostics: DocumentationDiagnostic[] = []) {
    super(message)
    this.name = 'DocumentationError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

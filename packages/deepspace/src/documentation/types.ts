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
}

export interface DocumentationFrontmatter {
  title?: string
  description?: string
  slug?: string
  hidden?: boolean
  noindex?: boolean
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
}

export type DocumentationRuntimeRouteData = Omit<DocumentationRuntimeData, 'config' | 'navigation'>

/** Small per-route payload used by the hydrated documentation router. */
export interface DocumentationRuntimeRouteDocument {
  canonical: string | null
  data: DocumentationRuntimeRouteData
  description: string | null
  openGraph: Record<'og:title' | 'og:description' | 'og:url', string | null>
  robots: string | null
  title: string
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

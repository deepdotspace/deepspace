export const DOCS_CONFIG_FILE = 'docs.json'
export const DOCS_MANIFEST_VERSION = 1

export type DocsAssistantAccess = 'disabled' | 'public' | 'authenticated'
export type DocsMcpAccess = 'disabled' | 'public'
export const DOCS_CONTEXTUAL_ACTIONS = [
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
export type DocsContextualAction = (typeof DOCS_CONTEXTUAL_ACTIONS)[number]
export const DEFAULT_DOCS_CONTEXTUAL_ACTIONS: readonly DocsContextualAction[] =
  DOCS_CONTEXTUAL_ACTIONS

export interface DocsFontConfig {
  family: string
  weight?: number | string
  source?: string
  format?: string
}

export interface DocsThemeConfig {
  preset?: string
  accent?: string
  background?: string
  backgroundDark?: string
  backgroundDecoration?: 'none' | 'gradient' | 'grid'
  bodyFont?: DocsFontConfig
  headingFont?: DocsFontConfig
  monoFont?: DocsFontConfig
  codeBlockMode?: 'dark' | 'system'
  eyebrowStyle?: 'section' | 'breadcrumbs' | 'none'
  logo?: string
  logoDark?: string
  logoHref?: string
  favicon?: string
  defaultMode?: 'light' | 'dark' | 'system'
  strictMode?: boolean
}

export interface DocsLinkConfig {
  label: string
  href: string
}

export interface DocsNavGroup {
  group: string
  pages: DocsNavigationItem[]
}

export type DocsNavigationItem = string | DocsLinkConfig | DocsNavGroup

export const DOCS_OPENAPI_SAMPLE_LANGUAGES = ['curl', 'javascript', 'python', 'go'] as const
export type DocsOpenApiSampleLanguage = (typeof DOCS_OPENAPI_SAMPLE_LANGUAGES)[number]
export type DocsOpenApiSampleDefaults = 'required' | 'all'

export interface DocsOpenApiExamplesConfig {
  languages: DocsOpenApiSampleLanguage[]
  defaults: DocsOpenApiSampleDefaults
  autogenerate: boolean
}

export const DEFAULT_DOCS_OPENAPI_EXAMPLES = {
  languages: ['curl', 'python', 'javascript', 'go'],
  defaults: 'all',
  autogenerate: true,
} as const satisfies Omit<DocsOpenApiExamplesConfig, 'languages'> & {
  languages: readonly DocsOpenApiSampleLanguage[]
}

export interface DocsOpenApiConfig {
  source: string
  route?: string
  label?: string
  playground?: boolean
  baseUrl?: string
  examples?: DocsOpenApiExamplesConfig
}

export interface DocsAssistantConfig {
  access: DocsAssistantAccess
  model?: string
  suggestions?: string[]
}

export interface DocsMcpConfig {
  access: DocsMcpAccess
}

export interface DocsContextualConfig {
  actions: DocsContextualAction[]
}

export interface DocsSeoConfig {
  noindex?: boolean
  ogImage?: string
  metaTags?: Record<string, string>
}

export interface DocsConfig {
  $schema?: string
  name: string
  description?: string
  source: string
  output: string
  url?: string
  theme: DocsThemeConfig
  navigation?: DocsNavigationItem[]
  links: DocsLinkConfig[]
  footer: DocsLinkConfig[]
  redirects: Record<string, string>
  openapi: DocsOpenApiConfig[]
  assistant: DocsAssistantConfig
  mcp: DocsMcpConfig
  contextual: DocsContextualConfig
  seo: DocsSeoConfig
}

export interface DocsFrontmatter {
  title?: string
  description?: string
  slug?: string
  hidden?: boolean
  noindex?: boolean
}

export interface DocsHeading {
  depth: number
  id: string
  text: string
}

export interface DocsPage {
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
  headings: DocsHeading[]
  sourceFormat: 'markdown' | 'mdx' | 'generated'
  kind: 'page' | 'openapi'
  openapi?: DocsOpenApiOperation
}

export interface DocsNavigationPage {
  kind: 'page'
  route: string
  label: string
}

export interface DocsNavigationLink {
  kind: 'link'
  href: string
  label: string
}

export interface DocsNavigationGroup {
  kind: 'group'
  label: string
  items: DocsNavigationNode[]
}

export type DocsNavigationNode = DocsNavigationPage | DocsNavigationLink | DocsNavigationGroup

export interface DocsOpenApiParameter {
  name: string
  in: string
  required: boolean
  description?: string
  schema?: unknown
  example?: unknown
}

export interface DocsOpenApiResponse {
  status: string
  description: string
  schema?: unknown
}

export interface DocsOpenApiCodeSample {
  language: string
  label: string
  syntax: string
  code: string
  generated: boolean
}

export interface DocsOpenApiOperation {
  method: string
  path: string
  operationId: string
  summary: string
  description?: string
  tags: string[]
  parameters: DocsOpenApiParameter[]
  requestBody?: unknown
  responses: DocsOpenApiResponse[]
  security?: unknown
  baseUrl?: string
  playground: boolean
  codeSamples: DocsOpenApiCodeSample[]
}

export interface DocsSearchEntry {
  route: string
  title: string
  description?: string
  headings: string[]
  text: string
}

export interface DocsAssistantChunk {
  id: string
  route: string
  title: string
  heading?: string
  text: string
}

export interface DocsGraph {
  config: DocsConfig
  pages: DocsPage[]
  navigation: DocsNavigationNode[]
  sourceHash: string
}

export interface DocsBuildManifest {
  version: typeof DOCS_MANIFEST_VERSION
  sourceHash: string
  outputHash: string
  name: string
  pageCount: number
  routes: string[]
  assistant: DocsAssistantConfig
  mcp: DocsMcpConfig
}

export interface DocsDiagnostic {
  code: string
  message: string
  file?: string
  line?: number
}

export interface DocsValidationResult {
  appDir: string
  configPath: string
  sourceDir: string
  outputDir: string
  graph: DocsGraph
  warnings: DocsDiagnostic[]
}

export interface DocsBuildResult extends DocsValidationResult {
  manifest: DocsBuildManifest
  files: string[]
}

export interface DocsRuntimePageLink {
  route: string
  title: string
}

export interface DocsRuntimePage {
  route: string
  title: string
  description?: string
  html: string
  headings: DocsHeading[]
  kind: DocsPage['kind']
  markdownUrl: string
  openapi?: DocsOpenApiOperation
}

export interface DocsRuntimeData {
  config: Pick<
    DocsConfig,
    'name' | 'description' | 'theme' | 'links' | 'footer' | 'assistant' | 'mcp' | 'contextual'
  >
  page: DocsRuntimePage
  navigation: DocsNavigationNode[]
  breadcrumbs: string[]
  previous?: DocsRuntimePageLink
  next?: DocsRuntimePageLink
}

export type DocsRuntimeRouteData = Omit<DocsRuntimeData, 'config' | 'navigation'>

/** Small per-route payload used by the hydrated docs router. */
export interface DocsRuntimeRouteDocument {
  canonical: string | null
  data: DocsRuntimeRouteData
  description: string | null
  openGraph: Record<'og:title' | 'og:description' | 'og:url', string | null>
  robots: string | null
  title: string
}

export class DocsError extends Error {
  readonly code: string
  readonly diagnostics: DocsDiagnostic[]

  constructor(message: string, code: string, diagnostics: DocsDiagnostic[] = []) {
    super(message)
    this.name = 'DocsError'
    this.code = code
    this.diagnostics = diagnostics
  }
}

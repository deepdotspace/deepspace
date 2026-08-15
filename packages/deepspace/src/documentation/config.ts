import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  getDeepSpaceAIModel,
  listDeepSpaceAgentModels,
  resolveDeepSpaceAgentModel,
} from '../shared/ai-models'
import {
  DOCUMENTATION_CONFIG_FILE,
  DEFAULT_DOCUMENTATION_OPENAPI_EXAMPLES,
  DocumentationError,
  type DocumentationConfig,
  type DocumentationDiagnostic,
  type DocumentationNavigationItem,
  type DocumentationOpenApiConfig,
} from './types'
import { RAW_CONFIG_KEYS, THEME_CONFIG_KEYS, openapiItemSchema, rawConfigSchema } from './config/schema'
import {
  humanize,
  isWithin,
  safeChildPath,
  validateLinks,
  validateRedirects,
} from './config/validation'
import { errorMessage } from './text'

export interface LoadedDocumentationConfig {
  config: DocumentationConfig
  configPath: string
  sourceDir: string
  outputDir: string
  raw: string
  warnings: DocumentationDiagnostic[]
}

export function loadDocumentationConfig(appDir: string): LoadedDocumentationConfig {
  const resolvedAppDir = resolve(appDir)
  const configPath = resolve(resolvedAppDir, DOCUMENTATION_CONFIG_FILE)
  if (!existsSync(configPath)) {
    throw new DocumentationError(
      `No ${DOCUMENTATION_CONFIG_FILE} found in ${resolvedAppDir}`,
      'documentation_config_missing',
      [{ code: 'documentation_config_missing', message: `Create ${DOCUMENTATION_CONFIG_FILE}`, file: configPath }],
    )
  }

  const raw = readFileSync(configPath, 'utf8')
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch (error) {
    throw new DocumentationError(
      `${DOCUMENTATION_CONFIG_FILE} is not valid JSON: ${errorMessage(error)}`,
      'documentation_config_invalid',
      [{ code: 'invalid_json', message: errorMessage(error), file: configPath }],
    )
  }

  const parsed = rawConfigSchema.safeParse(input)
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) => ({
      code: 'invalid_config_value',
      message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      file: configPath,
    }))
    throw new DocumentationError(
      `${DOCUMENTATION_CONFIG_FILE} has ${diagnostics.length} validation error(s)`,
      'documentation_config_invalid',
      diagnostics,
    )
  }

  const data = parsed.data
  if (
    data.assistant.model !== undefined &&
    !resolveDeepSpaceAgentModel(data.assistant.model, 'documentation')
  ) {
    const catalogModel = getDeepSpaceAIModel(data.assistant.model)
    const reason = catalogModel
      ? `does not support the multi-step documentation agent (${catalogModel.note ?? 'incompatible runtime contract'})`
      : 'is not in the DeepSpace model catalog'
    const supported = listDeepSpaceAgentModels('documentation')
      .map((model) => model.id)
      .join(', ')
    throw new DocumentationError(
      `${DOCUMENTATION_CONFIG_FILE} has an unsupported assistant model`,
      'documentation_config_invalid',
      [
        {
          code: 'unsupported_assistant_model',
          message: `assistant.model '${data.assistant.model}' ${reason}. Supported models: ${supported}`,
          file: configPath,
        },
      ],
    )
  }
  const warnings: DocumentationDiagnostic[] = []
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const key of Object.keys(input)) {
      if (!RAW_CONFIG_KEYS.has(key)) {
        warnings.push({
          code: 'unsupported_config_key',
          message: `Unsupported Mintlify configuration key '${key}' was ignored`,
          file: configPath,
        })
      }
    }
    const rawTheme = (input as Record<string, unknown>).theme
    if (rawTheme && typeof rawTheme === 'object' && !Array.isArray(rawTheme)) {
      for (const key of Object.keys(rawTheme)) {
        if (!THEME_CONFIG_KEYS.has(key)) {
          warnings.push({
            code: 'unsupported_config_key',
            message: `Unsupported theme configuration key 'theme.${key}' was ignored`,
            file: configPath,
          })
        }
      }
    }
  }
  const themeInput = typeof data.theme === 'string' ? {} : data.theme
  if (typeof data.theme === 'string') {
    warnings.push({
      code: 'mintlify_theme_normalized',
      message: `Mintlify theme '${data.theme}' is mapped to the native Orbit surface`,
      file: configPath,
    })
  }
  const logo = typeof data.logo === 'string' ? { light: data.logo } : data.logo
  const background = data.background?.color
  const bodyFont =
    data.fonts?.body ?? (data.fonts?.family ? { family: data.fonts.family } : undefined)
  const headingFont = data.fonts?.heading ?? bodyFont
  const monoFont = data.fonts?.mono
  const navigation = Array.isArray(data.navigation) ? data.navigation : data.navigation?.groups
  if (data.navigation && !Array.isArray(data.navigation)) {
    warnings.push({
      code: 'mintlify_navigation_normalized',
      message: 'Mintlify navigation.groups was normalized to native navigation',
      file: configPath,
    })
  }
  const navbarLinks = [
    ...(data.navbar?.links ?? []),
    ...(data.navbar?.primary
      ? [{ label: data.navbar.primary.label, href: data.navbar.primary.href }]
      : []),
  ]
  const footer = Array.isArray(data.footer)
    ? data.footer
    : Object.entries(data.footer.socials ?? {}).map(([label, href]) => ({
        label: humanize(label),
        href,
      }))
  const config: DocumentationConfig = {
    $schema: data.$schema,
    name: data.name,
    description: data.description,
    source: data.source,
    output: data.output,
    url: data.url,
    domains: [...new Set(data.domains)],
    theme: {
      ...themeInput,
      accent: themeInput.accent ?? data.colors?.primary ?? data.colors?.light ?? data.colors?.dark,
      // Mintlify's colors.light is "the anchor color used in dark mode".
      accentDark: themeInput.accentDark ?? data.colors?.light,
      background: background?.light ?? themeInput.background,
      backgroundDark: background && 'dark' in background ? background.dark : undefined,
      backgroundDecoration: data.background?.decoration,
      bodyFont,
      headingFont,
      monoFont,
      codeBlockMode: data.styling?.codeblocks,
      eyebrowStyle: data.styling?.eyebrows,
      logo: themeInput.logo ?? logo?.light,
      logoDark: themeInput.logoDark ?? logo?.dark,
      logoHref: logo?.href,
      favicon: themeInput.favicon ?? data.favicon,
      defaultMode: data.appearance?.default ?? themeInput.defaultMode,
      strictMode: themeInput.strictMode ?? data.appearance?.strict,
    },
    navigation: navigation as DocumentationNavigationItem[] | undefined,
    links: data.links.length > 0 ? data.links : navbarLinks,
    footer,
    redirects: data.redirects,
    openapi: normalizeOpenApi(data.openapi, data.api) as DocumentationOpenApiConfig[],
    assistant: data.assistant,
    mcp: data.mcp,
    contextual: data.contextual,
    seo: {
      ...(data.seo.noindex === undefined ? {} : { noindex: data.seo.noindex }),
      ...(data.seo.ogImage ? { ogImage: data.seo.ogImage } : {}),
      ...((data.seo.metaTags ?? data.seo.metatags)
        ? { metaTags: data.seo.metaTags ?? data.seo.metatags }
        : {}),
    },
  }
  validateRedirects(config.redirects, configPath)
  validateLinks(config.links, 'links', configPath)
  validateLinks(config.footer, 'footer', configPath)
  if (config.theme.logoHref) {
    validateLinks([{ label: 'logo', href: config.theme.logoHref }], 'logo.href', configPath)
  }

  const sourceDir = safeChildPath(resolvedAppDir, config.source, 'source', configPath)
  const outputDir = safeChildPath(resolvedAppDir, config.output, 'output', configPath)
  if (sourceDir === outputDir || isWithin(sourceDir, outputDir)) {
    throw new DocumentationError(
      'documentation.json output must not contain the documentation source directory',
      'documentation_path_collision',
      [
        {
          code: 'documentation_path_collision',
          message: `source=${config.source}, output=${config.output}`,
          file: configPath,
        },
      ],
    )
  }

  config.theme = {
    ...config.theme,
    ...(config.theme.logo ? { logo: normalizeLocalAsset(config.theme.logo, sourceDir) } : {}),
    ...(config.theme.logoDark
      ? { logoDark: normalizeLocalAsset(config.theme.logoDark, sourceDir) }
      : {}),
    ...(config.theme.favicon
      ? { favicon: normalizeLocalAsset(config.theme.favicon, sourceDir) }
      : {}),
    ...(config.theme.bodyFont?.source
      ? {
          bodyFont: {
            ...config.theme.bodyFont,
            source: normalizeLocalAsset(config.theme.bodyFont.source, sourceDir),
          },
        }
      : {}),
    ...(config.theme.headingFont?.source
      ? {
          headingFont: {
            ...config.theme.headingFont,
            source: normalizeLocalAsset(config.theme.headingFont.source, sourceDir),
          },
        }
      : {}),
    ...(config.theme.monoFont?.source
      ? {
          monoFont: {
            ...config.theme.monoFont,
            source: normalizeLocalAsset(config.theme.monoFont.source, sourceDir),
          },
        }
      : {}),
  }
  if (config.seo.ogImage) {
    config.seo = {
      ...config.seo,
      ogImage: normalizeLocalAsset(config.seo.ogImage, sourceDir),
    }
  }

  return { config, configPath, sourceDir, outputDir, raw, warnings }
}

function normalizeLocalAsset(value: string, sourceDir: string): string {
  if (/^(?:https?:|data:|\/media\/)/i.test(value)) return value
  const relativePath = value.replace(/^\.\//, '').replace(/^\/+/, '')
  if (!relativePath || !existsSync(resolve(sourceDir, relativePath))) return value
  return `/media/${relativePath.split('\\').join('/')}`
}

function normalizeOpenApi(
  value: z.infer<typeof openapiItemSchema> | Array<z.infer<typeof openapiItemSchema>> | undefined,
  api: z.infer<typeof rawConfigSchema>['api'],
): Array<z.infer<typeof openapiItemSchema>> {
  if (!value) return []
  const items = Array.isArray(value) ? value : [value]
  return items.map((item) => {
    const localExamples = 'examples' in item ? item.examples : undefined
    const display = api?.playground?.display
    return {
      ...item,
      ...('playground' in item && item.playground !== undefined
        ? { playground: item.playground }
        : display
          ? { playground: display === 'interactive' }
          : {}),
      examples: {
        languages: localExamples?.languages ??
          api?.examples?.languages ?? [...DEFAULT_DOCUMENTATION_OPENAPI_EXAMPLES.languages],
        defaults: localExamples?.defaults ??
          api?.examples?.defaults ?? DEFAULT_DOCUMENTATION_OPENAPI_EXAMPLES.defaults,
        autogenerate: localExamples?.autogenerate ??
          api?.examples?.autogenerate ?? DEFAULT_DOCUMENTATION_OPENAPI_EXAMPLES.autogenerate,
      },
    }
  })
}

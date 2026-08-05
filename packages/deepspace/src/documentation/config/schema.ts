import { z } from 'zod'
import {
  DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS,
  DOCUMENTATION_CONTEXTUAL_ACTIONS,
  DOCUMENTATION_OPENAPI_SAMPLE_LANGUAGES,
} from '../types'

const linkSchema = z.object({
  label: z.string().trim().min(1),
  href: z.string().trim().min(1),
})

type NavigationInput =
  | string
  | z.infer<typeof linkSchema>
  | {
      group: string
      pages: NavigationInput[]
    }

const navigationSchema: z.ZodType<NavigationInput> = z.lazy(() =>
  z.union([
    z.string().trim().min(1),
    linkSchema,
    z.object({
      group: z.string().trim().min(1),
      pages: z.array(navigationSchema).min(1),
    }),
  ]),
)

const openApiExamplesSchema = z.object({
  languages: z.array(z.enum(DOCUMENTATION_OPENAPI_SAMPLE_LANGUAGES)).min(1).optional(),
  defaults: z.enum(['required', 'all']).optional(),
  autogenerate: z.boolean().optional(),
})

export const openapiItemSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .transform((source) => ({ source })),
  z.object({
    source: z.string().trim().min(1),
    route: z.string().trim().optional(),
    label: z.string().trim().min(1).optional(),
    playground: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    examples: openApiExamplesSchema.optional(),
  }),
])

const themeObjectSchema = z.object({
  preset: z.string().trim().min(1).optional(),
  accent: z.string().trim().optional(),
  background: z.string().trim().optional(),
  logo: z.string().trim().optional(),
  logoDark: z.string().trim().optional(),
  favicon: z.string().trim().optional(),
  defaultMode: z.enum(['light', 'dark', 'system']).optional(),
})

const fontSpecSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .transform((family) => ({ family })),
  z.object({
    family: z.string().trim().min(1),
    weight: z.union([z.number().int().min(100).max(900), z.string().trim().min(1)]).optional(),
    source: z.string().trim().min(1).optional(),
    format: z.string().trim().min(1).optional(),
  }),
])

const colorPairSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .transform((color) => ({ light: color })),
  z.object({
    light: z.string().trim().min(1).optional(),
    dark: z.string().trim().min(1).optional(),
  }),
])

const navigationRootSchema = z.union([
  z.array(navigationSchema),
  z.object({
    groups: z.array(
      z.object({
        group: z.string().trim().min(1),
        pages: z.array(navigationSchema).min(1),
      }),
    ),
    global: z.record(z.string(), z.unknown()).optional(),
  }),
])

const navbarSchema = z
  .object({
    links: z.array(linkSchema).optional(),
    primary: z
      .object({
        type: z.string().optional(),
        label: z.string().trim().min(1),
        href: z.string().trim().min(1),
      })
      .optional(),
  })
  .optional()

const footerSchema = z.union([
  z.array(linkSchema),
  z.object({ socials: z.record(z.string(), z.string().trim().min(1)).optional() }),
])

const logoSchema = z
  .union([
    z.string().trim().min(1),
    z.object({
      light: z.string().trim().min(1),
      dark: z.string().trim().min(1).optional(),
      href: z.string().trim().min(1).optional(),
    }),
  ])
  .optional()

const contextualActionsSchema = z
  .array(z.enum(DOCUMENTATION_CONTEXTUAL_ACTIONS))
  .min(1)
  .max(DOCUMENTATION_CONTEXTUAL_ACTIONS.length)
  .refine((actions) => new Set(actions).size === actions.length, {
    message: 'actions must not contain duplicates',
  })

const hostnameSchema = z
  .hostname('must be a hostname such as docs.example.com')
  .trim()
  .toLowerCase()
  .refine((value) => value.includes('.'), 'must include a public suffix')

export const rawConfigSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  source: z.string().trim().min(1).default('documentation'),
  output: z.string().trim().min(1).default('dist/_documentation'),
  url: z.string().url().optional(),
  domains: z
    .array(hostnameSchema)
    .max(1, 'one compiled documentation surface has one canonical custom domain')
    .default([]),
  theme: z.union([z.string().trim().min(1), themeObjectSchema]).default({}),
  colors: z
    .object({
      primary: z.string().trim().optional(),
      light: z.string().trim().optional(),
      dark: z.string().trim().optional(),
    })
    .optional(),
  logo: logoSchema,
  favicon: z.string().trim().min(1).optional(),
  appearance: z
    .object({
      default: z.enum(['light', 'dark', 'system']).optional(),
      strict: z.boolean().optional(),
    })
    .optional(),
  background: z
    .object({
      color: colorPairSchema.optional(),
      decoration: z.enum(['none', 'gradient', 'grid']).optional(),
    })
    .optional(),
  fonts: z
    .object({
      family: z.string().trim().min(1).optional(),
      body: fontSpecSchema.optional(),
      heading: fontSpecSchema.optional(),
      mono: fontSpecSchema.optional(),
    })
    .optional(),
  styling: z
    .object({
      codeblocks: z.enum(['dark', 'system']).optional(),
      eyebrows: z.enum(['section', 'breadcrumbs', 'none']).optional(),
    })
    .optional(),
  navigation: navigationRootSchema.optional(),
  navbar: navbarSchema,
  links: z.array(linkSchema).default([]),
  footer: footerSchema.default([]),
  redirects: z.record(z.string(), z.string()).default({}),
  api: z
    .object({
      playground: z
        .object({
          display: z.enum(['interactive', 'simple', 'none']).optional(),
        })
        .optional(),
      examples: openApiExamplesSchema.optional(),
    })
    .optional(),
  openapi: z.union([openapiItemSchema, z.array(openapiItemSchema)]).optional(),
  assistant: z
    .object({
      access: z.enum(['disabled', 'public', 'authenticated']).default('disabled'),
      model: z.string().trim().min(1).optional(),
      suggestions: z.array(z.string().trim().min(1)).max(6).optional(),
    })
    .default({ access: 'disabled' }),
  mcp: z
    .object({
      access: z.enum(['disabled', 'public']).default('public'),
    })
    .default({ access: 'public' }),
  contextual: z
    .object({
      actions: contextualActionsSchema.default([...DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS]),
    })
    .default({ actions: [...DEFAULT_DOCUMENTATION_CONTEXTUAL_ACTIONS] }),
  seo: z
    .object({
      noindex: z.boolean().optional(),
      ogImage: z.string().trim().optional(),
      metaTags: z.record(z.string(), z.string()).optional(),
      metatags: z.record(z.string(), z.string()).optional(),
    })
    .default({}),
})

export const RAW_CONFIG_KEYS = new Set([
  '$schema',
  'name',
  'description',
  'source',
  'output',
  'url',
  'domains',
  'theme',
  'colors',
  'logo',
  'favicon',
  'appearance',
  'background',
  'fonts',
  'styling',
  'navigation',
  'navbar',
  'links',
  'footer',
  'redirects',
  'api',
  'openapi',
  'assistant',
  'mcp',
  'contextual',
  'seo',
])

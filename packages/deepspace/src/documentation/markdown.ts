import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import { parse as parseYaml } from 'yaml'
import { createSlugger, errorMessage, escapeHtml } from './text'
import { DocumentationError, type DocumentationFrontmatter, type DocumentationHeading } from './types'

const COMPONENT_NAMES = [
  'Note',
  'Tip',
  'Warning',
  'Info',
  'Card',
  'Accordion',
  'AccordionGroup',
  'Step',
  'Tab',
  'CodeGroup',
  'Steps',
  'Tabs',
] as const

type ComponentName = (typeof COMPONENT_NAMES)[number]

const LEAF_COMPONENTS: ComponentName[] = [
  'Note',
  'Tip',
  'Warning',
  'Info',
  'Card',
  'Accordion',
  'Step',
  'Tab',
  'CodeGroup',
]

const WRAPPER_COMPONENTS: ComponentName[] = ['AccordionGroup', 'Steps', 'Tabs']

for (const [name, language] of Object.entries({
  bash,
  css,
  html: xml,
  javascript,
  json,
  jsx: javascript,
  markdown,
  md: markdown,
  shell: bash,
  sh: bash,
  ts: typescript,
  tsx: typescript,
  typescript,
  xml,
  yaml,
  yml: yaml,
})) {
  hljs.registerLanguage(name, language)
}

const markdownRenderer = new Marked({
  renderer: {
    code({ text, lang }) {
      const { language, title } = parseCodeFenceInfo(lang)
      const highlighted = language && hljs.getLanguage(language)
        ? hljs.highlight(text, { language, ignoreIllegals: true }).value
        : escapeHtml(text)
      const className = language
        ? ` class="language-${escapeHtml(language)} hljs"`
        : ' class="hljs"'
      return `<pre${title ? ` data-code-title="${escapeHtml(title)}"` : ''}><code${className}>${highlighted}</code></pre>\n`
    },
  },
})

export interface ParsedMarkdown {
  frontmatter: DocumentationFrontmatter
  markdown: string
  html: string
  text: string
  headings: DocumentationHeading[]
}

/** Remove the first authored Markdown H1 because the documentation shell owns the page H1. */
export function stripFirstMarkdownH1(source: string): string {
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)].filter((match) => match[0])
  let inFrontmatter = false
  let frontmatterSeen = false
  let fence: { marker: '`' | '~'; length: number } | undefined
  for (const [index, match] of lines.entries()) {
    const raw = match[0]
    const line = raw.replace(/\r?\n$/, '')
    const content = index === 0 ? line.replace(/^\uFEFF/, '') : line
    if (index === 0 && content === '---') {
      inFrontmatter = true
      frontmatterSeen = true
      continue
    }
    if (inFrontmatter) {
      if (frontmatterSeen && /^(?:---|\.\.\.)\s*$/.test(content)) inFrontmatter = false
      continue
    }
    const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) fence = { marker, length: fenceMatch[1].length }
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined
      continue
    }
    if (fence || !/^ {0,3}#(?:[\t ]+|$)/.test(content)) continue
    const start = match.index ?? 0
    const newline = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : ''
    return `${source.slice(0, start)}${newline}${source.slice(start + raw.length)}`
  }
  return source
}

export function parseMarkdown(source: string, file: string): ParsedMarkdown {
  const { frontmatter, body } = parseFrontmatter(source, file)
  validateExecutableMdx(body, file)

  const placeholders: string[] = []
  let prepared = protectCode(body.replace(/^\uFEFF/, ''), placeholders)
  for (const name of [...LEAF_COMPONENTS, ...WRAPPER_COMPONENTS]) {
    prepared = replaceComponentBlocks(prepared, name, placeholders)
  }

  const rendered = String(markdownRenderer.parse(prepared, { gfm: true, breaks: false }))
  let restored = rendered
  for (let pass = 0; pass < placeholders.length + 1; pass++) {
    let changed = false
    restored = restored.replace(
      /(?:<p>)?@@DEEPSPACE_COMPONENT_(\d+)@@(?:<\/p>)?/g,
      (_match, indexRaw: string) => {
        const replacement = placeholders[Number(indexRaw)]
        if (replacement === undefined) return ''
        changed = true
        return replacement
      },
    )
    if (!changed) break
  }
  restored = restored.replace(
    /<div class="documentation-code-group" data-code-group-pending data-code-group-title="([^"]*)">([\s\S]*?)<\/div>/g,
    (_match, title: string, innerHtml: string) => renderCodeGroup(innerHtml, title),
  )

  const safe = sanitizeHtml(restored, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'article',
      'aside',
      'button',
      'details',
      'div',
      'figure',
      'figcaption',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'input',
      'label',
      'section',
      'span',
      'summary',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'class'],
      aside: ['class'],
      button: ['type', 'class', 'data-copy-code'],
      code: ['class'],
      details: ['class', 'open'],
      div: ['class', 'data-tab-group', 'data-tab-persist'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
      input: ['type', 'checked', 'disabled'],
      pre: ['class', 'data-code-title'],
      section: ['class', 'data-tab', 'data-tab-title'],
      span: ['class'],
      summary: ['class'],
      table: ['class'],
      '*': ['id', 'aria-label', 'aria-hidden', 'role'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'escape',
    transformTags: {
      a: (_tagName, attributes) => {
        const external = /^https?:\/\//i.test(attributes.href ?? '')
        return {
          tagName: 'a',
          attribs: external
            ? { ...attributes, target: '_blank', rel: 'noopener noreferrer' }
            : attributes,
        }
      },
      img: (_tagName, attributes) => ({
        tagName: 'img',
        attribs: { ...attributes, loading: attributes.loading ?? 'lazy' },
      }),
    },
  })

  const { html, headings } = addHeadingIds(safe)
  return {
    frontmatter,
    markdown: body.trim(),
    html,
    text: htmlToText(html),
    headings,
  }
}

export function parseFrontmatter(
  source: string,
  file: string,
): { frontmatter: DocumentationFrontmatter; body: string } {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return { frontmatter: {}, body: source }
  }
  const normalized = source.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new DocumentationError(
      `Unclosed front matter in ${file}`,
      'documentation_frontmatter_invalid',
      [{ code: 'frontmatter_unclosed', message: 'Expected a closing --- line', file, line: 1 }],
    )
  }

  let value: unknown
  try {
    value = parseYaml(normalized.slice(4, end), { maxAliasCount: 20 })
  } catch (error) {
    throw new DocumentationError(
      `Invalid front matter in ${file}: ${errorMessage(error)}`,
      'documentation_frontmatter_invalid',
      [{ code: 'frontmatter_yaml', message: errorMessage(error), file, line: 1 }],
    )
  }
  if (value === null) value = {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentationError(
      `Front matter must be a mapping in ${file}`,
      'documentation_frontmatter_invalid',
      [{ code: 'frontmatter_shape', message: 'Expected key/value front matter', file, line: 1 }],
    )
  }
  const raw = value as Record<string, unknown>
  const frontmatter: DocumentationFrontmatter = {}
  for (const key of ['title', 'description', 'slug'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw frontmatterTypeError(file, key, 'string')
    }
    if (typeof raw[key] === 'string') frontmatter[key] = raw[key]
  }
  for (const key of ['hidden', 'noindex'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
      throw frontmatterTypeError(file, key, 'boolean')
    }
    if (typeof raw[key] === 'boolean') frontmatter[key] = raw[key]
  }
  return { frontmatter, body: normalized.slice(end + 5) }
}

function replaceComponentBlocks(
  source: string,
  name: ComponentName,
  placeholders: string[],
): string {
  const pattern = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'g')
  return source.replace(pattern, (_match, attributesRaw: string | undefined, inner: string) => {
    const attributes = parseAttributes(attributesRaw ?? '')
    const innerHtml = String(markdownRenderer.parse(inner.trim(), { gfm: true, breaks: false }))
    const html = renderComponent(name, attributes, innerHtml)
    const index = placeholders.push(html) - 1
    return `\n\n@@DEEPSPACE_COMPONENT_${index}@@\n\n`
  })
}

function renderComponent(
  name: ComponentName,
  attributes: Record<string, string>,
  innerHtml: string,
): string {
  const title = escapeHtml(attributes.title ?? attributes.label ?? '')
  switch (name) {
    case 'Note':
    case 'Tip':
    case 'Warning':
    case 'Info':
      return `<aside class="documentation-callout documentation-callout-${name.toLowerCase()}">` +
        `${title ? `<strong>${title}</strong>` : `<strong>${name}</strong>`}${innerHtml}</aside>`
    case 'Card': {
      const href = safeHref(attributes.href)
      const content = `${title ? `<strong>${title}</strong>` : ''}${innerHtml}`
      return href
        ? `<a class="documentation-card" href="${escapeHtml(href)}">${content}<span aria-hidden="true">→</span></a>`
        : `<div class="documentation-card">${content}</div>`
    }
    case 'Accordion':
      return `<details class="documentation-accordion"><summary>${title || 'Details'}</summary>${innerHtml}</details>`
    case 'AccordionGroup':
      return `<div class="documentation-accordion-group">${innerHtml}</div>`
    case 'Step':
      return `<section class="documentation-step">${title ? `<h3>${title}</h3>` : ''}${innerHtml}</section>`
    case 'Steps':
      return `<div class="documentation-steps">${innerHtml}</div>`
    case 'Tab':
      return `<section class="documentation-tab" data-tab data-tab-title="${title || 'Tab'}">${innerHtml}</section>`
    case 'Tabs':
      return `<div class="documentation-tabs" data-tab-group>${innerHtml}</div>`
    case 'CodeGroup':
      return `<div class="documentation-code-group" data-code-group-pending data-code-group-title="${title}">${innerHtml}</div>`
  }
}

function renderCodeGroup(innerHtml: string, title: string): string {
  const blocks = [...innerHtml.matchAll(/<pre([^>]*)>([\s\S]*?)<\/pre>/g)]
  if (blocks.length === 0) {
    return `<div class="documentation-code-group">${title ? `<div class="documentation-code-group-title">${title}</div>` : ''}${innerHtml}</div>`
  }
  const tabs = blocks.map((match, index) => {
    const attributes = match[1] ?? ''
    const explicit = attributes.match(/\sdata-code-title="([^"]+)"/)?.[1]
    const language = match[2]?.match(/class="language-([^\s"]+)/)?.[1]
    const label = explicit ?? codeLanguageLabel(language) ?? `Example ${index + 1}`
    return `<section class="documentation-code-tab" data-tab data-tab-title="${escapeHtml(label)}"><pre${attributes}>${match[2]}</pre></section>`
  }).join('')
  return `<div class="documentation-code-group" data-tab-group data-tab-persist="code">${title ? `<div class="documentation-code-group-title">${title}</div>` : ''}${tabs}</div>`
}

export function parseCodeFenceInfo(value: string | undefined): { language?: string; title?: string } {
  const raw = value?.trim() ?? ''
  if (!raw) return {}
  const language = raw.split(/\s+/, 1)[0]?.toLowerCase()
  const metadata = raw.slice(language?.length ?? 0).trim()
  const quotedTitle = metadata.match(/(?:^|\s)title=(?:"([^"]+)"|'([^']+)')/i)
  // A bare token is a title (or code-group tab label) unless it is an option
  // shape: {1,3-4} ranges, key=value pairs, or a known option keyword — those
  // must never render as a header bar.
  const optionKeyword = /^(?:wrap|expandable|twoslash|focus)$/i.test(metadata)
  const bareTitle = metadata && !metadata.includes('=') && !metadata.startsWith('{') && !optionKeyword
    ? metadata
    : undefined
  const title = quotedTitle?.[1] ?? quotedTitle?.[2] ?? bareTitle
  return {
    ...(language ? { language } : {}),
    ...(title ? { title: title.trim() } : {}),
  }
}

function codeLanguageLabel(language: string | undefined): string | undefined {
  if (!language) return undefined
  const names: Record<string, string> = {
    bash: 'Shell',
    javascript: 'JavaScript',
    js: 'JavaScript',
    jsx: 'React',
    shell: 'Shell',
    sh: 'Shell',
    ts: 'TypeScript',
    tsx: 'React',
    typescript: 'TypeScript',
  }
  return names[language] ?? language.toUpperCase()
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of raw.matchAll(pattern)) {
    attributes[match[1]] = match[2] ?? match[3] ?? ''
  }
  return attributes
}

function validateExecutableMdx(body: string, file: string): void {
  const validationBody = stripCodeForValidation(body)
  const lines = validationBody.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\s*(?:import|export)\s/.test(line)) {
      throw new DocumentationError(
        `Executable MDX is not supported in ${file}:${index + 1}`,
        'documentation_mdx_unsafe',
        [{
          code: 'mdx_module_syntax',
          message: 'Use the built-in documentation component vocabulary instead of import/export',
          file,
          line: index + 1,
        }],
      )
    }
    if (/<[A-Za-z][^>]*\son[A-Za-z]+\s*=/.test(line) || /<script\b/i.test(line)) {
      throw new DocumentationError(
        `Active HTML is not supported in ${file}:${index + 1}`,
        'documentation_mdx_unsafe',
        [{
          code: 'active_html',
          message: 'Scripts and inline event handlers are prohibited',
          file,
          line: index + 1,
        }],
      )
    }
    if (/<[A-Z][A-Za-z0-9]*[^>]*=\s*\{/.test(line)) {
      throw new DocumentationError(
        `JSX expressions are not supported in ${file}:${index + 1}`,
        'documentation_mdx_unsafe',
        [{
          code: 'jsx_expression',
          message: 'Component attributes must use quoted string values',
          file,
          line: index + 1,
        }],
      )
    }
  }

  const componentPattern = /<\/?([A-Z][A-Za-z0-9]*)\b/g
  for (const match of validationBody.matchAll(componentPattern)) {
    if (!COMPONENT_NAMES.includes(match[1] as ComponentName)) {
      const line = validationBody.slice(0, match.index).split('\n').length
      throw new DocumentationError(
        `Unknown documentation component <${match[1]}> in ${file}:${line}`,
        'documentation_mdx_component_unknown',
        [{
          code: 'unknown_component',
          message: `Supported components: ${COMPONENT_NAMES.join(', ')}`,
          file,
          line,
        }],
      )
    }
  }
}

function protectCode(source: string, placeholders: string[]): string {
  const fenced = source.replace(
    /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*(?=\n|$)/gm,
    (block, indentation: string) => {
      const normalized = indentation
        ? block.split('\n').map((line) => line.startsWith(indentation) ? line.slice(indentation.length) : line).join('\n')
        : block
      const html = String(markdownRenderer.parse(normalized, { gfm: true, breaks: false }))
      const index = placeholders.push(html) - 1
      return `\n\n@@DEEPSPACE_COMPONENT_${index}@@\n\n`
    },
  )
  return fenced.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const index = placeholders.push(`<code>${escapeHtml(code)}</code>`) - 1
    return `@@DEEPSPACE_COMPONENT_${index}@@`
  })
}

function stripCodeForValidation(source: string): string {
  return source
    .replace(
      /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*(?=\n|$)/gm,
      (block) => block.replace(/[^\n]/g, ' '),
    )
    .replace(/`[^`\n]+`/g, (code) => ' '.repeat(code.length))
}

function addHeadingIds(html: string): { html: string; headings: DocumentationHeading[] } {
  const headings: DocumentationHeading[] = []
  const slug = createSlugger()
  const output = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, depthRaw, content) => {
    const text = htmlToText(content)
    const id = slug(text)
    const depth = Number(depthRaw)
    headings.push({ depth, id, text })
    return `<h${depth} id="${id}">${content}<a class="documentation-heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a></h${depth}>`
  })
  return { html: output, headings }
}

export { slugify } from './text'

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function safeHref(value: string | undefined): string {
  if (!value) return ''
  if (/^(?:https?:|mailto:|\/|#)/i.test(value)) return value
  return ''
}

function frontmatterTypeError(file: string, key: string, type: string): DocumentationError {
  return new DocumentationError(
    `Front matter ${key} must be a ${type} in ${file}`,
    'documentation_frontmatter_invalid',
    [{ code: 'frontmatter_type', message: `${key} must be a ${type}`, file, line: 1 }],
  )
}

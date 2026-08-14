import { createProcessor, type CompileOptions } from '@mdx-js/mdx'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { toMarkdown } from 'mdast-util-to-markdown'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { parseCodeFenceInfo, parseFrontmatter, parseMarkdown, type ParsedMarkdown } from './markdown'
import { createSlugger, errorMessage } from './text'
import { DocumentationError } from './types'

interface SyntaxNode {
  type: string
  value?: string
  depth?: number
  lang?: string | null
  meta?: string | null
  name?: string | null
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>
  children?: SyntaxNode[]
  data?: Record<string, unknown>
  position?: { start?: { line?: number } }
}

const EXECUTABLE_NODE_TYPES = new Set([
  'mdxjsEsm',
  'mdxFlowExpression',
  'mdxTextExpression',
])

export function parseMdx(source: string, file: string): ParsedMarkdown {
  const { frontmatter, body } = parseFrontmatter(source, file)
  try {
    const processor = createProcessor({ remarkPlugins: [remarkGfm] })
    const tree = processor.parse(body) as unknown as SyntaxNode
    const staticTree = projectStaticMarkdown(tree)
    const markdown = toMarkdown(staticTree as unknown as Parameters<typeof toMarkdown>[0], {
      extensions: [gfmToMarkdown()],
    })
    return { ...parseMarkdown(markdown, file), frontmatter }
  } catch (error) {
    if (error instanceof DocumentationError) throw error
    const line = diagnosticLine(error)
    throw new DocumentationError(
      `Invalid MDX in ${file}: ${errorMessage(error)}`,
      'documentation_mdx_invalid',
      [{ code: 'mdx_syntax', message: errorMessage(error), file, ...(line ? { line } : {}) }],
    )
  }
}

/** Shared compile settings keep graph headings and executable MDX output identical. */
export function mdxCompileOptions(): CompileOptions {
  return {
    jsx: false,
    outputFormat: 'program',
    remarkPlugins: [remarkGfm, remarkFrontmatter, removeFrontmatter, addRuntimeMetadata],
    rehypePlugins: [rehypeHighlight],
  }
}

function projectStaticMarkdown(node: SyntaxNode): SyntaxNode {
  const projected: SyntaxNode = { ...node }
  delete projected.attributes
  delete projected.name
  projected.children = (node.children ?? []).flatMap(projectStaticNode)
  return projected
}

function projectStaticNode(node: SyntaxNode): SyntaxNode[] {
  if (EXECUTABLE_NODE_TYPES.has(node.type)) return []
  if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
    const title = jsxTitle(node)
    const titleNode = title
      ? [{
          type: 'paragraph',
          children: [{ type: 'text', value: title }],
        } satisfies SyntaxNode]
      : []
    return [...titleNode, ...(node.children ?? []).flatMap(projectStaticNode)]
  }
  return [projectStaticMarkdown(node)]
}

function jsxTitle(node: SyntaxNode): string | undefined {
  const attribute = node.attributes?.find((candidate) =>
    candidate.type === 'mdxJsxAttribute' && (candidate.name === 'title' || candidate.name === 'label'),
  )
  return typeof attribute?.value === 'string' ? attribute.value : undefined
}

function removeFrontmatter() {
  return (tree: SyntaxNode): void => {
    tree.children = tree.children?.filter((node) => node.type !== 'yaml')
  }
}

function addRuntimeMetadata() {
  return (tree: SyntaxNode): void => {
    const slug = createSlugger()
    visit(tree, (node) => {
      if (node.type === 'heading') {
        const text = staticText(node)
        const id = slug(text)
        node.data = {
          ...node.data,
          hProperties: {
            ...asRecord(node.data?.hProperties),
            id,
          },
        }
      }
      if (node.type === 'code' && typeof node.meta === 'string' && node.meta.trim()) {
        // Same fence-info grammar as the Markdown path: a bare word or a
        // title="…" pair after the language becomes the block title.
        const { title } = parseCodeFenceInfo(`${node.lang ?? ''} ${node.meta}`.trim())
        if (title) {
          node.data = {
            ...node.data,
            hProperties: {
              ...asRecord(node.data?.hProperties),
              'data-code-title': title,
            },
          }
        }
      }
    })
  }
}

function staticText(node: SyntaxNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  if (EXECUTABLE_NODE_TYPES.has(node.type)) return ''
  return (node.children ?? []).map(staticText).join('')
}

function visit(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
  visitor(node)
  for (const child of node.children ?? []) visit(child, visitor)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function diagnosticLine(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('line' in error)) return undefined
  return typeof error.line === 'number' ? error.line : undefined
}

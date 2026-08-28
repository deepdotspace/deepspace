import { createHash } from 'node:crypto'
import { documentationPublicPath, markdownUrlForRoute } from './routing'
import { documentationSubject } from './text'
import type { DocumentationGraph, DocumentationNavigationNode, DocumentationPage } from './types'

export const AGENT_SKILLS_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

export interface DocumentationSkillArtifacts {
  name: string
  description: string
  markdown: string
  discoveryIndex: Record<string, unknown>
}

/** Build one deterministic, installable skill from the same graph as the site. */
export function createDocumentationSkillArtifacts(
  graph: DocumentationGraph,
  baseUrl?: string,
  basePath = '/docs',
): DocumentationSkillArtifacts {
  const name = documentationSkillName(graph.config.name)
  const description = documentationSkillDescription(graph.config.name, graph.config.description)
  const root = baseUrl?.replace(/\/$/, '') ?? ''
  const markdown = renderDocumentationSkill(graph, name, description, root)
  const digest = createHash('sha256').update(markdown).digest('hex')

  return {
    name,
    description,
    markdown,
    discoveryIndex: {
      $schema: AGENT_SKILLS_SCHEMA,
      skills: [
        {
          name,
          type: 'skill-md',
          description,
          url: documentationPublicPath(basePath, `/.well-known/agent-skills/${name}/skill.md`),
          digest: `sha256:${digest}`,
        },
      ],
    },
  }
}

export function documentationSkillName(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  return normalized.slice(0, 64).replace(/-+$/g, '') || 'documentation'
}

function documentationSkillDescription(name: string, description?: string): string {
  const detail = description?.replace(/\s+/g, ' ').trim()
  const value = detail
    ? `Use when answering questions, integrating, or implementing work with ${name}. ${detail}`
    : `Use when answering questions, integrating, or implementing work with ${name}.`
  return value.slice(0, 1_024).trim()
}

function renderDocumentationSkill(
  graph: DocumentationGraph,
  name: string,
  description: string,
  root: string,
): string {
  const lines = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'metadata:',
    '  version: "1.0"',
    `  source-hash: ${JSON.stringify(graph.sourceHash)}`,
    '---',
    '',
    `# ${graph.config.name}`,
    '',
    graph.config.description ??
      `Use the published ${documentationSubject(graph.config.name)} as the source of truth.`,
    '',
    '## Grounding workflow',
    '',
    `1. Read [the documentation index](${root}/llms.txt) to discover the available pages.`,
    graph.config.mcp.access === 'public'
      ? `2. Prefer the read-only MCP server at \`${root}/mcp\` for ranked search and exact page reads.`
      : `2. Search the index, then open the relevant page Markdown directly.`,
    `3. Read a page's canonical Markdown before making implementation claims or quoting commands.`,
    `4. Treat this release as authoritative; do not mix instructions from another version or hostname.`,
    '',
    '## Documentation map',
    '',
    ...renderNavigation(graph.navigation, graph.pages, root),
    '## Constraints',
    '',
    '- Do not invent APIs, commands, configuration keys, or supported behavior.',
    '- Preserve security, authentication, billing, and deployment boundaries stated in the documentation.',
    '- When pages disagree, prefer the more specific page and report the conflict.',
    '- Link the exact source page in the final answer when the client supports citations.',
    '',
  ]
  return lines.join('\n')
}

function renderNavigation(
  navigation: DocumentationNavigationNode[],
  pages: DocumentationPage[],
  root: string,
): string[] {
  const byRoute = new Map(pages.map((page) => [page.route, page]))
  const lines: string[] = []
  const seen = new Set<string>()

  const visit = (nodes: DocumentationNavigationNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.kind === 'group') {
        lines.push(`${'#'.repeat(Math.min(depth + 2, 6))} ${node.label}`, '')
        visit(node.items, depth + 1)
        continue
      }
      if (node.kind !== 'page' || seen.has(node.route)) continue
      const page = byRoute.get(node.route)
      if (!page || page.hidden) continue
      seen.add(page.route)
      const markdownRoute = markdownUrlForRoute(page.route)
      lines.push(renderPageLink(page, root, markdownRoute))
    }
  }

  visit(navigation, 1)
  const remaining = pages.filter((page) => !page.hidden && !seen.has(page.route))
  if (remaining.length > 0) {
    lines.push('### More', '')
    for (const page of remaining) {
      const markdownRoute = markdownUrlForRoute(page.route)
      lines.push(renderPageLink(page, root, markdownRoute))
    }
  }
  lines.push('')
  return lines
}

function renderPageLink(page: DocumentationPage, root: string, markdownRoute: string): string {
  return (
    `- [${page.title}](${root}${markdownRoute})` +
    `${page.description ? ` — ${page.description}` : ''}`
  )
}

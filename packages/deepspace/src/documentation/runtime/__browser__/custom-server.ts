import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDocumentation } from '../../build'

/**
 * The executable-documentation fixture: MDX pages, a local component import, and
 * an app-owned `documentation.tsx` wrapper. That combination is what selects the
 * custom runtime (React renders the prose) instead of the default runtime (the
 * compiler's HTML is injected), so this server is the only place the browser
 * suite can observe React-owned article content.
 *
 * The app lives under `packages/deepspace/node_modules` so `react`,
 * `react-dom`, and the MDX toolchain resolve from the workspace the same way
 * they do for a real installed app, and so the fixture never dirties the tree.
 */
const host = '127.0.0.1'
const port = 4179
const packageDir = fileURLToPath(new URL('../../../..', import.meta.url))
const fixtureRoot = join(packageDir, 'node_modules')
const fixturePrefix = '.documentation-custom-fixture-'

// Discard fixtures from previous runs before creating this one. The runner stops
// the web server by killing the wrapper process, so an exit handler here is not
// reliably reached; sweeping on start bounds the leftovers at one either way.
for (const entry of readdirSync(fixtureRoot)) {
  if (entry.startsWith(fixturePrefix)) rmSync(join(fixtureRoot, entry), { recursive: true, force: true })
}
const appDir = mkdtempSync(join(fixtureRoot, fixturePrefix))
const sourceDir = join(appDir, 'documentation')
mkdirSync(sourceDir, { recursive: true })

// Best-effort teardown for the runs that do exit cleanly.
const discardFixture = (): void => rmSync(appDir, { recursive: true, force: true })
process.on('exit', discardFixture)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { discardFixture(); process.exit(0) })
}

writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify({ name: 'documentation-custom-fixture', private: true, version: '0.0.0' }, null, 2)}\n`,
)

writeFileSync(
  join(appDir, 'documentation.json'),
  `${JSON.stringify(
    {
      name: 'Custom Runtime Acceptance Documentation',
      description: 'Browser-level acceptance for the executable documentation runtime.',
      url: `http://${host}:${port}/docs`,
      navigation: [{ group: 'Start', pages: ['index', 'guide', 'reference'] }],
      assistant: { access: 'public' },
    },
    null,
    2,
  )}\n`,
)

/** A local component, imported by MDX, so the fixture exercises app-owned React
 * inside the prose rather than only compiler-generated elements. */
writeFileSync(
  join(appDir, 'Highlight.tsx'),
  `import type { ReactNode } from 'react'

export function Highlight({ children }: { children?: ReactNode }) {
  return <strong className="fixture-highlight" data-fixture-highlight>{children}</strong>
}

export default Highlight
`,
)

/** The app-owned shell wrapper. Real sites wrap the SDK shell in their own
 * chrome, so the fixture does too: the layout chain has to survive it. */
writeFileSync(
  join(appDir, 'documentation.tsx'),
  `import { DocumentationApp, type DocumentationSiteProps } from 'deepspace/documentation/react'

export default function Site(props: DocumentationSiteProps) {
  return (
    <div className="fixture-site-wrapper" data-fixture-wrapper>
      <DocumentationApp {...props} />
    </div>
  )
}
`,
)

function page(title: string, description: string, links: string): string {
  const body = Array.from({ length: 12 }, (_, index) => `## Section ${index + 1}

Executable documentation acceptance content ${index + 1} for ${title}.

\`\`\`ts
export const section${index + 1} = ${JSON.stringify(`${title} ${index + 1}`)}
\`\`\`
`).join('\n')
  return `---
title: ${title}
description: ${description}
---

import { Highlight } from '../Highlight'

# ${title}

<Highlight>${title} highlight</Highlight>

${links}

<Tabs>
  <Tab title="First">First panel for ${title}.</Tab>
  <Tab title="Second">Second panel for ${title}.</Tab>
</Tabs>

<CodeGroup>
\`\`\`ts one.ts
export const one = ${JSON.stringify(title)}
\`\`\`

\`\`\`ts two.ts
export const two = ${JSON.stringify(title)}
\`\`\`
</CodeGroup>

${body}
`
}

writeFileSync(
  join(sourceDir, 'index.mdx'),
  page('Home', 'Home metadata.', '[Guide](/guide) · [Reference](/reference)'),
)
writeFileSync(
  join(sourceDir, 'guide.mdx'),
  page('Guide', 'Guide metadata.', '[Home](/) · [Reference](/reference)'),
)
writeFileSync(
  join(sourceDir, 'reference.mdx'),
  page('Reference', 'Reference metadata.', '[Home](/) · [Guide](/guide)'),
)

const outputDir = buildDocumentation({ appDir }).outputDir
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  const relative = decodeURIComponent(url.pathname).replace(/^\/docs\/?/u, '')
  const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/u, '')
  let target = join(outputDir, safe || 'index.html')
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
  if (!existsSync(target) && !extname(target)) target = join(target, 'index.html')
  if (!existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': contentTypes[extname(target)] ?? 'application/octet-stream',
  })
  response.end(readFileSync(target))
}).listen(port, host, () => {
  process.stdout.write(`documentation custom-runtime fixture: http://${host}:${port}/docs\n`)
})

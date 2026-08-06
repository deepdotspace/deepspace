import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { buildDocumentation } from '../../build'

const host = '127.0.0.1'
const port = 4178
const appDir = mkdtempSync(join(tmpdir(), 'deepspace-documentation-routing-'))
const sourceDir = join(appDir, 'documentation')
mkdirSync(sourceDir, { recursive: true })

writeFileSync(
  join(appDir, 'documentation.json'),
  `${JSON.stringify(
    {
      name: 'Routing Acceptance',
      description: 'Browser-level documentation router acceptance.',
      url: `http://${host}:${port}/docs`,
      navigation: [{ group: 'Start', pages: ['index', 'guide', 'reference'] }],
      assistant: { access: 'public' },
    },
    null,
    2,
  )}\n`,
)

/** Code fences on every page: the copy/ask controls are the article's only
 * imperative DOM pass, so the default runtime has to carry them through
 * navigation the same way the executable runtime does. */
const longBody = Array.from(
  { length: 12 },
  (_, index) => `## Section ${index + 1}\n\nRouting acceptance content ${index + 1}.\n\n\`\`\`ts\nexport const section${index + 1} = ${index + 1}\n\`\`\``,
).join('\n\n')
const body = (title: string, links: string): string =>
  `---\ntitle: ${title}\ndescription: ${title} metadata.\n---\n\n# ${title}\n\n${links}\n\n${longBody}\n`
writeFileSync(join(sourceDir, 'index.md'), body('Home', '[Guide](/guide) · [Reference](/reference)'))
writeFileSync(join(sourceDir, 'guide.md'), body('Guide', '[Home](/) · [Reference](/reference)'))
writeFileSync(join(sourceDir, 'reference.md'), body('Reference', '[Home](/) · [Guide](/guide)'))

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
  process.stdout.write(`documentation routing fixture: http://${host}:${port}/docs\n`)
})

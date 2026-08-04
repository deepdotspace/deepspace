import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import sanitizeHtml from 'sanitize-html'
import { DocsError } from './types'

const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
])

const SOURCE_EXTENSIONS = new Set(['.css', '.js', '.jsx', '.md', '.mdx', '.ts', '.tsx'])

/** Owns all filesystem mutation and hashing for one deterministic docs build. */
export class DocsOutput {
  readonly files = new Set<string>()

  constructor(
    readonly outputDir: string,
    appDir: string,
    sourceDir: string,
  ) {
    assertSafeOutput(appDir, sourceDir, outputDir)
    if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true })
    mkdirSync(outputDir, { recursive: true })
  }

  write(relativePath: string, content: string | Uint8Array): void {
    const path = this.safePath(relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    this.files.add(normalizeRelativePath(relativePath))
  }

  copyMedia(sourceDir: string, auxiliarySources: Set<string>): void {
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const sourcePath = join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(sourcePath)
          continue
        }
        const extension = extname(entry.name).toLowerCase()
        if (SOURCE_EXTENSIONS.has(extension) || auxiliarySources.has(resolve(sourcePath))) continue
        if (!MEDIA_EXTENSIONS.has(extension)) {
          throw new DocsError(
            `Unsupported documentation media type: ${relative(sourceDir, sourcePath)}`,
            'docs_media_unsupported',
            [{
              code: 'media_type_unsupported',
              message: extension || '(no extension)',
              file: sourcePath,
            }],
          )
        }
        const mediaPath = `media/${normalizeRelativePath(relative(sourceDir, sourcePath))}`
        const content = extension === '.svg'
          ? sanitizeSvg(readFileSync(sourcePath, 'utf8'), sourcePath)
          : readFileSync(sourcePath)
        this.write(mediaPath, content)
      }
    }
    walk(sourceDir)
  }

  hash(): string {
    const hash = createHash('sha256')
    for (const file of [...this.files].sort()) {
      hash.update(file)
      hash.update(readFileSync(join(this.outputDir, file)))
    }
    return hash.digest('hex')
  }

  private safePath(relativePath: string): string {
    const path = resolve(this.outputDir, relativePath)
    const rel = relative(this.outputDir, path)
    if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
      throw new DocsError(
        `Refusing documentation artifact outside the output directory: ${relativePath}`,
        'docs_output_unsafe',
        [{ code: 'artifact_path_escape', message: relativePath }],
      )
    }
    return path
  }
}

function assertSafeOutput(appDir: string, sourceDir: string, outputDir: string): void {
  const appRelative = relative(appDir, outputDir)
  const sourceRelative = relative(sourceDir, outputDir)
  if (
    outputDir === appDir ||
    outputDir === sourceDir ||
    appRelative === '..' ||
    appRelative.startsWith(`..${sep}`) ||
    sourceRelative === '' ||
    (!sourceRelative.startsWith('..') && sourceRelative !== '')
  ) {
    throw new DocsError(
      `Refusing unsafe docs output directory: ${outputDir}`,
      'docs_output_unsafe',
      [{ code: 'unsafe_output', message: outputDir }],
    )
  }
}

function sanitizeSvg(source: string, sourcePath: string): string {
  const safe = sanitizeHtml(source, {
    allowedTags: [
      'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
      'rect', 'image', 'defs', 'linearGradient', 'radialGradient', 'stop',
      'clipPath', 'mask', 'title', 'desc', 'text', 'tspan',
    ],
    allowedAttributes: {
      svg: [
        'xmlns', 'xmlns:xlink', 'viewBox', 'width', 'height', 'fill', 'stroke',
        'role', 'aria-label',
      ],
      image: ['href', 'xlink:href', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
      '*': [
        'id', 'class', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy',
        'r', 'rx', 'ry', 'points', 'width', 'height', 'viewBox', 'fill',
        'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
        'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform', 'offset',
        'stop-color', 'stop-opacity', 'clip-path', 'mask', 'role', 'aria-label',
        'aria-hidden', 'font-family', 'font-size', 'font-style', 'font-weight',
        'letter-spacing', 'text-anchor', 'dominant-baseline',
      ],
    },
    allowedSchemes: ['data'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
  })
  if (!/<svg\b/i.test(safe)) {
    throw new DocsError(
      `Invalid documentation SVG: ${relative(process.cwd(), sourcePath)}`,
      'docs_media_invalid',
      [{ code: 'svg_invalid', message: 'Expected an SVG root element', file: sourcePath }],
    )
  }
  return safe
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

const RESOURCE_EXTENSIONS = new Set([
  '7z', 'avif', 'css', 'csv', 'gif', 'gz', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map',
  'md', 'mjs', 'mp3', 'mp4', 'pdf', 'png', 'svg', 'tar', 'txt', 'wasm', 'webm',
  'webp', 'woff', 'woff2', 'xml', 'yaml', 'yml', 'zip',
])

/** Distinguish generated documentation resources from authored page routes. */
export function isNativeDocumentationResourcePath(pathname: string): boolean {
  const leaf = pathname.slice(pathname.lastIndexOf('/') + 1)
  const extension = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.') + 1).toLowerCase() : ''
  return extension !== '' && RESOURCE_EXTENSIONS.has(extension)
}

/** Encode a compiler-owned logical path without collapsing its segment boundaries. */
export function encodeNativeDocumentationPath(pathname: string): string {
  return pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/')
}

/** Normalize one URL pathname while preserving encoded slashes as data, not separators. */
export function canonicalNativeDocumentationRequestPath(pathname: string): string | null {
  try {
    return pathname
      .split('/')
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join('/')
  } catch {
    return null
  }
}

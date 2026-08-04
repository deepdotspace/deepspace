const DOCS_RESOURCE_EXTENSIONS = new Set([
  '7z', 'avif', 'css', 'csv', 'gif', 'gz', 'ico', 'jpeg', 'jpg', 'js', 'json', 'map',
  'md', 'mjs', 'mp3', 'mp4', 'pdf', 'png', 'svg', 'tar', 'txt', 'wasm', 'webm',
  'webp', 'woff', 'woff2', 'xml', 'yaml', 'yml', 'zip',
])

/** Distinguish generated docs resources from authored page routes, including dotted slugs. */
export function isDocsResourcePath(pathname: string): boolean {
  const leaf = pathname.slice(pathname.lastIndexOf('/') + 1)
  const extension = leaf.includes('.') ? leaf.slice(leaf.lastIndexOf('.') + 1).toLowerCase() : ''
  return extension !== '' && DOCS_RESOURCE_EXTENSIONS.has(extension)
}

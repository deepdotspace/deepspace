/**
 * useMimeTypeDetection — MIME type detection and file categorization.
 *
 * Mirrors the main app's approach:
 * 1. Magic byte detection via `file-type` library (dynamically imported)
 * 2. Fallback to browser-provided MIME type (extension-based)
 * 3. Extension-based category mapping for 11 file categories
 *
 * @example
 * ```tsx
 * const { detectMimeType, getFileCategory, getExtension } = useMimeTypeDetection()
 *
 * // Detect MIME type from a File object (uses magic bytes)
 * const mimeType = await detectMimeType(file)
 *
 * // Categorize by MIME type + file name
 * const category = getFileCategory('application/pdf', 'report.pdf')  // → 'pdf'
 * const category = getFileCategory('text/plain', 'app.tsx')          // → 'code'
 * ```
 */

import { useCallback } from 'react'

// ============================================================================
// Types
// ============================================================================

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'text'
  | 'other'

export interface MimeTypeDetection {
  /** Detect MIME type from a File using magic bytes, falling back to file.type */
  detectMimeType: (file: File) => Promise<string>
  /** Map MIME type + file name to a display category */
  getFileCategory: (mimeType: string, fileName: string) => FileCategory
  /** Extract lowercase extension from a file name */
  getExtension: (fileName: string) => string
  /** Check if a category supports inline preview */
  canPreview: (category: FileCategory) => boolean
}

// ============================================================================
// Extension sets for category detection
// ============================================================================

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'ogg', 'ogv', 'avi', 'mkv', 'm4v'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'wma', 'ogg'])
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'rtf'])
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'tsv'])
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2'])
const CODE_EXTENSIONS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'json', 'css', 'scss', 'less',
  'html', 'xml', 'svg', 'py', 'java', 'cpp', 'c', 'h',
  'php', 'rb', 'go', 'rs', 'swift', 'kt', 'sh', 'bash',
  'yaml', 'yml', 'toml', 'sql', 'graphql', 'vue', 'svelte',
])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'log', 'ini', 'cfg', 'env'])

// ============================================================================
// Pure utility functions
// ============================================================================

function getExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function getFileCategory(mimeType: string, fileName: string): FileCategory {
  const ext = getExtension(fileName)

  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mimeType.includes('excel') || mimeType.includes('spreadsheetml') || mimeType.includes('spreadsheet') || SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet'
  if (mimeType.includes('powerpoint') || mimeType.includes('presentationml') || mimeType.includes('presentation') || PRESENTATION_EXTENSIONS.has(ext)) return 'presentation'
  if (mimeType.includes('word') || mimeType.includes('wordprocessingml') || DOCUMENT_EXTENSIONS.has(ext)) return 'document'
  if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed') || ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json') || CODE_EXTENSIONS.has(ext)) return 'code'
  if (mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) return 'text'

  return 'other'
}

function canPreview(category: FileCategory): boolean {
  return category === 'image'
    || category === 'video'
    || category === 'audio'
    || category === 'pdf'
    || category === 'code'
    || category === 'text'
    || category === 'spreadsheet'
    || category === 'document'
}

async function detectMimeType(file: File): Promise<string> {
  try {
    const { fileTypeFromBuffer } = await import('file-type')
    const arrayBuffer = await file.arrayBuffer()
    const result = await fileTypeFromBuffer(new Uint8Array(arrayBuffer))
    if (result) return result.mime
  } catch {
    // Can fail on zero-length files, security-restricted blobs, or if module fails to load
  }

  return file.type || 'application/octet-stream'
}

// ============================================================================
// Hook
// ============================================================================

export function useMimeTypeDetection(): MimeTypeDetection {
  const detect = useCallback((file: File) => detectMimeType(file), [])
  const categorize = useCallback((mimeType: string, fileName: string) => getFileCategory(mimeType, fileName), [])
  const ext = useCallback((fileName: string) => getExtension(fileName), [])
  const preview = useCallback((category: FileCategory) => canPreview(category), [])

  return {
    detectMimeType: detect,
    getFileCategory: categorize,
    getExtension: ext,
    canPreview: preview,
  }
}

// Also export the pure functions for non-React contexts
export { detectMimeType, getFileCategory, getExtension, canPreview }

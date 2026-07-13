/**
 * Shared types and utilities for file attachments across miniapps.
 */

export interface FileAttachment {
  key: string
  url: string
  name: string
  size: number
  mimeType: string
}

const IMAGE_MIME_PREFIXES = ['image/']

export function isImageFile(mimeType: string): boolean {
  return IMAGE_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix))
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

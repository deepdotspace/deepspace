/**
 * File Manager Page
 *
 * Demonstrates:
 * - useR2Files for upload, list, download, delete
 * - Drag-and-drop upload zone
 * - Inline image preview
 * - File size formatting
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useR2Files } from 'deepspace'
import { EmptyState, Badge, Modal } from '@/components/ui'
import type { R2FileInfo } from 'deepspace'

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function isImage(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)$/i.test(name)
}

function fileIcon(name: string): string {
  if (isImage(name)) return 'image'
  if (/\.(pdf)$/i.test(name)) return 'pdf'
  if (/\.(doc|docx|txt|md)$/i.test(name)) return 'doc'
  if (/\.(mp4|mov|webm|avi)$/i.test(name)) return 'video'
  if (/\.(mp3|wav|ogg|flac)$/i.test(name)) return 'audio'
  if (/\.(zip|tar|gz|rar|7z)$/i.test(name)) return 'archive'
  return 'file'
}

// ============================================================================
// Drop Zone
// ============================================================================

interface DropZoneProps {
  onFiles: (files: File[]) => void
  isUploading: boolean
}

function DropZone({ onFiles, isUploading }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onFiles(files)
  }, [onFiles])

  const handleClick = () => inputRef.current?.click()

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onFiles(files)
    e.target.value = ''
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={`
        relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
        ${isDragging
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/50 hover:bg-muted/30'
        }
        ${isUploading ? 'pointer-events-none opacity-60' : ''}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleInputChange}
        className="hidden"
      />
      {isUploading ? (
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Uploading...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <svg className="w-10 h-10 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Click to upload</span> or drag and drop
          </p>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// File Card
// ============================================================================

interface FileCardProps {
  file: R2FileInfo
  onDownload: () => void
  onDelete: () => void
  onPreview: () => void
}

function FileCard({ file, onDownload, onDelete, onPreview }: FileCardProps) {
  const name = file.originalName ?? file.key.split('/').pop() ?? 'Unnamed'
  const type = fileIcon(name)
  const previewable = isImage(name)

  const iconColor: Record<string, string> = {
    image: 'text-emerald-500',
    pdf: 'text-red-500',
    doc: 'text-blue-500',
    video: 'text-purple-500',
    audio: 'text-orange-500',
    archive: 'text-yellow-500',
    file: 'text-muted-foreground',
  }

  return (
    <div className="group p-4 bg-card/60 rounded-xl border border-border hover:border-primary/30 transition-colors">
      <div className="flex items-start gap-3">
        <div
          className={`shrink-0 w-10 h-10 rounded-lg bg-muted/60 flex items-center justify-center ${iconColor[type] ?? ''} ${previewable ? 'cursor-pointer' : ''}`}
          onClick={previewable ? onPreview : undefined}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {type === 'image' ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            )}
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{name}</p>
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="secondary" size="sm">{formatBytes(file.size)}</Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(file.uploaded).toLocaleDateString()}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onDownload}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-colors"
            title="Download"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors"
            title="Delete"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Preview Modal
// ============================================================================

interface PreviewModalProps {
  file: R2FileInfo | null
  imageUrl: string | null
  onClose: () => void
}

function PreviewModal({ file, imageUrl, onClose }: PreviewModalProps) {
  const name = file?.originalName ?? file?.key.split('/').pop() ?? ''

  return (
    <Modal open={!!file} onClose={onClose} size="lg">
      <Modal.Header onClose={onClose}>
        <Modal.Title>{name}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {imageUrl && (
          <img src={imageUrl} alt={name} className="max-w-full max-h-[70vh] mx-auto rounded-lg" />
        )}
      </Modal.Body>
    </Modal>
  )
}

// ============================================================================
// Main Page
// ============================================================================

export default function FileManagerPage({ className }: { className?: string }) {
  const { upload, downloadFile, deleteFile, list, getUrl, isUploading } = useR2Files()
  const [files, setFiles] = useState<R2FileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [previewFile, setPreviewFile] = useState<R2FileInfo | null>(null)

  const refreshFiles = useCallback(async () => {
    const result = await list()
    setFiles(result)
    setLoading(false)
  }, [list])

  useEffect(() => {
    refreshFiles()
  }, [refreshFiles])

  const handleUpload = async (fileList: File[]) => {
    for (const file of fileList) {
      await upload(file)
    }
    await refreshFiles()
  }

  const handleDownload = async (file: R2FileInfo) => {
    await downloadFile(file)
  }

  const handleDelete = async (file: R2FileInfo) => {
    const name = file.originalName ?? file.key.split('/').pop() ?? 'this file'
    if (!confirm(`Delete "${name}"?`)) return
    await deleteFile(file)
    await refreshFiles()
  }

  const handlePreview = (file: R2FileInfo) => {
    setPreviewFile(file)
  }

  return (
    <div className={`h-full bg-background overflow-y-auto ${className ?? ''}`}>
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Files</h1>
              <p className="text-muted-foreground mt-1">
                {files.length} {files.length === 1 ? 'file' : 'files'} stored
              </p>
            </div>
            {files.length > 0 && (
              <Badge variant="secondary">
                {formatBytes(files.reduce((sum, f) => sum + f.size, 0))} used
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Upload zone */}
        <DropZone onFiles={handleUpload} isUploading={isUploading} />

        {/* File list */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : files.length === 0 ? (
          <EmptyState
            title="No files yet"
            description="Upload your first file using the drop zone above"
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {files.map((file) => (
              <FileCard
                key={file.key}
                file={file}
                onDownload={() => handleDownload(file)}
                onDelete={() => handleDelete(file)}
                onPreview={() => handlePreview(file)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Image preview modal */}
      <PreviewModal
        file={previewFile}
        imageUrl={previewFile ? getUrl(previewFile) : null}
        onClose={() => setPreviewFile(null)}
      />
    </div>
  )
}

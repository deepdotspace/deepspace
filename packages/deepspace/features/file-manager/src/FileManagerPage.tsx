/** Per-user file management with authenticated previews and visible mutation outcomes. */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  Eye,
  File as FileIcon,
  FileImage,
  FolderOpen,
  Trash2,
  TriangleAlert,
  UploadCloud,
} from 'lucide-react'
import { useR2Files, type R2FileInfo } from 'deepspace'
import { Badge, Button, ConfirmModal, EmptyState, Modal, useToast } from '@/components/ui'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${parseFloat((bytes / 1024 ** unit).toFixed(1))} ${units[unit]}`
}

function displayName(file: R2FileInfo): string {
  return file.originalName ?? file.key.split('/').pop() ?? 'Unnamed'
}

// SVG is served as a download for origin safety, so it is deliberately not
// rendered inline. It remains uploadable and downloadable like every file.
function canPreviewImage(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|ico)$/i.test(name)
}

interface DropZoneProps {
  onFiles: (files: File[]) => void
  isUploading: boolean
}

function DropZone({ onFiles, isUploading }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) onFiles(files)
    },
    [onFiles],
  )

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
        isDragging ? 'border-primary bg-primary/5' : 'border-border bg-card/30'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) onFiles(files)
          event.target.value = ''
        }}
        className="hidden"
      />
      {isUploading ? (
        <div className="mx-auto max-w-xs space-y-3" aria-label="Uploading files" aria-busy="true">
          <div className="mx-auto size-10 animate-pulse rounded-lg bg-muted" />
          <div className="mx-auto h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="mx-auto h-3 w-48 animate-pulse rounded bg-muted/70" />
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <UploadCloud className="size-10 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">
            Drag files here or choose them from your device.
          </p>
          <Button variant="secondary" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
        </div>
      )}
    </div>
  )
}

interface FileCardProps {
  file: R2FileInfo
  onDownload: () => void
  onDelete: () => void
  onPreview: () => void
}

function FileCard({ file, onDownload, onDelete, onPreview }: FileCardProps) {
  const name = displayName(file)
  const previewable = canPreviewImage(name)

  return (
    <div className="rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/30">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {previewable ? (
            <FileImage className="size-5 text-emerald-500" aria-hidden="true" />
          ) : (
            <FileIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{name}</p>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="secondary" size="sm">
              {formatBytes(file.size)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {new Date(file.uploaded).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {previewable && (
          <Button variant="ghost" size="sm" onClick={onPreview}>
            <Eye aria-hidden="true" />
            Preview
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onDownload}>
          <Download aria-hidden="true" />
          Download
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/20 hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" />
          Delete
        </Button>
      </div>
    </div>
  )
}

function PreviewModal({
  file,
  imageUrl,
  onClose,
}: {
  file: R2FileInfo | null
  imageUrl: string | null
  onClose: () => void
}) {
  return (
    <Modal open={file !== null} onClose={onClose} size="lg">
      <Modal.Header>
        <Modal.Title>{file ? displayName(file) : ''}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        {imageUrl && file && (
          <img
            src={imageUrl}
            alt={displayName(file)}
            className="mx-auto max-h-[70vh] max-w-full rounded-lg"
          />
        )}
      </Modal.Body>
    </Modal>
  )
}

export default function FileManagerPage({ className }: { className?: string }) {
  const { upload, downloadFile, readFile, deleteFile, list, isUploading } = useR2Files()
  const toast = useToast()
  const [files, setFiles] = useState<R2FileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [previewFile, setPreviewFile] = useState<R2FileInfo | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<R2FileInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const previewUrlRef = useRef<string | null>(null)

  // `list` throws on failure; rendered as an error state rather than the
  // empty grid an unreachable or unauthorized account is not.
  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await list())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Please try again.')
    } finally {
      setLoading(false)
    }
  }, [list])

  useEffect(() => {
    void refreshFiles()
  }, [refreshFiles])

  useEffect(
    () => () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    },
    [],
  )

  const closePreview = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = null
    setPreviewUrl(null)
    setPreviewFile(null)
  }

  const handleUpload = async (fileList: File[]) => {
    let uploaded = 0
    for (const file of fileList) {
      const result = await upload(file)
      if (!result.success) {
        toast.error(`Could not upload "${file.name}"`, result.error ?? 'Please try again.')
        continue
      }
      uploaded += 1
    }
    if (uploaded > 0) {
      toast.success(
        uploaded === 1 ? 'File uploaded' : `${uploaded} files uploaded`,
        'Your file list is up to date.',
      )
      await refreshFiles()
    }
  }

  const handleDownload = async (file: R2FileInfo) => {
    const result = await downloadFile(file)
    if (!result.success) {
      toast.error(`Could not download "${displayName(file)}"`, result.error ?? 'Please try again.')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const result = await deleteFile(deleteTarget)
      if (!result.success) {
        toast.error(
          `Could not delete "${displayName(deleteTarget)}"`,
          result.error ?? 'Please try again.',
        )
        return
      }
      toast.success('File deleted', `"${displayName(deleteTarget)}" was deleted.`)
      setDeleteTarget(null)
      await refreshFiles()
    } finally {
      setDeleting(false)
    }
  }

  const handlePreview = async (file: R2FileInfo) => {
    try {
      const response = await readFile(file)
      const url = URL.createObjectURL(await response.blob())
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = url
      setPreviewUrl(url)
      setPreviewFile(file)
    } catch (error) {
      toast.error(
        `Could not preview "${displayName(file)}"`,
        error instanceof Error ? error.message : 'Please try again.',
      )
    }
  }

  return (
    <div className={`h-full overflow-y-auto bg-background ${className ?? ''}`}>
      <div className="sticky top-0 z-10 border-b border-border bg-card/60 backdrop-blur-md">
        <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Files</h1>
              <p className="mt-1 text-muted-foreground">
                {files.length} {files.length === 1 ? 'file' : 'files'} stored
              </p>
            </div>
            {files.length > 0 && (
              <Badge variant="secondary">
                {formatBytes(files.reduce((sum, file) => sum + file.size, 0))} used
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <DropZone onFiles={(nextFiles) => void handleUpload(nextFiles)} isUploading={isUploading} />

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-label="Loading files" aria-busy="true">
            <div className="h-36 animate-pulse rounded-xl border border-border bg-muted/40" />
            <div className="h-36 animate-pulse rounded-xl border border-border bg-muted/40" />
          </div>
        ) : loadError ? (
          <EmptyState
            title="Could not load files"
            description={loadError}
            icon={<TriangleAlert aria-hidden="true" />}
            action={{
              label: 'Retry',
              onClick: () => {
                setLoading(true)
                void refreshFiles()
              },
            }}
          />
        ) : files.length === 0 ? (
          <EmptyState
            title="No files yet"
            description="Upload your first file using the drop zone above."
            icon={<FolderOpen aria-hidden="true" />}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {files.map((file) => (
              <FileCard
                key={file.key}
                file={file}
                onDownload={() => void handleDownload(file)}
                onDelete={() => setDeleteTarget(file)}
                onPreview={() => void handlePreview(file)}
              />
            ))}
          </div>
        )}
      </div>

      <PreviewModal file={previewFile} imageUrl={previewUrl} onClose={closePreview} />
      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void handleDelete()}
        title={deleteTarget ? `Delete "${displayName(deleteTarget)}"?` : 'Delete file?'}
        description="This cannot be undone."
        confirmText="Delete"
        loading={deleting}
      />
    </div>
  )
}

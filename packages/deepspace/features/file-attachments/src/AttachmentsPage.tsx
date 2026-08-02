/** Attachment metadata/CRUD over records plus binary storage in R2. */

import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import {
  useUser,
  useQuery,
  useMutations,
  useR2Files,
  ROLES,
  formatFileSize,
  type Role,
} from 'deepspace'
import { Button, Modal, EmptyState, Badge, useToast } from '@/components/ui'
import { AttachmentPreview, AttachmentThumbnail } from '../components/AttachmentPreview'
import { useMimeTypeDetection } from '../hooks/useMimeTypeDetection'

const MAX_FILE_SIZE = 50 * 1024 * 1024

interface Attachment {
  fileName: string
  fileKey: string
  mimeType: string
  fileSize: number
  ownerId: string
}

const CATEGORY_LABELS: Record<string, string> = {
  all: 'All',
  image: 'Images',
  video: 'Videos',
  audio: 'Audio',
  pdf: 'PDFs',
  code: 'Code',
  text: 'Text',
  spreadsheet: 'Spreadsheets',
  document: 'Documents',
  presentation: 'Presentations',
  archive: 'Archives',
  other: 'Other',
}

interface UploadModalProps {
  isOpen: boolean
  onClose: () => void
  onUpload: (file: File, detectedMime: string) => Promise<boolean>
  isUploading: boolean
}

function UploadModal({ isOpen, onClose, onUpload, isUploading }: UploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [detectedType, setDetectedType] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const selectedFileRef = useRef<File | null>(null)
  const { detectMimeType } = useMimeTypeDetection()

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_FILE_SIZE) {
      selectedFileRef.current = null
      setSelectedFile(null)
      setDetectedType(null)
      setError(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}.`)
      e.currentTarget.value = ''
      return
    }

    setError(null)
    selectedFileRef.current = file
    setSelectedFile(file)
    setDetectedType(null)
    const mime = await detectMimeType(file)
    if (selectedFileRef.current === file) setDetectedType(mime)
  }

  const handleUpload = async () => {
    if (!selectedFile) return
    const file = selectedFile
    const mime = detectedType || (await detectMimeType(file))
    if (selectedFileRef.current !== file) return
    const uploaded = await onUpload(file, mime)
    if (!uploaded) return
    selectedFileRef.current = null
    setSelectedFile(null)
    setDetectedType(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
    onClose()
  }

  const handleClose = () => {
    selectedFileRef.current = null
    setSelectedFile(null)
    setDetectedType(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
    onClose()
  }

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" data-testid="upload-modal">
      <Modal.Header>
        <Modal.Title>Upload File</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div
            onClick={() => inputRef.current?.click()}
            className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 hover:bg-muted/20 transition-colors"
          >
            <input ref={inputRef} type="file" className="hidden" onChange={handleFileSelect} />
            <svg className="w-10 h-10 mx-auto text-muted-foreground mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            {selectedFile ? (
              <div>
                <p className="text-sm font-medium text-foreground">{selectedFile.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatFileSize(selectedFile.size)} &middot; {detectedType || selectedFile.type || 'detecting...'}
                </p>
              </div>
            ) : (
              <div>
                <p className="text-sm text-muted-foreground">Click to select a file</p>
                <p className="text-xs text-muted-foreground mt-1">Max {formatFileSize(MAX_FILE_SIZE)}</p>
              </div>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={handleClose}>Cancel</Button>
        <Button onClick={handleUpload} disabled={!selectedFile || isUploading}>
          {isUploading ? 'Uploading...' : 'Upload'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

function PreviewModal({ isOpen, onClose, attachment, previewUrl, onDownload }: {
  isOpen: boolean
  onClose: () => void
  attachment: { data: Attachment; recordId: string } | null
  previewUrl: string | null
  onDownload: () => void
}) {
  if (!attachment) return null
  const { fileName, mimeType, fileSize } = attachment.data

  return (
    <Modal open={isOpen} onClose={onClose} size="lg" data-testid="preview-modal">
      <Modal.Header>
        <Modal.Title>{fileName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          {previewUrl ? (
            <AttachmentPreview url={previewUrl} fileName={fileName} mimeType={mimeType} />
          ) : (
            <AttachmentThumbnail url={null} fileName={fileName} category="other" />
          )}
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span>{formatFileSize(fileSize)}</span>
            <span>&middot;</span>
            <span>{mimeType}</span>
          </div>
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button onClick={onDownload}>Download</Button>
      </Modal.Footer>
    </Modal>
  )
}

export default function AttachmentsPage() {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const canUpload = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN
  const isAdmin = userRole === ROLES.ADMIN
  const { getFileCategory, canPreview } = useMimeTypeDetection()
  const toast = useToast()

  const [showUploadModal, setShowUploadModal] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<{ data: Attachment; recordId: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ recordId: string; fileKey: string; fileName: string } | null>(null)
  const [filter, setFilter] = useState<string>('all')

  const { upload, downloadFile, readFile, deleteFile, isUploading } = useR2Files()

  // Realtime changes append regardless of requested order. ISO timestamps
  // sort lexicographically, so this keeps new uploads first without parsing.
  const { records: rawAttachments, status } = useQuery<Attachment>('attachments')
  const attachments = useMemo(
    () => [...rawAttachments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [rawAttachments],
  )
  const { create, remove } = useMutations<Attachment>('attachments')

  const filteredAttachments = useMemo(() => {
    if (filter === 'all') return attachments
    return attachments.filter(att => getFileCategory(att.data.mimeType, att.data.fileName) === filter)
  }, [attachments, filter, getFileCategory])

  // Refs deduplicate loads across realtime array refreshes and retain every
  // created object URL for cleanup.
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const inflightKeysRef = useRef<Set<string>>(new Set())
  const objectUrlsRef = useRef<Set<string>>(new Set())
  const isMountedRef = useRef(false)

  // Free every object URL, including URLs added after the initial render.
  useEffect(() => {
    const objectUrls = objectUrlsRef.current
    const inflightKeys = inflightKeysRef.current
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.clear()
      inflightKeys.clear()
    }
  }, [])

  const loadPreviewUrl = useCallback(async (fileKey: string, mimeType: string) => {
    if (inflightKeysRef.current.has(fileKey)) return
    inflightKeysRef.current.add(fileKey)
    try {
      const response = await readFile(fileKey)
      const rawBlob = await response.blob()
      if (!isMountedRef.current) return

      // Preserve the detected type for native media and preview parsers.
      const blob = new Blob([rawBlob], { type: mimeType || rawBlob.type })
      const url = URL.createObjectURL(blob)
      objectUrlsRef.current.add(url)
      setPreviewUrls(prev => ({ ...prev, [fileKey]: url }))
    } catch {
      // Preview not available — allow a retry on the next attachments push.
      inflightKeysRef.current.delete(fileKey)
    }
  }, [readFile])

  // Native thumbnails need their bytes immediately. Heavier document formats
  // are fetched only when selected, rather than eagerly downloading every
  // attachment in the collection.
  useEffect(() => {
    filteredAttachments.forEach(att => {
      const category = getFileCategory(att.data.mimeType, att.data.fileName)
      if (category === 'image' || category === 'video' || category === 'audio') {
        void loadPreviewUrl(att.data.fileKey, att.data.mimeType)
      }
    })
    if (previewAttachment) {
      const { fileKey, fileName, mimeType } = previewAttachment.data
      const category = getFileCategory(mimeType, fileName)
      if (canPreview(category)) void loadPreviewUrl(fileKey, mimeType)
    }
  }, [canPreview, filteredAttachments, getFileCategory, loadPreviewUrl, previewAttachment])

  const handleUpload = async (file: File, detectedMime: string) => {
    const result = await upload(file, file.name)
    if (!result.success || !result.key) {
      toast.error(result.error ?? 'Upload failed')
      return false
    }

    // `ownerId` is intentionally omitted — the schema declares it
    // `userBound: true, immutable: true`, so the server fills it in
    // from the authenticated caller and ignores any client-supplied
    // value. The Attachment type still includes it (stored records
    // always carry it), hence the cast.
    await create({
      fileName: file.name,
      fileKey: result.key,
      mimeType: detectedMime,
      fileSize: file.size,
    } as Attachment)
    toast.success('File uploaded')
    return true
  }

  const handleDeleteRequest = (recordId: string, fileKey: string, fileName: string) => {
    setDeleteTarget({ recordId, fileKey, fileName })
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    const result = await deleteFile(deleteTarget.fileKey)
    if (!result.success) {
      toast.error(result.error ?? 'Delete failed')
      return
    }
    await remove(deleteTarget.recordId)
    // Free the blob URL we created for this file and clear dedup state
    // so a future re-upload of the same key (rare but possible) can fetch.
    const url = previewUrls[deleteTarget.fileKey]
    if (url) {
      URL.revokeObjectURL(url)
      objectUrlsRef.current.delete(url)
    }
    inflightKeysRef.current.delete(deleteTarget.fileKey)
    setPreviewUrls(prev => {
      if (!(deleteTarget.fileKey in prev)) return prev
      const next = { ...prev }
      delete next[deleteTarget.fileKey]
      return next
    })
    setDeleteTarget(null)
    toast.success('File deleted')
  }

  const handleDownload = async (fileKey: string, fileName: string) => {
    const result = await downloadFile(fileKey, fileName)
    if (!result.success) toast.error(result.error ?? 'Download failed')
  }

  const isLoading = status === 'loading'

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: attachments.length }
    attachments.forEach(att => {
      const cat = getFileCategory(att.data.mimeType, att.data.fileName)
      counts[cat] = (counts[cat] ?? 0) + 1
    })
    return counts
  }, [attachments, getFileCategory])

  return (
    <div className="h-full bg-background overflow-y-auto">
      {/* Header */}
      <div className="bg-card/60 backdrop-blur-md border-b border-border sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-foreground">Attachments</h1>
              <p className="text-muted-foreground mt-1">
                {attachments.length} file{attachments.length !== 1 ? 's' : ''} uploaded
              </p>
            </div>
            {canUpload && (
              <Button onClick={() => setShowUploadModal(true)}>
                <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                Upload
              </Button>
            )}
          </div>

          {/* Filter badges */}
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 mt-4 overflow-x-auto pb-1">
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
                const count = categoryCounts[key] ?? 0
                if (key !== 'all' && count === 0) return null
                return (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                      filter === key
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {label} {count > 0 && `(${count})`}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
          </div>
        ) : attachments.length === 0 ? (
          <EmptyState
            title="No files yet"
            description={canUpload ? 'Upload your first file to get started' : 'No files have been uploaded yet'}
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            }
          />
        ) : filteredAttachments.length === 0 ? (
          <EmptyState
            title="No files match"
            description="Try a different filter"
            icon={
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredAttachments.map(att => {
              const isOwner = att.data.ownerId === user?.id
              const canDelete = isOwner || isAdmin
              const category = getFileCategory(att.data.mimeType, att.data.fileName)
              const url = previewUrls[att.data.fileKey] ?? null

              return (
                <div
                  key={att.recordId}
                  className="bg-card/60 rounded-xl border border-border overflow-hidden hover:border-border/80 transition-colors group"
                >
                  {/* Thumbnail */}
                  <div className="cursor-pointer" onClick={() => setPreviewAttachment(att)}>
                    <AttachmentThumbnail url={url} fileName={att.data.fileName} category={category} />
                  </div>

                  {/* Info */}
                  <div className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{att.data.fileName}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="secondary" size="sm">{category}</Badge>
                          <span className="text-xs text-muted-foreground">{formatFileSize(att.data.fileSize)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleDownload(att.data.fileKey, att.data.fileName)}
                          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded-lg transition-colors"
                          title="Download"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                        {canDelete && (
                          <button
                            onClick={() => handleDeleteRequest(att.recordId, att.data.fileKey, att.data.fileName)}
                            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/20 rounded-lg transition-colors"
                            title="Delete"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Upload Modal */}
      <UploadModal
        isOpen={showUploadModal}
        onClose={() => setShowUploadModal(false)}
        onUpload={handleUpload}
        isUploading={isUploading}
      />

      {/* Preview Modal */}
      <PreviewModal
        isOpen={!!previewAttachment}
        onClose={() => setPreviewAttachment(null)}
        attachment={previewAttachment}
        previewUrl={previewAttachment ? (previewUrls[previewAttachment.data.fileKey] ?? null) : null}
        onDownload={() => {
          if (previewAttachment) {
            handleDownload(previewAttachment.data.fileKey, previewAttachment.data.fileName)
          }
        }}
      />

      {/* Delete Confirmation Modal */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} size="sm" data-testid="delete-confirm-modal">
        <Modal.Header>
          <Modal.Title>Delete File</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <span className="font-medium text-foreground">{deleteTarget?.fileName}</span>? This cannot be undone.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button variant="destructive" onClick={handleDeleteConfirm}>Delete</Button>
        </Modal.Footer>
      </Modal>
    </div>
  )
}

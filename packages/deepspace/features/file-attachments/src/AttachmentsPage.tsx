/**
 * Attachments Page
 *
 * Demonstrates:
 * - useMimeTypeDetection for MIME detection and file categorization
 * - useFilePreview for centralized preview with dynamic imports
 * - useR2Files for file upload/download/delete (R2 storage)
 * - useQuery + useMutations for file metadata (collection records)
 *
 * To use: Copy to src/pages/ and add route in App.tsx
 */

import { useState, useCallback, useRef, useMemo, useEffect, type RefCallback } from 'react'
import {
  useUser,
  useQuery,
  useMutations,
  useR2Files,
  ROLES,
  formatFileSize,
  type Role,
} from 'deepspace'
import { Button, Modal, EmptyState, Badge } from '@/components/ui'
import { useMimeTypeDetection, type FileCategory } from '../hooks/useMimeTypeDetection'
import { useFilePreview } from '../hooks/useFilePreview'
import { MAX_FILE_SIZE } from '../constants/attachments-constants'

// ============================================================================
// Types
// ============================================================================

interface Attachment {
  fileName: string
  fileKey: string
  mimeType: string
  fileSize: number
  ownerId: string
}

// ============================================================================
// File Icon (fallback for non-previewable types)
// ============================================================================

const ICON_PATHS: Record<FileCategory, string> = {
  image: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  video: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  audio: 'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z',
  pdf: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
  document: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  spreadsheet: 'M3 10h18M3 14h18M9 4v16M15 4v16M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
  presentation: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  archive: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  text: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  other: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
}

function FileIcon({ category }: { category: FileCategory }) {
  return (
    <div className="w-full h-48 bg-muted/20 rounded-lg flex items-center justify-center">
      <svg className="w-12 h-12 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={ICON_PATHS[category]} />
      </svg>
    </div>
  )
}

// ============================================================================
// Thumbnail Preview (card grid view)
// ============================================================================

function ThumbnailPreview({ url, fileName, mimeType: _mimeType, category }: {
  url: string | null
  fileName: string
  mimeType: string
  category: FileCategory
}) {
  if (!url) return <FileIcon category={category} />

  switch (category) {
    case 'image':
      return <img src={url} alt={fileName} className="w-full h-48 object-cover rounded-t-xl" loading="lazy" />
    case 'video':
      return <video src={url} className="w-full h-48 rounded-t-xl bg-black" preload="metadata" muted />
    case 'audio':
      return (
        <div className="w-full h-48 bg-muted/20 rounded-t-xl flex flex-col items-center justify-center gap-2 px-4">
          <svg className="w-8 h-8 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={ICON_PATHS.audio} />
          </svg>
          <audio src={url} controls className="w-full" preload="metadata" />
        </div>
      )
    default:
      return <FileIcon category={category} />
  }
}

// ============================================================================
// DOCX Preview Renderer (needs its own component for proper ref management)
// ============================================================================

function DocxPreviewRenderer({ data, module: docxModule }: {
  data: ArrayBuffer
  module: typeof import('docx-preview')
}) {
  const styleRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)

  // Reset loading state when the document changes. This is a side effect
  // (setState), so it belongs in useEffect — `useMemo` is for computing
  // values, and React docs warn its body may not run under Concurrent Mode.
  useEffect(() => {
    setLoading(true)
  }, [data])

  const onContainerReady: RefCallback<HTMLDivElement> = useCallback((node) => {
    if (!node) return
    node.innerHTML = ''
    if (styleRef.current) styleRef.current.innerHTML = ''

    docxModule.renderAsync(data, node, styleRef.current ?? undefined, {
      className: 'docx-preview-page',
      inWrapper: true,
      ignoreWidth: true,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: true,
    }).then(() => setLoading(false))
      .catch(() => setLoading(false))
  }, [data, docxModule])

  return (
    <div className="w-full min-h-[400px] rounded-lg overflow-auto" style={{ background: '#e8e8e8' }}>
      {loading && (
        <div className="p-8 text-center text-muted-foreground">Loading document...</div>
      )}
      <div ref={styleRef} />
      <div ref={onContainerReady} style={{ minHeight: loading ? 0 : undefined }} />
      <style>{`
        .docx-preview-page-wrapper {
          background: #e8e8e8;
          padding: 16px 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
        }
        .docx-preview-page-wrapper > section.docx-preview-page {
          background: #ffffff !important;
          color: #1a1a1a !important;
          box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
          border-radius: 4px;
          overflow: hidden;
          width: 100% !important;
          padding: 24px !important;
          box-sizing: border-box !important;
        }
        .docx-preview-page-wrapper > section.docx-preview-page * {
          color: inherit;
        }
      `}</style>
    </div>
  )
}

// ============================================================================
// XLSX Preview Renderer (needs its own component for useState)
// ============================================================================

function XlsxPreviewRenderer({ data }: { data: import('../hooks/useFilePreview').XlsxData }) {
  const [activeSheet, setActiveSheet] = useState(0)
  const { sheets } = data
  const sheet = sheets[activeSheet]

  return (
    <div className="w-full">
      {sheets.length > 1 && (
        <div className="flex gap-1 px-2 py-1 bg-muted/30 border-b border-border overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSheet(i)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                i === activeSheet ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm font-mono">
            <thead>
              <tr>
                <th className="sticky top-0 px-3 py-2 text-right text-xs text-muted-foreground bg-muted/50 border-b-2 border-border">#</th>
                {sheet.headers.map((h, i) => (
                  <th key={i} className="sticky top-0 px-3 py-2 text-left font-semibold text-foreground bg-muted/50 border-b-2 border-border whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, ri) => (
                <tr key={ri} className={ri % 2 === 0 ? '' : 'bg-muted/20'}>
                  <td className="px-3 py-1.5 text-right text-xs text-muted-foreground border-b border-border/50">{ri + 1}</td>
                  {sheet.headers.map((_, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-foreground border-b border-border/50 whitespace-nowrap max-w-[300px] truncate">
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.truncated && (
            <div className="px-4 py-2 text-center text-xs text-muted-foreground bg-muted/30 border-t border-border">
              Showing first 500 rows. Download the file to see all data.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Full Preview Modal Content (uses useFilePreview)
// ============================================================================

function FullPreview({ url, fileName, mimeType }: { url: string; fileName: string; mimeType: string }) {
  const preview = useFilePreview({ url, fileName, mimeType })

  if (preview.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  if (preview.error) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Failed to load preview: {preview.error}
      </div>
    )
  }

  // Image
  if (preview.category === 'image') {
    return <img src={url} alt={fileName} className="w-full rounded-lg" />
  }

  // Video
  if (preview.category === 'video') {
    return <video src={url} controls className="w-full rounded-lg bg-black" />
  }

  // Audio
  if (preview.category === 'audio') {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <FileIcon category="audio" />
        <audio src={url} controls className="w-full" />
      </div>
    )
  }

  // PDF — render via PDF.js canvases (avoids iframe sandbox blocking)
  if (preview.category === 'pdf' && preview.pdfPages) {
    return (
      <div className="flex flex-col gap-4 overflow-auto" style={{ maxHeight: '80vh' }}>
        {preview.pdfPages.map((canvas, i) => {
          const aspectRatio = canvas.width / canvas.height
          return (
            <div
              key={i}
              ref={(el) => {
                if (el && !el.hasChildNodes()) {
                  canvas.style.width = '100%'
                  canvas.style.height = 'auto'
                  canvas.style.display = 'block'
                  el.appendChild(canvas)
                }
              }}
              className="w-full rounded-lg overflow-hidden border border-border bg-white flex-shrink-0"
              style={{ aspectRatio: `${aspectRatio}` }}
            />
          )
        })}
      </div>
    )
  }

  // Code/Text with CodeMirror
  if ((preview.category === 'code' || preview.category === 'text') && preview.textContent !== null) {
    if (preview.codeEditorKit) {
      const { Component, langExtensions, darkTheme } = preview.codeEditorKit
      return (
        <div className="w-full overflow-hidden rounded-lg border border-border">
          <Component
            value={preview.textContent}
            extensions={[...langExtensions, darkTheme]}
            readOnly
            editable={false}
            theme="dark"
            height="400px"
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: false }}
            style={{ fontSize: '13px' }}
          />
        </div>
      )
    }
    // Fallback: plain text
    return (
      <pre className="w-full p-4 bg-muted/20 rounded-lg border border-border text-sm text-foreground overflow-auto max-h-[400px] whitespace-pre-wrap">
        {preview.textContent}
      </pre>
    )
  }

  // CSV
  if (preview.csvData) {
    const { headers, rows, truncated } = preview.csvData
    return (
      <div className="w-full overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm font-mono">
          <thead>
            <tr>
              <th className="sticky top-0 px-3 py-2 text-right text-xs text-muted-foreground bg-muted/50 border-b-2 border-border">#</th>
              {headers.map((h, i) => (
                <th key={i} className="sticky top-0 px-3 py-2 text-left font-semibold text-foreground bg-muted/50 border-b-2 border-border whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? '' : 'bg-muted/20'}>
                <td className="px-3 py-1.5 text-right text-xs text-muted-foreground border-b border-border/50">{ri + 1}</td>
                {headers.map((_, ci) => (
                  <td key={ci} className="px-3 py-1.5 text-foreground border-b border-border/50 whitespace-nowrap max-w-[300px] truncate" title={row[ci] ?? ''}>
                    {row[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          <div className="px-4 py-2 text-center text-xs text-muted-foreground bg-muted/30 border-t border-border">
            Showing first 500 rows. Download the file to see all data.
          </div>
        )}
      </div>
    )
  }

  // DOCX — use DocxPreviewRenderer subcomponent to manage refs properly
  if (preview.category === 'document' && preview.docxData && preview.docxModule) {
    return <DocxPreviewRenderer data={preview.docxData} module={preview.docxModule} />
  }

  // XLSX
  if (preview.xlsxData) {
    return <XlsxPreviewRenderer data={preview.xlsxData} />
  }

  // Fallback — no preview available for this type
  return (
    <div className="flex flex-col items-center gap-4 p-12 text-center">
      <FileIcon category={preview.category} />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">No preview available</p>
        <p className="text-xs text-muted-foreground">
          Preview is not supported for this file type. You can download the file to view it.
        </p>
      </div>
    </div>
  )
}

// ============================================================================
// Category Filter Labels
// ============================================================================

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

// ============================================================================
// Upload Modal
// ============================================================================

interface UploadModalProps {
  isOpen: boolean
  onClose: () => void
  onUpload: (file: File, detectedMime: string) => Promise<void>
  isUploading: boolean
}

function UploadModal({ isOpen, onClose, onUpload, isUploading }: UploadModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [detectedType, setDetectedType] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { detectMimeType } = useMimeTypeDetection()

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large. Maximum size is ${formatFileSize(MAX_FILE_SIZE)}.`)
      return
    }

    setError(null)
    setSelectedFile(file)
    const mime = await detectMimeType(file)
    setDetectedType(mime)
  }

  const handleUpload = async () => {
    if (!selectedFile) return
    const mime = detectedType || await detectMimeType(selectedFile)
    await onUpload(selectedFile, mime)
    setSelectedFile(null)
    setDetectedType(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
    onClose()
  }

  const handleClose = () => {
    setSelectedFile(null)
    setDetectedType(null)
    setError(null)
    if (inputRef.current) inputRef.current.value = ''
    onClose()
  }

  return (
    <Modal open={isOpen} onClose={handleClose} size="sm" data-testid="upload-modal">
      <Modal.Header onClose={handleClose}>
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

// ============================================================================
// Preview Modal
// ============================================================================

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
      <Modal.Header onClose={onClose}>
        <Modal.Title>{fileName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          {previewUrl ? (
            <FullPreview url={previewUrl} fileName={fileName} mimeType={mimeType} />
          ) : (
            <FileIcon category="other" />
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

// ============================================================================
// Main Page
// ============================================================================

export default function AttachmentsPage() {
  const { user } = useUser()
  const userRole = (user?.role ?? ROLES.VIEWER) as Role
  const canUpload = userRole === ROLES.MEMBER || userRole === ROLES.ADMIN
  const isAdmin = userRole === ROLES.ADMIN
  const { getFileCategory } = useMimeTypeDetection()

  const [showUploadModal, setShowUploadModal] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<{ data: Attachment; recordId: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ recordId: string; fileKey: string; fileName: string } | null>(null)
  const [filter, setFilter] = useState<string>('all')

  // R2 file storage
  const { upload, downloadFile, readFile, deleteFile, isUploading } = useR2Files()

  // Collection records (metadata).
  //
  // We sort client-side instead of relying on the server's `orderDir: 'desc'`:
  // the SDK's RecordStore.applyChange always appends new records to the end
  // (see store.ts — the comment there even admits it only fits asc feeds),
  // so on a desc list a freshly-uploaded attachment would land at the bottom
  // until the next full fetch. ISO-8601 strings sort lexicographically, so
  // localeCompare on createdAt gives the right order without parsing dates.
  const { records: rawAttachments, status } = useQuery<Attachment>('attachments')
  const attachments = useMemo(
    () => [...rawAttachments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [rawAttachments],
  )
  const { create, remove } = useMutations<Attachment>('attachments')

  // Build preview URLs for previewable files.
  //
  // Dedup is ref-based, not state-based. The realtime subscription gives
  // `attachments` a fresh array reference on every server push (even when
  // contents are unchanged), which re-fires the load effect. If we deduped
  // via `previewUrls` state, the stale-closure race would let two pushes
  // start two parallel fetches for the same key, each calling
  // URL.createObjectURL → setPreviewUrls would swap the <img src> to a new
  // blob URL on settle → visible flash + leaked object URLs.
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({})
  const inflightKeysRef = useRef<Set<string>>(new Set())
  const objectUrlsRef = useRef<Set<string>>(new Set())

  const loadPreviewUrl = useCallback(async (fileKey: string, mimeType: string) => {
    if (inflightKeysRef.current.has(fileKey)) return
    inflightKeysRef.current.add(fileKey)
    try {
      const response = await readFile(fileKey)
      if (response) {
        const rawBlob = await response.blob()
        // Re-create blob with correct MIME type (Chrome blocks PDFs in iframes without it)
        const blob = new Blob([rawBlob], { type: mimeType || rawBlob.type })
        const url = URL.createObjectURL(blob)
        objectUrlsRef.current.add(url)
        setPreviewUrls(prev => ({ ...prev, [fileKey]: url }))
      }
    } catch {
      // Preview not available — allow a retry on the next attachments push.
      inflightKeysRef.current.delete(fileKey)
    }
  }, [readFile])

  // Load preview URLs for visible files.
  useEffect(() => {
    attachments.forEach(att => {
      loadPreviewUrl(att.data.fileKey, att.data.mimeType)
    })
  }, [attachments, loadPreviewUrl])

  // Free all blob URLs we created on unmount.
  useEffect(() => {
    return () => {
      // Read the refs' LATEST contents at unmount so we revoke every URL and
      // clear every key accumulated over the component's life. Capturing at
      // setup time (empty) would leak URLs; these are collection refs, not DOM
      // nodes.
      /* eslint-disable react-hooks/exhaustive-deps -- must revoke/clear the latest ref contents at unmount, not the empty setup-time values */
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url)
      objectUrlsRef.current.clear()
      inflightKeysRef.current.clear()
      /* eslint-enable react-hooks/exhaustive-deps */
    }
  }, [])

  // Filter attachments
  const filteredAttachments = useMemo(() => {
    if (filter === 'all') return attachments
    return attachments.filter(att => getFileCategory(att.data.mimeType, att.data.fileName) === filter)
  }, [attachments, filter, getFileCategory])

  // Handlers
  const handleUpload = async (file: File, detectedMime: string) => {
    const result = await upload(file, file.name)
    if (result.success && result.key) {
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
    }
  }

  const handleDeleteRequest = (recordId: string, fileKey: string, fileName: string) => {
    setDeleteTarget({ recordId, fileKey, fileName })
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    await deleteFile(deleteTarget.fileKey)
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
  }

  const handleDownload = async (fileKey: string, fileName: string) => {
    await downloadFile(fileKey, fileName)
  }

  const isLoading = status === 'loading'

  // Category counts for filter badges
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
                    <ThumbnailPreview url={url} fileName={att.data.fileName} mimeType={att.data.mimeType} category={category} />
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
        <Modal.Header onClose={() => setDeleteTarget(null)}>
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

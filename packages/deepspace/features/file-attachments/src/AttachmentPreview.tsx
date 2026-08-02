import { useEffect, useRef, useState } from 'react'

import { useFilePreview, type XlsxData } from '../hooks/useFilePreview'
import type { FileCategory } from '../hooks/useMimeTypeDetection'

const ICON_PATHS: Record<FileCategory, string> = {
  image:
    'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z',
  video:
    'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z',
  audio:
    'M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z',
  pdf: 'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
  document:
    'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  spreadsheet:
    'M3 10h18M3 14h18M9 4v16M15 4v16M3 6a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6z',
  presentation:
    'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  archive: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  code: 'M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4',
  text: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  other:
    'M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z',
}

function FileIcon({ category }: { category: FileCategory }) {
  return (
    <div
      className="flex h-48 w-full items-center justify-center rounded-lg bg-muted/20"
      role="img"
      aria-label={`${category} file`}
    >
      <svg
        className="h-12 w-12 text-muted-foreground/50"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d={ICON_PATHS[category]}
        />
      </svg>
    </div>
  )
}

export function AttachmentThumbnail({
  url,
  fileName,
  category,
}: {
  url: string | null
  fileName: string
  category: FileCategory
}) {
  if (!url) return <FileIcon category={category} />

  switch (category) {
    case 'image':
      return (
        <img
          src={url}
          alt={fileName}
          className="h-48 w-full rounded-t-xl object-cover"
          loading="lazy"
        />
      )
    case 'video':
      return (
        <video
          src={url}
          aria-label={`${fileName} preview`}
          className="h-48 w-full rounded-t-xl bg-black"
          preload="metadata"
          muted
        />
      )
    case 'audio':
      return (
        <div className="flex h-48 w-full flex-col items-center justify-center gap-2 rounded-t-xl bg-muted/20 px-4">
          <svg
            className="h-8 w-8 text-muted-foreground/50"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d={ICON_PATHS.audio}
            />
          </svg>
          <audio
            src={url}
            aria-label={fileName}
            controls
            className="w-full"
            preload="metadata"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )
    default:
      return <FileIcon category={category} />
  }
}

function TabularPreview({
  headers,
  rows,
  truncated,
}: {
  headers: string[]
  rows: string[][]
  truncated: boolean
}) {
  return (
    <div className="w-full overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse font-mono text-sm">
        <thead>
          <tr>
            <th className="sticky top-0 border-b-2 border-border bg-muted/50 px-3 py-2 text-right text-xs text-muted-foreground">
              #
            </th>
            {headers.map((header, index) => (
              <th
                key={`${index}-${header}`}
                className="sticky top-0 whitespace-nowrap border-b-2 border-border bg-muted/50 px-3 py-2 text-left font-semibold text-foreground"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 === 0 ? '' : 'bg-muted/20'}>
              <td className="border-b border-border/50 px-3 py-1.5 text-right text-xs text-muted-foreground">
                {rowIndex + 1}
              </td>
              {headers.map((_, columnIndex) => (
                <td
                  key={columnIndex}
                  className="max-w-[300px] truncate whitespace-nowrap border-b border-border/50 px-3 py-1.5 text-foreground"
                  title={row[columnIndex] ?? ''}
                >
                  {row[columnIndex] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div className="border-t border-border bg-muted/30 px-4 py-2 text-center text-xs text-muted-foreground">
          Showing first 500 rows. Download the file to see all data.
        </div>
      )}
    </div>
  )
}

function DocxPreview({
  data,
  module: docxModule,
}: {
  data: ArrayBuffer
  module: typeof import('docx-preview')
}) {
  const styleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const content = contentRef.current
    const styles = styleRef.current
    if (!content || !styles) return

    let active = true
    setStatus('loading')
    content.replaceChildren()
    styles.replaceChildren()

    void docxModule
      .renderAsync(data, content, styles, {
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
      })
      .then(
        () => {
          if (active) setStatus('ready')
        },
        () => {
          if (active) setStatus('error')
        },
      )

    return () => {
      active = false
      content.replaceChildren()
      styles.replaceChildren()
    }
  }, [data, docxModule])

  return (
    <div
      className="min-h-[400px] w-full overflow-auto rounded-lg"
      style={{ background: '#e8e8e8' }}
    >
      {status === 'loading' && (
        <div className="p-8 text-center text-muted-foreground">Loading document...</div>
      )}
      {status === 'error' && (
        <div className="p-8 text-center text-muted-foreground">Failed to render document.</div>
      )}
      <div ref={styleRef} />
      <div ref={contentRef} />
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

function XlsxPreview({ data }: { data: XlsxData }) {
  const [activeSheet, setActiveSheet] = useState(0)

  useEffect(() => {
    setActiveSheet(0)
  }, [data])

  const sheet = data.sheets[activeSheet] ?? data.sheets[0]
  if (!sheet) {
    return <div className="p-8 text-center text-muted-foreground">This workbook has no sheets.</div>
  }

  return (
    <div className="w-full">
      {data.sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-muted/30 px-2 py-1">
          {data.sheets.map((candidate, index) => (
            <button
              key={candidate.name}
              type="button"
              onClick={() => setActiveSheet(index)}
              className={`whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors ${
                index === activeSheet
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      )}
      <TabularPreview headers={sheet.headers} rows={sheet.rows} truncated={sheet.truncated} />
    </div>
  )
}

function PdfPage({ canvas }: { canvas: HTMLCanvasElement }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    canvas.style.width = '100%'
    canvas.style.height = 'auto'
    canvas.style.display = 'block'
    container.replaceChildren(canvas)
    return () => {
      if (canvas.parentNode === container) canvas.remove()
    }
  }, [canvas])

  return (
    <div
      ref={containerRef}
      className="w-full flex-shrink-0 overflow-hidden rounded-lg border border-border bg-white"
      style={{ aspectRatio: `${canvas.width / canvas.height}` }}
    />
  )
}

export function AttachmentPreview({
  url,
  fileName,
  mimeType,
}: {
  url: string
  fileName: string
  mimeType: string
}) {
  const preview = useFilePreview({ url, fileName, mimeType })

  if (preview.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
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

  if (preview.category === 'image') {
    return <img src={url} alt={fileName} className="w-full rounded-lg" />
  }

  if (preview.category === 'video') {
    return <video src={url} aria-label={fileName} controls className="w-full rounded-lg bg-black" />
  }

  if (preview.category === 'audio') {
    return (
      <div className="flex flex-col items-center gap-4 p-8">
        <FileIcon category="audio" />
        <audio src={url} aria-label={fileName} controls className="w-full" />
      </div>
    )
  }

  if (preview.category === 'pdf' && preview.pdfPages) {
    return (
      <div className="flex max-h-[80vh] flex-col gap-4 overflow-auto">
        {preview.pdfPages.map((canvas, index) => (
          <PdfPage key={index} canvas={canvas} />
        ))}
      </div>
    )
  }

  if (
    (preview.category === 'code' || preview.category === 'text') &&
    preview.textContent !== null
  ) {
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

    return (
      <pre className="max-h-[400px] w-full overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-4 text-sm text-foreground">
        {preview.textContent}
      </pre>
    )
  }

  if (preview.csvData) {
    return <TabularPreview {...preview.csvData} />
  }

  if (preview.category === 'document' && preview.docxData && preview.docxModule) {
    return <DocxPreview data={preview.docxData} module={preview.docxModule} />
  }

  if (preview.xlsxData) {
    return <XlsxPreview data={preview.xlsxData} />
  }

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

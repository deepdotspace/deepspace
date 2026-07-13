/**
 * useFilePreview — Centralized file preview hook with dynamic imports.
 *
 * Mirrors the main app's pattern:
 * - Image, video, audio, PDF → native browser elements (no extra deps)
 * - Code/text → CodeMirror (dynamically imported)
 * - CSV → PapaParse (dynamically imported)
 * - DOCX → docx-preview (dynamically imported)
 * - XLSX → ExcelJS (dynamically imported)
 *
 * Heavy libraries are only loaded when needed, keeping the base bundle small.
 *
 * @example
 * ```tsx
 * const { PreviewComponent, isLoading, error } = useFilePreview({
 *   url: 'https://...',
 *   fileName: 'report.csv',
 *   mimeType: 'text/csv',
 * })
 *
 * return <PreviewComponent />
 * ```
 */

import { useState, useEffect } from 'react'
import { getFileCategory, getExtension, type FileCategory } from './useMimeTypeDetection'

// ============================================================================
// Types
// ============================================================================

export interface FilePreviewInput {
  /** URL to fetch the file content from (R2 download URL or blob URL) */
  url: string
  /** Original file name (used for extension-based detection) */
  fileName: string
  /** MIME type of the file */
  mimeType: string
}

export interface FilePreviewResult {
  /** The file category determined from MIME type + extension */
  category: FileCategory
  /** Whether the file type supports inline preview */
  canPreview: boolean
  /** Whether preview content is still loading */
  isLoading: boolean
  /** Error message if preview failed to load */
  error: string | null
  /** Loaded text content (for code and plain-text files; CSV uses csvData) */
  textContent: string | null
  /** Parsed CSV data: [headerRow, ...dataRows] */
  csvData: { headers: string[]; rows: string[][]; truncated: boolean } | null
  /** Loaded CodeMirror editor kit (dynamically imported) */
  codeEditorKit: CodeEditorKit | null
  /** Fetched DOCX ArrayBuffer (render with docx-preview in a callback ref) */
  docxData: ArrayBuffer | null
  /** Dynamically loaded docx-preview module */
  docxModule: typeof import('docx-preview') | null
  /** Parsed XLSX data with multiple sheets */
  xlsxData: XlsxData | null
  /** Rendered PDF page canvases (via PDF.js) */
  pdfPages: HTMLCanvasElement[] | null
}

export interface CodeEditorKit {
  Component: React.ComponentType<Record<string, unknown>>
  /** Opaque CodeMirror Extension objects (dynamically imported, no stable public type here). */
  langExtensions: unknown[]
  /** Opaque CodeMirror theme Extension. */
  darkTheme: unknown
}

export interface XlsxSheet {
  name: string
  headers: string[]
  rows: string[][]
  truncated: boolean
}

export interface XlsxData {
  sheets: XlsxSheet[]
  activeSheet: number
}

// ============================================================================
// Constants
// ============================================================================

const MAX_PREVIEW_ROWS = 500

// ============================================================================
// Language mode detection for CodeMirror
// ============================================================================

type LanguageMode = 'javascript' | 'typescript' | 'plain'

function getLanguageMode(fileName: string): LanguageMode {
  const ext = getExtension(fileName)
  switch (ext) {
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'ts':
    case 'tsx':
      return 'typescript'
    default:
      return 'plain'
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useFilePreview({ url, fileName, mimeType }: FilePreviewInput): FilePreviewResult {
  const category = getFileCategory(mimeType, fileName)
  const extension = getExtension(fileName)
  const previewable = isPreviewable(category, extension)

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [csvData, setCsvData] = useState<FilePreviewResult['csvData']>(null)
  const [codeEditorKit, setCodeEditorKit] = useState<CodeEditorKit | null>(null)
  const [xlsxData, setXlsxData] = useState<XlsxData | null>(null)
  const [docxData, setDocxData] = useState<ArrayBuffer | null>(null)
  const [docxModule, setDocxModule] = useState<typeof import('docx-preview') | null>(null)
  const [pdfPages, setPdfPages] = useState<HTMLCanvasElement[] | null>(null)

  // Load preview content based on category
  useEffect(() => {
    if (!previewable || !url) return

    // Native browser previews (image, video, audio) don't need fetching
    // PDF uses PDF.js now (rendered to canvas) to avoid iframe sandbox issues
    if (category === 'image' || category === 'video' || category === 'audio') {
      return
    }

    const controller = new AbortController()
    let cancelled = false

    setIsLoading(true)
    setError(null)
    setTextContent(null)
    setCsvData(null)
    setXlsxData(null)
    setDocxData(null)
    setDocxModule(null)
    setPdfPages(null)

    async function loadPreview() {
      try {
        if (category === 'pdf') {
          await loadPdfPreview(url, controller.signal, cancelled, setPdfPages, setError)
        } else if (category === 'code' || category === 'text') {
          await loadCodePreview(url, fileName, controller.signal, cancelled, setTextContent, setCodeEditorKit)
        } else if (extension === 'csv' || extension === 'tsv') {
          await loadCsvPreview(url, controller.signal, cancelled, setCsvData)
        } else if (extension === 'docx') {
          await loadDocxPreview(url, controller.signal, cancelled, setDocxData, setDocxModule)
        } else if (extension === 'xlsx' || extension === 'xls') {
          await loadXlsxPreview(url, controller.signal, cancelled, setXlsxData)
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          setError(err instanceof Error ? err.message : 'Failed to load preview')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    loadPreview()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [url, fileName, mimeType, category, extension, previewable])

  return {
    category,
    canPreview: previewable,
    isLoading,
    error,
    textContent,
    csvData,
    codeEditorKit,
    docxData,
    docxModule,
    xlsxData,
    pdfPages,
  }
}

// ============================================================================
// Preview loaders (each dynamically imports its heavy dependency)
// ============================================================================

function isPreviewable(category: FileCategory, extension: string): boolean {
  if (['image', 'video', 'audio', 'pdf', 'code', 'text'].includes(category)) return true
  if (['csv', 'tsv', 'docx', 'xlsx', 'xls'].includes(extension)) return true
  return false
}

async function loadCodePreview(
  url: string,
  fileName: string,
  signal: AbortSignal,
  cancelled: boolean,
  setTextContent: (v: string) => void,
  setCodeEditorKit: (v: CodeEditorKit) => void,
) {
  const [response, ...editorModules] = await Promise.all([
    fetch(url, { signal }),
    import('@uiw/react-codemirror').catch(() => null),
    import('@codemirror/lang-javascript').catch(() => null),
    import('@codemirror/theme-one-dark').catch(() => null),
  ])

  if (cancelled) return
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const text = await response.text()
  if (cancelled) return

  // Pretty-print minified JSON before handing it to CodeMirror. Files like
  // `package-lock.json` or build manifests are often shipped as one long
  // line, which CodeMirror has no way to re-indent — so the user sees a
  // single horizontal-scroll bar. JSON.parse → JSON.stringify with 2-space
  // indent gives a properly-formatted view at the cost of a transient
  // memory peak; we cap the input at 5 MB to keep that peak bounded. On
  // any failure (invalid JSON, oversize) we render the original text as-is
  // instead of erroring — the user still gets a preview, just unformatted.
  let displayText = text
  if (fileName.toLowerCase().endsWith('.json') && text.length < 5_000_000) {
    try {
      displayText = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Not valid JSON — leave as-is.
    }
  }
  setTextContent(displayText)

  const [cmModule, jsModule, themeModule] = editorModules
  if (cmModule && jsModule && themeModule) {
    const mode = getLanguageMode(fileName)
    const langExtensions: unknown[] = []

    if (mode === 'javascript') {
      langExtensions.push(jsModule.javascript({ jsx: true }))
    } else if (mode === 'typescript') {
      langExtensions.push(jsModule.javascript({ jsx: true, typescript: true }))
    }

    setCodeEditorKit({
      Component: cmModule.default,
      langExtensions,
      darkTheme: themeModule.oneDark,
    })
  }
}

async function loadCsvPreview(
  url: string,
  signal: AbortSignal,
  cancelled: boolean,
  setCsvData: (v: FilePreviewResult['csvData']) => void,
) {
  const [response, Papa] = await Promise.all([
    fetch(url, { signal }),
    import('papaparse'),
  ])

  if (cancelled) return
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const text = await response.text()
  if (cancelled) return

  const result = Papa.default.parse<string[]>(text, { skipEmptyLines: true })
  const allRows = result.data

  if (allRows.length === 0) {
    setCsvData({ headers: [], rows: [], truncated: false })
    return
  }

  const headers = allRows[0]
  const truncated = allRows.length > MAX_PREVIEW_ROWS + 1
  const rows = truncated ? allRows.slice(1, MAX_PREVIEW_ROWS + 1) : allRows.slice(1)

  setCsvData({ headers, rows, truncated })
}

async function loadDocxPreview(
  url: string,
  signal: AbortSignal,
  cancelled: boolean,
  setDocxData: (v: ArrayBuffer) => void,
  setDocxModule: (v: typeof import('docx-preview')) => void,
) {
  const [response, docxPreviewModule] = await Promise.all([
    fetch(url, { signal }),
    import('docx-preview'),
  ])

  if (cancelled) return
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const arrayBuffer = await response.arrayBuffer()
  if (cancelled) return

  setDocxData(arrayBuffer)
  setDocxModule(docxPreviewModule)
}

async function loadXlsxPreview(
  url: string,
  signal: AbortSignal,
  cancelled: boolean,
  setXlsxData: (v: XlsxData) => void,
) {
  const [response, ExcelJSModule] = await Promise.all([
    fetch(url, { signal }),
    import('exceljs'),
  ])

  if (cancelled) return
  if (!response.ok) throw new Error(`HTTP ${response.status}`)

  const arrayBuffer = await response.arrayBuffer()
  if (cancelled) return

  const ExcelJS = (ExcelJSModule as { default?: typeof import('exceljs') }).default ?? ExcelJSModule
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(arrayBuffer)
  if (cancelled) return

  // Bounded recursion: a malformed XLSX could in theory produce
  // `{result: {result: {result: ...}}}` chains that blow the stack.
  // ExcelJS doesn't surface cycles today, but a depth cap is essentially
  // free insurance against a crafted-input DoS.
  const MAX_CELL_DEPTH = 8
  const cellToString = (value: unknown, depth = 0): string => {
    if (value == null) return ''
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }
    if (value instanceof Date) return value.toISOString()
    if (depth >= MAX_CELL_DEPTH) return ''
    if (typeof value === 'object') {
      const v = value as { result?: unknown; text?: unknown; richText?: Array<{ text: string }>; hyperlink?: string }
      if (v.result != null) return cellToString(v.result, depth + 1)
      if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('')
      if (typeof v.text === 'string') return v.text
      if (typeof v.hyperlink === 'string') return v.hyperlink
    }
    return String(value)
  }

  const sheets: XlsxSheet[] = workbook.worksheets.map(ws => {
    const allRows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      // row.values is 1-indexed; slice(1) gives a dense-ish array
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      for (const v of values) cells.push(cellToString(v))
      allRows.push(cells)
    })

    if (allRows.length === 0) {
      return { name: ws.name, headers: [], rows: [], truncated: false }
    }

    const headers = allRows[0]
    const truncated = allRows.length > MAX_PREVIEW_ROWS + 1
    const rows = truncated
      ? allRows.slice(1, MAX_PREVIEW_ROWS + 1)
      : allRows.slice(1)

    return { name: ws.name, headers, rows, truncated }
  })

  setXlsxData({ sheets, activeSheet: 0 })
}

// ============================================================================
// PDF.js loader — renders PDF pages to canvas (avoids iframe sandbox issues).
//
// Bundled via `pdfjs-dist` (declared in this feature's feature.json
// dependencies) rather than fetched from a third-party CDN at runtime.
// Loading from cdnjs without SRI would have meant any cdnjs compromise =
// arbitrary JS in the app origin with full auth/R2 access.
//
// The worker is imported via Vite's `?worker` suffix, which returns a
// `Worker` constructor that Vite builds and bundles separately. We hand
// the instantiated worker to pdfjs as `workerPort`. This is more robust
// than `workerSrc` + a URL because it sidesteps Cloudflare's static
// asset handler, which serves `.mjs` with a generic MIME and breaks
// the dynamic-import path pdfjs uses to bootstrap its fake worker.
//
// Both the lib and worker module are dynamic-imported so they're
// code-split into their own chunks — the base bundle stays small, and
// the worker module only downloads when a user actually previews a PDF.
// ============================================================================

let pdfjsLoadPromise: Promise<typeof import('pdfjs-dist')> | null = null

async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  if (pdfjsLoadPromise) return pdfjsLoadPromise

  pdfjsLoadPromise = (async () => {
    const [pdfjsLib, workerModule] = await Promise.all([
      import('pdfjs-dist'),
      // Vite's `?worker` suffix yields a Worker constructor (typed via vite/client).
      import('pdfjs-dist/build/pdf.worker.min.mjs?worker'),
    ])
    const PdfWorker = (workerModule as { default: new () => Worker }).default
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()
    return pdfjsLib
  })()

  return pdfjsLoadPromise
}

async function loadPdfPreview(
  url: string,
  signal: AbortSignal,
  cancelled: boolean,
  setPdfPages: (v: HTMLCanvasElement[]) => void,
  setError: (v: string) => void,
) {
  try {
    const pdfjsLib = await loadPdfJs()
    if (cancelled) return

    const response = await fetch(url, { signal })
    if (cancelled) return
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const arrayBuffer = await response.arrayBuffer()
    if (cancelled) return

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
    if (cancelled) return

    const canvases: HTMLCanvasElement[] = []
    const SCALE = 1.5

    for (let i = 1; i <= pdf.numPages; i++) {
      if (cancelled) return
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: SCALE })

      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height

      const ctx = canvas.getContext('2d')!
      await page.render({ canvasContext: ctx, viewport }).promise
      canvases.push(canvas)
    }

    if (!cancelled) setPdfPages(canvases)
  } catch (err) {
    if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
      setError(err instanceof Error ? err.message : 'Failed to load PDF')
    }
  }
}

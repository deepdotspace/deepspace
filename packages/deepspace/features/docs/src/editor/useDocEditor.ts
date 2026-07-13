/**
 * Tiptap editor hook bound to a Yjs `XmlFragment` + Awareness.
 *
 * Why Tiptap vs the old contenteditable approach:
 *   - Y.XmlFragment is a structured CRDT — remote keystrokes become
 *     fine-grained ProseMirror transactions, not an `innerHTML` swap.
 *   - Local caret survives concurrent remote edits via ProseMirror's
 *     position-mapping system (no manual probe / restore).
 *   - Remote cursors come from `@tiptap/extension-collaboration-caret`
 *     reading the same Awareness instance our WS hook already wires.
 *   - No HTML round-trip in storage, so browser-inserted artefacts
 *     (`&nbsp;`, `<div><br></div>`, IME composition state) cannot
 *     corrupt the shared document.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import type { Awareness } from 'deepspace'
import type * as Y from 'yjs'

type CollaborationUser = {
  name?: string | null
  color?: string | null
}

const DEFAULT_COLLABORATION_COLOR = '#2563eb'
const DISALLOWED_COLLABORATION_COLORS = new Set([
  '#fff',
  '#ffff',
  '#ffffff',
  '#ffffffff',
  'white',
  'rgb(255, 255, 255)',
  'rgba(255, 255, 255, 1)',
])

export interface UseDocEditorOptions {
  doc: Y.Doc
  /** Awareness instance shared with the Yjs WS hook (or null while not yet connected). */
  awareness: Awareness | null
  userName: string
  userColor: string
  synced: boolean
  canWrite: boolean
  placeholder?: string
}

function collaborationColorFor(user: CollaborationUser): string {
  const color = user.color?.trim()
  if (!color || DISALLOWED_COLLABORATION_COLORS.has(color.toLowerCase())) {
    return DEFAULT_COLLABORATION_COLOR
  }
  return color
}

function renderCollaborationCaret(user: CollaborationUser): HTMLElement {
  const color = collaborationColorFor(user)
  const cursor = document.createElement('span')
  cursor.classList.add('collaboration-carets__caret')
  cursor.style.setProperty('--collaboration-caret-color', color)
  cursor.setAttribute('aria-hidden', 'true')

  const label = document.createElement('span')
  label.classList.add('collaboration-carets__label')
  label.style.backgroundColor = `color-mix(in srgb, ${color} 16%, var(--docs-editor-paper))`
  label.style.color = color
  label.textContent = user.name || 'Collaborator'
  cursor.appendChild(label)

  return cursor
}

function renderCollaborationSelection(user: CollaborationUser) {
  const color = collaborationColorFor(user)
  return {
    class: 'ProseMirror-yjs-selection collaboration-carets__selection',
    style: `background-color: color-mix(in srgb, ${color} 20%, transparent)`,
  }
}

/** Pasted HTML sometimes carries our own collab caret nodes — scrub them. */
function stripCollaborationArtifactsFromHTML(html: string): string {
  if (typeof document === 'undefined') return html

  const container = document.createElement('div')
  container.innerHTML = html

  container
    .querySelectorAll('.collaboration-carets__caret, .collaboration-carets__label')
    .forEach((node) => node.remove())

  container
    .querySelectorAll('.ProseMirror-yjs-selection, .collaboration-carets__selection')
    .forEach((node) => {
      node.replaceWith(...Array.from(node.childNodes))
    })

  return container.innerHTML
}

export function useDocEditor({
  doc,
  awareness,
  userName,
  userColor,
  synced,
  canWrite,
  placeholder = 'Start typing — toolbar above for formatting…',
}: UseDocEditorOptions): Editor | null {
  /** Structured CRDT field that ProseMirror binds to — distinct from the legacy Y.Text('content'). */
  const fragment = useMemo(() => doc.getXmlFragment('default'), [doc])

  /** CollaborationCaret expects a provider-shaped `{ awareness }` object. */
  const provider = useMemo(() => (awareness ? { awareness } : null), [awareness])

  const extensions = useMemo(() => {
    const exts: unknown[] = [
      StarterKit.configure({
        // Yjs has its own undo/redo history via the Collaboration extension; keeping
        // both enabled corrupts the shared document on undo.
        undoRedo: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Collaboration.configure({ fragment }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: { class: 'docs-text-highlight' },
      }),
      Subscript,
      Superscript,
      TaskList,
      TaskItem.configure({ nested: true }),
      Typography,
      Placeholder.configure({ placeholder }),
    ]

    if (provider) {
      exts.push(
        CollaborationCaret.configure({
          provider,
          user: { name: userName, color: userColor },
          render: renderCollaborationCaret,
          selectionRender: renderCollaborationSelection,
        }),
      )
    }

    return exts
  }, [fragment, provider, userName, userColor, placeholder])

  const editor = useEditor(
    {
      editable: synced && canWrite,
      // Tiptap renders synchronously by default which trips up React's strict mode
      // in dev (the editor view is destroyed and re-created, and any subscriber
      // that runs in between throws on `editor.view`). Defer to a useEffect.
      immediatelyRender: false,
      // Bare directive on purpose: naming @typescript-eslint/no-explicit-any
      // here is a hard "unknown rule" error under the scaffolded app's
      // minimal eslint config (which never registers that plugin), while the
      // SDK monorepo's config does enable the rule and needs the suppression.
      // eslint-disable-next-line
      extensions: extensions as any,
      editorProps: {
        transformPastedHTML: stripCollaborationArtifactsFromHTML,
        attributes: {
          class: 'docs-tiptap-editor',
          'data-testid': 'docs-tiptap-editor',
        },
      },
    },
    [extensions],
  )

  /**
   * Toggle editable without thrashing the editor: setEditable is cheap and
   * preserves selection/awareness, whereas re-creating the editor on every
   * `synced`/`canWrite` change would flicker remote carets and reset undo.
   */
  const prevEditable = useRef(false)
  useEffect(() => {
    const editable = synced && canWrite
    if (editor && editable !== prevEditable.current) {
      prevEditable.current = editable
      editor.setEditable(editable)
    }
  }, [editor, synced, canWrite])

  return editor
}

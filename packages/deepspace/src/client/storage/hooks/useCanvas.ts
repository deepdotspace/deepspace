/**
 * useCanvas — Connect to a CanvasRoom Durable Object.
 *
 * Opens a WebSocket to /ws/canvas/:roomId for collaborative spatial editing.
 *
 * @example
 * const { shapes, addShape, moveShape, deleteShape, viewports } = useCanvas('my-canvas')
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { getAuthToken } from '../../auth'
import { wsLog } from '../ws-log'
import { MSG } from '@/shared/protocol/constants'
import {
  clientBuild,
  dispatch,
  encode,
  type ServerMessage,
} from '@/shared/protocol/messages'

export interface CanvasShapeClient {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  props: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ViewportClient {
  userId: string
  x: number
  y: number
  width: number
  height: number
  zoom: number
}

export interface UseCanvasResult {
  /** All shapes on the canvas */
  shapes: CanvasShapeClient[]
  /** Other users' viewports */
  viewports: ViewportClient[]
  /** Whether WebSocket is connected */
  connected: boolean
  /**
   * Whether this connection has write access (member/admin role). The
   * write callbacks below no-op when this is false; UIs should also use
   * it to disable controls so viewers see why their clicks do nothing.
   * Viewport reporting stays available regardless — it's presence info.
   */
  canWrite: boolean
  /** Add a shape (no-op when canWrite is false) */
  addShape: (shape: Partial<CanvasShapeClient>) => void
  /** Move a shape (no-op when canWrite is false) */
  moveShape: (shapeId: string, x: number, y: number) => void
  /** Resize a shape (no-op when canWrite is false) */
  resizeShape: (shapeId: string, width: number, height: number, x?: number, y?: number) => void
  /** Delete a shape (no-op when canWrite is false) */
  deleteShape: (shapeId: string) => void
  /** Update shape properties (no-op when canWrite is false) */
  updateShape: (shapeId: string, props: Record<string, unknown>) => void
  /** Report local viewport (allowed for viewers — presence-like) */
  setViewport: (viewport: Omit<ViewportClient, 'userId'>) => void
  /** Undo last action (no-op when canWrite is false) */
  undo: () => void
  /** Redo last undone action (no-op when canWrite is false) */
  redo: () => void
}

export function useCanvas(roomId: string): UseCanvasResult {
  const [shapes, setShapes] = useState<CanvasShapeClient[]>([])
  const [viewports, setViewports] = useState<ViewportClient[]>([])
  const [connected, setConnected] = useState(false)
  // Defaults to false: until the server's AUTH frame arrives, assume the
  // safer no-write posture so UIs don't briefly enable controls for a
  // viewer mid-handshake.
  const [canWrite, setCanWrite] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let alive = true

    const connect = async () => {
      if (!alive) return

      const token = await getAuthToken()
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const baseUrl = `${protocol}//${window.location.host}`
      const url = new URL(`/ws/canvas/${encodeURIComponent(roomId)}`, baseUrl)
      if (token) url.searchParams.set('token', token)

      wsLog('connecting', `canvas:${roomId}`)
      ws = new WebSocket(url.toString())
      wsRef.current = ws

      ws.onopen = () => {
        wsLog('connected', `canvas:${roomId}`)
        setConnected(true)
      }

      ws.onmessage = (event) => {
        // Typed dispatch — handler payloads are narrowed by the SDK's
        // discriminated `ServerMessage` union. Shape/viewport objects
        // on the wire are typed as `unknown` (the protocol layer
        // doesn't know the app's domain types), so we cast to the
        // local `CanvasShapeClient` / `ViewportClient` where we use
        // them.
        dispatch<ServerMessage>(event.data, {
          [MSG.AUTH]: (p) => {
            setCanWrite(p.canWrite)
          },
          [MSG.CANVAS_SHAPES]: (p) => {
            setShapes(p.shapes as CanvasShapeClient[])
            setViewports(p.viewports as ViewportClient[])
          },
          [MSG.CANVAS_ADD]: (p) => {
            const shape = p.shape as CanvasShapeClient
            setShapes((prev) => [...prev.filter((s) => s.id !== shape.id), shape])
          },
          [MSG.CANVAS_MOVE]: (p) => {
            setShapes((prev) =>
              prev.map((s) => (s.id === p.shapeId ? { ...s, x: p.x, y: p.y } : s)),
            )
          },
          [MSG.CANVAS_RESIZE]: (p) => {
            setShapes((prev) =>
              prev.map((s) => {
                if (s.id !== p.shapeId) return s
                const updated = { ...s, width: p.width, height: p.height }
                if (p.x !== undefined) updated.x = p.x
                if (p.y !== undefined) updated.y = p.y
                return updated
              }),
            )
          },
          [MSG.CANVAS_DELETE]: (p) => {
            setShapes((prev) => prev.filter((s) => s.id !== p.shapeId))
          },
          [MSG.CANVAS_UPDATE]: (p) => {
            setShapes((prev) =>
              prev.map((s) =>
                s.id === p.shapeId ? { ...s, props: { ...s.props, ...p.props } } : s,
              ),
            )
          },
          [MSG.CANVAS_VIEWPORT]: (p) => {
            // The payload is a union of `{ viewport }` and
            // `{ userId, removed: true }` — narrow by presence.
            if ('removed' in p) {
              const removed = p
              setViewports((prev) => prev.filter((v) => v.userId !== removed.userId))
            } else {
              const viewport = p.viewport as ViewportClient
              setViewports((prev) => [
                ...prev.filter((v) => v.userId !== viewport.userId),
                viewport,
              ])
            }
          },
        })
      }

      ws.onclose = () => {
        wsLog('disconnected', `canvas:${roomId}`)
        wsRef.current = null
        setConnected(false)
        // Reset to the safe default so a reconnect with a degraded role
        // (e.g. JWT expired, user now anon) doesn't leave write buttons
        // enabled until the new AUTH frame arrives. The fresh server
        // onConnect will re-send AUTH with the current canWrite value.
        setCanWrite(false)
        if (alive) reconnectTimer = setTimeout(connect, 1000)
      }

      ws.onerror = () => ws?.close()
    }

    connect()

    return () => {
      wsLog('closing', `canvas:${roomId}`)
      alive = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (ws) {
        ws.onclose = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      }
      wsRef.current = null
    }
  }, [roomId])

  // Typed builders — `clientBuild.canvasX` returns a validated
  // `ClientMessage` that `encode` stringifies. No hand-rolled
  // `JSON.stringify({ type, payload })` calls here.
  const sendBuilt = useCallback(
    <M extends { type: string; payload: unknown }>(message: M) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(encode(message))
    },
    [],
  )

  // Local write-gate: write callbacks short-circuit when canWrite is
  // false. The server enforces the same rule (see CanvasRoom.onMessage),
  // so this is a UX layer — viewers click a button and get instant
  // "nothing happened" instead of a round-trip ERROR.
  const sendWrite = useCallback(
    <M extends { type: string; payload: unknown }>(message: M) => {
      if (!canWrite) return
      sendBuilt(message)
    },
    [sendBuilt, canWrite],
  )

  const addShape = useCallback(
    (shape: Partial<CanvasShapeClient>) => sendWrite(clientBuild.canvasAdd(shape)),
    [sendWrite],
  )

  const moveShape = useCallback(
    (shapeId: string, x: number, y: number) =>
      sendWrite(clientBuild.canvasMove(shapeId, x, y)),
    [sendWrite],
  )

  const resizeShape = useCallback(
    (shapeId: string, width: number, height: number, x?: number, y?: number) =>
      sendWrite(clientBuild.canvasResize(shapeId, width, height, x, y)),
    [sendWrite],
  )

  const deleteShape = useCallback(
    (shapeId: string) => sendWrite(clientBuild.canvasDelete(shapeId)),
    [sendWrite],
  )

  const updateShape = useCallback(
    (shapeId: string, props: Record<string, unknown>) =>
      sendWrite(clientBuild.canvasUpdate(shapeId, props)),
    [sendWrite],
  )

  // Viewport stays on sendBuilt (not sendWrite): broadcasting "I'm
  // looking here" is presence-like and intentionally allowed for
  // viewers, matching the server's CanvasRoom gate.
  const setViewport = useCallback(
    (viewport: Omit<ViewportClient, 'userId'>) =>
      sendBuilt(clientBuild.canvasViewport(viewport)),
    [sendBuilt],
  )

  const undo = useCallback(() => sendWrite(clientBuild.canvasUndo()), [sendWrite])
  const redo = useCallback(() => sendWrite(clientBuild.canvasRedo()), [sendWrite])

  return { shapes, viewports, connected, canWrite, addShape, moveShape, resizeShape, deleteShape, updateShape, setViewport, undo, redo }
}

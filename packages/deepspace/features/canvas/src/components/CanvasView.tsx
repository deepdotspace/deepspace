/**
 * CanvasView — SVG canvas with shape rendering, mouse interaction, zoom/pan, and multi-user cursors.
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { useCanvas } from 'deepspace'
import { CanvasToolbar, type CanvasTool } from './CanvasToolbar'
import { ShapeRenderer } from './ShapeRenderer'
import { Badge } from '@/components/ui'

interface CanvasViewProps {
  docId: string
  className?: string
}

interface DragState {
  type: 'create' | 'move'
  startX: number
  startY: number
  shapeId?: string
  originalX?: number
  originalY?: number
}

// User colors for multi-user cursors
const CURSOR_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6']

export function CanvasView({ docId, className }: CanvasViewProps) {
  const {
    shapes,
    viewports,
    connected,
    addShape,
    moveShape,
    deleteShape,
    setViewport,
    undo,
    redo,
  } = useCanvas(docId)

  const [activeTool, setActiveTool] = useState<CanvasTool>('select')
  const [activeColor, setActiveColor] = useState('#6366f1')
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0, panX: 0, panY: 0 })

  const svgRef = useRef<SVGSVGElement>(null)

  // Convert screen coordinates to canvas coordinates
  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current
      if (!svg) return { x: 0, y: 0 }
      const rect = svg.getBoundingClientRect()
      return {
        x: (clientX - rect.left - pan.x) / zoom,
        y: (clientY - rect.top - pan.y) / zoom,
      }
    },
    [pan, zoom],
  )

  // Report viewport on pan/zoom change
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    setViewport({
      x: -pan.x / zoom,
      y: -pan.y / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
      zoom,
    })
  }, [pan, zoom, setViewport])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedShapeId && document.activeElement === document.body) {
          e.preventDefault()
          deleteShape(selectedShapeId)
          setSelectedShapeId(null)
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          redo()
        } else {
          undo()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedShapeId, deleteShape, undo, redo])

  // Mouse down on SVG background
  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle mouse button or space+click for panning
      if (e.button === 1) {
        e.preventDefault()
        setIsPanning(true)
        setPanStart({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y })
        return
      }

      if (e.button !== 0) return

      const pos = screenToCanvas(e.clientX, e.clientY)

      if (activeTool === 'select') {
        // Deselect when clicking background
        setSelectedShapeId(null)
        // Start panning
        setIsPanning(true)
        setPanStart({ x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y })
        return
      }

      // Start creating a shape
      setDragState({
        type: 'create',
        startX: pos.x,
        startY: pos.y,
      })
    },
    [activeTool, screenToCanvas, pan],
  )

  // Mouse down on a shape
  const handleShapeMouseDown = useCallback(
    (e: React.MouseEvent, shapeId: string) => {
      if (activeTool !== 'select') return

      const shape = shapes.find((s) => s.id === shapeId)
      if (!shape) return

      setSelectedShapeId(shapeId)
      setDragState({
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        shapeId,
        originalX: shape.x,
        originalY: shape.y,
      })
    },
    [activeTool, shapes],
  )

  // Mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setPan({
          x: panStart.panX + (e.clientX - panStart.x),
          y: panStart.panY + (e.clientY - panStart.y),
        })
        return
      }

      if (!dragState) return

      if (dragState.type === 'move' && dragState.shapeId) {
        const dx = (e.clientX - dragState.startX) / zoom
        const dy = (e.clientY - dragState.startY) / zoom
        moveShape(dragState.shapeId, dragState.originalX! + dx, dragState.originalY! + dy)
      }
    },
    [dragState, isPanning, panStart, zoom, moveShape],
  )

  // Mouse up
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setIsPanning(false)
        return
      }

      if (!dragState) return

      if (dragState.type === 'create') {
        const pos = screenToCanvas(e.clientX, e.clientY)
        const x = Math.min(dragState.startX, pos.x)
        const y = Math.min(dragState.startY, pos.y)
        const width = Math.max(Math.abs(pos.x - dragState.startX), 20)
        const height = Math.max(Math.abs(pos.y - dragState.startY), 20)

        addShape({
          type: activeTool,
          x,
          y,
          width,
          height,
          props: {
            stroke: activeColor,
            fill: 'transparent',
            ...(activeTool === 'text' ? { text: 'Text' } : {}),
          },
        })

        // Switch back to select after creating
        setActiveTool('select')
      }

      setDragState(null)
    },
    [dragState, isPanning, screenToCanvas, activeTool, activeColor, addShape],
  )

  // Wheel for zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const svg = svgRef.current
      if (!svg) return

      const rect = svg.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.min(Math.max(zoom * zoomFactor, 0.1), 5)

      // Zoom towards mouse position
      setPan({
        x: mouseX - (mouseX - pan.x) * (newZoom / zoom),
        y: mouseY - (mouseY - pan.y) * (newZoom / zoom),
      })
      setZoom(newZoom)
    },
    [zoom, pan],
  )

  const handleDelete = useCallback(() => {
    if (selectedShapeId) {
      deleteShape(selectedShapeId)
      setSelectedShapeId(null)
    }
  }, [selectedShapeId, deleteShape])

  return (
    <div data-testid="canvas-view" className={`flex flex-col h-full ${className ?? ''}`}>
      <CanvasToolbar
        activeTool={activeTool}
        activeColor={activeColor}
        hasSelection={selectedShapeId !== null}
        onToolChange={setActiveTool}
        onColorChange={setActiveColor}
        onDelete={handleDelete}
        onUndo={undo}
        onRedo={redo}
      />

      <div className="relative flex-1 overflow-hidden bg-background">
        {/* Connection status */}
        <div className="absolute top-3 right-3 z-10">
          {connected ? (
            <Badge variant="success" className="text-xs">
              <span className="w-1.5 h-1.5 bg-success rounded-full mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              <span className="w-1.5 h-1.5 bg-warning rounded-full animate-pulse mr-1" />
              Connecting...
            </Badge>
          )}
        </div>

        {/* Zoom indicator */}
        <div className="absolute bottom-3 right-3 z-10">
          <span className="text-xs text-muted-foreground bg-card/80 px-2 py-1 rounded border border-border">
            {Math.round(zoom * 100)}%
          </span>
        </div>

        <svg
          ref={svgRef}
          data-testid="canvas-svg"
          className="w-full h-full"
          style={{
            cursor: activeTool === 'select' ? (isPanning ? 'grabbing' : 'default') : 'crosshair',
          }}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          {/* Grid background */}
          <defs>
            <pattern
              id="grid"
              width={20 * zoom}
              height={20 * zoom}
              patternUnits="userSpaceOnUse"
              x={pan.x % (20 * zoom)}
              y={pan.y % (20 * zoom)}
            >
              <circle cx={1} cy={1} r={0.5} fill="currentColor" className="text-border" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />

          {/* Canvas content with pan/zoom transform */}
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {/* Shapes */}
            {shapes.map((shape) => (
              <ShapeRenderer
                key={shape.id}
                shape={shape}
                isSelected={shape.id === selectedShapeId}
                onMouseDown={handleShapeMouseDown}
              />
            ))}

            {/* Other users' cursors */}
            {viewports.map((vp, i) => (
              <g key={vp.userId} pointerEvents="none">
                {/* Cursor dot */}
                <circle
                  cx={vp.x + vp.width / 2}
                  cy={vp.y + 20}
                  r={4 / zoom}
                  fill={CURSOR_COLORS[i % CURSOR_COLORS.length]}
                />
                {/* User label */}
                <text
                  x={vp.x + vp.width / 2 + 8 / zoom}
                  y={vp.y + 24 / zoom}
                  fontSize={11 / zoom}
                  fill={CURSOR_COLORS[i % CURSOR_COLORS.length]}
                  fontFamily="system-ui, sans-serif"
                >
                  User {vp.userId.slice(0, 6)}
                </text>
              </g>
            ))}
          </g>

          {/* Drag preview for shape creation */}
          {dragState?.type === 'create' && (
            <rect
              x={0}
              y={0}
              width={0}
              height={0}
              fill="transparent"
              stroke={activeColor}
              strokeWidth={1}
              strokeDasharray="4 3"
              pointerEvents="none"
              style={{ display: 'none' }}
            />
          )}
        </svg>
      </div>
    </div>
  )
}

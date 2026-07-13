/**
 * ShapeRenderer — Renders individual shapes as SVG elements.
 *
 * Supports: rect, ellipse, line, text
 */

import type { CanvasShapeClient } from 'deepspace'

interface ShapeRendererProps {
  shape: CanvasShapeClient
  isSelected: boolean
  onMouseDown: (e: React.MouseEvent, shapeId: string) => void
}

const SELECTION_PADDING = 4

export function ShapeRenderer({ shape, isSelected, onMouseDown }: ShapeRendererProps) {
  const fill = (shape.props.fill as string) ?? 'transparent'
  const stroke = (shape.props.stroke as string) ?? '#6366f1'
  const strokeWidth = (shape.props.strokeWidth as number) ?? 2

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation()
    onMouseDown(e, shape.id)
  }

  return (
    <g
      data-testid={`shape-${shape.id}`}
      onMouseDown={handleMouseDown}
      style={{ cursor: 'move' }}
    >
      {/* Selection outline */}
      {isSelected && (
        <rect
          x={shape.x - SELECTION_PADDING}
          y={shape.y - SELECTION_PADDING}
          width={shape.width + SELECTION_PADDING * 2}
          height={shape.height + SELECTION_PADDING * 2}
          fill="none"
          style={{ stroke: 'var(--color-primary)' }}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          rx={2}
          pointerEvents="none"
        />
      )}

      {/* Shape */}
      {shape.type === 'rect' && (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
          rx={4}
        />
      )}

      {shape.type === 'ellipse' && (
        <ellipse
          cx={shape.x + shape.width / 2}
          cy={shape.y + shape.height / 2}
          rx={shape.width / 2}
          ry={shape.height / 2}
          fill={fill}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      )}

      {shape.type === 'line' && (
        <line
          x1={shape.x}
          y1={shape.y}
          x2={shape.x + shape.width}
          y2={shape.y + shape.height}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
      )}

      {shape.type === 'text' && (
        <>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            fill={fill === 'transparent' ? 'transparent' : fill}
            stroke={isSelected ? stroke : 'transparent'}
            strokeWidth={isSelected ? strokeWidth : 0}
            rx={2}
          />
          <text
            x={shape.x + 8}
            y={shape.y + shape.height / 2}
            dominantBaseline="central"
            fill={stroke}
            fontSize={14}
            fontFamily="system-ui, sans-serif"
            pointerEvents="none"
          >
            {(shape.props.text as string) ?? 'Text'}
          </text>
        </>
      )}
    </g>
  )
}

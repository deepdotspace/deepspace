/**
 * CanvasToolbar — Shape creation tools, selection, delete, color picker.
 */

export type CanvasTool = 'select' | 'rect' | 'ellipse' | 'line' | 'text'

const PRESET_COLORS = [
  '#6366f1', // indigo
  '#ef4444', // red
  '#22c55e', // green
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#64748b', // slate
  '#000000', // black
]

interface CanvasToolbarProps {
  activeTool: CanvasTool
  activeColor: string
  hasSelection: boolean
  onToolChange: (tool: CanvasTool) => void
  onColorChange: (color: string) => void
  onDelete: () => void
  onUndo: () => void
  onRedo: () => void
}

const tools: { id: CanvasTool; label: string; icon: React.ReactNode }[] = [
  {
    id: 'select',
    label: 'Select',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
      </svg>
    ),
  },
  {
    id: 'rect',
    label: 'Rectangle',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <rect x="3" y="3" width="18" height="18" rx="2" strokeWidth={2} />
      </svg>
    ),
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <ellipse cx="12" cy="12" rx="9" ry="7" strokeWidth={2} />
      </svg>
    ),
  },
  {
    id: 'line',
    label: 'Line',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <line x1="5" y1="19" x2="19" y2="5" strokeWidth={2} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'text',
    label: 'Text',
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M8 6v12m0 0h8" />
      </svg>
    ),
  },
]

export function CanvasToolbar({
  activeTool,
  activeColor,
  hasSelection,
  onToolChange,
  onColorChange,
  onDelete,
  onUndo,
  onRedo,
}: CanvasToolbarProps) {
  return (
    <div
      data-testid="canvas-toolbar"
      className="flex items-center gap-3 px-4 py-2 bg-card/80 backdrop-blur-md border-b border-border"
    >
      {/* Shape tools */}
      <div className="flex items-center gap-1">
        {tools.map((tool) => (
          <button
            key={tool.id}
            data-testid={`tool-${tool.id}`}
            onClick={() => onToolChange(tool.id)}
            title={tool.label}
            className={`p-2 rounded-lg transition-colors ${
              activeTool === tool.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            {tool.icon}
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-border" />

      {/* Color picker */}
      <div className="flex items-center gap-1">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            data-testid={`color-${color}`}
            onClick={() => onColorChange(color)}
            title={color}
            className={`w-5 h-5 rounded-full border-2 transition-transform ${
              activeColor === color ? 'border-foreground scale-125' : 'border-transparent hover:scale-110'
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      <div className="w-px h-6 bg-border" />

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          data-testid="canvas-undo"
          onClick={onUndo}
          title="Undo"
          className="p-2 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4m-4 4l4 4" />
          </svg>
        </button>
        <button
          data-testid="canvas-redo"
          onClick={onRedo}
          title="Redo"
          className="p-2 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a5 5 0 00-5 5v2m15-7l-4-4m4 4l-4 4" />
          </svg>
        </button>

        <button
          data-testid="canvas-delete"
          onClick={onDelete}
          disabled={!hasSelection}
          title="Delete selected"
          className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  )
}

import { createContext, useContext, useEffect, useId, useRef, type ComponentProps } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

// Links Modal.Title to the <dialog> via aria-labelledby so the dialog has an
// accessible name (screen readers announce it; getByRole('dialog', { name })
// can find it). Radix did this for us before the native-<dialog> rewrite.
const ModalTitleIdContext = createContext<string | undefined>(undefined)

const SIZES = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const

interface ModalProps extends Omit<ComponentProps<'dialog'>, 'open' | 'onClose'> {
  open: boolean
  onClose: () => void
  size?: keyof typeof SIZES
}

/**
 * Modal built on the native <dialog>. showModal() gives us the focus trap,
 * Escape handling, and the inert background for free. We keep a single close
 * path: Escape and backdrop clicks call onClose, the parent flips `open`, and
 * the effect closes the element. Edit the markup freely — it's just a dialog.
 */
function ModalRoot({ open, onClose, size = 'md', className, children, ...props }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  // An explicit aria-label wins; otherwise the dialog is named by its
  // Modal.Title (aria-labelledby pointing at an id the Title picks up).
  // Always give a modal one or the other — with neither, aria-labelledby
  // references an id that never renders, which a11y scanners flag.
  const labelledBy = props['aria-label'] ? undefined : titleId

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] rounded-2xl border border-border bg-background p-0 text-foreground shadow-xl',
        'backdrop:bg-black/50 backdrop:backdrop-blur-sm',
        SIZES[size],
        className,
      )}
      {...props}
    >
      <ModalTitleIdContext.Provider value={titleId}>
        <div className="flex max-h-[85vh] flex-col p-5">{children}</div>
      </ModalTitleIdContext.Provider>
    </dialog>
  )
}

function ModalHeader({
  onClose,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { onClose?: () => void }) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)} {...props}>
      <div className="space-y-1">{children}</div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 -mt-1 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

function ModalTitle({ className, ...props }: ComponentProps<'h2'>) {
  const titleId = useContext(ModalTitleIdContext)
  return (
    <h2
      id={titleId}
      className={cn('text-lg font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

function ModalDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function ModalBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex-1 overflow-y-auto py-4', className)} {...props} />
}

function ModalFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

export const Modal = Object.assign(ModalRoot, {
  Header: ModalHeader,
  Title: ModalTitle,
  Description: ModalDescription,
  Body: ModalBody,
  Footer: ModalFooter,
})

interface ConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  loading?: boolean
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'destructive',
  loading = false,
}: ConfirmModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="sm">
      <Modal.Header>
        <Modal.Title>{title}</Modal.Title>
        {description && <Modal.Description>{description}</Modal.Description>}
      </Modal.Header>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={loading}>
          {cancelText}
        </Button>
        <Button variant={variant} onClick={onConfirm} loading={loading}>
          {confirmText}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

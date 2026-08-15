/** Modal / ConfirmModal — app-level wrappers around Dialog primitives. */

import React, { ReactNode, JSX } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader as DHeader,
  DialogTitle as DTitle,
  DialogDescription as DDescription,
  DialogFooter as DFooter,
} from './Dialog'
import { Button } from './Button'
import { cn } from '@/lib/utils'

// ============================================================================
// Modal - Accessible modal dialog (wraps the Base UI Dialog primitives in ./Dialog)
// ============================================================================

interface ModalProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  open: boolean
  onClose: () => void
  children: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

// Always give a Modal an accessible name: render a <Modal.Title> (Base UI
// wires aria-labelledby from Dialog.Title automatically) or pass aria-label.
// With neither, screen readers announce an unnamed dialog and
// getByRole('dialog', { name }) can't find it.
export function Modal({
  open,
  onClose,
  children,
  size = 'md',
  className,
  ...props
}: ModalProps): JSX.Element {
  const sizes = {
    sm: 'max-w-[calc(100vw-2rem)] sm:max-w-sm',
    md: 'max-w-[calc(100vw-2rem)] sm:max-w-lg',
    lg: 'max-w-[calc(100vw-2rem)] sm:max-w-2xl',
    xl: 'max-w-[calc(100vw-2rem)] sm:max-w-4xl',
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent
        aria-describedby={undefined}
        className={cn(sizes[size], 'flex flex-col max-h-[85vh]', className)}
        {...props}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// Modal.Header
// ============================================================================

interface ModalHeaderProps {
  children: ReactNode
  className?: string
}

function ModalHeader({ children, className = '' }: ModalHeaderProps): JSX.Element {
  return (
    <DHeader className={className}>
      {children}
    </DHeader>
  )
}

// ============================================================================
// Modal.Title
// ============================================================================

interface ModalTitleProps {
  children: ReactNode
  className?: string
}

function ModalTitle({ children, className = '' }: ModalTitleProps): JSX.Element {
  // min-w-0 + truncate: long unbroken strings (filenames, URLs) ellipsize
  // instead of stretching the dialog.
  return (
    <DTitle className={cn('min-w-0 truncate', className)}>
      {children}
    </DTitle>
  )
}

// ============================================================================
// Modal.Description
// ============================================================================

interface ModalDescriptionProps {
  children: ReactNode
  className?: string
}

function ModalDescription({ children, className = '' }: ModalDescriptionProps): JSX.Element {
  return (
    <DDescription className={className}>
      {children}
    </DDescription>
  )
}

// ============================================================================
// Modal.Body - Scrollable content area
// ============================================================================

interface ModalBodyProps {
  children: ReactNode
  className?: string
}

function ModalBody({ children, className = '' }: ModalBodyProps): JSX.Element {
  // px-1 -mx-1 leaves room for focus rings on inputs (which extend 1px
  // outside their box) without shrinking the visual content area —
  // the negative margin compensates for the padding so children still
  // align with Header / Footer. break-words keeps long unbroken strings
  // (filenames, URLs) from forcing horizontal overflow.
  return (
    <div className={cn('flex-1 overflow-y-auto -mx-1 px-1 py-4 break-words', className)}>
      {children}
    </div>
  )
}

// ============================================================================
// Modal.Footer - Action buttons area
// ============================================================================

interface ModalFooterProps {
  children: ReactNode
  className?: string
}

function ModalFooter({ children, className = '' }: ModalFooterProps): JSX.Element {
  return (
    <DFooter className={className}>
      {children}
    </DFooter>
  )
}

// ============================================================================
// ConfirmModal - Pre-built confirmation dialog
// ============================================================================

interface ConfirmModalProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: 'destructive' | 'default'
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
}: ConfirmModalProps): JSX.Element {
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

// ============================================================================
// Attach sub-components
// ============================================================================

Modal.Header = ModalHeader
Modal.Title = ModalTitle
Modal.Description = ModalDescription
Modal.Body = ModalBody
Modal.Footer = ModalFooter

export default Modal

import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info'
type Size = 'default' | 'sm' | 'lg'

const VARIANTS: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  outline: 'border border-border text-foreground',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning text-warning-foreground',
  info: 'bg-info text-info-foreground',
}

const SIZES: Record<Size, string> = {
  default: 'px-2.5 py-0.5 text-xs',
  sm: 'px-2 py-px text-[10px]',
  lg: 'px-3 py-1 text-sm',
}

export interface BadgeProps extends ComponentProps<'span'> {
  variant?: Variant
  size?: Size
}

export function Badge({ className, variant = 'default', size = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-medium',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
}

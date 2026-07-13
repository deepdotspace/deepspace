import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

export function Avatar({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary',
        className,
      )}
      {...props}
    />
  )
}

export function AvatarImage({ className, alt = '', ...props }: ComponentProps<'img'>) {
  return <img className={cn('size-full object-cover', className)} alt={alt} {...props} />
}

export function AvatarFallback({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-sm font-medium text-muted-foreground', className)}
      {...props}
    />
  )
}

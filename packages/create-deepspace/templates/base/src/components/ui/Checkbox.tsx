import { useState } from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'

type CheckedState = boolean | 'indeterminate'

interface CheckboxProps
  extends Omit<CheckboxPrimitive.Root.Props, 'checked' | 'defaultChecked' | 'onCheckedChange' | 'indeterminate'> {
  checked?: CheckedState
  defaultChecked?: CheckedState
  onCheckedChange?: (checked: boolean) => void
}

/**
 * Checkbox — wraps Base UI's Checkbox. Base UI owns the controlled/uncontrolled
 * toggle, keyboard/ARIA, and the hidden form input (rendered as a sibling, not
 * illegally nested in the button). We keep the Radix-style `checked` API that
 * accepts `'indeterminate'`, mapping it onto Base UI's separate `indeterminate`
 * flag.
 */
function Checkbox({ className, checked, defaultChecked, onCheckedChange, ...props }: CheckboxProps) {
  // Mixed state, both modes (Radix semantics): controlled comes straight from
  // `checked`; uncontrolled starts mixed via `defaultChecked="indeterminate"`
  // and clears on the first user toggle. Deriving it from `checked` alone
  // would silently render an uncontrolled mixed checkbox as plain unchecked.
  const [uncontrolledIndeterminate, setUncontrolledIndeterminate] = useState(
    checked === undefined && defaultChecked === 'indeterminate',
  )
  const indeterminate =
    checked !== undefined ? checked === 'indeterminate' : uncontrolledIndeterminate
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      checked={checked === 'indeterminate' ? false : checked}
      defaultChecked={defaultChecked === 'indeterminate' ? false : defaultChecked}
      indeterminate={indeterminate}
      onCheckedChange={(value) => {
        setUncontrolledIndeterminate(false)
        onCheckedChange?.(value)
      }}
      className={cn(
        'peer grid h-4 w-4 shrink-0 place-content-center rounded-[5px] border border-input shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground',
        'data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {indeterminate ? (
          <Minus className="h-3.5 w-3.5" strokeWidth={3} />
        ) : (
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }

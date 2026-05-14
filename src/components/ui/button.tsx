import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-app)] disabled:pointer-events-none disabled:opacity-70',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent)] text-white shadow-[0_8px_18px_var(--accent-soft)] hover:brightness-[1.03]',
        secondary: 'border border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-chip)]',
        ghost: 'text-[var(--text-primary)] hover:bg-[var(--surface-chip)]',
        outline: 'border border-[var(--border-subtle)] bg-transparent text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-chip)]',
        destructive: 'bg-[#d45b5b] text-white hover:brightness-[1.03]',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-7 rounded-md px-2.5 text-xs',
        lg: 'h-10 rounded-xl px-4',
        icon: 'h-9 w-9',
        iconSm: 'h-7 w-7 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)

Button.displayName = 'Button'

export { Button, buttonVariants }

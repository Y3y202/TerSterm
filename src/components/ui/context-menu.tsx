import * as React from 'react'
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu'
import { cn } from '../../lib/utils'

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger
const ContextMenuPortal = ContextMenuPrimitive.Portal

const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPortal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        'z-50 min-w-44 overflow-hidden rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel-strong)] p-1.5 text-[var(--text-primary)] shadow-[0_24px_60px_rgba(15,23,42,0.18)]',
        className,
      )}
      {...props}
    />
  </ContextMenuPortal>
))

ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <ContextMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-default select-none items-center rounded-lg px-3 py-2 text-sm outline-none transition focus:bg-[var(--surface-chip)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      inset && 'pl-8',
      className,
    )}
    {...props}
  />
))

ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

export { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger }

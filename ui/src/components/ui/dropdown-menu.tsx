"use client"

import * as React from "react"
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function DropdownMenu({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  )
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          "min-w-[220px] z-50",
          "bg-card border border-border rounded-lg",
          "shadow-[0_4px_12px_rgba(0,0,0,0.4),0_16px_36px_rgba(0,0,0,0.3)]",
          "p-1.5",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1",
          "duration-[140ms] ease-out",
          "text-text outline-none",
          "max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto",
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "px-2.5 py-1.5 rounded-[5px] text-sm",
        "flex items-center gap-2.5 cursor-default outline-none",
        "hover:bg-white/5 data-[highlighted]:bg-white/5",
        "focus:bg-white/5 focus:text-text",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "data-[inset]:pl-8 relative select-none",
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive",
        "[&_svg:not([class*='text-'])]:text-very-dim [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "px-2.5 py-1.5 pl-8 rounded-[5px] text-sm",
        "flex items-center gap-2.5 cursor-default outline-none relative select-none",
        "hover:bg-white/5 data-[highlighted]:bg-white/5",
        "focus:bg-white/5 focus:text-text",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center data-[state=checked]:bg-brand rounded-sm">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "px-2.5 py-1.5 pl-8 rounded-[5px] text-sm",
        "flex items-center gap-2.5 cursor-default outline-none relative select-none",
        "hover:bg-white/5 data-[highlighted]:bg-white/5",
        "focus:bg-white/5 focus:text-text",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center data-[state=checked]:bg-brand rounded-full">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2.5 py-1.5 text-xs font-semibold text-very-dim uppercase tracking-[0.08em] data-[inset]:pl-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("h-px bg-border-soft my-1 -mx-1.5", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-xs text-very-dim font-mono",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "px-2.5 py-1.5 rounded-[5px] text-sm",
        "flex items-center gap-2.5 cursor-default outline-none select-none",
        "hover:bg-white/5 data-[highlighted]:bg-white/5",
        "focus:bg-white/5 focus:text-text",
        "data-[state=open]:bg-white/5 data-[state=open]:text-text",
        "data-[inset]:pl-8",
        "[&_svg:not([class*='text-'])]:text-very-dim [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "min-w-[220px] z-50",
        "bg-card border border-border rounded-lg",
        "shadow-[0_4px_12px_rgba(0,0,0,0.4),0_16px_36px_rgba(0,0,0,0.3)]",
        "p-1.5",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1",
        "duration-[140ms] ease-out",
        "text-text outline-none overflow-hidden",
        "origin-(--radix-dropdown-menu-content-transform-origin)",
        className
      )}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}

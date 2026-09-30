"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-field ring-offset-background transition-colors outline-none",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-brand data-[state=checked]:border-brand data-[state=checked]:text-white",
        "aria-invalid:border-error aria-invalid:ring-error/[0.18]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }

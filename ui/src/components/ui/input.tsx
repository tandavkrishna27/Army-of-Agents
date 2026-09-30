import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-8 w-full rounded-md border border-border bg-field px-3 py-1.5 text-sm text-text transition-colors",
        "hover:bg-card-2",
        "focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
        "placeholder:text-very-dim",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error/[0.18]",
        "file:bg-transparent file:border-0 file:text-sm file:font-medium",
        className
      )}
      {...props}
    />
  )
}

export { Input }

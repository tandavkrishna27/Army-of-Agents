import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-[76px] w-full resize-y rounded-md border border-border bg-field px-3 py-2 text-sm text-text transition-colors",
        "hover:bg-card-2",
        "focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
        "placeholder:text-very-dim",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error/[0.18]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }

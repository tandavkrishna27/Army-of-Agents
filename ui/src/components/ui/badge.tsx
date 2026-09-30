import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Status badge — design-system §9.11.
 *
 * Pill with subtle top-to-bottom gradient + semantic-colored border.
 * Seven canonical variants map to AoA's status palette:
 *
 *   active   — success (green)         agent/task done, goal active
 *   live     — brand red (with pulse)  running, in-progress
 *   idle     — slate (cool grey)       planned, backlog
 *   pending  — warning (amber)         blocked, at-risk
 *   error    — error red               failed
 *   draft    — info (blue)             todo, draft
 *   archived — neutral grey            cancelled, archived
 *
 * For the live state's pulsing ring, render an inner dot with the
 * `animate-pulse-glow` keyframe (defined in `ui/src/index.css`):
 *
 *   <Badge variant="live">
 *     <span className="size-1.5 rounded-full bg-current animate-pulse-glow" />
 *     Running
 *   </Badge>
 *
 * The badge container itself does not pulse; only the dot child does.
 *
 * Backwards-compat aliases — `default`, `secondary`, `destructive`,
 * `outline`, `ghost`, `link` — are kept so existing call sites compile
 * unchanged. A future codemod will swap them for the semantic names.
 */
const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[0.66rem] font-semibold uppercase tracking-[0.04em] w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none bg-gradient-to-b focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-colors overflow-hidden",
  {
    variants: {
      variant: {
        // Canonical semantic variants (§9.11)
        active:
          "from-success/[0.18] to-success/[0.12] text-[hsl(150_50%_70%)] border-success/25",
        live:
          "from-brand/[0.22] to-brand/[0.14] text-[hsl(15_70%_78%)] border-brand/30",
        idle:
          "from-data-slate/[0.16] to-data-slate/[0.08] text-[hsl(220_14%_75%)] border-data-slate/[0.22]",
        pending:
          "from-warning/[0.20] to-warning/[0.12] text-[hsl(45_70%_70%)] border-warning/[0.28]",
        error:
          "from-error/[0.18] to-error/[0.10] text-[hsl(0_80%_75%)] border-error/[0.28]",
        draft:
          "from-info/[0.18] to-info/[0.10] text-[hsl(220_75%_75%)] border-info/[0.25]",
        archived:
          "bg-card text-dim border-border bg-none",

        // Backwards-compat aliases — keep existing call sites compiling.
        // Codemod will retire these in a follow-up.
        default:
          "from-brand/[0.18] to-brand/[0.12] text-[hsl(15_70%_78%)] border-brand/25",
        secondary:
          "from-data-slate/[0.16] to-data-slate/[0.08] text-[hsl(220_14%_75%)] border-data-slate/[0.22]",
        destructive:
          "from-error/[0.18] to-error/[0.10] text-[hsl(0_80%_75%)] border-error/[0.28]",
        outline:
          "bg-card text-dim border-border bg-none",
        ghost:
          "border-transparent bg-none [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link:
          "border-transparent bg-none text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "active",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }

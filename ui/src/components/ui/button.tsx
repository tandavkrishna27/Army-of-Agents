import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring focus-visible:border-brand disabled:opacity-40 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-brand text-white hover:bg-brand-hover border border-transparent",
        secondary: "bg-card text-text border border-border hover:bg-hd",
        outline: "bg-transparent text-text border border-border-strong hover:bg-card",
        ghost: "bg-transparent text-text border border-transparent hover:bg-white/5",
        destructive: "bg-error text-white hover:bg-[#f87171] border border-transparent",
        link: "bg-transparent text-brand hover:text-brand-hover hover:underline border-0 p-0 h-auto font-semibold",
      },
      size: {
        sm: "h-[26px] px-2.5 text-xs rounded-[5px] [&_svg]:size-3.5",
        default: "h-8 px-3 text-sm rounded-md [&_svg]:size-4",
        lg: "h-10 px-4 text-base rounded-lg [&_svg]:size-4",
        icon: "size-8 p-0 rounded-md [&_svg]:size-4",
        // Legacy size aliases — preserved so existing call sites keep typechecking.
        // Visually mapped to the spec'd buckets (sm | default | lg | icon).
        xs: "h-[26px] px-2.5 text-xs rounded-[5px] [&_svg]:size-3.5",
        "icon-xs": "size-[26px] p-0 rounded-[5px] [&_svg]:size-3.5",
        "icon-sm": "size-8 p-0 rounded-md [&_svg]:size-4",
        "icon-lg": "size-10 p-0 rounded-lg [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }

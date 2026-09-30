import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list flex border-b border-border group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:border-b-0 group-data-[orientation=vertical]/tabs:border-r",
  {
    variants: {
      variant: {
        default: "",
        line: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "px-4 py-2.5 text-sm text-dim hover:text-text",
        "data-[state=active]:text-text data-[state=active]:font-medium",
        "border-b-2 border-transparent data-[state=active]:border-brand -mb-px",
        "transition-colors duration-[180ms] ease-out",
        "flex items-center gap-1.5 cursor-pointer whitespace-nowrap",
        "disabled:pointer-events-none disabled:opacity-50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring focus-visible:ring-offset-2",
        "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start",
        "group-data-[orientation=vertical]/tabs:border-b-0 group-data-[orientation=vertical]/tabs:border-r-2 group-data-[orientation=vertical]/tabs:data-[state=active]:border-brand group-data-[orientation=vertical]/tabs:-mr-px group-data-[orientation=vertical]/tabs:mb-0",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "mt-2 outline-none flex-1",
        "data-[state=active]:animate-in data-[state=active]:fade-in-0",
        "duration-[180ms] ease-out",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }

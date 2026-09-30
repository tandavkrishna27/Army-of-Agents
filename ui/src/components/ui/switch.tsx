"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      "peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
      "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-brand data-[state=unchecked]:bg-[hsl(0_0%_25%)]",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block size-3.5 rounded-full bg-white shadow-sm ring-0 transition-transform",
        "data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0"
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };

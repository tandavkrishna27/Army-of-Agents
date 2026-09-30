import * as React from "react";
import { cn } from "@/lib/utils";

const variantClass = {
  active: "bg-success [box-shadow:0_0_0_2px_rgba(79,182,126,0.18)]",
  live: "bg-brand animate-pulse-glow",
  idle: "bg-data-slate",
  pending: "bg-warning [box-shadow:0_0_0_2px_rgba(217,169,56,0.18)]",
  error: "bg-error [box-shadow:0_0_0_2px_rgba(239,68,68,0.18)]",
  draft: "bg-info [box-shadow:0_0_0_2px_rgba(59,130,246,0.18)]",
} as const;

export type StatusDotVariant = keyof typeof variantClass;

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StatusDotVariant;
}

export function StatusDot({ variant = "active", className, ...rest }: StatusDotProps) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full shrink-0", variantClass[variant], className)}
      aria-hidden
      data-variant={variant}
      {...rest}
    />
  );
}

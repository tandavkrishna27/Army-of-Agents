import * as React from "react";
import { cn } from "@/lib/utils";

export interface MetaPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  mono?: boolean;
}

export function MetaPill({ children, className, mono, ...rest }: MetaPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded text-[0.66rem] bg-white/[0.05] border border-border text-dim",
        mono && "font-mono",
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export function MetaPillRow({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex flex-wrap gap-1.5 mt-2", className)} {...rest}>
      {children}
    </div>
  );
}

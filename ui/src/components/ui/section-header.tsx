import * as React from "react";
import { cn } from "@/lib/utils";

export interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  number?: number;
  icon?: React.ReactNode;
}

export function SectionHeader({
  number,
  icon,
  children,
  className,
  ...rest
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "text-[0.62rem] uppercase tracking-[0.1em] text-dim mb-3 flex items-center gap-2 font-semibold",
        className
      )}
      {...rest}
    >
      {number !== undefined && (
        <span
          className="size-[18px] rounded-full bg-brand-wash text-brand inline-flex items-center justify-center font-mono text-[0.66rem] font-bold"
          aria-hidden
        >
          {number}
        </span>
      )}
      {icon && <span className="text-current opacity-60 [&_svg]:size-3" aria-hidden>{icon}</span>}
      <span>{children}</span>
    </div>
  );
}

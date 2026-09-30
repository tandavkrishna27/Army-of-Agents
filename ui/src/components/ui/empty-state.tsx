import * as React from "react";
import { cn } from "@/lib/utils";

export type EmptyStateVariant = "first-time" | "no-results";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  variant?: EmptyStateVariant;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "first-time",
  className,
}: EmptyStateProps) {
  const iconBg =
    variant === "first-time"
      ? "bg-brand-wash border border-brand/20 text-brand"
      : "bg-card-2 border border-border text-dim";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center p-6",
        "bg-[radial-gradient(ellipse_70%_60%_at_50%_0%,var(--brand-wash)_0%,transparent_70%)]",
        className
      )}
      data-variant={variant}
    >
      {icon && (
        <div
          className={cn(
            "flex size-14 rounded-2xl items-center justify-center text-2xl mb-3.5 [&_svg]:size-6",
            iconBg
          )}
        >
          {icon}
        </div>
      )}
      <div className="text-base font-semibold tracking-[-0.01em] mb-1.5">{title}</div>
      {description && (
        <div className="text-sm text-dim leading-relaxed max-w-[320px] mb-3.5">{description}</div>
      )}
      {action && <div>{action}</div>}
    </div>
  );
}

import * as React from "react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  breadcrumb?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  filters?: React.ReactNode;
  search?: React.ReactNode;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  breadcrumb,
  title,
  subtitle,
  filters,
  search,
  primaryAction,
  secondaryAction,
  className,
}: PageHeaderProps) {
  const hasActionRow = filters || search || primaryAction || secondaryAction;
  return (
    <div
      className={cn(
        "px-6 pt-5 pb-4 border-b border-border relative",
        "bg-[radial-gradient(ellipse_80%_100%_at_30%_-20%,var(--brand-wash)_0%,transparent_70%)]",
        "bg-hd",
        className
      )}
    >
      {breadcrumb && (
        <div className="text-[0.66rem] tracking-[0.04em] text-very-dim mb-1">
          {breadcrumb}
        </div>
      )}
      <h1 className="text-[1.4rem] font-bold tracking-[-0.025em] mb-1 text-text">{title}</h1>
      {subtitle && <div className="text-[0.82rem] text-dim mb-3">{subtitle}</div>}
      {hasActionRow && (
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          {filters}
          <div className="flex-1" />
          {search}
          {secondaryAction}
          {primaryAction}
        </div>
      )}
    </div>
  );
}

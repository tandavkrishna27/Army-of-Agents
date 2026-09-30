import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";

export interface WidgetShellProps {
  title: string;
  icon: LucideIcon;
  /** Route the header link opens (suppressed while editing). */
  to: string;
  /** True while the Home board is in edit mode — header becomes non-navigating (drag/select). */
  editing?: boolean;
  children: ReactNode;
}

/**
 * Tile chrome shared by every Home board widget: a full-height card whose
 * header is the "open this widget's page" affordance. Not editing → the
 * header is a Link (clicking it navigates to `to`). Editing → the header is
 * a plain, non-navigating div so drag/resize/select can take over instead.
 */
export function WidgetShell({ title, icon: Icon, to, editing, children }: WidgetShellProps) {
  const headerInner = (
    <>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <h2 className="flex-1 truncate text-sm font-semibold text-muted-foreground">{title}</h2>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-border bg-card">
      {editing ? (
        <div className="flex items-center gap-2 px-4 py-3">{headerInner}</div>
      ) : (
        <Link
          to={to}
          aria-label={`Open ${title}`}
          className="flex items-center gap-2 px-4 py-3 text-inherit no-underline transition-colors hover:bg-accent/50"
        >
          {headerInner}
        </Link>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

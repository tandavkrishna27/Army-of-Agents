import type { ReactNode } from "react";
import { Link } from "@/lib/router";

export interface WidgetRowLinkProps {
  /** Deep-link target for this row, or null when it has no navigable entity. */
  to: string | null;
  /** True while the Home board is in edit mode — row becomes non-navigating,
   *  mirroring how WidgetShell swaps its header Link->div. */
  editing?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A widget data row that deep-links to its specific entity: a Link to `to`
 * when not editing and a target exists, and a plain non-navigating element
 * otherwise (editing, or a row with no resolvable target — e.g. an activity
 * item whose entity type isn't deep-linkable). Same idea as WidgetShell's
 * header Link<->div swap, applied per row.
 */
export function WidgetRowLink({ to, editing, className, children }: WidgetRowLinkProps) {
  if (editing || !to) {
    return <div className={className}>{children}</div>;
  }
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

import { ChevronRight, ChevronDown, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface FolderTreeNodeProps {
  label: string;
  icon?: string | LucideIcon;
  /** Optional inline color applied to the icon span (e.g. "var(--data-indigo)"). */
  iconTone?: string;
  count?: number;
  /** Count badge tone. "brand" wraps the count in a brand-red pill (used for Pending Review). */
  countTone?: "default" | "brand";
  /** Rolled-up pending-item tally for this folder (incl. descendants). Renders an "N pending" badge. */
  pendingCount?: number;
  depth: number;
  expanded: boolean;
  selected: boolean;
  hasChildren: boolean;
  onToggleExpand: () => void;
  onSelect: () => void;
  tintClass?: string;
  /** Optional rightSlot rendered at the end of the row. Used for the kebab menu in 6.2b. */
  actions?: ReactNode;
  /** Optional native browser tooltip shown on hover (e.g. deep-nesting soft-warn). */
  tooltip?: string;
}

export function FolderTreeNode({
  label,
  icon,
  iconTone,
  count,
  countTone = "default",
  pendingCount,
  depth,
  expanded,
  selected,
  hasChildren,
  onToggleExpand,
  onSelect,
  tintClass,
  actions,
  tooltip,
}: FolderTreeNodeProps) {
  const indent = depth * 12 + 8;
  // Lucide icons are forwardRef *objects*, not plain functions. Treat any
  // non-string truthy value as a component to render.
  const Icon = icon && typeof icon !== "string" ? (icon as LucideIcon) : null;

  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={selected}
      onClick={onSelect}
      title={tooltip}
      className={cn(
        "group flex items-center gap-1 py-1.5 pr-2 cursor-pointer text-xs leading-snug select-none",
        "relative",
        "hover:bg-muted/60 transition-colors duration-100",
        selected && "bg-brand/[0.08] text-[hsl(15_60%_75%)]",
        tintClass,
      )}
      style={{ paddingLeft: indent }}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) onToggleExpand();
        }}
        className="flex-shrink-0 inline-flex h-3.5 w-3.5 items-center justify-center text-muted-foreground"
        aria-label={hasChildren ? (expanded ? "Collapse" : "Expand") : undefined}
        tabIndex={hasChildren ? 0 : -1}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )
        ) : null}
      </button>
      <span
        className="flex-shrink-0 text-sm leading-none"
        style={iconTone ? { color: iconTone } : undefined}
      >
        {Icon ? <Icon className="h-3.5 w-3.5" /> : (typeof icon === "string" ? icon : "📁")}
      </span>
      <span className="truncate flex-1">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "text-[10px] tabular-nums",
            countTone === "brand"
              ? "rounded px-1.5 py-0.5 bg-brand/[0.08] text-[hsl(15_60%_75%)]"
              : "text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
      {typeof pendingCount === "number" && pendingCount > 0 && (
        <span
          className="rounded border border-border bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-medium whitespace-nowrap"
          style={{ color: "var(--data-amber)" }}
        >
          {pendingCount} pending
        </span>
      )}
      {actions}
      {selected && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-[5px] rounded-full bg-brand shadow-[0_0_6px_rgba(184,45,28,0.55)]"
        />
      )}
    </div>
  );
}

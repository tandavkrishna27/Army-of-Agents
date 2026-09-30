import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ActionGroup } from "../actionQueue";
import { WidgetRowLink } from "./WidgetRowLink";

export function ActionQueueGroup({
  group,
  editing,
  maxItems,
}: {
  group: ActionGroup;
  editing?: boolean;
  /**
   * Caps how many of this group's items render (size-responsive truncation,
   * allocated across groups by ActionQueueWidget's `allocateActionGroups`).
   * The header's count badge always shows `group.items.length` — the TRUE
   * total — regardless of this cap, so a truncated group never understates
   * how many items it actually has.
   */
  maxItems?: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const Icon = group.icon;
  const visibleItems = typeof maxItems === "number" ? group.items.slice(0, maxItems) : group.items;

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 w-full px-4 py-2.5 text-sm font-medium hover:bg-accent/30 transition-colors"
      >
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="flex-1 text-left">{group.title}</span>
        <span className="text-xs font-normal bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full tabular-nums">
          {group.items.length}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${
            expanded ? "" : "-rotate-90"
          }`}
        />
      </button>
      {expanded && (
        <div className="border-t border-border divide-y divide-border">
          {visibleItems.map((item) => (
            <WidgetRowLink
              key={item.key}
              to={item.to}
              editing={editing}
              className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50 transition-colors no-underline text-inherit"
            >
              <span className="flex-1 min-w-0 truncate">{item.label}</span>
              {item.sublabel && <span className="text-xs text-muted-foreground shrink-0">{item.sublabel}</span>}
            </WidgetRowLink>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import type { HubDensity, HubGroupMode } from "@armyofagents/shared";
import type { HubItemListRow } from "@/api/hub-items";
import { cn } from "@/lib/utils";
import { HUB_REGISTRY } from "./hubRegistry";
import { buildHubListEntries } from "./hubTypes";

interface HubListProps {
  items: HubItemListRow[];
  isLoading: boolean;
  error: unknown;
  selectedItemId: string | null;
  selectedBulkIds: Set<string>;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  groupMode?: HubGroupMode;
  density?: HubDensity;
  onSelectItem: (itemId: string) => void;
  /**
   * Row-click "open" gesture: selects the item AND opens its entity as a tab.
   * When omitted, a click falls back to {@link onSelectItem} (select only).
   * Keyboard j/k navigation always uses {@link onSelectItem} (preview, no tab).
   */
  onOpenItem?: (item: HubItemListRow) => void;
  onMarkRead: (itemId: string) => void;
  onToggleBulkItem: (itemId: string) => void;
  onLoadMore?: () => void;
  /** Restore a personally-dismissed hidden row (revealed via the "N hidden" chip). */
  onUndismiss?: (itemId: string) => void;
  /** Restore a personally-snoozed hidden row (revealed via the "N hidden" chip). */
  onUnsnooze?: (itemId: string) => void;
}

/** A row is "hidden" when the current user dismissed it or has an active snooze. */
function hiddenState(item: HubItemListRow): "dismissed" | "snoozed" | null {
  if (item.dismissedAt) return "dismissed";
  if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > Date.now()) return "snoozed";
  return null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function HubList({
  items,
  isLoading,
  error,
  selectedItemId,
  selectedBulkIds,
  hasMore = false,
  isLoadingMore = false,
  groupMode = "auto",
  density = "comfortable",
  onSelectItem,
  onOpenItem,
  onMarkRead,
  onToggleBulkItem,
  onLoadMore,
  onUndismiss,
  onUnsnooze,
}: HubListProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading hub items...</div>;
  }
  if (error) {
    return <div className="p-4 text-sm text-error">Could not load hub items.</div>;
  }
  if (items.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No open items in this lane.</div>;
  }

  const entries = buildHubListEntries(items, groupMode);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {entries.flatMap((entry) => {
        if (entry.kind === "group") {
          const expanded = expandedGroups.has(entry.key);
          const groupRows = expanded ? entry.items : [];
          return [
            <div
              key={`group:${entry.key}`}
              className="border-b border-border bg-card/60 px-4 py-2"
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => {
                  setExpandedGroups((current) => {
                    const next = new Set(current);
                    if (next.has(entry.key)) next.delete(entry.key);
                    else next.add(entry.key);
                    return next;
                  });
                }}
                className="flex h-8 w-full items-center justify-between text-left text-sm font-medium"
              >
                <span>
                  {entry.items.length} {entry.label}
                </span>
                <span className="text-xs text-muted-foreground">{entry.unreadCount} unread</span>
              </button>
              {entry.summary ? (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {entry.summary}
                </p>
              ) : null}
            </div>,
            ...groupRows.map((item) => renderItem(item)),
          ];
        }
        return [renderItem(entry.item)];
      })}
      {hasMore ? (
        <div className="border-b border-border p-3">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="h-9 w-full rounded-md border border-border text-sm text-text hover:bg-card disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoadingMore ? "Loading..." : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );

  function renderItem(item: HubItemListRow) {
    const entry = HUB_REGISTRY[item.semanticType];
    const Icon = entry.icon;
    const selected = selectedItemId === item.id;
    const hidden = hiddenState(item);
    return (
      <div
        key={item.id}
        className={cn(
          "grid h-[92px] w-full grid-cols-[18px_28px_1fr_auto] gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-card",
          density === "compact" && "h-[76px] py-2",
          selected && "bg-card",
          hidden && "opacity-70",
        )}
      >
        <input
          type="checkbox"
          aria-label={`Select ${item.title}`}
          checked={selectedBulkIds.has(item.id)}
          onChange={() => onToggleBulkItem(item.id)}
          className="mt-1 size-4 accent-brand"
        />
        <span className="mt-0.5 flex size-7 items-center justify-center rounded-md border border-border bg-bg">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <button
          type="button"
          data-hub-row-id={item.id}
          onClick={() => {
            if (onOpenItem) onOpenItem(item);
            else onSelectItem(item.id);
            if (!item.readAt) onMarkRead(item.id);
          }}
          className="min-w-0 text-left"
        >
          <span className="flex items-center gap-2">
            {!item.readAt ? (
              <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="Unread" />
            ) : null}
            <span className="truncate text-sm font-medium text-text">{item.title}</span>
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {item.summary ?? entry.label}
          </span>
          <span className="mt-2 flex min-w-0 items-center gap-1.5">
            <span className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {entry.label}
            </span>
            <span className="inline-flex rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {item.priority}
            </span>
            {hidden ? (
              <span className="inline-flex rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {hidden}
              </span>
            ) : null}
          </span>
        </button>
        <div className="flex flex-col items-end justify-between gap-1">
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatDate(item.createdAt)}
          </span>
          {hidden ? (
            <button
              type="button"
              onClick={() => {
                if (hidden === "dismissed") onUndismiss?.(item.id);
                else onUnsnooze?.(item.id);
              }}
              className="whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-card"
            >
              {hidden === "dismissed" ? "Undismiss" : "Unsnooze"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
}

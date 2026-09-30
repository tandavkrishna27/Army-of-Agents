import { EyeOff, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { useBreakpoint } from "@/lib/useBreakpoint";
import type { HubAuditRow, HubItemListRow } from "@/api/hub-items";
import type {
  HubAutopilotActionRow,
  HubAutopilotPolicy,
  HubItemStatus,
  HubLane,
  HubPreferences,
} from "@armyofagents/shared";
import { Button } from "@/components/ui/button";
import { HubActionBar } from "./HubActionBar";
import { HubHome } from "./HubHome";
import { HubList } from "./HubList";
import { HubRail, type HubRailLane } from "./HubRail";
import { HubTabBody } from "./HubTabBody";
import { HubTabStrip } from "./HubTabStrip";
import { hubTabForItem } from "./hubRegistry";
import { HOME_TAB, type HubTab } from "./hubViewerModel";

const EMPTY_BULK_IDS = new Set<string>();
const noop = () => {};
/** Persisted icon-only state for the hub lane rail (Discussions-rail pattern). */
const RAIL_COLLAPSED_KEY = "aoa:hub:rail-collapsed";
const DEFAULT_PREFERENCES: HubPreferences = {
  defaultLanding: "home",
  visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
  groupMode: "auto",
  density: "comfortable",
  showAutopilotEntry: true,
  updatedAt: null,
};
const DEFAULT_AUTOPILOT_POLICY: HubAutopilotPolicy = {
  mode: "off",
  handledToday: 0,
  lastHandledAt: null,
  rules: [],
  updatedAt: null,
};
const EMPTY_AUTOPILOT_ACTIONS: { items: HubAutopilotActionRow[] } = { items: [] };

interface HubShellProps {
  activeLane: HubRailLane;
  items: HubItemListRow[];
  /** Home-only "Needs you most" preview rows (a small waiting-lane page). Fed to
   *  HubHome when no lane is active; `items` stays empty on Home. */
  homeItems?: HubItemListRow[];
  counts: { open: number; unread: number };
  isLoading: boolean;
  error: unknown;
  selectedItemId: string | null;
  /** The selected hub item resolved by the parent (loaded list OR deep-link
   *  hydration), used as the Home tab's reading-pane preview. */
  selectedItem: HubItemListRow | null;
  /** Concrete company id for the embedded viewers hosted in tabs (D2-review
   *  seam: an embedded ThreadDetail with an undefined companyId would hang). */
  companyId: string | undefined;
  /** Open hub tabs (Home first, non-closeable) + the active tab key. */
  tabs: HubTab[];
  activeTabKey: string | null;
  /** Open a prebuilt tab (linked-entity hand-offs from inside a hosted viewer). */
  onOpenTab: (tab: HubTab) => void;
  /** Row-click "open": select the item + open its entity as a tab. */
  onOpenItem: (item: HubItemListRow) => void;
  onCloseTab: (key: string) => void;
  onActivateTab: (key: string) => void;
  onAddBrowserTab: () => void;
  /** Resolve a hub item id → full row for the runtime_decision tab body. */
  resolveHubItem: (hubItemId: string) => HubItemListRow | undefined;
  /** Resolve the active tab back to its originating hub row for action-bar targeting. */
  resolveHubItemForTab?: (tab: HubTab) => HubItemListRow | undefined;
  historyStatus: Extract<HubItemStatus, "open" | "resolved" | "archived">;
  auditRows: HubAuditRow[];
  auditLoading: boolean;
  selectedBulkIds: Set<string>;
  bulkMessage: string | null;
  searchText?: string;
  /** Waiting-lane dismiss-hole safety net: count of the current user's hidden
   *  (dismissed/snoozed) OPEN rows; the "N hidden" chip renders when > 0. */
  hiddenCount?: number;
  /** Whether the hidden rows are currently revealed (chip toggled on). */
  showHidden?: boolean;
  /** Toggle the hidden-reveal (includeDismissed + includeSnoozed) list query. */
  onToggleHidden?: () => void;
  /** Restore a personally-dismissed hidden row. */
  onUndismiss?: (itemId: string) => void;
  /** Restore a personally-snoozed hidden row. */
  onUnsnooze?: (itemId: string) => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  preferences?: HubPreferences;
  autopilotPolicy?: HubAutopilotPolicy;
  autopilotActions?: { items: HubAutopilotActionRow[] };
  onLaneChange: (lane: HubRailLane) => void;
  onSearchTextChange?: (value: string) => void;
  onLoadMore?: () => void;
  onUndoAutopilotAction?: (action: HubAutopilotActionRow) => void;
  onHistoryStatusChange: (status: Extract<HubItemStatus, "open" | "resolved" | "archived">) => void;
  onSelectItem: (itemId: string | null) => void;
  onMarkRead: (itemId: string) => void;
  onToggleBulkItem: (itemId: string) => void;
  onBulkAction: (action: "archive" | "dismiss" | "snooze") => void;
  onMarkUnread: (itemId: string) => void;
  onDismiss: (itemId: string) => void;
  onSnooze: (itemId: string) => void;
  onLifecycleAction: (item: HubItemListRow, action: "resolve" | "archive" | "claim" | "release") => void;
  undoAction: { label: string; onUndo: () => void } | null;
}

export function HubShell({
  activeLane,
  items,
  homeItems,
  counts,
  isLoading,
  error,
  selectedItemId,
  selectedItem,
  companyId,
  tabs,
  activeTabKey,
  onOpenTab,
  onOpenItem,
  onCloseTab,
  onActivateTab,
  onAddBrowserTab,
  resolveHubItem,
  resolveHubItemForTab,
  historyStatus = "open",
  auditRows = [],
  auditLoading = false,
  selectedBulkIds = EMPTY_BULK_IDS,
  bulkMessage = null,
  searchText = "",
  hiddenCount = 0,
  showHidden = false,
  onToggleHidden = noop,
  onUndismiss = noop,
  onUnsnooze = noop,
  hasMore = false,
  isLoadingMore = false,
  preferences = DEFAULT_PREFERENCES,
  autopilotPolicy = DEFAULT_AUTOPILOT_POLICY,
  autopilotActions = EMPTY_AUTOPILOT_ACTIONS,
  onLaneChange,
  onSearchTextChange = noop,
  onLoadMore = noop,
  onUndoAutopilotAction = noop,
  onHistoryStatusChange = noop,
  onSelectItem,
  onMarkRead,
  onToggleBulkItem = noop,
  onBulkAction = noop,
  onMarkUnread = noop,
  onDismiss = noop,
  onSnooze = noop,
  onLifecycleAction = noop,
  undoAction = null,
}: HubShellProps) {
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const toggleRailCollapsed = () => {
    setRailCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(RAIL_COLLAPSED_KEY, String(next));
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  };
  // Gate the resizable Group on the SAME 1024px boundary the rest of this
  // component uses via `lg:` (HubRail `hidden lg:block`, rail dialog `lg:hidden`).
  // `isMobile` is <640px only, which would mount the horizontal split in the
  // 640-1023px tablet band while the inline rail is still hidden.
  const { isDesktopUp } = useBreakpoint();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "aoa:hub:panel-sizes",
    storage: localStorage,
    panelIds: ["hub-list", "hub-viewer"],
  });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const keyboardSelectedItemId = useRef<string | null>(selectedItemId);
  const showHome = activeLane === null;
  const listItems = showHome ? (homeItems ?? []) : items;
  const selectedCount = selectedBulkIds.size;
  // The "N hidden" chip is the dismiss-hole safety net: only the waiting lane's
  // OPEN view, and only when the toggle is already on OR the current user has
  // hidden rows to reveal (so toggling off never strands the affordance).
  const showHiddenChip =
    activeLane === "waiting_on_you" &&
    historyStatus === "open" &&
    (showHidden || hiddenCount > 0);

  useEffect(() => {
    keyboardSelectedItemId.current = selectedItemId;
  }, [selectedItemId]);

  useEffect(() => {
    keyboardSelectedItemId.current = null;
  }, [activeLane, historyStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;

      if (event.key === "/" && !showHome) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === "Escape") {
        if (mobileRailOpen) {
          setMobileRailOpen(false);
          return;
        }
        if (selectedItemId) {
          focusHubRow(selectedItemId);
          onSelectItem(null);
        }
        return;
      }

      if (event.key === "Enter" && activeLane && items.length > 0) {
        const currentId = keyboardSelectedItemId.current ?? selectedItemId;
        if (!currentId) return;
        const target = items.find((item) => item.id === currentId);
        if (target) {
          event.preventDefault();
          onOpenItem(target);
        }
        return;
      }

      if ((event.key === "j" || event.key === "k") && activeLane && items.length > 0) {
        event.preventDefault();
        const visibleRowIds = getVisibleHubRowIds();
        const navigationItems =
          visibleRowIds.length > 0
            ? visibleRowIds
                .map((id) => items.find((item) => item.id === id))
                .filter((item): item is HubItemListRow => Boolean(item))
            : items;
        const currentId = keyboardSelectedItemId.current ?? selectedItemId;
        const currentIndex = currentId
          ? navigationItems.findIndex((item) => item.id === currentId)
          : -1;
        const nextIndex =
          event.key === "j"
            ? Math.min(currentIndex + 1, navigationItems.length - 1)
            : Math.max(currentIndex - 1, 0);
        const nextItem = navigationItems[nextIndex] ?? navigationItems[0];
        keyboardSelectedItemId.current = nextItem.id;
        onSelectItem(nextItem.id);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeLane, items, mobileRailOpen, onOpenItem, onSelectItem, selectedItemId, showHome]);

  const handleLaneChange = (lane: HubRailLane) => {
    setMobileRailOpen(false);
    onLaneChange(lane);
  };

  const listSection = (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* 42px header — matches the rail header and the viewer tab strip. */}
          <div className="flex h-[42px] shrink-0 items-center justify-between gap-3 border-b border-border px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Open hub lanes"
                onClick={() => setMobileRailOpen(true)}
                className="lg:hidden"
              >
                <Menu className="size-4" aria-hidden="true" />
              </Button>
              <h1 className="truncate text-sm font-semibold">
                {showHome ? "Hub Home" : laneTitle(activeLane)}
              </h1>
            </div>
            <div className="flex shrink-0 gap-1">
              {!showHome
                ? (["open", "resolved", "archived"] as const).map((status) => (
                  <Button
                    key={status}
                    type="button"
                    variant={historyStatus === status ? "secondary" : "ghost"}
                    size="sm"
                    aria-pressed={historyStatus === status}
                    onClick={() => onHistoryStatusChange(status)}
                  >
                    {statusLabel(status)}
                  </Button>
                ))
                : null}
            </div>
          </div>
          {!showHome ? (
            <div className="border-b border-border px-4 py-2">
              <input
                type="search"
                aria-label="Search hub"
                ref={searchInputRef}
                value={searchText}
                onChange={(event) => onSearchTextChange(event.target.value)}
                placeholder="Search"
                className="h-9 w-full rounded-md border border-border bg-bg px-3 text-sm outline-none focus:border-brand"
              />
            </div>
          ) : null}
          {showHiddenChip ? (
            <div className="border-b border-border px-4 py-2">
              <button
                type="button"
                aria-pressed={showHidden}
                onClick={onToggleHidden}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-card",
                  showHidden && "border-brand/60 bg-brand/10 text-brand",
                )}
              >
                <EyeOff className="size-3" aria-hidden="true" />
                {showHidden
                  ? "Hide dismissed"
                  : `${hiddenCount} hidden`}
              </button>
            </div>
          ) : null}
          {!showHome && selectedCount > 0 ? (
            <div className="flex h-11 items-center justify-between gap-3 border-b border-border bg-card px-4 text-xs">
              <span className="text-muted-foreground">{selectedCount} selected</span>
              <div className="flex gap-1">
                <Button type="button" variant="secondary" size="sm" onClick={() => onBulkAction("archive")}>
                  Archive selected
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => onBulkAction("dismiss")}>
                  Dismiss selected
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => onBulkAction("snooze")}>
                  Snooze selected
                </Button>
              </div>
            </div>
          ) : null}
          {!showHome && bulkMessage ? (
            <div role="status" className="border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground">
              {bulkMessage}
            </div>
          ) : null}
          <HubList
            items={listItems}
            isLoading={isLoading}
            error={error}
            selectedItemId={selectedItemId}
            selectedBulkIds={selectedBulkIds}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            groupMode={preferences.groupMode}
            density={preferences.density}
            onOpenItem={onOpenItem}
            onSelectItem={onSelectItem}
            onMarkRead={onMarkRead}
            onToggleBulkItem={onToggleBulkItem}
            onLoadMore={onLoadMore}
            onUndismiss={onUndismiss}
            onUnsnooze={onUnsnooze}
          />
        </section>
  );

  const activeTab = tabs.find((tab) => tab.key === activeTabKey) ?? tabs[0] ?? HOME_TAB;
  const activeBarItem: HubItemListRow | null =
    activeTab.kind === "home"
      ? null
      : resolveHubItemForTab?.(activeTab) ??
        hubItemForTab(activeTab, [
          ...(selectedItem ? [selectedItem] : []),
          ...items,
          ...(homeItems ?? []),
        ]);
  const viewer = (
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg"
          data-testid="hub-tabbed-viewer"
        >
          <HubTabStrip
            tabs={tabs}
            activeKey={activeTabKey}
            onActivate={onActivateTab}
            onClose={onCloseTab}
            onAddBrowser={onAddBrowserTab}
          />
          {activeBarItem && activeTab.kind !== "home" ? (
            <HubActionBar
              item={activeBarItem}
              onDismiss={onDismiss}
              onSnooze={onSnooze}
              onLifecycleAction={onLifecycleAction}
              onMarkUnread={onMarkUnread}
              undoAction={undoAction}
            />
          ) : null}
          <div className="min-h-0 min-w-0 flex-1">
            <HubTabBody
              tab={activeTab}
              companyId={companyId}
              onOpenTab={onOpenTab}
              resolveHubItem={resolveHubItem}
              activeItem={activeBarItem}
              homeContent={
                <HubHome
                  counts={counts}
                  items={homeItems ?? items}
                  visibleLanes={preferences.visibleLanes}
                  showAutopilotEntry={preferences.showAutopilotEntry}
                  autopilotPolicy={autopilotPolicy}
                  autopilotActions={autopilotActions.items}
                  onLaneChange={(lane: HubLane) => onLaneChange(lane)}
                  onUndoAutopilotAction={onUndoAutopilotAction}
                />
              }
            />
          </div>
        </div>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-muted/30 text-text lg:flex-row lg:gap-2 lg:p-2">
      <div className="hidden lg:block">
        <HubRail
          activeLane={activeLane}
          counts={counts}
          visibleLanes={preferences.visibleLanes}
          onLaneChange={handleLaneChange}
          collapsed={railCollapsed}
          onToggleCollapsed={toggleRailCollapsed}
        />
      </div>
      {mobileRailOpen ? (
        <div
          role="dialog"
          aria-label="Hub lanes"
          className="border-b border-border bg-bg lg:hidden"
        >
          <div className="flex h-11 items-center justify-between border-b border-border px-3">
            <span className="text-sm font-semibold">Hub lanes</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close hub lanes"
              onClick={() => setMobileRailOpen(false)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
          <HubRail
            activeLane={activeLane}
            counts={counts}
            visibleLanes={preferences.visibleLanes}
            onLaneChange={handleLaneChange}
          />
        </div>
      ) : null}
      {!isDesktopUp ? (
        <main className="flex min-w-0 flex-1 flex-col">
          {listSection}
          {viewer}
        </main>
      ) : (
        <Group
          orientation="horizontal"
          className="flex min-w-0 flex-1"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          data-testid="hub-panel-group"
        >
          <Panel
            id="hub-list"
            defaultSize="38%"
            minSize="24%"
            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="hub-list-panel"
          >
            {listSection}
          </Panel>
          {/* Transparent resize gutter — the tray shows through, so the list and
              viewer read as separate floating islands (Discussions pattern). */}
          <Separator
            className="w-2 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border/70"
            data-testid="hub-panel-separator"
          />
          <Panel
            id="hub-viewer"
            minSize="30%"
            className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="hub-viewer-panel"
          >
            {viewer}
          </Panel>
        </Group>
      )}
    </div>
  );
}

function statusLabel(status: Extract<HubItemStatus, "open" | "resolved" | "archived">) {
  if (status === "resolved") return "Resolved";
  if (status === "archived") return "Archived";
  return "Open";
}

function laneTitle(lane: HubLane | null) {
  if (lane === "waiting_on_you") return "Waiting on you";
  if (lane === "notifications") return "Notifications";
  if (lane === "suggestions") return "Suggestions";
  return "Home";
}

function hubItemIdForTab(tab: HubTab): string {
  const payload = tab.payload as { hubItemId?: string } | undefined;
  return payload?.hubItemId ?? "";
}

function hubItemForTab(tab: HubTab, candidates: HubItemListRow[]): HubItemListRow | null {
  const hubItemId = hubItemIdForTab(tab);
  if (hubItemId) {
    return candidates.find((item) => item.id === hubItemId) ?? null;
  }
  return candidates.find((item) => hubTabForItem(item).key === tab.key) ?? null;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return true;
  const role = target.getAttribute("role");
  return role === "textbox" || role === "combobox";
}

function focusHubRow(itemId: string) {
  const row = Array.from(document.querySelectorAll<HTMLElement>("[data-hub-row-id]")).find(
    (element) => element.getAttribute("data-hub-row-id") === itemId,
  );
  row?.focus();
}

function getVisibleHubRowIds() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-hub-row-id]"))
    .filter((element) => element.offsetParent !== null)
    .map((element) => element.getAttribute("data-hub-row-id"))
    .filter((id): id is string => Boolean(id));
}

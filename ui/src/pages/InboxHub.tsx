import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  HubAutopilotActionRow,
  HubAutopilotActionsResponse,
  HubAutopilotPolicy,
  HubItemStatus,
  HubLane,
  HubPreferences,
  NotificationPreferences,
} from "@armyofagents/shared";
import { hubItemsApi, type HubItemListRow, type HubListResponse } from "@/api/hub-items";
import { HubShell } from "@/components/hub/HubShell";
import { hubTabForItem } from "@/components/hub/hubRegistry";
import { browserTab } from "@/components/hub/hubViewerModel";
import { useHubTabs } from "@/components/hub/useHubTabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useLiveUpdates } from "@/context/LiveUpdatesProvider";
import { useToast } from "@/context/ToastContext";
import { useHubItemMutations } from "@/hooks/useHubItemMutations";
import { buildHubToastInput, shouldToastHubItem } from "@/lib/hub-toast-bridge";
import { queryKeys } from "@/lib/queryKeys";
import { Navigate, useLocation, useNavigate, useParams } from "@/lib/router";

export const LANE_TO_SLUG: Record<HubLane, string> = {
  waiting_on_you: "waiting",
  notifications: "notifications",
  suggestions: "suggestions",
};

export const SLUG_TO_LANE: Record<string, HubLane> = {
  waiting: "waiting_on_you",
  notifications: "notifications",
  suggestions: "suggestions",
};

type RouteHistoryStatus = Extract<HubItemStatus, "open" | "resolved" | "archived">;

function getRouteHistoryStatus(search: string): RouteHistoryStatus {
  const status = new URLSearchParams(search).get("status");
  return status === "resolved" || status === "archived" ? status : "open";
}

function appendStatus(search: string, status: RouteHistoryStatus) {
  const params = new URLSearchParams(search);
  params.set("status", status);
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}

const DEFAULT_HUB_PREFERENCES: HubPreferences = {
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
const DEFAULT_AUTOPILOT_ACTIONS: HubAutopilotActionsResponse = { items: [] };

/** Bound for the opened-item preview cache (deliberate, like useHubTabs' 12-tab cap). */
export const OPENED_ITEM_CACHE_MAX = 24;

/**
 * "Needs you most" (HubHome) reads items[0]. On Home (`activeLane===null`) the
 * lane list query is disabled, so without a dedicated fetch the card is
 * permanently empty. This stable options object drives a small waiting-lane
 * preview page (the decision lane) with a stable query key. Module-level so the
 * reference — and therefore the query key — stays stable across renders.
 */
export const HOME_PREVIEW_OPTIONS = {
  lane: "waiting_on_you",
  status: "open",
  limit: 5,
} as const;

/**
 * The ONLY insert path for the opened-item cache — used by BOTH writers (the
 * deep-link hydration effect and handleOpenItem) so the cache stays bounded to
 * the most recent {@link OPENED_ITEM_CACHE_MAX} rows. Recency = insertion
 * order (string keys preserve it; hub item ids are uuids, never integer-like).
 * Re-inserting the exact cached reference is a no-op (React bails out, so
 * repeated row clicks don't churn state); a changed row for a cached id
 * refreshes both its data and its recency.
 */
export function insertOpenedItem(
  cache: Record<string, HubItemListRow>,
  item: HubItemListRow,
): Record<string, HubItemListRow> {
  if (cache[item.id] === item) return cache;
  const entries = Object.entries(cache).filter(([id]) => id !== item.id);
  entries.push([item.id, item]);
  return Object.fromEntries(
    entries.slice(Math.max(0, entries.length - OPENED_ITEM_CACHE_MAX)),
  );
}

interface OpenedItemCacheState {
  companyId: string | null;
  items: Record<string, HubItemListRow>;
}

export function InboxHub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{
    companyPrefix?: string;
    lane?: string;
    itemId?: string;
  }>();
  const queryClient = useQueryClient();
  const { onHubItemChanged } = useLiveUpdates();
  const { pushToast } = useToast();
  const refreshAutopilotDashboard = useCallback(() => {
    if (!selectedCompanyId) return;
    void queryClient.invalidateQueries({
      queryKey: queryKeys.hubItems.autopilotPolicy(selectedCompanyId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.hubItems.autopilotActions(selectedCompanyId),
    });
  }, [queryClient, selectedCompanyId]);
  const markingReadItemIds = useRef(new Set<string>());
  const notificationPreferencesRef = useRef<NotificationPreferences | null>(null);
  const hubMutations = useHubItemMutations(selectedCompanyId);
  // Tabbed right-panel viewer (Home + entity + browser tabs), persisted per company.
  const { tabs, activeKey, openTab, closeTab, activateTab } = useHubTabs(
    selectedCompanyId ?? undefined,
  );
  // Rows opened as tabs are cached here so runtime_decision / notification bodies
  // (which resolve their hub item by id) keep working after a lane switch, and so
  // deep-linked items from another lane / resolved history can resolve at all.
  // Bounded: every write goes through insertOpenedItem (most recent 24 rows).
  const [openedItemCacheState, setOpenedItemCacheState] = useState<OpenedItemCacheState>({
    companyId: selectedCompanyId ?? null,
    items: {},
  });
  const openedItemCache =
    openedItemCacheState.companyId === (selectedCompanyId ?? null)
      ? openedItemCacheState.items
      : {};
  // Per-itemId guard (not a boolean): a later deep-link to a DIFFERENT item in
  // the same SPA session must hydrate too; the same item stays fire-once.
  const deepLinkHandledRef = useRef<string | null>(null);
  const [undoAction, setUndoAction] = useState<{
    label: string;
    itemId: string;
    auditId?: string;
    expectedVersion?: number;
    restore?: { kind: "unsnooze" | "undismiss" };
  } | null>(null);
  const routeHistoryStatus = getRouteHistoryStatus(location.search);
  const [historyStatus, setHistoryStatus] =
    useState<RouteHistoryStatus>(routeHistoryStatus);
  const [selectedBulkIds, setSelectedBulkIds] = useState<Set<string>>(() => new Set());
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  // Waiting-lane dismiss-hole safety net: reveal the current user's personally
  // hidden (dismissed/snoozed) OPEN rows when the "N hidden" chip is toggled on.
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    const companyId = selectedCompanyId ?? null;
    if (openedItemCacheState.companyId === companyId) return;
    setOpenedItemCacheState({ companyId, items: {} });
  }, [openedItemCacheState.companyId, selectedCompanyId]);

  const cacheOpenedItem = useCallback((item: HubItemListRow) => {
    const companyId = selectedCompanyId ?? null;
    setOpenedItemCacheState((current) => ({
      companyId,
      items: insertOpenedItem(
        current.companyId === companyId ? current.items : {},
        item,
      ),
    }));
  }, [selectedCompanyId]);

  const laneSlug = params.lane ?? null;
  const activeLane = laneSlug ? SLUG_TO_LANE[laneSlug] ?? null : null;
  const unknownLane = laneSlug != null && activeLane == null;
  const inboxHubIndex = location.pathname.indexOf("/inbox-hub");
  const legacyInboxHubTarget =
    inboxHubIndex >= 0
      ? `/inbox${location.pathname.slice(inboxHubIndex + "/inbox-hub".length)}${location.search}`
      : null;
  const isLegacyInboxNew = /\/inbox\/new$/.test(location.pathname);
  const isLegacyInboxAll = /\/inbox\/all$/.test(location.pathname);

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox Hub" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setHistoryStatus(routeHistoryStatus);
  }, [routeHistoryStatus]);

  const countsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hubItems.counts(selectedCompanyId)
      : ["hub-items", "counts", "none"],
    queryFn: () => hubItemsApi.counts(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const preferencesQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hubItems.preferences(selectedCompanyId)
      : ["hub-items", "preferences", "none"],
    queryFn: () => hubItemsApi.getPreferences(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const preferences = preferencesQuery.data ?? DEFAULT_HUB_PREFERENCES;

  const notificationPreferencesQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.notifications.preferences(selectedCompanyId)
      : ["notifications", "preferences", "none"],
    queryFn: () => hubItemsApi.notificationPreferences.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const autopilotPolicyQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hubItems.autopilotPolicy(selectedCompanyId)
      : ["hub-items", "autopilot-policy", "none"],
    queryFn: () => hubItemsApi.autopilotPolicy.get(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const autopilotActionsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hubItems.autopilotActions(selectedCompanyId)
      : ["hub-items", "autopilot-actions", "none"],
    queryFn: () => hubItemsApi.autopilotActions.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    notificationPreferencesRef.current = notificationPreferencesQuery.data ?? null;
  }, [notificationPreferencesQuery.data, selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    return onHubItemChanged(async (itemId) => {
      const loadedNotificationPreferences = notificationPreferencesRef.current;
      if (!loadedNotificationPreferences) return;

      try {
        const item = await hubItemsApi.getOne(selectedCompanyId, itemId);
        const decision = shouldToastHubItem({
          item,
          preferences: loadedNotificationPreferences,
          now: new Date(),
        });
        if (decision.show) {
          pushToast(buildHubToastInput(selectedCompanyId, item));
        }
      } catch {
        // The RBAC hydration route may 404 for stale/hidden items; ignore the poke.
      }
    });
  }, [onHubItemChanged, pushToast, selectedCompanyId]);

  useEffect(() => {
    if (!activeLane) {
      if (preferences.defaultLanding !== "home") {
        navigate(`/inbox/${LANE_TO_SLUG[preferences.defaultLanding]}`);
      }
      return;
    }
    if (!preferences.visibleLanes.includes(activeLane)) {
      navigate("/inbox");
    }
  }, [activeLane, navigate, preferences.defaultLanding, preferences.visibleLanes]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchText(searchText.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  // The hidden-reveal toggle only applies to the waiting lane's OPEN history view
  // (dismiss/snooze are personal decision-lane triage). Elsewhere it stays off.
  const hiddenRevealActive =
    showHidden && activeLane === "waiting_on_you" && historyStatus === "open";

  const listOptions = useMemo(
    () =>
      activeLane
        ? {
            lane: activeLane,
            status: historyStatus,
            q: debouncedSearchText || undefined,
            groupMode: preferences.groupMode,
            ...(hiddenRevealActive
              ? { includeDismissed: true, includeSnoozed: true }
              : {}),
            limit: 50,
          }
        : undefined,
    [activeLane, debouncedSearchText, historyStatus, preferences.groupMode, hiddenRevealActive],
  );

  // Per-user, lane-scoped count of dismissed/snoozed OPEN items (the "N hidden"
  // chip). Waiting-lane only; a separate cheap query (never touches the counts
  // snapshot cache). Sits under the ["hub-items", cid] prefix so the live
  // hub.item.changed invalidation refreshes it.
  const hiddenCountQuery = useQuery({
    queryKey:
      selectedCompanyId
        ? queryKeys.hubItems.hiddenCount(selectedCompanyId, "waiting_on_you")
        : ["hub-items", "hidden-count", "none"],
    queryFn: () => hubItemsApi.hiddenCount(selectedCompanyId!, "waiting_on_you"),
    enabled: !!selectedCompanyId && activeLane === "waiting_on_you",
  });
  const hiddenCount = hiddenCountQuery.data?.hiddenOpen ?? 0;

  // "Needs you most" Home preview: a small waiting-lane page fetched ONLY on Home
  // (activeLane===null), where the lane list query is disabled. Distinct query
  // key from any lane's infinite query, under the ["hub-items", cid] prefix so the
  // live hub.item.changed invalidation refreshes it.
  const homePreviewQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.hubItems.homePreview(selectedCompanyId)
      : ["hub-items", "home-preview", "none"],
    queryFn: () => hubItemsApi.list(selectedCompanyId!, HOME_PREVIEW_OPTIONS),
    enabled: !!selectedCompanyId && !activeLane,
  });
  const homeItems = homePreviewQuery.data?.items ?? [];

  useEffect(() => {
    if (homePreviewQuery.status !== "success") return;
    refreshAutopilotDashboard();
  }, [homePreviewQuery.dataUpdatedAt, homePreviewQuery.status, refreshAutopilotDashboard]);

  // Reset the bulk selection on any list-scope change. Page accumulation resets
  // for free: the query key includes lane/search/status, so useInfiniteQuery
  // starts a fresh page-1 fetch whenever the scope changes.
  useEffect(() => {
    setSelectedBulkIds(new Set());
    setShowHidden(false);
  }, [activeLane, debouncedSearchText, historyStatus]);

  // Pages accumulate in the react-query cache (no useState mirror). v5's default
  // structuralSharing keeps item references stable across an unchanged refetch,
  // so the list doesn't re-render on every hub mutation (the flicker fix).
  const listQuery = useInfiniteQuery({
    queryKey:
      selectedCompanyId && listOptions
        ? queryKeys.hubItems.list(selectedCompanyId, listOptions)
        : ["hub-items", selectedCompanyId ?? "none", "home"],
    queryFn: ({ pageParam }) =>
      hubItemsApi.list(selectedCompanyId!, {
        ...listOptions!,
        cursor: pageParam ?? undefined,
      }),
    enabled: !!selectedCompanyId && !!listOptions,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  useEffect(() => {
    if (listQuery.status !== "success") return;
    refreshAutopilotDashboard();
  }, [listQuery.dataUpdatedAt, listQuery.status, refreshAutopilotDashboard]);

  const markRead = useMutation({
    mutationFn: (itemId: string) => hubItemsApi.markRead(selectedCompanyId!, itemId),
    onMutate: (itemId) => {
      if (!selectedCompanyId) return;
      const readAt = new Date().toISOString();
      // Broad prefix matcher: this hits the list, counts, audit, preferences and
      // autopilot caches. Branch order matters — the infinite-query list cache is
      // `{ pages: HubListResponse[], pageParams }`, so match `"pages" in old` FIRST
      // (before the `.items`/array branches) and leave every other shape as `old`.
      queryClient.setQueriesData<unknown>(
        { queryKey: ["hub-items", selectedCompanyId] },
        (old: unknown) => {
          if (
            old &&
            typeof old === "object" &&
            "pages" in old &&
            Array.isArray((old as { pages: HubListResponse[] }).pages)
          ) {
            const paged = old as { pages: HubListResponse[]; pageParams: unknown[] };
            return {
              ...paged,
              pages: paged.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  item.id === itemId ? { ...item, readAt } : item,
                ),
              })),
            };
          }
          if (Array.isArray(old)) {
            return old.map((item) =>
              (item as HubItemListRow).id === itemId
                ? { ...(item as HubItemListRow), readAt }
                : item,
            );
          }
          if (old && typeof old === "object" && Array.isArray((old as HubListResponse).items)) {
            const resp = old as HubListResponse;
            return {
              ...resp,
              items: resp.items.map((item) =>
                item.id === itemId ? { ...item, readAt } : item,
              ),
            };
          }
          return old;
        },
      );
    },
    onError: (_error, itemId) => {
      markingReadItemIds.current.delete(itemId);
    },
    onSettled: async () => {
      if (!selectedCompanyId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.hubItems.counts(selectedCompanyId),
      });
    },
  });

  const items = useMemo(
    () => (activeLane ? (listQuery.data?.pages.flatMap((page) => page.items) ?? []) : []),
    [activeLane, listQuery.data],
  );
  // `selectedItemId` gates the center-list highlight, so it stays validated
  // against the loaded lane. `selectedItem` (the Home preview) additionally
  // falls back to the opened-item cache so a deep-linked / cross-lane item still
  // previews. `:itemId` remains a HUB-ITEM id — never an entity id.
  const selectedItemId =
    params.itemId && items.some((item) => item.id === params.itemId)
      ? params.itemId
      : null;
  const selectedItem =
    (params.itemId
      ? items.find((item) => item.id === params.itemId) ?? openedItemCache[params.itemId]
      : undefined) ?? null;

  // Deep link (`/inbox/:lane/:itemId`) OPENS + activates the item's dedicated tab
  // (tab-first, no preview). Prefer the lane's own row: if the item's lane is
  // still loading, WAIT for it (opening a tab is a one-shot side-effect, unlike
  // the old reactive reading pane — resolving off a half-loaded list would open
  // the wrong-typed tab). Only when the item is genuinely NOT in the settled lane
  // (hidden / resolved / other lane) do we hydrate it once via `getOne`, then open
  // its tab. The `deepLinkHandledRef` guard keeps this idempotent so a later list
  // refetch (or a manual tab close) never re-opens the tab for the same `:itemId`.
  useEffect(() => {
    const itemId = params.itemId;
    if (!itemId || !selectedCompanyId) return;
    const deepLinkKey = `${selectedCompanyId}:${itemId}`;
    if (deepLinkHandledRef.current === deepLinkKey) return;
    const listItem = items.find((item) => item.id === itemId);
    const cached = openedItemCache[itemId];
    if (listItem || cached) {
      const row = listItem ?? cached;
      if (listItem) cacheOpenedItem(listItem);
      deepLinkHandledRef.current = deepLinkKey;
      if (row) openTab(hubTabForItem(row));
      return;
    }
    // The item's lane is still loading — defer so the lane row (correct entity
    // type) wins over a redundant getOne hydrate.
    if (activeLane && listQuery.isLoading) return;
    deepLinkHandledRef.current = deepLinkKey;
    let cancelled = false;
    hubItemsApi
      .getOne(selectedCompanyId, itemId)
      .then((item) => {
        if (cancelled) return;
        cacheOpenedItem(item);
        openTab(hubTabForItem(item));
      })
      .catch(() => {
        // Stale / hidden deep link — no tab to open.
      });
    return () => {
      cancelled = true;
    };
  }, [
    params.itemId,
    selectedCompanyId,
    items,
    openedItemCache,
    cacheOpenedItem,
    openTab,
    activeLane,
    listQuery.isLoading,
  ]);

  const resolveHubItem = useCallback(
    (id: string): HubItemListRow | undefined =>
      items.find((item) => item.id === id) ?? openedItemCache[id],
    [items, openedItemCache],
  );
  const resolveHubItemForTab = useCallback(
    (tab: (typeof tabs)[number]): HubItemListRow | undefined => {
      const hubItemId = (tab.payload as { hubItemId?: string } | undefined)?.hubItemId;
      if (hubItemId) return resolveHubItem(hubItemId);

      return [
        ...(selectedItem ? [selectedItem] : []),
        ...items,
        ...homeItems,
        ...Object.values(openedItemCache),
      ].find((item) => hubTabForItem(item).key === tab.key);
    },
    [homeItems, items, openedItemCache, resolveHubItem, selectedItem],
  );
  const auditQuery = useQuery({
    queryKey:
      selectedCompanyId && selectedItem
        ? queryKeys.hubItems.audit(selectedCompanyId, selectedItem.id)
        : ["hub-items", selectedCompanyId ?? "none", "audit", "none"],
    queryFn: () => hubItemsApi.audit(selectedCompanyId!, selectedItem!.id),
    enabled:
      !!selectedCompanyId &&
      !!selectedItem &&
      (selectedItem.status === "resolved" || selectedItem.status === "archived"),
  });

  const handleLaneChange = (lane: HubLane | null) => {
    setHistoryStatus("open");
    setSelectedBulkIds(new Set());
    if (!lane) {
      navigate("/inbox");
      return;
    }
    navigate(`/inbox/${LANE_TO_SLUG[lane]}`);
  };

  const handleHistoryStatusChange = (
    status: RouteHistoryStatus,
  ) => {
    setHistoryStatus(status);
    setBulkMessage(null);
    if (activeLane) {
      const itemPath = params.itemId ? `/${params.itemId}` : "";
      navigate(
        `/inbox/${LANE_TO_SLUG[activeLane]}${itemPath}${appendStatus(
          location.search,
          status,
        )}`,
      );
    }
  };

  const handleToggleBulkItem = (itemId: string) => {
    setSelectedBulkIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const handleBulkAction = async (action: "archive" | "dismiss" | "snooze") => {
    const selectedItems = items.filter((item) => selectedBulkIds.has(item.id));
    if (selectedItems.length === 0) return;
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const result = await hubMutations.bulkAction.mutateAsync({
      items: selectedItems.map((item) => {
        if (action === "archive") {
          return { id: item.id, action, expectedVersion: item.version };
        }
        if (action === "snooze") {
          return { id: item.id, action, until };
        }
        return { id: item.id, action };
      }),
    });
    setBulkMessage(
      `${result.summary.succeeded} succeeded, ${result.summary.failed} failed`,
    );
    setSelectedBulkIds(new Set());
  };

  const handleSelectItem = (itemId: string | null) => {
    if (!activeLane) return;
    const lanePath = `/inbox/${LANE_TO_SLUG[activeLane]}`;
    if (!itemId) {
      navigate(`${lanePath}${location.search}`);
      return;
    }
    navigate(`${lanePath}/${itemId}${location.search}`);
  };

  // "Open full" (from the Home reading pane) + linked-entity hand-offs: open the
  // item's entity as a dedicated tab (and keep it selected). Cache the row so its
  // tab body can resolve it by id even after a later lane switch.
  const handleOpenItem = (item: HubItemListRow) => {
    cacheOpenedItem(item);
    handleSelectItem(item.id);
    openTab(hubTabForItem(item));
  };

  const handleAddBrowserTab = () => {
    openTab(browserTab("about:blank", "Browser"));
  };

  const handleLoadMore = () => {
    if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
      void listQuery.fetchNextPage();
    }
  };

  const handleMarkRead = (itemId: string) => {
    if (markingReadItemIds.current.has(itemId)) return;
    markingReadItemIds.current.add(itemId);
    markRead.mutate(itemId);
  };

  const handleMarkUnread = (itemId: string) => {
    hubMutations.markUnread.mutate(itemId);
  };

  const handleUndismiss = (itemId: string) => {
    hubMutations.undismiss.mutate(itemId);
  };

  const handleUnsnooze = (itemId: string) => {
    hubMutations.unsnooze.mutate(itemId);
  };

  const handleDismiss = (itemId: string) => {
    hubMutations.dismiss.mutate(itemId);
    setUndoAction({ label: "dismiss", itemId, restore: { kind: "undismiss" } });
  };

  const handleSnooze = (itemId: string) => {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    hubMutations.snooze.mutate({ itemId, until });
    setUndoAction({ label: "snooze", itemId, restore: { kind: "unsnooze" } });
  };

  const handleLifecycleAction = async (
    item: HubItemListRow,
    action: "resolve" | "archive" | "claim" | "release",
  ) => {
    const result = await hubMutations.act.mutateAsync({
      itemId: item.id,
      payload: { action, expectedVersion: item.version },
    });
    if (result.auditId) {
      setUndoAction({
        label: action,
        itemId: item.id,
        auditId: result.auditId,
        expectedVersion: result.item.version,
      });
    }
  };

  const undoServerAction = () => {
    if (!undoAction) return;
    if (undoAction.restore) {
      void hubMutations.undoPersonalState({
        itemId: undoAction.itemId,
        restore: undoAction.restore,
      });
    } else if (undoAction.auditId != null && undoAction.expectedVersion != null) {
      hubMutations.undo.mutate({
        itemId: undoAction.itemId,
        payload: {
          auditId: undoAction.auditId,
          expectedVersion: undoAction.expectedVersion,
        },
      });
    }
    setUndoAction(null);
  };

  const handleUndoAutopilotAction = (action: HubAutopilotActionRow) => {
    if (!selectedCompanyId || !action.hubItemId || action.itemVersion == null) return;
    hubMutations.undo.mutate(
      {
        itemId: action.hubItemId,
        payload: {
          auditId: action.auditId,
          expectedVersion: action.itemVersion,
        },
      },
      {
        onSettled: async () => {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.hubItems.autopilotActions(selectedCompanyId),
          });
        },
      },
    );
  };

  if (legacyInboxHubTarget) {
    return <Navigate to={legacyInboxHubTarget} replace />;
  }

  if (isLegacyInboxNew) {
    return (
      <Navigate
        to={`/inbox/${LANE_TO_SLUG.waiting_on_you}${location.search}`}
        replace
      />
    );
  }

  if (isLegacyInboxAll) {
    return (
      <Navigate
        to={`/inbox/${LANE_TO_SLUG.waiting_on_you}${appendStatus(
          location.search,
          "resolved",
        )}`}
        replace
      />
    );
  }

  if (unknownLane) {
    return <Navigate to="/inbox" replace />;
  }

  return (
    <HubShell
      activeLane={activeLane}
      items={items}
      homeItems={homeItems}
      counts={countsQuery.data ?? { open: 0, unread: 0 }}
      isLoading={
        activeLane
          ? listQuery.isLoading
          : countsQuery.isLoading || homePreviewQuery.isLoading
      }
      error={listQuery.error ?? countsQuery.error ?? homePreviewQuery.error}
      selectedItemId={selectedItemId}
      selectedItem={selectedItem}
      companyId={selectedCompanyId ?? undefined}
      tabs={tabs}
      activeTabKey={activeKey}
      onOpenTab={openTab}
      onOpenItem={handleOpenItem}
      onCloseTab={closeTab}
      onActivateTab={activateTab}
      onAddBrowserTab={handleAddBrowserTab}
      resolveHubItem={resolveHubItem}
      resolveHubItemForTab={resolveHubItemForTab}
      historyStatus={historyStatus}
      auditRows={auditQuery.data ?? []}
      auditLoading={auditQuery.isLoading}
      selectedBulkIds={selectedBulkIds}
      bulkMessage={bulkMessage}
      searchText={searchText}
      hiddenCount={hiddenCount}
      showHidden={hiddenRevealActive}
      onToggleHidden={() => setShowHidden((value) => !value)}
      onUndismiss={handleUndismiss}
      onUnsnooze={handleUnsnooze}
      hasMore={listQuery.hasNextPage}
      isLoadingMore={listQuery.isFetchingNextPage}
      preferences={preferences}
      autopilotPolicy={autopilotPolicyQuery.data ?? DEFAULT_AUTOPILOT_POLICY}
      autopilotActions={autopilotActionsQuery.data ?? DEFAULT_AUTOPILOT_ACTIONS}
      onLaneChange={handleLaneChange}
      onSearchTextChange={setSearchText}
      onLoadMore={handleLoadMore}
      onUndoAutopilotAction={handleUndoAutopilotAction}
      onHistoryStatusChange={handleHistoryStatusChange}
      onSelectItem={handleSelectItem}
      onMarkRead={handleMarkRead}
      onToggleBulkItem={handleToggleBulkItem}
      onBulkAction={(action) => {
        void handleBulkAction(action);
      }}
      onMarkUnread={handleMarkUnread}
      onDismiss={handleDismiss}
      onSnooze={handleSnooze}
      onLifecycleAction={(item, action) => {
        void handleLifecycleAction(item, action);
      }}
      undoAction={
        undoAction
          ? {
              label: undoAction.label,
              onUndo: undoServerAction,
            }
          : null
      }
    />
  );
}

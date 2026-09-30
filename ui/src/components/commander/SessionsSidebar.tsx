import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCompany } from "../../context/CompanyContext";
import { commanderConversationsApi, type ConversationRow } from "../../api/internal-agent";
import { Plus, Search, X, Pin, RotateCcw, PanelLeft, PanelLeftClose, MessageSquare } from "lucide-react";
import { cn } from "../../lib/utils";
import { COMMANDER_PANEL_CARD } from "./commanderChrome";
import { SessionRow } from "./SessionRow";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "../ui/tooltip";
import { useCommanderSessionsCollapsed } from "./useCommanderSessionsCollapsed";

/** Pure exported helper — used by SessionsSidebar and pinned-group filter in Task 6. */
export function filterConversationsByTitle(
  conversations: ConversationRow[],
  query: string,
): ConversationRow[] {
  const trimmed = query.trim();
  if (!trimmed) return conversations;
  const lower = trimmed.toLowerCase();
  return conversations.filter((conv) =>
    (conv.title ?? "").toLowerCase().includes(lower),
  );
}

interface Props {
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  /** Commander desktop: render root as a rounded card (drops its own right border + sidebar bg). Off for the mobile drawer. */
  chrome?: boolean;
  /**
   * Phase 6 [A1]: Optional controlled collapse state lifted from Commander.tsx.
   * When both are provided the component is fully controlled (choreography can
   * collapse sessions from AgentPanelContent). Falls back to the internal
   * useCommanderSessionsCollapsed hook when omitted (mobile drawer, legacy usage).
   */
  collapsed?: boolean;
  onSetCollapsed?: (value: boolean) => void;
}

function groupByDate(conversations: ConversationRow[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 1);
  const weekStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - 7);
  const groups: { label: string; items: ConversationRow[] }[] = [
    { label: "TODAY", items: [] },
    { label: "YESTERDAY", items: [] },
    { label: "THIS WEEK", items: [] },
    { label: "OLDER", items: [] },
  ];
  for (const conv of conversations) {
    const d = new Date(conv.updatedAt);
    if (d >= todayStart) groups[0].items.push(conv);
    else if (d >= yesterdayStart) groups[1].items.push(conv);
    else if (d >= weekStart) groups[2].items.push(conv);
    else groups[3].items.push(conv);
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * Pure cache-update helpers — exported for unit testing.
 * Each takes the current cache data shape and returns the updated shape.
 */
export function applyPinOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
  convId: string,
  pinned: boolean,
): { conversations: ConversationRow[] } {
  const conversations = data?.conversations ?? [];
  return {
    conversations: conversations.map((c) =>
      c.id === convId ? { ...c, pinned } : c,
    ),
  };
}

export function applyRenameOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
  convId: string,
  title: string,
): { conversations: ConversationRow[] } {
  const conversations = data?.conversations ?? [];
  return {
    conversations: conversations.map((c) =>
      c.id === convId ? { ...c, title } : c,
    ),
  };
}

export function applyDeleteOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
  convId: string,
): { conversations: ConversationRow[] } {
  const conversations = data?.conversations ?? [];
  return {
    conversations: conversations.filter((c) => c.id !== convId),
  };
}

export function applyArchiveOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
  convId: string,
): { conversations: ConversationRow[] } {
  const conversations = data?.conversations ?? [];
  return { conversations: conversations.filter((c) => c.id !== convId) };
}

/**
 * Manual-order helpers (Batch 2: session drag reorder).
 *
 * The list is in "manual mode" once ANY conversation has a non-null sortOrder.
 * In manual mode the date groups are replaced by a single flat list ordered by
 * sortOrder. Conversations created since the last reorder (sortOrder null) sort
 * to the TOP by recency, so a brand-new chat is always visible above the
 * arranged list until the next drag locks it in.
 */
export function isManualOrder(conversations: ConversationRow[]): boolean {
  return conversations.some((c) => c.sortOrder != null);
}

export function orderForManual(conversations: ConversationRow[]): ConversationRow[] {
  const ordered = conversations
    .filter((c) => c.sortOrder != null)
    .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number));
  const unordered = conversations
    .filter((c) => c.sortOrder == null)
    .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  return [...unordered, ...ordered];
}

/** Optimistically stamp sortOrder by index for the dragged list. */
export function applyReorderOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
  orderedIds: string[],
): { conversations: ConversationRow[] } {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  const conversations = data?.conversations ?? [];
  return {
    conversations: conversations.map((c) =>
      pos.has(c.id) ? { ...c, sortOrder: pos.get(c.id)! } : c,
    ),
  };
}

/** Optimistically clear all manual ordering (back to date groups). */
export function applyResetOrderOptimistic(
  data: { conversations: ConversationRow[] } | undefined,
): { conversations: ConversationRow[] } {
  const conversations = data?.conversations ?? [];
  return {
    conversations: conversations.map((c) => ({ ...c, sortOrder: null })),
  };
}

/**
 * Sortable wrapper around SessionRow. The wrapper owns the drag ref + pointer
 * listeners; with a distance activation constraint, a plain click still reaches
 * SessionRow's onClick (select), while a >6px drag starts a reorder.
 */
function SortableSessionRow({
  conversation,
  isActive,
  onSelect,
  onPin,
  onRename,
  onArchive,
  onDelete,
}: {
  conversation: ConversationRow;
  isActive: boolean;
  onSelect: () => void;
  onPin: (pinned: boolean) => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: conversation.id });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      className={cn("cursor-grab active:cursor-grabbing", isDragging && "opacity-80")}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // prevent page scroll on Space; prevent dnd-kit drag on Enter
          onSelect();
        }
      }}
    >
      <SessionRow
        conversation={conversation}
        isActive={isActive}
        onSelect={onSelect}
        onPin={onPin}
        onRename={onRename}
        onArchive={onArchive}
        onDelete={onDelete}
      />
    </div>
  );
}

// ─── Rail (collapsed 48px) ───────────────────────────────────────────────────

interface RailProps {
  conversations: ConversationRow[];
  activeConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onExpand: () => void;
  onNewConversation: () => void;
  chrome?: boolean;
}

function SessionsRail({
  conversations,
  activeConversationId,
  onSelect,
  onExpand,
  onNewConversation,
  chrome,
}: RailProps) {
  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex flex-col items-center w-12 shrink-0 h-full",
          chrome
            ? `${COMMANDER_PANEL_CARD} overflow-hidden`
            : "border-r border-border bg-secondary-sidebar",
        )}
        data-testid="commander-sessions-rail"
      >
        {/* Rail header — 42px, expand button centered */}
        <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onExpand}
                title="Expand chats"
                aria-label="Expand chats sidebar"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>Expand chats</TooltipContent>
          </Tooltip>
        </div>

        {/* Divider */}
        <div className="w-6 h-px bg-border my-1 shrink-0" />

        {/* Stacked action icons */}
        <div className="flex flex-col items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onNewConversation}
                aria-label="New chat"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <Plus className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>New chat</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onExpand}
                aria-label="Search sessions"
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <Search className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>Search sessions</TooltipContent>
          </Tooltip>
        </div>

        {/* Divider */}
        <div className="w-6 h-px bg-border my-1 shrink-0" />

        {/* Session icons — scrollable */}
        <div className="flex-1 flex flex-col items-center gap-1 overflow-y-auto overflow-x-hidden min-h-0 w-full px-1.5">
          {conversations.map((conv) => {
            const isActive = conv.id === activeConversationId;
            return (
              <Tooltip key={conv.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelect(conv.id)}
                    aria-label={conv.title ?? "Session"}
                    className={cn(
                      "relative w-7 h-7 flex items-center justify-center rounded-md transition-colors shrink-0",
                      isActive
                        ? "bg-brand/10 text-brand"
                        : "text-very-dim hover:bg-hd hover:text-dim",
                    )}
                  >
                    {isActive && (
                      <span className="absolute left-[-6px] top-[6px] bottom-[6px] w-0.5 rounded-r bg-brand" />
                    )}
                    <MessageSquare className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={6}>
                  {conv.title ?? "Untitled session"}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        {/* Session count */}
        <div className="text-[0.65rem] font-mono text-very-dim shrink-0 pb-1">
          {conversations.length}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SessionsSidebar({
  activeConversationId,
  onSelect,
  onNewConversation,
  chrome = false,
  collapsed: collapsedProp,
  onSetCollapsed,
}: Props) {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();

  // Global-persisted collapse — single key across all conversations (B5).
  // Phase 6 [A1]: when controlled props are provided, use them; otherwise fall
  // back to the internal hook (mobile drawer / legacy usage).
  const [collapsedInternal, setCollapsedInternal] = useCommanderSessionsCollapsed();
  const isControlled = collapsedProp !== undefined && onSetCollapsed !== undefined;
  const collapsed = isControlled ? collapsedProp : collapsedInternal;
  const setCollapsed = isControlled ? onSetCollapsed : setCollapsedInternal;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const queryKey = ["commander-conversations", selectedCompanyId] as const;

  const { data } = useQuery({
    queryKey,
    queryFn: () => commanderConversationsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const archiveMutation = useMutation({
    mutationFn: (convId: string) =>
      commanderConversationsApi.archive(selectedCompanyId!, convId),
    onMutate: async (convId) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyArchiveOptimistic(previous, convId));
      return { previous };
    },
    onError: (_err, _convId, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  const pinMutation = useMutation({
    mutationFn: ({ convId, pinned }: { convId: string; pinned: boolean }) =>
      commanderConversationsApi.pin(selectedCompanyId!, convId, pinned),
    onMutate: async ({ convId, pinned }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyPinOptimistic(previous, convId, pinned));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ convId, title }: { convId: string; title: string }) =>
      commanderConversationsApi.rename(selectedCompanyId!, convId, title),
    onMutate: async ({ convId, title }) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyRenameOptimistic(previous, convId, title));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (convId: string) =>
      commanderConversationsApi.remove(selectedCompanyId!, convId),
    onMutate: async (convId) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyDeleteOptimistic(previous, convId));
      return { previous };
    },
    onError: (_err, _convId, ctx) => {
      if (ctx?.previous !== undefined) {
        qc.setQueryData(queryKey, ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) =>
      commanderConversationsApi.reorder(selectedCompanyId!, orderedIds),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyReorderOptimistic(previous, orderedIds));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  const resetOrderMutation = useMutation({
    mutationFn: () => commanderConversationsApi.resetOrder(selectedCompanyId!),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<{ conversations: ConversationRow[] }>(queryKey);
      qc.setQueryData(queryKey, applyResetOrderOptimistic(previous));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous !== undefined) qc.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["commander-conversations"] });
    },
  });

  // Per-input sensors so touch works too. Mouse: a >6px move starts a drag (a
  // plain click still selects). Touch: a long-press (200ms, <6px wobble) starts
  // a drag — a quick tap selects and a swipe still scrolls the list (rows have
  // touch-action: manipulation, so PointerSensor alone would lose touch-drags
  // to scrolling). Keyboard: space/arrows reorder for a11y.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const conversations = data?.conversations ?? [];
  const filtered = useMemo(
    () => filterConversationsByTitle(conversations, searchQuery),
    [conversations, searchQuery],
  );

  // Manual mode is decided by the full (unfiltered) list so a search that hides
  // ordered rows doesn't flip the view back to date groups.
  const manualMode = useMemo(() => isManualOrder(conversations), [conversations]);

  /**
   * PINNED group: top 5 pinned conversations from the filtered list, sorted by
   * updatedAt descending.
   * pinnedAt not tracked; sort by updatedAt as proxy.
   * Cap at 5 — overflow conversations remain visible in their date groups.
   */
  const pinned = useMemo(
    () =>
      filtered
        .filter((c) => c.pinned)
        .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))
        .slice(0, 5),
    [filtered],
  );

  /**
   * Exclude the displayed-pinned 5 from date groups to avoid duplication.
   * If a user has >5 pinned conversations, the overflow still appears in its
   * date group so no sessions are hidden.
   */
  const pinnedIds = useMemo(() => new Set(pinned.map((c) => c.id)), [pinned]);

  // Non-pinned conversations (the draggable set). Pinned rows live in their own
  // top group and never participate in the drag reorder.
  const nonPinned = useMemo(
    () => filtered.filter((c) => !pinnedIds.has(c.id)),
    [filtered, pinnedIds],
  );

  // Default mode → date groups. Manual mode → one flat list (no headers).
  const groups = useMemo(
    () => (manualMode ? [] : groupByDate(nonPinned)),
    [manualMode, nonPinned],
  );
  const manualList = useMemo(
    () => (manualMode ? orderForManual(nonPinned) : []),
    [manualMode, nonPinned],
  );

  // The SortableContext item array must match the on-screen render order so
  // dnd-kit's index math lines up: flat manual order, or groups concatenated.
  const sortableIds = useMemo(
    () =>
      (manualMode ? manualList : groups.flatMap((g) => g.items)).map((c) => c.id),
    [manualMode, manualList, groups],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = sortableIds.indexOf(active.id as string);
      const newIndex = sortableIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(sortableIds, oldIndex, newIndex);
      reorderMutation.mutate(next);
    },
    [sortableIds, reorderMutation],
  );

  // Auto-focus the input when search opens
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  function handleNewChat() {
    setSearchQuery("");
    setSearchOpen(false);
    onNewConversation();
  }

  const renderSortableRow = (conv: ConversationRow) => (
    <SortableSessionRow
      key={conv.id}
      conversation={conv}
      isActive={conv.id === activeConversationId}
      onSelect={() => onSelect(conv.id)}
      onPin={(p) => pinMutation.mutate({ convId: conv.id, pinned: p })}
      onRename={(title) => renameMutation.mutate({ convId: conv.id, title })}
      onArchive={() => archiveMutation.mutate(conv.id)}
      onDelete={() => deleteMutation.mutate(conv.id)}
    />
  );

  // ── Collapsed → 48px rail ────────────────────────────────────────────────
  if (collapsed) {
    return (
      <SessionsRail
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
        onExpand={() => setCollapsed(false)}
        onNewConversation={handleNewChat}
        chrome={chrome}
      />
    );
  }

  // ── Expanded (224px / w-56) ───────────────────────────────────────────────
  return (
    <div
      className={cn(
        "flex flex-col h-full w-56 shrink-0 transition-[width] duration-200",
        chrome
          ? `${COMMANDER_PANEL_CARD} overflow-hidden`
          : "border-r border-border bg-secondary-sidebar",
      )}
    >
      {/* ── 42px "Chats" header ─────────────────────────────────────────── */}
      <div
        className="h-[42px] flex items-center gap-2 px-3 border-b border-border shrink-0"
        data-testid="commander-sessions-header"
      >
        {/* Online status dot */}
        <span
          className="inline-block w-2 h-2 rounded-full bg-success shrink-0"
          title="Commander online"
          aria-label="Commander online"
        />

        {/* Title */}
        <span className="text-sm font-semibold flex-1 min-w-0 truncate">Chats</span>

        {/* New chat icon button */}
        <button
          type="button"
          onClick={handleNewChat}
          title="New chat"
          aria-label="New chat"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* Search toggle */}
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          title={searchOpen ? "Close search" : "Search sessions"}
          aria-label={searchOpen ? "Close search" : "Search sessions"}
          aria-pressed={searchOpen}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md transition-colors shrink-0",
            searchOpen
              ? "text-foreground bg-muted/70"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}
        >
          <Search className="h-3.5 w-3.5" />
        </button>

        {/* Collapse button */}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse chats"
          aria-label="Collapse chats sidebar"
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
          data-testid="commander-sessions-collapse"
          data-commander-touch
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Search field — drops open below header when active ──────────── */}
      {searchOpen && (
        <div className="px-2.5 py-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-1.5 rounded-md border border-border px-2 h-7 bg-field">
            <Search className="h-3 w-3 text-dim shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => {
                if (!searchQuery.trim()) setSearchOpen(false);
              }}
              placeholder="Search sessions…"
              className="flex-1 min-w-0 bg-transparent text-[0.78rem] text-text placeholder:text-very-dim outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onMouseDown={(e) => {
                  // prevent input blur before we clear
                  e.preventDefault();
                  setSearchQuery("");
                  setSearchOpen(false);
                }}
                className="shrink-0 p-0.5 rounded hover:bg-hd transition-colors"
                title="Clear search"
                aria-label="Clear search"
              >
                <X className="h-3 w-3 text-dim" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Session list ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.length === 0 && (
          <p className="text-xs text-muted-foreground px-3 py-4 text-center">
            {searchQuery.trim() ? "No sessions match" : "No sessions yet"}
          </p>
        )}

        {/* PINNED group — rendered above date groups when any pinned sessions exist */}
        {pinned.length > 0 && (
          <div>
            <div className="px-3 py-1.5 flex items-center gap-1 text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">
              <Pin className="h-2.5 w-2.5 shrink-0" />
              Pinned
            </div>
            {pinned.map((conv) => (
              <SessionRow
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={() => onSelect(conv.id)}
                onPin={(p) => pinMutation.mutate({ convId: conv.id, pinned: p })}
                onRename={(title) => renameMutation.mutate({ convId: conv.id, title })}
                onArchive={() => archiveMutation.mutate(conv.id)}
                onDelete={() => deleteMutation.mutate(conv.id)}
              />
            ))}
          </div>
        )}

        {/* Non-pinned sessions — draggable. Date groups by default; one flat
            "Arranged" list once the user has dragged (manual mode). */}
        {nonPinned.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {manualMode ? (
                <div>
                  <div className="px-3 py-1.5 flex items-center justify-between text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">
                    <span>Arranged</span>
                    <button
                      type="button"
                      onClick={() => resetOrderMutation.mutate()}
                      className="flex items-center gap-1 normal-case tracking-normal text-very-dim hover:text-text transition-colors"
                      title="Reset to most-recent order"
                    >
                      <RotateCcw className="h-2.5 w-2.5" />
                      Reset
                    </button>
                  </div>
                  {manualList.map(renderSortableRow)}
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.label}>
                    <div className="px-3 py-1.5 text-[9px] font-semibold text-muted-foreground uppercase tracking-widest">
                      {group.label}
                    </div>
                    {group.items.map(renderSortableRow)}
                  </div>
                ))
              )}
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

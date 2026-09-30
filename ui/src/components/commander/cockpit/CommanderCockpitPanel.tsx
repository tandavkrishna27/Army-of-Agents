import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  Calendar,
  CheckCircle,
  CheckCircle2,
  ClipboardList,
  DollarSign,
  Inbox,
  FileText,
  LayoutDashboard,
  MessageSquare,
  MessagesSquare,
  MoreVertical,
  PanelRight,
  PanelRightClose,
  Pin,
  Play,
  Settings2,
  StickyNote,
  Users,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CockpitData, CockpitPinnedEntityType, CommanderInputRef, ShowRef } from "@armyofagents/shared";
import { cockpitApi } from "../../../api/cockpit";
import { queryKeys } from "../../../lib/queryKeys";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { ScrollArea } from "../../ui/scroll-area";
import { useCommanderCockpitPrefs } from "../useCommanderCockpitPrefs";
import {
  groupCardsBySection,
  selectVisibleCards,
  selectVisibleSectionGroups,
  type CockpitCardDef,
} from "./cockpitCardModel";
import { CockpitSection } from "../../workspace/cockpit/CockpitSection";
import { CockpitRunningCard } from "./CockpitRunningCard";
import { CockpitReviewCard } from "./CockpitReviewCard";
import { CockpitMyTasksCard } from "./CockpitMyTasksCard";
import { CockpitTodayCard } from "./CockpitTodayCard";
import { CockpitStickyNotesCard } from "./CockpitStickyNotesCard";
import { CockpitInboxCard } from "./CockpitInboxCard";
import { CockpitDiscussionsCard } from "./CockpitDiscussionsCard";
import { CockpitApprovalsCard } from "./CockpitApprovalsCard";
import { CockpitPinnedCard } from "./CockpitPinnedCard";
import { CockpitGoalsAtRiskCard } from "./CockpitGoalsAtRiskCard";
import { CockpitBudgetPulseCard } from "./CockpitBudgetPulseCard";
import { CockpitDoneTodayCard } from "./CockpitDoneTodayCard";
import { CockpitProactiveFindingsCard } from "./CockpitProactiveFindingsCard";
import { CockpitTeammatesActivityCard } from "./CockpitTeammatesActivityCard";
import { CockpitMemoryCard } from "./CockpitMemoryCard";
import { useCockpitPin } from "./useCockpitPin";
import { CockpitConversationZone } from "./CockpitConversationZone";

// ---------------------------------------------------------------------------
// Interaction callbacks type
// ---------------------------------------------------------------------------

export interface CockpitInteractions {
  onOpenTask?: (issueId: string, title: string, anchorId?: string) => void;
  onAsk?: (text: string) => void;
  onReference?: (ref: CommanderInputRef, suggestedPrompt?: string) => void;
  onOpenInputRef?: (ref: CommanderInputRef) => void;
  onOpenFullPage?: (href: string) => void;
  onPin?: (entityType: CockpitPinnedEntityType, entityId: string) => void;
  onUnpin?: (entityType: CockpitPinnedEntityType, entityId: string) => void;
  onOpenArtifact?: (artifactId: string, title: string) => void;
}

// ---------------------------------------------------------------------------
// Empty cockpit data (used while loading / on error)
// ---------------------------------------------------------------------------

const EMPTY_DATA: CockpitData = {
  activeWork: {
    mine: { items: [], total: 0 },
    managed: { items: [], total: 0 },
  },
  awaitingReview: { items: [], total: 0 },
  meta: {
    generatedAt: "",
    partial: false,
    slices: {},
  },
  running: [],
  review: [],
  myTasks: [],
  today: { reminders: [], dueTasks: [] },
  stickyNotes: [],
  inbox: [],
  discussions: [],
  // Phase 3c: approvals required by CockpitData type
  approvals: [],
  // Phase 3d: pinned required by CockpitData type
  pinned: [],
  // Opt-in cards
  goalsAtRisk: [],
  budgetPulse: null,
  doneToday: [],
  proactiveFindings: [],
  teammatesActivity: [],
};

// ---------------------------------------------------------------------------
// Card registry — 12 cards (7 default-on: running/review/myTasks/today/discussions/
// approvals/pinned; 5 opt-in defaultOn:false: goalsAtRisk/budgetPulse/doneToday/
// proactiveFindings/teammatesActivity). The "In this conversation" zone is rendered
// separately (conversation-fed, not a registry card). Cards are PRESENTATIONAL; data
// comes from the shared batched /cockpit query, not per-card fetches.
// ---------------------------------------------------------------------------

export interface CockpitCardRenderDef extends CockpitCardDef {
  /** Lucide icon component shown in the collapsible section trigger. */
  icon: LucideIcon;
  /** Short summary string derived from cockpit data for the section trigger subtitle. */
  summary: (data: CockpitData) => string | null;
  isActive: (data: CockpitData) => boolean;
  /** Phase 3c/3d: companyId threaded through so cards that need per-source API calls
   * (e.g. CockpitApprovalsCard, CockpitPinnedCard) can dispatch correctly without a separate context.
   * Phase 7: conversationId threaded for the Memory card. */
  render: (props: { data: CockpitData; companyId: string; conversationId?: string | null } & CockpitInteractions) => React.ReactElement | null;
}

// ---------------------------------------------------------------------------
// localStorage persistence for per-card collapse state
// ---------------------------------------------------------------------------

function cockpitSectionKey(cardId: string) {
  return `aoa:commander:cockpit:section:${cardId}`;
}

function loadCardExpanded(cardId: string): boolean {
  try {
    const stored = localStorage.getItem(cockpitSectionKey(cardId));
    // Default: expanded (null means never set yet → true)
    return stored !== "false";
  } catch {
    return true;
  }
}

function saveCardExpanded(cardId: string, open: boolean) {
  try {
    localStorage.setItem(cockpitSectionKey(cardId), String(open));
  } catch {
    // Ignore storage failures.
  }
}

export const COCKPIT_REGISTRY: CockpitCardRenderDef[] = [
  // Phase 3d: pinned items — shown near the top so pinned work is always visible
  {
    id: "pinned",
    title: "Pinned",
    defaultOn: true,
    sectionId: "memory_context",
    icon: Pin,
    summary: (d) => d.pinned.length > 0 ? `${d.pinned.length} pinned` : null,
    isActive: (d) => d.pinned.length > 0,
    render: ({ data, onOpenTask, onOpenArtifact, onOpenFullPage, onUnpin }) => (
      <CockpitPinnedCard
        items={data.pinned}
        onOpenTask={onOpenTask}
        onOpenArtifact={onOpenArtifact}
        onOpenFullPage={onOpenFullPage}
        onUnpin={onUnpin}
      />
    ),
  },
  {
    id: "running",
    title: "Running now",
    defaultOn: true,
    sectionId: "watch",
    icon: Play,
    summary: (d) => d.running.length > 0 ? `${d.running.length} running` : null,
    isActive: (d) => d.running.length > 0,
    render: ({ data, onOpenTask, onAsk, onReference }) => (
      <CockpitRunningCard runs={data.running} onOpenTask={onOpenTask} onAsk={onAsk} onReference={onReference} />
    ),
  },
  {
    id: "inbox",
    title: "Inbox",
    defaultOn: true,
    sectionId: "triage",
    icon: Inbox,
    summary: (d) => {
      const unread = d.inbox.filter((item) => item.unread).length;
      if (unread > 0) return `${unread} unread`;
      return d.inbox.length > 0 ? `${d.inbox.length} open` : null;
    },
    isActive: (d) => d.inbox.length > 0,
    render: ({ data, onOpenFullPage, onOpenInputRef, onOpenTask, onAsk, onReference }) => (
      <CockpitInboxCard
        items={data.inbox}
        onOpenFullPage={onOpenFullPage}
        onOpenReference={onOpenInputRef}
        onOpenTask={onOpenTask}
        onAsk={onAsk}
        onReference={onReference}
      />
    ),
  },
  {
    id: "review",
    title: "Awaiting review",
    defaultOn: true,
    sectionId: "triage",
    icon: CheckCircle,
    summary: (d) => {
      const total = d.awaitingReview?.total ?? d.review.length;
      return total > 0 ? `${total} awaiting` : null;
    },
    isActive: (d) => (d.awaitingReview?.total ?? d.review.length) > 0,
    render: ({ data, onOpenTask, onAsk, onPin, onReference, onOpenFullPage }) => (
      <CockpitReviewCard
        items={data.awaitingReview?.items ?? data.review}
        total={data.awaitingReview?.total ?? data.review.length}
        onOpenTask={onOpenTask}
        onAsk={onAsk}
        onPin={onPin}
        onReference={onReference}
        onViewAll={() => onOpenFullPage?.("/issues?cockpitBucket=awaiting_review")}
      />
    ),
  },
  {
    id: "myTasks",
    title: "Active work",
    defaultOn: true,
    sectionId: "my_work",
    icon: ClipboardList,
    summary: (d) => {
      const total = d.activeWork
        ? d.activeWork.mine.total + d.activeWork.managed.total
        : d.myTasks.length;
      return total > 0 ? `${total} active` : null;
    },
    isActive: (d) => d.activeWork
      ? d.activeWork.mine.total + d.activeWork.managed.total > 0
      : d.myTasks.length > 0,
    render: ({ data, onOpenTask, onAsk, onPin, onReference, onOpenFullPage }) => (
      <CockpitMyTasksCard
        items={data.myTasks}
        activeWork={data.activeWork}
        onOpenTask={onOpenTask}
        onAsk={onAsk}
        onPin={onPin}
        onReference={onReference}
        onViewAll={(bucket) => onOpenFullPage?.(`/issues?cockpitBucket=${bucket}`)}
      />
    ),
  },
  {
    id: "today",
    title: "Today",
    defaultOn: true,
    sectionId: "my_work",
    icon: Calendar,
    summary: (d) => {
      const total = d.today.reminders.length + d.today.dueTasks.length;
      return total > 0 ? `${total} items` : null;
    },
    isActive: (d) => d.today.reminders.length > 0 || d.today.dueTasks.length > 0,
    render: ({ data, onOpenTask, onAsk, onPin, onReference }) => (
      <CockpitTodayCard
        reminders={data.today.reminders}
        dueTasks={data.today.dueTasks}
        onOpenTask={onOpenTask}
        onAsk={onAsk}
        onPin={onPin}
        onReference={onReference}
      />
    ),
  },
  {
    id: "stickyNotes",
    title: "Sticky notes",
    defaultOn: true,
    sectionId: "my_work",
    icon: StickyNote,
    summary: (d) => d.stickyNotes.length > 0 ? `${d.stickyNotes.length} notes` : null,
    isActive: (_d) => true,
    render: ({ data, companyId, onAsk, onReference }) => (
      <CockpitStickyNotesCard
        companyId={companyId}
        items={data.stickyNotes}
        onAsk={onAsk}
        onReference={onReference}
      />
    ),
  },
  {
    id: "discussions",
    title: "Discussions",
    defaultOn: true,
    sectionId: "conversations",
    icon: MessageSquare,
    summary: (d) => d.discussions.length > 0 ? `${d.discussions.length} active` : null,
    isActive: (d) => d.discussions.length > 0,
    render: ({ data, onOpenFullPage, onOpenInputRef, onAsk, onReference }) => (
      <CockpitDiscussionsCard
        items={data.discussions}
        onOpenFullPage={onOpenFullPage}
        onOpenReference={onOpenInputRef}
        onAsk={onAsk}
        onReference={onReference}
      />
    ),
  },
  // Phase 3c: unified approvals queue (founder-only; server returns [] for non-founders)
  {
    id: "approvals",
    title: "Approvals",
    defaultOn: true,
    sectionId: "triage",
    icon: CheckCircle2,
    summary: (d) => d.approvals.length > 0 ? `${d.approvals.length} pending` : null,
    isActive: (d) => d.approvals.length > 0,
    render: ({ data, companyId, onOpenFullPage, onOpenInputRef, onAsk, onReference }) => (
      <CockpitApprovalsCard
        items={data.approvals}
        companyId={companyId}
        onOpenFullPage={onOpenFullPage}
        onOpenReference={onOpenInputRef}
        onAsk={onAsk}
        onReference={onReference}
      />
    ),
  },
  // ── Opt-in cards (defaultOn: false) ─────────────────────────────────────
  {
    id: "goalsAtRisk",
    title: "Goals at risk",
    defaultOn: false,
    sectionId: "watch",
    icon: AlertTriangle,
    summary: (d) => d.goalsAtRisk.length > 0 ? `${d.goalsAtRisk.length} at risk` : null,
    isActive: (d) => d.goalsAtRisk.length > 0,
    render: ({ data, onOpenFullPage }) => (
      <CockpitGoalsAtRiskCard items={data.goalsAtRisk} onOpenFullPage={onOpenFullPage} />
    ),
  },
  {
    id: "budgetPulse",
    title: "Budget pulse",
    defaultOn: false,
    sectionId: "watch",
    icon: DollarSign,
    summary: (d) => d.budgetPulse !== null ? `${Math.round(d.budgetPulse.percentUsed)}% used` : null,
    isActive: (d) => d.budgetPulse !== null,
    render: ({ data }) => <CockpitBudgetPulseCard pulse={data.budgetPulse} />,
  },
  {
    id: "doneToday",
    title: "Done today",
    defaultOn: false,
    sectionId: "watch",
    icon: CheckCircle2,
    summary: (d) => d.doneToday.length > 0 ? `${d.doneToday.length} completed` : null,
    isActive: (d) => d.doneToday.length > 0,
    render: ({ data, onOpenTask }) => (
      <CockpitDoneTodayCard items={data.doneToday} onOpenTask={onOpenTask} />
    ),
  },
  {
    id: "proactiveFindings",
    title: "Proactive findings",
    defaultOn: false,
    sectionId: "watch",
    icon: Zap,
    summary: (d) => d.proactiveFindings.length > 0 ? `${d.proactiveFindings.length} findings` : null,
    isActive: (d) => d.proactiveFindings.length > 0,
    render: ({ data, onOpenFullPage, onOpenTask, onAsk }) => (
      <CockpitProactiveFindingsCard
        items={data.proactiveFindings}
        onOpenFullPage={onOpenFullPage}
        onOpenTask={onOpenTask}
        onAsk={onAsk}
      />
    ),
  },
  {
    id: "teammatesActivity",
    title: "Teammates' activity",
    defaultOn: false,
    sectionId: "watch",
    icon: Users,
    summary: (d) => d.teammatesActivity.length > 0 ? `${d.teammatesActivity.length} updates` : null,
    isActive: (d) => d.teammatesActivity.length > 0,
    render: ({ data, onOpenFullPage, onOpenTask }) => (
      <CockpitTeammatesActivityCard
        items={data.teammatesActivity}
        onOpenFullPage={onOpenFullPage}
        onOpenTask={onOpenTask}
      />
    ),
  },
  // Phase 7: Memory cockpit card — defaultOn:false (opt-in, audit surface).
  // Enable via the cockpit config popover (Settings2 icon in the header).
  // Shows memory_retrievals for the active Commander conversation so founders
  // can see exactly what the model looked up. isActive is always true when
  // there is a conversation (the card self-manages empty state).
  {
    id: "memory",
    title: "Memory",
    defaultOn: false,
    sectionId: "memory_context",
    icon: Brain,
    summary: (_d) => null, // row count is fetched inside the card, not from cockpit batch
    isActive: (_d) => true, // always mount; card shows empty state when no conversation
    render: ({ companyId, conversationId }) => (
      <CockpitMemoryCard
        companyId={companyId}
        conversationId={conversationId}
      />
    ),
  },
];

// ---------------------------------------------------------------------------
// Config popover — show/hide cards
// ---------------------------------------------------------------------------

function CockpitConfigPopover({
  prefs,
  setPrefs,
  registry,
}: {
  prefs: ReturnType<typeof useCommanderCockpitPrefs>[0];
  setPrefs: ReturnType<typeof useCommanderCockpitPrefs>[1];
  registry: CockpitCardDef[];
}) {
  const groupedCards = groupCardsBySection(registry);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Configure cockpit cards"
          title="Configure cockpit cards"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <Settings2 className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-2">
        <p className="mb-1.5 px-1 text-[11px] font-medium text-muted-foreground">Show cards</p>
        {groupedCards.map((group) => (
          <div
            key={group.section.id}
            className="space-y-0.5"
            data-testid={`cockpit-config-group-${group.section.id}`}
          >
            <p className="mb-1 mt-2 px-1 text-[11px] font-medium text-muted-foreground">
              {group.section.title}
            </p>
            {group.cards.map((card) => {
              const isDefault = card.defaultOn;
              const isHidden = prefs.hidden.includes(card.id);
              const isEnabled = prefs.enabled.includes(card.id);
              const checked = isDefault ? !isHidden : isEnabled;

              return (
                <label
                  key={card.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-xs hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    className="accent-brand"
                    checked={checked}
                    onChange={() => {
                      if (isDefault) {
                        const nextHidden = isHidden
                          ? prefs.hidden.filter((id) => id !== card.id)
                          : [...prefs.hidden, card.id];
                        setPrefs({ ...prefs, hidden: nextHidden });
                        return;
                      }

                      const nextEnabled = isEnabled
                        ? prefs.enabled.filter((id) => id !== card.id)
                        : [...prefs.enabled, card.id];
                      setPrefs({ ...prefs, enabled: nextEnabled });
                    }}
                  />
                  {card.title}
                </label>
              );
            })}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Full panel (expanded state)
// ---------------------------------------------------------------------------

export function CommanderCockpitPanel({
  companyId,
  conversationId,
  collapsed = false,
  onExpand,
  onCollapse,
  onOpenTask,
  onAsk,
  onReference,
  onOpenInputRef,
  onOpenFullPage,
  onOpenArtifact,
  conversationRefs = [],
  onOpenRef,
}: {
  companyId: string;
  /** Phase 7: active Commander conversation id for the Memory cockpit card. */
  conversationId?: string | null;
  /** When true the panel renders its 48px rail (with one icon per active card). */
  collapsed?: boolean;
  /** Expand from the rail. */
  onExpand?: () => void;
  onCollapse: () => void;
  conversationRefs?: ShowRef[];
  onOpenRef?: (ref: ShowRef) => void;
} & CockpitInteractions) {
  const [prefs, setPrefs] = useCommanderCockpitPrefs();

  // Phase 3d: panel owns the pin/unpin hook so cards remain presentational.
  const { pin, unpin } = useCockpitPin(companyId);

  // ONE batched query. LiveEvents (LiveUpdatesProvider) invalidate this key for
  // instant updates; the modest refetchInterval is a belt-and-suspenders fallback
  // for heartbeat/crew runs between events.
  const fullQuery = useQuery({
    queryKey: queryKeys.cockpit(companyId),
    queryFn: () => cockpitApi.get(companyId),
    enabled: !!companyId && !collapsed,
    refetchInterval: 8000,
  });
  const countsQuery = useQuery({
    queryKey: queryKeys.cockpitCounts(companyId),
    queryFn: () => cockpitApi.counts(companyId),
    enabled: !!companyId && collapsed,
    refetchInterval: 8000,
  });
  const { data, isLoading, isError, error, refetch } = fullQuery;

  const cockpitData = data ?? EMPTY_DATA;

  // Active map derived from the registry's own isActive predicates — single source of
  // truth (also feeds the card-render gate), so no separate hardcoded map to drift.
  const active = Object.fromEntries(
    COCKPIT_REGISTRY.map((c) => [c.id, c.isActive(cockpitData)]),
  );
  if (collapsed && countsQuery.data) {
    active.running = countsQuery.data.running > 0;
    active.inbox = countsQuery.data.inbox > 0;
    active.review = countsQuery.data.awaitingReview > 0;
    active.myTasks = countsQuery.data.activeWorkMine + countsQuery.data.activeWorkManaged > 0;
    active.approvals = countsQuery.data.approvals > 0;
    active.discussions = countsQuery.data.discussions > 0;
  }

  const visible = selectVisibleCards({
    registry: COCKPIT_REGISTRY,
    hidden: prefs.hidden,
    order: prefs.order,
    active,
    enabled: prefs.enabled,
  });
  const visibleGroups = selectVisibleSectionGroups({
    registry: COCKPIT_REGISTRY,
    hidden: prefs.hidden,
    order: prefs.order,
    active,
    enabled: prefs.enabled,
  });

  // Per-card collapse state — default: all expanded (no max cap for commander cockpit).
  const [cardExpanded, setCardExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const card of COCKPIT_REGISTRY) {
      initial[card.id] = loadCardExpanded(card.id);
    }
    // Always default true for conversation zone too.
    initial["conversation"] = loadCardExpanded("conversation");
    return initial;
  });

  const setCardOpen = useCallback((id: string, open: boolean) => {
    setCardExpanded((prev) => {
      if (prev[id] === open) return prev;
      saveCardExpanded(id, open);
      return { ...prev, [id]: open };
    });
  }, []);

  // Collapsed → render the 48px rail with one icon per ACTIVE card. The rail needs
  // the active-card list, which only the panel can compute (it owns the cockpit
  // query). So the panel renders its own rail rather than a data-less sibling —
  // mirrors WorkspaceRightPanel, which owns both expanded + collapsed states.
  // (Early return is after all hooks above — Rules of Hooks safe.)
  if (collapsed) {
    return (
      <CommanderCockpitRail
        badge={visible.length}
        onExpand={onExpand ?? (() => {})}
        activeCards={visible}
        onExpandAndShowCard={(id) => {
          setCardOpen(id, true);
          onExpand?.();
        }}
      />
    );
  }

  return (
    <div
      data-testid="commander-cockpit-panel"
      className="relative flex h-full min-w-0 flex-1 flex-col"
    >
      {/* Phase 5A: 42px header — PanelRightClose (left) + title + Config + MoreVertical (right) */}
      <header
        className="flex h-[42px] shrink-0 items-center gap-1 border-b border-border px-2"
        data-testid="commander-cockpit-header"
      >
        <button
          type="button"
          aria-label="Collapse cockpit"
          title="Collapse cockpit"
          onClick={onCollapse}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate pl-1 text-xs font-semibold text-foreground">
          Cockpit
        </span>
        <div className="flex items-center gap-0.5">
          <CockpitConfigPopover prefs={prefs} setPrefs={setPrefs} registry={COCKPIT_REGISTRY} />
          <button
            type="button"
            aria-label="Cockpit menu"
            title="Cockpit menu"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <MoreVertical className="size-4" aria-hidden />
          </button>
        </div>
      </header>

      <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="commander-cockpit-scroll">
        <div className="w-full min-w-0 space-y-2 overflow-hidden px-2 py-2">
          {isLoading && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground" role="status">
              Loading cockpit...
            </div>
          )}

          {isError && (
            <div className="space-y-2 rounded border border-destructive/30 px-2 py-3 text-xs" role="alert">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{error instanceof Error ? error.message : "Cockpit data could not be loaded."}</span>
              </div>
              <button
                type="button"
                className="text-xs font-medium text-foreground hover:underline"
                onClick={() => void refetch()}
              >
                Try again
              </button>
            </div>
          )}

          {!isLoading && !isError && cockpitData.meta?.partial && (
            <div className="flex items-start gap-2 rounded border border-amber-500/30 px-2 py-2 text-xs text-muted-foreground" role="status">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
              <span>Some cockpit sections are temporarily unavailable.</span>
            </div>
          )}

          {/* Phase 5C: Conversation zone — NOT a registry card; gets its own CockpitSection [B4] */}
          {!isLoading && !isError && conversationRefs.length > 0 && (
            <CockpitSection
              id="conversation"
              title="In this conversation"
              summary={`${conversationRefs.length} ref${conversationRefs.length === 1 ? "" : "s"}`}
              icon={MessagesSquare}
              open={cardExpanded["conversation"] ?? true}
              onOpenChange={(open) => setCardOpen("conversation", open)}
            >
              <ConversationZoneBody refs={conversationRefs} onOpen={onOpenRef} />
            </CockpitSection>
          )}

          {/* Phase 1: Product groups around existing cards; cards stay collapsible. */}
          {!isLoading && !isError && visibleGroups.map((group) => (
            <section
              key={group.section.id}
              data-testid={`cockpit-group-${group.section.id}`}
              className="space-y-1.5"
            >
              <div className="px-1 pt-1 text-[11px] font-semibold uppercase tracking-normal text-muted-foreground">
                {group.section.title}
              </div>
              <div className="space-y-2">
                {group.cards.map((c) => (
                  <CockpitSection
                    key={c.id}
                    id={c.id}
                    title={c.title}
                    summary={c.summary(cockpitData)}
                    icon={c.icon}
                    open={cardExpanded[c.id] ?? true}
                    onOpenChange={(open) => setCardOpen(c.id, open)}
                  >
                    {/* Phase 3c/3d: companyId + pin/unpin/artifact callbacks threaded through.
                        Phase 7: conversationId for the Memory card. */}
                    {c.render({
                      data: cockpitData,
                      companyId,
                      conversationId,
                      onOpenTask,
                      onAsk,
                      onReference,
                      onOpenInputRef,
                      onOpenFullPage,
                      onOpenArtifact,
                      onPin: (entityType, entityId) => pin.mutate({ entityType, entityId }),
                      onUnpin: (entityType, entityId) => unpin.mutate({ entityType, entityId }),
                    })}
                  </CockpitSection>
                ))}
              </div>
            </section>
          ))}

          {!isLoading && !isError && visible.length === 0 && conversationRefs.length === 0 && (
            <div className="flex items-center justify-center p-6 text-center text-xs text-muted-foreground">
              All clear — nothing needs you right now.
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation zone body — rendered inside the CockpitSection content area.
// Strips the internal <header> (title+count now live in the CockpitSection trigger).
// ---------------------------------------------------------------------------

function ConversationZoneBody({
  refs,
  onOpen,
}: {
  refs: ShowRef[];
  onOpen?: (ref: ShowRef) => void;
}) {
  return (
    <ul className="space-y-0.5" data-testid="cockpit-zone-conversation">
      {refs.map((r) => {
        const title = r.title ?? `Artifact ${r.id.slice(0, 8)}`;
        return (
          <li
            key={`${r.id}:${r.versionId ?? "latest"}`}
            className="group flex items-center gap-1 truncate rounded px-1 py-1 text-xs hover:bg-muted/50"
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left"
              onClick={() => onOpen?.(r)}
            >
              <FileText className="mr-1 inline size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate font-medium">{title}</span>
            </button>
            {r.action === "created" && (
              <span className="shrink-0 text-[10px] text-muted-foreground">created</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Semi-rail (collapsed state) — 48px wide, mirroring WorkspaceRightPanel
// ---------------------------------------------------------------------------

export function CommanderCockpitRail({
  badge,
  onExpand,
  activeCards = [],
  onExpandAndShowCard,
}: {
  badge: number;
  onExpand: () => void;
  /** Active card ids in display order — one stacked icon per card. */
  activeCards?: CockpitCardRenderDef[];
  /** Click a card icon → expand cockpit and (optionally) scroll to that card. */
  onExpandAndShowCard?: (cardId: string) => void;
}) {
  return (
    <div
      data-testid="commander-cockpit-rail"
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1"
    >
      {/* 42px header: expand button */}
      <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
        <button
          type="button"
          aria-label="Expand cockpit"
          title="Expand cockpit"
          onClick={onExpand}
          className="relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        >
          <PanelRight className="size-4" aria-hidden />
          {badge > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
              {badge}
            </span>
          )}
        </button>
      </div>

      {/* Divider + stacked card icons */}
      <div className="my-0.5 h-px w-6 bg-border" />
      <div className="flex flex-col items-center gap-1 py-1">
        {activeCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              title={card.title}
              aria-label={card.title}
              onClick={() => {
                onExpandAndShowCard?.(card.id);
                onExpand();
              }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              data-testid={`commander-rail-card-${card.id}`}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

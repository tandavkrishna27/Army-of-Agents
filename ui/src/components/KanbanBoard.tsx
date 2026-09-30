import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@/lib/router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Identity } from "./Identity";
import { AgentAvatar } from "./threads/AgentAvatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Link2,
  MessageSquare,
  Clock,
  Target,
  FileText,
  type LucideIcon,
} from "lucide-react";
import type { Issue } from "@armyofagents/shared";

const boardStatuses = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Agent {
  id: string;
  name: string;
}

/**
 * Per-issue live-run detail for the "Live" pill (thread-chat-experience Task
 * 5.5/5.7). When supplied, the pill renders "{agentName} · {elapsed}" instead of
 * the bare "Live" — surfaced from `liveRunsForCompany`, which now includes crew
 * (internal_agent) runs with { agentName, startedAt }. Optional: callers that
 * only pass `liveIssueIds` keep the plain "Live" pill.
 */
export interface LiveRunInfo {
  agentName?: string | null;
  /** ISO timestamp (or Date) the run started; the elapsed anchor. */
  startedAt?: string | Date | null;
}

/**
 * Card chrome variant (unified-crew-board design 2026-06-02, T-D).
 *   `standard` — the main Tasks board + department/project boards. Footer is
 *                PriorityIcon + the bare assignee name (the pre-enrichment look
 *                from 74d603770^). NO owner avatar, source badge, or artifact
 *                chip.
 *   `crew`     — the Crew Board only. Footer is the enriched meta row (owner
 *                avatar 🤖/👤, clickable source-lineage badge, artifact chip).
 * The live pill + blocked chip predate the enrichment and render in BOTH.
 */
export type KanbanCardVariant = "standard" | "crew";

interface KanbanBoardProps {
  issues: Issue[];
  agents?: Agent[];
  /** Card chrome. Defaults to "standard" — only the Crew Board opts into "crew". */
  cardVariant?: KanbanCardVariant;
  liveIssueIds?: Set<string>;
  /** Optional richer live-run info per issue id for the "Live" pill. */
  liveRunsByIssue?: Map<string, LiveRunInfo>;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
  onSelectIssue?: (issueIdentifier: string) => void;
}

/** Compact elapsed label from a start time, e.g. "0:42", "3:05", "1h12m". */
function formatElapsed(startedAt: string | Date | null | undefined, nowMs: number): string | null {
  if (!startedAt) return null;
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt.getTime();
  if (!Number.isFinite(start)) return null;
  const secs = Math.max(0, Math.floor((nowMs - start) / 1000));
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h${m.toString().padStart(2, "0")}m`;
}

/**
 * The animated "Live" pill (Task 5.5/5.7). Owns its OWN 1 Hz ticker so the
 * per-second elapsed update re-renders only this element — not the whole board.
 * Only live cards mount a `LivePill`, so non-live cards never re-render on the
 * clock. The ticker stops when the start time is absent (bare "Live"), so a
 * label without an elapsed counter costs no timer.
 */
function LivePill({ liveRun }: { liveRun?: LiveRunInfo }) {
  const startedAt = liveRun?.startedAt ?? null;
  const name = liveRun?.agentName ?? null;
  // Tick a 1s clock only while we actually have an elapsed anchor to advance.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const elapsed = formatElapsed(startedAt, nowMs);
  const label = name && elapsed ? `${name} · ${elapsed}` : name ? name : "Live";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 shrink-0 ml-auto max-w-[160px]"
      title={name && elapsed ? `${name} · running ${elapsed}` : "Live run in progress"}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400 truncate">
        {label}
      </span>
    </span>
  );
}

/* ── Source badge (lineage) ── */

/**
 * The lineage descriptor rendered as the card's "source" pill — the most
 * important new meta element. Computed purely from existing `issues` columns
 * (no new backend data; see unified-crew-board design 2026-06-02).
 *
 *   `href`   — when set, the badge navigates to the origin on click
 *              (discussion / goal); `null` for context-free origins (direct,
 *              or a routine without a navigable id) which render non-clickable.
 *   `strong` — direct/context-free tasks are the exception: they render as a
 *              faint "· direct" with no chip chrome (`strong = false`).
 */
interface SourceBadge {
  icon: LucideIcon;
  label: string;
  title: string;
  href: string | null;
  strong: boolean;
}

/** Truncate a source title to keep the pill compact (≈18 chars + ellipsis). */
function truncateSource(text: string, max = 18): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * `originKind` is a free-text `issues` column (e.g. "crew_thread",
 * "routine_execution") that is NOT yet surfaced on the shared `Issue` type —
 * only `sourceDiscussionId` / `sourceThreadTitle` are. Read it defensively so
 * the badge still works whether or not the field is present on a given row.
 */
function issueOriginKind(issue: Issue): string | null {
  const v = (issue as { originKind?: unknown }).originKind;
  return typeof v === "string" ? v : null;
}

/**
 * Derive the source badge from an issue, degrading gracefully when richer data
 * (e.g. `sourceThreadTitle`, which only the Crew Board query populates) is
 * absent. Priority: thread title › routine › goal › discussion (no title) ›
 * direct. Returns `null` only when there is genuinely nothing to show — but in
 * practice every task resolves to at least the faint "· direct" fallback.
 */
function deriveSourceBadge(issue: Issue): SourceBadge | null {
  const originKind = issueOriginKind(issue);

  // 1. Discussion with a known title — the richest lineage signal.
  if (issue.sourceThreadTitle) {
    return {
      icon: MessageSquare,
      label: truncateSource(issue.sourceThreadTitle),
      title: `From discussion: ${issue.sourceThreadTitle}`,
      href: issue.sourceDiscussionId ? `/discussions/${issue.sourceDiscussionId}` : null,
      strong: true,
    };
  }

  // 2. Routine-fired task.
  if (originKind === "routine_execution") {
    return {
      icon: Clock,
      label: "routine",
      title: "Created by a routine",
      href: null,
      strong: true,
    };
  }

  // 3. Goal-scoped task.
  if (issue.goalId) {
    return {
      icon: Target,
      label: "goal",
      title: "Serves a goal",
      href: `/goals/${issue.goalId}`,
      strong: true,
    };
  }

  // 4. Crew thread without a denormalized title (e.g. main Tasks board, which
  //    doesn't run the JOIN) — still link to the discussion if we have its id.
  if (originKind === "crew_thread" || issue.sourceDiscussionId) {
    return {
      icon: MessageSquare,
      label: "discussion",
      title: "From a discussion",
      href: issue.sourceDiscussionId ? `/discussions/${issue.sourceDiscussionId}` : null,
      strong: true,
    };
  }

  // 5. Direct / quick-capture — the exception; faint, no strong chip.
  return {
    icon: MessageSquare,
    label: "direct",
    title: "Created directly",
    href: null,
    strong: false,
  };
}

/* ── Droppable Column ── */

function KanbanColumn({
  status,
  issues,
  agents,
  cardVariant,
  liveIssueIds,
  liveRunsByIssue,
  onSelectIssue,
}: {
  status: string;
  issues: Issue[];
  agents?: Agent[];
  cardVariant: KanbanCardVariant;
  liveIssueIds?: Set<string>;
  liveRunsByIssue?: Map<string, LiveRunInfo>;
  onSelectIssue?: (issueIdentifier: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div data-testid={`kanban-column-${status}`} className="flex flex-col min-w-[260px] w-[260px] shrink-0">
      <div className="flex items-center gap-2 px-2 py-2 mb-1">
        <StatusIcon status={status} />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {statusLabel(status)}
        </span>
        <span className="text-xs text-muted-foreground/60 ml-auto tabular-nums">
          {issues.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex-1 min-h-[120px] rounded-md p-1 space-y-1 transition-colors ${
          isOver ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        <SortableContext
          items={issues.map((i) => i.id)}
          strategy={verticalListSortingStrategy}
        >
          {issues.map((issue) => (
            <KanbanCard
              key={issue.id}
              issue={issue}
              agents={agents}
              cardVariant={cardVariant}
              isLive={liveIssueIds?.has(issue.id)}
              liveRun={liveRunsByIssue?.get(issue.id)}
              onSelectIssue={onSelectIssue}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}

/* ── Card meta row (owner · source · artifact) ── */

/**
 * The source-badge pill. When `badge.href` is set it navigates to the origin
 * on click — and crucially stops the event from bubbling to the card's outer
 * `Link`/`onSelectIssue`, so clicking the lineage jumps to the thread/goal
 * instead of opening the task slide-over. Rendered as a `<span role="link">`
 * (not an `<a>`) because it lives inside the card's outer anchor and nesting
 * `<a>` in `<a>` is invalid HTML.
 */
function SourceBadgeChip({ badge }: { badge: SourceBadge }) {
  const navigate = useNavigate();
  const Icon = badge.icon;
  const clickable = badge.href !== null;

  // Faint, chip-less treatment for direct/context-free tasks (the exception).
  if (!badge.strong) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50 min-w-0"
        title={badge.title}
      >
        <Icon className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{badge.label}</span>
      </span>
    );
  }

  const onActivate = (e: React.MouseEvent | React.KeyboardEvent) => {
    if (!badge.href) return;
    // Do NOT also open the card slide-over / navigate the outer Link.
    e.stopPropagation();
    e.preventDefault();
    navigate(badge.href);
  };

  return (
    <span
      role={clickable ? "link" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onActivate : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(e);
            }
          : undefined
      }
      title={badge.title}
      className={`inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground min-w-0 max-w-[140px] ${
        clickable
          ? "cursor-pointer transition-colors hover:bg-muted hover:text-foreground"
          : ""
      }`}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{badge.label}</span>
    </span>
  );
}

/**
 * Bottom meta row: priority · owner (🤖 agent avatar / 👤 person initials) ·
 * source lineage badge · artifact chip. Every element degrades gracefully when
 * its backing column is absent — no empty/broken chips are ever rendered.
 */
function CardMetaRow({
  issue,
  agentName,
}: {
  issue: Issue;
  agentName: (id: string | null) => string | null;
}) {
  const badge = deriveSourceBadge(issue);
  const ownerAgentName = issue.assigneeAgentId ? agentName(issue.assigneeAgentId) : null;
  const showAgentOwner = Boolean(issue.assigneeAgentId);
  const showHumanOwner = !issue.assigneeAgentId && Boolean(issue.assigneeUserId);

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <PriorityIcon priority={issue.priority} />

      {/* Owner — 🤖 agent vs 👤 person reads at a glance via distinct avatars. */}
      {showAgentOwner && (
        <span className="inline-flex items-center gap-1 min-w-0 max-w-[120px]">
          <AgentAvatar name={ownerAgentName ?? "Agent"} size={18} />
          {ownerAgentName ? (
            <span
              className="text-[11px] text-muted-foreground truncate"
              data-testid="kanban-card-owner-name"
            >
              {ownerAgentName}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/70 font-mono truncate">
              {issue.assigneeAgentId!.slice(0, 8)}
            </span>
          )}
        </span>
      )}
      {showHumanOwner && (
        <Identity name={issue.assigneeUserId!} size="xs" />
      )}

      {/* Source lineage + artifact pushed to the right edge. */}
      <span className="flex items-center gap-1.5 ml-auto min-w-0">
        {badge && <SourceBadgeChip badge={badge} />}
        {issue.artifactId && (
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
            title="This task produced a deliverable"
            data-testid="kanban-artifact-chip"
          >
            <FileText className="h-2.5 w-2.5 shrink-0" />
          </span>
        )}
      </span>
    </div>
  );
}

/* ── Standard card footer (pre-enrichment) ── */

/**
 * The original, un-enriched footer used by the main Tasks board and
 * department/project boards (`cardVariant="standard"`). This is an EXACT
 * reproduction of the footer that shipped before commit 74d603770 — just
 * PriorityIcon + the bare assignee name (Identity, size "xs"), with the
 * id-prefix fallback when the agent name isn't resolved. No owner avatar,
 * source-lineage badge, or artifact chip — those are crew-only.
 */
function StandardCardFooter({
  issue,
  agentName,
}: {
  issue: Issue;
  agentName: (id: string | null) => string | null;
}) {
  return (
    <div className="flex items-center gap-2">
      <PriorityIcon priority={issue.priority} />
      {issue.assigneeAgentId && (() => {
        const name = agentName(issue.assigneeAgentId);
        return name ? (
          <Identity name={name} size="xs" />
        ) : (
          <span className="text-xs text-muted-foreground font-mono">
            {issue.assigneeAgentId.slice(0, 8)}
          </span>
        );
      })()}
    </div>
  );
}

/* ── Draggable Card ── */

function KanbanCard({
  issue,
  agents,
  cardVariant = "standard",
  isLive,
  liveRun,
  isOverlay,
  onSelectIssue,
}: {
  issue: Issue;
  agents?: Agent[];
  cardVariant?: KanbanCardVariant;
  isLive?: boolean;
  liveRun?: LiveRunInfo;
  isOverlay?: boolean;
  onSelectIssue?: (issueIdentifier: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: issue.id, data: { issue } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`kanban-card-${issue.id}`}
      {...attributes}
      {...listeners}
      className={`kanban-card-hover rounded-md border bg-card p-2.5 cursor-grab active:cursor-grabbing transition-all duration-150 ${
        isDragging && !isOverlay ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : ""}`}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="block no-underline text-inherit"
        onClick={(e) => {
          // Prevent navigation during drag
          if (isDragging) { e.preventDefault(); return; }
          if (onSelectIssue) {
            e.preventDefault();
            onSelectIssue(issue.identifier ?? issue.id);
          }
        }}
      >
        <div className="flex items-start gap-1.5 mb-1.5">
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {/* Task 5.5/5.7: the live pill owns its own 1 Hz ticker (LivePill) so
              only this element re-renders per second — not the whole board. */}
          {isLive && <LivePill liveRun={liveRun} />}
          {issue.status === "blocked" && !isLive && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 shrink-0 ml-auto">
                    <Link2 className="h-3 w-3" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  Blocked by dependencies
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <p className="text-sm leading-snug line-clamp-2 mb-1">{issue.title}</p>
        {issue.description && (
          <p className="text-xs text-muted-foreground/70 line-clamp-2 mb-1.5 leading-relaxed">
            {issue.description.split("\n")[0].slice(0, 140)}
          </p>
        )}
        {/* Labels */}
        {(issue.labels ?? []).length > 0 && (
          <div className="flex items-center gap-1 flex-wrap mb-1.5">
            {(issue.labels ?? []).slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center rounded-full border px-1.5 py-0 text-[9px] font-medium leading-4"
                style={{
                  borderColor: label.color,
                  color: label.color,
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </span>
            ))}
            {(issue.labels ?? []).length > 3 && (
              <span className="text-[9px] text-muted-foreground">+{(issue.labels ?? []).length - 3}</span>
            )}
          </div>
        )}
        {cardVariant === "crew" ? (
          <CardMetaRow issue={issue} agentName={agentName} />
        ) : (
          <StandardCardFooter issue={issue} agentName={agentName} />
        )}
      </Link>
    </div>
  );
}

/* ── Main Board ── */

export function KanbanBoard({
  issues,
  agents,
  cardVariant = "standard",
  liveIssueIds,
  liveRunsByIssue,
  onUpdateIssue,
  onSelectIssue,
}: KanbanBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  // Note: the live pill's 1 Hz elapsed counter is owned per-card by `LivePill`,
  // so the board no longer holds a board-wide clock — only live cards tick, and
  // only their pill element re-renders each second (not the whole board).

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const columnIssues = useMemo(() => {
    const grouped: Record<string, Issue[]> = {};
    for (const status of boardStatuses) {
      grouped[status] = [];
    }
    for (const issue of issues) {
      if (grouped[issue.status]) {
        grouped[issue.status].push(issue);
      }
    }
    return grouped;
  }, [issues]);

  const activeIssue = useMemo(
    () => (activeId ? issues.find((i) => i.id === activeId) : null),
    [activeId, issues]
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const issueId = active.id as string;
    const issue = issues.find((i) => i.id === issueId);
    if (!issue) return;

    // Determine target status: the "over" could be a column id (status string)
    // or another card's id. Find which column the "over" belongs to.
    let targetStatus: string | null = null;

    if (boardStatuses.includes(over.id as string)) {
      targetStatus = over.id as string;
    } else {
      // It's a card - find which column it's in
      const targetIssue = issues.find((i) => i.id === over.id);
      if (targetIssue) {
        targetStatus = targetIssue.status;
      }
    }

    if (targetStatus && targetStatus !== issue.status) {
      onUpdateIssue(issueId, { status: targetStatus });
    }
  }

  function handleDragOver(_event: DragOverEvent) {
    // Could be used for visual feedback; keeping simple for now
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4 -mx-2 px-2">
        {boardStatuses.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            issues={columnIssues[status] ?? []}
            agents={agents}
            cardVariant={cardVariant}
            liveIssueIds={liveIssueIds}
            liveRunsByIssue={liveRunsByIssue}
            onSelectIssue={onSelectIssue}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <KanbanCard issue={activeIssue} agents={agents} cardVariant={cardVariant} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

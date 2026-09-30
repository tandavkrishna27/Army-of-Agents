/**
 * Phase 7 — Memory cockpit card.
 *
 * Mirrors workspace `sections/MemorySection.tsx` but scoped to a Commander
 * conversation instead of a task. Shows what memory the Commander actually
 * queried during this conversation (triggeredBy:"commander_query").
 *
 * Groups:
 *   commander_query  → "Commander queries"
 *   auto             → "Auto-retrieved"
 *   agent_search / agent_get → "Agent-pulled"
 *   skill_materialize → "Skill-materialized" (collapsed by default)
 *   other            → "Other"
 *
 * Per-row: item title (or "(item deleted)"), layer badge, category badge,
 * similarity %, "filtered" badge if !shownToAgent, link to memory explore.
 *
 * Empty state shown when there are no retrievals yet.
 * Registered in COCKPIT_REGISTRY with defaultOn:false (opt-in, audit surface).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Search, MousePointerClick, FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useCompany } from "../../../context/CompanyContext";
import { memoryRetrievalsApi, type MemoryRetrievalRowApi } from "../../../api/memoryRetrievals";
import { queryKeys } from "../../../lib/queryKeys";

// ---------------------------------------------------------------------------
// Group classification (same logic as workspace MemorySection, extended for
// commander_query which is the primary trigger from this surface)
// ---------------------------------------------------------------------------

type RetrievalGroup = "commander" | "auto" | "agent-pulled" | "skill" | "other";

function classifyGroup(trigger: MemoryRetrievalRowApi["triggeredBy"]): RetrievalGroup {
  switch (trigger) {
    case "commander_query":
      return "commander";
    case "auto":
      return "auto";
    case "agent_search":
    case "agent_get":
      return "agent-pulled";
    case "skill_materialize":
      return "skill";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CockpitMemoryCardProps {
  companyId: string;
  conversationId: string | null | undefined;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CockpitMemoryCard({ companyId, conversationId }: CockpitMemoryCardProps) {
  const { selectedCompany } = useCompany();
  // Derive the company prefix for memory explore links (e.g. "ACME").
  // Falls back to empty string — links simply won't be correct on unusual deploys.
  const companyPrefix = selectedCompany?.issuePrefix?.toUpperCase() ?? "";

  const enabled = Boolean(companyId && conversationId);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.retrievalsForConversation(companyId, conversationId ?? ""),
    queryFn: () => memoryRetrievalsApi.listForConversation(companyId, conversationId!, { limit: 100 }),
    enabled,
    staleTime: 5000,
  });

  const groups = useMemo(() => {
    const commander: MemoryRetrievalRowApi[] = [];
    const auto: MemoryRetrievalRowApi[] = [];
    const agentPulled: MemoryRetrievalRowApi[] = [];
    const skill: MemoryRetrievalRowApi[] = [];
    const other: MemoryRetrievalRowApi[] = [];
    for (const row of data ?? []) {
      const g = classifyGroup(row.triggeredBy);
      if (g === "commander") commander.push(row);
      else if (g === "auto") auto.push(row);
      else if (g === "agent-pulled") agentPulled.push(row);
      else if (g === "skill") skill.push(row);
      else other.push(row);
    }
    return { commander, auto, agentPulled, skill, other };
  }, [data]);

  if (!conversationId) {
    return (
      <div
        className="mx-3 flex items-start gap-2 rounded-md border border-dashed border-muted-foreground/30 p-3"
        data-testid="cockpit-memory-no-conversation"
      >
        <Brain className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">No active conversation</div>
          <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            Start a Commander chat to see memory retrievals here.
          </div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="px-3 space-y-2" data-testid="cockpit-memory-skeleton">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="mx-3 p-3 rounded-md border border-dashed border-destructive/30 text-xs text-muted-foreground"
        data-testid="cockpit-memory-error"
      >
        Couldn't load memory retrievals for this conversation.
      </div>
    );
  }

  const total = (data ?? []).length;

  if (total === 0) {
    return (
      <div
        className="mx-3 flex items-start gap-2 rounded-md border border-dashed border-muted-foreground/30 p-3"
        data-testid="cockpit-memory-empty"
      >
        <Brain className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">No memory queried yet</div>
          <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            Memory retrievals from this conversation will appear here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-3 overflow-hidden px-1" data-testid="cockpit-memory-card">
      <div className="text-xs text-muted-foreground px-2">
        {total} memory {total === 1 ? "retrieval" : "retrievals"} in this conversation
      </div>

      {groups.commander.length > 0 && (
        <RetrievalGroupView
          label="Commander queries"
          icon={MousePointerClick}
          rows={groups.commander}
          companyPrefix={companyPrefix}
          testid="cockpit-memory-group-commander"
        />
      )}

      {groups.auto.length > 0 && (
        <RetrievalGroupView
          label="Auto-retrieved"
          icon={Brain}
          rows={groups.auto}
          companyPrefix={companyPrefix}
          testid="cockpit-memory-group-auto"
        />
      )}

      {groups.agentPulled.length > 0 && (
        <RetrievalGroupView
          label="Agent-pulled"
          icon={Search}
          rows={groups.agentPulled}
          companyPrefix={companyPrefix}
          testid="cockpit-memory-group-agent-pulled"
        />
      )}

      {groups.other.length > 0 && (
        <RetrievalGroupView
          label="Other"
          icon={Brain}
          rows={groups.other}
          companyPrefix={companyPrefix}
          testid="cockpit-memory-group-other"
        />
      )}

      {groups.skill.length > 0 && (
        // Collapsed by default — skill-materialized rows tend to be high-volume.
        <details className="min-w-0 space-y-1 overflow-hidden" data-testid="cockpit-memory-group-skill">
          <summary className="flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden px-2 text-xs uppercase tracking-wide text-muted-foreground">
            <FileText className="h-3 w-3 shrink-0" />
            <span>Skill-materialized · {groups.skill.length}</span>
          </summary>
          <div className="mt-1 min-w-0 space-y-1 overflow-hidden">
            {groups.skill.map((row) => (
              <RetrievalRow key={row.id} row={row} companyPrefix={companyPrefix} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group view
// ---------------------------------------------------------------------------

interface RetrievalGroupViewProps {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  rows: MemoryRetrievalRowApi[];
  companyPrefix: string;
  testid: string;
}

function RetrievalGroupView({ label, icon: Icon, rows, companyPrefix, testid }: RetrievalGroupViewProps) {
  return (
    <div className="min-w-0 space-y-1 overflow-hidden" data-testid={testid}>
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden px-2 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">
          {label} · {rows.length}
        </span>
      </div>
      <div className="min-w-0 space-y-1 overflow-hidden">
        {rows.map((row) => (
          <RetrievalRow key={row.id} row={row} companyPrefix={companyPrefix} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual retrieval row
// ---------------------------------------------------------------------------

function RetrievalRow({ row, companyPrefix }: { row: MemoryRetrievalRowApi; companyPrefix: string }) {
  const title = row.itemTitle ?? "(item deleted)";
  const isDeleted = !row.itemTitle;
  const sim = row.similarityScore ? Math.round(parseFloat(row.similarityScore) * 100) : null;
  const href = row.itemId
    ? `/${companyPrefix}/memory/explore?item=${row.itemId}&type=memory_item`
    : null;

  const content = (
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className={cn("text-sm truncate", isDeleted && "italic text-muted-foreground")}>
          {title}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {row.itemLayer && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              {row.itemLayer}
            </Badge>
          )}
          {row.itemCategory && (
            <Badge variant="outline" className="text-[10px] h-4 px-1">
              {row.itemCategory}
            </Badge>
          )}
          {!row.shownToAgent && (
            <Badge variant="outline" className="text-[10px] h-4 px-1 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700">
              filtered
            </Badge>
          )}
          {sim !== null && (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{sim}%</span>
          )}
          {row.rank !== null && (
            <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">#{row.rank}</span>
          )}
        </div>
      </div>
      {href && <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />}
    </div>
  );

  if (href) {
    return (
      <a href={href} data-testid="cockpit-memory-row" className="block min-w-0 max-w-full overflow-hidden">
        {content}
      </a>
    );
  }
  return (
    <div data-testid="cockpit-memory-row" className="min-w-0 max-w-full cursor-default overflow-hidden">
      {content}
    </div>
  );
}

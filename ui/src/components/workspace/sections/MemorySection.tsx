import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, Search, MousePointerClick, FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { memoryRetrievalsApi, type MemoryRetrievalRowApi } from "../../../api/memoryRetrievals";
import { queryKeys } from "../../../lib/queryKeys";

/**
 * Workspace right-panel Memory section.
 *
 * Reads memory_retrievals (audit log written by Phase 1's
 * recordMemoryRetrievals) and shows the founder what memory each
 * agent run actually saw. Replaces the previous "coming soon"
 * placeholder.
 *
 * Groups retrievals by triggeredBy:
 *   - AUTO: pre-run injection (memorySvc.searchMultiPath called from
 *     fetchMemoryContext — wired in a later phase)
 *   - AGENT-PULLED: agent.search + agent.get MCP calls during the run
 *   - SKILL-MATERIALIZED: pinned-memory skill synthesis (Phase 2).
 *     Collapsed by default to keep the section compact.
 *
 * Click any item → navigate to /<companyPrefix>/memory/explore?item=<id> (the
 * Memory page reads ?item to select-and-open the detail view).
 */

type RetrievalGroup = "auto" | "agent-pulled" | "skill" | "other";

function classifyGroup(trigger: MemoryRetrievalRowApi["triggeredBy"]): RetrievalGroup {
  switch (trigger) {
    case "auto":
      return "auto";
    case "agent_search":
    case "agent_get":
      return "agent-pulled";
    case "skill_materialize":
      return "skill";
    case "commander_query":
      return "other";
    default:
      return "other";
  }
}

interface MemorySectionProps {
  issueId: string;
  companyId: string;
  companyPrefix: string;
}

export function MemorySection({ issueId, companyId, companyPrefix }: MemorySectionProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.memory.retrievalsForIssue(companyId, issueId),
    queryFn: () => memoryRetrievalsApi.listForIssue(companyId, issueId, { limit: 100 }),
    enabled: Boolean(companyId && issueId),
    staleTime: 5000,
  });

  const groups = useMemo(() => {
    const auto: MemoryRetrievalRowApi[] = [];
    const agentPulled: MemoryRetrievalRowApi[] = [];
    const skill: MemoryRetrievalRowApi[] = [];
    const other: MemoryRetrievalRowApi[] = [];
    for (const row of data ?? []) {
      const g = classifyGroup(row.triggeredBy);
      if (g === "auto") auto.push(row);
      else if (g === "agent-pulled") agentPulled.push(row);
      else if (g === "skill") skill.push(row);
      else other.push(row);
    }
    return { auto, agentPulled, skill, other };
  }, [data]);

  if (isLoading) {
    return (
      <div className="px-3 space-y-2" data-testid="memory-section-skeleton">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="mx-3 p-3 rounded-md border border-dashed border-destructive/30 text-xs text-muted-foreground"
        data-testid="memory-section-error"
      >
        Couldn't load memory retrievals for this task.
      </div>
    );
  }

  const total = (data ?? []).length;
  if (total === 0) {
    return (
      <div
        className="mx-3 flex items-start gap-2 rounded-md border border-dashed border-muted-foreground/30 p-3"
        data-testid="memory-section-empty"
      >
        <Brain className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-foreground">No memory used yet</div>
          <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            Retrievals from future runs will appear here.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-3 overflow-hidden px-1" data-testid="memory-section">
      <div className="text-xs text-muted-foreground">
        {total} memory {total === 1 ? "retrieval" : "retrievals"} on this task
      </div>

      {groups.auto.length > 0 && (
        <RetrievalGroupView
          label="Auto-retrieved"
          icon={Brain}
          rows={groups.auto}
          companyPrefix={companyPrefix}
          testid="memory-group-auto"
        />
      )}

      {groups.agentPulled.length > 0 && (
        <RetrievalGroupView
          label="Agent-pulled"
          icon={Search}
          rows={groups.agentPulled}
          companyPrefix={companyPrefix}
          testid="memory-group-agent-pulled"
        />
      )}

      {groups.other.length > 0 && (
        <RetrievalGroupView
          label="Commander queries"
          icon={MousePointerClick}
          rows={groups.other}
          companyPrefix={companyPrefix}
          testid="memory-group-other"
        />
      )}

      {groups.skill.length > 0 && (
        // Collapsed by default via <details> — pinned-skill deliveries
        // tend to be high-volume (one row per pinned item per run) and
        // less interesting per-item than auto/agent-pulled.
        <details className="min-w-0 space-y-1 overflow-hidden" data-testid="memory-group-skill">
          <summary className="flex min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden text-xs uppercase tracking-wide text-muted-foreground">
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
      <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs uppercase tracking-wide text-muted-foreground">
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
      <a href={href} data-testid="memory-retrieval-row" className="block min-w-0 max-w-full overflow-hidden">
        {content}
      </a>
    );
  }
  return (
    <div data-testid="memory-retrieval-row" className="min-w-0 max-w-full cursor-default overflow-hidden">
      {content}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import type { Agent } from "@armyofagents/shared";
import { KanbanBoard, type LiveRunInfo } from "../KanbanBoard";
import { TaskSlideOver } from "../TaskSlideOver";
import { issuesApi } from "../../api/issues";
import { heartbeatsApi } from "../../api/heartbeats";
import { queryKeys } from "../../lib/queryKeys";
import { EmptyState } from "../EmptyState";

/**
 * Crew Board — the unified, flat tracker for ALL crew-agent task activity.
 *
 * Design: docs/aoa/plans/2026-06-02-unified-crew-board-design.md.
 *
 * Scope is "assignee is an active crew (kind='aoa') agent", resolved server-side
 * by the `taskScope: 'crew'` filter. That pulls in every crew-agent task —
 * regardless of whether it was born from a discussion, goal, routine, MCP, or
 * direct capture — into one pane. Each task carries its owner and its lineage
 * (source badge) on the shared `KanbanCard`, so the board no longer groups by
 * source thread: it renders one flat `KanbanBoard` and you watch the whole
 * crew's work move backlog → in progress → review → done.
 *
 * View-only: tasks are created in context (discussions / goals / routines /
 * MCP), never hand-made here. There is no create affordance. Clicking a card
 * opens the full `TaskSlideOver` (assignee, dependencies, workspace, live runs,
 * comments, the run/activity timeline with tools · cost · outcome, artifacts,
 * and the review bar) — the same rich detail the main Tasks board opens. The
 * old per-task `CrewTaskAuditCard` is retired; its content lives in the
 * slide-over's activity timeline.
 */

export interface CrewBoardProps {
  companyId: string;
  /** Crew/AoA agents — supplies owner names + avatars on each card. */
  crewAgents?: Pick<Agent, "id" | "name">[];
}

export function CrewBoard({ companyId, crewAgents = [] }: CrewBoardProps) {
  const queryClient = useQueryClient();
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);

  const tasksQuery = useQuery({
    queryKey: ["tasks", "crew-board", companyId],
    queryFn: () => issuesApi.list(companyId, { taskScope: "crew" }),
    enabled: Boolean(companyId),
  });

  // Live crew activity. `liveRunsForCompany` UNIONs crew (internal_agent) runs,
  // so a task a crew agent is executing shows the "Live" pill — labelled
  // "{agentName} · {elapsed}" via liveRunsByIssue. The issue.status_changed live
  // event (LiveUpdatesProvider) also invalidates this query so the pill clears
  // promptly when a run ends; refetchInterval is the belt-and-suspenders
  // fallback (mirrors Issues.tsx / ProjectDetail.tsx).
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: Boolean(companyId),
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const liveRunsByIssue = useMemo(() => {
    const map = new Map<string, LiveRunInfo>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) map.set(run.issueId, { agentName: run.agentName, startedAt: run.startedAt });
    }
    return map;
  }, [liveRuns]);

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["tasks", "crew-board", companyId],
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.issues.list(companyId),
      });
    },
  });

  const tasks = tasksQuery.data ?? [];

  // KanbanBoard fires onSelectIssue with `issue.identifier ?? issue.id`; the
  // /issues/:id route + TaskSlideOver both resolve identifiers to UUIDs, so we
  // can hand the value straight through (matches the Issues.tsx pattern).
  const handleSelectIssue = (identifierOrId: string) => {
    setSelectedIssueId(identifierOrId);
  };

  if (tasksQuery.isLoading) {
    return (
      <div
        className="px-5 py-12 text-center text-sm text-muted-foreground"
        data-testid="crew-board-loading"
      >
        Loading…
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="px-5 py-8" data-testid="crew-board-empty">
        <EmptyState
          icon={MessageSquare}
          message="No crew tasks yet. Crew-agent tasks will appear here."
        />
      </div>
    );
  }

  return (
    <>
      <div className="px-5 py-4" data-testid="crew-board">
        <KanbanBoard
          issues={tasks}
          agents={crewAgents}
          cardVariant="crew"
          liveIssueIds={liveIssueIds}
          liveRunsByIssue={liveRunsByIssue}
          onUpdateIssue={(id, data) => updateMutation.mutate({ id, data })}
          onSelectIssue={handleSelectIssue}
        />
      </div>

      {/* Full task detail — opens when a card is clicked on the crew board. */}
      <TaskSlideOver
        issueId={selectedIssueId}
        open={!!selectedIssueId}
        onClose={() => setSelectedIssueId(null)}
      />
    </>
  );
}

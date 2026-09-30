import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { agentsApi } from "../../api/agents";
import { heartbeatsApi } from "../../api/heartbeats";
import { agentRouteRef } from "../../lib/utils";
import { PageSkeleton } from "../PageSkeleton";
import { RunDetail } from "../../pages/AgentDetail";

/**
 * RunDetailContainer — hosts a single heartbeat run for the Inbox Hub `run` tab
 * (D4b). The run tab payload carries BOTH `runId` and `agentId` because there is
 * no fetch-by-id endpoint for a run — so we fetch the agent's run list
 * (`heartbeatsApi.list(companyId, agentId)`) and `.find()` the row, plus fetch
 * the agent to derive `adapterType` (transcript parser) and the route ref
 * `RunDetail` uses for resume/retry navigation.
 *
 * If the run can't be resolved (missing `agentId`, run pruned, or list not yet
 * loaded), it renders a graceful fallback rather than crashing.
 */
export function RunDetailContainer({
  runId,
  agentId,
  companyId,
  onOpenIssue,
}: {
  runId: string;
  agentId: string;
  companyId?: string;
  onOpenIssue?: (issueId: string, title: string) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const lookupCompanyId = companyId ?? selectedCompanyId ?? undefined;

  const { data: agent } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(agentId, lookupCompanyId),
    enabled: Boolean(agentId),
  });

  // The run's own company (from the loaded agent) is authoritative; fall back to
  // the lookup company so the list query can arm before the agent resolves.
  const resolvedCompanyId = agent?.companyId ?? lookupCompanyId;

  const {
    data: runs,
    isLoading: runsLoading,
    error: runsError,
  } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agentId),
    queryFn: () => heartbeatsApi.list(resolvedCompanyId!, agentId),
    enabled: Boolean(resolvedCompanyId) && Boolean(agentId),
  });

  const foundRun = (runs ?? []).find((r) => r.id === runId) ?? null;

  if (runsError) {
    return <RunNotFound reason={runsError instanceof Error ? runsError.message : undefined} />;
  }

  // Still loading the run list — show a skeleton rather than the not-found state.
  if (runsLoading && !runs) {
    return <PageSkeleton variant="detail" />;
  }

  if (!agentId || !foundRun) {
    return <RunNotFound />;
  }

  const agentRouteId = agent ? agentRouteRef(agent) : agentId;
  // adapterType lives on the agent (HeartbeatRun has none); default to a generic
  // parser until the agent query resolves — RunDetail only uses it for transcript
  // parsing + the claude_auth_required affordance.
  const adapterType = agent?.adapterType ?? "process";

  return (
    <div className="h-full w-full overflow-auto p-5" data-testid="hub-run-detail-container">
      <RunDetail
        run={foundRun}
        agentRouteId={agentRouteId}
        adapterType={adapterType}
        onOpenIssue={onOpenIssue}
      />
    </div>
  );
}

/** Graceful "run not found" affordance — never crashes the tab. */
function RunNotFound({ reason }: { reason?: string }) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid="hub-run-not-found"
      role="status"
    >
      <p className="text-sm font-medium text-foreground">Run not found</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        {reason ??
          "This run may have been pruned or belongs to an agent that is no longer available. Open the agent to see its current runs."}
      </p>
    </div>
  );
}

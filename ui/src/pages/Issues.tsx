import { useEffect, useMemo, useCallback, useRef } from "react";
import { useParams, useSearchParams, useNavigate } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CockpitTaskBucket } from "@armyofagents/shared";
import { issuesApi } from "../api/issues";
import { cockpitApi } from "../api/cockpit";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { AccessRequiredBoundary } from "./AccessRequired";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { TaskSlideOver } from "../components/TaskSlideOver";
import { CircleDot, Loader2 } from "lucide-react";

const COCKPIT_BUCKETS = new Set<CockpitTaskBucket>(["mine", "managed", "awaiting_review"]);

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { issueId: routeIssueId } = useParams<{ issueId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Resolve issue ID from either route param (issues/:issueId) or query param (?selected=:id)
  const selectedQueryParam = searchParams.get("selected");
  const selectedIssueId = routeIssueId || selectedQueryParam || null;
  const rawCockpitBucket = searchParams.get("cockpitBucket");
  const cockpitBucket = rawCockpitBucket && COCKPIT_BUCKETS.has(rawCockpitBucket as CockpitTaskBucket)
    ? rawCockpitBucket as CockpitTaskBucket
    : null;

  const slideOverOpen = !!selectedIssueId;

  // markIssueRead side effect (migrated from IssueDetail.tsx per G14)
  const lastMarkedReadIssueIdRef = useRef<string | null>(null);
  const markIssueRead = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onSuccess: () => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  useEffect(() => {
    if (!selectedIssueId) {
      lastMarkedReadIssueIdRef.current = null;
      return;
    }
    if (lastMarkedReadIssueIdRef.current === selectedIssueId) return;
    lastMarkedReadIssueIdRef.current = selectedIssueId;
    markIssueRead.mutate(selectedIssueId);
  }, [selectedIssueId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close slide-over without discarding an accountable-work filter.
  const handleCloseSlideOver = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("selected");
    navigate(`/issues${next.size > 0 ? `?${next.toString()}` : ""}`, { replace: true });
  }, [navigate, searchParams]);

  // Open slide-over for a task: set ?selected=:id query param
  const handleSelectIssue = useCallback((issueIdentifier: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("selected", issueIdentifier);
    navigate(`/issues?${next.toString()}`, { replace: true });
  }, [navigate, searchParams]);

  const initialSearch = searchParams.get("q") ?? "";
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = useCallback((search: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmedSearch = search.trim();
      const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
      if (currentSearch === trimmedSearch) return;

      const url = new URL(window.location.href);
      if (trimmedSearch) {
        url.searchParams.set("q", trimmedSearch);
      } else {
        url.searchParams.delete("q");
      }

      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }, 300);
  }, []);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !cockpitBucket,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && !cockpitBucket,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const { setSubtitle, setEntityColor } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Tasks" }]);
    setEntityColor("var(--entity-task)");
    return () => { setSubtitle(null); setEntityColor(null); };
  }, [setBreadcrumbs, setSubtitle, setEntityColor]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !cockpitBucket,
  });

  const cockpitTasksQuery = useInfiniteQuery({
    queryKey: ["cockpit", selectedCompanyId, "tasks", cockpitBucket],
    queryFn: ({ pageParam }) => cockpitApi.listTasks(
      selectedCompanyId!,
      cockpitBucket!,
      { limit: 50, cursor: pageParam },
    ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!selectedCompanyId && !!cockpitBucket,
  });
  const cockpitTasks = cockpitTasksQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const cockpitTotal = cockpitTasksQuery.data?.pages[0]?.total ?? 0;

  // Compute subtitle counts
  useEffect(() => {
    if (cockpitBucket) {
      const label = cockpitBucket === "mine"
        ? "Mine"
        : cockpitBucket === "managed"
          ? "Managed"
          : "Awaiting Review";
      setSubtitle(cockpitTasksQuery.data ? `${cockpitTotal} ${label.toLowerCase()}` : null);
      return;
    }
    if (!issues) return;
    const active = issues.filter((i) => ["todo", "in_progress", "blocked"].includes(i.status)).length;
    const inReview = issues.filter((i) => i.status === "in_review").length;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} active`);
    if (inReview > 0) parts.push(`${inReview} in review`);
    setSubtitle(parts.length > 0 ? parts.join(" \u00B7 ") : null);
  }, [cockpitBucket, cockpitTasksQuery.data, cockpitTotal, issues, setSubtitle]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view tasks" description="Tasks are the primary unit of work that agents execute on your behalf." entityColor="var(--entity-task)" />;
  }

  // A 403 on the primary company-scoped query (tasks list, or the cockpit
  // bucket when active) means this workspace is off-limits — e.g. membership
  // revoked mid-session. AccessRequiredBoundary surfaces the friendly access
  // state instead of the list's generic error; non-403 errors flow through to
  // the list's normal inline error, and loading/empty are unaffected.
  return (
    <AccessRequiredBoundary error={cockpitBucket ? cockpitTasksQuery.error : error}>
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Tasks<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The primary unit of work agents execute on your behalf.
        </p>
      </div>
      {cockpitBucket ? (
        <section className="border-y border-border" aria-label="Accountable work">
          <div className="flex min-h-10 items-center justify-between border-b border-border px-2 text-xs text-muted-foreground">
            <span>
              {cockpitBucket === "mine" ? "Mine" : cockpitBucket === "managed" ? "Managed" : "Awaiting Review"}
            </span>
            <span className="tabular-nums">{cockpitTotal}</span>
          </div>
          {cockpitTasksQuery.isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Loading tasks...
            </div>
          )}
          {cockpitTasksQuery.isError && (
            <div className="space-y-2 py-10 text-center text-sm" role="alert">
              <p>These tasks could not be loaded.</p>
              <button type="button" className="font-medium text-brand hover:underline" onClick={() => void cockpitTasksQuery.refetch()}>
                Try again
              </button>
            </div>
          )}
          {!cockpitTasksQuery.isLoading && !cockpitTasksQuery.isError && cockpitTasks.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">No tasks in this queue.</div>
          )}
          {cockpitTasks.length > 0 && (
            <ul className="divide-y divide-border">
              {cockpitTasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center gap-3 px-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-focus-ring"
                    onClick={() => handleSelectIssue(task.id)}
                  >
                    <span className="w-20 shrink-0 text-xs text-muted-foreground">{task.identifier ?? "Task"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{task.responsibility.label}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{task.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {cockpitTasksQuery.hasNextPage && (
            <div className="flex justify-center border-t border-border p-3">
              <button
                type="button"
                className="min-h-10 px-4 text-sm font-medium text-brand hover:underline disabled:opacity-50"
                disabled={cockpitTasksQuery.isFetchingNextPage}
                onClick={() => void cockpitTasksQuery.fetchNextPage()}
              >
                {cockpitTasksQuery.isFetchingNextPage ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </section>
      ) : (
        <IssuesList
          issues={issues ?? []}
          isLoading={isLoading}
          error={error as Error | null}
          agents={agents}
          liveIssueIds={liveIssueIds}
          viewStateKey="aoa:issues-view"
          initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
          initialSearch={initialSearch}
          onSearchChange={handleSearchChange}
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
          onSelectIssue={handleSelectIssue}
        />
      )}
      <TaskSlideOver
        issueId={selectedIssueId}
        open={slideOverOpen}
        onClose={handleCloseSlideOver}
      />
    </div>
    </AccessRequiredBoundary>
  );
}

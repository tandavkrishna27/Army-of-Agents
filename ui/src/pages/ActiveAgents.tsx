import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue, LiveEvent } from "@armyofagents/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { getUIAdapter } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ExternalLink, Radio } from "lucide-react";
import { Identity } from "../components/Identity";
import { EmptyState } from "../components/EmptyState";
import {
  type FeedItem,
  MAX_FEED_ITEMS,
  MAX_STREAMING_TEXT_LENGTH,
  readString,
  summarizeEntry,
  createFeedItem,
  parseStdoutChunk,
  parseStderrChunk,
  parseSystemChunk,
  isRunActive,
  mergeFeedItems,
} from "../lib/agent-feed";

// --- Main page component ---

export function ActiveAgents() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [feedByRun, setFeedByRun] = useState<Map<string, FeedItem[]>>(new Map());
  const seenKeysRef = useRef(new Set<string>());
  const pendingByRunRef = useRef(new Map<string, string>());
  const nextIdRef = useRef(1);

  useEffect(() => {
    setBreadcrumbs([{ label: "Live Agents" }]);
  }, [setBreadcrumbs]);

  // Fetch live + recent runs
  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(selectedCompanyId!), "live-agents"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, 8),
    enabled: !!selectedCompanyId,
    refetchInterval: 5_000,
  });

  const runs = liveRuns ?? [];

  // Fetch issues for task context on cards. The Live Agents page monitors BOTH
  // org and crew runs (liveRunsForCompany unions heartbeat + internal_agent
  // runs), so the task lookup must use taskScope:'all' — otherwise a live CREW
  // run's issueId misses in issueById and the card shows a raw UUID instead of
  // the task title (review #3). Distinct "scope-all" cache key so this never
  // poisons the org board's cache (mirrors ActiveAgentsPanel).
  const { data: issues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "scope-all"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { taskScope: "all" }),
    enabled: !!selectedCompanyId && runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const activeRunIds = useMemo(() => new Set(runs.filter(isRunActive).map((r) => r.id)), [runs]);
  const activeCount = activeRunIds.size;

  // Fetch logs for completed runs that have no feed items
  const fetchedLogRunsRef = useRef(new Set<string>());
  useEffect(() => {
    if (runs.length === 0) return;

    const completedWithoutFeed = runs.filter(
      (r) => !isRunActive(r) && !fetchedLogRunsRef.current.has(r.id),
    );
    if (completedWithoutFeed.length === 0) return;

    // Mark as fetching to prevent duplicate requests
    for (const r of completedWithoutFeed) fetchedLogRunsRef.current.add(r.id);

    const fetchLogs = async () => {
      for (const run of completedWithoutFeed) {
        try {
          const logData = await heartbeatsApi.log(run.id);
          if (!logData.content) continue;

          const lines = logData.content.split("\n").filter((l) => l.trim());
          const items: FeedItem[] = [];
          const adapter = getUIAdapter(run.adapterType ?? "process");

          for (const line of lines) {
            let record: { ts?: string; stream?: string; chunk?: string };
            try {
              record = JSON.parse(line) as { ts?: string; stream?: string; chunk?: string };
            } catch {
              continue;
            }

            const ts = record.ts ?? run.createdAt;
            const chunk = record.chunk;
            if (!chunk) continue;

            if (record.stream === "stderr") {
              for (const errLine of chunk.split(/\r?\n/).filter((l) => l.trim())) {
                const item = createFeedItem(run, ts, errLine, "error", nextIdRef.current++);
                if (item) items.push(item);
              }
              continue;
            }

            if (record.stream === "system") {
              items.push(...parseSystemChunk(run, chunk, ts, pendingByRunRef.current, nextIdRef));
              continue;
            }

            // stdout — parse through adapter
            for (const stdoutLine of chunk.split(/\r?\n/).filter((l) => l.trim())) {
              const parsed = adapter.parseStdoutLine(stdoutLine, ts);
              if (parsed.length === 0) {
                const fallback = createFeedItem(run, ts, stdoutLine, "info", nextIdRef.current++);
                if (fallback) items.push(fallback);
                continue;
              }
              for (const entry of parsed) {
                const summary = summarizeEntry(entry);
                if (summary) {
                  const item = createFeedItem(run, ts, summary.text, summary.tone, nextIdRef.current++);
                  if (item) items.push(item);
                }
              }
            }
          }

          if (items.length > 0) {
            setFeedByRun((prev) => {
              const next = new Map(prev);
              next.set(run.id, items.slice(-MAX_FEED_ITEMS));
              return next;
            });
          }
        } catch {
          // Log fetch failed — card will show "Finished X ago" fallback
        }
      }
    };

    fetchLogs();
  }, [runs]);

  // Clean up pending buffers for ended runs
  useEffect(() => {
    const stillActive = new Set<string>();
    for (const runId of activeRunIds) {
      stillActive.add(`${runId}:stdout`);
      stillActive.add(`${runId}:stderr`);
      stillActive.add(`${runId}:system`);
    }
    for (const key of pendingByRunRef.current.keys()) {
      if (!stillActive.has(key)) pendingByRunRef.current.delete(key);
    }
  }, [activeRunIds]);

  // WebSocket for live streaming
  useEffect(() => {
    if (!selectedCompanyId || activeRunIds.size === 0) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const appendItems = (runId: string, items: FeedItem[]) => {
      if (items.length === 0) return;
      setFeedByRun((prev) => {
        const next = new Map(prev);
        const existing = next.get(runId) ?? [];
        next.set(runId, mergeFeedItems(existing, items, seenKeysRef.current, MAX_FEED_ITEMS));
        return next;
      });
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(selectedCompanyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;
        let event: LiveEvent;
        try { event = JSON.parse(raw) as LiveEvent; } catch { return; }
        if (event.companyId !== selectedCompanyId) return;
        const payload = event.payload ?? {};
        const runId = readString(payload["runId"]);
        if (!runId || !activeRunIds.has(runId)) return;
        const run = runById.get(runId);
        if (!run) return;

        if (event.type === "heartbeat.run.event") {
          const seq = typeof payload["seq"] === "number" ? payload["seq"] : null;
          const eventType = readString(payload["eventType"]) ?? "event";
          const messageText = readString(payload["message"]) ?? eventType;
          const dedupeKey = `${runId}:event:${seq ?? `${eventType}:${messageText}:${event.createdAt}`}`;
          if (seenKeysRef.current.has(dedupeKey)) return;
          seenKeysRef.current.add(dedupeKey);
          if (seenKeysRef.current.size > 6000) seenKeysRef.current.clear();
          const tone = eventType === "error" ? "error" : eventType === "lifecycle" ? "warn" : "info";
          const item = createFeedItem(run, event.createdAt, messageText, tone, nextIdRef.current++);
          if (item) appendItems(run.id, [item]);
          return;
        }
        if (event.type === "heartbeat.run.status") {
          const status = readString(payload["status"]) ?? "updated";
          const dedupeKey = `${runId}:status:${status}:${readString(payload["finishedAt"]) ?? ""}`;
          if (seenKeysRef.current.has(dedupeKey)) return;
          seenKeysRef.current.add(dedupeKey);
          if (seenKeysRef.current.size > 6000) seenKeysRef.current.clear();
          const tone = status === "failed" || status === "timed_out" ? "error" : "warn";
          const item = createFeedItem(run, event.createdAt, `run ${status}`, tone, nextIdRef.current++);
          if (item) appendItems(run.id, [item]);
          return;
        }
        if (event.type === "heartbeat.run.log") {
          const chunk = readString(payload["chunk"]);
          if (!chunk) return;
          const streamRaw = readString(payload["stream"]);
          const stream = streamRaw === "stderr" || streamRaw === "system" ? streamRaw : "stdout";
          if (stream === "stderr") {
            appendItems(run.id, parseStderrChunk(run, chunk, event.createdAt, pendingByRunRef.current, nextIdRef));
            return;
          }
          if (stream === "system") {
            appendItems(run.id, parseSystemChunk(run, chunk, event.createdAt, pendingByRunRef.current, nextIdRef));
            return;
          }
          appendItems(run.id, parseStdoutChunk(run, chunk, event.createdAt, pendingByRunRef.current, nextIdRef));
        }
      };

      socket.onerror = () => { socket?.close(); };
      socket.onclose = () => { if (!closed) reconnectTimer = window.setTimeout(connect, 1500); };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "live_agents_unmount");
      }
    };
  }, [activeRunIds, selectedCompanyId, runById]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Radio} message="Select a company to view live agents." />;
  }

  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Radio}
        message="No active or recent agent runs. When agents are working on tasks, their live output will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Live Agents<span className="text-brand">.</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Real-time view of agents currently running and their most recent runs.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {activeCount > 0
          ? `${activeCount} agent${activeCount !== 1 ? "s" : ""} running · ${runs.length} recent run${runs.length !== 1 ? "s" : ""}`
          : `${runs.length} recent run${runs.length !== 1 ? "s" : ""}`}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {runs.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            issue={run.issueId ? issueById.get(run.issueId) : undefined}
            feed={feedByRun.get(run.id) ?? []}
            isActive={activeRunIds.has(run.id)}
          />
        ))}
      </div>
    </div>
  );
}

// --- Run Card component ---

function RunCard({
  run,
  issue,
  feed,
  isActive,
}: {
  run: LiveRunForIssue;
  issue?: Issue;
  feed: FeedItem[];
  isActive: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const recent = feed.slice(-20);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTo({ top: body.scrollHeight, behavior: "smooth" });
  }, [feed.length]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border overflow-hidden min-h-[200px]",
        isActive
          ? "border-blue-500/30 bg-background/80 shadow-[0_0_12px_rgba(59,130,246,0.08)]"
          : "border-border bg-background/50",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          ) : (
            <span className="flex h-2 w-2 shrink-0">
              <span className="inline-flex rounded-full h-2 w-2 bg-muted-foreground/40" />
            </span>
          )}
          <Identity name={run.agentName} size="sm" />
          {isActive && (
            <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">Live</span>
          )}
        </div>
        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground shrink-0"
        >
          <ExternalLink className="h-2.5 w-2.5" />
        </Link>
      </div>

      {/* Task context */}
      {run.issueId && (
        <div className="px-3 py-1.5 border-b border-border/40 text-xs flex items-center gap-1 min-w-0">
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className={cn(
              "hover:underline min-w-0 truncate",
              isActive
                ? "text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={issue?.title ? `${issue.identifier} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
          >
            {issue?.identifier ?? run.issueId.slice(0, 8)}
            {issue?.title ? ` - ${issue.title}` : ""}
          </Link>
        </div>
      )}

      {/* Feed body */}
      <div ref={bodyRef} className="flex-1 max-h-[140px] overflow-y-auto p-2 font-mono text-[11px] space-y-1">
        {isActive && recent.length === 0 && (
          <div className="text-xs text-muted-foreground">Waiting for output...</div>
        )}
        {!isActive && recent.length === 0 && (
          <div className="text-xs text-muted-foreground">
            {run.finishedAt ? `Finished ${relativeTime(run.finishedAt)}` : `Started ${relativeTime(run.createdAt)}`}
          </div>
        )}
        {recent.map((item, index) => (
          <div
            key={item.id}
            className={cn(
              "flex gap-2 items-start",
              index === recent.length - 1 && isActive && "animate-in fade-in slide-in-from-bottom-1 duration-300",
            )}
          >
            <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(item.ts)}</span>
            <span
              className={cn(
                "min-w-0 break-words",
                item.tone === "error" && "text-red-600 dark:text-red-300",
                item.tone === "warn" && "text-amber-600 dark:text-amber-300",
                item.tone === "assistant" && "text-emerald-700 dark:text-emerald-200",
                item.tone === "tool" && "text-cyan-600 dark:text-cyan-300",
                item.tone === "info" && "text-foreground/80",
              )}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

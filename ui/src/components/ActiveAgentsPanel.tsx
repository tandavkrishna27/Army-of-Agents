import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue, LiveEvent } from "@armyofagents/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import {
  type FeedItem,
  MAX_FEED_ITEMS,
  MAX_STREAMING_TEXT_LENGTH,
  readString,
  createFeedItem,
  parseStdoutChunk,
  parseStderrChunk,
  parseSystemChunk,
  isRunActive,
  mergeFeedItems,
} from "../lib/agent-feed";

const MIN_DASHBOARD_RUNS = 4;

interface ActiveAgentsPanelProps {
  companyId: string;
  hideHeader?: boolean;
}

export function ActiveAgentsPanel({ companyId, hideHeader }: ActiveAgentsPanelProps) {
  const [feedByRun, setFeedByRun] = useState<Map<string, FeedItem[]>>(new Map());
  const seenKeysRef = useRef(new Set<string>());
  const pendingByRunRef = useRef(new Map<string, string>());
  const nextIdRef = useRef(1);

  const { data: liveRuns } = useQuery({
    queryKey: [...queryKeys.liveRuns(companyId), "dashboard"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, MIN_DASHBOARD_RUNS),
  });

  const runs = liveRuns ?? [];
  const { data: issues } = useQuery({
    // Distinct key from the org-default board list — this panel labels live
    // crew runs, so it must see crew tasks ('all'); sharing the org cache key
    // would cross-contaminate the main Tasks board.
    queryKey: [...queryKeys.issues.list(companyId), "scope-all"],
    queryFn: () => issuesApi.list(companyId, { taskScope: "all" }),
    enabled: runs.length > 0,
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) {
      map.set(issue.id, issue);
    }
    return map;
  }, [issues]);

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);
  const activeRunIds = useMemo(() => new Set(runs.filter(isRunActive).map((r) => r.id)), [runs]);

  // Clean up pending buffers for runs that ended
  useEffect(() => {
    const stillActive = new Set<string>();
    for (const runId of activeRunIds) {
      stillActive.add(`${runId}:stdout`);
      stillActive.add(`${runId}:stderr`);
      stillActive.add(`${runId}:system`);
    }
    for (const key of pendingByRunRef.current.keys()) {
      if (!stillActive.has(key)) {
        pendingByRunRef.current.delete(key);
      }
    }
  }, [activeRunIds]);

  // WebSocket connection for streaming
  useEffect(() => {
    if (activeRunIds.size === 0) return;

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

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;

        let event: LiveEvent;
        try {
          event = JSON.parse(raw) as LiveEvent;
        } catch {
          return;
        }

        if (event.companyId !== companyId) return;
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

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "active_agents_panel_unmount");
      }
    };
  }, [activeRunIds, companyId, runById]);

  if (hideHeader && runs.length === 0) return null;

  return (
    <div>
      {!hideHeader && (
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Agents
        </h3>
      )}
      {runs.length === 0 ? (
        <div className="border border-border rounded-lg p-4">
          <p className="text-sm text-muted-foreground">No recent agent runs.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-4">
          {runs.map((run) => (
            <AgentRunCard
              key={run.id}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              feed={feedByRun.get(run.id) ?? []}
              isActive={isRunActive(run)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRunCard({
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
    <div className={cn(
      "flex flex-col rounded-lg border overflow-hidden min-h-[200px]",
      isActive
        ? "border-blue-500/30 bg-background/80 shadow-[0_0_12px_rgba(59,130,246,0.08)]"
        : "border-border bg-background/50",
    )}>
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

      {/* Issue context */}
      {run.issueId && (
        <div className="px-3 py-1.5 border-b border-border/40 text-xs flex items-center gap-1 min-w-0">
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className={cn(
              "hover:underline min-w-0 truncate",
              isActive ? "text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300" : "text-muted-foreground hover:text-foreground",
            )}
            title={issue?.title ? `${issue?.identifier ?? run.issueId.slice(0, 8)} - ${issue.title}` : issue?.identifier ?? run.issueId.slice(0, 8)}
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
            <span className={cn(
              "min-w-0 break-words",
              item.tone === "error" && "text-red-600 dark:text-red-300",
              item.tone === "warn" && "text-amber-600 dark:text-amber-300",
              item.tone === "assistant" && "text-emerald-700 dark:text-emerald-200",
              item.tone === "tool" && "text-cyan-600 dark:text-cyan-300",
              item.tone === "info" && "text-foreground/80",
            )}>
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

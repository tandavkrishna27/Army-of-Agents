import { useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { heartbeatsApi } from "@/api/heartbeats";
import { activityApi } from "@/api/activity";
import { queryKeys } from "@/lib/queryKeys";

interface TerminalPanelProps {
  issueId: string;
  companyId: string;
}

// companyId kept in interface for future company-scoped endpoints
export function TerminalPanel({ issueId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const afterSeqRef = useRef(0);
  const activeRunIdRef = useRef<string | null>(null);

  // Fetch live runs (reuses existing query key so no duplicate polling)
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(issueId),
    refetchInterval: 3000,
  });

  // Fetch historical runs as fallback
  const { data: historicalRuns } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !liveRuns?.length,
  });

  // Determine which run to show
  const latestLiveRun = liveRuns?.[0] ?? null;
  const latestHistoricalRun = historicalRuns?.[0] ?? null;
  const currentRunId = latestLiveRun?.id ?? latestHistoricalRun?.runId ?? null;
  const isRunning = latestLiveRun?.status === "running" || latestLiveRun?.status === "starting";

  // Init xterm
  const initTerminal = useCallback(() => {
    if (!containerRef.current || termRef.current) return;
    const term = new Terminal({
      disableStdin: true,
      fontSize: 12,
      fontFamily: "monospace",
      convertEol: true,
      scrollback: 5000,
      theme: { background: "#00000000" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
  }, []);

  // Cleanup xterm on unmount
  useEffect(() => {
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        fitRef.current?.fit();
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Fetch and write output when run changes or is active
  useEffect(() => {
    if (!currentRunId) return;

    // If run changed, clear terminal and reset seq
    if (activeRunIdRef.current !== currentRunId) {
      activeRunIdRef.current = currentRunId;
      afterSeqRef.current = 0;
      termRef.current?.clear();
      initTerminal();
    }

    if (!termRef.current) {
      initTerminal();
    }

    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    if (isRunning) {
      // Stream events for active runs
      const fetchEvents = async () => {
        if (cancelled) return;
        try {
          const events = await heartbeatsApi.events(currentRunId, afterSeqRef.current);
          if (cancelled || !termRef.current) return;
          for (const evt of events) {
            if (evt.stream === "stdout" || evt.stream === "stderr") {
              termRef.current.write(evt.message ?? "");
            }
            afterSeqRef.current = evt.seq + 1;
          }
        } catch {
          // ignore fetch errors during polling
        }
      };
      fetchEvents();
      intervalId = setInterval(fetchEvents, 2000);
    } else {
      // Fetch full log for completed runs
      const fetchLog = async () => {
        if (cancelled || !termRef.current) return;
        try {
          let offset = 0;
          let hasMore = true;
          let chunks = 0;
          const MAX_CHUNKS = 50;
          while (hasMore && !cancelled && chunks < MAX_CHUNKS) {
            chunks++;
            const result = await heartbeatsApi.log(currentRunId, offset);
            if (cancelled || !termRef.current) return;
            if (result.content) {
              termRef.current.write(result.content);
            }
            hasMore = result.nextOffset !== undefined;
            offset = result.nextOffset ?? 0;
          }
        } catch {
          // ignore
        }
      };
      fetchLog();
    }

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [currentRunId, isRunning, initTerminal]);

  if (!currentRunId) {
    return (
      <div
        className="flex items-center justify-center h-[200px] text-xs text-muted-foreground"
        data-testid="terminal-empty"
      >
        No run output yet
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-[200px] overflow-hidden rounded-md"
      data-testid="terminal-container"
    />
  );
}

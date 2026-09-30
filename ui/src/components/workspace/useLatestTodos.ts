import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../../api/heartbeats";
import { buildTranscript } from "../../adapters/transcript";
import { getUIAdapter } from "../../adapters/registry";
import type { RunForIssue } from "../../api/activity";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoResult {
  todos: TodoItem[];
  completed: number;
  total: number;
}

const EMPTY: TodoResult = { todos: [], completed: 0, total: 0 };

const TODO_TOOL_NAMES = new Set(["TodoWrite", "update_progress", "set_status"]);

export function useLatestTodos(
  latestRun: RunForIssue | null,
  activeRun: { id: string; status?: string } | null,
  adapterType: string,
): TodoResult {
  const isRunning = activeRun?.status === "running" || activeRun?.status === "in_progress";
  const runId = activeRun?.id ?? latestRun?.runId ?? null;

  // Determine if the run we're showing completed successfully
  const runStatus = activeRun?.status ?? latestRun?.status ?? null;
  const runSucceeded = runStatus === "succeeded" || runStatus === "completed";

  const { data: logData } = useQuery({
    queryKey: ["run-log-todos", runId],
    queryFn: () => heartbeatsApi.log(runId!),
    enabled: !!runId,
    refetchInterval: isRunning ? 3000 : false,
    staleTime: isRunning ? 0 : 30_000,
  });

  return useMemo(() => {
    if (!logData?.content) return EMPTY;

    const chunks = parseNdjsonContent(logData.content);
    const adapter = getUIAdapter(adapterType);
    const entries = buildTranscript(chunks, adapter.parseStdoutLine);

    const result = extractTodosFromEntries(entries);

    // If the run succeeded, promote any remaining in_progress/pending to completed
    if (runSucceeded && result.total > 0 && result.completed < result.total) {
      const promoted = result.todos.map((t) => ({
        ...t,
        status: "completed" as const,
      }));
      return { todos: promoted, completed: result.total, total: result.total };
    }

    return result;
  }, [logData?.content, adapterType, runSucceeded]);
}

/** Exported for testing */
export function extractTodosFromEntries(
  entries: Array<{ kind: string; name?: string; input?: unknown }>,
): TodoResult {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "tool_call" && entry.name && TODO_TOOL_NAMES.has(entry.name)) {
      return extractTodos(entry.input);
    }
  }
  return EMPTY;
}

function extractTodos(input: unknown): TodoResult {
  const record = input as Record<string, unknown> | null;
  if (!record || !Array.isArray(record.todos)) return EMPTY;

  const todos: TodoItem[] = record.todos.map((t: any) => ({
    content: t.content ?? t.text ?? String(t),
    status: (t.status === "completed" || t.status === "in_progress" || t.status === "pending")
      ? t.status
      : "pending",
  }));

  const completed = todos.filter((t) => t.status === "completed").length;
  return { todos, completed, total: todos.length };
}

function parseNdjsonContent(content: string): Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> {
  const lines = content.split("\n").filter(Boolean);
  const chunks: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.ts === "string" && typeof parsed.chunk === "string") {
        chunks.push({ ts: parsed.ts, stream: parsed.stream ?? "stdout", chunk: parsed.chunk });
      }
    } catch {
      if (chunks.length === 0) {
        return [{ ts: new Date().toISOString(), stream: "stdout", chunk: content }];
      }
    }
  }
  return chunks.length > 0 ? chunks : [{ ts: new Date().toISOString(), stream: "stdout", chunk: content }];
}

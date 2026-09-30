import type { MutableRefObject } from "react";
import type { LiveRunForIssue } from "../api/heartbeats";
import { getUIAdapter } from "../adapters";
import type { TranscriptEntry } from "../adapters";

// ── Types ──────────────────────────────────────────────────────────

export type FeedTone = "info" | "warn" | "error" | "assistant" | "tool";

export interface FeedItem {
  id: string;
  ts: string;
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  tone: FeedTone;
  dedupeKey: string;
  streamingKind?: "assistant" | "thinking";
}

// ── Constants ──────────────────────────────────────────────────────

export const MAX_FEED_ITEMS = 40;
export const MAX_FEED_TEXT_LENGTH = 220;
export const MAX_STREAMING_TEXT_LENGTH = 4000;

// ── Helpers ────────────────────────────────────────────────────────

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function summarizeEntry(entry: TranscriptEntry): { text: string; tone: FeedTone } | null {
  if (entry.kind === "assistant") {
    const text = entry.text.trim();
    return text ? { text, tone: "assistant" } : null;
  }
  if (entry.kind === "thinking") {
    const text = entry.text.trim();
    return text ? { text: `[thinking] ${text}`, tone: "info" } : null;
  }
  if (entry.kind === "tool_call") {
    return { text: `tool ${entry.name}`, tone: "tool" };
  }
  if (entry.kind === "tool_result") {
    const base = entry.content.trim();
    return {
      text: entry.isError ? `tool error: ${base}` : `tool result: ${base}`,
      tone: entry.isError ? "error" : "tool",
    };
  }
  if (entry.kind === "stderr") {
    const text = entry.text.trim();
    return text ? { text, tone: "error" } : null;
  }
  if (entry.kind === "system") {
    const text = entry.text.trim();
    return text ? { text, tone: "warn" } : null;
  }
  if (entry.kind === "stdout") {
    const text = entry.text.trim();
    return text ? { text, tone: "info" } : null;
  }
  return null;
}

export function summarizeSystemLine(text: string): { text: string; tone: FeedTone } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const previewDetection = trimmed.match(/^\[aoa\]\s+(app preview detection\b.*)$/i);
  if (previewDetection?.[1]) {
    return { text: previewDetection[1], tone: "info" };
  }

  return { text: trimmed, tone: "warn" };
}

export function createFeedItem(
  run: LiveRunForIssue,
  ts: string,
  text: string,
  tone: FeedTone,
  nextId: number,
  options?: {
    streamingKind?: "assistant" | "thinking";
    preserveWhitespace?: boolean;
  },
): FeedItem | null {
  if (!text.trim()) return null;
  const base = options?.preserveWhitespace ? text : text.trim();
  const maxLength = options?.streamingKind ? MAX_STREAMING_TEXT_LENGTH : MAX_FEED_TEXT_LENGTH;
  const normalized = base.length > maxLength ? base.slice(-maxLength) : base;
  return {
    id: `${run.id}:${nextId}`,
    ts,
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    text: normalized,
    tone,
    dedupeKey: `feed:${run.id}:${ts}:${tone}:${normalized}`,
    streamingKind: options?.streamingKind,
  };
}

export function parseStdoutChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stdout`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");
  const adapter = getUIAdapter(run.adapterType ?? "process");

  const summarized: Array<{ text: string; tone: FeedTone; streamingKind?: "assistant" | "thinking" }> = [];
  const appendSummary = (entry: TranscriptEntry) => {
    if (entry.kind === "assistant" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "assistant") {
        last.text += text;
      } else {
        summarized.push({ text, tone: "assistant", streamingKind: "assistant" });
      }
      return;
    }
    if (entry.kind === "thinking" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "thinking") {
        last.text += text;
      } else {
        summarized.push({ text: `[thinking] ${text}`, tone: "info", streamingKind: "thinking" });
      }
      return;
    }
    const summary = summarizeEntry(entry);
    if (!summary) return;
    summarized.push({ text: summary.text, tone: summary.tone });
  };

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = adapter.parseStdoutLine(trimmed, ts);
    if (parsed.length === 0) {
      const fallback = createFeedItem(run, ts, trimmed, "info", nextIdRef.current++);
      if (fallback) items.push(fallback);
      continue;
    }
    for (const entry of parsed) {
      appendSummary(entry);
    }
  }

  for (const summary of summarized) {
    const item = createFeedItem(run, ts, summary.text, summary.tone, nextIdRef.current++, {
      streamingKind: summary.streamingKind,
      preserveWhitespace: !!summary.streamingKind,
    });
    if (item) items.push(item);
  }

  return items;
}

export function parseStderrChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stderr`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const item = createFeedItem(run, ts, line, "error", nextIdRef.current++);
    if (item) items.push(item);
  }
  return items;
}

export function parseSystemChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:system`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const summary = summarizeSystemLine(line);
    if (!summary) continue;
    const item = createFeedItem(run, ts, summary.text, summary.tone, nextIdRef.current++);
    if (item) items.push(item);
  }
  return items;
}

export function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

export function mergeFeedItems(
  existing: FeedItem[],
  newItems: FeedItem[],
  seenKeys: Set<string>,
  maxItems: number,
): FeedItem[] {
  const result = [...existing];
  for (const item of newItems) {
    if (seenKeys.has(item.dedupeKey)) continue;
    seenKeys.add(item.dedupeKey);

    const last = result[result.length - 1];
    if (
      item.streamingKind &&
      last &&
      last.runId === item.runId &&
      last.streamingKind === item.streamingKind
    ) {
      const mergedText = `${last.text}${item.text}`;
      result[result.length - 1] = {
        ...last,
        ts: item.ts,
        text: mergedText.length > MAX_STREAMING_TEXT_LENGTH
          ? mergedText.slice(-MAX_STREAMING_TEXT_LENGTH)
          : mergedText,
        dedupeKey: last.dedupeKey,
      };
      continue;
    }

    result.push(item);
  }
  if (seenKeys.size > 6000) seenKeys.clear();
  return result.slice(-maxItems);
}

import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { parseSystemChunk, summarizeSystemLine } from "../lib/agent-feed";

const run: LiveRunForIssue = {
  id: "run-1",
  status: "running",
  invocationSource: "assignment",
  triggerDetail: "system",
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  agentId: "agent-1",
  agentName: "Preview Agent",
  adapterType: "process",
};

describe("agent-feed system logs", () => {
  it("summarizes app preview detection as info instead of warning", () => {
    expect(
      summarizeSystemLine("[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)"),
    ).toEqual({
      text: "App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      tone: "info",
    });
  });

  it("parses system preview detection chunks as info feed items", () => {
    const nextIdRef = { current: 1 };
    const items = parseSystemChunk(
      run,
      "[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)\n",
      "2026-01-01T00:00:01Z",
      new Map(),
      nextIdRef,
    );

    expect(items).toEqual([
      expect.objectContaining({
        runId: "run-1",
        text: "App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
        tone: "info",
      }),
    ]);
  });
});

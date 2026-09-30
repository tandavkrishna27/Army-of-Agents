// ui/src/__tests__/transcript/normalize-transcript.test.ts

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@armyofagents/adapter-utils";
import { normalizeTranscript } from "../../components/workspace/transcript/normalize-transcript";

describe("normalizeTranscript", () => {
  it("merges consecutive assistant messages into one block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-01-01T00:00:00Z", text: "Hello" },
      { kind: "assistant", ts: "2026-01-01T00:00:01Z", text: "World" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "message", role: "assistant", text: "Hello\nWorld" });
  });

  it("matches tool_call with tool_result by toolUseId", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "Read", input: { path: "auth.ts", toolUseId: "t1" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:01Z", toolUseId: "t1", content: "file contents", isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    // After grouping, tool blocks get grouped into tool_group
    const toolBlocks = blocks.filter((b) => b.type === "tool" || b.type === "tool_group");
    expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("groups consecutive command tools into command_group", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "bash", input: { command: "ls" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:01Z", toolUseId: "", content: "file-a", isError: false },
      { kind: "tool_call", ts: "2026-01-01T00:00:02Z", name: "bash", input: { command: "pwd" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:03Z", toolUseId: "", content: "/home", isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    const cmdGroups = blocks.filter((b) => b.type === "command_group");
    expect(cmdGroups).toHaveLength(1);
    if (cmdGroups[0]?.type === "command_group") {
      expect(cmdGroups[0].items).toHaveLength(2);
    }
  });

  it("keeps running command stdout inside the command block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "command_execution", input: { command: "ls -la" } },
      { kind: "stdout", ts: "2026-01-01T00:00:01Z", text: "file-a\nfile-b" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("batches consecutive stderr into stderr_group", () => {
    const entries: TranscriptEntry[] = [
      { kind: "stderr", ts: "2026-01-01T00:00:00Z", text: "Warning: deprecated" },
      { kind: "stderr", ts: "2026-01-01T00:00:01Z", text: "Warning: unused var" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "stderr_group" });
    if (blocks[0]?.type === "stderr_group") {
      expect(blocks[0].lines).toHaveLength(2);
    }
  });

  it("groups known Codex adapter stderr noise as quiet diagnostics", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-01-01T00:00:00Z",
        text: "WARN codex_core_plugins::manifest: ignoring interface.defaultPrompt",
      },
      {
        kind: "stderr",
        ts: "2026-01-01T00:00:01Z",
        text: "WARN codex_core_skills::loader: ignoring interface.icon_small",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "diagnostic_group" });
    if (blocks[0]?.type === "diagnostic_group") {
      expect(blocks[0].lines).toHaveLength(2);
    }
  });

  it("keeps Codex shell snapshot and plugin sync warnings out of red stderr", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-01-01T00:00:00Z",
        text: "WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell: Shell snapshot not supported yet for PowerShell",
      },
      {
        kind: "stderr",
        ts: "2026-01-01T00:00:01Z",
        text: "WARN codex_core_plugins::startup_sync: git sync failed for curated plugin sync, falling back to GitHub HTTP error=failed to move previous curated plugins repo out of the way: Access is denied.",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "diagnostic_group" });
  });

  it("keeps successful app preview detection summaries out of red stderr", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "stderr",
        ts: "2026-01-01T00:00:00Z",
        text: "[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "diagnostic_group" });
  });

  it("renders app preview detection system logs as info events", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "system",
        ts: "2026-01-01T00:00:00Z",
        text: "[aoa] App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      },
    ];

    const blocks = normalizeTranscript(entries, false);

    expect(blocks).toEqual([
      expect.objectContaining({
        type: "event",
        label: "preview",
        tone: "info",
        text: "App preview detection (stream) found 1 candidate URL(s), 1 reachable service(s)",
      }),
    ]);
  });

  it("converts init entry to event block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "init", ts: "2026-01-01T00:00:00Z", model: "claude-sonnet", sessionId: "s1" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "event", label: "init", tone: "info" });
  });

  it("converts result entry to event block with error tone on failure", () => {
    const entries: TranscriptEntry[] = [
      { kind: "result", ts: "2026-01-01T00:00:00Z", text: "Failed", inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 0.01, subtype: "error", isError: true, errors: ["timeout"] },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks[0]).toMatchObject({ type: "event", tone: "error" });
  });

  it("merges consecutive thinking entries", () => {
    const entries: TranscriptEntry[] = [
      { kind: "thinking", ts: "2026-01-01T00:00:00Z", text: "Step 1" },
      { kind: "thinking", ts: "2026-01-01T00:00:01Z", text: "Step 2" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "thinking", text: "Step 1\nStep 2" });
  });
});

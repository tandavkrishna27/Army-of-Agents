import { describe, expect, it } from "vitest";
import { findServerAdapter, listServerAdapters } from "../adapters/registry.js";

describe("adapter registry session management", () => {
  it("normalizes known sessioned built-ins with adapter-utils defaults", () => {
    const claude = findServerAdapter("claude_local");
    expect(claude?.sessionManagement?.supportsSessionResume).toBe(true);
  });

  it("does not invent session management for non-sessioned adapters", () => {
    const process = findServerAdapter("process");
    expect(process?.sessionManagement).toBeUndefined();
  });

  it("listServerAdapters returns normalized built-ins", () => {
    const claude = listServerAdapters().find((adapter) => adapter.type === "claude_local");
    expect(claude?.sessionManagement?.nativeContextManagement).toBe("confirmed");
  });

  it("declares parked question delivery for CLI adapters instead of implying live relay", () => {
    for (const type of ["claude_local", "codex_local"]) {
      expect(findServerAdapter(type)?.humanQuestionCapabilities).toEqual({
        mode: "ask_and_park",
        preservesProducerInvocationId: true,
      });
    }
  });

  it("preserves Cursor Cloud repository session context in the registry codec", () => {
    const cursorCloud = findServerAdapter("cursor_cloud");
    expect(
      cursorCloud?.sessionCodec?.serialize({
        cursorAgentId: "agent-123",
        latestRunId: "run-456",
        envType: "pool",
        envName: "trusted",
        repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
      }),
    ).toEqual({
      cursorAgentId: "agent-123",
      latestRunId: "run-456",
      runtime: "cloud",
      envType: "pool",
      envName: "trusted",
      repos: [{ url: "https://github.com/paperclipai/paperclip.git", startingRef: "main" }],
    });
  });
});

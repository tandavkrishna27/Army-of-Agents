import { describe, expect, it } from "vitest";
import { deriveLiveRunState } from "../../components/workspace/transcript/live-run-state";
import type { DisplayBlock } from "../../components/workspace/transcript/types";

describe("deriveLiveRunState", () => {
  it("describes a running edit as the current step and counts edited files", () => {
    const blocks: DisplayBlock[] = [
      {
        type: "multi_edit_group",
        fileCount: 2,
        items: [
          {
            type: "tool",
            ts: "2026-01-01T00:00:00Z",
            name: "Edit",
            input: { file_path: "src/a.ts" },
            status: "completed",
          },
          {
            type: "tool",
            ts: "2026-01-01T00:00:01Z",
            name: "Edit",
            input: { file_path: "src/b.ts" },
            status: "running",
          },
        ],
      },
    ];

    const state = deriveLiveRunState(blocks, { isRunning: true });

    expect(state.phaseLabel).toBe("Editing");
    expect(state.currentStepText).toBe("Editing 2 files");
    expect(state.summaryItems).toContain("2 files edited");
  });

  it("summarizes commands, diagnostics, and errors without exposing raw stderr labels", () => {
    const blocks: DisplayBlock[] = [
      { type: "command_group_agg", count: 2, items: [] },
      {
        type: "diagnostic_group",
        ts: "2026-01-01T00:00:00Z",
        lines: [{ ts: "2026-01-01T00:00:00Z", text: "warning" }],
      },
      {
        type: "stderr_group",
        ts: "2026-01-01T00:00:01Z",
        lines: [{ ts: "2026-01-01T00:00:01Z", text: "boom" }],
      },
    ];

    const state = deriveLiveRunState(blocks, { isRunning: false });

    expect(state.phaseLabel).toBe("Failed");
    expect(state.currentStepText).toBeNull();
    expect(state.summaryItems).toEqual(["2 commands", "1 diagnostic", "1 error"]);
  });

  it("uses the latest running command as the active current step", () => {
    const blocks: DisplayBlock[] = [
      {
        type: "command_group_agg",
        count: 1,
        items: [
          {
            type: "tool",
            ts: "2026-01-01T00:00:00Z",
            name: "shell",
            input: { command: "pnpm test:run" },
            status: "running",
          },
        ],
      },
    ];

    const state = deriveLiveRunState(blocks, { isRunning: true });

    expect(state.phaseLabel).toBe("Running command");
    expect(state.currentStepText).toBe("Running command");
    expect(state.summaryItems).toEqual(["1 command"]);
  });
});

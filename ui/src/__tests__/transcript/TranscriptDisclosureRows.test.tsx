import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TranscriptAggregatedGroup } from "../../components/workspace/transcript/TranscriptAggregatedGroup";
import { TranscriptEditGroup } from "../../components/workspace/transcript/TranscriptEditGroup";
import type { AggregatedGroup } from "../../components/workspace/transcript/types";

describe("Transcript disclosure rows", () => {
  it("renders command groups as quiet Codex-like disclosure rows", () => {
    const group: Extract<AggregatedGroup, { type: "command_group_agg" }> = {
      type: "command_group_agg",
      count: 2,
      items: [
        {
          type: "tool",
          ts: "2026-05-17T10:00:00.000Z",
          name: "Bash",
          input: { command: "pnpm test:run" },
          result: "status: completed",
          status: "completed",
        },
        {
          type: "tool",
          ts: "2026-05-17T10:01:00.000Z",
          name: "Bash",
          input: { command: "pnpm build" },
          result: "status: completed",
          status: "completed",
        },
      ],
    };

    render(<TranscriptAggregatedGroup group={group} departmentType="software_development" />);

    const button = screen.getByRole("button", { name: /Ran 2 commands/i });
    expect(button).toHaveClass("bg-transparent");

    fireEvent.click(button);

    expect(screen.getByText("pnpm test:run")).toBeInTheDocument();
    expect(screen.getByText("pnpm build")).toBeInTheDocument();
  });

  it("renders multi-file edits as changed-files rows with stats", () => {
    const group: Extract<AggregatedGroup, { type: "multi_edit_group" }> = {
      type: "multi_edit_group",
      fileCount: 2,
      items: [
        {
          type: "tool",
          ts: "2026-05-17T10:00:00.000Z",
          name: "Edit",
          input: { file_path: "ui/src/components/workspace/WorkspaceTimeline.tsx" },
          result: "+55 -51",
          status: "completed",
        },
        {
          type: "tool",
          ts: "2026-05-17T10:01:00.000Z",
          name: "Edit",
          input: { file_path: "ui/src/components/workspace/transcript/TranscriptEditGroup.tsx" },
          result: "+58 -14",
          status: "completed",
        },
      ],
    };

    render(<TranscriptEditGroup group={group} />);

    const button = screen.getByRole("button", { name: /Edited 2 files/i });
    expect(button).toHaveClass("bg-transparent");
    expect(screen.getByText("+113")).toBeInTheDocument();
    expect(screen.getByText("-65")).toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByText("ui/src/components/workspace/WorkspaceTimeline.tsx")).toBeInTheDocument();
    expect(screen.getByText("ui/src/components/workspace/transcript/TranscriptEditGroup.tsx")).toBeInTheDocument();
  });
});

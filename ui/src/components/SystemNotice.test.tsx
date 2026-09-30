import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IssueComment } from "@armyofagents/shared";
import { MemoryRouter } from "react-router-dom";
import { CommentThread } from "./CommentThread";
import { SystemNotice } from "./SystemNotice";

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Comment editor" />,
}));

const baseComment: IssueComment = {
  id: "comment-1",
  companyId: "company-1",
  issueId: "issue-1",
  authorAgentId: null,
  authorUserId: null,
  authorType: "system",
  presentation: {
    kind: "system_notice",
    tone: "warning",
    title: "Missing issue disposition",
  },
  metadata: {
    version: 1,
    sections: [
      {
        title: "Run",
        rows: [{ status: "succeeded", nextAction: "Ask the agent to finish the handoff" }],
      },
    ],
  },
  body: "The run succeeded, but the task still needs a clear next state.",
  createdAt: new Date("2026-05-12T10:00:00Z"),
  updatedAt: new Date("2026-05-12T10:00:00Z"),
};

describe("SystemNotice", () => {
  it("renders a compact system notice with structured details", () => {
    render(<SystemNotice comment={baseComment} />);

    expect(screen.getByText("Missing issue disposition")).toBeTruthy();
    expect(screen.getByText(baseComment.body)).toBeTruthy();
    expect(screen.getByText("Run")).toBeTruthy();
    expect(screen.getByText("next action")).toBeTruthy();
    expect(screen.getByText("Ask the agent to finish the handoff")).toBeTruthy();
  });

  it("renders system notice comments outside normal comment bubbles", () => {
    render(
      <MemoryRouter>
        <CommentThread comments={[baseComment]} onAdd={async () => {}} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("system-notice-comment")).toBeTruthy();
    expect(screen.queryByText("System")).toBeNull();
    expect(screen.queryByText("You")).toBeNull();
  });

  it("keeps comments in an internal scroll area with a sticky composer", () => {
    render(
      <MemoryRouter>
        <CommentThread comments={[baseComment]} onAdd={async () => {}} />
      </MemoryRouter>,
    );

    const root = screen.getByTestId("task-comments-panel");
    const timeline = screen.getByTestId("task-comments-timeline");
    const composer = screen.getByTestId("task-comments-composer");

    expect(root.className).toContain("flex");
    expect(root.className).toContain("min-h-0");
    expect(timeline.className).toContain("overflow-y-auto");
    expect(composer.className).toContain("sticky");
    expect(composer.className).toContain("bottom-0");
  });
});

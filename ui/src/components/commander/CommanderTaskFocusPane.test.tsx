import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { CommanderTaskFocusPane, initialTabForAnchor } from "./CommanderTaskFocusPane";

vi.mock("../TaskDetail", () => ({
  TaskDetail: ({ issueId, initialTab, onDismiss }: {
    issueId: string;
    initialTab: string;
    onDismiss: () => void;
  }) => (
    <div data-testid="task-detail-stub" data-issue-id={issueId} data-initial-tab={initialTab}>
      <button type="button" onClick={onDismiss}>Close task</button>
    </div>
  ),
}));

describe("CommanderTaskFocusPane", () => {
  it("routes question and work anchors to the Task Work tab", () => {
    expect(initialTabForAnchor("question")).toBe("work");
    expect(initialTabForAnchor("work")).toBe("work");
    expect(initialTabForAnchor("review")).toBe("overview");
  });

  it("hosts TaskDetail as a focus pane and delegates close", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CommanderTaskFocusPane issueId="task-1" anchorId="question" onClose={onClose} />,
    );

    expect(screen.getByTestId("commander-task-focus-pane")).toHaveAttribute("data-issue-id", "task-1");
    expect(screen.getByTestId("task-detail-stub")).toHaveAttribute("data-initial-tab", "work");
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../TaskDetail", () => ({
  TaskDetail: ({
    issueId,
    active,
    onDismiss,
  }: {
    issueId: string | null;
    active: boolean;
    onDismiss?: () => void;
  }) => (
    <button
      data-testid="task-detail-mock"
      data-issue={issueId}
      data-active={String(active)}
      onClick={() => onDismiss?.()}
    />
  ),
}));

import { TabBodySwitch } from "./CommanderViewerPanel";
import type { ViewerTab } from "./commanderViewerModel";

const taskTab: ViewerTab = {
  id: "task:issue-1",
  kind: "task",
  title: "Fix login",
  refId: "issue-1",
};

function renderSwitch(onCloseTab = vi.fn()) {
  render(
    <TabBodySwitch
      activeId="task:issue-1"
      activeTab={taskTab}
      companyId="comp-1"
      conversationRefs={[]}
      onOpen={vi.fn()}
      onCloseTab={onCloseTab}
    />,
  );
  return { onCloseTab };
}

describe("TabBodySwitch — task tab", () => {
  it("renders TaskDetail with active=true and the issueId (refId)", () => {
    renderSwitch();
    const el = screen.getByTestId("task-detail-mock");
    expect(el).toHaveAttribute("data-issue", "issue-1");
    expect(el).toHaveAttribute("data-active", "true");
  });

  it("wires onDismiss to close the task tab by id", () => {
    const { onCloseTab } = renderSwitch();
    fireEvent.click(screen.getByTestId("task-detail-mock"));
    expect(onCloseTab).toHaveBeenCalledWith("task:issue-1");
  });
});

import { describe, expect, it } from "vitest";
import {
  TASK_DETAIL_TAB_ORDER,
  getDefaultTaskDetailTab,
  getTaskDetailTabBadges,
  getTaskDetailTabLabel,
} from "../components/task-detail/taskDetailViewModel";

describe("task detail view model", () => {
  it("opens on Overview and keeps the agreed tab inventory", () => {
    expect(getDefaultTaskDetailTab()).toBe("overview");
    expect(TASK_DETAIL_TAB_ORDER).toEqual([
      "overview",
      "work",
      "comments",
      "subtasks",
      "activity",
    ]);
  });

  it("uses product labels for tabs without inventing Outputs or Artifacts tabs", () => {
    expect(getTaskDetailTabLabel("overview")).toBe("Overview");
    expect(getTaskDetailTabLabel("work")).toBe("Work");
    expect(getTaskDetailTabLabel("comments")).toBe("Comments");
    expect(getTaskDetailTabLabel("subtasks")).toBe("Sub-tasks");
    expect(getTaskDetailTabLabel("activity")).toBe("Activity");
  });

  it("rolls work-adjacent inventory into the Work tab badge", () => {
    expect(
      getTaskDetailTabBadges({
        comments: 2,
        subtasks: 3,
        activity: 9,
        artifacts: 1,
        dependencies: 4,
        documents: 2,
        attachments: 5,
        contextBundles: 1,
        hasWorkspace: true,
      }),
    ).toEqual({
      overview: null,
      work: 14,
      comments: 2,
      subtasks: 3,
      activity: 9,
    });
  });
});

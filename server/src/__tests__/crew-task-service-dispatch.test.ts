import { describe, it, expect, vi } from "vitest";
const { mockEnqueueAssignee } = vi.hoisted(() => ({ mockEnqueueAssignee: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/issue-assignee-wakeup.js", () => ({ enqueueIssueAssigneeWakeup: mockEnqueueAssignee }));
import { dispatchCreatedCrewTasks } from "../services/crew-task-service.js";
describe("crew-task-service dispatch", () => {
  it("enqueues one wakeup PER task (carrying issueId), skipping null assignees and planning-mode tasks", async () => {
    const created = [
      { id: "i1", assigneeAgentId: "scout", workMode: "standard" },
      { id: "i2", assigneeAgentId: "engineer", workMode: "standard" },
      { id: "i3", assigneeAgentId: null, workMode: "standard" },
    ];
    await dispatchCreatedCrewTasks({} as any, "co", created as any);
    expect(mockEnqueueAssignee).toHaveBeenCalledTimes(2);
    expect(mockEnqueueAssignee).toHaveBeenCalledWith({} as any, expect.objectContaining({ issueId: "i1", agentId: "scout", reason: "crew_task_auto_approved" }));
  });
});

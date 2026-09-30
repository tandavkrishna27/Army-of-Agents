import { describe, expect, it } from "vitest";
import { parseTaskAssigneeValue, taskAssigneePayload } from "../lib/task-assignee";

describe("task assignee helpers", () => {
  it("maps an agent option to assigneeAgentId only", () => {
    expect(taskAssigneePayload("agent:agent-1")).toEqual({
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
  });

  it("maps a human option to assigneeUserId only", () => {
    expect(taskAssigneePayload("user:user-1")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    });
  });

  it("maps empty option to unassigned", () => {
    expect(taskAssigneePayload("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("rejects malformed values", () => {
    expect(parseTaskAssigneeValue("user:")).toEqual({ kind: "none", id: null });
    expect(parseTaskAssigneeValue("agent:agent-1")).toEqual({ kind: "agent", id: "agent-1" });
  });
});

import { describe, expect, it } from "vitest";
import { classifyCockpitTask } from "../services/cockpit-work.js";

const scope = {
  userIds: ["report-user"],
  agentIds: ["report-agent"],
};

function task(overrides: Partial<{
  status: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  responsibleUserId: string | null;
  reviewerUserId: string | null;
}> = {}) {
  return {
    status: "in_progress",
    assigneeUserId: null,
    assigneeAgentId: null,
    responsibleUserId: null,
    reviewerUserId: null,
    ...overrides,
  };
}

describe("classifyCockpitTask", () => {
  it("classifies direct assignment and explicit responsibility as Mine", () => {
    expect(classifyCockpitTask(task({ assigneeUserId: "me" }), "me", scope)).toBe("mine");
    expect(classifyCockpitTask(task({ responsibleUserId: "me" }), "me", scope)).toBe("mine");
  });

  it("classifies reporting humans and agents as Managed", () => {
    expect(classifyCockpitTask(task({ assigneeUserId: "report-user" }), "me", scope)).toBe("managed");
    expect(classifyCockpitTask(task({ assigneeAgentId: "report-agent" }), "me", scope)).toBe("managed");
  });

  it("gives Mine precedence over Managed", () => {
    expect(classifyCockpitTask(task({
      assigneeAgentId: "report-agent",
      responsibleUserId: "me",
    }), "me", scope)).toBe("mine");
  });

  it("moves accountable work into Awaiting Review", () => {
    expect(classifyCockpitTask(task({ status: "in_review", assigneeAgentId: "report-agent" }), "me", scope))
      .toBe("awaiting_review");
    expect(classifyCockpitTask(task({ status: "in_review", responsibleUserId: "me" }), "me", scope))
      .toBe("awaiting_review");
  });

  it("includes explicit reviewer assignments outside the responsibility subtree", () => {
    expect(classifyCockpitTask(task({ status: "in_review", reviewerUserId: "me" }), "me", scope))
      .toBe("awaiting_review");
  });

  it("excludes terminal and unrelated work", () => {
    expect(classifyCockpitTask(task({ status: "done", assigneeUserId: "me" }), "me", scope)).toBeNull();
    expect(classifyCockpitTask(task(), "me", scope)).toBeNull();
  });
});

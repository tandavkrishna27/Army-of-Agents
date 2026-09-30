import { describe, expect, it } from "vitest";
import type { HumanWorkload } from "../types/team.js";

describe("HumanWorkload shared contract", () => {
  it("accepts direct and managed-agent workload sections", () => {
    const workload: HumanWorkload = {
      companyId: "company-1",
      userId: "user-1",
      generatedAt: new Date("2026-07-09T00:00:00.000Z"),
      summary: {
        responsibleOpenTaskCount: 1,
        assignedOpenTaskCount: 1,
        managedAgentCount: 2,
        managedAgentOpenTaskCount: 3,
        attentionCount: 2,
      },
      responsibleTasks: [
        {
          id: "issue-1",
          identifier: "MANA-1",
          title: "Own launch checklist",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: "user-1",
          responsibleUserId: "user-1",
          dueDate: null,
          updatedAt: new Date("2026-07-09T00:00:00.000Z"),
        },
      ],
      assignedTasks: [],
      managedAgents: [
        {
          id: "agent-1",
          name: "Engineer",
          role: "engineer",
          status: "idle",
          rootAgentId: "agent-1",
          rootAgentName: "Engineer",
          openTaskCount: 3,
        },
      ],
      managedAgentTasks: [],
      attentionItems: [
        {
          kind: "blocked_task",
          taskId: "issue-2",
          identifier: "MANA-2",
          title: "Blocked deploy",
          status: "blocked",
          source: "responsible",
          agentId: null,
          agentName: null,
        },
      ],
    };

    expect(workload.summary.attentionCount).toBe(2);
    expect(workload.managedAgents[0]?.rootAgentId).toBe("agent-1");
  });
});

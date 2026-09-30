import { describe, it, expect } from "vitest";
import { compileThreadScopeDraft } from "../services/thread-scope-draft-compiler.js";

describe("W1a contract: assignee flows through scope-item payload", () => {
  it("compiled task_proposal exposes payload.assigneeAgentId (string | null)", () => {
    const out = compileThreadScopeDraft({
      threadTitle: "T", summaryText: "S",
      entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: "x" }],
      extractedItems: [], attachments: [],
      proposedTasks: [{ title: "A", assigneeAgentId: "agent-1" }, { title: "B" }],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    for (const t of tasks) {
      expect(t.payload).toHaveProperty("assigneeAgentId");
      expect(["string", "object"]).toContain(typeof t.payload.assigneeAgentId); // string | null
    }
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-1");
    expect(tasks[1].payload.assigneeAgentId).toBeNull();
  });
});

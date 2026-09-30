import { describe, it, expect, vi, beforeEach } from "vitest";
const { mockResolveAgentKinds, mockEnqueueAoa, mockHeartbeatWakeup, mockResolveCrewRole } = vi.hoisted(() => ({
  mockResolveAgentKinds: vi.fn(),
  mockEnqueueAoa: vi.fn().mockResolvedValue(undefined),
  mockHeartbeatWakeup: vi.fn().mockResolvedValue(undefined),
  mockResolveCrewRole: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ resolveAgentKinds: mockResolveAgentKinds, enqueueAoaMentionWakeup: mockEnqueueAoa }),
}));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => ({ wakeup: mockHeartbeatWakeup }) }));
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({ resolveCrewRole: mockResolveCrewRole }));
import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";
describe("enqueueIssueAssigneeWakeup", () => {
  beforeEach(() => vi.clearAllMocks());
  it("crew → dispatcher enqueue with role stamped, NOT heartbeat", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a1", "aoa"]]));
    mockResolveCrewRole.mockResolvedValue("engineer");
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a1", issueId: "i1", source: "assignment", reason: "issue_assigned", mutation: "create" });
    expect(mockHeartbeatWakeup).not.toHaveBeenCalled();
    expect(mockEnqueueAoa).toHaveBeenCalledWith("co", "a1", expect.objectContaining({
      source: "assignment", reason: "issue_assigned",
      payload: expect.objectContaining({ issueId: "i1", mutation: "create", role: "engineer" }),
    }));
  });
  it("org → heartbeat, NOT dispatcher", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a2", "org"]]));
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a2", issueId: "i2", source: "assignment", reason: "issue_assigned" });
    expect(mockEnqueueAoa).not.toHaveBeenCalled();
    expect(mockHeartbeatWakeup).toHaveBeenCalledWith("a2", expect.objectContaining({ payload: expect.objectContaining({ issueId: "i2" }) }));
  });
  it("crew with null role → enqueues without a role key (dispatcher fail-closes it)", async () => {
    mockResolveAgentKinds.mockResolvedValue(new Map([["a3", "aoa"]]));
    mockResolveCrewRole.mockResolvedValue(null);
    await enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a3", issueId: "i3", source: "assignment", reason: "issue_assigned" });
    expect("role" in mockEnqueueAoa.mock.calls[0][2].payload).toBe(false);
  });
  it("L3: crew enqueue failure is swallowed (best-effort, symmetric with org branch)", async () => {
    // Caller awaits this post-commit; a crew enqueue throw must NOT propagate
    // out and unwind the already-committed DB mutation.
    mockResolveAgentKinds.mockResolvedValue(new Map([["a4", "aoa"]]));
    mockResolveCrewRole.mockResolvedValue("engineer");
    mockEnqueueAoa.mockRejectedValueOnce(new Error("dispatcher boom"));
    await expect(
      enqueueIssueAssigneeWakeup({} as any, { companyId: "co", agentId: "a4", issueId: "i4", source: "assignment", reason: "issue_assigned" }),
    ).resolves.toBeUndefined();
  });
});

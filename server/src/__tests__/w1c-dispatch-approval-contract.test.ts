// W1c contract test — pins the wire shape the Assist branch passes to
// approvalService.create(companyId, data). If the handler shape changes, update
// BOTH this and thread-agent-actions.ts — the crew_dispatch approve() side-effect
// (approvals.ts) depends on `payload.threadId` + `payload.taskIds`, and the approve
// ROUTE skips its generic requester-wakeup + trust-score bump only because
// requestedBy* are null (system-originated dispatch gate, not agent-work-review).

import { describe, expect, it } from "vitest";
import {
  APPROVAL_TYPES,
  CREATABLE_APPROVAL_TYPES,
  createApprovalSchema,
} from "@armyofagents/shared";

/**
 * The exact object the Assist branch passes to approvalService.create(companyId, data).
 * Mirrors server/src/services/thread-agent-actions.ts.
 */
function buildCrewDispatchApprovalData(args: {
  threadId: string;
  scopeVersionId: string;
  taskIds: string[];
  proposedByAgentId: string | null;
}) {
  return {
    type: "crew_dispatch" as const,
    status: "pending" as const,
    requestedByAgentId: null,
    requestedByUserId: null,
    payload: {
      threadId: args.threadId,
      scopeVersionId: args.scopeVersionId,
      taskIds: args.taskIds,
      proposedByAgentId: args.proposedByAgentId,
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
  };
}

describe("W1c crew_dispatch approval contract", () => {
  it("is system-originated (no requester) so the approve route skips requester-wakeup + trust-score", () => {
    const data = buildCrewDispatchApprovalData({
      threadId: "t1",
      scopeVersionId: "sv1",
      taskIds: ["i1", "i2"],
      proposedByAgentId: "adjutant",
    });
    expect(data.requestedByAgentId).toBeNull();
    expect(data.requestedByUserId).toBeNull();
  });

  it("carries the thread + version + task ids the approve() side-effect needs", () => {
    const data = buildCrewDispatchApprovalData({
      threadId: "t1",
      scopeVersionId: "sv1",
      taskIds: ["i1", "i2"],
      proposedByAgentId: null,
    });
    expect(data.type).toBe("crew_dispatch");
    expect(data.status).toBe("pending");
    expect(data.payload.threadId).toBe("t1");
    expect(data.payload.scopeVersionId).toBe("sv1");
    expect(data.payload.taskIds).toEqual(["i1", "i2"]);
  });
});

describe("crew_dispatch is system-internal — not externally creatable (Codex #267 P1)", () => {
  it("is a known approval type (read/list/filter) but NOT in the creatable set", () => {
    expect(APPROVAL_TYPES).toContain("crew_dispatch"); // clients can read/filter it
    expect(CREATABLE_APPROVAL_TYPES).not.toContain("crew_dispatch"); // external create is blocked
  });

  it("createApprovalSchema (HTTP route + MCP create-approval) REJECTS type=crew_dispatch", () => {
    const res = createApprovalSchema.safeParse({
      type: "crew_dispatch",
      payload: { taskIds: ["out-of-scope-1"] },
    });
    expect(res.success).toBe(false);
  });

  it("createApprovalSchema still ACCEPTS a legitimately-creatable type", () => {
    const res = createApprovalSchema.safeParse({ type: "hire_agent", payload: {} });
    expect(res.success).toBe(true);
  });
});

describe("install_mcp_connector is system-internal — readable, not externally creatable (Codex P2)", () => {
  it("is a known approval type (read/list/filter) but NOT in the creatable set", () => {
    // Created system-side by createConnector; the Approval contract + MCP
    // list-approvals must be able to represent/filter it, but a client must not
    // be able to mint one (its approve() activates a company connector).
    expect(APPROVAL_TYPES).toContain("install_mcp_connector");
    expect(CREATABLE_APPROVAL_TYPES).not.toContain("install_mcp_connector");
  });

  it("createApprovalSchema (HTTP route + MCP create-approval) REJECTS type=install_mcp_connector", () => {
    const res = createApprovalSchema.safeParse({
      type: "install_mcp_connector",
      payload: { connectorId: "c1" },
    });
    expect(res.success).toBe(false);
  });
});

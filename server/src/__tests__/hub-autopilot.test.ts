import { describe, expect, it, vi } from "vitest";
import type { HubAutopilotPolicy } from "@armyofagents/shared";
import { HUB_SEMANTIC_TYPES } from "@armyofagents/shared";
import { DEFAULT_HUB_AUTOPILOT_POLICY, hubAutopilotService } from "../services/hub-autopilot.js";

function policyWith(rule: Partial<HubAutopilotPolicy["rules"][number]>, mode: HubAutopilotPolicy["mode"] = "drive"): HubAutopilotPolicy {
  return {
    ...DEFAULT_HUB_AUTOPILOT_POLICY,
    mode,
    rules: DEFAULT_HUB_AUTOPILOT_POLICY.rules.map((existing) =>
      existing.semanticType === rule.semanticType
        ? {
            ...existing,
            ...rule,
          }
        : existing,
    ),
  };
}

function makeEmptyDb() {
  const emptyQuery = {
    where: vi.fn(() => emptyQuery),
    orderBy: vi.fn(() => emptyQuery),
    limit: vi.fn(async () => []),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
  };
  return {
    select: vi.fn(() => ({
      from: () => emptyQuery,
    })),
  } as any;
}

function makeRowsDb(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    leftJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(async () => rows),
  };
  return {
    select: vi.fn(() => query),
  } as any;
}

describe("hubAutopilotService", () => {
  it("returns an off default policy when no row exists", async () => {
    const policy = await hubAutopilotService(makeEmptyDb()).get("company-1");

    expect(policy.mode).toBe("off");
    expect(policy.handledToday).toBe(0);
    expect(policy.lastHandledAt).toBeNull();
    expect(policy.rules).toHaveLength(HUB_SEMANTIC_TYPES.length);
    expect(policy.rules.every((rule) => !rule.enabled && rule.action === "none")).toBe(true);
  });

  it("evaluates off policy as noop", async () => {
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => DEFAULT_HUB_AUTOPILOT_POLICY,
    });

    await expect(
      service.evaluate({
        companyId: "company-1",
        hubItemId: "hub-1",
        semanticType: "run_complete",
        sourceAgentId: "agent-1",
        version: 2,
      }),
    ).resolves.toMatchObject({ decision: "noop", action: "none", autonomyLevel: "off" });
  });

  it("rejects auto-handle for founder-gated categories", async () => {
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => ({
        ...DEFAULT_HUB_AUTOPILOT_POLICY,
        mode: "drive",
        rules: [
          ...DEFAULT_HUB_AUTOPILOT_POLICY.rules.filter((rule) => rule.semanticType !== "approval_request"),
          { semanticType: "approval_request", action: "resolve", minTrustScore: 0, enabled: true },
        ],
      } as HubAutopilotPolicy),
    });

    await expect(
      service.evaluate({
        companyId: "company-1",
        hubItemId: "hub-1",
        semanticType: "approval_request",
        sourceAgentId: "agent-1",
        version: 2,
      }),
    ).resolves.toMatchObject({ decision: "escalate", action: "none" });
  });

  it("evaluates enabled drive policy with enough trust as resolve", async () => {
    const trustScores = { getScore: vi.fn().mockResolvedValue({ currentScore: 90, totalCompleted: 3 }) };
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => policyWith({ semanticType: "run_complete", action: "resolve", minTrustScore: 80, enabled: true }),
      trustScores,
    });

    const evaluation = await service.evaluate({
      companyId: "company-1",
      hubItemId: "hub-1",
      semanticType: "run_complete",
      sourceAgentId: "agent-1",
      version: 2,
    });

    expect(evaluation).toMatchObject({ decision: "auto_handle", action: "resolve", autonomyLevel: "drive" });
    expect(trustScores.getScore).toHaveBeenCalledWith("company-1", "agent-1");
  });

  it("evaluates enabled policy with low trust as escalate", async () => {
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => policyWith({ semanticType: "run_complete", action: "resolve", minTrustScore: 80, enabled: true }),
      trustScores: { getScore: vi.fn().mockResolvedValue({ currentScore: 50, totalCompleted: 3 }) },
    });

    await expect(
      service.evaluate({
        companyId: "company-1",
        hubItemId: "hub-1",
        semanticType: "run_complete",
        sourceAgentId: "agent-1",
        version: 2,
      }),
    ).resolves.toMatchObject({ decision: "escalate", action: "none" });
  });

  it("records autonomous resolve through the hub lifecycle action path", async () => {
    const hubItems = {
      recordLifecycleAction: vi.fn().mockResolvedValue({
        item: { id: "hub-1" },
        auditId: "audit-1",
        undoDeadline: new Date("2026-07-01T12:00:00.000Z"),
      }),
    };
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => policyWith({ semanticType: "run_complete", action: "resolve", minTrustScore: 0, enabled: true }),
      trustScores: { getScore: vi.fn().mockResolvedValue({ currentScore: 100, totalCompleted: 3 }) },
      hubItems,
    });

    await service.applyEvaluation({
      companyId: "company-1",
      hubItemId: "hub-1",
      semanticType: "run_complete",
      sourceType: "heartbeat_run",
      sourceId: "run-1",
      sourceAgentId: "agent-1",
      version: 2,
    });

    expect(hubItems.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        hubItemId: "hub-1",
        action: "resolve",
        expectedVersion: 2,
        actorType: "autonomy",
        actorId: "autopilot",
        actorIsFounder: false,
        authorityBasis: "autopilot_policy:run_complete:drive",
        autonomyLevel: "drive",
        idempotencyKey: "autopilot:company-1:hub-1:2:resolve",
        decisionContext: expect.objectContaining({
          autopilot: true,
          semanticType: "run_complete",
          sourceAgentId: "agent-1",
          minTrustScore: 0,
        }),
      }),
    );
  });

  it("uses deterministic idempotency keys for autonomous actions", async () => {
    const hubItems = { recordLifecycleAction: vi.fn().mockResolvedValue({ item: {}, auditId: "audit-1", undoDeadline: null }) };
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => policyWith({ semanticType: "routine_outcome", action: "archive", minTrustScore: 0, enabled: true }),
      trustScores: { getScore: vi.fn().mockResolvedValue({ currentScore: 100, totalCompleted: 3 }) },
      hubItems,
    });

    await service.applyEvaluation({
      companyId: "company-1",
      hubItemId: "hub-2",
      semanticType: "routine_outcome",
      sourceAgentId: "agent-1",
      version: 7,
    });

    expect(hubItems.recordLifecycleAction).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "autopilot:company-1:hub-2:7:archive" }),
    );
  });

  it("keeps autonomous lifecycle actions undoable when only decisionContext is present", async () => {
    const hubItems = { recordLifecycleAction: vi.fn().mockResolvedValue({ item: {}, auditId: "audit-1", undoDeadline: null }) };
    const service = hubAutopilotService(makeEmptyDb(), {
      policyReader: async () => policyWith({ semanticType: "run_complete", action: "resolve", minTrustScore: 0, enabled: true }),
      trustScores: { getScore: vi.fn().mockResolvedValue({ currentScore: 100, totalCompleted: 3 }) },
      hubItems,
    });

    await service.applyEvaluation({
      companyId: "company-1",
      hubItemId: "hub-1",
      semanticType: "run_complete",
      sourceAgentId: "agent-1",
      version: 2,
    });

    expect(hubItems.recordLifecycleAction.mock.calls[0][0]).not.toHaveProperty("relayResult");
    expect(hubItems.recordLifecycleAction.mock.calls[0][0]).toHaveProperty("decisionContext");
  });

  it("returns the audited post-action version for undoable recent actions", async () => {
    const service = hubAutopilotService(
      makeRowsDb([
        {
          auditId: "audit-1",
          hubItemId: "hub-1",
          title: "Run complete",
          semanticType: "run_complete",
          action: "resolve",
          autonomyLevel: "drive",
          reason: "trusted",
          decisionContext: {},
          priorState: { status: "open", version: 2 },
          undoDeadline: new Date("2026-07-01T12:00:00.000Z"),
          itemStatus: "resolved",
          itemVersion: 9,
          createdAt: new Date("2026-07-01T11:59:00.000Z"),
        },
      ]),
    );

    const result = await service.listRecentActions("company-1");

    expect(result.items[0]).toMatchObject({
      auditId: "audit-1",
      itemVersion: 3,
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  internalAgentRuntimeApprovals: makeTableProxy("internal_agent_runtime_approvals"),
  internalAgentToolTrustRules: makeTableProxy("internal_agent_tool_trust_rules"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import {
  hashRuntimeApprovalParams,
  runtimeApprovalService,
} from "../services/internal-agent/runtime-approvals.js";

type InsertCall = { table: unknown; values: Record<string, unknown> };
type UpdateCall = { table: unknown; set: Record<string, unknown> };

function makeDb(options: {
  insertReturning?: unknown[];
  selectRows?: unknown[];
  updateReturning?: unknown[];
} = {}) {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const selectWhereCalls: unknown[] = [];

  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        insertCalls.push({ table, values });
        const chain = {
          onConflictDoUpdate: vi.fn(() => chain),
          returning: vi.fn(() => Promise.resolve(options.insertReturning ?? [values])),
        };
        return chain;
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          selectWhereCalls.push(condition);
          return {
            limit: vi.fn(() => Promise.resolve(options.selectRows ?? [])),
          };
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => {
        updateCalls.push({ table, set });
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(options.updateReturning ?? [set])),
          })),
        };
      }),
    })),
  };

  return { db: db as any, insertCalls, selectWhereCalls, updateCalls };
}

describe("hashRuntimeApprovalParams", () => {
  it("is stable for object key order and order-sensitive for arrays", () => {
    const first = hashRuntimeApprovalParams("create_issue", {
      title: "Launch",
      labels: ["a", "b"],
      metadata: { priority: 1, owner: "u1" },
    });
    const reordered = hashRuntimeApprovalParams("create_issue", {
      metadata: { owner: "u1", priority: 1 },
      labels: ["a", "b"],
      title: "Launch",
    });
    const differentArrayOrder = hashRuntimeApprovalParams("create_issue", {
      metadata: { owner: "u1", priority: 1 },
      labels: ["b", "a"],
      title: "Launch",
    });

    expect(first.paramsHashVersion).toBe("v1");
    expect(first.paramsHash).toBe(reordered.paramsHash);
    expect(first.paramsHash).not.toBe(differentArrayOrder.paramsHash);
  });
});

describe("runtimeApprovalService", () => {
  it("creates a pending approval with company/user/tool/params/expiresAt", async () => {
    const { db, insertCalls } = makeDb();
    const svc = runtimeApprovalService(db);

    const created = await svc.createPending({
      companyId: "co-1",
      conversationId: "conv-1",
      runId: "run-1",
      userId: "user-1",
      toolName: "create_issue",
      params: { title: "Launch" },
      ttlMs: 60_000,
    });

    expect(created).toBeTruthy();
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      companyId: "co-1",
      conversationId: "conv-1",
      runId: "run-1",
      userId: "user-1",
      toolName: "create_issue",
      params: { title: "Launch" },
      status: "pending",
      paramsHashVersion: "v1",
    });
    expect(insertCalls[0].values.paramsHash).toEqual(expect.any(String));
    expect(insertCalls[0].values.expiresAt).toBeInstanceOf(Date);
  });

  it("looks up exact trust by company/user/tool/hash/hash version only", async () => {
    const trustedRule = { id: "trust-1", enabled: true };
    const { db, selectWhereCalls } = makeDb({ selectRows: [trustedRule] });
    const svc = runtimeApprovalService(db);

    const result = await svc.findTrustedExact({
      companyId: "co-1",
      userId: "user-1",
      toolName: "create_issue",
      params: { title: "Launch" },
    });

    expect(result).toEqual(trustedRule);
    expect(selectWhereCalls).toHaveLength(1);
  });

  it("lists enabled trust rules for one company user", async () => {
    const rules = [{ id: "trust-1", toolName: "create_issue", enabled: true }];
    const { db, selectWhereCalls } = makeDb({ selectRows: rules });
    const svc = runtimeApprovalService(db);

    const result = await svc.listTrustRules("co-1", "user-1");

    expect(result).toEqual(rules);
    expect(selectWhereCalls).toHaveLength(1);
  });

  it("revokes a user trust rule by disabling it", async () => {
    const revoked = { id: "trust-1", enabled: false };
    const { db, updateCalls } = makeDb({ updateReturning: [revoked] });
    const svc = runtimeApprovalService(db);

    const result = await svc.revokeTrustRule("trust-1", "co-1", "user-1");

    expect(result).toEqual(revoked);
    expect(updateCalls[0].set).toMatchObject({ enabled: false });
    expect(updateCalls[0].set.updatedAt).toBeInstanceOf(Date);
  });

  it("upserts trust rules so revoked exact actions can be re-enabled", async () => {
    const trusted = { id: "trust-1", enabled: true };
    const { db, insertCalls } = makeDb({ insertReturning: [trusted] });
    const svc = runtimeApprovalService(db);

    const result = await svc.createTrustRule({
      companyId: "co-1",
      userId: "user-1",
      toolName: "create_issue",
      params: { title: "Launch" },
      createdByUserId: "user-1",
    });

    expect(result).toEqual(trusted);
    expect(insertCalls[0].values).toMatchObject({
      companyId: "co-1",
      userId: "user-1",
      toolName: "create_issue",
      scope: "exact_params",
      enabled: true,
      createdByUserId: "user-1",
    });
    const valuesChain = (db.insert as any).mock.results[0].value.values.mock.results[0].value;
    expect(valuesChain.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.any(Array),
        set: expect.objectContaining({
          enabled: true,
          createdByUserId: "user-1",
          expiresAt: null,
        }),
      }),
    );
  });

  it("denies a pending approval and never claims execution", async () => {
    const updated = { id: "approval-1", status: "denied" };
    const { db, updateCalls } = makeDb({ updateReturning: [updated] });
    const svc = runtimeApprovalService(db);

    const result = await svc.deny("approval-1", "co-1", "user-1");

    expect(result).toEqual(updated);
    expect(updateCalls[0].set).toMatchObject({
      status: "denied",
      decidedByUserId: "user-1",
      decision: "deny",
    });
    expect(updateCalls[0].set).not.toHaveProperty("executedAt");
  });

  it("claims exactly one pending, unexpired approval by moving it to executing", async () => {
    const claimed = { id: "approval-1", status: "executing" };
    const { db, updateCalls } = makeDb({ updateReturning: [claimed] });
    const svc = runtimeApprovalService(db);

    const result = await svc.claimForExecution(
      "approval-1",
      "co-1",
      "user-1",
      "allow_once",
    );

    expect(result).toEqual(claimed);
    expect(updateCalls[0].set).toMatchObject({
      status: "executing",
      decidedByUserId: "user-1",
      decision: "allow_once",
    });
  });

  it("returns null when an approval cannot be claimed", async () => {
    const { db } = makeDb({ updateReturning: [] });
    const svc = runtimeApprovalService(db);

    await expect(
      svc.claimForExecution("approval-1", "co-1", "user-1", "allow_once"),
    ).resolves.toBeNull();
  });

  it("stores successful execution summary and entity details", async () => {
    const updated = { id: "approval-1", status: "approved" };
    const { db, updateCalls } = makeDb({ updateReturning: [updated] });
    const svc = runtimeApprovalService(db);

    const result = await svc.markExecuted("approval-1", "co-1", {
      summary: "Created task",
      entityType: "issue",
      entityId: "issue-1",
    });

    expect(result).toEqual(updated);
    expect(updateCalls[0].set).toMatchObject({
      status: "approved",
      resultSummary: "Created task",
      resultEntityType: "issue",
      resultEntityId: "issue-1",
    });
    expect(updateCalls[0].set.executedAt).toBeInstanceOf(Date);
  });

  it("stores failed execution error", async () => {
    const updated = { id: "approval-1", status: "failed" };
    const { db, updateCalls } = makeDb({ updateReturning: [updated] });
    const svc = runtimeApprovalService(db);

    const result = await svc.markFailed("approval-1", "co-1", "Tool failed");

    expect(result).toEqual(updated);
    expect(updateCalls[0].set).toMatchObject({
      status: "failed",
      resultError: "Tool failed",
    });
  });
});

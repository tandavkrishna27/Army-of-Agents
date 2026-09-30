import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";
import { createAgentDb } from "./helpers/mock-db.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  agentConfigRevisions: makeTableProxy("agent_config_revisions"),
}));

// org-hierarchy is constructed inside agentService(); stub it so the parent
// branches in updateAgent are inert for these patches (we patch `title` only).
vi.mock("../services/org-hierarchy.js", () => ({
  orgHierarchyService: () => ({
    ensureParent: vi.fn(),
    assertNoCycle: vi.fn(),
  }),
}));

import { agentService } from "../services/agents.js";

const T0 = new Date("2026-06-25T12:00:00.000Z"); // stored updatedAt
const T1 = new Date("2026-06-25T12:05:00.000Z"); // changed-underneath updatedAt
const existing = {
  id: "a1", companyId: "c1", name: "Atlas", role: "general", kind: "org",
  status: "idle", reportsTo: null, parentType: null, parentId: null,
  adapterType: "process", adapterConfig: {}, runtimeConfig: {},
  budgetMonthlyCents: 0, spentMonthlyCents: 0, permissions: {},
  skillKeys: [], metadata: null, createdAt: T0, updatedAt: T0,
};

beforeEach(() => vi.clearAllMocks());

describe("agentService.update — optimistic concurrency (expectedUpdatedAt)", () => {
  it("no token → last-write-wins update succeeds (back-compat)", async () => {
    const db = createAgentDb({
      selects: [[existing]],                         // getById
      updates: [[{ ...existing, title: "X", updatedAt: T1 }]], // guarded update hits 1 row
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" });
    expect(res?.title).toBe("X");
  });

  // NOTE: the Proxy mock ignores the WHERE clause, so this asserts only that the
  // token-supplied path returns the row without throwing — NOT that the guard's
  // ms-precision date_trunc comparison matched. That real-DB behaviour is proven
  // in agents-update-concurrency.integration.test.ts.
  it("token supplied → update passes through (real guard match proven in integration test)", async () => {
    const db = createAgentDb({
      selects: [[existing]],
      updates: [[{ ...existing, title: "X", updatedAt: T1 }]],
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() });
    expect(res?.title).toBe("X");
  });

  it("stale token (row changed) → throws 409 conflict with current updatedAt", async () => {
    const db = createAgentDb({
      selects: [[existing], [{ ...existing, updatedAt: T1 }]], // getById, then re-read shows it still exists
      updates: [[]],                                            // guarded update matched 0 rows
    });
    const svc = agentService(db as never);
    await expect(
      svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() }),
    ).rejects.toMatchObject({
      status: 409,
      details: { currentUpdatedAt: T1.toISOString() },
    });
  });

  it("token for a vanished row → returns null (route maps to 404, not 409)", async () => {
    const db = createAgentDb({
      selects: [[existing], []], // getById finds it, but the re-read finds nothing (deleted concurrently)
      updates: [[]],             // guarded update matched 0 rows
    });
    const svc = agentService(db as never);
    const res = await svc.update("a1", { title: "X" }, { expectedUpdatedAt: T0.toISOString() });
    expect(res).toBeNull();
  });
});

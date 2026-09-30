// Service-layer defense-in-depth verification: approve/reject/requestRevision
// must refuse to update an approval row when the supplied companyId doesn't
// match the row's actual companyId. Even if a future route forgets the
// load+assertCompanyAccess gate, the service refuses to mutate cross-tenant.
//
// Closes the PR #131 follow-up flagged by the C3/C4 review.

import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  approvals: makeTableProxy("approvals"),
  approvalComments: makeTableProxy("approval_comments"),
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  notifications: makeTableProxy("notifications"),
  issues: makeTableProxy("issues"),
  // org hierarchy reads — defensive stubs in case service init touches them.
  agentProjects: makeTableProxy("agent_projects"),
  projects: makeTableProxy("projects"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// approvals.js now imports crew-budget.js + crew-task-service.js (the W1c
// crew_dispatch approve() branch). Mock them so their transitive @armyofagents/db
// imports (e.g. memoryItems) never load under this test's partial db mock. The
// crew_dispatch path is never exercised here (types are "test"/"hire_agent").
vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: vi.fn(),
}));
vi.mock("../services/crew-task-service.js", () => ({
  dispatchCreatedCrewTasks: vi.fn(),
}));

// Service uses agentService internally (for hire_agent payloads). We never
// hit those paths in this test (type is "test" not "hire_agent"), but the
// factory is invoked at construction so we provide an empty stub.
vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    activatePendingApproval: vi.fn(),
    create: vi.fn(),
    terminate: vi.fn(),
  }),
}));
vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: vi.fn().mockResolvedValue(undefined),
}));

import { approvalService } from "../services/approvals.js";

const FAKE_EXISTING = {
  id: "ap1",
  companyId: "company-A",
  status: "pending",
  type: "test",
  payload: {},
};

/**
 * Build a mock db where:
 *   - SELECT returns the single fake approval row (regardless of where).
 *     This simulates getExistingApproval(id) succeeding even cross-tenant —
 *     the service intentionally relies on the UPDATE's WHERE for the
 *     defense-in-depth gate, not on the existence check.
 *   - UPDATE().returning() returns whatever the test passed in. The test
 *     passes [] to simulate "WHERE id=X AND companyId=Y matched no rows".
 */
function makeDb(updateReturning: unknown[]): any {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    then: (resolve: any) => resolve([FAKE_EXISTING]),
    limit: () => Promise.resolve([FAKE_EXISTING]),
    orderBy: () => selectChain,
  };
  return {
    select: () => selectChain,
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: () => ({
            then: (resolve: any) => resolve(updateReturning),
          }),
        }),
      }),
    })),
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([]) }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  };
}

describe("approvalService — companyId defense-in-depth", () => {
  it("approve: returns null when companyId mismatch (zero rows updated)", async () => {
    const db = makeDb([]); // simulate WHERE id=X AND companyId=Y matching no rows
    const svc = approvalService(db);
    const result = await svc.approve("ap1", "company-WRONG", "user-A", "ok");
    expect(result).toBeNull();
  });

  it("approve: returns row when companyId matches", async () => {
    const fakeApproval = { id: "ap1", companyId: "company-A", type: "test", status: "approved" };
    const db = makeDb([fakeApproval]);
    const svc = approvalService(db);
    const result = await svc.approve("ap1", "company-A", "user-A", "ok");
    expect(result).toEqual(fakeApproval);
  });

  it("reject: returns null when companyId mismatch", async () => {
    const db = makeDb([]);
    const svc = approvalService(db);
    const result = await svc.reject("ap1", "company-WRONG", "user-A", "no");
    expect(result).toBeNull();
  });

  it("reject: returns row when companyId matches", async () => {
    const fakeApproval = { id: "ap1", companyId: "company-A", type: "test", status: "rejected" };
    const db = makeDb([fakeApproval]);
    const svc = approvalService(db);
    const result = await svc.reject("ap1", "company-A", "user-A", "no");
    expect(result).toEqual(fakeApproval);
  });

  it("requestRevision: returns null when companyId mismatch", async () => {
    const db = makeDb([]);
    const svc = approvalService(db);
    const result = await svc.requestRevision("ap1", "company-WRONG", "user-A", "needs work");
    expect(result).toBeNull();
  });

  it("requestRevision: returns row when companyId matches", async () => {
    const fakeApproval = {
      id: "ap1",
      companyId: "company-A",
      type: "test",
      status: "revision_requested",
    };
    const db = makeDb([fakeApproval]);
    const svc = approvalService(db);
    const result = await svc.requestRevision("ap1", "company-A", "user-A", "needs work");
    expect(result).toEqual(fakeApproval);
  });
});

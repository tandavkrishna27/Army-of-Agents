import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({ executionTargets: makeTableProxy("execution_targets") }));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { resolveExecutionTargetForRun } from "../services/execution-target-resolver.js";

const pooled = {
  id: "t-pool",
  slug: "pool-1",
  kind: "pooled_gvisor",
  trustClass: "shared_multitenant",
  status: "active",
  organizationId: null,
};

// A thenable that ALSO exposes `.where`, so BOTH the old (`await …from()`) and the
// new (`…from().where()`) code paths resolve to rows; the discriminator is whether
// `.where` was invoked. Mirrors execution-targets-service.test.ts's mock shape.
function dbCapturingWhere(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const fromResult: unknown = Object.assign(Promise.resolve(rows), { where });
  const from = vi.fn().mockReturnValue(fromResult);
  const select = vi.fn().mockReturnValue({ from });
  return {
    db: { select } as unknown as Parameters<typeof resolveExecutionTargetForRun>[0],
    where,
    from,
  };
}

describe("resolveExecutionTargetForRun scopes execution_targets in SQL (M2 — no full-table scan)", () => {
  it("filters to system-OR-own-org via a WHERE clause (or(isNull, eq)), not a JS post-filter", async () => {
    const { db, where, from } = dbCapturingWhere([pooled]);
    const chosen = await resolveExecutionTargetForRun(db, {
      organizationId: "org-1",
      companyId: "co-1",
      credentialKind: "company_api_key",
      pinnedTargetId: null,
      executionTargetSlug: null,
    });
    expect(from).toHaveBeenCalled();
    // or(isNull(organizationId), eq(organizationId, orgId)) -> stub returns "or"
    expect(where).toHaveBeenCalledWith("or");
    // Behavior preserved: a business key still routes to the pooled target.
    expect(chosen?.id).toBe("t-pool");
  });

  it("a null org scopes via isNull() alone (no eq(col, null)) — the null branch", async () => {
    const { db, where, from } = dbCapturingWhere([pooled]);
    const chosen = await resolveExecutionTargetForRun(db, {
      organizationId: null,
      companyId: "co-1",
      credentialKind: "company_api_key",
      pinnedTargetId: null,
      executionTargetSlug: null,
    });
    expect(from).toHaveBeenCalled();
    // isNull(organizationId) alone (never eq(col, null)) -> stub returns "isNull"
    expect(where).toHaveBeenCalledWith("isNull");
    // Behavior preserved: system rows still route a business key to the pool.
    expect(chosen?.id).toBe("t-pool");
  });
});

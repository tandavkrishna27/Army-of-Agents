import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { marketplaceInstallOperations: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"), and: () => Symbol("op:and"), gt: () => Symbol("op:gt"),
}));

import { startInstallOperation } from "../services/marketplace-install/orchestrator.js";

const SKILL = {
  id: "skill:aoa-curated/code-review", type: "skill" as const, name: "Code Review", description: "...", version: "1.0.0",
  source: { adapter: "aoa-curated", url: "...", locator: "...", commitSha: "abc" },
  resourceUrl: "https://.../SKILL.md",
  trust: { tier: "verified" as const, source: "aoa-curated" }, status: "active" as const,
  addedAt: "2026-04-30T00:00:00Z", category: "engineering" as const, tags: [],
};

describe("idempotency", () => {
  it("two startInstallOperation calls with same idempotencyKey return same operation row", async () => {
    let storedOp: any = null;
    const db = {
      insert: () => ({
        values: (row: any) => {
          storedOp = { ...row, id: "op-1", createdAt: new Date() };
          return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([storedOp]) }) };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(storedOp ? [storedOp] : []),
          }),
        }),
      }),
    };

    const op1 = await startInstallOperation({
      request: { catalogItemId: SKILL.id, idempotencyKey: "abc-123" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: db as any,
    });

    const op2 = await startInstallOperation({
      request: { catalogItemId: SKILL.id, idempotencyKey: "abc-123" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: db as any,
    });

    expect(op1.id).toBe(op2.id);
    expect(op1.id).toBe("op-1");
  });

  it("operations with different idempotencyKeys are independent", async () => {
    const operations: any[] = [];
    let nextId = 1;
    const db = {
      insert: () => ({
        values: (row: any) => {
          const op = { ...row, id: `op-${nextId++}`, createdAt: new Date() };
          operations.push(op);
          return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([op]) }) };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    };

    const op1 = await startInstallOperation({
      request: { catalogItemId: SKILL.id, idempotencyKey: "key-A" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: db as any,
    });
    const op2 = await startInstallOperation({
      request: { catalogItemId: SKILL.id, idempotencyKey: "key-B" },
      catalogItem: SKILL, companyId: "c1", requestedByUserId: "u1", db: db as any,
    });

    expect(op1.id).not.toBe(op2.id);
    expect(operations).toHaveLength(2);
  });
});

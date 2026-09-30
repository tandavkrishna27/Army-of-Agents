import { describe, expect, it, vi } from "vitest";

// Value-carrying drizzle mock so the fake DB can honour the hash predicate.
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  ne: (col: unknown, val: unknown) => ({ op: "ne", col, val }),
  and: (...clauses: unknown[]) => ({ op: "and", clauses }),
}));
vi.mock("@armyofagents/db", () => {
  const table = new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p : undefined) });
  return { executionTargets: table };
});

import {
  createWorkerToken,
  hashWorkerToken,
  resolveWorkerTargetId,
  stripWorkerSecret,
} from "../services/execution-targets.js";

// select({id}).from().where({op:"eq",col:"workerTokenHash",val}) → matching ids.
function matches(row: Record<string, unknown>, clause: any): boolean {
  if (clause.op === "and") return clause.clauses.every((part: any) => matches(row, part));
  if (clause.op === "eq") return row[clause.col] === clause.val;
  if (clause.op === "ne") return row[clause.col] !== clause.val;
  return false;
}

function makeFakeDb(rows: Array<{ id: string; workerTokenHash: string | null; status?: string }>) {
  return {
    select: () => ({
      from: () => ({
        where: (clause: any) =>
          Promise.resolve(
            rows
              .filter((r) => matches({ status: "active", ...r }, clause))
              .map((r) => ({ id: r.id })),
          ),
      }),
    }),
  } as any;
}

describe("worker-token helpers (Finding #3 — the row id is no longer the credential)", () => {
  it("createWorkerToken is prefixed + high-entropy; hashWorkerToken is deterministic and not the token", () => {
    const a = createWorkerToken();
    const b = createWorkerToken();
    expect(a).toMatch(/^aoa_wtk_[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
    expect(hashWorkerToken(a)).toBe(hashWorkerToken(a));
    expect(hashWorkerToken(a)).not.toBe(a);
  });

  it("resolveWorkerTargetId returns the id for the matching token hash", async () => {
    const token = createWorkerToken();
    const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken(token) }]);
    expect(await resolveWorkerTargetId(db, token)).toBe("t-1");
  });

  it("the raw target-id UUID no longer authorizes (its hash matches no row)", async () => {
    const token = createWorkerToken();
    const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken(token) }]);
    expect(await resolveWorkerTargetId(db, "t-1")).toBeNull();
  });

  it("empty / unknown tokens resolve to null (fail closed)", async () => {
    const db = makeFakeDb([{ id: "t-1", workerTokenHash: hashWorkerToken("real") }]);
    expect(await resolveWorkerTargetId(db, "")).toBeNull();
    expect(await resolveWorkerTargetId(db, "   ")).toBeNull();
    expect(await resolveWorkerTargetId(db, "not-a-real-token")).toBeNull();
  });

  it("a revoked target with a null token hash rejects its former token", async () => {
    const formerToken = createWorkerToken();
    const db = makeFakeDb([{ id: "t-1", workerTokenHash: null }]);
    expect(await resolveWorkerTargetId(db, formerToken)).toBeNull();
  });

  it("a disabled target rejects authentication even if a stale hash remains", async () => {
    const token = createWorkerToken();
    const db = makeFakeDb([
      { id: "t-1", workerTokenHash: hashWorkerToken(token), status: "disabled" },
    ]);
    expect(await resolveWorkerTargetId(db, token)).toBeNull();
  });

  it("stripWorkerSecret removes only the hash, keeping the FK id", () => {
    const safe = stripWorkerSecret({ id: "t-1", organizationId: "org-A", workerTokenHash: "deadbeef" });
    expect(safe).toEqual({ id: "t-1", organizationId: "org-A" });
    expect("workerTokenHash" in safe).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";
vi.mock("@armyofagents/db", async () => ({ executionTargets: makeTableProxy("execution_targets") }));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
import {
  listExecutionTargets,
  registerWorkerHeartbeat,
  revokeExecutionTargetWorkerToken,
  rotateExecutionTargetWorkerToken,
} from "../services/execution-targets.js";

describe("listExecutionTargets (P5 finding #1 — no system-row leak; L-c: scoped in SQL)", () => {
  // Thenable-with-.where: the OLD (`await …from()`) and NEW (`…from().where()`)
  // paths both resolve rows; the discriminator is whether `.where` ran.
  function dbWith(scopedRows: unknown[]) {
    const where = vi.fn().mockResolvedValue(scopedRows);
    const fromResult: unknown = Object.assign(Promise.resolve(scopedRows), { where });
    const from = vi.fn().mockReturnValue(fromResult);
    const select = vi.fn().mockReturnValue({ from });
    return {
      db: { select } as unknown as Parameters<typeof listExecutionTargets>[0],
      where,
      select,
    };
  }

  it("scopes to the org's own rows via a WHERE clause (eq), not a full scan + JS filter", async () => {
    const { db, where } = dbWith([
      { id: "a-ded", organizationId: "org-A", slug: "a-box", kind: "dedicated_worker" },
    ]);
    const out = (await listExecutionTargets(db, "org-A")) as Array<{
      id: string;
      organizationId: string | null;
    }>;
    expect(where).toHaveBeenCalledWith("eq"); // eq(organizationId, orgId) — SQL scope
    expect(out.map((t) => t.id)).toEqual(["a-ded"]);
  });

  it("returns nothing for a null org WITHOUT scanning the table (early-return before the query)", async () => {
    const { db, select } = dbWith([]);
    expect(await listExecutionTargets(db, null)).toEqual([]);
    expect(select).not.toHaveBeenCalled(); // no ambient system-row scan for a null org
  });
});

describe("registerWorkerHeartbeat", () => {
  it("scopes the update to the target ID (never the slug) and reports rows updated", async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "t-1" }]) });
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) } as unknown as Parameters<typeof registerWorkerHeartbeat>[0];
    const res = await registerWorkerHeartbeat(db, { targetId: "t-1", status: "active", capabilities: { runtimes: ["runsc"] } });
    expect(db.update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
    // "and" is the stubbed operator return; proves .where was given a COMPOSED
    // predicate — and(eq(id), ne(status, 'disabled')) — not a bare id equality.
    // The status guard keeps a disabled target from being resurrected by its
    // own heartbeat (real-DB proof in execution-targets-worker-token.integration).
    expect(where).toHaveBeenCalledWith("and");
    expect(res.updated).toBe(1);
  });
  it("reports zero updated when the target id is gone (fail-closed 404 at the route)", async () => {
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    const set = vi.fn().mockReturnValue({ where });
    const db = { update: vi.fn().mockReturnValue({ set }) } as unknown as Parameters<typeof registerWorkerHeartbeat>[0];
    expect((await registerWorkerHeartbeat(db, { targetId: "missing" })).updated).toBe(0);
  });
});

describe("execution-target worker-token lifecycle", () => {
  function updateDb(returningRows: unknown[]) {
    const returning = vi.fn().mockResolvedValue(returningRows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    return {
      db: { update: vi.fn().mockReturnValue({ set }) } as unknown as Parameters<
        typeof rotateExecutionTargetWorkerToken
      >[0],
      set,
      where,
    };
  }

  it("atomically rotates the same-org target token and returns plaintext only once", async () => {
    const { db, set, where } = updateDb([
      { id: "target-1", organizationId: "org-1", status: "active", workerTokenHash: "new-hash" },
    ]);
    const rotated = await rotateExecutionTargetWorkerToken(db, {
      organizationId: "org-1",
      targetId: "target-1",
    });

    expect(where).toHaveBeenCalledWith("and");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ workerTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    );
    expect(rotated?.workerToken).toMatch(/^aoa_wtk_[0-9a-f]{48}$/);
    expect(rotated?.target).not.toHaveProperty("workerTokenHash");
    expect(set.mock.calls[0]?.[0].workerTokenHash).not.toBe(rotated?.workerToken);
  });

  it("revokes a same-org target by clearing its hash and durably disabling it", async () => {
    const { db, set, where } = updateDb([
      { id: "target-1", organizationId: "org-1", status: "disabled", workerTokenHash: null },
    ]);
    const revoked = await revokeExecutionTargetWorkerToken(db, {
      organizationId: "org-1",
      targetId: "target-1",
    });

    expect(where).toHaveBeenCalledWith("and");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ workerTokenHash: null, status: "disabled" }),
    );
    expect(revoked).toEqual(expect.objectContaining({ id: "target-1", status: "disabled" }));
    expect(revoked).not.toHaveProperty("workerTokenHash");
  });

  it("returns null when the target is missing or belongs to another organization", async () => {
    const { db: rotateDb } = updateDb([]);
    const { db: revokeDb } = updateDb([]);

    await expect(
      rotateExecutionTargetWorkerToken(rotateDb, { organizationId: "org-1", targetId: "target-2" }),
    ).resolves.toBeNull();
    await expect(
      revokeExecutionTargetWorkerToken(revokeDb, { organizationId: "org-1", targetId: "target-2" }),
    ).resolves.toBeNull();
  });
});

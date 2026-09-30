// server/src/__tests__/artifact-add-version-parent.test.ts
//
// Task A-M8 — artifactService.addVersion must validate that parentVersionId
// belongs to the SAME artifact being versioned. The FK on
// artifact_versions.parent_version_id permits ANY artifact_versions row
// (including one owned by another artifact / another company), and the zod
// validator only enforces `.uuid()`. A foreign/missing parent must be rejected
// with badRequest BEFORE the new version row is inserted.
//
// Service-mock unit test: drives addVersion with a hand-rolled tx whose parent
// lookup returns either a DIFFERENT artifactId (reject) or the SAME artifactId
// (accept).

import { describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    artifacts: makeTable("artifacts"),
    artifactVersions: makeTable("artifact_versions"),
    issues: makeTable("issues"),
  };
});

import { artifactService } from "../services/artifacts.js";
import { HttpError } from "../errors.js";

type MockRow = Record<string, unknown>;

/**
 * Hand-rolled tx that serves SELECTs from a queue (in the order addVersion
 * issues them) and records insert/update calls. addVersion's select calls,
 * in order:
 *   1. (NEW) when parentVersionId provided: parent's { artifactId }
 *   2. existing max { versionNumber }
 * The implementation issues the parent check FIRST so a foreign parent rejects
 * before any other read or write.
 */
function makeTracker(opts: { selectResults: MockRow[][]; versionId?: string }) {
  const inserts: Array<{ values: MockRow }> = [];
  const updates: Array<{ set: MockRow }> = [];
  let selectIdx = 0;

  function makeSelectChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      chain[m] = (..._a: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  const tx = {
    select: (_fields?: unknown) =>
      makeSelectChain(() => opts.selectResults[selectIdx++] ?? []),
    insert: (_table: unknown) => {
      const idx = inserts.length;
      inserts.push({ values: {} });
      const chain: Record<string, unknown> = {};
      chain.values = (v: MockRow) => {
        inserts[idx].values = v;
        return chain;
      };
      chain.returning = () =>
        Promise.resolve([{ id: opts.versionId ?? "v-new", ...inserts[idx].values }]);
      return chain;
    },
    update: (_table: unknown) => {
      const idx = updates.length;
      updates.push({ set: {} });
      const chain: Record<string, unknown> = {};
      chain.set = (v: MockRow) => {
        updates[idx].set = v;
        return chain;
      };
      chain.where = () => Promise.resolve([]);
      return chain;
    },
  };

  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };

  return { db, inserts, updates };
}

describe("artifactService.addVersion — parentVersionId belongs to artifact (A-M8)", () => {
  it("rejects a parentVersionId whose parent row belongs to a DIFFERENT artifact", async () => {
    // First select (parent lookup) returns a parent owned by another artifact.
    const tracker = makeTracker({
      selectResults: [[{ artifactId: "other-artifact" }]],
    });
    const svc = artifactService(tracker.db as never);

    await expect(
      svc.addVersion("art-1", { source: "agent", parentVersionId: "v-from-other" }),
    ).rejects.toBeInstanceOf(HttpError);

    // Nothing was inserted — the new version row must NOT be created.
    expect(tracker.inserts.length).toBe(0);
    expect(tracker.updates.length).toBe(0);
  });

  it("rejects a parentVersionId that does not resolve to any row (missing parent)", async () => {
    const tracker = makeTracker({ selectResults: [[]] });
    const svc = artifactService(tracker.db as never);

    let caught: unknown;
    try {
      await svc.addVersion("art-1", { source: "agent", parentVersionId: "v-ghost" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(400);
    expect(tracker.inserts.length).toBe(0);
  });

  it("accepts a parentVersionId that belongs to the SAME artifact", async () => {
    // select[0] = parent lookup (same artifact); select[1] = existing max version.
    const tracker = makeTracker({
      selectResults: [[{ artifactId: "art-1" }], [{ versionNumber: 2 }]],
      versionId: "v-3",
    });
    const svc = artifactService(tracker.db as never);

    const version = (await svc.addVersion("art-1", {
      source: "agent",
      parentVersionId: "v-2-same",
    })) as MockRow;

    expect((version as { id: string }).id).toBe("v-3");
    expect(tracker.inserts.length).toBe(1);
    expect(tracker.inserts[0].values).toMatchObject({
      artifactId: "art-1",
      versionNumber: 3,
      parentVersionId: "v-2-same",
    });
    // currentVersionId pointer bumped.
    expect(tracker.updates[0].set).toMatchObject({ currentVersionId: "v-3" });
  });

  it("accepts when no parentVersionId is provided (no parent lookup needed)", async () => {
    // Only the existing-max select runs; no parent lookup.
    const tracker = makeTracker({
      selectResults: [[{ versionNumber: 0 }]],
      versionId: "v-1",
    });
    const svc = artifactService(tracker.db as never);

    const version = (await svc.addVersion("art-1", { source: "founder" })) as MockRow;

    expect((version as { id: string }).id).toBe("v-1");
    expect(tracker.inserts[0].values).toMatchObject({
      artifactId: "art-1",
      versionNumber: 1,
      parentVersionId: null,
    });
  });
});

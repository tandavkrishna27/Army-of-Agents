import { describe, expect, it } from "vitest";
import {
  captureFreshnessSnapshot,
  compareFreshnessSnapshot,
} from "../services/thread-agent-action-freshness.js";

function createSequenceDb(rows: unknown[][]) {
  let index = 0;
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(resolve(rows[index++] ?? []));
    return chain;
  };

  return {
    select: () => makeChain(),
  };
}

const baseThread = {
  id: "thread-1",
  status: "active",
  phase: "scope",
  entrySeq: 6,
  updatedAt: new Date("2026-06-15T10:00:00Z"),
};

const baseHuman = {
  id: "entry-6",
  seq: 6,
  createdAt: new Date("2026-06-15T10:01:00Z"),
};

const baseScope = {
  id: "scope-v1",
  versionNumber: 1,
  status: "draft",
  sourceEndSeq: 6,
  createdAt: new Date("2026-06-15T10:02:00Z"),
};

describe("thread agent action freshness", () => {
  it("returns null (no-op) when the thread is missing — background sweep teardown", async () => {
    // captureFreshnessSnapshot must never throw when the thread row is absent;
    // background sweeps encounter this when a company/thread is torn down (e.g.
    // test cleanup). The caller (runner.ts try/catch, compareFreshnessSnapshot
    // null-check) handles null as a silent no-op.
    const db = createSequenceDb([[], [], []]);
    await expect(captureFreshnessSnapshot(db as never, "ghost-thread")).resolves.toBeNull();
  });

  it("reports thread_missing (not throws) from compareFreshnessSnapshot when thread is absent", async () => {
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    // compareFreshnessSnapshot inner call to captureFreshnessSnapshot returns null for a missing thread.
    const db = createSequenceDb([[], [], []]);
    const result = await compareFreshnessSnapshot(db as never, "ghost-thread", snapshot!);
    expect(result).toEqual({ fresh: false, reason: "thread_missing" });
  });

  it("captures the thread freshness snapshot", async () => {
    const db = createSequenceDb([[baseThread], [baseHuman], [baseScope]]);

    await expect(captureFreshnessSnapshot(db as never, "thread-1")).resolves.toEqual({
      threadId: "thread-1",
      threadStatus: "active",
      threadPhase: "scope",
      entrySeq: 6,
      latestHumanEntryId: "entry-6",
      latestHumanSeq: 6,
      latestScopeVersionId: "scope-v1",
      latestScopeVersionNumber: 1,
      latestScopeVersionStatus: "draft",
      latestScopeSourceEndSeq: 6,
    });
  });

  it("returns fresh when the thread has not advanced", async () => {
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
      snapshot,
    );

    expect(result).toEqual({ fresh: true });
  });

  it("marks stale when a newer human entry arrives", async () => {
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    const newerThread = { ...baseThread, entrySeq: 7 };
    const newerHuman = { id: "entry-7", seq: 7, createdAt: new Date("2026-06-15T10:03:00Z") };

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[newerThread], [newerHuman], [baseScope]]) as never,
      "thread-1",
      snapshot,
    );

    expect(result).toEqual({ fresh: false, reason: "newer_human_entry" });
  });

  it("marks stale when a newer scope version appears", async () => {
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    const newerScope = {
      id: "scope-v2",
      versionNumber: 2,
      status: "draft",
      sourceEndSeq: 6,
      createdAt: new Date("2026-06-15T10:04:00Z"),
    };

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [newerScope]]) as never,
      "thread-1",
      snapshot,
    );

    expect(result).toEqual({ fresh: false, reason: "newer_scope_version" });
  });

  it("marks done threads stale for controller commits", async () => {
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[{ ...baseThread, phase: "done" }], [baseHuman], [baseScope]]) as never,
      "thread-1",
      snapshot,
    );

    expect(result).toEqual({ fresh: false, reason: "thread_done" });
  });

  it("does NOT suppress a scope-coupled action whose only scope advance is its OWN batch's draft", async () => {
    // A-M7: in one thread-scoped batch, a sibling create_scope_draft commits FIRST,
    // minting a new draft (scope-v2) → that becomes the live latestScopeVersionId.
    // A scope-coupled add_scope_item snapshotted at scope-v1 would otherwise be
    // suppressed as `newer_scope_version`, even though its commit will REUSE that very
    // draft (createDraftFromThread early-returns the existing draft). Threading the
    // batch-produced version id (scope-v2) must mark it FRESH, not stale.
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    const newerScope = {
      id: "scope-v2",
      versionNumber: 2,
      status: "draft",
      sourceEndSeq: 6,
      createdAt: new Date("2026-06-15T10:04:00Z"),
    };

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [newerScope]]) as never,
      "thread-1",
      snapshot,
      "add_scope_item",
      "scope-v2", // batchProducedScopeVersionId — the draft a sibling action just produced
    );

    expect(result).toEqual({ fresh: true });
  });

  it("STILL suppresses a scope-coupled action when the scope advanced and no batch draft was produced", async () => {
    // A-M7 guard: with no batch-produced draft id (undefined), the genuine
    // cross-actor scope advance still suppresses — behavior unchanged.
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    const newerScope = {
      id: "scope-v2",
      versionNumber: 2,
      status: "draft",
      sourceEndSeq: 6,
      createdAt: new Date("2026-06-15T10:04:00Z"),
    };

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [newerScope]]) as never,
      "thread-1",
      snapshot,
      "add_scope_item",
      undefined,
    );

    expect(result).toEqual({ fresh: false, reason: "newer_scope_version" });
  });

  it("STILL suppresses a scope-coupled action when the live scope is a DIFFERENT version than the batch draft", async () => {
    // A-M7 guard: a genuine cross-actor advance to scope-v2 while THIS batch only
    // produced scope-v3 must NOT be excused — the batch draft id does not match the
    // live latestScopeVersionId, so the suppression still fires.
    const snapshot = await captureFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
    );
    const newerScope = {
      id: "scope-v2",
      versionNumber: 2,
      status: "draft",
      sourceEndSeq: 6,
      createdAt: new Date("2026-06-15T10:04:00Z"),
    };

    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [newerScope]]) as never,
      "thread-1",
      snapshot,
      "add_scope_item",
      "scope-v3", // batch produced a different draft than the live one
    );

    expect(result).toEqual({ fresh: false, reason: "newer_scope_version" });
  });

  it("reports snapshot_unavailable (not newer_human_entry) for an empty snapshot", async () => {
    // When captureFreshnessSnapshot threw at run start, the stored snapshot is
    // empty `{}`. The live thread has a human entry, so the legacy code reported
    // `newer_human_entry` (a FALSE human-conflict reason). It must now report a
    // distinct `snapshot_unavailable` reason instead.
    const result = await compareFreshnessSnapshot(
      createSequenceDb([[baseThread], [baseHuman], [baseScope]]) as never,
      "thread-1",
      {} as never,
    );

    expect(result).toEqual({ fresh: false, reason: "snapshot_unavailable" });
  });
});

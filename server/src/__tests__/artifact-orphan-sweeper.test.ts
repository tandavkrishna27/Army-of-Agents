// DAT-009 slice 2 §4.3 — the sweep RUNNER (the impure half), exercised with injected deps.
//
// The eligibility DECISION is tested separately in artifact-orphan-sweep.test.ts. This
// suite is about what the runner DOES with those decisions: what it deletes, in what
// order, what it reports, and — most importantly — what it does when a delete fails.

import { describe, expect, it, vi } from "vitest";

import { runArtifactOrphanSweep, type SweepCandidateRow } from "../services/artifact-orphan-sweeper.js";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const expired = new Date(NOW.getTime() - 60_000).toISOString();
const live = new Date(NOW.getTime() + 60_000).toISOString();

function row(over: Partial<SweepCandidateRow> = {}): SweepCandidateRow {
  return {
    id: "row-1",
    status: "granted",
    objectKey: "organizations/org_1/jobs/job_1/attempts/0/evidence.png",
    expiresAt: expired,
    hasCommittedSibling: false,
    ...over,
  };
}

function deps(rows: SweepCandidateRow[], over: Partial<Parameters<typeof runArtifactOrphanSweep>[0]> = {}) {
  return {
    findCandidates: vi.fn(async () => rows),
    deleteObject: vi.fn(async () => {}),
    markSwept: vi.fn(async () => {}),
    now: NOW,
    limit: 100,
    ...over,
  };
}

describe("DAT-009 slice 2 — orphan sweep runner", () => {
  it("deletes the object and marks the row for an eligible orphan", async () => {
    const d = deps([row()]);
    const report = await runArtifactOrphanSweep(d);
    expect(d.deleteObject).toHaveBeenCalledWith("organizations/org_1/jobs/job_1/attempts/0/evidence.png");
    expect(d.markSwept).toHaveBeenCalledWith("row-1");
    expect(report.swept).toBe(1);
    expect(report.examined).toBe(1);
  });

  it("★ DELETES BEFORE MARKING — never the other way round", async () => {
    // If the row were marked swept first and the delete then failed, the object would
    // survive with no record pointing at it: an orphan that is now invisible to the very
    // mechanism built to find orphans. Deleting first means the worst case is a retry.
    const order: string[] = [];
    const d = deps([row()], {
      deleteObject: vi.fn(async () => { order.push("delete"); }),
      markSwept: vi.fn(async () => { order.push("mark"); }),
    });
    await runArtifactOrphanSweep(d);
    expect(order).toEqual(["delete", "mark"]);
  });

  it("★ does NOT mark the row when the delete fails", async () => {
    // The row must stay sweepable so the next run retries. Marking it would strand a
    // live object permanently.
    const d = deps([row()], { deleteObject: vi.fn(async () => { throw new Error("s3 down"); }) });
    const report = await runArtifactOrphanSweep(d);
    expect(d.markSwept).not.toHaveBeenCalled();
    expect(report.swept).toBe(0);
    expect(report.failed).toBe(1);
  });

  it("★ never deletes an orphan whose artifact was committed", async () => {
    // The happy-path shape: the granted intent survives its own commit and names the
    // same object. Deleting here destroys a committed, immutable artifact.
    const d = deps([row({ hasCommittedSibling: true })]);
    const report = await runArtifactOrphanSweep(d);
    expect(d.deleteObject).not.toHaveBeenCalled();
    expect(report.swept).toBe(0);
    expect(report.refusals.committed_sibling_exists).toBe(1);
  });

  it("never deletes a grant that can still be redeemed", async () => {
    const d = deps([row({ expiresAt: live })]);
    const report = await runArtifactOrphanSweep(d);
    expect(d.deleteObject).not.toHaveBeenCalled();
    expect(report.refusals.grant_still_redeemable).toBe(1);
  });

  it("surfaces refusals that need an operator, and not the ordinary ones", async () => {
    const d = deps([row({ objectKey: null }), row({ id: "row-2", expiresAt: live })]);
    const report = await runArtifactOrphanSweep(d);
    expect(report.actionable).toEqual([{ id: "row-1", reason: "no_object_key" }]);
  });

  it("keeps going after one candidate fails", async () => {
    const d = deps([row({ id: "a" }), row({ id: "b" })], {
      deleteObject: vi.fn(async (key: string) => { if (key.includes("evidence")) throw new Error("boom"); }),
    });
    const report = await runArtifactOrphanSweep(d);
    expect(report.examined).toBe(2);
    expect(report.failed).toBe(2);
  });

  it("★ anti-vacuity: a run that examined nothing says so rather than reporting success", async () => {
    // A sweep that found nothing to sweep is indistinguishable from a broken query. The
    // report must let the caller tell those apart.
    const report = await runArtifactOrphanSweep(deps([]));
    expect(report.examined).toBe(0);
    expect(report.examinedNothing).toBe(true);
  });

  it("passes the limit and the expiry boundary through to the query", async () => {
    const d = deps([], { limit: 25 });
    await runArtifactOrphanSweep(d);
    expect(d.findCandidates).toHaveBeenCalledWith({ before: NOW, limit: 25 });
  });
});

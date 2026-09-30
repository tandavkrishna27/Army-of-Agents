/**
 * artifact-orphan-sweeper.ts — DAT-009 slice 2 §4.3, the sweep RUNNER.
 *
 * Deletes the objects left behind when a presigned PUT outlives the fence that
 * authorised it: the fence is checked only at mint, so a lease lost mid-flight still
 * lets the upload land, and commit then refuses `stale_fence`. Nothing collected those
 * bytes — `deleteObject` has two call sites in the whole repo, both task attachments,
 * and there is no S3 lifecycle rule.
 *
 * Every eligibility question is delegated to the pure decision in
 * `artifact-orphan-sweep.ts`. This module owns only the sequencing and the report.
 *
 * ★ THE ORDER IS THE CORRECTNESS PROPERTY. Delete the object, THEN mark the row. Marking
 * first and failing the delete would leave a live object with no record pointing at it —
 * an orphan invisible to the very mechanism built to find orphans, and unreachable
 * forever because the storage port cannot list. Deleting first makes the worst case a
 * retry on the next run.
 */

import { isSweepEligible, type ArtifactSweepCandidate, type SweepRefusal, sweepRefusalIsActionable } from "./artifact-orphan-sweep.js";

export interface SweepCandidateRow extends ArtifactSweepCandidate {
  readonly id: string;
}

export interface SweepReport {
  /** How many candidate rows the query returned. */
  examined: number;
  /**
   * ★ True when the run had nothing to look at. A sweep that found nothing is otherwise
   * indistinguishable from a broken query returning an empty set, and "OK (0 swept)"
   * reads as health in both cases. The caller decides what to do; it is not hidden.
   */
  examinedNothing: boolean;
  swept: number;
  /** Candidates that were eligible but whose delete threw. They stay sweepable. */
  failed: number;
  refusals: Partial<Record<SweepRefusal, number>>;
  /** Refusals that can never resolve themselves and need a human. */
  actionable: Array<{ id: string; reason: SweepRefusal }>;
}

export interface SweepDeps {
  findCandidates(input: { before: Date; limit: number }): Promise<SweepCandidateRow[]>;
  deleteObject(objectKey: string): Promise<void>;
  markSwept(id: string): Promise<void>;
  now: Date;
  limit: number;
}

export async function runArtifactOrphanSweep(deps: SweepDeps): Promise<SweepReport> {
  const candidates = await deps.findCandidates({ before: deps.now, limit: deps.limit });

  const report: SweepReport = {
    examined: candidates.length,
    examinedNothing: candidates.length === 0,
    swept: 0,
    failed: 0,
    refusals: {},
    actionable: [],
  };

  for (const candidate of candidates) {
    const decision = isSweepEligible(candidate, deps.now);
    if (!decision.eligible) {
      report.refusals[decision.reason] = (report.refusals[decision.reason] ?? 0) + 1;
      // The refusal reason is CARRIED, not discarded. A reason that can never resolve
      // itself accumulates in silence otherwise — and the query filters on status and
      // expiry only, so such a row is returned on every future run for ever.
      if (sweepRefusalIsActionable(decision.reason)) {
        report.actionable.push({ id: candidate.id, reason: decision.reason });
      }
      continue;
    }

    // Eligible implies a non-null objectKey (the decision refuses otherwise), but the
    // type does not know that.
    const objectKey = candidate.objectKey!;
    try {
      // ★ DELETE FIRST. See the module header — marking first strands a live object.
      await deps.deleteObject(objectKey);
      await deps.markSwept(candidate.id);
      report.swept += 1;
    } catch {
      // One candidate's failure must not abandon the rest: a single unreachable object
      // would otherwise stop every later orphan in the batch from being collected. The
      // row is left `granted`, so the next run retries it.
      report.failed += 1;
    }
  }

  return report;
}

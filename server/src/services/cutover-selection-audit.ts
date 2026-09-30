/**
 * cutover-selection-audit.ts — DE-20's `audit` clause, SELECTION HALF (conjunct 4a).
 *
 * ★ THE DEFECT THIS CLOSES, MEASURED AT `6b39c77f6`.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-20 asserts
 * "cutover selection and rollback transitions are audited". Half of the
 * SELECTION conjunct was delivered and half was not, and the missing half was
 * the one an operator needs most:
 *
 *   ★ CITED BY SYMBOL, LINE AS A HINT ONLY. Line numbers rot — twice inside this
 *   very PR — and the symbol is the handle. Every hint below was re-measured at
 *   HEAD, not carried from the base commit.
 *
 *   - a DISTRIBUTED selection writes one `distributed_execution_handoff`
 *     `heartbeat_run_events` row: the `appendRunEvent(...)` call inside
 *     `markRunHandedOffToDistributed` (`heartbeat.ts`, ~`:6994`);
 *   - a LEGACY selection wrote NOTHING DURABLE AT ALL. The
 *     `canaryExecutionOwner = canaryWorkload.ok ? … : { owner: "legacy", … }`
 *     assignment resolves it (~`:5316-5337`), `shouldSuppressLegacyExecution`
 *     (~`:5457`) is false, and control falls straight through to
 *     `adapter.execute` (~`:5511`). The only trace was a `logger.info` line.
 *
 *   ★ THE NOTE THIS REPLACES ASSERTED A CAUSAL SHIFT THAT DID NOT HAPPEN: it
 *   claimed the append this module feeds shifted those three lines. The append
 *   sits BELOW the assignment and moved it not at all; the drift came from
 *   elsewhere in the file. Reciting a delta is not measuring one.
 *
 * So "the cutover selected legacy for this run" was INDISTINGUISHABLE, in the
 * database, from "this run was never a cutover candidate at all" — which is the
 * exact blindness `heartbeat.ts`'s own comment above that logger already names:
 * "a canary that silently stayed legacy because of a missing workload would have
 * been indistinguishable, in aggregate, from one that was simply not a canary".
 * That comment fixed the LOG. This fixes the RECORD.
 *
 * ★ ONE WRITE, BOTH ARMS — the structural point, and the reason this is not two
 * writers. The event is appended at the SINGLE site immediately after
 * `canaryExecutionOwner` is assigned and BEFORE the suppression branch reads it.
 * A per-arm writer would let a future edit audit one arm and not the other,
 * which is the defect being repaired. `de-20-cutover-selection-audit` asserts
 * that position structurally, because nothing else in this repo can:
 * `executeRun` is ~2,700 lines with a dependency surface that is impractical to
 * instantiate in-process (the standing CLI-003/005/006 limitation).
 *
 * ★ WHAT THIS DOES NOT DELIVER, AND IS NOT CLAIMED.
 * DE-20's `audit` clause is a CONJUNCTION: "cutover selection AND ROLLBACK
 * TRANSITIONS are audited". The ROLLBACK conjunct (4b) is VACUOUS and untouched
 * here: `createDistributedExecutionDrain`
 * (`server/src/services/job-distributed-drain.ts:114`) has zero production
 * callers, so removing an organization from the rollout dial cancels nothing in
 * flight — there is no rollback transition, so there is no transition event.
 * That conjunct is `E0-F013` Decision 1's to rule on and `E0-F014`'s to own.
 * HALF A CONJUNCTION IS NOT THE CONJUNCTION: **DE-20 DOES NOT CLOSE.**
 *
 * ★ AND ONE THING NEITHER HALF FIXES. DE-20's enforcement has never been
 * exercised in a deployment — the rollout source has zero deployment hits, so
 * the suppression return at `heartbeat.ts` is proven only in CI. A selection
 * event does not change that; it means that when the cutover IS first run for
 * real, both of its outcomes leave a row.
 *
 * Pure by construction: this module builds the event, and `heartbeat.ts` owns
 * the append (it holds `appendRunEvent`, the db handle and the seq base). That
 * split is what makes the payload testable without instantiating `executeRun`.
 */
import type { RunExecutionOwner } from "./run-execution-owner.js";

/**
 * The event type for the cutover selection decision. Distinct from
 * `distributed_execution_handoff`, which records a DIFFERENT fact — that the
 * handoff marker landed — and is written later, only on the distributed arm,
 * and only after `markRunHandedOffToDistributed`'s critical UPDATE succeeds.
 * Folding the two would make "the selection was recorded" depend on the marker
 * write, which is the coupling this crossing cannot afford.
 */
export const CUTOVER_SELECTION_EVENT_TYPE = "distributed_execution_selection";

export interface CutoverSelectionEvent {
  readonly eventType: typeof CUTOVER_SELECTION_EVENT_TYPE;
  readonly stream: "system";
  readonly level: "info";
  readonly message: string;
  readonly payload: {
    /** The arm the cutover selected. THE field this record exists for. */
    readonly owner: "distributed" | "legacy";
    /** Present only on the distributed arm; null on legacy, where no job exists. */
    readonly jobId: string | null;
    readonly attemptId: string | null;
    /**
     * Why legacy was selected — the `LegacyOwnerReason` the resolver produced.
     * Null on the distributed arm. Without this the legacy row would say a
     * selection happened and never say why, which is the count-only shape this
     * crossing already had at the metric layer.
     */
    readonly reason: string | null;
    /** The resolver's free-text detail, when it carried one. */
    readonly detail: string | null;
  };
}

/**
 * Build the durable selection record for EITHER arm. Total over
 * `RunExecutionOwner`: there is no input that produces no event, which is what
 * makes "both arms are audited" a property of the type rather than of a reviewer
 * remembering to add the second call.
 */
export function buildCutoverSelectionEvent(owner: RunExecutionOwner): CutoverSelectionEvent {
  if (owner.owner === "distributed") {
    return {
      eventType: CUTOVER_SELECTION_EVENT_TYPE,
      stream: "system",
      level: "info",
      message: `Cutover selected DISTRIBUTED — job ${owner.jobId}, attempt ${owner.attemptId}`,
      payload: {
        owner: "distributed",
        jobId: owner.jobId,
        attemptId: owner.attemptId,
        reason: null,
        detail: null,
      },
    };
  }
  return {
    eventType: CUTOVER_SELECTION_EVENT_TYPE,
    stream: "system",
    level: "info",
    message: `Cutover selected LEGACY — ${owner.reason}`,
    payload: {
      owner: "legacy",
      jobId: null,
      attemptId: null,
      reason: owner.reason,
      detail: owner.detail ?? null,
    },
  };
}

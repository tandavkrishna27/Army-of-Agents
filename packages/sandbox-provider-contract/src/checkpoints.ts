// -----------------------------------------------------------------------------
// Lifecycle checkpoints + fault-injection vocabulary (provider-neutral).
//
// These are the fake harness's OWN lifecycle checkpoints — the points at which a
// scripted run can have a fault injected. They are deliberately distinct from the
// frozen `PROVIDER_OPERATIONS` vocabulary (a checkpoint is a moment in a run; a
// provider operation is a driver call), though several coincide by name. No
// checkpoint is invented outside this closed set, and it is the single source of
// truth both the contract suite and the fake provider script against.
// -----------------------------------------------------------------------------

/**
 * The eight ordered lifecycle checkpoints a scripted sandbox run passes through.
 * A `failureInjection.point` matches one of these names; the acceptance requires
 * a fault to be injectable at EACH of them.
 */
export const LIFECYCLE_CHECKPOINTS = [
  "create",
  "execute",
  "event",
  "hang",
  "cancel",
  "crash",
  "checkpoint",
  "destroy",
] as const;
export type LifecycleCheckpoint = (typeof LIFECYCLE_CHECKPOINTS)[number];

const LIFECYCLE_CHECKPOINT_SET: ReadonlySet<string> = new Set(LIFECYCLE_CHECKPOINTS);

/** True iff `value` is one of the eight closed lifecycle checkpoints. */
export function isLifecycleCheckpoint(value: unknown): value is LifecycleCheckpoint {
  return typeof value === "string" && LIFECYCLE_CHECKPOINT_SET.has(value);
}

/**
 * A fault injected into a scripted run at a lifecycle checkpoint. `effect` is an
 * opaque, provider-neutral label (the FND-004 fixtures declare values such as
 * `cancel_requested`, `worker_process_crash`, `lease_lost`, `budget_exhausted`,
 * `provider_pause`, `metadata_destination`, `plaintext_secret_in_argv`); the
 * harness never enumerates it — it records and replays whatever the fixture/test
 * declares so the double stays faithful.
 */
export interface FailureInjection {
  readonly point: LifecycleCheckpoint;
  readonly effect: string;
}

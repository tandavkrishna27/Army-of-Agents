// -----------------------------------------------------------------------------
// FND-004 fixture runtime: fail-closed validation, deterministic run-plan
// derivation, and event-digest recompute.
//
// A fixture is loaded/validated fail-closed: structural zod validation PLUS a
// recompute-and-verify of every `expectedEvent.eventDigest` through the shared
// worker-protocol digest helpers. An event whose digest does not verify (a
// tampered fixture) is REJECTED rather than partially scripted. Scripted events
// are re-emitted with a RECOMPUTED digest so two replays of one fixture are
// byte-identical. The fixture events are the FND-004 golden-journey subset (their
// own `schema-v1.json` shape), NOT the strict wire `workerEventV1Schema` — so
// only the digest, not the strict event schema, is asserted here.
// -----------------------------------------------------------------------------

import { z } from "zod";
import { canonicalEventDigestInputV1, verifyWorkerEventDigestV1 } from "@armyofagents/worker-protocol";

import { sha256Hex } from "./hash.js";

/** The eight ordered lifecycle checkpoints — a structural mirror of the contract
 * package's `LIFECYCLE_CHECKPOINTS` (the fake never imports the contract at
 * runtime; the contract-self test asserts the two lists are identical). */
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

export function isLifecycleCheckpoint(value: unknown): value is LifecycleCheckpoint {
  return typeof value === "string" && LIFECYCLE_CHECKPOINT_SET.has(value);
}

export interface FailureInjection {
  readonly point: LifecycleCheckpoint;
  readonly effect: string;
}

/** Raised (fail-closed) when a fixture does not validate structurally or an
 * `expectedEvent` digest does not verify. */
export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureValidationError";
  }
}

const stepSchema = z
  .object({
    action: z.string().min(1),
    at: z.string().optional(),
    emits: z.array(z.string()).optional(),
  })
  .passthrough();

const fixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    workloadType: z.enum(["batch", "browser_session", "service"]),
    steps: z.array(stepSchema).min(1),
    failureInjection: z
      .object({ point: z.string().min(1), effect: z.string().min(1) })
      .passthrough()
      .nullable(),
    expectedEvents: z.array(z.record(z.unknown())),
    cleanup: z.object({ authority: z.string().min(1) }).passthrough(),
    control: z
      .object({
        cancellation: z.string().min(1),
        productApproval: z.string().min(1),
        runtimeDecision: z.string().min(1),
      })
      .passthrough(),
    expected: z.object({ terminalState: z.string().min(1) }).passthrough(),
  })
  .passthrough();

export type ValidatedFixture = z.infer<typeof fixtureSchema>;

/**
 * Validate a raw fixture object fail-closed: structure + per-event digest verify.
 * Throws {@link FixtureValidationError} on any structural or digest failure.
 */
export async function validateFixture(raw: unknown): Promise<ValidatedFixture> {
  const parsed = fixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FixtureValidationError(`fixture failed structural validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const fixture = parsed.data;
  for (let i = 0; i < fixture.expectedEvents.length; i += 1) {
    const event = fixture.expectedEvents[i];
    if (typeof event.eventDigest !== "string") {
      throw new FixtureValidationError(`fixture ${fixture.id} event[${i}] has no string eventDigest`);
    }
    const verified = await verifyWorkerEventDigestV1(event, sha256Hex);
    if (!verified) {
      throw new FixtureValidationError(`fixture ${fixture.id} event[${i}] (${String(event.eventType)}) failed digest verification`);
    }
  }
  return fixture;
}

/**
 * Re-emit a fixture's events with a RECOMPUTED `eventDigest`. Because a valid
 * fixture's stored digest already matches, the recomputed value is identical and
 * the emitted event deep-equals the fixture event — making two replays
 * byte-identical. A caller that mutated a payload would see the digest diverge
 * (the non-vacuousness of the recompute).
 */
export function emitFixtureEvents(fixture: ValidatedFixture): Array<Record<string, unknown>> {
  return fixture.expectedEvents.map((event) => {
    const recomputed = sha256Hex(canonicalEventDigestInputV1(event));
    return { ...event, eventDigest: recomputed };
  });
}

export interface RunStep {
  readonly checkpoint: LifecycleCheckpoint;
  readonly op: string;
}

export interface RunPlan {
  readonly forward: readonly RunStep[];
  readonly teardown: readonly RunStep[];
}

const CRASH_EFFECTS: ReadonlySet<string> = new Set(["worker_process_crash", "lease_lost", "provider_pause"]);
const CHECKPOINT_DECISIONS: ReadonlySet<string> = new Set(["checkpoint_restore", "provider_pause_resume"]);

/**
 * Derive a deterministic run plan from a fixture. `includeAllCheckpoints` forces
 * every one of the eight lifecycle checkpoints to be present (used by the
 * per-checkpoint fault-injection acceptance); otherwise the plan reflects only
 * the checkpoints the fixture models. Teardown (destroy → list → reconcile) ALWAYS
 * runs, so resources reach zero even after an injected fault.
 */
export function derivePlan(fixture: ValidatedFixture, includeAllCheckpoints = false): RunPlan {
  const forward: RunStep[] = [
    { checkpoint: "create", op: "create" },
    { checkpoint: "execute", op: "execute" },
  ];
  if (fixture.expectedEvents.length > 0 || includeAllCheckpoints) {
    forward.push({ checkpoint: "event", op: "inspect" });
  }
  if (includeAllCheckpoints) {
    forward.push({ checkpoint: "hang", op: "inspect" });
  }
  if (fixture.control.cancellation !== "none" || includeAllCheckpoints) {
    forward.push({ checkpoint: "cancel", op: "cancel" });
  }
  const crashLike = CRASH_EFFECTS.has(fixture.failureInjection?.effect ?? "") || includeAllCheckpoints;
  if (crashLike) {
    forward.push({ checkpoint: "crash", op: "kill" });
  }
  const checkpointLike =
    CHECKPOINT_DECISIONS.has(fixture.control.runtimeDecision) ||
    fixture.steps.some((s) => s.action === "commit_checkpoint") ||
    includeAllCheckpoints;
  if (checkpointLike) {
    forward.push({ checkpoint: "checkpoint", op: "checkpoint" });
    forward.push({ checkpoint: "checkpoint", op: "restore" });
  }
  const teardown: RunStep[] = [
    { checkpoint: "destroy", op: "destroy" },
    { checkpoint: "destroy", op: "list" },
    { checkpoint: "destroy", op: "reconcile_cleanup" },
  ];
  return { forward, teardown };
}

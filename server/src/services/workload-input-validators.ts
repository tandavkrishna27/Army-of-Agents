// server/src/services/workload-input-validators.ts
//
// BRW-001 — the per-workload-type input validator registry.
//
// THE HAZARD IS GENERAL, NOT BROWSER-SPECIFIC. `buildJobEnvelope` (job-leasing.ts) passes
// the job's raw `input` blob through as the workload for ALL THREE frozen workload types:
//
//     workloadType: input.job.workloadType,
//     workload:     input.job.input,          <-- untyped, straight through
//
// gated only by `jobEnvelopeV1Schema.safeParse`, which returns null — and therefore NO
// LEASE — on any mismatch. Meanwhile the submission surface types `input` as
// `z.record(z.unknown())`, bounded only at 64 KiB. So for every workload type, an input
// that does not exactly satisfy its strict frozen schema submits fine and then silently
// never leases.
//
// DECLARED IS NOT ENFORCED. This registry declares a slot for EVERY frozen workload type,
// because that is what turns "this workload type has no validator" into a test failure
// rather than an invisible default. It ENFORCES only `browser_session`, which is the
// workload BRW-001 owns.
//
//     batch            declared, NOT enforced -> input passes through byte-identically
//     browser_session  declared, ENFORCED     -> normalised to the frozen workload shape
//     service          declared, ENFORCED     -> SVC-001; normalised, ingress refused
//
// SVC-001 promoted `service` from not_enforced to enforced. Before that promotion a
// service job carrying {"port": 8080} was accepted with 201, persisted and hashed, and
// then died silently at envelope parse with no lease and no error.
//
// A `not_enforced` slot is deliberately inert: it returns the caller's input unchanged, so
// adding this registry changes the runtime behaviour of the paths this epic does not own by
// exactly zero bytes. Promoting a slot to `enforced` is a real behaviour change and is
// guarded by tests.
import { WORKLOAD_TYPES, type WorkloadType } from "@armyofagents/worker-protocol";
import { normalizeBrowserJobInput } from "./browser-job-config.js";
import { normalizeServiceJobInput } from "./service-job-config.js";

export type WorkloadInputValidationResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/** An enforcing slot: the workload's input is validated and normalised at submit time. */
interface EnforcedValidatorSlot {
  readonly status: "enforced";
  readonly validate: (raw: unknown) => WorkloadInputValidationResult;
}

/** A declared-but-inert slot. `reason` states why enforcement has not been wired, so an
 * unenforced workload is a recorded decision rather than an oversight. */
interface NotEnforcedValidatorSlot {
  readonly status: "not_enforced";
  readonly reason: string;
}

export type WorkloadValidatorSlot = EnforcedValidatorSlot | NotEnforcedValidatorSlot;

export const WORKLOAD_INPUT_VALIDATORS: Readonly<Record<WorkloadType, WorkloadValidatorSlot>> =
  Object.freeze({
    batch: {
      status: "not_enforced",
      reason:
        "Batch input construction belongs to the epic that owns the live execution cutover path. " +
        "Enforcing it from this lane would change that path's runtime behaviour, which the " +
        "cross-lane deconfliction contract forbids without coordination.",
    },
    browser_session: {
      status: "enforced",
      validate: (raw: unknown): WorkloadInputValidationResult => {
        const result = normalizeBrowserJobInput(raw);
        return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
      },
    },
    service: {
      status: "enforced",
      validate: (raw: unknown): WorkloadInputValidationResult => {
        const result = normalizeServiceJobInput(raw);
        return result.ok ? { ok: true, value: result.value } : { ok: false, reason: result.reason };
      },
    },
  } satisfies Record<WorkloadType, WorkloadValidatorSlot>);

const DECLARED_WORKLOAD_TYPES = new Set<string>(WORKLOAD_TYPES);

/**
 * Validate one job's submission input against its workload type.
 *
 * An ENFORCED workload type is normalised to its frozen shape or refused with a typed
 * reason. A NOT-ENFORCED workload type gets its input back untouched — the registry is
 * inert for those by design. An unknown workload type fails closed.
 *
 * Pure and synchronous. Callers must run this AFTER their authorization gate so that a
 * denied caller cannot distinguish a malformed input from a valid one.
 */
export function validateWorkloadInput(
  workloadType: string,
  raw: unknown,
): WorkloadInputValidationResult {
  if (!DECLARED_WORKLOAD_TYPES.has(workloadType)) {
    return { ok: false, reason: "unknown_workload_type" };
  }
  const slot = WORKLOAD_INPUT_VALIDATORS[workloadType as WorkloadType];
  if (slot.status === "enforced") return slot.validate(raw);
  // Inert by design: the caller's input is returned exactly as supplied.
  return { ok: true, value: raw as Record<string, unknown> };
}

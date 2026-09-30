// server/src/services/distributed-shadow-port.ts
//
// MIG-005/006/007 (Lane C) — the ONE seam the three non-heartbeat execution sinks call.
//
// WHY A MODULE-LEVEL PORT rather than a constructor option. Commander turns
// (`internal-agent/cli-mode.ts`), crew dispatch (`internal-agent/aoa-agents/runner.ts`)
// and one-shot operations (`one-shot-sandbox-cli.ts`) are reached from many call sites
// that each hold a bare `db`, exactly like the `cancelRun` callers that led
// `setDistributedCancellationPort` to the same shape (`index.ts`). A constructor option
// would be `undefined` at every real call — wired-looking and inert.
//
// UNREGISTERED IS A NO-OP. A deployment that never composes a recorder is byte-identical:
// `recordDistributedShadow` returns immediately. The composition root registers it in the
// same block that composes the comparator, i.e. only when distributed execution is on.
//
// NOTHING HERE MAY FAIL A LIVE OPERATION. These sinks are user-visible — a Commander turn,
// a crew dispatch, an extraction. Every failure direction is swallowed and recorded.

import type { SubmitJobSource } from "@armyofagents/shared";
import { submitJobSourceWorkloadType } from "@armyofagents/shared";
import type { AdmissibilityProbeInput, AdmissibilityVerdict } from "./job-shadow-admissibility.js";
import type { JobShadowComparator, LegacyRunExecutionSnapshot } from "./job-shadow-comparator.js";

/**
 * How long a shadow probe may hold up the live operation it observes (D5b).
 *
 * Admission is a handful of indexed lookups, so this is generous rather than tight; it
 * exists so a slow or wedged database degrades the OBSERVABILITY record instead of the
 * Commander turn. A timeout is recorded as `admissible: null` — data, not agreement.
 */
export const SHADOW_PROBE_DEADLINE_MS = 2_000;

/** What a sink knows at its seam. Identity travels inside `source` (design D3). */
export interface ShadowSinkInput {
  readonly companyId: string;
  readonly source: SubmitJobSource;
  readonly principal: { readonly kind: string; readonly id: string; readonly role?: string };
  readonly routing: { readonly executionTargetType: string };
  readonly policy: {
    readonly model: string | null;
    readonly budgetPolicyId: string | null;
    readonly effectiveCompletionPolicy: string;
  };
  readonly workloadCharacterization: LegacyRunExecutionSnapshot["workloadCharacterization"];
}

export interface DistributedShadowPort {
  record(input: ShadowSinkInput): Promise<void>;
}

let port: DistributedShadowPort | null = null;

/** Register (or, with `null`, clear) the process-wide recorder. */
export function setDistributedShadowPort(next: DistributedShadowPort | null): void {
  port = next;
}

/**
 * Record one shadow observation. A no-op when nothing is registered, and it NEVER throws
 * or rejects — the caller is a live user path and must not learn that shadow exists.
 */
export async function recordDistributedShadow(input: ShadowSinkInput): Promise<void> {
  const current = port;
  if (!current) return;
  try {
    await current.record(input);
  } catch {
    // Observability only.
  }
}

export interface DistributedShadowRecorderDeps {
  /** Resolves `off | shadow | active | canary` plus the Organization, flag-first. */
  resolveRolloutState(input: {
    companyId: string;
    /** MIG-002 per-sink axis — the sink whose rollout is being resolved. */
    sourceKind?: string;
  }): Promise<{ state: string; organizationId: string | null }>;
  probe(input: AdmissibilityProbeInput): Promise<AdmissibilityVerdict>;
  comparator: Pick<JobShadowComparator, "compare">;
}

/** Resolve `promise` or, after `ms`, an undetermined verdict. Never rejects. */
async function withDeadline(
  promise: Promise<AdmissibilityVerdict>,
  ms: number,
): Promise<AdmissibilityVerdict> {
  const timeout = new Promise<AdmissibilityVerdict>((resolve) => {
    const handle = setTimeout(
      () => resolve({ admissible: null, reason: "probe_timeout", authoritiesChecked: [] }),
      ms,
    );
    // Do not hold the event loop open for a probe nobody is waiting on.
    handle.unref?.();
  });
  return Promise.race([
    promise.catch(
      (): AdmissibilityVerdict => ({
        admissible: null,
        reason: "probe_error",
        authoritiesChecked: [],
      }),
    ),
    timeout,
  ]);
}

export function createDistributedShadowRecorder(
  deps: DistributedShadowRecorderDeps,
): DistributedShadowPort {
  return {
    async record(input) {
      try {
        await recordOnce(deps, input);
      } catch {
        // The recorder is guarded HERE as well as in `recordDistributedShadow`. A guarded
        // action with a second unguarded door is a defect this programme has already paid
        // for once: any caller holding the recorder directly (a test, a future composition
        // root) must get the same never-throws contract.
      }
    },
  };
}

async function recordOnce(
  deps: DistributedShadowRecorderDeps,
  input: ShadowSinkInput,
): Promise<void> {
  const { state, organizationId } = await deps.resolveRolloutState({
    companyId: input.companyId,
    // Resolve the rollout for THIS sink. Without it, an Organization opted in for one sink
    // would arm every sink — the exact thing the per-sink axis exists to prevent.
    sourceKind: input.source.kind,
  });
  // ONLY shadow. `active`/`canary` are the cutover states and are owned by the
  // convert/placement path, not by an observability record.
  if (state !== "shadow" || !organizationId) return;

  const verdict = await withDeadline(
    deps.probe({
      organizationId,
      companyId: input.companyId,
      source: input.source,
      principal: input.principal,
    }),
    SHADOW_PROBE_DEADLINE_MS,
  );

  deps.comparator.compare(
    {
      organizationId,
      companyId: input.companyId,
      source: input.source,
      // The key a REAL submission computes, never one the seam invented.
      workloadType: submitJobSourceWorkloadType(input.source),
      routing: input.routing,
      provenance: {
        // What the legacy path resolved. The distributed side's answer is the
        // admissibility verdict, not a different string here.
        executionPrincipalKind: input.principal.kind,
        credentialKind: null,
      },
      policy: input.policy,
      workloadCharacterization: input.workloadCharacterization,
    },
    {
      admissible: verdict.admissible,
      // Carry the WHY, not just the verdict: a refusal nobody can explain is not
      // evidence, and `authoritiesChecked` is what makes the per-sink signal
      // asymmetry visible in the aggregate rather than only in a unit test.
      admissibilityReason: verdict.reason,
      admissibilityAuthorities: verdict.authoritiesChecked,
    },
  );
}

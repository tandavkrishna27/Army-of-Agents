/**
 * The uninstall plan (DSK-003 Lane B, I6/I7).
 *
 * THERE IS NO DEFAULT IDENTITY DISPOSITION, and that is the whole point. Neither
 * candidate default is safe:
 *
 *   - defaulting to RETAIN leaves a working device credential on a machine that is being
 *     decommissioned, sold, or returned; and
 *   - defaulting to REVOKE destroys an identity the operator may still need — and
 *     DSK-001 established that this is unrecoverable, because `findWorkerForBinding`
 *     (`packages/db/src/repositories/tenant/worker-enrollment.ts`) has NO status
 *     predicate, so even a revoked row keeps matching and blocks re-enrolment forever
 *     with no reset route.
 *
 * So "the operator did not say" is a REFUSAL. That is the same discipline
 * `--reset-identity` already uses with its explicit acknowledgement flag, and it is the
 * reason a near-miss like `keep` or `delete` is refused rather than interpreted: a typo
 * must never become a destructive action.
 *
 * THE ORDER IS A VALUE, NOT CONTROL FLOW. Returning an ordered step list — rather than
 * doing the work in sequence inside a function — makes "work stops before identity is
 * touched" a property a test can read directly, the same shape as
 * `lifecycle/shutdown.ts`'s `createLeaseLifecycleSteps`.
 *
 * Pure: no fs, no process, no clock. Executing the plan is the caller's job.
 */

/** The two dispositions, which are deliberate opposites with no middle ground. */
export const UNINSTALL_IDENTITY_POLICIES = ["retain", "revoke"] as const;
export type UninstallIdentityPolicy = (typeof UNINSTALL_IDENTITY_POLICIES)[number];

export const UNINSTALL_REFUSALS = ["no_identity_policy", "unknown_identity_policy"] as const;
export type UninstallRefusal = (typeof UNINSTALL_REFUSALS)[number];

/** One ordered step. `name` is the operator-facing description of what happens. */
export interface UninstallStep {
  readonly name: UninstallStepName;
  /** Why this step is where it is — surfaced in logs and in an operator confirmation. */
  readonly reason: string;
}

export type UninstallStepName =
  | "stop-leasing"
  | "drain"
  | "identity-retain"
  | "identity-destroy"
  | "stop-host";

export type UninstallPlan =
  | {
      readonly ok: true;
      readonly steps: readonly UninstallStep[];
      /** True only for `revoke`. Lets a caller require confirmation for the one that bites. */
      readonly destroysIdentity: boolean;
    }
  | { readonly ok: false; readonly reason: UninstallRefusal };

const POLICIES: ReadonlySet<string> = new Set(UNINSTALL_IDENTITY_POLICIES);

/**
 * Build the ordered uninstall plan for an explicit identity policy.
 *
 * Work stops first, always, and in the same lease-stop-before-drain order the shutdown
 * handler uses: stopping new leasing before draining is what prevents a fresh lease
 * arriving in the middle of a teardown. The identity step comes after all of it, because
 * an identity destroyed while work is still in flight strands that work with no way to
 * report it.
 */
export function planUninstall(input: { identityPolicy: UninstallIdentityPolicy }): UninstallPlan {
  const policy = input.identityPolicy as unknown;
  if (typeof policy !== "string" || policy.length === 0) {
    return { ok: false, reason: "no_identity_policy" };
  }
  if (!POLICIES.has(policy)) {
    return { ok: false, reason: "unknown_identity_policy" };
  }

  // Spelled `=== "revoke"`, never `!== "retain"`. Under the validation above the two are
  // EQUIVALENT — a mutation swapping them survives, correctly, because `POLICIES.has`
  // has already narrowed `policy` to exactly two values. They differ in BLAST RADIUS if
  // that guard is ever weakened or reordered: `=== "revoke"` fails toward retaining an
  // identity, `!== "retain"` fails toward destroying one. Only one of those is
  // recoverable, so the equivalent spellings are not equally good.
  const revoking = policy === "revoke";
  const steps: readonly UninstallStep[] = [
    {
      name: "stop-leasing",
      reason: "accept no new work before tearing anything down",
    },
    {
      name: "drain",
      reason: "let in-flight work finish or be fenced before the host goes away",
    },
    revoking
      ? {
          name: "identity-destroy",
          reason: "the operator asked to revoke: destroy the local device identity",
        }
      : {
          name: "identity-retain",
          reason: "the operator asked to retain: leave the device identity in OS storage",
        },
    {
      name: "stop-host",
      reason: "stop the background host last, so every step above could still report",
    },
  ];

  return { ok: true, steps, destroysIdentity: revoking };
}

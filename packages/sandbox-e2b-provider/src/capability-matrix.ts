// -----------------------------------------------------------------------------
// The CLI-001 capability-matrix disposition — a TYPED fixture (CLI-001/D5).
//
// It pins the template/image/policy the E2B driver is bound to, records each
// provider operation's support disposition, and records each hostile
// isolation/fencing/TTL/kill/inspect/cleanup case. A static lint
// (`capability-matrix.test.ts`) asserts that NO required case is marked
// unsupported — only the genuinely-optional `checkpoint`/`restore`/`health` ops
// may be `unsupported`, and only with a recorded fallback. The `verifiedBy` field
// records HOW each disposition is evidenced: `no-key-core` (in-process mock
// transport + static gates, lands CI-green now) or `keyed-lane` (the real-E2B
// `workflow_dispatch` lane, run when the operator supplies the provider-control key).
//
// The human-readable disposition record is
// `docs/replatform/epics/E7-coding-e2b/tickets/CLI-001-capability-matrix.md`;
// this fixture is its machine-checkable mirror.
// -----------------------------------------------------------------------------

import type { ProviderOperation } from "@armyofagents/worker-protocol";

export type VerifiedBy = "no-key-core" | "keyed-lane";

export interface OperationDisposition {
  readonly operation: ProviderOperation;
  /** Core ops (+ every isolation invariant) are required; optional ops are not. */
  readonly required: boolean;
  readonly supported: boolean;
  /** Required when `supported === false` — how the capability is otherwise met. */
  readonly fallback?: string;
  readonly verifiedBy: VerifiedBy;
}

export interface IsolationCaseDisposition {
  readonly id: string;
  readonly title: string;
  /** Isolation/fencing/TTL/kill/inspect/cleanup cases are ALWAYS required. */
  readonly required: true;
  readonly supported: boolean;
  readonly verifiedBy: VerifiedBy;
}

export interface CapabilityMatrix {
  /** Pinned provider-control surface (the "verified" limit set is completed by
   * the keyed lane; the no-key core pins the disposition SHAPE). */
  readonly pins: {
    readonly templateId: string;
    readonly image: string;
    readonly policyVersion: string;
    readonly limits: {
      readonly maxConcurrentSandboxes: number;
      readonly defaultTtlMs: number;
      readonly maxTtlMs: number;
    };
  };
  readonly operations: readonly OperationDisposition[];
  readonly isolationCases: readonly IsolationCaseDisposition[];
}

export const CLI_001_CAPABILITY_MATRIX: CapabilityMatrix = {
  pins: {
    // Pinned E2B template alias (the operator may override via the keyed lane's
    // `e2b_template` input; "base" installs the CLIs per-run).
    templateId: "aoa-base",
    image: "e2b/base",
    policyVersion: "cli-001-v1",
    limits: {
      // The no-key core pins the SHAPE; the keyed lane verifies the real numbers.
      maxConcurrentSandboxes: 50,
      defaultTtlMs: 60_000,
      maxTtlMs: 3_600_000,
    },
  },
  operations: [
    { operation: "create", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "execute", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "cancel", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "kill", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "destroy", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "list", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "inspect", required: true, supported: true, verifiedBy: "no-key-core" },
    { operation: "reconcile_cleanup", required: true, supported: true, verifiedBy: "no-key-core" },
    // Optional ops. `health` is supported (an E2B running probe). `checkpoint`/
    // `restore` are unsupported-with-fallback in the no-key default disposition —
    // E2B beta pause/resume is deferred to keyed-lane verification; the fallback
    // is full destroy + recreate from the pinned template.
    { operation: "health", required: false, supported: true, verifiedBy: "no-key-core" },
    {
      operation: "checkpoint",
      required: false,
      supported: false,
      fallback: "destroy + recreate from the pinned template (no live snapshot); E2B beta pause deferred to CLI-004/keyed lane",
      verifiedBy: "keyed-lane",
    },
    {
      operation: "restore",
      required: false,
      supported: false,
      fallback: "recreate from the pinned template + replay the workspace snapshot (DAT-001); E2B beta resume deferred to CLI-004/keyed lane",
      verifiedBy: "keyed-lane",
    },
  ],
  isolationCases: [
    { id: "2.1", title: "effect-authority withdrawal (terminal + idempotent)", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.2", title: "effect ops unrepresentable under cleanup authority", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.3", title: "no existence oracle (uniform ResourceNotAvailableError)", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.4", title: "monotonic cleanup convergence (bounded destroy retries)", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.5", title: "zero-byte management projection (redaction non-vacuous)", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.6", title: "network denial + no bypass (frozen classes)", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.7", title: "no provider-credential / customer-byte leak", required: true, supported: true, verifiedBy: "no-key-core" },
    { id: "2.8", title: "bounded lifecycle faults (TTL/kill/crash/outage)", required: true, supported: true, verifiedBy: "no-key-core" },
  ],
};

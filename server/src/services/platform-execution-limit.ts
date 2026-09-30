// server/src/services/platform-execution-limit.ts
//
// M1 (per-tenant managed execution) — the platform per-tenant execution-limit SEAM.
//
// This is the single, clearly-named place a future subscription/usage throttle
// (design R2, milestone M4) plugs in. It is a NO-OP today: it always allows, and
// it enforces nothing. It exists now so that the enforcement author in M4 has one
// obvious call site to fill in, wired at the managed dispatch entry
// (`environment-runtime.ts`, the E2B / provider-sandbox acquire branch), so it
// cannot be missed.
//
// ── GRAIN (design §4.2, locked by the FKs) ──────────────────────────────────
// The subscription / usage ceiling is the ORGANIZATION's, not the company's:
// `organizations.plan` / `organizations.concurrencyCap` are where plan + concurrency
// governance already live, and the organization is the billing tenant. A single run
// resolves its KEY and per-run SPEND at the COMPANY grain (`runtime_provider_keys`,
// `companies.budgetMonthlyCents`) and its subscription LIMIT at the ORG grain, joined
// by `companies.organizationId`. Enforcing the subscription ceiling at the company
// grain would let one organization multiply its subscription by creating companies.
//
// So this seam is org-grained: the caller resolves `organizationId` from the run's
// company (`companies.organizationId`) and passes it alongside `companyId`. In M1 the
// organization id is carried but not read; M4 reads `organizations.plan` /
// `concurrencyCap` here and decides allow/deny.
//
// Pure by construction: NO database import, NO frozen-protocol touch, NO migration.
// The org resolution (a `companies` read) lives at the call site so this module stays
// a pure, drizzle-free unit (Test Patterns / ESM-cycle rule).

export interface PlatformExecutionLimitInput {
  /** The run's AoA primary tenant. Key + per-run spend are anchored here. */
  readonly companyId: string;
  /**
   * The organization the company belongs to (`companies.organizationId`), i.e. the
   * subscription / billing tenant whose ceiling M4 will enforce. `null` only when the
   * org could not be resolved (best-effort at the call site); M4 decides how to treat
   * an unresolved org (likely fail-closed once enforcement is real).
   */
  readonly organizationId: string | null;
}

export interface PlatformExecutionLimitDecision {
  /** M1: always `true`. M4 flips this to a real allow/deny. */
  readonly allowed: boolean;
  /** Echoed back so a caller/record cites the grain that was checked. */
  readonly organizationId: string | null;
}

/**
 * M1 seam — subscription enforcement wires here in M4; no-op today (always allows).
 *
 * Called at the managed dispatch entry for every managed (provider-sandbox / E2B) run.
 * Returns `{ allowed: true }` unconditionally in M1. Do NOT add enforcement, a DB read,
 * or a frozen-protocol dependency here without the M4 subscription decision.
 */
export function assertWithinPlatformExecutionLimit(
  input: PlatformExecutionLimitInput,
): PlatformExecutionLimitDecision {
  return { allowed: true, organizationId: input.organizationId };
}

export type PlatformExecutionLimitCheck = typeof assertWithinPlatformExecutionLimit;

/**
 * Thrown at the managed dispatch entry when the platform execution limit DENIES a run.
 *
 * In M1 this never fires — the seam always returns `{ allowed: true }`. It exists so the
 * call site ENFORCES the decision now: M4 changes only the checker to return
 * `{ allowed: false }` when a tenant is over its subscription ceiling, and this rejection
 * (already wired at the acquire branch) stops the acquire. That is what makes the seam a
 * single hook — M4 does not have to also edit the call site (Codex P2, PR #431).
 */
export class PlatformExecutionLimitExceededError extends Error {
  readonly companyId: string;
  readonly organizationId: string | null;
  constructor(companyId: string, organizationId: string | null) {
    super(
      `Platform execution limit exceeded for organization ${organizationId ?? "(unresolved)"} (company ${companyId})`,
    );
    this.name = "PlatformExecutionLimitExceededError";
    this.companyId = companyId;
    this.organizationId = organizationId;
  }
}

// server/src/mcp/distributed-run-currency.ts
//
// DAT-007 item #1 — the fence-bound run-JWT CURRENCY gate for the distributed
// `/mcp` auth path. Ruled by the founder 2026-09-19 (per-call / Option B, hard
// gate, adopted into the seam, inert behind AOA_DISTRIBUTED_EXECUTION_ENABLED);
// design + adversarial verification in
// `docs/replatform/DECISION-REQUEST-dat-007-item1-run-jwt-resolver.md`.
//
// THE GAP it closes: a distributed (remote-worker E2B) coding agent presents a
// per-run agent JWT at `POST /companies/:cid/mcp`. That JWT carries only
// `{ sub, company_id, adapter_type, run_id }` with a <=48h TTL and NO lease/fence
// binding (`server/src/agent-auth-jwt.ts`), and DE-08 leaves no network backstop
// at the managed-shared tier. So a STALE (lease lost) or REPLACED (attempt
// superseded) sandbox would keep its signed, unexpired JWT and pass every
// company-identity check on the path — reading memory, creating tasks, asking
// humans — until the TTL simply expired. This gate re-proves, per call, that the
// presenting run is STILL the current holder of a live lease/fence for its job.
//
// SLICE 1 (this file): the PURE classifier only — the security decision, exhaustively
// unit-tested with plain literals. The DB reader (`createDistributedRunCurrencyResolver`,
// which runs the bounded `runId -> heartbeat_runs -> job_attempts -> leases ->
// execution_targets` query) and the `server.ts:446` request-authorization mount land
// in slice 2, inert behind the flag. Until then this classifier is exercised only by
// its edge-case suite.

/** The gate's decision. Deliberately a bare two-valued verdict: a DENY is thrown as
 *  the SAME coarse `forbidden` the endpoint already returns for wrong-tenant, so the
 *  caller learns nothing that distinguishes stale from replaced from not-found (no
 *  existence oracle). */
export type RunCurrencyVerdict = "admit" | "deny";

/** The row facts the DB reader (slice 2) will hand this classifier, resolved from the
 *  SIGNED `run_id` claim. Kept drizzle-free so the security decision is a pure function
 *  testable without a database. Column provenance:
 *  - `runFound`         — a `heartbeat_runs` row exists for the signed run id (PK).
 *  - `runCompanyId`     — `heartbeat_runs.company_id`.
 *  - `executionOwner`   — `heartbeat_runs.execution_owner`: `null` = local, `"distributed"`
 *                         = handed off to a worker (written ONLY by the org heartbeat
 *                         handoff, never by crew).
 *  - `attemptStatus`    — `job_attempts.status` of `heartbeat_runs.distributed_attempt_id`.
 *  - `leaseStatus`      — `leases.status` of that attempt's offered/active lease, or null.
 *  - `expiresFresh`     — `leases.expires_at > clock_timestamp()`, computed against a FRESH
 *                         database clock in SQL (never a JS timestamp), matching `renewLease`'s
 *                         strict `>` with no grace.
 *  - `targetSuperseded` — the execution target's device generation moved, was disabled, or is
 *                         absent (fail-CLOSED), mirroring the `guardActiveFence` cutoff. */
export interface RunCurrencySnapshot {
  readonly runFound: boolean;
  readonly runCompanyId: string | null;
  readonly executionOwner: string | null;
  readonly attemptStatus: string | null;
  readonly leaseStatus: string | null;
  readonly expiresFresh: boolean;
  readonly targetSuperseded: boolean;
}

/** Job-attempt statuses in which the run has terminated — a mirror of
 *  `TERMINAL_ATTEMPT_STATUSES` (`packages/db/src/repositories/tenant/job-fence.ts:63`).
 *  A terminal attempt is never live, so a superseded/replaced attempt (which the reaper
 *  marks terminal before allocating its successor) is denied here. */
const TERMINAL_ATTEMPT_STATUSES: readonly string[] = ["succeeded", "failed", "cancelled", "expired"];

/**
 * Decide whether a distributed run-JWT actor's tool call is admitted, from the row
 * snapshot resolved for its SIGNED `run_id`.
 *
 * The order is load-bearing:
 *   1. No run row → ADMIT (fail-OPEN). Not an org distributed run this gate covers — a
 *      crew run, a forged/expired-but-reaped run — bounded anyway by the JWT's <=48h TTL.
 *      Crew is deliberately out of scope (it never carries `execution_owner="distributed"`).
 *   2. Company mismatch → DENY. Defense-in-depth over the endpoint's own wrong-tenant check.
 *   3. Not distributed (`execution_owner` !== "distributed") → ADMIT. A LOCAL org run under
 *      flag-on has no separable lease to be current against — this is the central guard
 *      against false-denying local execution.
 *   4. Distributed → ADMIT iff the run still holds the CURRENT live fence: an `active` lease,
 *      fresh against the DB clock, a non-terminal attempt, and a current (non-superseded)
 *      target. This mirrors `isActiveFence` (`job-fence.ts:509-515`) plus the
 *      `guardActiveFence` target-generation cutoff (`job-control.ts:1961-1967`). Any other
 *      state — lost/offered/expired lease, terminal (superseded/replaced) attempt, revoked
 *      target — is a coarse DENY.
 */
export function classifyRunCurrency(
  snapshot: RunCurrencySnapshot,
  companyId: string,
): RunCurrencyVerdict {
  // (1) No org distributed run row for this signed run id — not a run this gate covers
  //     (crew, forged, or reaped). Fail-OPEN; bounded by the JWT's <=48h TTL.
  if (!snapshot.runFound) return "admit";
  // (2) Defense-in-depth: the run's company must match the URL company.
  if (snapshot.runCompanyId !== companyId) return "deny";
  // (3) A non-distributed owner (a LOCAL org run, execution_owner IS NULL) under flag-on
  //     has no separable lease to be current against — admit. The central false-deny guard.
  if (snapshot.executionOwner !== "distributed") return "admit";
  // (4) Distributed: admit iff the run still holds the CURRENT live fence — an `active`
  //     lease, fresh against the DB clock, a non-terminal attempt, and a current target.
  //     Mirrors isActiveFence (job-fence.ts:509-515) + the guardActiveFence target cutoff
  //     (job-control.ts:1961-1967). Any other state is a coarse deny.
  const live =
    snapshot.leaseStatus === "active" &&
    snapshot.expiresFresh &&
    !TERMINAL_ATTEMPT_STATUSES.includes(snapshot.attemptStatus ?? "") &&
    !snapshot.targetSuperseded;
  return live ? "admit" : "deny";
}

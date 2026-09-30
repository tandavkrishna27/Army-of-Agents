/**
 * DAT-008 slice 5 — the per-lease redaction-canary coordinator.
 *
 * A run's redeemed secret values must be scrubbed from BOTH event streams the run can produce: the
 * supervisor's lifecycle stream (`supervisor.ts`) and the fence-close proxy's post-close
 * `network_denied` stream (`lease-renewal.ts` / `fence-close-proxy.ts`). The two sinks are built by
 * DIFFERENT components at DIFFERENT times — the proxy in the driver's `registerLease` (synchronously,
 * before the run redeems), the supervisor's sequencer inside the async run — so neither can hand the
 * other a canary value at construction.
 *
 * This coordinator resolves that with a shared, per-lease, LIVE array. `ensure(leaseId)` returns the
 * SAME mutable array for a lease; both sinks capture that reference at construction (an
 * `EventSequencer` reads `redactionCanaries` by reference, scrubbing per emit). The supervisor
 * `push`es the redeemed values into it ONCE, before create — before any emit on either stream — so
 * the reference every later emit reads is already seeded. `release(leaseId)` drops the array when the
 * run settles so the map cannot grow without bound.
 *
 * ★ The timing invariant that makes this sound: SEED STRICTLY BEFORE ANY EMIT. The supervisor seeds
 * before `create`; its first emit is `attempt_started`/a create-fail terminal (both after seeding),
 * and the proxy's only emit is `network_denied`, which fires only after `close()` at run end. So on
 * both streams every emit sees the seeded array.
 *
 * Runtime imports: none beyond standard globals — the E4-D01 boundary.
 */

export interface RunCanaryCoordinator {
  /** The per-lease canary array (idempotent — the SAME array reference each call for a lease). */
  ensure(leaseId: string): string[];
  /** Drop a lease's array (called when the run settles). Idempotent. */
  release(leaseId: string): void;
  /** Live count of tracked leases — for a leak-growth assertion. */
  size(): number;
}

export function createRunCanaryCoordinator(): RunCanaryCoordinator {
  const byLease = new Map<string, string[]>();
  return {
    ensure(leaseId: string): string[] {
      let arr = byLease.get(leaseId);
      if (arr === undefined) {
        arr = [];
        byLease.set(leaseId, arr);
      }
      return arr;
    },
    release(leaseId: string): void {
      byLease.delete(leaseId);
    },
    size(): number {
      return byLease.size;
    },
  };
}

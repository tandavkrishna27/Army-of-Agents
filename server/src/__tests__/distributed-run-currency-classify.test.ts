// server/src/__tests__/distributed-run-currency-classify.test.ts — DAT-007 item #1, slice 1.
//
// Tier 1 of the resolver's TDD plan: the PURE `classifyRunCurrency` decision, one case per
// row of the design's edge-case table (docs/replatform/DECISION-REQUEST-dat-007-item1-run-jwt-resolver.md).
// No DB, no mocks — plain literals. The DB reader + the /mcp mount are proven in slices 2/3.
import { describe, expect, it } from "vitest";

import {
  classifyRunCurrency,
  type RunCurrencySnapshot,
} from "../mcp/distributed-run-currency.js";

const CO = "co-1";

/** A live, current, DISTRIBUTED org run — the happy-path ADMIT baseline. Each test overrides
 *  exactly one field so the case under test is the only variable. */
function live(overrides: Partial<RunCurrencySnapshot> = {}): RunCurrencySnapshot {
  return {
    runFound: true,
    runCompanyId: CO,
    executionOwner: "distributed",
    attemptStatus: "running",
    leaseStatus: "active",
    expiresFresh: true,
    targetSuperseded: false,
    ...overrides,
  };
}

describe("classifyRunCurrency — DAT-007 item #1 fence-bound currency gate", () => {
  it("ADMITs a live, current, distributed org run (happy path — edge 8)", () => {
    expect(classifyRunCurrency(live(), CO)).toBe("admit");
  });

  // ── fall-through ADMITs: cases that are NOT a gated org distributed run ──
  it("ADMITs when no run row exists for the signed run id (edge 4/5 — crew/forged/swept, fail-open)", () => {
    expect(classifyRunCurrency(live({ runFound: false }), CO)).toBe("admit");
  });

  it("ADMITs a LOCAL org run under flag-on (execution_owner NULL — edge 6, the central false-deny guard)", () => {
    expect(classifyRunCurrency(live({ executionOwner: null }), CO)).toBe("admit");
  });

  it("ADMITs a crew-shaped run row whose execution_owner is not 'distributed' (edge 5)", () => {
    // Crew never carries execution_owner='distributed' (that marker is org-heartbeat-only),
    // so even a crew run with a heartbeat_runs row falls through here.
    expect(classifyRunCurrency(live({ executionOwner: "legacy" }), CO)).toBe("admit");
  });

  // ── DENYs ──
  it("DENYs cross-company: the run's company != the URL company (edge 7, defense in depth)", () => {
    expect(classifyRunCurrency(live({ runCompanyId: "other-co" }), CO)).toBe("deny");
  });

  it("DENYs a distributed run with no offered/active lease — lost/released/revoked (edge 9)", () => {
    expect(classifyRunCurrency(live({ leaseStatus: null }), CO)).toBe("deny");
    expect(classifyRunCurrency(live({ leaseStatus: "released" }), CO)).toBe("deny");
    expect(classifyRunCurrency(live({ leaseStatus: "revoked" }), CO)).toBe("deny");
  });

  it("DENYs an 'active' lease that is past its fresh-clock expiry — unswept lapse (edge 10, load-bearing)", () => {
    // The load-bearing case classifyLeaseTruthRow would MISS: it ignores expires_at and would
    // admit a lapsed-but-unswept lease. The currency gate uses the fresh DB clock and denies.
    expect(classifyRunCurrency(live({ expiresFresh: false }), CO)).toBe("deny");
  });

  it("DENYs a merely 'offered' (un-acked) lease — the predicate requires 'active' (edge 11)", () => {
    expect(classifyRunCurrency(live({ leaseStatus: "offered" }), CO)).toBe("deny");
  });

  it("DENYs every terminal attempt status even when the lease row still reads 'active' (edge 12/13 — superseded/replaced)", () => {
    // Superseded/replaced closes here: the reaper marks the reaped attempt terminal before
    // allocating its successor, so a stale sandbox's attempt is never live.
    for (const status of ["succeeded", "failed", "cancelled", "expired"]) {
      expect(classifyRunCurrency(live({ attemptStatus: status }), CO)).toBe("deny");
    }
  });

  it("DENYs a superseded target — generation moved / disabled / absent (edge 14/15, fail-closed)", () => {
    expect(classifyRunCurrency(live({ targetSuperseded: true }), CO)).toBe("deny");
  });

  // ── the AND-of-all-live-conditions is genuine: flipping any single live condition denies ──
  it("requires ALL live conditions together — no single relaxation admits a distributed run", () => {
    expect(classifyRunCurrency(live(), CO)).toBe("admit"); // baseline
    expect(classifyRunCurrency(live({ leaseStatus: "offered" }), CO)).toBe("deny");
    expect(classifyRunCurrency(live({ expiresFresh: false }), CO)).toBe("deny");
    expect(classifyRunCurrency(live({ attemptStatus: "expired" }), CO)).toBe("deny");
    expect(classifyRunCurrency(live({ targetSuperseded: true }), CO)).toBe("deny");
  });

  // ── coarse denial: the verdict is a bare admit|deny, never a reason the caller can read ──
  it("returns only 'admit' | 'deny' — no reason/oracle leaked to the caller", () => {
    const cases: RunCurrencySnapshot[] = [
      live(),
      live({ runFound: false }),
      live({ runCompanyId: "other-co" }),
      live({ leaseStatus: null }),
      live({ attemptStatus: "expired" }),
      live({ targetSuperseded: true }),
    ];
    for (const snapshot of cases) {
      expect(["admit", "deny"]).toContain(classifyRunCurrency(snapshot, CO));
    }
  });
});

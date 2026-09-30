// DEP-011 reaper Slice B (B1) — pure per-row classifier arms.
//
// The embedded-PG integration test (server/src/__tests__/adapter-manager-control-
// lease-truth.integration.test.ts) skips on Windows; this pure test exercises EVERY
// OR-arm of the positive-confirmed-death classifier on every platform so a mutation
// to any single arm reds.
import { describe, expect, it } from "vitest";
import { classifyLeaseTruthRow } from "../repositories/tenant/lease-truth.js";

// A canonical LIVE row: active lease, running attempt, matched target, matching gen.
const LIVE = {
  leaseStatus: "active",
  leaseTargetGeneration: 3,
  attemptStatus: "running",
  targetDeviceGeneration: 3,
  targetStatus: "active",
} as const;

describe("classifyLeaseTruthRow — positive-confirmed-death arms", () => {
  it("classifies a fully-live row as live (the fail-safe default)", () => {
    expect(classifyLeaseTruthRow(LIVE)).toBe("live");
  });

  it("an 'offered' (not-yet-active) lease with a live target is still live (skip), not reaped", () => {
    // Narrower than the authority on purpose: offered is mid-handshake, fail-safe skip.
    expect(classifyLeaseTruthRow({ ...LIVE, leaseStatus: "offered" })).toBe("live");
  });

  // --- terminal: lease status arm ---
  for (const status of ["released", "expired", "revoked"] as const) {
    it(`lease.status='${status}' → terminal`, () => {
      expect(classifyLeaseTruthRow({ ...LIVE, leaseStatus: status })).toBe("terminal");
    });
  }

  // --- terminal: attempt status arm (TERMINAL_ATTEMPT_STATUSES) ---
  for (const status of ["succeeded", "failed", "cancelled", "expired"] as const) {
    it(`attempt.status='${status}' → terminal (even with a live lease + target)`, () => {
      expect(classifyLeaseTruthRow({ ...LIVE, attemptStatus: status })).toBe("terminal");
    });
  }

  it("a non-terminal attempt status ('leased') does not by itself make terminal", () => {
    expect(classifyLeaseTruthRow({ ...LIVE, attemptStatus: "leased" })).toBe("live");
  });

  // --- superseded: disabled target arm ---
  it("target.status='disabled' → superseded (generation matching notwithstanding)", () => {
    expect(classifyLeaseTruthRow({ ...LIVE, targetStatus: "disabled" })).toBe("superseded");
  });

  it("a non-disabled target status ('draining') is NOT superseded on that arm alone", () => {
    expect(classifyLeaseTruthRow({ ...LIVE, targetStatus: "draining" })).toBe("live");
  });

  // --- superseded: generation-moved-past arm ---
  it("target device generation moved PAST the lease's stored generation → superseded", () => {
    expect(
      classifyLeaseTruthRow({ ...LIVE, leaseTargetGeneration: 1, targetDeviceGeneration: 2 }),
    ).toBe("superseded");
  });

  it("equal generations are live (not superseded) — strict '>' guards the boundary", () => {
    expect(
      classifyLeaseTruthRow({ ...LIVE, leaseTargetGeneration: 5, targetDeviceGeneration: 5 }),
    ).toBe("live");
  });

  // --- fail-safe: ambiguity is live (skip), NEVER superseded/orphan ---
  it("an unmatched/absent target (null generation + null status) is live, never reaped", () => {
    expect(
      classifyLeaseTruthRow({
        ...LIVE,
        targetDeviceGeneration: null,
        targetStatus: null,
      }),
    ).toBe("live");
  });

  it("a null lease target generation is live (skip), never superseded", () => {
    expect(
      classifyLeaseTruthRow({ ...LIVE, leaseTargetGeneration: null, targetDeviceGeneration: 4 }),
    ).toBe("live");
  });

  // --- precedence: terminal wins over superseded (both → orphan at the client) ---
  it("a terminal lease that is ALSO superseded classifies terminal (observability precedence)", () => {
    expect(
      classifyLeaseTruthRow({
        ...LIVE,
        leaseStatus: "revoked",
        targetStatus: "disabled",
        leaseTargetGeneration: 1,
        targetDeviceGeneration: 9,
      }),
    ).toBe("terminal");
  });
});

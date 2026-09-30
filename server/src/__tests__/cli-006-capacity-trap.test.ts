// CLI-006 (Task 5) — the Organization capacity double-count.
//
// This file CHARACTERISES current behaviour. It does not change the capacity
// engine — JOB-007 owns that — and it is not asserting a bug to be fixed here.
// It exists because the consequence is operationally surprising and silent, and
// the operator guidance that falls out of it belongs in CLI-006's result doc.
//
// The trap, in one line: **a canary run competes with itself for the
// Organization's capacity, and at `concurrency_cap = 1` the transfer is
// structurally impossible.**
//
// Why. `resolveOrgCapacityUsage` = `legacyRunning + heldAttempts`
// (org-concurrency.ts). At the moment the seam resolves ownership, the run is
// ALREADY `status='running'` — the seam sits late in `executeRun`, just before
// `adapter.execute` — so `countRunningRunsForOrg` counts it. The convert then
// submits, and `admitAttemptCapacity` denies on `usage >= cap`. With `cap = 1`:
// usage is 1 (this very run) before the attempt has claimed anything, so
// admission denies with `reason:"capacity"`, the convert fails, and
// `resolveRunExecutionOwner` returns `{owner:"legacy", reason:"convert_failed"}`.
//
// The run then executes on the legacy path and everything looks normal. Nothing
// errors, nothing is logged as a rollout failure at the operator's altitude — the
// canary simply never happens. And `cap = 1` is the natural first choice for
// someone piloting a canary, which is exactly why this is worth writing down.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const orgConcurrency = readFileSync(
  fileURLToPath(new URL("../services/org-concurrency.ts", import.meta.url)),
  "utf8",
);

describe("CLI-006/Task 5 — the transferring run is counted against itself", () => {
  it("counts EVERY running heartbeat run for the org, with no owner exclusion", () => {
    // The crux. If this predicate ever gained an `execution_owner` exclusion the
    // double count would disappear and this whole trap would be obsolete — so the
    // assertion is written to fail loudly if that happens, rather than to pass
    // vacuously.
    const fn = orgConcurrency.slice(
      orgConcurrency.indexOf("export async function countRunningRunsForOrg"),
      orgConcurrency.indexOf("export const CAPACITY_CLAIM_UNCLAIMED"),
    );
    expect(fn).toContain('eq(heartbeatRuns.status, "running")');
    expect(fn).not.toContain("executionOwner");
  });

  it("derives occupancy as legacyRunning + heldAttempts", () => {
    expect(orgConcurrency).toContain("total: legacyRunning + heldAttempts");
  });

  it("denies admission at usage >= cap", () => {
    expect(orgConcurrency).toContain("if (usageForReport >= cap)");
    expect(orgConcurrency).toContain('reason: "capacity"');
  });
});

describe("CLI-006/Task 5 — the arithmetic, and the operator guidance it implies", () => {
  // Occupancy as the admission sees it at the moment the canary run tries to
  // transfer. `heldAttempts` is 0 because this attempt has not claimed yet — the
  // claim is what admission is deciding.
  const usageAtTransfer = (otherRunningRunsInOrg: number) => {
    const legacyRunning = otherRunningRunsInOrg + 1; // +1 = THIS run, already 'running'
    const heldAttempts = 0;
    return legacyRunning + heldAttempts;
  };
  const admits = (cap: number, otherRuns: number) => usageAtTransfer(otherRuns) < cap;

  it("cap = 1 can NEVER admit a canary transfer, even on a completely idle org", () => {
    expect(usageAtTransfer(0)).toBe(1);
    expect(admits(1, 0)).toBe(false);
  });

  it("cap = 2 admits the transfer on an otherwise idle org", () => {
    expect(admits(2, 0)).toBe(true);
  });

  it("cap = 2 stops admitting as soon as one other run is live", () => {
    // So the guidance is not merely "use 2" — it is "cap must exceed the org's
    // concurrent legacy runs, not merely be greater than 1".
    expect(admits(2, 1)).toBe(false);
    expect(admits(3, 1)).toBe(true);
  });

  it("the general rule: cap must be strictly greater than the org's running runs", () => {
    for (const other of [0, 1, 2, 5]) {
      expect(admits(other + 1, other)).toBe(false);
      expect(admits(other + 2, other)).toBe(true);
    }
  });
});

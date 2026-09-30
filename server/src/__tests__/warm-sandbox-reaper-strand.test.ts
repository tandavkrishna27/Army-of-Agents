/**
 * REL-004 Lane D (D3/J4) — the reaper reclaims STRANDED leases.
 *
 * A stranded lease is one that is terminal in the database but still holds an unreleased provider
 * handle: the row says "done", the VM says "running", and it bills until someone kills it.
 *
 * Two ways to get there, both verified in the terrain doc:
 *
 *   1. MIG-008's `casClaimPaused` flips paused -> expired with `cleanup_status='pending'` and
 *      deliberately does NOT kill (deferring teardown to CLI-004). The reaper's query selects
 *      exclusively `status='paused'`, so the row leaves the only reclaim path forever.
 *   2. The reaper's own CAS calls `expireLeaseIfPaused(id)` with NO cleanupStatus, so a process
 *      death between the claim and the kill leaves `expired` with the field UNCHANGED.
 *
 * Revision 1 of the design proposed widening the reaper's SELECT. That is INERT: the only kill
 * helper claims with a `WHERE status='paused'` CAS, so every widened row fails the claim and the
 * sandbox lives. Hence a second claim primitive, and hence these tests assert a PROVIDER KILL
 * happened — not merely that a row was selected.
 *
 * This arm is switch-INDEPENDENT by design (D2a arm 1): a terminal row with an unreleased handle
 * is pure waste with no user-visible state, so there is nothing to opt into.
 */

import { describe, expect, it, vi } from "vitest";
import type { EnvironmentService } from "../services/environments.js";
import { sweepIdleWarmSandboxes } from "../services/warm-sandbox-reaper.js";

const CO = "00000000-0000-0000-0000-000000000001";
const ENV = "00000000-0000-0000-0000-000000000010";

function strandedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-stranded",
    companyId: CO,
    environmentId: ENV,
    provider: "e2b",
    providerLeaseId: "e2b-stranded",
    status: "expired",
    cleanupStatus: "pending",
    leasePolicy: "reuse_by_agent",
    pausedAt: null,
    releasedAt: new Date().toISOString(),
    metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace" } },
    ...overrides,
  };
}

function e2bEnvRow() {
  return { id: ENV, companyId: CO, name: "warm", driver: "sandbox", config: { provider: "e2b", template: "base" } };
}

function harness(input: {
  stranded?: unknown[];
  claimWins?: boolean;
}) {
  const releaseProvider = vi.fn(async () => ({ cleanupStatus: "success" as const }));
  const claimTerminalUncleaned = vi.fn(async (id: string) =>
    (input.claimWins ?? true) ? { ...strandedRow(), id, cleanupStatus: "failed" } : null);
  const listTerminalUncleanedLeases = vi.fn(async () => input.stranded ?? []);
  const environments = {
    get: vi.fn(async () => e2bEnvRow()),
    releaseLease: vi.fn(async () => ({ ...strandedRow(), status: "expired" })),
    expireLeaseIfPaused: vi.fn(async () => null),
    listPausedLeasesOlderThan: vi.fn(async () => []),
    listTerminalUncleanedLeases,
    claimTerminalUncleaned,
    listLiveAndPausedProviderLeasesForCompany: vi.fn(),
    acquireLease: vi.fn(),
    releaseLeasesForRun: vi.fn(),
  } as unknown as EnvironmentService;

  return {
    environments,
    releaseProvider,
    claimTerminalUncleaned,
    listTerminalUncleanedLeases,
    run: () => sweepIdleWarmSandboxes({} as never, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProvider, execute: vi.fn() }],
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-e2b") },
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
    }),
  };
}

describe("REL-004 Lane D/J4 — stranded leases are reclaimed, with a real provider kill", () => {
  it("reclaims MIG-008's orphan (expired + cleanup_status 'pending')", async () => {
    const h = harness({ stranded: [strandedRow()] });
    const result = await h.run();
    expect(h.claimTerminalUncleaned).toHaveBeenCalledWith("lease-stranded");
    // The assertion that matters: a PROVIDER KILL, not merely a row selected.
    expect(h.releaseProvider).toHaveBeenCalledTimes(1);
    expect(result.reaped).toBe(1);
  });

  it("reclaims the crash-window orphan (expired + cleanup_status UNCHANGED/null)", async () => {
    // Revision 1's `= 'pending'` predicate missed this shape entirely.
    const h = harness({ stranded: [strandedRow({ id: "lease-crash", cleanupStatus: null })] });
    await h.run();
    expect(h.claimTerminalUncleaned).toHaveBeenCalledWith("lease-crash");
    expect(h.releaseProvider).toHaveBeenCalledTimes(1);
  });

  it("reclaims a status-'failed' row that was never ATTEMPTED", async () => {
    // environment-runtime.ts sets status 'failed' on a provider-release throw, so the terminal
    // status alone does not tell you whether a teardown was tried. `cleanup_status` does.
    const h = harness({ stranded: [strandedRow({ id: "lease-failed", status: "failed", cleanupStatus: "pending" })] });
    await h.run();
    expect(h.releaseProvider).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a row whose teardown was already attempted (the retry bound)", async () => {
    // CORRECTED. An earlier version of this suite asserted that cleanup_status='failed' IS
    // reclaimed. That is wrong twice over. It contradicts the design's own retry bound — a kill
    // that never succeeds must be attempted once, not every five minutes forever — and it forced
    // a claim predicate of `IS DISTINCT FROM 'success'`, which is not a compare-and-swap at all:
    // the claim WRITES 'failed', so a second concurrent claimer still matched and both killed the
    // same sandbox. The barrier race in warm-sandbox-reaper-race.integration.test.ts found it.
    //
    // Claimable is therefore {NULL, 'pending'} — unattempted — and the claim moves the row out of
    // that set. The scan mirrors it, so an attempted-and-failed row is never re-listed.
    const h = harness({ stranded: [] });
    const result = await h.run();
    expect(h.listTerminalUncleanedLeases).toHaveBeenCalled();
    expect(h.releaseProvider).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it("does NOT kill when the terminal CAS is lost — no double-kill", async () => {
    // The claim is the latch. Losing it means a co-running sweep owns the row.
    const h = harness({ stranded: [strandedRow()], claimWins: false });
    const result = await h.run();
    expect(h.claimTerminalUncleaned).toHaveBeenCalledWith("lease-stranded");
    expect(h.releaseProvider).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it("runs with NO kill switch present — the strand arm is switch-independent", async () => {
    // Non-vacuity for D2a arm 1: nothing here consults the kill-switch document.
    const h = harness({ stranded: [strandedRow()] });
    const result = await h.run();
    expect(result.reaped).toBe(1);
  });

  it("reclaims nothing when there are no stranded rows", async () => {
    // Non-vacuity for every case above: the harness does not reclaim unconditionally.
    const h = harness({ stranded: [] });
    const result = await h.run();
    expect(h.releaseProvider).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });
});

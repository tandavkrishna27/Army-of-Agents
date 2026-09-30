import { describe, expect, it, vi } from "vitest";
import type { EnvironmentService } from "../services/environments.js";
import { sweepIdleWarmSandboxes, evictOldestPausedSandbox } from "../services/warm-sandbox-reaper.js";

const CO = "00000000-0000-0000-0000-000000000001";
const ENV = "00000000-0000-0000-0000-000000000010";

// A raw environment_leases row (camelCase — normalizeEnvironmentLease reads
// these keys). Only the fields the reaper/destroy path touches are set.
function pausedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-paused",
    companyId: CO,
    environmentId: ENV,
    provider: "e2b",
    providerLeaseId: "e2b-paused",
    status: "paused",
    leasePolicy: "reuse_by_agent",
    pausedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    releasedAt: null,
    metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace" } },
    ...overrides,
  };
}

function e2bEnvRow() {
  return { id: ENV, companyId: CO, name: "warm", driver: "sandbox", config: { provider: "e2b", template: "base" } };
}

function fakeProviderKeys() {
  return { resolveCredential: vi.fn(async () => "sk-e2b") };
}

describe("warm-sandbox reaper (U7.6)", () => {
  it("destroys sandboxes paused longer than the idle TTL (provider kill, reuseLease:false; row → expired)", async () => {
    const paused = pausedRow();
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn(async () => ({ ...paused, status: "expired" }));
    // CAS latch: the lease is still paused, so the claim wins (returns the row).
    const expireLeaseIfPaused = vi.fn(async () => ({ ...paused, status: "expired" }));
    const listPausedLeasesOlderThan = vi.fn(async () => [paused]);
    const environments = {
      get: vi.fn(async () => e2bEnvRow()),
      releaseLease,
      expireLeaseIfPaused,
      listPausedLeasesOlderThan,
      // REL-004 Lane D: the sweep gained a second, switch-independent arm over STRANDED
      // leases. Stubbed empty here so these cases still exercise only the paused path.
      listPausedLeasesWithKeyGeneration: vi.fn(async () => []),
      listTerminalUncleanedLeases: vi.fn(async () => []),
      claimTerminalUncleaned: vi.fn(async () => null),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const res = await sweepIdleWarmSandboxes({} as never, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
    });

    // The CAS claim ran (paused→expired) BEFORE the provider kill.
    expect(expireLeaseIfPaused).toHaveBeenCalledWith("lease-paused");
    expect(res).toEqual({ scanned: 1, reaped: 1 });
    // Reaped lease is KILLED (reuseLease:false), never re-paused.
    expect(releaseProviderSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerLeaseId: "e2b-paused", config: expect.objectContaining({ reuseLease: false }) }),
    );
    // DB row retired to expired.
    expect(releaseLease).toHaveBeenCalledWith("lease-paused", "expired", expect.objectContaining({ cleanupStatus: "success" }));
  });

  it("leaves sandboxes paused within the TTL untouched (and scans with a cutoff ≈ TTL ago)", async () => {
    // The real query filters by cutoff; here the stub returns [] to model that.
    const listPausedLeasesOlderThan = vi.fn(async () => []);
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const environments = {
      get: vi.fn(),
      releaseLease: vi.fn(),
      listPausedLeasesOlderThan,
      // REL-004 Lane D: the sweep gained a second, switch-independent arm over STRANDED
      // leases. Stubbed empty here so these cases still exercise only the paused path.
      listTerminalUncleanedLeases: vi.fn(async () => []),
      claimTerminalUncleaned: vi.fn(async () => null),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const res = await sweepIdleWarmSandboxes({} as never, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
    });

    expect(res.reaped).toBe(0);
    expect(releaseProviderSpy).not.toHaveBeenCalled();
    const cutoffArg = listPausedLeasesOlderThan.mock.calls[0]?.[0] as Date;
    const ageMs = Date.now() - cutoffArg.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
    expect(ageMs).toBeLessThanOrEqual(31 * 60 * 1000);
  });

  it("no-ops when the reaper flag is off (never scans)", async () => {
    const listPausedLeasesOlderThan = vi.fn();
    const environments = {
      get: vi.fn(),
      releaseLease: vi.fn(),
      listPausedLeasesOlderThan,
      // REL-004 Lane D: the sweep gained a second, switch-independent arm over STRANDED
      // leases. Stubbed empty here so these cases still exercise only the paused path.
      listTerminalUncleanedLeases: vi.fn(async () => []),
      claimTerminalUncleaned: vi.fn(async () => null),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const res = await sweepIdleWarmSandboxes({} as never, {
      environments,
      getExperimental: async () => ({ enableWarmSandboxReaper: false, warmSandboxIdleTtlMinutes: 30 }),
    });

    expect(res).toEqual({ scanned: 0, reaped: 0 });
    expect(listPausedLeasesOlderThan).not.toHaveBeenCalled();
  });

  it("evictOldestPausedSandbox destroys the oldest paused lease and never touches active ones", async () => {
    // Query returns `pausedAt asc nulls last` → oldest paused first, active last.
    const oldestPaused = pausedRow({ id: "old", providerLeaseId: "e2b-old", pausedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    const activeLease = pausedRow({ id: "act", providerLeaseId: "e2b-act", status: "active", pausedAt: null });
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn(async () => ({ ...oldestPaused, status: "expired" }));
    const expireLeaseIfPaused = vi.fn(async () => ({ ...oldestPaused, status: "expired" }));
    const environments = {
      get: vi.fn(async () => e2bEnvRow()),
      releaseLease,
      expireLeaseIfPaused,
      listPausedLeasesOlderThan: vi.fn(),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(async () => [oldestPaused, activeLease]),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const evicted = await evictOldestPausedSandbox({} as never, CO, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
    });

    expect(expireLeaseIfPaused).toHaveBeenCalledWith("old");
    expect(evicted?.id).toBe("old");
    expect(releaseProviderSpy).toHaveBeenCalledWith(expect.objectContaining({ providerLeaseId: "e2b-old" }));
    // The active lease is never killed.
    expect(releaseProviderSpy).not.toHaveBeenCalledWith(expect.objectContaining({ providerLeaseId: "e2b-act" }));
    expect(releaseLease).toHaveBeenCalledWith("old", "expired", expect.anything());
  });

  it("evictOldestPausedSandbox returns null when nothing is paused (all active)", async () => {
    const activeLease = pausedRow({ id: "act", providerLeaseId: "e2b-act", status: "active", pausedAt: null });
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const environments = {
      get: vi.fn(),
      releaseLease: vi.fn(),
      listPausedLeasesOlderThan: vi.fn(),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(async () => [activeLease]),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const evicted = await evictOldestPausedSandbox({} as never, CO, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
    });

    expect(evicted).toBeNull();
    expect(releaseProviderSpy).not.toHaveBeenCalled();
  });

  it("sweep SKIPS the provider kill when a concurrent resume claimed the lease between list and destroy (CAS → null)", async () => {
    // The lease was listed as paused, but a concurrent org/Commander run resumed
    // it (paused→active) before the destroy. The paused→expired CAS now matches
    // 0 rows (returns null) → the destroyer must NOT force-kill the now-LIVE VM
    // and must leave the lease untouched.
    const paused = pausedRow();
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn();
    const expireLeaseIfPaused = vi.fn(async () => null); // lost the race
    const environments = {
      get: vi.fn(async () => e2bEnvRow()),
      releaseLease,
      expireLeaseIfPaused,
      listPausedLeasesOlderThan: vi.fn(async () => [paused]),
      // REL-004 Lane D: the sweep gained a second, switch-independent STRANDED arm.
      listTerminalUncleanedLeases: vi.fn(async () => []),
      claimTerminalUncleaned: vi.fn(async () => null),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const res = await sweepIdleWarmSandboxes({} as never, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
    });

    // The claim was attempted and lost — nothing killed, nothing else mutated.
    expect(expireLeaseIfPaused).toHaveBeenCalledWith("lease-paused");
    expect(releaseProviderSpy).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    // The live lease is NOT counted as reaped.
    expect(res).toEqual({ scanned: 1, reaped: 0 });
  });

  it("evict SKIPS the provider kill on a lost CAS (double-evict collapses to one winner) and returns null", async () => {
    // Two over-cap acquires both pick the same oldest-paused row; the first CAS
    // wins and kills, the second sees the row is no longer paused (null) → it
    // must NOT double-kill the VM the first evict already retired.
    const oldestPaused = pausedRow({ id: "old", providerLeaseId: "e2b-old" });
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn();
    const expireLeaseIfPaused = vi.fn(async () => null); // the losing evictor
    const environments = {
      get: vi.fn(async () => e2bEnvRow()),
      releaseLease,
      expireLeaseIfPaused,
      listPausedLeasesOlderThan: vi.fn(),
      listLiveAndPausedProviderLeasesForCompany: vi.fn(async () => [oldestPaused]),
      acquireLease: vi.fn(),
      releaseLeasesForRun: vi.fn(),
    } as unknown as EnvironmentService;

    const evicted = await evictOldestPausedSandbox({} as never, CO, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() }],
      runtimeProviderKeys: fakeProviderKeys(),
    });

    expect(expireLeaseIfPaused).toHaveBeenCalledWith("old");
    expect(releaseProviderSpy).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    expect(evicted).toBeNull();
  });
});

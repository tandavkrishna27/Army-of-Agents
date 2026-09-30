/**
 * REL-004 Lane D (§5) — inherited deferral #5, "old-key kill-switch enforcement".
 *
 * The Wave-3 handoff assigns this to REL-004 clause 3, and `e2b-credential-authority.ts` points
 * here by name: "The LIVE force-kill of sandboxes tagged with a superseded generation is
 * REL-004's kill-switch primitive."
 *
 * THE PREREQUISITE DID NOT EXIST. `deriveE2bKeyGeneration` returns a company's CURRENT key
 * version; nothing recorded the generation a sandbox was created under, so "superseded" was not
 * computable for an existing sandbox. These tests pin the tag and the reclaim it enables.
 *
 * Why reclaiming a superseded PAUSED snapshot is safe: AoA's own credential authority refuses to
 * resolve or inject a superseded generation, so AoA will never resume it. It is dead weight by
 * this system's own policy — independent of whether E2B itself would still honour the old key,
 * which we cannot test without the operator-dispatched keyed lane.
 */

import { describe, expect, it, vi } from "vitest";
import type { EnvironmentService } from "../services/environments.js";
import { sweepIdleWarmSandboxes } from "../services/warm-sandbox-reaper.js";

const CO_A = "00000000-0000-0000-0000-00000000000a";
const CO_B = "00000000-0000-0000-0000-00000000000b";
const ENV = "00000000-0000-0000-0000-000000000010";

function pausedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "lease-old-key",
    companyId: CO_A,
    environmentId: ENV,
    provider: "e2b",
    providerLeaseId: "e2b-old",
    status: "paused",
    leasePolicy: "reuse_by_agent",
    pausedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    releasedAt: null,
    metadata: { provider: "e2b", keyGeneration: "3", providerMetadata: {} },
    ...overrides,
  };
}

function harness(input: { paused: unknown[]; currentGeneration?: (companyId: string) => Promise<string | null> }) {
  const releaseProvider = vi.fn(async () => ({ cleanupStatus: "success" as const }));
  const listPausedLeasesWithKeyGeneration = vi.fn(async () => input.paused);
  const environments = {
    get: vi.fn(async () => ({ id: ENV, companyId: CO_A, name: "warm", driver: "sandbox", config: { provider: "e2b", template: "base" } })),
    releaseLease: vi.fn(async () => ({ ...pausedRow(), status: "expired" })),
    expireLeaseIfPaused: vi.fn(async (id: string) => ({ ...pausedRow(), id, status: "expired" })),
    listPausedLeasesOlderThan: vi.fn(async () => []),
    listPausedLeasesForProvider: vi.fn(async () => []),
    listPausedLeasesWithKeyGeneration,
    listTerminalUncleanedLeases: vi.fn(async () => []),
    claimTerminalUncleaned: vi.fn(async () => null),
    listLiveAndPausedProviderLeasesForCompany: vi.fn(),
    acquireLease: vi.fn(),
    releaseLeasesForRun: vi.fn(),
  } as unknown as EnvironmentService;

  return {
    environments, releaseProvider, listPausedLeasesWithKeyGeneration,
    run: () => sweepIdleWarmSandboxes({} as never, {
      environments,
      sandboxProviders: [{ provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProvider, execute: vi.fn() }],
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-e2b") },
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
      readKillSwitchDocument: async () => undefined,
      currentKeyGeneration: input.currentGeneration ?? (async () => "4"),
    }),
  };
}

describe("REL-004 Lane D/§5 — superseded-key paused snapshots are reclaimed", () => {
  it("reclaims a paused snapshot whose recorded generation is not the current one", async () => {
    const h = harness({ paused: [pausedRow()] });          // recorded 3, current 4
    const result = await h.run();
    expect(h.releaseProvider).toHaveBeenCalledTimes(1);
    expect(result.reaped).toBe(1);
  });

  it("leaves a CURRENT-generation snapshot alone", async () => {
    // Non-vacuity: the arm compares, it does not reap every paused e2b lease it sees.
    const h = harness({ paused: [pausedRow({ metadata: { provider: "e2b", keyGeneration: "4" } })] });
    const result = await h.run();
    expect(h.releaseProvider).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  it("leaves an UNTAGGED snapshot alone — absence is not evidence of supersession", async () => {
    // Leases acquired before this tag existed have no generation. Reaping them would destroy
    // every pre-existing warm snapshot on first deploy.
    const h = harness({ paused: [pausedRow({ metadata: { provider: "e2b" } })] });
    await h.run();
    expect(h.releaseProvider).not.toHaveBeenCalled();
  });

  it("leaves everything alone when the company has NO BYO key (ungenerationed)", async () => {
    // deriveE2bKeyGeneration returns null for the operator-env default. Null is "no generation
    // to compare", not "superseded".
    const h = harness({ paused: [pausedRow()], currentGeneration: async () => null });
    await h.run();
    expect(h.releaseProvider).not.toHaveBeenCalled();
  });

  it("compares per COMPANY, not globally", async () => {
    // Company A rotated to 4; company B is still on 3. B's snapshot must survive.
    const h = harness({
      paused: [
        pausedRow({ id: "a-old", companyId: CO_A, metadata: { provider: "e2b", keyGeneration: "3" } }),
        pausedRow({ id: "b-current", companyId: CO_B, metadata: { provider: "e2b", keyGeneration: "3" } }),
      ],
      currentGeneration: async (companyId) => (companyId === CO_A ? "4" : "3"),
    });
    const result = await h.run();
    expect(result.reaped).toBe(1);
  });

  it("does not let a generation-lookup failure destroy anything", async () => {
    // Same fail-open rule as the reclaim arm: an unavailable database must not force-kill VMs.
    const h = harness({ paused: [pausedRow()], currentGeneration: async () => { throw new Error("db down"); } });
    const result = await h.run();
    expect(h.releaseProvider).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });
});

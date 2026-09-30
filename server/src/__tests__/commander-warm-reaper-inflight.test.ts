// W7.5e — Task 4:
//  (a) The warm-sandbox reaper NEVER touches an in-flight (active) Commander
//      turn. This is answered STRUCTURALLY, not with new gate code: a live turn
//      holds its lease `status='active'` until it releases at turn end (W7.5d);
//      the reaper sweeps `status='paused'` only (warm-sandbox-reaper.ts:99,
//      `listPausedLeasesOlderThan`). So an active lease — even an old one — is
//      never eligible. No reaper-gate code is needed; this test documents the
//      invariant so a future paused/active mistake would fail loudly.
//  (b) F5 characterization lock: Commander has NO `ask_founder`/`ask_human`. The
//      internal-registry gate requires `actor.source==="agent"` + `agentId` +
//      `runId` (ask-founder-tool.ts:205); a commander actor never satisfies it,
//      so the ⚡CONFIRM marker is Commander's ONLY human-in-the-loop path. There
//      is no ask_founder live-relay to carry over the broker and nothing holds a
//      VM open awaiting a human, which is WHY the reaper-gate is moot. Locking
//      this makes any future "add a commander branch to the gate" a deliberate,
//      reviewed change — not a silent default.
//
// NOTE: this file must NOT mock drizzle-orm / @armyofagents/db — the reaper and
// ask-founder-tool both import the REAL db package (matching warm-sandbox-
// reaper.test.ts, which mocks neither).
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentService } from "../services/environments.js";
import { sweepIdleWarmSandboxes } from "../services/warm-sandbox-reaper.js";

const CO = "00000000-0000-0000-0000-000000000001";
const ENV = "00000000-0000-0000-0000-000000000010";

// The in-flight Commander turn's lease: status='active', pausedAt=null. It is
// "old" in wall-clock terms (started 45m ago) but is NOT paused, so the paused-
// only scan below never returns it.
function activeInFlightLease() {
  return {
    id: "lease-active-inflight",
    companyId: CO,
    environmentId: ENV,
    provider: "e2b",
    providerLeaseId: "e2b-active",
    status: "active",
    leasePolicy: "reuse_by_agent",
    commanderConversationId: "conv-1",
    startedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    pausedAt: null, // ← never paused while the turn is live
    releasedAt: null,
    metadata: { provider: "e2b", providerMetadata: { remoteCwd: "/workspace" } },
  };
}

describe("warm reaper never touches an in-flight (active) Commander turn (W7.5e Task 4a)", () => {
  it("does not reap an active lease, even an old one — only paused leases are swept", async () => {
    // Model the reaper's paused-only scan (warm-sandbox-reaper.ts:99): given the
    // full lease set, return only rows with status='paused' older than cutoff.
    // The active in-flight turn's lease is excluded by construction.
    const allLeases = [activeInFlightLease()];
    const listPausedLeasesOlderThan = vi.fn(async (cutoff: Date) =>
      allLeases.filter(
        (l) => l.status === "paused" && l.pausedAt !== null && new Date(l.pausedAt) < cutoff,
      ),
    );
    const releaseProviderSpy = vi.fn(async () => ({ cleanupStatus: "success" as const }));
    const releaseLease = vi.fn();
    const environments = {
      get: vi.fn(),
      releaseLease,
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
      sandboxProviders: [
        { provider: "e2b", acquireLease: vi.fn(), releaseLease: releaseProviderSpy, execute: vi.fn() },
      ],
      runtimeProviderKeys: { resolveCredential: vi.fn(async () => "sk-e2b") },
      getExperimental: async () => ({ enableWarmSandboxReaper: true, warmSandboxIdleTtlMinutes: 30 }),
    });

    // The scan ran, but the active lease was never a candidate.
    expect(listPausedLeasesOlderThan).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ scanned: 0, reaped: 0 });
    // The active turn's sandbox is never killed / re-paused.
    expect(releaseProviderSpy).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });
});

// ── F5: Commander has NO ask_founder/ask_human (characterization lock) ────────
import { handleAskHuman, handleAskFounder } from "../mcp/tools/ask-founder-tool.js";

describe("[F5] Commander has no ask_founder/ask_human over the broker (W7.5e Task 4b)", () => {
  // A commander actor: source='commander', no agentId/runId run identity.
  const commanderCtx = {
    actor: { source: "commander", userId: "u1", companyId: CO, agentId: null, runId: "conv-1" },
  } as never;

  it("ask_human refuses a commander actor (agent-run gate) — 403, not answered", async () => {
    const res = await handleAskHuman(commanderCtx, { question: "?" });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });

  it("ask_founder (the alias) also refuses a commander actor", async () => {
    const res = await handleAskFounder(commanderCtx, { question: "?" });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});

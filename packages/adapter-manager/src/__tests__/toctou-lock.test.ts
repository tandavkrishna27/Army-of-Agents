// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the TOCTOU lock on gateOwnedOp (option (b)).
//
// `gateOwnedOp` is `provider.inspect` (the AM-local owned-check) THEN `dispatch` — two
// provider round-trips with a gap. An AM-local per-sandboxId lock spanning inspect ->
// dispatch closes the in-process interleave. It is acquired AFTER `verifyOrUniform`
// (verify stays OUTSIDE the lock — an unauthenticated caller must not acquire a lock,
// and the crafted `sandboxId` keys the lock map, which EVICTS on drain).
//
// ★ HONESTLY PARTIAL (β1.6): it serializes only THIS adapter-manager instance's
// inspect+dispatch — NOT E2B's own TTL destroy+reassign, and NOT a second replica. The
// real fix is the (c) proven-non-reuse invariant (deploy-owed). This is defense-in-depth.
//
// Proven here (unit-level, calling the exported gate directly):
//   - two concurrent ops on the SAME sandboxId do NOT interleave inspect/dispatch (a
//     yielding inspect can't let the second op's inspect run mid-flight);
//   - VERIFY-BEFORE-LOCK: an invalid/absent capability is refused WITHOUT acquiring the
//     lock (0 acquisitions) and WITHOUT touching the provider;
//   - the lock map EVICTS on drain (size returns to 0), incl. after a dispatch throws.
// -----------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { InspectResult, ProviderOpContext, ResourceLabels, SandboxProvider } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/worker-daemon";
import {
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
} from "@armyofagents/provider-wire";

import { gateOwnedOp, type OwnedOpGateDeps } from "../owned-op-gate.js";
import { KeyedMutex } from "../keyed-mutex.js";

const NOW = 1_700_000_000_000;
const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};
const controlPlane = generateKeyPairSync("ed25519");

function ctx(): ProviderOpContext {
  return { deadlineMs: 5_000, idempotencyKey: "idem-1" };
}
function mint(ownedLabels: ResourceLabels = OWNED): OwnedLabelsCapability {
  return signOwnedLabelsCapability(
    { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels, expiresAt: NOW + 60_000 },
    controlPlane.privateKey,
  );
}
function ownedDetail(sandboxId: string): InspectResult {
  return {
    providerOpId: `insp:${sandboxId}`,
    sandboxId,
    resourceLabels: OWNED,
    generation: OWNED.deviceGeneration,
    state: "running",
    command: "",
    env: {},
    logs: [],
    workspaceBytes: 0,
    objectGrants: [],
    secrets: {},
  };
}
function tick(): Promise<void> {
  // A few microtask yields, so WITHOUT the lock a second op's inspect would interleave.
  return Promise.resolve().then(() => Promise.resolve().then(() => undefined));
}

/** A KeyedMutex that counts how many times runExclusive was entered (acquisitions). */
class CountingMutex extends KeyedMutex {
  acquisitions = 0;
  override runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.acquisitions += 1;
    return super.runExclusive(key, fn);
  }
}

describe("TOCTOU lock — inspect+dispatch do not interleave on the same sandboxId", () => {
  it("two concurrent ops on the same id serialize (a yielding inspect can't interleave)", async () => {
    const events: string[] = [];
    const provider = {
      inspect: async (sandboxId: string): Promise<InspectResult> => {
        events.push(`inspect:start`);
        await tick(); // yield — the other op MUST NOT slip its inspect in here
        events.push(`inspect:end`);
        return ownedDetail(sandboxId);
      },
    } as unknown as SandboxProvider;
    const sandboxLock = new KeyedMutex();
    const deps: OwnedOpGateDeps = { provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, sandboxLock };

    const dispatch = (tag: string) => async (): Promise<string> => {
      events.push(`dispatch:${tag}`);
      return tag;
    };
    const [a, b] = await Promise.all([
      gateOwnedOp(deps, "sbx-1", ctx(), mint(), dispatch("A")),
      gateOwnedOp(deps, "sbx-1", ctx(), mint(), dispatch("B")),
    ]);
    expect([a, b].sort()).toEqual(["A", "B"]);
    // Strict serialization: one op's full inspect->dispatch completes before the other
    // op's inspect begins — never two inspect:start before an inspect:end (that would be
    // the interleave the lock exists to prevent).
    const kinds = events.map((e) => (e.startsWith("dispatch") ? "dispatch" : e));
    expect(kinds).toEqual(["inspect:start", "inspect:end", "dispatch", "inspect:start", "inspect:end", "dispatch"]);
    // And the two dispatches are the two distinct tags (each op ran once).
    const dispatched = events.filter((e) => e.startsWith("dispatch")).sort();
    expect(dispatched).toEqual(["dispatch:A", "dispatch:B"]);
    expect(sandboxLock.size).toBe(0); // evicted on drain
  });

  it("two DIFFERENT sandboxIds are NOT serialized against each other", async () => {
    const events: string[] = [];
    const provider = {
      inspect: async (sandboxId: string): Promise<InspectResult> => {
        events.push(`inspect:${sandboxId}`);
        await tick();
        return ownedDetail(sandboxId);
      },
    } as unknown as SandboxProvider;
    const sandboxLock = new KeyedMutex();
    const deps: OwnedOpGateDeps = { provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, sandboxLock };
    await Promise.all([
      gateOwnedOp(deps, "sbx-1", ctx(), mint(), async () => "a"),
      gateOwnedOp(deps, "sbx-2", ctx(), mint(), async () => "b"),
    ]);
    // Both inspects started before either finished — distinct ids don't contend.
    expect(events.slice(0, 2).sort()).toEqual(["inspect:sbx-1", "inspect:sbx-2"]);
  });
});

describe("TOCTOU lock — verify happens BEFORE the lock", () => {
  it("an absent capability is refused WITHOUT acquiring the lock or touching the provider", async () => {
    let inspectCalls = 0;
    const provider = {
      inspect: async (sandboxId: string): Promise<InspectResult> => {
        inspectCalls += 1;
        return ownedDetail(sandboxId);
      },
    } as unknown as SandboxProvider;
    const sandboxLock = new CountingMutex();
    const deps: OwnedOpGateDeps = { provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, sandboxLock };
    await expect(gateOwnedOp(deps, "sbx-x", ctx(), undefined, async () => "x")).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(sandboxLock.acquisitions).toBe(0); // verify is OUTSIDE the lock
    expect(inspectCalls).toBe(0); // and the provider is never reached
    expect(sandboxLock.size).toBe(0);
  });

  it("a VALID capability acquires the lock exactly once", async () => {
    const provider = { inspect: async (id: string) => ownedDetail(id) } as unknown as SandboxProvider;
    const sandboxLock = new CountingMutex();
    const deps: OwnedOpGateDeps = { provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, sandboxLock };
    await gateOwnedOp(deps, "sbx-1", ctx(), mint(), async () => "ok");
    expect(sandboxLock.acquisitions).toBe(1);
    expect(sandboxLock.size).toBe(0);
  });
});

describe("TOCTOU lock — released on throw (evict on drain)", () => {
  it("a dispatch that throws still evicts the lock; a later op on the same id runs", async () => {
    const provider = { inspect: async (id: string) => ownedDetail(id) } as unknown as SandboxProvider;
    const sandboxLock = new KeyedMutex();
    const deps: OwnedOpGateDeps = { provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, sandboxLock };
    await expect(
      gateOwnedOp(deps, "sbx-1", ctx(), mint(), async () => {
        throw new Error("dispatch boom");
      }),
    ).rejects.toThrow("dispatch boom");
    expect(sandboxLock.size).toBe(0); // released + evicted despite the throw
    // The id is free — a subsequent op runs to completion.
    const r = await gateOwnedOp(deps, "sbx-1", ctx(), mint(), async () => "recovered");
    expect(r).toBe("recovered");
  });
});

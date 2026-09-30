import { describe, expect, it } from "vitest";

import {
  CleanupAuthority,
  CleanupAuthorityDeniedError,
  ResourceNotAvailableError,
  createMetrics,
  hashResourceLabels,
  reconcile,
  type EffectFence,
  type OwnershipSelector,
  type ProviderOpContext,
  type ResourceLabels,
} from "@armyofagents/worker-daemon";

import { DIRECTIVE_KEYS } from "../directives.js";
import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";

// -----------------------------------------------------------------------------
// CLI-004 / D1 — the no-key composition proof. The EXISTING WRK-004 `reconcile()`
// sweep is run against the REAL `E2bSandboxProvider` driver over the deterministic
// key-less `MockE2bTransport`, with a running (live-lease) + a paused + a leaked/
// stopped fixture SEEDED THROUGH THE PROVIDER's own ops (create + checkpoint/kill)
// so the live/paused/leaked disposition is a property of the real driver's state
// mapping, not a transport double. `reconcile-leaked.test.ts` proves the sweep
// against the in-process fake; this proves it against the E2B driver's provider
// path. It rides the `pr.yml` provider-glob distributed-contract gate.
//
// It re-implements NO denial/redaction/convergence logic: invariants §2.4 (effect
// denial / no-existence-oracle) and §2.5 (redacted projection) are asserted by
// INSTANTIATING the EXISTING exported `CleanupAuthority` (the CLI-001 isolation
// suite already proves these green vs the same driver) — CLI-004 only composes.
// -----------------------------------------------------------------------------

const ORG = "org-e2b";
const TARGET = "target-e2b";
const WORKER = "worker-e2b";
const selector: OwnershipSelector = { organizationId: ORG, targetId: TARGET, workerId: WORKER };

let ctxN = 0;
const makeCtx = (key?: string): ProviderOpContext => ({ deadlineMs: 60_000, idempotencyKey: key ?? `idem-${++ctxN}` });

function labels(overrides: Partial<ResourceLabels> = {}): ResourceLabels {
  return {
    organizationId: ORG,
    targetId: TARGET,
    workerId: WORKER,
    jobId: "job-1",
    attempt: 1,
    leaseId: "lease-1",
    deviceGeneration: 1,
    ...overrides,
  };
}

function spec(l: ResourceLabels, env: Record<string, string> = {}) {
  return { resourceLabels: l, command: "codex run", args: [] as string[], env, workloadType: "batch" };
}

const SENSITIVE_KEYS = ["command", "env", "logs", "secrets", "workspaceBytes", "objectGrants"] as const;

describe("CLI-004/D1 — reconcile() composed against the E2B driver (mock transport)", () => {
  it("attributes every resource, reconciles ONLY the orphans, leaves the live lease untouched, converges to zero", async () => {
    const transport = new MockE2bTransport({ supportsPauseResume: true });
    const provider = new E2bSandboxProvider({ transport, advertisedOptionalOps: ["checkpoint", "restore", "health"] });

    // Seed THROUGH the provider: a running (live-lease) sandbox, a paused sandbox
    // (checkpoint → transport.pause → state "paused" → mapped stopped, no live
    // lease), and a leaked sandbox (kill → state "stopped", no live lease).
    const live = await provider.create(spec(labels({ jobId: "j-live", leaseId: "l-live" })), makeCtx());
    const paused = await provider.create(spec(labels({ jobId: "j-paused", leaseId: "l-paused" })), makeCtx());
    await provider.checkpoint(paused.sandboxId, makeCtx());
    const leaked = await provider.create(spec(labels({ jobId: "j-leaked", leaseId: "l-leaked" })), makeCtx());
    await provider.kill(leaked.sandboxId, makeCtx());

    // (§2.1) Attribution + (§2.5-list) the sweep's list projection is management-safe.
    const page = await provider.list({ ownershipSelector: selector, pageSize: 50 }, makeCtx());
    expect(page.resources.length).toBe(3);
    for (const r of page.resources) {
      expect(r.resourceLabels.organizationId).toBe(ORG);
      expect(r.resourceLabels.targetId).toBe(TARGET);
      expect(r.resourceLabels.workerId).toBe(WORKER);
      expect(typeof r.resourceLabels.jobId).toBe("string");
      expect(typeof r.resourceLabels.leaseId).toBe("string");
      expect(r.generation).toBe(1);
      for (const k of SENSITIVE_KEYS) expect(k in r).toBe(false);
    }
    // Exactly the running sandbox carries a live lease.
    expect(page.resources.filter((r) => r.hasLiveLease).map((r) => r.sandboxId)).toEqual([live.sandboxId]);

    // (§2.2) Only the two orphans are reconciled; the live lease is never touched.
    // A single sweep lists all three in one page: `reconcile` deletes orphans as it
    // goes, and the real-E2B `terminate` removes the row (unlike the row-retaining
    // in-process fake), so a small page whose cursor row is destroyed mid-sweep is
    // an ACROSS-SWEEP convergence case (§2.3), not a single-page selection case.
    const metrics = createMetrics();
    const result = await reconcile({ provider, ownershipSelector: selector, makeCtx: () => makeCtx(), metrics });
    expect(result.scanned).toBe(3);
    expect(result.orphansDestroyed).toBe(2);
    expect(result.orphansFailed).toBe(0);
    expect(result.outcomes.map((o) => o.sandboxId).sort()).toEqual([leaked.sandboxId, paused.sandboxId].sort());
    // The outcomes carry the HASHED labels, never raw ids.
    for (const o of result.outcomes) {
      expect(o.resourceLabelsHash.length).toBe(64);
      expect(o.resourceLabelsHash).not.toContain(ORG);
    }
    expect(metrics.renderPrometheus()).toContain("reconcile_orphans_total 2");

    // Live-lease sandbox is untouched and still running.
    expect(await transport.isRunning(live.sandboxId)).toBe(true);
    expect((await provider.inspect(live.sandboxId, makeCtx())).state).toBe("running");

    // (§2.8) Zero orphans remain; only the live sandbox is left.
    const after = await provider.list({ ownershipSelector: selector, pageSize: 50 }, makeCtx());
    expect(after.resources.length).toBe(1);
    expect(after.resources.filter((r) => !r.hasLiveLease).length).toBe(0);
    expect(transport.liveCount()).toBe(1);

    // (§2.3) A second pass is idempotent (only the live remains; no cleanup runs)…
    const second = await reconcile({ provider, ownershipSelector: selector, makeCtx: () => makeCtx() });
    expect(second.scanned).toBe(1);
    expect(second.orphansDestroyed).toBe(0);
    expect(second.orphansFailed).toBe(0);
    // …and a repeat cleanup of an already-gone sandbox is a converged success (NotFound→success).
    expect((await provider.reconcileCleanup(paused.sandboxId, makeCtx())).cleanupStatus).toBe("success");
  });

  it("(§2.6) a transient transport fault reports cleanupStatus:failed (never thrown), leaves the resource intact, counts it", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const l = labels({ jobId: "j-fault", leaseId: "l-fault" });
    // The reserved destroy-failure directive → every terminate throws a transient
    // transport error the driver REPORTS as failed (never throws), modeling a
    // provider outage the resource survives.
    const created = await provider.create(spec(l, { [DIRECTIVE_KEYS.destroyFailures]: "999" }), makeCtx());
    await provider.kill(created.sandboxId, makeCtx()); // make it a leaked orphan

    const metrics = createMetrics();
    const result = await reconcile({ provider, ownershipSelector: selector, makeCtx: () => makeCtx(), metrics });
    expect(result.scanned).toBe(1);
    expect(result.orphansFailed).toBe(1);
    expect(result.orphansDestroyed).toBe(0);
    expect(result.outcomes[0]?.cleanupStatus).toBe("failed");

    // The resource is intact for the next bounded sweep (outage-backoff shape).
    expect(transport.liveCount()).toBe(1);
    expect((await provider.inspect(created.sandboxId, makeCtx())).sandboxId).toBe(created.sandboxId);
    // Counted through the EXISTING metric.
    expect(metrics.renderPrometheus()).toContain('cleanup_outcome{outcome="failed"} 1');
  });

  it("(§2.4 + §2.5) reconciliation routes an orphan through the EXISTING redaction + denial authority (reuse, not re-derived)", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const l = labels({ jobId: "j-red", leaseId: "l-red" });
    const created = await provider.create(spec(l, { API_KEY: "sk-live-secret" }), makeCtx());

    const fence: EffectFence = {
      jobId: l.jobId,
      attempt: l.attempt,
      leaseId: l.leaseId,
      fenceToken: "f".repeat(40),
      deviceGeneration: l.deviceGeneration,
      observedSeq: 0,
    };
    const authority = new CleanupAuthority({
      provider,
      resourceLabels: l,
      targetGeneration: l.deviceGeneration,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });

    // (§2.5) The cleanup facet's inspect returns ONLY the 5-key redacted projection…
    const projection = await authority.inspect(created.sandboxId, makeCtx());
    expect(Object.keys(projection).sort()).toEqual(["generation", "providerOpId", "resourceLabelsHash", "sandboxId", "state"]);
    expect(projection.resourceLabelsHash).toBe(hashResourceLabels(l));
    const ser = JSON.stringify(projection);
    expect(ser).not.toContain("sk-live-secret");
    expect(ser).not.toContain("codex run");
    expect(ser).not.toContain(ORG);
    // …NON-VACUOUS: the provider's OWN inspect holds the sensitive command (redaction is
    // real work). ★ [Cred-1] (DEP-012 Slice 4+5): `env` is NO LONGER at rest — the provider
    // stopped copying the tenant env into durable E2B metadata, so `raw.env` is empty and the
    // API key never sits in the durable store (a STRONGER property than redaction).
    const raw = await provider.inspect(created.sandboxId, makeCtx());
    expect(raw.command).toBe("codex run");
    expect(raw.env.API_KEY).toBeUndefined();
    expect(raw.env).toEqual({});

    // (§2.4) The cleanup facet can NEVER effect.
    expect(() => authority.execute()).toThrow(CleanupAuthorityDeniedError);
    expect(() => authority.create()).toThrow(CleanupAuthorityDeniedError);
    expect(() => authority.resume()).toThrow(CleanupAuthorityDeniedError);

    // (§2.4) A wrong-generation target and an absent id collapse to the SAME
    // uniform ResourceNotAvailableError — no existence oracle.
    const wrongGen = new CleanupAuthority({
      provider,
      resourceLabels: l,
      targetGeneration: l.deviceGeneration + 1,
      fence,
      deadline: Date.now() + 10_000,
      epoch: 0,
    });
    await expect(wrongGen.inspect(created.sandboxId, makeCtx())).rejects.toBeInstanceOf(ResourceNotAvailableError);
    await expect(authority.inspect("sbx-absent", makeCtx())).rejects.toBeInstanceOf(ResourceNotAvailableError);
  });
});

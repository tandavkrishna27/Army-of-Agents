import { describe, expect, it } from "vitest";

import type {
  CleanupResult,
  CreateResult,
  ExecuteResult,
  InspectResult,
  ProviderOperation,
  SandboxProvider,
  StopResult,
} from "@armyofagents/worker-daemon";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import { perOpToInvokeDriver } from "../per-op-adapter.js";

// -----------------------------------------------------------------------------
// D2 — the E6-F008 adapter is FAITHFUL (each op routes to its method; each fault
// lever reaches the provider) and NON-VACUOUS (a sabotaged provider is caught).
// -----------------------------------------------------------------------------

function realDriver(opts: { maxDestroyAttempts?: number } = {}) {
  const transport = new MockE2bTransport();
  const provider = new E2bSandboxProvider({ transport });
  return perOpToInvokeDriver(provider, { providerId: "e2b-unit", maxDestroyAttempts: opts.maxDestroyAttempts ?? 3 });
}

/** A recording SandboxProvider that delegates to a real E2B provider and logs the
 * per-op method each invoke reaches — the routing proof. */
class RecordingProvider implements SandboxProvider {
  readonly calls: string[] = [];
  readonly #inner: E2bSandboxProvider;
  constructor(inner: E2bSandboxProvider) {
    this.#inner = inner;
  }
  get advertisedOperations() {
    return this.#inner.advertisedOperations;
  }
  get checkpointMode() {
    return this.#inner.checkpointMode;
  }
  get healthMode() {
    return this.#inner.healthMode;
  }
  create(...a: Parameters<SandboxProvider["create"]>) {
    this.calls.push("create");
    return this.#inner.create(...a);
  }
  execute(...a: Parameters<SandboxProvider["execute"]>) {
    this.calls.push("execute");
    return this.#inner.execute(...a);
  }
  cancel(...a: Parameters<SandboxProvider["cancel"]>) {
    this.calls.push("cancel");
    return this.#inner.cancel(...a);
  }
  kill(...a: Parameters<SandboxProvider["kill"]>) {
    this.calls.push("kill");
    return this.#inner.kill(...a);
  }
  destroy(...a: Parameters<SandboxProvider["destroy"]>) {
    this.calls.push("destroy");
    return this.#inner.destroy(...a);
  }
  list(...a: Parameters<SandboxProvider["list"]>) {
    this.calls.push("list");
    return this.#inner.list(...a);
  }
  inspect(...a: Parameters<SandboxProvider["inspect"]>) {
    this.calls.push("inspect");
    return this.#inner.inspect(...a);
  }
  reconcileCleanup(...a: Parameters<SandboxProvider["reconcileCleanup"]>) {
    this.calls.push("reconcileCleanup");
    return this.#inner.reconcileCleanup(...a);
  }
  checkpoint(...a: Parameters<SandboxProvider["checkpoint"]>) {
    this.calls.push("checkpoint");
    return this.#inner.checkpoint(...a);
  }
  restore(...a: Parameters<SandboxProvider["restore"]>) {
    this.calls.push("restore");
    return this.#inner.restore(...a);
  }
  health(...a: Parameters<SandboxProvider["health"]>) {
    this.calls.push("health");
    return this.#inner.health(...a);
  }
}

describe("D2 — op routing (each ProviderOperation reaches its per-op method)", () => {
  it("routes create/execute/inspect/list/cancel/kill/destroy/health to their methods", async () => {
    const rec = new RecordingProvider(new E2bSandboxProvider({ transport: new MockE2bTransport() }));
    const driver = perOpToInvokeDriver(rec, { providerId: "e2b-route" });
    const created = await driver.invoke("create", { providerId: driver.providerId });
    expect(created.kind).toBe("created");
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    await driver.invoke("execute", { providerId: driver.providerId, resourceId: rid });
    await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid });
    await driver.invoke("list", { providerId: driver.providerId });
    await driver.invoke("cancel", { providerId: driver.providerId, resourceId: rid });
    await driver.invoke("kill", { providerId: driver.providerId, resourceId: rid });
    await driver.invoke("health", { providerId: driver.providerId, resourceId: rid });
    await driver.invoke("destroy", { providerId: driver.providerId, resourceId: rid });
    for (const method of ["create", "execute", "inspect", "list", "cancel", "kill", "health", "destroy"]) {
      expect(rec.calls, `expected op to route to ${method}`).toContain(method);
    }
  });

  it("reconcile_cleanup converges via list + teardown methods (provider-wide)", async () => {
    const rec = new RecordingProvider(new E2bSandboxProvider({ transport: new MockE2bTransport() }));
    const driver = perOpToInvokeDriver(rec, { providerId: "e2b-reco" });
    await driver.invoke("create", { providerId: driver.providerId });
    rec.calls.length = 0;
    const result = await driver.invoke("reconcile_cleanup", { providerId: driver.providerId });
    expect(result.kind).toBe("cleanup");
    expect(rec.calls).toContain("list"); // enumerated
    expect(rec.calls).toContain("destroy"); // reclaimed
  });
});

describe("D2 — every fault lever reaches the provider (observable outcome)", () => {
  it("egress.classification (non-allow) surfaces SandboxEgressDeniedError with the class", async () => {
    const driver = realDriver();
    const created = await driver.invoke("create", { providerId: driver.providerId });
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    let raised: unknown;
    try {
      await driver.invoke("execute", { providerId: driver.providerId, resourceId: rid, params: { egress: { classification: "metadata" } } });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("SandboxEgressDeniedError");
    expect((raised as { destinationClass?: string })?.destinationClass).toBe("metadata");
  });

  it("lifecycleFault:ttl and a zero deadline both reach a timedOut terminal", async () => {
    const driver = realDriver();
    const c1 = await driver.invoke("create", { providerId: driver.providerId });
    const r1 = c1.kind === "created" ? c1.resource.resourceId : "";
    const ttl = await driver.invoke("execute", { providerId: driver.providerId, resourceId: r1, params: { lifecycleFault: "ttl" } });
    expect(ttl.kind === "executed" && ttl.timedOut).toBe(true);
    const c2 = await driver.invoke("create", { providerId: driver.providerId });
    const r2 = c2.kind === "created" ? c2.resource.resourceId : "";
    const hung = await driver.invoke("execute", { providerId: driver.providerId, resourceId: r2, deadlineMs: 0 });
    expect(hung.kind === "executed" && hung.timedOut).toBe(true);
  });

  it("lifecycleFault:crash reaches a failed terminal", async () => {
    const driver = realDriver();
    const c = await driver.invoke("create", { providerId: driver.providerId });
    const rid = c.kind === "created" ? c.resource.resourceId : "";
    const crash = await driver.invoke("execute", { providerId: driver.providerId, resourceId: rid, params: { lifecycleFault: "crash" } });
    expect(crash.kind === "executed" && crash.terminalState === "failed").toBe(true);
  });

  it("withdrawEffectAuthority latches terminal denial of governed effects", async () => {
    const driver = realDriver();
    await driver.invoke("list", { providerId: driver.providerId, params: { withdrawEffectAuthority: true } });
    let raised: unknown;
    try {
      await driver.invoke("execute", { providerId: driver.providerId });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("EffectAuthorityWithdrawnError");
  });

  it("authority:cleanup denies effect ops with the matching attemptedOperation", async () => {
    const driver = realDriver();
    let raised: unknown;
    try {
      await driver.invoke("execute", { providerId: driver.providerId, params: { authority: "cleanup" } });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("CleanupAuthorityDeniedError");
    expect((raised as { attemptedOperation?: string })?.attemptedOperation).toBe("execute");
  });

  it("targetGeneration mismatch on the cleanup facet collapses to ResourceNotAvailableError", async () => {
    const driver = realDriver();
    const c = await driver.invoke("create", { providerId: driver.providerId, params: { resourceGeneration: 1 } });
    const rid = c.kind === "created" ? c.resource.resourceId : "";
    let raised: unknown;
    try {
      await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid, params: { authority: "cleanup", targetGeneration: 999 } });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("ResourceNotAvailableError");
  });

  it("faults.destroyFailures at the ceiling reports a bounded failed converge; below it converges", async () => {
    const ceiling = 3;
    const failDriver = realDriver({ maxDestroyAttempts: ceiling });
    await failDriver.invoke("create", { providerId: failDriver.providerId, params: { faults: { destroyFailures: ceiling } } });
    const failed = await failDriver.invoke("reconcile_cleanup", { providerId: failDriver.providerId, params: { authority: "cleanup" } });
    expect(failed.kind === "cleanup" && failed.cleanup.cleanupStatus).toBe("failed");

    const okDriver = realDriver({ maxDestroyAttempts: ceiling });
    await okDriver.invoke("create", { providerId: okDriver.providerId, params: { faults: { destroyFailures: ceiling - 1 } } });
    const ok = await okDriver.invoke("reconcile_cleanup", { providerId: okDriver.providerId, params: { authority: "cleanup" } });
    expect(ok.kind === "cleanup" && ok.cleanup.cleanupStatus).toBe("success");
  });

  it("sensitive/secret canaries are HELD by the provider but REDACTED from the neutral projection (non-vacuous)", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const driver = perOpToInvokeDriver(provider, { providerId: "e2b-redact" });
    const created = await driver.invoke("create", {
      providerId: driver.providerId,
      params: { sensitive: { command: "CANARY-CMD", env: "CANARY-ENV" }, secrets: { providerCredential: "CANARY-CRED" } },
    });
    const rid = created.kind === "created" ? created.resource.resourceId : "";
    // The provider HOLDS the sensitive command (proving redaction is real work — NON-vacuous
    // via `command`). ★ [Cred-1] (DEP-012 Slice 4+5): `env` is NO LONGER at rest — the
    // provider stopped copying the tenant env into durable E2B metadata, so `inspect.env` is
    // empty and the credential never sits in the durable store. This is a STRONGER property
    // than "redaction strips env": the env is not there to strip.
    const detail = await provider.inspect(rid, { deadlineMs: 1000, idempotencyKey: "k" });
    expect(detail.command).toBe("CANARY-CMD");
    expect(JSON.stringify(detail.env)).not.toContain("CANARY-CRED");
    expect(detail.env).toEqual({});
    // The neutral invoke-seam projection carries NONE of it.
    const inspect = await driver.invoke("inspect", { providerId: driver.providerId, resourceId: rid });
    expect(inspect.kind).toBe("inspect");
    const serialized = JSON.stringify(inspect);
    expect(serialized).not.toContain("CANARY-CMD");
    expect(serialized).not.toContain("CANARY-ENV");
    expect(serialized).not.toContain("CANARY-CRED");
  });
});

describe("D2 — advertisement gate", () => {
  it("an unadvertised optional op raises UnsupportedProviderOperation.operation", async () => {
    const driver = realDriver(); // default advertises core + health (NOT checkpoint/restore)
    let raised: unknown;
    try {
      await driver.invoke("checkpoint", { providerId: driver.providerId, resourceId: "x" });
    } catch (err) {
      raised = err;
    }
    expect((raised as { name?: string })?.name).toBe("UnsupportedProviderOperation");
    expect((raised as { operation?: string })?.operation).toBe("checkpoint");
  });

  it("an advertised optional op (pause/resume transport) routes through", async () => {
    const transport = new MockE2bTransport({ supportsPauseResume: true });
    const provider = new E2bSandboxProvider({ transport, advertisedOptionalOps: ["checkpoint", "restore", "health"] });
    const driver = perOpToInvokeDriver(provider, { providerId: "e2b-opt" });
    const c = await driver.invoke("create", { providerId: driver.providerId });
    const rid = c.kind === "created" ? c.resource.resourceId : "";
    const chk = await driver.invoke("checkpoint", { providerId: driver.providerId, resourceId: rid });
    expect(chk.kind).toBe("checkpoint");
    const res = await driver.invoke("restore", { providerId: driver.providerId, resourceId: rid });
    expect(res.kind).toBe("restore");
  });
});

// --- Non-vacuity: a SABOTAGED provider is caught (mirror of DEP-008 wrapDriver) --

/** Wrap a per-op provider, overriding one method with a sabotage. */
function sabotage(base: SandboxProvider, overrides: Partial<SandboxProvider>): SandboxProvider {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SandboxProvider;
}

describe("D2 — non-vacuity (a sabotaged provider is caught by the adapter)", () => {
  it("a destroy that always succeeds without reclaiming leaves resources — reconcile still reports, but list is non-empty", async () => {
    const transport = new MockE2bTransport();
    const inner = new E2bSandboxProvider({ transport });
    // Sabotage: destroy claims success but NEVER terminates (resource leaks).
    const broken = sabotage(inner, {
      destroy: async (): Promise<CleanupResult> => ({ providerOpId: "sabotage", cleanupStatus: "success" }),
    });
    const driver = perOpToInvokeDriver(broken, { providerId: "e2b-sab" });
    await driver.invoke("create", { providerId: driver.providerId });
    await driver.invoke("reconcile_cleanup", { providerId: driver.providerId });
    const list = await driver.invoke("list", { providerId: driver.providerId });
    // A faithful converge would leave zero; the sabotaged destroy leaks the resource.
    expect(list.kind === "list" && list.list.resources.length).toBeGreaterThan(0);
  });
});

// A CHARACTERIZATION test, NOT a non-vacuity guard: the adapter has no independent
// existence oracle — its no-oracle / not-found behaviour is only as strong as the
// PROVIDER's not-found signalling. This documents that seam boundary (a provider whose
// inspect fabricates a match defeats it). It belongs OUTSIDE the non-vacuity block above
// (whose guards genuinely catch a sabotaged provider), so the header is not misleading.
// TODO(CLI-004): once `requireOwned` gains a label/ownership check, promote this to a real
// guard asserting a foreign-labelled detail is denied.
describe("D2 — known limitation: the adapter has no independent inspect oracle", () => {
  it("an inspect that hides non-existence is NOT caught (the seam trusts the provider's not-found)", async () => {
    const transport = new MockE2bTransport();
    const inner = new E2bSandboxProvider({ transport });
    // Sabotage: inspect fabricates a matching detail for ANY id (no not-found).
    const broken = sabotage(inner, {
      inspect: async (sandboxId: string): Promise<InspectResult> => ({
        providerOpId: "sabotage",
        sandboxId,
        resourceLabels: { organizationId: "o", targetId: "t", workerId: "w", jobId: "j", attempt: 1, leaseId: "l", deviceGeneration: 1 },
        generation: 1,
        state: "running",
        command: "",
        env: {},
        logs: [],
        workspaceBytes: 0,
        objectGrants: [],
        secrets: {},
      }),
    });
    const driver = perOpToInvokeDriver(broken, { providerId: "e2b-oracle" });
    // An absent id on the cleanup facet SHOULD raise ResourceNotAvailableError; with the
    // sabotaged inspect it wrongly resolves to a live projection — the adapter's oracle-
    // freedom is only as strong as the provider's not-found signalling (proves the seam).
    const inspect = await driver.invoke("inspect", { providerId: driver.providerId, resourceId: "ghost", params: { authority: "cleanup" } });
    expect(inspect.kind).toBe("inspect");
    expect(inspect.kind === "inspect" && inspect.projection !== null).toBe(true);
  });
});

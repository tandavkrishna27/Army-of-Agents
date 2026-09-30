// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B2 — the teardown + redacted-read gated wire, component test.
//
// Runs on a GATED adapter-manager server (a control-plane public key is pinned) driven
// through the networked driver carrying a TEST-minted capability. Covers the 6 remaining
// gated ops — the 4 teardown ops (cancel/kill/destroy/reconcile_cleanup) + redacted
// inspect/list — OVER THE WIRE. Proves, per B2.4:
//   - each op OWNED -> dispatch + the right result;
//   - each op FOREIGN -> uniform ResourceNotAvailableError, NOT dispatched (a spy);
//   - MISSING capability -> refused (fail-closed parity with execute);
//   - an ALLOW-PATH dispatch fault -> the ORIGINAL class crosses, NOT the uniform error;
//   - a TRANSIENT inspect fault -> surfaced distinctly (not collapsed), so a teardown
//     converge would retry rather than leak;
//   - inspect/list wire bytes carry NO raw labels / sensitive fields; list returns only
//     the caller's OWN resources (a mixed-owner mock);
//   - the driver's inspect/list satisfy the port via synthesis (state/generation FROM the
//     projection; hasLiveLease = state==="running");
//   - EXHAUSTIVE routing: an UNGATED server 404s the 5 new ops (never raw).
//
// Single-tenant loopback, mock transport, no deploy — but the gated route stands up no
// reachable oracle.
// -----------------------------------------------------------------------------

import type { AddressInfo } from "node:net";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateSandboxSpec, ProviderOpContext, ResourceLabels } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/worker-daemon";
import {
  NetworkedProviderDriver,
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  WireProtocolError,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
  type OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-wire";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { SandboxEgressDeniedError } from "@armyofagents/sandbox-e2b-provider/errors.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";

import { createProviderServer } from "../server.js";

// Counts EVERY transport dispatch so "NOT dispatched" assertions are precise. Note the
// gate ALWAYS calls getInfo (the AM-local owned-check inspect) even on a refusal, so a
// refused teardown bumps getInfo but NOT signal/terminate — that is the property we test.
class CountingMockTransport extends MockE2bTransport {
  runCommandCalls = 0;
  signalCalls = 0;
  terminateCalls = 0;
  override async runCommand(
    ...args: Parameters<MockE2bTransport["runCommand"]>
  ): ReturnType<MockE2bTransport["runCommand"]> {
    this.runCommandCalls += 1;
    return super.runCommand(...args);
  }
  override async signal(
    ...args: Parameters<MockE2bTransport["signal"]>
  ): ReturnType<MockE2bTransport["signal"]> {
    this.signalCalls += 1;
    return super.signal(...args);
  }
  override async terminate(
    ...args: Parameters<MockE2bTransport["terminate"]>
  ): ReturnType<MockE2bTransport["terminate"]> {
    this.terminateCalls += 1;
    return super.terminate(...args);
  }
}

const NOW = 1_700_000_000_000;
const UNIFORM_ERR_BODY = JSON.stringify({ err: { name: "ResourceNotAvailableError", message: "resource not available" } });

const OWNED: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};
// A DIFFERENT worker (different coarse scope) — exists, not the caller's.
const FOREIGN: ResourceLabels = { ...OWNED, workerId: "wkr-2", leaseId: "lease-2" };
// SAME coarse (org/target/worker) but a DIFFERENT fine tuple — proves the fine filter bites.
const SAME_COARSE: ResourceLabels = { ...OWNED, jobId: "job-2", leaseId: "lease-9" };

const controlPlane = generateKeyPairSync("ed25519");

let transport: CountingMockTransport;
let server: ReturnType<typeof createProviderServer>;
let baseUrl: string;

async function startServer(
  providerFactory: (t: CountingMockTransport) => E2bSandboxProvider = (t) => new E2bSandboxProvider({ transport: t }),
  publicKey: KeyObject = controlPlane.publicKey,
): Promise<void> {
  transport = new CountingMockTransport();
  server = createProviderServer({ provider: providerFactory(transport), controlPlanePublicKey: publicKey, now: () => NOW });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => startServer());
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function ctx(overrides: Partial<ProviderOpContext> = {}): ProviderOpContext {
  return { deadlineMs: 5_000, idempotencyKey: "idem-1", ...overrides };
}
function specFor(labels: ResourceLabels): CreateSandboxSpec {
  return { resourceLabels: labels, command: "run.sh", args: [], env: { TENANT_TOKEN: "s3cr3t" }, workloadType: "coding" };
}
function mint(
  overrides: Partial<OwnedLabelsCapabilitySignedFields> = {},
  privateKey: KeyObject = controlPlane.privateKey,
): OwnedLabelsCapability {
  return signOwnedLabelsCapability(
    { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels: OWNED, expiresAt: NOW + 60_000, ...overrides },
    privateKey,
  );
}
// Now that a GATED server GATES `create` (β1), the setup mints + attaches a capability
// whose ownedLabels MATCH the labels it creates (the caller creates only its OWN-labeled
// sandbox). FOREIGN / SAME_COARSE setups mint their OWN foreign capability — the foreign
// sandbox created AS the foreign tenant. Against an UNGATED server the capability is inert
// (create keeps its raw keyless handler), so the same helper serves both.
async function createSandbox(labels: ResourceLabels, url: string = baseUrl): Promise<string> {
  const driver = new NetworkedProviderDriver({ baseUrl: url, capability: mint({ ownedLabels: labels }) });
  const r = await driver.create(specFor(labels), ctx({ idempotencyKey: `c-${labels.workerId}-${labels.leaseId}` }));
  return r.sandboxId;
}
/** POST a raw op body (bypassing the driver) and return the exact response text. */
async function rawOp(op: string, body: unknown, url: string = baseUrl): Promise<string> {
  const res = await fetch(`${url}/op/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.text();
}

// The 4 teardown ops as (driver method, transport-dispatch counter) pairs.
const TEARDOWNS = [
  { op: "cancel" as const, counter: "signalCalls" as const, expect: (r: unknown) => expect((r as { outcome: string }).outcome).toBe("stopped") },
  { op: "kill" as const, counter: "signalCalls" as const, expect: (r: unknown) => expect((r as { outcome: string }).outcome).toBe("stopped") },
  { op: "destroy" as const, counter: "terminateCalls" as const, expect: (r: unknown) => expect((r as { cleanupStatus: string }).cleanupStatus).toBe("success") },
  { op: "reconcileCleanup" as const, counter: "terminateCalls" as const, expect: (r: unknown) => expect((r as { cleanupStatus: string }).cleanupStatus).toBe("success") },
];

describe("B2 teardown ops — the allow path (owned -> dispatched)", () => {
  for (const { op, counter, expect: expectResult } of TEARDOWNS) {
    it(`${op} on the caller's OWN sandbox dispatches and returns the right result`, async () => {
      const sandboxId = await createSandbox(OWNED);
      const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
      const before = transport[counter];
      const result = await driver[op](sandboxId, ctx({ idempotencyKey: `t-${op}` }));
      expectResult(result);
      expect(transport[counter]).toBe(before + 1); // dispatched
    });
  }
});

describe("B2 teardown ops — refusals are uniform + never dispatched", () => {
  for (const { op, counter } of TEARDOWNS) {
    it(`${op} on a FOREIGN sandbox -> ResourceNotAvailableError, transport NOT hit`, async () => {
      const foreignId = await createSandbox(FOREIGN);
      const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
      const before = transport[counter];
      await expect(driver[op](foreignId, ctx({ idempotencyKey: `t-${op}-foreign` }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
      expect(transport[counter]).toBe(before); // NOT dispatched
    });

    it(`${op} with a MISSING capability -> refused, NOT dispatched (fail-closed parity)`, async () => {
      const sandboxId = await createSandbox(OWNED);
      const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
      const before = transport[counter];
      await expect(driver[op](sandboxId, ctx({ idempotencyKey: `t-${op}-nocap` }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
      expect(transport[counter]).toBe(before);
    });
  }

  it("the teardown foreign refusal is BYTE-IDENTICAL to not-found (the oracle collapse)", async () => {
    const foreignId = await createSandbox(FOREIGN);
    const cap = mint();
    const foreignBody = await rawOp("destroy", { args: foreignId, ctx: ctx(), capability: cap });
    const notFoundBody = await rawOp("destroy", { args: "sbx-nope", ctx: ctx(), capability: cap });
    expect(foreignBody).toBe(notFoundBody);
    expect(foreignBody).toBe(UNIFORM_ERR_BODY);
  });
});

describe("B2 — allow-path dispatch faults surface their OWN class (dispatch is outside the collapse)", () => {
  // A provider whose chosen dispatch method throws AFTER the owned-check passes. inspect
  // succeeds (owned-check ok), then the dispatch throws its own class — which must cross
  // UNCHANGED, never the uniform error.
  class DispatchFaultProvider extends E2bSandboxProvider {
    constructor(t: CountingMockTransport, private readonly faultOp: "execute" | "cancel" | "kill" | "destroy" | "reconcileCleanup") {
      super({ transport: t });
    }
    override async execute(...a: Parameters<E2bSandboxProvider["execute"]>): ReturnType<E2bSandboxProvider["execute"]> {
      if (this.faultOp === "execute") throw new SandboxEgressDeniedError("metadata");
      return super.execute(...a);
    }
    override async cancel(...a: Parameters<E2bSandboxProvider["cancel"]>): ReturnType<E2bSandboxProvider["cancel"]> {
      if (this.faultOp === "cancel") throw new SandboxEgressDeniedError("metadata");
      return super.cancel(...a);
    }
    override async kill(...a: Parameters<E2bSandboxProvider["kill"]>): ReturnType<E2bSandboxProvider["kill"]> {
      if (this.faultOp === "kill") throw new SandboxEgressDeniedError("metadata");
      return super.kill(...a);
    }
    override async destroy(...a: Parameters<E2bSandboxProvider["destroy"]>): ReturnType<E2bSandboxProvider["destroy"]> {
      if (this.faultOp === "destroy") throw new SandboxEgressDeniedError("metadata");
      return super.destroy(...a);
    }
    override async reconcileCleanup(...a: Parameters<E2bSandboxProvider["reconcileCleanup"]>): ReturnType<E2bSandboxProvider["reconcileCleanup"]> {
      if (this.faultOp === "reconcileCleanup") throw new SandboxEgressDeniedError("metadata");
      return super.reconcileCleanup(...a);
    }
  }

  for (const faultOp of ["execute", "cancel", "kill", "destroy", "reconcileCleanup"] as const) {
    it(`${faultOp}: owned-check passes then dispatch throws -> the ORIGINAL class crosses (not RNA)`, async () => {
      await server.close();
      await startServer((t) => new DispatchFaultProvider(t, faultOp));
      const sandboxId = await createSandbox(OWNED);
      const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
      const call =
        faultOp === "execute"
          ? driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "d-exec" }))
          : driver[faultOp](sandboxId, ctx({ idempotencyKey: `d-${faultOp}` }));
      await expect(call).rejects.toBeInstanceOf(SandboxEgressDeniedError);
      await expect(call.catch((e) => e)).resolves.not.toBeInstanceOf(ResourceNotAvailableError);
    });
  }
});

describe("B2 — a transient INSPECT fault is surfaced distinctly (not collapsed -> no leak)", () => {
  class InspectTransientProvider extends E2bSandboxProvider {
    constructor(t: CountingMockTransport, private readonly faultId: string) {
      super({ transport: t });
    }
    override async inspect(sandboxId: string, c: ProviderOpContext): ReturnType<E2bSandboxProvider["inspect"]> {
      if (sandboxId === this.faultId) throw new Error("inspect transport blip");
      return super.inspect(sandboxId, c);
    }
  }

  for (const op of ["cancel", "destroy"] as const) {
    it(`${op}: a transient inspect fault is NOT collapsed to RNA, and dispatch does NOT run`, async () => {
      // Discover the owned id first (against a clean server), then rebuild with the fault.
      const ownedId = await createSandbox(OWNED);
      await server.close();
      await startServer((t) => new InspectTransientProvider(t, ownedId));
      // Re-create the same-labeled sandbox on the fault server (ids are deterministic: first create -> sbx-000001).
      const sandboxId = await createSandbox(OWNED);
      expect(sandboxId).toBe(ownedId);
      const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
      const counterBefore = transport.signalCalls + transport.terminateCalls;
      const err = await driver[op](sandboxId, ctx({ idempotencyKey: `x-${op}` })).catch((e: unknown) => e);
      // Surfaced distinctly — NOT the uniform ownership refusal (over the wire a generic
      // fault becomes WireProtocolError; a teardown converge would retry, never leak).
      expect(err).not.toBeInstanceOf(ResourceNotAvailableError);
      expect(err).toBeInstanceOf(WireProtocolError);
      // The transient fired BEFORE the owned-check, so the teardown never dispatched.
      expect(transport.signalCalls + transport.terminateCalls).toBe(counterBefore);
    });
  }
});

describe("B2 inspect (redacted) — the allow path + no sensitive crossing", () => {
  it("inspect on OWN sandbox returns a synthesized, port-correct InspectResult with EMPTY sensitive fields", async () => {
    const sandboxId = await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    const result = await driver.inspect(sandboxId, ctx({ idempotencyKey: "i-own" }));
    // Own labels (from the capability) — F2-clean.
    expect(result.resourceLabels).toEqual(OWNED);
    // state + generation come FROM THE PROJECTION (the mock reports running / gen 7).
    expect(result.state).toBe("running");
    expect(result.generation).toBe(7);
    expect(result.sandboxId).toBe(sandboxId);
    // The sensitive fields are EMPTY — never the tenant command/env/secrets.
    expect(result.command).toBe("");
    expect(result.env).toEqual({});
    expect(result.secrets).toEqual({});
    expect(result.logs).toEqual([]);
    expect(result.workspaceBytes).toBe(0);
    expect(result.objectGrants).toEqual([]);
  });

  it("the inspect WIRE BYTES carry a hash — never raw labels, env, secrets, or command", async () => {
    const sandboxId = await createSandbox(OWNED);
    const body = await rawOp("inspect", { args: sandboxId, ctx: ctx(), capability: mint() });
    const parsed = JSON.parse(body) as { ok: Record<string, unknown> };
    expect(parsed.ok).toHaveProperty("resourceLabelsHash");
    expect(typeof parsed.ok.resourceLabelsHash).toBe("string");
    expect(parsed.ok).not.toHaveProperty("resourceLabels");
    expect(parsed.ok).not.toHaveProperty("env");
    expect(parsed.ok).not.toHaveProperty("secrets");
    expect(parsed.ok).not.toHaveProperty("command");
    // No raw label VALUE and no tenant secret anywhere in the bytes.
    expect(body).not.toContain("s3cr3t");
    expect(body).not.toContain("run.sh");
    expect(body).not.toContain("org-1");
    expect(body).not.toContain("lease-1");
  });

  it("inspect on a FOREIGN sandbox -> uniform ResourceNotAvailableError", async () => {
    const foreignId = await createSandbox(FOREIGN);
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    await expect(driver.inspect(foreignId, ctx({ idempotencyKey: "i-foreign" }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
  });
});

describe("B2 list (scoped + redacted) — only the caller's own resources cross", () => {
  it("returns ONLY the caller's own resources (mixed-owner mock), each redacted + synthesized", async () => {
    await createSandbox(OWNED); // sbx-000001
    await createSandbox(FOREIGN); // different worker
    await createSandbox(SAME_COARSE); // same coarse, different fine
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    const result = await driver.list({ ownershipSelector: { organizationId: "x", targetId: "x", workerId: "x" }, pageSize: 100 }, ctx({ idempotencyKey: "l-own" }));
    // Only the single OWNED tuple survives BOTH filter clauses.
    expect(result.resources).toHaveLength(1);
    const row = result.resources[0];
    expect(row.resourceLabels).toEqual(OWNED); // synthesized from the capability
    expect(row.generation).toBe(7);
    expect(row.state).toBe("running");
    expect(row.hasLiveLease).toBe(true); // synthesized = state === "running"
    expect(result.nextPageToken).toBeNull();
  });

  it("the list WIRE BYTES carry hashes only — no raw labels / secrets for ANY resource", async () => {
    await createSandbox(OWNED);
    await createSandbox(FOREIGN);
    const body = await rawOp("list", { args: { ownershipSelector: { organizationId: "x", targetId: "x", workerId: "x" }, pageSize: 100 }, ctx: ctx(), capability: mint() });
    const parsed = JSON.parse(body) as { ok: { resources: Record<string, unknown>[] } };
    expect(parsed.ok.resources.length).toBe(1);
    for (const r of parsed.ok.resources) {
      expect(r).toHaveProperty("resourceLabelsHash");
      expect(r).not.toHaveProperty("resourceLabels");
    }
    expect(body).not.toContain("s3cr3t");
    expect(body).not.toContain("org-1");
    expect(body).not.toContain("lease-1");
    expect(body).not.toContain("lease-2"); // not even the foreign resource's labels
  });

  it("★ F1 regression: nextPageToken is ALWAYS null — never a FOREIGN sandbox id (no cross-tenant cursor oracle)", async () => {
    // A mixed-owner host. A tiny client pageSize + a garbage client selector must NOT let the
    // caller walk the GLOBAL set via the cursor: the provider does not scope pagination, so a
    // real nextPageToken would be a foreign sandbox id. The server exposes no cursor at all.
    await createSandbox(OWNED); // sbx-000001
    const foreignId = await createSandbox(FOREIGN); // sbx-000002 — the victim id
    const body = await rawOp("list", {
      args: { ownershipSelector: { organizationId: "x", targetId: "x", workerId: "x" }, pageSize: 1, pageToken: null },
      ctx: ctx(),
      capability: mint(),
    });
    const parsed = JSON.parse(body) as { ok: { resources: unknown[]; nextPageToken: string | null } };
    expect(parsed.ok.nextPageToken).toBeNull(); // no cursor — the leak is closed
    expect(body).not.toContain(foreignId); // the victim's id never crosses, even as a cursor
    expect(parsed.ok.resources).toHaveLength(1); // only the caller's own row
  });

  it("list with a MISSING capability -> uniform ResourceNotAvailableError (fail-closed parity)", async () => {
    await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
    await expect(driver.list({ ownershipSelector: { organizationId: "x", targetId: "x", workerId: "x" }, pageSize: 100 }, ctx({ idempotencyKey: "l-nocap" }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
  });
});

describe("B2 — EXHAUSTIVE fail-closed routing (keyless posture)", () => {
  it("an UNGATED server 404s all 5 new ops (never a raw provider.inspect/list)", async () => {
    const ungated = createProviderServer({ provider: new E2bSandboxProvider({ transport: new MockE2bTransport() }), now: () => NOW });
    await new Promise<void>((resolve) => ungated.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(ungated.address() as AddressInfo).port}`;
    try {
      for (const op of ["cancel", "kill", "destroy", "reconcile_cleanup", "inspect", "list"]) {
        const res = await fetch(`${url}/op/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: "sbx-x", ctx: ctx() }) });
        expect(res.status).toBe(404);
        const parsed = JSON.parse(await res.text()) as { err?: { name?: string }; ok?: unknown };
        expect(parsed.ok).toBeUndefined();
        expect(parsed.err?.name).toBe("WireProtocolError");
      }
      // execute keeps its keyless handler (Unit A back-compat) — it does NOT 404.
      const created = await createSandbox(OWNED, url);
      const execDriver = new NetworkedProviderDriver({ baseUrl: url });
      const r = await execDriver.execute({ sandboxId: created, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "u-exec" }));
      expect(r.exitCode).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => ungated.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("a GATED server refuses a capability-less teardown/inspect/list with the uniform error, NOT a 404", async () => {
    const sandboxId = await createSandbox(OWNED);
    // No capability field at all — the fall-open guard: refuse with RNA, never dispatch.
    for (const [op, args] of [["cancel", sandboxId], ["inspect", sandboxId], ["list", { ownershipSelector: { organizationId: "x", targetId: "x", workerId: "x" }, pageSize: 100 }]] as const) {
      const body = await rawOp(op, { args, ctx: ctx() });
      const parsed = JSON.parse(body) as { err?: { name?: string } };
      expect(parsed.err?.name).toBe("ResourceNotAvailableError");
    }
  });
});

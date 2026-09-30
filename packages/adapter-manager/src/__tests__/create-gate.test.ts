// -----------------------------------------------------------------------------
// DEP-012 Slice 3 · Wave β1 — the create-gate + durable ledger, component test.
//
// Gating `create` is what a durable identity-namespaced ledger FORCES: the provider's
// own `#idempotency` map is keyed by the worker-chosen key alone and sits below the
// gate, so `create` must carry the capability. On a KEYED server every `create` routes
// through the create-gate (verify -> spec-label match -> ledger -> provider.create with
// a STRIPPED key); a KEYLESS server keeps `create` ungated (Unit A back-compat).
//
// Proves, OVER THE WIRE + at the provider boundary:
//   - own-labeled create ALLOWED; FOREIGN spec-labels -> uniform RNA (arbitrary-labels
//     hole closed); MISSING capability -> refused; keyless server -> create ungated;
//   - a legit replay (same identity + key) is a ledger HIT that BYPASSES provider.create;
//   - ★ THE STRIP: a cross-identity replay of the SAME idempotencyKey gives B its OWN
//     sandbox, never A's — AND provider.create is called with an EMPTY key (so the
//     provider's key-alone map can't echo A to B);
//   - ★ CONCURRENCY: two same-(identity,key) creates on ONE instance -> exactly ONE
//     provider.create (the mutex); a cross-replica race (two instances, shared ledger
//     volume + shared backend) -> exactly ONE sandbox survives (check-after-create tears
//     down the loser).
//
// Single-tenant loopback, mock transport, no deploy.
// -----------------------------------------------------------------------------

import type { AddressInfo } from "node:net";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateSandboxSpec, ProviderOpContext, ResourceLabels } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/worker-daemon";
import {
  NetworkedProviderDriver,
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
  type OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-wire";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";

import { createProviderServer } from "../server.js";
import { gateCreate, type CreateGateDeps } from "../create-gate.js";
import { IdempotencyLedger, IdempotencyLedgerError } from "../idempotency-ledger.js";
import { KeyedMutex } from "../keyed-mutex.js";
import type { SandboxProvider } from "@armyofagents/worker-daemon";

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
// A DIFFERENT identity (different worker) — its own tenant.
const OTHER: ResourceLabels = { ...OWNED, workerId: "wkr-2", leaseId: "lease-2" };

const controlPlane = generateKeyPairSync("ed25519");

/** A provider that records the idempotencyKey each create receives, and counts creates.
 * Extends the REAL provider so its `#idempotency` leak is live (the strip must close it). */
class CreateSpyProvider extends E2bSandboxProvider {
  readonly createKeys: string[] = [];
  override async create(spec: CreateSandboxSpec, ctx: ProviderOpContext): ReturnType<E2bSandboxProvider["create"]> {
    this.createKeys.push(ctx.idempotencyKey);
    return super.create(spec, ctx);
  }
}

function ctx(overrides: Partial<ProviderOpContext> = {}): ProviderOpContext {
  return { deadlineMs: 5_000, idempotencyKey: "idem-1", ...overrides };
}
function specFor(labels: ResourceLabels): CreateSandboxSpec {
  return { resourceLabels: labels, command: "run.sh", args: [], env: { TENANT_TOKEN: "s3cr3t" }, workloadType: "coding" };
}
function mint(ownedLabels: ResourceLabels, overrides: Partial<OwnedLabelsCapabilitySignedFields> = {}): OwnedLabelsCapability {
  return signOwnedLabelsCapability(
    { v: OWNED_LABELS_CAPABILITY_VERSION, audience: OWNED_LABELS_CAPABILITY_AUDIENCE, ownedLabels, expiresAt: NOW + 60_000, ...overrides },
    controlPlane.privateKey,
  );
}

const servers: ReturnType<typeof createProviderServer>[] = [];
const dirs: string[] = [];
async function listen(server: ReturnType<typeof createProviderServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
function tempLedgerDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aoa-am-cg-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("create-gate — the allow path + the arbitrary-labels closure", () => {
  it("own-labeled create is ALLOWED and returns the caller's labels", async () => {
    const provider = new E2bSandboxProvider({ transport: new MockE2bTransport() });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    const r = await driver.create(specFor(OWNED), ctx({ idempotencyKey: "c-own" }));
    expect(r.sandboxId).toBe("sbx-000001");
    expect(r.resourceLabels).toEqual(OWNED);
  });

  it("FOREIGN spec-labels (cap over OWNED, spec over OTHER) -> uniform RNA, NOT created", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    await expect(driver.create(specFor(OTHER), ctx({ idempotencyKey: "c-foreign" }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.liveCount()).toBe(0); // never provisioned
  });

  it("MISSING capability on a keyed server -> refused, NOT created", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
    await expect(driver.create(specFor(OWNED), ctx({ idempotencyKey: "c-nocap" }))).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.liveCount()).toBe(0);
  });

  it("the FOREIGN-spec refusal is BYTE-IDENTICAL to the uniform error (no oracle)", async () => {
    const provider = new E2bSandboxProvider({ transport: new MockE2bTransport() });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const res = await fetch(`${baseUrl}/op/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: specFor(OTHER), ctx: ctx(), capability: mint(OWNED) }),
    });
    expect(await res.text()).toBe(UNIFORM_ERR_BODY);
  });

  it("a KEYLESS server keeps create UNGATED (any labels, no capability)", async () => {
    const transport = new MockE2bTransport();
    const provider = new E2bSandboxProvider({ transport });
    const baseUrl = await listen(createProviderServer({ provider, now: () => NOW })); // no control-plane key -> ungated
    const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
    const r = await driver.create(specFor(OTHER), ctx({ idempotencyKey: "c-keyless" }));
    expect(r.sandboxId).toBe("sbx-000001"); // ungated create succeeds with arbitrary labels
    expect(transport.liveCount()).toBe(1);
  });
});

describe("create-gate — the durable ledger (replay bypasses the provider)", () => {
  it("a legit replay (same identity + key) is a HIT that does NOT call provider.create again", async () => {
    const provider = new CreateSpyProvider({ transport: new MockE2bTransport() });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    const first = await driver.create(specFor(OWNED), ctx({ idempotencyKey: "replay-key" }));
    const second = await driver.create(specFor(OWNED), ctx({ idempotencyKey: "replay-key" }));
    expect(second.sandboxId).toBe(first.sandboxId); // same sandbox
    expect(provider.createKeys.length).toBe(1); // provider.create called ONCE — the replay bypassed it
  });
});

describe("create-gate — ★ THE STRIP (cross-identity replay must not leak A's sandbox to B)", () => {
  it("B's replay of A's idempotencyKey yields B's OWN sandbox, and provider.create sees an EMPTY key", async () => {
    const provider = new CreateSpyProvider({ transport: new MockE2bTransport() });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const SHARED = "shared-idem-key";

    const driverA = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    const a = await driverA.create(specFor(OWNED), ctx({ idempotencyKey: SHARED }));

    // B is a DIFFERENT identity replaying the SAME idempotencyKey.
    const driverB = new NetworkedProviderDriver({ baseUrl, capability: mint(OTHER) });
    const b = await driverB.create(specFor(OTHER), ctx({ idempotencyKey: SHARED }));

    // B got its OWN sandbox + its OWN labels — never A's.
    expect(b.sandboxId).not.toBe(a.sandboxId);
    expect(b.resourceLabels).toEqual(OTHER);
    expect(a.resourceLabels).toEqual(OWNED);

    // ★ The strip: every provider.create was called with an EMPTY key, so the
    // provider's own key-alone `#idempotency` could never echo A's sandbox to B.
    expect(provider.createKeys).toEqual(["", ""]);
  });
});

describe("create-gate — the loser is torn down even when the winner re-read fails (no orphan)", () => {
  it("on already_present, tears down the just-created loser BEFORE the fallible winner lookup", async () => {
    // A loser must be reclaimed even if re-reading the winner throws (a corrupt own-key
    // entry). Reversed ordering (read-then-teardown) would strand the loser as an orphan
    // — the β1.6 crash-orphan class. Here the winner re-read throws, but the loser is gone.
    const destroyed: string[] = [];
    const fakeProvider = {
      create: async () => ({ sandboxId: "sbx-loser", providerOpId: "op", resourceLabels: OWNED }),
      destroy: async (id: string) => {
        destroyed.push(id);
        return { providerOpId: "d", cleanupStatus: "success" as const };
      },
    } as unknown as SandboxProvider;
    let lookups = 0;
    const fakeLedger = {
      key: () => "LK",
      lookup: () => {
        lookups += 1;
        if (lookups === 1) return null; // initial MISS -> proceed to create
        throw new IdempotencyLedgerError(); // the winner re-read is corrupt
      },
      record: () => "already_present" as const,
    } as unknown as IdempotencyLedger;
    const deps: CreateGateDeps = {
      provider: fakeProvider,
      controlPlanePublicKey: controlPlane.publicKey,
      now: () => NOW,
      ledger: fakeLedger,
      createLock: new KeyedMutex(),
    };
    await expect(gateCreate(deps, specFor(OWNED), ctx({ idempotencyKey: "k" }), mint(OWNED))).rejects.toBeInstanceOf(
      IdempotencyLedgerError,
    );
    // The loser was reclaimed despite the failed winner-read — no stranded orphan.
    expect(destroyed).toEqual(["sbx-loser"]);
  });
});

describe("create-gate — ★ CONCURRENCY (no double-provision)", () => {
  it("two same-(identity,key) creates on ONE instance -> exactly ONE provider.create (the mutex)", async () => {
    const transport = new MockE2bTransport();
    const provider = new CreateSpyProvider({ transport });
    const baseUrl = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: tempLedgerDir() }));
    const driverA = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    const driverB = new NetworkedProviderDriver({ baseUrl, capability: mint(OWNED) });
    const [a, b] = await Promise.all([
      driverA.create(specFor(OWNED), ctx({ idempotencyKey: "race-key" })),
      driverB.create(specFor(OWNED), ctx({ idempotencyKey: "race-key" })),
    ]);
    expect(a.sandboxId).toBe(b.sandboxId); // both got the same sandbox
    expect(provider.createKeys.length).toBe(1); // the mutex serialized -> ONE create
    expect(transport.liveCount()).toBe(1); // exactly one sandbox exists
  });

  it("a cross-replica race (two instances, shared ledger dir + shared backend) -> exactly ONE sandbox survives", async () => {
    // A rendezvous provider: both creates enter (past their ledger miss) and wait until
    // BOTH have arrived before provisioning — deterministically forcing the double-provision
    // the check-after-create must clean up. The provider (backend) is SHARED across the two
    // instances (one global sandbox namespace), and the ledger DIR is shared (a shared volume);
    // the two instances have SEPARATE in-process mutexes, so neither serializes the other.
    let entered = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => (releaseBoth = resolve));
    let terminateCount = 0;
    class RendezvousProvider extends E2bSandboxProvider {
      createCount = 0;
      override async create(spec: CreateSandboxSpec, c: ProviderOpContext): ReturnType<E2bSandboxProvider["create"]> {
        this.createCount += 1;
        entered += 1;
        if (entered === 2) releaseBoth();
        await bothArrived; // both past the ledger miss before EITHER records
        return super.create(spec, c);
      }
      override async destroy(sandboxId: string, c: ProviderOpContext): ReturnType<E2bSandboxProvider["destroy"]> {
        terminateCount += 1;
        return super.destroy(sandboxId, c);
      }
    }
    const transport = new MockE2bTransport();
    const provider = new RendezvousProvider({ transport }); // ONE shared backend
    const ledgerDir = tempLedgerDir(); // ONE shared volume

    const urlA = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: ledgerDir }));
    const urlB = await listen(createProviderServer({ provider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW, idempotencyLedgerDir: ledgerDir }));
    const driverA = new NetworkedProviderDriver({ baseUrl: urlA, capability: mint(OWNED) });
    const driverB = new NetworkedProviderDriver({ baseUrl: urlB, capability: mint(OWNED) });

    const [a, b] = await Promise.all([
      driverA.create(specFor(OWNED), ctx({ idempotencyKey: "xrep-key" })),
      driverB.create(specFor(OWNED), ctx({ idempotencyKey: "xrep-key" })),
    ]);

    expect(provider.createCount).toBe(2); // both genuinely provisioned (the race happened)
    expect(a.sandboxId).toBe(b.sandboxId); // both returned the SAME winner
    expect(terminateCount).toBe(1); // the loser was torn down
    expect(transport.liveCount()).toBe(1); // exactly ONE sandbox survives
  });
});

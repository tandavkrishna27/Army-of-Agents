// -----------------------------------------------------------------------------
// DEP-012 Slice 1 · Unit B1 — the execute OWNERSHIP GATE component test.
//
// Stands up the mock-backed adapter-manager server GATED with a control-plane public
// key, and drives it through the networked driver carrying a TEST-minted capability.
// Proves, OVER THE WIRE:
//   - own-sandbox execute is ALLOWED (label tuple + generation match);
//   - foreign-sandbox execute -> uniform ResourceNotAvailableError, BYTE-IDENTICAL to
//     not-found (the oracle collapse), and the transport is NOT hit (gate before dispatch);
//   - MISSING capability -> REFUSED with the uniform error, NOT dispatched (the R2
//     fall-open guard);
//   - bad-sig / expired / wrong-audience -> refused;
//   - a non-NotFound inspect fault ALSO collapses to the same uniform error;
//   - no sensitive projection crosses (the capability carries the caller's OWN labels —
//     signed, non-secret — never another worker's, and never env/secrets/command).
//
// Single-tenant loopback, mock transport, no deploy — but here the execute route IS
// gated (unlike Unit A's ungated component test), so it stands up no reachable oracle.
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
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
  type OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-wire";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";

import { createProviderServer } from "../server.js";

// A mock transport that counts runCommand — the EXECUTE dispatch. A refusal must
// never reach it (the gate refuses before provider.execute -> transport.runCommand).
// inspect uses getInfo, NOT runCommand, so an owned-check does not bump this.
class CountingMockTransport extends MockE2bTransport {
  runCommandCalls = 0;
  override async runCommand(
    ...args: Parameters<MockE2bTransport["runCommand"]>
  ): ReturnType<MockE2bTransport["runCommand"]> {
    this.runCommandCalls += 1;
    return super.runCommand(...args);
  }
}

const NOW = 1_700_000_000_000;

// The single byte-form every ownership refusal must produce (the oracle collapse).
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
// A DIFFERENT worker in the SAME org — its sandbox exists but is not the caller's.
const FOREIGN: ResourceLabels = { ...OWNED, workerId: "wkr-2", leaseId: "lease-2" };

const controlPlane = generateKeyPairSync("ed25519");

let transport: CountingMockTransport;
let server: ReturnType<typeof createProviderServer>;
let baseUrl: string;

async function startServer(publicKey: KeyObject = controlPlane.publicKey): Promise<void> {
  transport = new CountingMockTransport();
  const provider = new E2bSandboxProvider({ transport });
  server = createProviderServer({ provider, controlPlanePublicKey: publicKey, now: () => NOW });
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

/**
 * Create a sandbox with the given labels. Now that a GATED server GATES `create`
 * (β1), the setup mints + attaches a capability whose ownedLabels MATCH the labels
 * it creates — the caller creates only its OWN-labeled sandbox. A FOREIGN-labeled
 * setup thus mints its OWN foreign capability (the foreign sandbox created AS the
 * foreign tenant — the correct model), NOT the owner's.
 */
async function createSandbox(labels: ResourceLabels): Promise<string> {
  const driver = new NetworkedProviderDriver({ baseUrl, capability: mint({ ownedLabels: labels }) });
  const r = await driver.create(specFor(labels), ctx({ idempotencyKey: `c-${labels.workerId}` }));
  return r.sandboxId;
}

/** POST a raw execute body (bypassing the driver) and return the exact response text. */
async function rawExecute(body: unknown): Promise<string> {
  const res = await fetch(`${baseUrl}/op/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

describe("execute gate — the allow path", () => {
  it("allows execute on the caller's OWN sandbox (labels + generation match)", async () => {
    const sandboxId = await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    const before = transport.runCommandCalls;
    const result = await driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-own" }));
    expect(result.exitCode).toBe(0);
    expect(result.stdoutRef).toBe(`ref:stdout:${sandboxId}`);
    expect(transport.runCommandCalls).toBe(before + 1); // dispatched
  });
});

describe("execute gate — refusals are uniform + never dispatched", () => {
  it("foreign-sandbox execute -> ResourceNotAvailableError, transport NOT hit", async () => {
    const foreignId = await createSandbox(FOREIGN); // exists, but not the caller's
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    const before = transport.runCommandCalls;
    await expect(
      driver.execute({ sandboxId: foreignId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-foreign" })),
    ).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.runCommandCalls).toBe(before); // NOT dispatched
  });

  it("MISSING capability -> ResourceNotAvailableError, NOT dispatched (the fall-open guard)", async () => {
    const sandboxId = await createSandbox(OWNED);
    // A driver with NO capability sends a Unit-A-shaped envelope; the gate must refuse.
    const driver = new NetworkedProviderDriver({ baseUrl });
    const before = transport.runCommandCalls;
    await expect(
      driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-nocap" })),
    ).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.runCommandCalls).toBe(before);
  });

  it("bad-sig / expired / wrong-audience capabilities are all refused", async () => {
    const sandboxId = await createSandbox(OWNED);
    const foreign = generateKeyPairSync("ed25519");
    const caps: OwnedLabelsCapability[] = [
      mint({}, foreign.privateKey), // signed by the wrong key
      mint({ expiresAt: NOW - 1 }), // expired
      mint({ audience: "other" as typeof OWNED_LABELS_CAPABILITY_AUDIENCE }), // wrong audience
    ];
    for (const capability of caps) {
      const driver = new NetworkedProviderDriver({ baseUrl, capability });
      const before = transport.runCommandCalls;
      await expect(
        driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-bad" })),
      ).rejects.toBeInstanceOf(ResourceNotAvailableError);
      expect(transport.runCommandCalls).toBe(before);
    }
  });
});

describe("execute gate — the oracle collapse (byte-identical refusals)", () => {
  it("foreign-existing, genuinely-not-found, AND a capability failure are byte-identical", async () => {
    const foreignId = await createSandbox(FOREIGN);
    const cap = mint();

    const foreignBody = await rawExecute({ args: { sandboxId: foreignId, command: "x", args: [], env: {} }, ctx: ctx(), capability: cap });
    const notFoundBody = await rawExecute({ args: { sandboxId: "sbx-nope", command: "x", args: [], env: {} }, ctx: ctx(), capability: cap });
    const missingCapBody = await rawExecute({ args: { sandboxId: foreignId, command: "x", args: [], env: {} }, ctx: ctx() });

    // Every refusal is the SAME uniform error body (byte-identical) — no existence oracle.
    expect(foreignBody).toBe(notFoundBody);
    expect(foreignBody).toBe(missingCapBody);
    expect(foreignBody).toBe(UNIFORM_ERR_BODY);
  });

  it("a NON-NotFound inspect fault is SURFACED distinctly, NOT collapsed to the uniform error (B2 correction)", async () => {
    // ★ B2 CORRECTS B1's collapse-ALL: gateOwnedOp mirrors #requireOwned EXACTLY —
    // SandboxNotFoundError -> uniform, but any OTHER (transient) inspect fault is RETHROWN
    // as its own class. A transient is existence-orthogonal (oracle-safe), and collapsing
    // it would let the idempotent teardown converge read "vanished -> success" and LEAK the
    // sandbox. So the fault must NOT be byte-identical to the ownership refusal.
    class InspectFaultProvider extends E2bSandboxProvider {
      override async inspect(sandboxId: string, ctx: ProviderOpContext): ReturnType<E2bSandboxProvider["inspect"]> {
        if (sandboxId === "sbx-fault") throw new Error("transport blew up");
        return super.inspect(sandboxId, ctx);
      }
    }
    const faultServer = createProviderServer({
      provider: new InspectFaultProvider({ transport: new MockE2bTransport() }),
      controlPlanePublicKey: controlPlane.publicKey,
      now: () => NOW,
    });
    await new Promise<void>((resolve) => faultServer.listen(0, "127.0.0.1", resolve));
    const faultUrl = `http://127.0.0.1:${(faultServer.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${faultUrl}/op/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: { sandboxId: "sbx-fault", command: "x", args: [], env: {} }, ctx: ctx(), capability: mint() }),
      });
      const text = await res.text();
      // ★ The load-bearing property (B2 correction): the transient is NOT byte-identical to
      // the uniform ownership refusal — so an idempotent teardown can never read it as
      // "vanished -> success" and leak the sandbox. This STILL HOLDS after Cred-2.
      expect(text).not.toBe(UNIFORM_ERR_BODY);
      const parsed = JSON.parse(text) as { err?: { name?: string }; ok?: unknown };
      expect(parsed.ok).toBeUndefined();
      // ★ [Cred-2] (DEP-012 Slice 4+5): the AM error fence maps this unmodelled `Error`
      // (whose message could leak a provider-auth value) to a FIXED generic WireProtocolError
      // BEFORE encoding. The class name flattens from "Error" to "WireProtocolError" — but the
      // driver ALREADY reconstructed any unknown name (incl. a raw "Error") to WireProtocolError
      // via reconstructError's default, so no consumer behaviour changed; only the leak-prone
      // message is now generic. Crucially it is still ≠ ResourceNotAvailableError (asserted above).
      expect(parsed.err?.name).toBe("WireProtocolError");
    } finally {
      await new Promise<void>((resolve, reject) => faultServer.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("a GENERATION skew (labels match but generation differs) is refused — the generation clause bites", async () => {
    // In the mock, generation derives from deviceGeneration, so labelsEqual subsumes it.
    // This provider skews generation away from the labels so the generation clause is
    // the ONLY thing that can refuse — proving it is load-bearing (mutate-each-arm).
    class GenerationSkewProvider extends E2bSandboxProvider {
      override async inspect(sandboxId: string, ctx: ProviderOpContext): ReturnType<E2bSandboxProvider["inspect"]> {
        const detail = await super.inspect(sandboxId, ctx);
        return { ...detail, generation: detail.generation + 1000 };
      }
    }
    const transportLocal = new MockE2bTransport();
    const skewProvider = new GenerationSkewProvider({ transport: transportLocal });
    const skewServer = createProviderServer({ provider: skewProvider, controlPlanePublicKey: controlPlane.publicKey, now: () => NOW });
    await new Promise<void>((resolve) => skewServer.listen(0, "127.0.0.1", resolve));
    const skewUrl = `http://127.0.0.1:${(skewServer.address() as AddressInfo).port}`;
    try {
      // create is GATED on a keyed server (β1) — attach a matching capability.
      const createDriver = new NetworkedProviderDriver({ baseUrl: skewUrl, capability: mint() });
      const { sandboxId } = await createDriver.create(specFor(OWNED), ctx({ idempotencyKey: "c-skew" }));
      // labels match OWNED exactly, but inspect reports generation 1007 != owned deviceGeneration 7.
      const driver = new NetworkedProviderDriver({ baseUrl: skewUrl, capability: mint() });
      await expect(
        driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-skew" })),
      ).rejects.toBeInstanceOf(ResourceNotAvailableError);
    } finally {
      await new Promise<void>((resolve, reject) => skewServer.close((err) => (err ? reject(err) : resolve())));
    }
  });
});

describe("execute gate — no sensitive projection crosses", () => {
  it("the execute request carries the caller's OWN labels (signed) and no secret/env/command", async () => {
    const seen: string[] = [];
    const capturingFetch: typeof fetch = async (input, init) => {
      if (typeof init?.body === "string" && String(input).endsWith("/op/execute")) seen.push(init.body);
      return fetch(input, init);
    };
    const sandboxId = await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl, fetch: capturingFetch, capability: mint() });
    await driver.execute({ sandboxId, command: "run.sh", args: [], env: {} }, ctx({ idempotencyKey: "e-sens" }));

    expect(seen.length).toBe(1);
    const body = JSON.parse(seen[0]);
    // The capability carries the caller's OWN labels — non-secret by construction.
    expect(body.capability.ownedLabels).toEqual(OWNED);
    // It carries NO tenant secret, no env map, no foreign labels.
    expect(seen[0]).not.toContain("s3cr3t");
    expect(body.capability).not.toHaveProperty("env");
    expect(body.capability).not.toHaveProperty("secrets");
  });
});

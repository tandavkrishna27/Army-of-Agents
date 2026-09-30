// -----------------------------------------------------------------------------
// DEP-011 Slice 2a — the REAL minted-cap ↔ REAL gated-server crossing.
//
// The worker-side seam (the per-run `makeRunProvider` factory, the capability
// threading, the null-object late-binding, the honest cleanup) is proven in the
// worker-daemon component test. THIS test proves the other half end-to-end: a
// control-plane-minted `OwnedLabelsCapability` (Slice 1's mint, a TEST keypair here)
// VERIFIES at the REAL adapter-manager create-gate over the REAL
// `NetworkedProviderDriver` wire, and the redeemed model key rides `create`'s `env`
// ACROSS the wire INTO the provider's sandbox — the credential crossing (§2a.7).
//
// It lives in adapter-manager (which already depends on worker-daemon + provider-wire
// + sandbox-e2b-provider, and dev-depends on provider-capability, with NO `pnpm -r
// build` cycle) because a worker-daemon test importing `provider-wire`/`adapter-manager`
// would make worker-daemon dev-depend on its own consumers — an ORDER cycle that breaks
// `pnpm -r build` (DEP-011 §2a.11 records this repo-vs-design correction).
//
// `E2bSandboxProvider` is named ONLY in this `.test.ts` (excluded from
// `check-gate-clause-wiring`) and imported via subpaths so the real-transport / `e2b`
// SDK stay out of the module closure.
// -----------------------------------------------------------------------------

import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateSandboxSpec, ProviderOpContext, ResourceLabels } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/sandbox-e2b-provider/errors.js";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";
import { NetworkedProviderDriver } from "@armyofagents/provider-wire";
import { signOwnedLabelsCapability } from "@armyofagents/provider-capability";

import { createProviderServer } from "../server.js";

const REDEEMED_VALUE = "sk-ant-fixture-dep011-crossing-000";

/** The worker's `labelsFor(handoff)` tuple — the cap's `ownedLabels` AND the create spec's
 * `resourceLabels` must equal it, or the create-gate rejects. */
const RUN_LABELS: ResourceLabels = {
  organizationId: "org-1",
  targetId: "tgt-1",
  workerId: "wkr-1",
  jobId: "job-1",
  attempt: 1,
  leaseId: "lease-1",
  deviceGeneration: 7,
};

function specFor(labels: ResourceLabels = RUN_LABELS): CreateSandboxSpec {
  return { resourceLabels: labels, command: "codex", args: ["exec"], env: { ANTHROPIC_API_KEY: REDEEMED_VALUE }, workloadType: "batch" };
}

function ctx(key: string): ProviderOpContext {
  return { deadlineMs: 5_000, idempotencyKey: key };
}

/** Records the env each create receives — the provider-side "peek" that proves the model key
 * crossed the wire INTO the provider. ★ [Cred-1] (DEP-012 Slice 4+5): the env now crosses on
 * the `envVars` channel (the necessary channel E2B runs the sandbox with), NOT durable
 * `metadata` — the provider stopped copying the key into durable metadata (it would leave it
 * AT REST). This white-box capture moved from `req.metadata[__aoa_env]` to `req.envVars`. */
class CapturingMockTransport extends MockE2bTransport {
  readonly createdEnvs: Record<string, string>[] = [];
  override async create(req: Parameters<MockE2bTransport["create"]>[0]): ReturnType<MockE2bTransport["create"]> {
    const result = await super.create(req);
    this.createdEnvs.push({ ...req.envVars });
    return result;
  }
}

describe("DEP-011 Slice 2a — the minted-cap crossing over the REAL gated wire", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let server: ReturnType<typeof createProviderServer>;
  let transport: CapturingMockTransport;
  let baseUrl: string;
  const requestBodies: string[] = [];

  function mintCap(expiresAt: number, labels: ResourceLabels = RUN_LABELS) {
    return signOwnedLabelsCapability({ v: 1, audience: "adapter-manager", ownedLabels: labels, expiresAt }, privateKey);
  }

  const capturingFetch: typeof fetch = async (input, init) => {
    if (typeof init?.body === "string") requestBodies.push(init.body);
    return fetch(input, init);
  };

  beforeEach(async () => {
    requestBodies.length = 0;
    transport = new CapturingMockTransport();
    server = createProviderServer({ provider: new E2bSandboxProvider({ transport }), controlPlanePublicKey: publicKey });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("★ (a)/(b) — a valid minted cap VERIFIES at the create-gate and the model key CROSSES the wire into the sandbox env", async () => {
    const cap = mintCap(Date.now() + 3_600_000);
    const driver = new NetworkedProviderDriver({ baseUrl, fetch: capturingFetch, capability: cap });

    const result = await driver.create(specFor(), ctx("c-ok"));

    // (a) the create SUCCEEDED — the gate verified the cap + label-matched it.
    expect(result.sandboxId).toMatch(/^sbx-/);
    expect(result.resourceLabels).toEqual(RUN_LABELS);

    // (b) the redeemed model key crossed INTO the provider's create env (provider-side peek)…
    expect(transport.createdEnvs[0]?.ANTHROPIC_API_KEY).toBe(REDEEMED_VALUE);
    // …and it + the cap sig are present in the create REQUEST body (the crossing — §2a.7).
    expect(requestBodies.some((b) => b.includes(REDEEMED_VALUE))).toBe(true);
    expect(requestBodies.some((b) => b.includes(cap.sig))).toBe(true);
  });

  it("FAIL-CLOSED — a driver with NO capability is refused by the gate (uniform ResourceNotAvailableError); no sandbox is created", async () => {
    const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
    await expect(driver.create(specFor(), ctx("c-nocap"))).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.createdEnvs.length).toBe(0);
  });

  it("FAIL-CLOSED — an EXPIRED cap is refused (the gate checks expiresAt > now on its OWN clock)", async () => {
    const cap = mintCap(Date.now() - 1); // already expired
    const driver = new NetworkedProviderDriver({ baseUrl, capability: cap });
    await expect(driver.create(specFor(), ctx("c-exp"))).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.createdEnvs.length).toBe(0);
  });

  it("FAIL-CLOSED — a cap whose ownedLabels do NOT match the spec labels is refused (no foreign-labeled create)", async () => {
    const cap = mintCap(Date.now() + 3_600_000); // ownedLabels = RUN_LABELS
    const driver = new NetworkedProviderDriver({ baseUrl, capability: cap });
    const foreignSpec = specFor({ ...RUN_LABELS, jobId: "job-OTHER" });
    await expect(driver.create(foreignSpec, ctx("c-foreign"))).rejects.toBeInstanceOf(ResourceNotAvailableError);
    expect(transport.createdEnvs.length).toBe(0);
  });
});

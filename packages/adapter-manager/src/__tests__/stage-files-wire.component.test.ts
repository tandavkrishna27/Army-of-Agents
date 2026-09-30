// -----------------------------------------------------------------------------
// E7-F011 — the networked stage_files wire route, component test.
//
// Closes the last hop of the staged-input pipeline on the NETWORKED/container lane:
// NetworkedProviderDriver.stageFiles -> POST /op/stage_files -> the GATED adapter-manager
// server -> gateOwnedOp -> the real E2bSandboxProvider.stageFiles (redeem grant -> verify
// sha256/maxBytes -> transport.writeFiles). Proves:
//   - OWNED  -> dispatched: the file lands in the sandbox fs; the result carries only paths;
//   - FOREIGN -> uniform ResourceNotAvailableError, NOT dispatched (a write spy);
//   - MISSING capability -> refused (fail-closed parity with execute/teardown);
//   - GRANT, NOT BYTES: the request body carries the download grant, never payload bytes;
//   - GATED-ONLY: an UNGATED (keyless) server 404s stage_files (never a raw write);
//   - the driver advertises fileStagingMode="grant_download".
//
// Single-tenant loopback, mock transport (key-less), no deploy. The grant redemption is
// injected (redeemDownloadGrant) so no network fetch is needed.
// -----------------------------------------------------------------------------

import type { AddressInfo } from "node:net";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CreateSandboxSpec, ProviderOpContext, ResourceLabels, StagedFileRequest } from "@armyofagents/worker-daemon";
import { ResourceNotAvailableError } from "@armyofagents/worker-daemon";
import {
  NetworkedProviderDriver,
  OWNED_LABELS_CAPABILITY_AUDIENCE,
  OWNED_LABELS_CAPABILITY_VERSION,
  signOwnedLabelsCapability,
  type OwnedLabelsCapability,
  type OwnedLabelsCapabilitySignedFields,
} from "@armyofagents/provider-wire";
import type { ArtifactDownloadGrantV1 } from "@armyofagents/worker-protocol";
import { E2bSandboxProvider } from "@armyofagents/sandbox-e2b-provider/e2b-provider.js";
import { MockE2bTransport } from "@armyofagents/sandbox-e2b-provider/mock-transport.js";

import { createProviderServer } from "../server.js";

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
// A DIFFERENT worker — exists, not the caller's.
const FOREIGN: ResourceLabels = { ...OWNED, workerId: "wkr-2", leaseId: "lease-2" };

const controlPlane = generateKeyPairSync("ed25519");

// The staged bytes + a grant whose expectedSha256/maxBytes match them, so the provider's
// verify passes. redeemDownloadGrant is injected to return these bytes (no network).
const STAGED_BYTES = new TextEncoder().encode("## Current Task\n- Task ID: t-1\n");
const STAGED_SHA = createHash("sha256").update(STAGED_BYTES).digest("hex");
const STAGED_PATH = "/home/user/.aoa/AGENTS.md";
const OBJECT_KEY = "organizations/org-1/jobs/job-1/attempts/1/00000000-0000-4000-8000-0000000000a1";

function grant(): ArtifactDownloadGrantV1 {
  return {
    protocolVersion: 1,
    operation: "download",
    artifactId: "00000000-0000-4000-8000-0000000000a1",
    method: "GET",
    url: "https://store.example/get?sig=abc",
    headers: {},
    issuedAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2126-09-03T12:05:00.000Z",
    maxBytes: STAGED_BYTES.byteLength,
    expectedSha256: STAGED_SHA,
    objectKey: OBJECT_KEY,
    redaction: "secret",
  } as ArtifactDownloadGrantV1;
}
const FILES: readonly StagedFileRequest[] = [{ path: STAGED_PATH, grant: grant() }];

// Records every writeFiles dispatch so "NOT dispatched" is precise + lets us assert the
// bytes landed in the sandbox fs.
class RecordingMockTransport extends MockE2bTransport {
  writeFilesCalls = 0;
  override async writeFiles(
    ...args: Parameters<MockE2bTransport["writeFiles"]>
  ): ReturnType<MockE2bTransport["writeFiles"]> {
    this.writeFilesCalls += 1;
    return super.writeFiles(...args);
  }
}

let transport: RecordingMockTransport;
let server: ReturnType<typeof createProviderServer>;
let baseUrl: string;

// `gated` is an explicit boolean, NOT an optional KeyObject: passing `undefined` for a
// defaulted KeyObject param would trigger the default (a key) and quietly gate the server,
// which is exactly the trap that made the "ungated 404" case pass a key by mistake.
async function startServer(gated = true): Promise<void> {
  transport = new RecordingMockTransport();
  const provider = new E2bSandboxProvider({
    transport,
    // GRANT, NOT BYTES over the wire: the provider redeems the pointer here. Injected so the
    // test needs no network — returns the staged bytes the grant's sha256/maxBytes describe.
    redeemDownloadGrant: async () => STAGED_BYTES,
  });
  server = createProviderServer({ provider, controlPlanePublicKey: gated ? controlPlane.publicKey : undefined, now: () => NOW });
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
async function createSandbox(labels: ResourceLabels, url: string = baseUrl): Promise<string> {
  const driver = new NetworkedProviderDriver({ baseUrl: url, capability: mint({ ownedLabels: labels }) });
  const r = await driver.create(specFor(labels), ctx({ idempotencyKey: `c-${labels.workerId}-${labels.leaseId}` }));
  return r.sandboxId;
}
async function rawOp(op: string, body: unknown, url: string = baseUrl): Promise<string> {
  const res = await fetch(`${url}/op/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.text();
}

describe("E7-F011 stage_files over the networked wire", () => {
  it("the driver advertises fileStagingMode='grant_download' (relays over the wire)", () => {
    expect(new NetworkedProviderDriver({ baseUrl }).fileStagingMode).toBe("grant_download");
  });

  it("OWNED sandbox: stages over the wire, the file lands in the sandbox, result carries only paths", async () => {
    const sandboxId = await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() });
    const before = transport.writeFilesCalls;

    const result = await driver.stageFiles(sandboxId, FILES, ctx({ idempotencyKey: "s-1" }));

    expect(result.stagedPaths).toEqual([STAGED_PATH]);
    expect(transport.writeFilesCalls).toBe(before + 1); // dispatched to the real provider->transport
    // the bytes actually landed in the sandbox fs (redeem -> verify -> writeFiles all ran)
    expect(await transport.readFile(sandboxId, STAGED_PATH)).toEqual(STAGED_BYTES);
    // only paths cross back — no bytes on the result
    expect(Object.keys(result)).toEqual(["stagedPaths"]);
  });

  it("FOREIGN sandbox: uniform ResourceNotAvailableError, transport NOT hit", async () => {
    const foreignId = await createSandbox(FOREIGN);
    const driver = new NetworkedProviderDriver({ baseUrl, capability: mint() }); // OWNED capability
    const before = transport.writeFilesCalls;
    await expect(driver.stageFiles(foreignId, FILES, ctx({ idempotencyKey: "s-foreign" }))).rejects.toBeInstanceOf(
      ResourceNotAvailableError,
    );
    expect(transport.writeFilesCalls).toBe(before); // NOT dispatched
  });

  it("MISSING capability: refused, NOT dispatched (fail-closed parity)", async () => {
    const sandboxId = await createSandbox(OWNED);
    const driver = new NetworkedProviderDriver({ baseUrl }); // no capability
    const before = transport.writeFilesCalls;
    await expect(driver.stageFiles(sandboxId, FILES, ctx({ idempotencyKey: "s-nocap" }))).rejects.toBeInstanceOf(
      ResourceNotAvailableError,
    );
    expect(transport.writeFilesCalls).toBe(before);
  });

  it("the FOREIGN refusal is BYTE-IDENTICAL to not-found (no ownership oracle)", async () => {
    const foreignId = await createSandbox(FOREIGN);
    const cap = mint();
    const foreignBody = await rawOp("stage_files", { args: { sandboxId: foreignId, files: FILES }, ctx: ctx(), capability: cap });
    const notFoundBody = await rawOp("stage_files", { args: { sandboxId: "sbx-nope", files: FILES }, ctx: ctx(), capability: cap });
    expect(foreignBody).toBe(notFoundBody);
    expect(foreignBody).toBe(UNIFORM_ERR_BODY);
  });

  it("GATED-ONLY: an UNGATED (keyless) server 404s stage_files (never a raw write)", async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await startServer(false); // ungated (no control-plane key)
    const body = await rawOp("stage_files", { args: { sandboxId: "sbx-anything", files: FILES }, ctx: ctx() });
    expect(body).toContain("WireProtocolError");
    expect(body).toContain("operation not available in this slice: stage_files");
    expect(transport.writeFilesCalls).toBe(0);
  });
});

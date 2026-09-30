// CLI-008 Unit B — the provider-side INBOUND file-staging capability.
//
// The mirror of `artifact-export-capability.test.ts`, and deliberately so: the export pair
// (`exportArtifact` + `artifactExportMode`) is the shipped precedent for growing this port
// without touching the frozen wire vocabulary, and this pair is modelled on it exactly.
//
// ★ The most important tests here are the ones asserting an unknown object and a WRONG DIGEST
// both FAIL. A double that staged fabricated bytes would be the WRK-009 defect again: a
// fabricated stage is byte-identical to a real one on every gate downstream, so nothing could
// tell that the agent is working from the wrong instructions.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { UnsupportedProviderOperation } from "../supervisor/provider.js";
import type { ResourceLabels } from "../supervisor/provider.js";

const CTX = { deadlineMs: 5_000, idempotencyKey: "idem-stage-1" };
const OBJECT_KEY = "organizations/org_1/jobs/job_1/attempts/1/mcp";
const BODY = '{"mcpServers":{"aoa":{"type":"http"}}}';
const PATH = "/home/user/.aoa/mcp.json";

const LABELS: ResourceLabels = {
  organizationId: "org_1",
  companyId: "co_1",
  jobId: "job_1",
  attempt: 1,
  leaseId: "lease_1",
  workerId: "worker_1",
  targetId: "target_1",
  deviceGeneration: 1,
};

function grant(overrides: Partial<{ objectKey: string; expectedSha256: string; maxBytes: number }> = {}) {
  return {
    protocolVersion: 1 as const,
    operation: "download" as const,
    artifactId: "00000000-0000-4000-8000-0000000000a1",
    method: "GET" as const,
    url: "https://store.example/get?sig=abc",
    headers: {},
    issuedAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2026-09-03T12:05:00.000Z",
    maxBytes: overrides.maxBytes ?? Buffer.byteLength(BODY),
    expectedSha256: overrides.expectedSha256 ?? createHash("sha256").update(BODY).digest("hex"),
    objectKey: overrides.objectKey ?? OBJECT_KEY,
    redaction: "secret" as const,
  };
}

async function staging() {
  const provider = createFakeSandboxProvider({
    fileStagingMode: "grant_download",
    stagedObjects: { [OBJECT_KEY]: BODY },
  });
  const created = await provider.create(
    { resourceLabels: LABELS, command: "claude", args: [], env: {}, workloadType: "batch" },
    CTX,
  );
  return { provider, sandboxId: created.sandboxId };
}

describe("CLI-008 Unit B — provider file-staging capability", () => {
  it("★ a provider that does not support staging DECLINES", async () => {
    // Default mode is "none" — an unscripted double must refuse, never report a phantom stage.
    const provider = createFakeSandboxProvider({});
    expect(provider.fileStagingMode).toBe("none");
    await expect(provider.stageFiles("sb-1", [{ path: PATH, grant: grant() }], CTX)).rejects.toBeInstanceOf(
      UnsupportedProviderOperation,
    );
  });

  it("stages a file into the sandbox with the granted object's bytes", async () => {
    const { provider, sandboxId } = await staging();
    const result = await provider.stageFiles(sandboxId, [{ path: PATH, grant: grant() }], CTX);
    expect(result.stagedPaths).toEqual([PATH]);
    expect(provider.stagedFiles()[PATH]).toBe(BODY);
  });

  it("★ an UNKNOWN object FAILS rather than staging fabricated content", async () => {
    const { provider, sandboxId } = await staging();
    await expect(
      provider.stageFiles(sandboxId, [{ path: PATH, grant: grant({ objectKey: "organizations/org_1/jobs/job_1/attempts/1/nope" }) }], CTX),
    ).rejects.toThrow();
    expect(provider.stagedFiles()).toEqual({});
  });

  it("★ a WRONG DIGEST FAILS — the bytes are verified before they are written", async () => {
    const { provider, sandboxId } = await staging();
    await expect(
      provider.stageFiles(sandboxId, [{ path: PATH, grant: grant({ expectedSha256: "0".repeat(64) }) }], CTX),
    ).rejects.toThrow(/hashed/);
    expect(provider.stagedFiles()).toEqual({});
  });

  it("★ staging is ALL-OR-NOTHING — one bad file stages none of them", async () => {
    // A partial stage is worse than no stage: the agent cannot tell which files it is missing.
    const { provider, sandboxId } = await staging();
    await expect(
      provider.stageFiles(
        sandboxId,
        [
          { path: PATH, grant: grant() },
          { path: "/home/user/.aoa/AGENTS.md", grant: grant({ objectKey: "organizations/org_1/jobs/job_1/attempts/1/missing" }) },
        ],
        CTX,
      ),
    ).rejects.toThrow();
    expect(provider.stagedFiles()).toEqual({});
  });

  it("★ the GRANT is not retained anywhere observable — only the object key", async () => {
    // The grant is a bearer capability: anyone holding it can read that key until it expires.
    const { provider, sandboxId } = await staging();
    await provider.stageFiles(sandboxId, [{ path: PATH, grant: grant() }], CTX);
    const recorded = JSON.stringify(provider.redeemedObjectKeys);
    expect(recorded).not.toContain("sig=abc");
    expect(recorded).not.toContain("https://");
    expect(provider.redeemedObjectKeys).toEqual([OBJECT_KEY]);
  });

  it("★ stage_files is NOT in advertisedOperations — that set is the FROZEN vocabulary", async () => {
    // Support is declared by `fileStagingMode`, exactly as the export pair declares its own
    // support by `artifactExportMode`. Two layers, deliberately not collapsed: a non-frozen
    // capability cannot enter `advertisedOperations`, and does not need to.
    const { provider } = await staging();
    expect([...provider.advertisedOperations]).not.toContain("stage_files");
  });

  it("stages nothing for an empty list without touching the sandbox", async () => {
    const { provider, sandboxId } = await staging();
    const result = await provider.stageFiles(sandboxId, [], CTX);
    expect(result.stagedPaths).toEqual([]);
    expect(provider.stagedFiles()).toEqual({});
  });
});

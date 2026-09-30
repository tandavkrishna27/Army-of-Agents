// CLI-008 Unit B — `E2bSandboxProvider.stageFiles` over the REAL driver logic and the
// deterministic, key-less mock transport.
//
// `transport.writeFiles` has existed in BOTH drivers since CLI-002/D1 with no caller on the
// distributed path. This is that caller. The redemption side is injected, exactly as the
// transport is, so the whole path is provable with no key and no network.
//
// ★ The load-bearing cases are the two REFUSALS. A provider that wrote unverified bytes would
// produce a sandbox whose agent works from the wrong file and whose run terminalizes cleanly —
// indistinguishable from success on every gate downstream.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import type { ArtifactDownloadGrantV1 } from "@armyofagents/worker-protocol";

const CTX = { deadlineMs: 30_000, idempotencyKey: "idem-stage" };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const LABELS = {
  organizationId: "org_1",
  companyId: "co_1",
  jobId: "job_1",
  attempt: 1,
  leaseId: "lease_1",
  workerId: "worker_1",
  targetId: "target_1",
  deviceGeneration: 1,
};

function grant(objectKey: string, body: string, overrides: Partial<ArtifactDownloadGrantV1> = {}): ArtifactDownloadGrantV1 {
  return {
    protocolVersion: 1,
    operation: "download",
    artifactId: "00000000-0000-4000-8000-0000000000a1",
    method: "GET",
    url: `https://store.example/get/${encodeURIComponent(objectKey)}?sig=abc`,
    headers: {},
    issuedAt: "2026-09-03T12:00:00.000Z",
    expiresAt: "2026-09-03T12:05:00.000Z",
    maxBytes: Buffer.byteLength(body),
    expectedSha256: sha256(body),
    objectKey,
    redaction: "secret",
    ...overrides,
  } as ArtifactDownloadGrantV1;
}

/** An in-memory "object store" standing in for the presigned GET. */
function makeStore(objects: Record<string, string>) {
  const redeemedUrls: string[] = [];
  return {
    redeemedUrls,
    redeem: async (g: ArtifactDownloadGrantV1): Promise<Uint8Array> => {
      redeemedUrls.push(g.url);
      const body = objects[g.objectKey];
      if (body === undefined) throw new Error(`no such object`);
      return enc(body);
    },
  };
}

async function provider(objects: Record<string, string>) {
  const transport = new MockE2bTransport();
  const store = makeStore(objects);
  const p = new E2bSandboxProvider({ transport, redeemDownloadGrant: store.redeem });
  const created = await p.create(
    { resourceLabels: LABELS, command: "claude", args: ["--print", "hi"], env: {}, workloadType: "batch" },
    CTX,
  );
  return { provider: p, transport, store, sandboxId: created.sandboxId };
}

describe("CLI-008 Unit B — E2bSandboxProvider.stageFiles (mock transport, no key)", () => {
  it("declares grant_download support — the transport has writeFiles, so this is honest", async () => {
    const { provider: p } = await provider({});
    expect(p.fileStagingMode).toBe("grant_download");
    // ...and it is still NOT a frozen wire operation.
    expect([...p.advertisedOperations]).not.toContain("stage_files");
  });

  it("★ redeems the grant and the bytes are READABLE BACK from inside the sandbox", async () => {
    const key = "organizations/org_1/jobs/job_1/attempts/1/a1";
    const body = '{"mcpServers":{"aoa":{"type":"http","url":"https://x/mcp"}}}';
    const { provider: p, transport, sandboxId } = await provider({ [key]: body });

    const result = await p.stageFiles(sandboxId, [{ path: "/home/user/.aoa/mcp.json", grant: grant(key, body) }], CTX);

    expect(result.stagedPaths).toEqual(["/home/user/.aoa/mcp.json"]);
    expect(dec(await transport.readFile(sandboxId, "/home/user/.aoa/mcp.json"))).toBe(body);
  });

  it("stages several files in one call", async () => {
    const objects = {
      "organizations/org_1/jobs/job_1/attempts/1/a1": "one",
      "organizations/org_1/jobs/job_1/attempts/1/a2": "two",
    };
    const { provider: p, transport, sandboxId } = await provider(objects);
    await p.stageFiles(
      sandboxId,
      [
        { path: "/home/user/.aoa/one.txt", grant: grant("organizations/org_1/jobs/job_1/attempts/1/a1", "one") },
        { path: "/home/user/.aoa/two.txt", grant: grant("organizations/org_1/jobs/job_1/attempts/1/a2", "two") },
      ],
      CTX,
    );
    expect(dec(await transport.readFile(sandboxId, "/home/user/.aoa/one.txt"))).toBe("one");
    expect(dec(await transport.readFile(sandboxId, "/home/user/.aoa/two.txt"))).toBe("two");
  });

  it("★ a DIGEST MISMATCH refuses, and writes NOTHING", async () => {
    const key = "organizations/org_1/jobs/job_1/attempts/1/a1";
    // The store serves different bytes than the grant was minted against.
    const { provider: p, transport, sandboxId } = await provider({ [key]: "tampered" });
    await expect(
      p.stageFiles(sandboxId, [{ path: "/home/user/.aoa/x.md", grant: grant(key, "original") }], CTX),
    ).rejects.toThrow(/hashed/);
    await expect(transport.readFile(sandboxId, "/home/user/.aoa/x.md")).rejects.toThrow();
  });

  it("★ an OVERSIZED object refuses before the digest is even considered", async () => {
    const key = "organizations/org_1/jobs/job_1/attempts/1/a1";
    const body = "0123456789";
    const { provider: p, transport, sandboxId } = await provider({ [key]: body });
    await expect(
      p.stageFiles(sandboxId, [{ path: "/x.md", grant: grant(key, body, { maxBytes: 3 }) }], CTX),
    ).rejects.toThrow(/over the granted/);
    await expect(transport.readFile(sandboxId, "/x.md")).rejects.toThrow();
  });

  it("★ ALL-OR-NOTHING — a second file that fails leaves the FIRST unwritten too", async () => {
    const good = "organizations/org_1/jobs/job_1/attempts/1/a1";
    const { provider: p, transport, sandboxId } = await provider({ [good]: "good" });
    await expect(
      p.stageFiles(
        sandboxId,
        [
          { path: "/good.md", grant: grant(good, "good") },
          { path: "/missing.md", grant: grant("organizations/org_1/jobs/job_1/attempts/1/nope", "x") },
        ],
        CTX,
      ),
    ).rejects.toThrow();
    await expect(transport.readFile(sandboxId, "/good.md")).rejects.toThrow();
  });

  it("★ a failed redemption never puts the grant's URL in the error", async () => {
    // The url IS the bearer capability. An error message is one of the easiest places for it
    // to escape into a log.
    const key = "organizations/org_1/jobs/job_1/attempts/1/a1";
    const { provider: p, sandboxId } = await provider({ [key]: "tampered" });
    const error = await p
      .stageFiles(sandboxId, [{ path: "/x.md", grant: grant(key, "original") }], CTX)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("sig=abc");
    expect(error.message).not.toContain("https://");
  });

  it("an empty list is a no-op that never touches the transport", async () => {
    const { provider: p, store, sandboxId } = await provider({});
    expect(await p.stageFiles(sandboxId, [], CTX)).toEqual({ stagedPaths: [] });
    expect(store.redeemedUrls).toEqual([]);
  });
});

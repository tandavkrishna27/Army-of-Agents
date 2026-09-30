// DAT-009 — `E2bSandboxProvider.digestArtifact` / `exportArtifact` over the REAL driver logic
// and the deterministic, key-less mock transport.
//
// `transport.readFile` has existed in BOTH drivers since CLI-002/D1. Slice 1 said so in the
// provider's own words — "a real implementation is a small, provider-specific piece" — declared
// `artifactExportMode = "none"`, and declined. This is that piece, and these are its guards.
//
// ★ THE LOAD-BEARING CASES ARE THE REFUSALS, exactly as they are for `stageFiles`. A provider
// that fabricated a digest would mint a grant for bytes that do not exist; a provider that
// uploaded without re-verifying would push the refusal out to the fenced commit's `headObject`
// check, in another process, with nothing left to point at. Both are WRK-009: a fabricated
// success that is byte-identical to a real one on every gate downstream.
//
// ★★ WHAT THIS FILE DOES NOT CLAIM. Nothing here puts a `job_artifacts` row on a run, and
// nothing here moves `capabilityProven`. The worker-side sequencer is DAT-009 slice 3 and is
// unbuilt; the counter additionally filters `kind = 'workspace_patch'`. See
// `CLI-008-unit-f-design.md` §1.6 link 2.

import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import { SandboxNotFoundError } from "../errors.js";
import type { ArtifactUploadGrantV1 } from "@armyofagents/worker-protocol";

const CTX = { deadlineMs: 30_000, idempotencyKey: "idem-export" };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const sha256B64 = (s: string) => createHash("sha256").update(s).digest("base64");

const OUT_PATH = "/home/user/out.txt";
// Deliberately not ASCII-only: a byte-length/char-length confusion in either the digest or the
// size would show here and nowhere else.
const BODY = "result bytes ✓ é 日本語\n";

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

const OBJECT_KEY = "organizations/org_1/jobs/job_1/attempts/1/out.txt";

function grant(body: string, overrides: Partial<ArtifactUploadGrantV1> = {}): ArtifactUploadGrantV1 {
  return {
    protocolVersion: 1,
    operation: "upload",
    artifactId: "00000000-0000-4000-8000-0000000000b1",
    method: "PUT",
    url: "https://store.example/put/out.txt?sig=abc",
    headers: {},
    issuedAt: "2026-09-04T12:00:00.000Z",
    expiresAt: "2026-09-04T12:05:00.000Z",
    maxBytes: Buffer.byteLength(body),
    expectedSha256: sha256Hex(body),
    objectKey: OBJECT_KEY,
    redaction: "secret",
    ...overrides,
  } as ArtifactUploadGrantV1;
}

/** An in-memory "object store" standing in for the presigned PUT. */
function makeStore() {
  const puts: { objectKey: string; url: string; bytes: Uint8Array }[] = [];
  return {
    puts,
    upload: async (g: ArtifactUploadGrantV1, bytes: Uint8Array): Promise<void> => {
      puts.push({ objectKey: g.objectKey, url: g.url, bytes: Uint8Array.from(bytes) });
    },
  };
}

/** A provider over a live mock sandbox whose filesystem already holds `files`. */
async function provider(files: Record<string, string> = { [OUT_PATH]: BODY }) {
  const transport = new MockE2bTransport();
  const store = makeStore();
  const p = new E2bSandboxProvider({ transport, performUploadGrant: store.upload });
  const created = await p.create(
    { resourceLabels: LABELS, command: "claude", args: ["--print", "hi"], env: {}, workloadType: "batch" },
    CTX,
  );
  const staged = Object.entries(files).map(([path, body]) => ({ path, bytes: enc(body) }));
  if (staged.length > 0) await transport.writeFiles(created.sandboxId, staged);
  return { provider: p, transport, store, sandboxId: created.sandboxId };
}

describe("DAT-009 — E2bSandboxProvider artifact export (mock transport, no key)", () => {
  it("declares grant_upload support — the transport has readFile, so this is honest", async () => {
    const { provider: p } = await provider();
    expect(p.artifactExportMode).toBe("grant_upload");
  });

  it("★ export is NOT in advertisedOperations — that set is the FROZEN vocabulary", async () => {
    // Support is declared by `artifactExportMode`; ROUTING is decided server-side by the frozen
    // `artifact.direct_upload` capability. Two layers, deliberately not collapsed.
    const { provider: p } = await provider();
    expect([...p.advertisedOperations]).not.toContain("digest_artifact");
    expect([...p.advertisedOperations]).not.toContain("export_artifact");
  });

  it("digests an in-sandbox file, returning its real hash and BYTE size", async () => {
    const { provider: p, sandboxId } = await provider();
    const r = await p.digestArtifact(sandboxId, OUT_PATH, CTX);
    expect(r.sha256).toBe(sha256Hex(BODY));
    expect(r.sizeBytes).toBe(Buffer.byteLength(BODY));
    // The multibyte body makes this assertion mean something: a `.length` bug would disagree.
    expect(r.sizeBytes).not.toBe(BODY.length);
  });

  it("★ the digest result carries METADATA ONLY — no content field", async () => {
    // This is what keeps the port's no-bytes property true. If a content field ever appears
    // here, bytes have started crossing the port and the decision has been quietly reversed.
    const { provider: p, sandboxId } = await provider();
    const r = await p.digestArtifact(sandboxId, OUT_PATH, CTX);
    expect(Object.keys(r).sort()).toEqual(["sha256", "sizeBytes"]);
  });

  it("★ an UNKNOWN path fails rather than fabricating a digest", async () => {
    const { provider: p, sandboxId } = await provider();
    await expect(p.digestArtifact(sandboxId, "/home/user/nope.txt", CTX)).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  it("★ an unknown SANDBOX fails too — the same domain not-found", async () => {
    const { provider: p } = await provider();
    await expect(p.digestArtifact("sb-does-not-exist", OUT_PATH, CTX)).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
  });

  it("★ export returns a REFERENCE, not bytes", async () => {
    const { provider: p, sandboxId } = await provider();
    const r = await p.exportArtifact(sandboxId, OUT_PATH, grant(BODY), CTX);
    expect(Object.keys(r)).toEqual(["objectKey"]);
    expect(r.objectKey).toBe(OBJECT_KEY);
  });

  it("uploads the file's ACTUAL bytes — byte-identical, from inside the sandbox", async () => {
    const { provider: p, store, sandboxId } = await provider();
    await p.exportArtifact(sandboxId, OUT_PATH, grant(BODY), CTX);
    expect(store.puts).toHaveLength(1);
    expect(dec(store.puts[0]!.bytes)).toBe(BODY);
    expect(store.puts[0]!.objectKey).toBe(OBJECT_KEY);
  });

  it("★★ REFUSES when the file changed after the grant was minted — and uploads NOTHING", async () => {
    // The TOCTOU case, and the reason the export re-hashes rather than trusting the digest call
    // that produced the grant. Without this the PUT succeeds and the fenced commit's headObject
    // re-verification rejects a checksum in another process, far from the cause.
    const { provider: p, transport, store, sandboxId } = await provider();
    const g = grant(BODY, { maxBytes: 10_000 });
    await transport.writeFiles(sandboxId, [{ path: OUT_PATH, bytes: enc("the agent kept writing") }]);
    await expect(p.exportArtifact(sandboxId, OUT_PATH, g, CTX)).rejects.toThrow(/hashed .* expected/);
    expect(store.puts).toHaveLength(0);
  });

  it("★★ REFUSES a file that outgrew its grant — the size check comes FIRST, and uploads NOTHING", async () => {
    const { provider: p, store, sandboxId } = await provider({ [OUT_PATH]: "x".repeat(64) });
    const g = grant("x".repeat(64), { maxBytes: 16 });
    await expect(p.exportArtifact(sandboxId, OUT_PATH, g, CTX)).rejects.toThrow(/over the granted 16/);
    expect(store.puts).toHaveLength(0);
  });

  it("export of an unknown path fails rather than reporting a phantom upload", async () => {
    const { provider: p, store, sandboxId } = await provider();
    await expect(p.exportArtifact(sandboxId, "/home/user/nope.txt", grant(BODY), CTX)).rejects.toBeInstanceOf(
      SandboxNotFoundError,
    );
    expect(store.puts).toHaveLength(0);
  });

  it("★ NEITHER refusal leaks the grant — no url, no signature, in the message or the stack", async () => {
    // The grant is a bearer capability: anyone holding it can write that key until it expires.
    // The port already classifies this class of value as sensitive (`objectGrants` on
    // InspectResult, excluded from RedactedResourceProjection).
    const { provider: p, transport, sandboxId } = await provider();
    const g = grant(BODY, { maxBytes: 10_000 });
    await transport.writeFiles(sandboxId, [{ path: OUT_PATH, bytes: enc("mutated") }]);
    const mismatch = await p.exportArtifact(sandboxId, OUT_PATH, g, CTX).catch((e: unknown) => e as Error);
    const oversize = await p
      .exportArtifact(sandboxId, OUT_PATH, grant("mutated", { maxBytes: 1 }), CTX)
      .catch((e: unknown) => e as Error);
    for (const err of [mismatch, oversize]) {
      const text = `${err.message}\n${err.stack ?? ""}`;
      expect(text).not.toContain("sig=abc");
      expect(text).not.toContain("https://");
      expect(text).not.toContain("store.example");
    }
  });

  it("★★ the DEFAULT uploader PUTs with the base64 checksum header the fenced commit needs", async () => {
    // DAT-002 measured the sharp edge live: the control plane binds `ChecksumAlgorithm: SHA256`
    // when it signs but returns `headers: {}`, so the PUT must carry the checksum itself, and
    // `artifact-commit.ts` fails CLOSED when the store cannot supply one to `headObject`. An
    // exporter that omits this header uploads fine and is rejected at commit.
    //
    // No `performUploadGrant` is injected here on purpose: this exercises the real default.
    const seen: { url: string; init: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: unknown, init?: unknown) => {
      seen.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const transport = new MockE2bTransport();
      const p = new E2bSandboxProvider({ transport });
      const created = await p.create(
        { resourceLabels: LABELS, command: "claude", args: [], env: {}, workloadType: "batch" },
        CTX,
      );
      await transport.writeFiles(created.sandboxId, [{ path: OUT_PATH, bytes: enc(BODY) }]);
      const r = await p.exportArtifact(created.sandboxId, OUT_PATH, grant(BODY), CTX);
      expect(r.objectKey).toBe(OBJECT_KEY);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("https://store.example/put/out.txt?sig=abc");
      expect(seen[0]!.init.method).toBe("PUT");
      const headers = seen[0]!.init.headers as Record<string, string>;
      // BASE64 of the raw digest, not the hex the grant carries. Mixing the two encodings up
      // produces a store-side rejection that reads like a checksum mismatch.
      expect(headers["x-amz-checksum-sha256"]).toBe(sha256B64(BODY));
      expect(headers["x-amz-checksum-sha256"]).not.toBe(sha256Hex(BODY));
      expect(dec(seen[0]!.init.body as Uint8Array)).toBe(BODY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("★ the GRANT's own headers WIN over the defaults — the signature is the grant's to define", async () => {
    // `s3-provider.ts` `presign` returns `headers: {}` today, so this ordering is invisible
    // now — but it signs `ContentType` whenever its caller supplies one, and a signed
    // content-type that a hard-coded default clobbered would fail the signature AT THE STORE,
    // where the cause is unreadable. The checksum header still has to survive the merge.
    const seen: RequestInit[] = [];
    const fakeFetch = vi.fn(async (_url: unknown, init?: unknown) => {
      seen.push((init ?? {}) as RequestInit);
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const transport = new MockE2bTransport();
      const p = new E2bSandboxProvider({ transport });
      const created = await p.create(
        { resourceLabels: LABELS, command: "claude", args: [], env: {}, workloadType: "batch" },
        CTX,
      );
      await transport.writeFiles(created.sandboxId, [{ path: OUT_PATH, bytes: enc(BODY) }]);
      await p.exportArtifact(
        created.sandboxId,
        OUT_PATH,
        grant(BODY, { headers: { "content-type": "text/plain" } }),
        CTX,
      );
      const headers = seen[0]!.headers as Record<string, string>;
      expect(headers["content-type"]).toBe("text/plain");
      expect(headers["x-amz-checksum-sha256"]).toBe(sha256B64(BODY));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("★ a non-2xx store response throws WITHOUT the url — the status is all that surfaces", async () => {
    const fakeFetch = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const transport = new MockE2bTransport();
      const p = new E2bSandboxProvider({ transport });
      const created = await p.create(
        { resourceLabels: LABELS, command: "claude", args: [], env: {}, workloadType: "batch" },
        CTX,
      );
      await transport.writeFiles(created.sandboxId, [{ path: OUT_PATH, bytes: enc(BODY) }]);
      const err = await p
        .exportArtifact(created.sandboxId, OUT_PATH, grant(BODY), CTX)
        .catch((e: unknown) => e as Error);
      expect(err.message).toContain("403");
      expect(`${err.message}\n${err.stack ?? ""}`).not.toContain("sig=abc");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

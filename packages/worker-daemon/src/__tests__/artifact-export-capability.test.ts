// DAT-009 slice 1 — the provider-side artifact export capability.
//
// The decision (DECISION-byte-egress-and-provider-topology.md, Option D) is that the provider
// uploads bytes DIRECTLY to object storage under a worker-minted grant, and the port carries a
// grant inbound and a REFERENCE outbound — never bytes. These tests pin that property and the
// decline path.
//
// ★ The most important test here is the one asserting an unknown path FAILS. A double that
// fabricated a digest would be the WRK-009 defect exactly: a fabricated success is
// byte-identical to a real one on every gate, so nothing downstream could tell.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { UnsupportedProviderOperation } from "../supervisor/provider.js";

const CTX = { deadlineMs: 5_000, idempotencyKey: "idem-1" };
const BODY = "screenshot-bytes";
const PATH = "/evidence/shot.png";

function grant(objectKey = "organizations/org_1/jobs/job_1/attempts/0/shot.png") {
  return {
    protocolVersion: 1 as const,
    operation: "upload" as const,
    artifactId: "shot",
    method: "PUT" as const,
    url: "https://store.example/put?sig=abc",
    headers: {},
    issuedAt: "2026-08-24T12:00:00.000Z",
    expiresAt: "2026-08-24T12:05:00.000Z",
    maxBytes: BODY.length,
    expectedSha256: createHash("sha256").update(BODY).digest("hex"),
    objectKey,
    redaction: "secret" as const,
  };
}

function exporting() {
  return createFakeSandboxProvider({
    artifactExportMode: "grant_upload",
    artifactFiles: { [PATH]: BODY },
  });
}

describe("DAT-009 slice 1 — artifact export capability", () => {
  it("★ a provider that does not support export DECLINES both operations", async () => {
    // Default mode is "none" — an unscripted double must refuse, never fabricate.
    const p = createFakeSandboxProvider({});
    expect(p.artifactExportMode).toBe("none");
    await expect(p.digestArtifact("sb-1", PATH, CTX)).rejects.toBeInstanceOf(UnsupportedProviderOperation);
    await expect(p.exportArtifact("sb-1", PATH, grant(), CTX)).rejects.toBeInstanceOf(UnsupportedProviderOperation);
  });

  it("digests an in-sandbox file, returning its real hash and size", async () => {
    const r = await exporting().digestArtifact("sb-1", PATH, CTX);
    expect(r.sha256).toBe(createHash("sha256").update(BODY).digest("hex"));
    expect(r.sizeBytes).toBe(Buffer.byteLength(BODY));
  });

  it("★ the digest result carries METADATA ONLY — no content field", async () => {
    // This is what keeps the port's no-bytes property true. If a content field ever appears
    // here, bytes have started crossing the port and the decision has been quietly reversed.
    const r = await exporting().digestArtifact("sb-1", PATH, CTX);
    expect(Object.keys(r).sort()).toEqual(["sha256", "sizeBytes"]);
  });

  it("★ an UNKNOWN path fails rather than fabricating a digest", async () => {
    // The grant is minted against this hash and size. A fabricated digest would produce a
    // grant for bytes that do not exist, and commit would refuse far away from the cause.
    await expect(exporting().digestArtifact("sb-1", "/nope.png", CTX)).rejects.toThrow();
  });

  it("★ export returns a REFERENCE, not bytes", async () => {
    const r = await exporting().exportArtifact("sb-1", PATH, grant(), CTX);
    expect(Object.keys(r)).toEqual(["objectKey"]);
    expect(r.objectKey).toBe("organizations/org_1/jobs/job_1/attempts/0/shot.png");
  });

  it("export of an unknown path fails rather than reporting a phantom upload", async () => {
    await expect(exporting().exportArtifact("sb-1", "/nope.png", grant(), CTX)).rejects.toThrow();
  });

  it("★ the GRANT is not retained anywhere observable — only the object key", async () => {
    // The grant is a bearer capability: anyone holding it can write that key until it expires.
    // The port already classifies this class of value as sensitive (`objectGrants` on
    // InspectResult, excluded from RedactedResourceProjection). The double must not become the
    // place a grant leaks from.
    const p = exporting();
    await p.exportArtifact("sb-1", PATH, grant(), CTX);
    const recorded = JSON.stringify(p.exportedObjectKeys);
    expect(recorded).not.toContain("sig=abc");
    expect(recorded).not.toContain("https://");
    expect(p.exportedObjectKeys).toEqual(["organizations/org_1/jobs/job_1/attempts/0/shot.png"]);
  });

  it("★ export is NOT in advertisedOperations — that set is the FROZEN vocabulary", async () => {
    // Support is declared by `artifactExportMode`, and ROUTING is decided server-side by the
    // frozen `artifact.direct_upload` capability. Two layers, deliberately not collapsed.
    const p = exporting();
    expect([...p.advertisedOperations]).not.toContain("digest_artifact");
    expect([...p.advertisedOperations]).not.toContain("export_artifact");
  });
});

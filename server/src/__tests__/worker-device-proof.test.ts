import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

async function proofModule() {
  return import("../services/worker-device-proof.js").catch(() => null);
}

interface CanonicalInput {
  method: string;
  path: string;
  bodyDigest: string;
  correlationId: string;
  issuedAt: string;
  proofId: string;
}

interface DeviceProofFixture {
  version: string;
  prefix: string;
  canonicalVectors: { name: string; input: CanonicalInput; canonical: string }[];
  rejectInputs: { name: string; input: CanonicalInput }[];
}

// The neutral shared vectors (JOB-002 / E4-F001). This SAME file is consumed
// independently by the worker daemon sign-side test (WRK-002) and by the
// reference checker scripts/check-device-proof-vectors.mjs. If the server
// canonicalizer ever diverges from these vectors, this test fails.
const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/device-proof/v1/vectors.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as DeviceProofFixture;

describe("JOB-002 versioned Ed25519 HTTP device proof — shared vectors (E4-F001)", () => {
  it("exposes the frozen v1 prefix and a non-empty vector set", () => {
    expect(fixture.version).toBe("1");
    expect(fixture.prefix).toBe("AOA-DEVICE-PROOF-V1");
    expect(fixture.canonicalVectors.length).toBeGreaterThan(0);
    expect(fixture.rejectInputs.length).toBeGreaterThan(0);
  });

  it("the server canonicalizer reproduces every shared canonical vector exactly", async () => {
    const mod = await proofModule();
    expect(mod, "worker-device-proof module is not implemented").not.toBeNull();
    for (const v of fixture.canonicalVectors) {
      expect(mod!.buildDeviceProofCanonicalInput(v.input), `vector ${v.name}`).toBe(v.canonical);
    }
  });

  it("the server canonicalizer rejects every shared reject input", async () => {
    const mod = await proofModule();
    expect(mod, "worker-device-proof module is not implemented").not.toBeNull();
    for (const r of fixture.rejectInputs) {
      expect(
        () => mod!.buildDeviceProofCanonicalInput(r.input),
        `reject ${r.name}`,
      ).toThrow(/device proof/i);
    }
  });

  it("accepts the exact vector and rejects method/path/body/request-id/skew/signature tamper", async () => {
    const mod = await proofModule();
    expect(mod, "worker-device-proof module is not implemented").not.toBeNull();
    const vector = fixture.canonicalVectors[0].input;
    const canonical = fixture.canonicalVectors[0].canonical;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64url");
    const proof = {
      version: "1",
      publicKey: publicKeyDer,
      signature,
      issuedAt: vector.issuedAt,
      proofId: vector.proofId,
    };
    const issuedMs = new Date(vector.issuedAt).getTime();
    const now = new Date(issuedMs + 30_000);
    expect(mod!.verifyDeviceProof({ ...vector, proof, now })).toEqual(expect.objectContaining({
      publicKey: publicKeyDer,
      deviceThumbprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    for (const changed of [
      { method: "PUT" },
      { path: "/api/worker-control/a-different-path" },
      { bodyDigest: "f".repeat(64) },
      { correlationId: "00000000-0000-4000-8000-000000000199" },
    ]) {
      expect(() => mod!.verifyDeviceProof({ ...vector, ...changed, proof, now })).toThrow(/device proof/i);
    }
    expect(() => mod!.verifyDeviceProof({ ...vector, proof: { ...proof, signature: "bad" }, now })).toThrow(/device proof/i);
    expect(() => mod!.verifyDeviceProof({ ...vector, proof, now: new Date(issuedMs + 600_000) })).toThrow(/device proof/i);
  });
});

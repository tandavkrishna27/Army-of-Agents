import { createPublicKey, generateKeyPairSync, verify as cryptoVerify, createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateDeviceKey,
  deviceKeyFromPkcs8Der,
  exportDevicePrivateKeyPkcs8Der,
  signWithDeviceKey,
} from "../identity/device-key.js";

describe("device-key — Ed25519 generation, SPKI DER, thumbprint", () => {
  it("generates an Ed25519 key whose public material is valid base64url SPKI DER", () => {
    const key = generateDeviceKey();
    expect(key.publicKeyDer).toMatch(/^[A-Za-z0-9_-]+$/);
    const der = Buffer.from(key.publicKeyDer, "base64url");
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    expect(pub.asymmetricKeyType).toBe("ed25519");
  });

  it("derives deviceThumbprint as the lowercase sha256 hex of the SPKI DER bytes", () => {
    const key = generateDeviceKey();
    const der = Buffer.from(key.publicKeyDer, "base64url");
    const expected = createHash("sha256").update(der).digest("hex");
    expect(key.deviceThumbprint).toBe(expected);
    expect(key.deviceThumbprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs with the private key so the public key verifies (algorithm=null Ed25519)", () => {
    const key = generateDeviceKey();
    const message = Buffer.from("AOA-DEVICE-PROOF-V1\nPOST\n/x", "utf8");
    const signature = signWithDeviceKey(key, message);
    expect(cryptoVerify(null, message, key.publicKey, signature)).toBe(true);
    // A tampered message must NOT verify (no fabricated pass).
    expect(cryptoVerify(null, Buffer.from("tampered", "utf8"), key.publicKey, signature)).toBe(false);
  });

  it("round-trips through a stored PKCS8 private key with identical public identity", () => {
    const key = generateDeviceKey();
    const der = exportDevicePrivateKeyPkcs8Der(key);
    const restored = deviceKeyFromPkcs8Der(der);
    expect(restored.publicKeyDer).toBe(key.publicKeyDer);
    expect(restored.deviceThumbprint).toBe(key.deviceThumbprint);
    // A signature from the restored key still verifies under the original public key.
    const message = Buffer.from("round-trip", "utf8");
    expect(cryptoVerify(null, message, key.publicKey, signWithDeviceKey(restored, message))).toBe(true);
  });

  it("NEVER exposes private-key material in JSON/serialized output", () => {
    const key = generateDeviceKey();
    const pkcs8Der = exportDevicePrivateKeyPkcs8Der(key);
    const pkcs8B64 = pkcs8Der.toString("base64");
    const pkcs8B64Url = pkcs8Der.toString("base64url");
    const pkcs8Pem = key.privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    const serialized = JSON.stringify(key);
    expect(serialized).not.toContain(pkcs8B64);
    expect(serialized).not.toContain(pkcs8B64Url);
    expect(serialized).not.toContain("PRIVATE KEY");
    // The PEM body (minus armor) must not leak either.
    for (const line of pkcs8Pem.split("\n")) {
      const body = line.trim();
      if (body.length >= 20 && !body.includes("PRIVATE KEY")) {
        expect(serialized).not.toContain(body);
      }
    }

    // Also guard the common accidental-log surfaces.
    expect(String(key)).not.toContain(pkcs8B64);
    expect(`${JSON.stringify({ key })}`).not.toContain(pkcs8B64);
  });

  it("rejects a stored key that is not an Ed25519 PKCS8 DER (fail closed)", () => {
    expect(() => deviceKeyFromPkcs8Der(Buffer.from("not-a-key", "utf8"))).toThrow();
    // A well-formed PKCS8 of the WRONG algorithm (RSA) must be refused, not accepted.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
    expect(() => deviceKeyFromPkcs8Der(rsaPkcs8)).toThrow();
  });
});

import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RowDecryptError,
  decryptEventRow,
  encryptEventRow,
  type EncryptedEventRow,
} from "../events/event-row-codec.js";

const KEK = Buffer.alloc(32, 7);

describe("event-row-codec — aes-256-gcm per-row encryption (D3)", () => {
  it("round-trips a payload BYTE-IDENTICAL through encrypt → decrypt", () => {
    const plaintext = Buffer.from(JSON.stringify({ hello: "world", seq: 42, nested: [1, 2, 3] }), "utf8");
    const row = encryptEventRow(plaintext, KEK);
    // Every ciphertext component is present and distinct from the plaintext.
    expect(row.iv.byteLength).toBe(12);
    expect(row.authTag.byteLength).toBe(16);
    expect(row.salt.byteLength).toBeGreaterThanOrEqual(16);
    expect(Buffer.compare(row.ciphertext, plaintext)).not.toBe(0);

    const back = decryptEventRow(row, KEK);
    expect(Buffer.compare(back, plaintext)).toBe(0);
    expect(back.toString("utf8")).toBe(plaintext.toString("utf8"));
  });

  it("uses a FRESH iv + salt per row (no nonce reuse) for identical plaintext", () => {
    const plaintext = Buffer.from("same-bytes", "utf8");
    const a = encryptEventRow(plaintext, KEK);
    const b = encryptEventRow(plaintext, KEK);
    expect(Buffer.compare(a.iv, b.iv)).not.toBe(0);
    expect(Buffer.compare(a.salt, b.salt)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  it("FAILS CLOSED on the WRONG key — decrypt throws RowDecryptError, never surfaces plaintext", () => {
    const plaintext = Buffer.from("secret-terminal-error-message", "utf8");
    const row = encryptEventRow(plaintext, KEK);
    const wrongKek = Buffer.alloc(32, 9);
    let thrown: unknown;
    try {
      decryptEventRow(row, wrongKek);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RowDecryptError);
    // The error message never leaks the plaintext bytes.
    expect(String((thrown as Error).message)).not.toContain("secret-terminal-error-message");
  });

  it("FAILS CLOSED on a TAMPERED ciphertext byte (GCM auth-tag rejects)", () => {
    const plaintext = Buffer.from("integrity-protected", "utf8");
    const row = encryptEventRow(plaintext, KEK);
    const tampered: EncryptedEventRow = {
      ...row,
      ciphertext: Buffer.from(row.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => decryptEventRow(tampered, KEK)).toThrow(RowDecryptError);
  });

  it("FAILS CLOSED on a TAMPERED auth tag", () => {
    const plaintext = Buffer.from("integrity-protected-tag", "utf8");
    const row = encryptEventRow(plaintext, KEK);
    const tampered: EncryptedEventRow = { ...row, authTag: Buffer.from(row.authTag) };
    tampered.authTag[0] ^= 0xff;
    expect(() => decryptEventRow(tampered, KEK)).toThrow(RowDecryptError);
  });

  it("rejects a KEK that is not 32 bytes (fail closed on custody misconfig)", () => {
    expect(() => encryptEventRow(Buffer.from("x"), randomBytes(16))).toThrow();
  });
});

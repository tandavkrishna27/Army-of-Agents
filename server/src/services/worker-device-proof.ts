import { createHash, createPublicKey, verify } from "node:crypto";

const DEVICE_PROOF_PREFIX = "AOA-DEVICE-PROOF-V1";
const DEFAULT_MAX_SKEW_MS = 5 * 60_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PROOF_ID = /^[A-Za-z0-9_-]{8,128}$/;

export interface DeviceProofHeaders {
  version: "1" | string;
  publicKey: string;
  signature: string;
  issuedAt: string;
  proofId: string;
}

export interface DeviceProofCanonicalInput {
  method: string;
  path: string;
  bodyDigest: string;
  correlationId: string;
  issuedAt: string;
  proofId: string;
}

function deviceProofError(): Error {
  return new Error("Device proof is invalid");
}

/**
 * Derive a device thumbprint from a base64url-encoded SPKI public key:
 * `sha256(SPKI DER)` in lowercase hex.
 *
 * Factored out of `verifyDeviceProof` (E11 M2) so the same derivation can be reused by the
 * read-only enrolment-key verify path WITHOUT re-implementing it. This is byte-identical to
 * the inline computation `verifyDeviceProof` used before — it decodes the SAME base64url
 * bytes and hashes them the SAME way — so `verifyDeviceProof`'s behaviour and its shared
 * vectors are unchanged. It does NOT validate that the bytes are a well-formed Ed25519 SPKI;
 * that structural check stays where each caller needs it (`verifyDeviceProof` for the proof
 * path, `verifyDeviceEnrolmentKey` for the verify path).
 */
export function deriveDeviceThumbprint(publicKeyBase64Url: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64Url, "base64url")).digest("hex");
}

function normalizedPath(path: string): string {
  try {
    const parsed = new URL(path, "https://aoa.invalid");
    if (parsed.origin !== "https://aoa.invalid") throw deviceProofError();
    return parsed.pathname;
  } catch {
    throw deviceProofError();
  }
}

export function buildDeviceProofCanonicalInput(input: DeviceProofCanonicalInput): string {
  if (!SHA256_HEX.test(input.bodyDigest) || !PROOF_ID.test(input.proofId)) {
    throw deviceProofError();
  }
  if (!input.correlationId || input.correlationId.includes("\n") || input.issuedAt.includes("\n")) {
    throw deviceProofError();
  }
  return [
    DEVICE_PROOF_PREFIX,
    input.method.toUpperCase(),
    normalizedPath(input.path),
    input.bodyDigest,
    input.correlationId,
    input.issuedAt,
    input.proofId,
  ].join("\n");
}

export function verifyDeviceProof(input: Omit<DeviceProofCanonicalInput, "issuedAt" | "proofId"> & {
  proof: DeviceProofHeaders;
  now?: Date;
  maxSkewMs?: number;
}): { publicKey: string; deviceThumbprint: string; issuedAt: Date; proofId: string } {
  try {
    if (input.proof.version !== "1" || !BASE64URL.test(input.proof.publicKey) ||
        !BASE64URL.test(input.proof.signature) || !PROOF_ID.test(input.proof.proofId)) {
      throw deviceProofError();
    }
    const issuedAt = new Date(input.proof.issuedAt);
    if (!Number.isFinite(issuedAt.getTime()) || issuedAt.toISOString() !== input.proof.issuedAt) {
      throw deviceProofError();
    }
    const now = input.now ?? new Date();
    const maxSkewMs = input.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    if (maxSkewMs < 0 || Math.abs(now.getTime() - issuedAt.getTime()) > maxSkewMs) {
      throw deviceProofError();
    }
    const publicKeyBytes = Buffer.from(input.proof.publicKey, "base64url");
    const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw deviceProofError();
    const canonical = buildDeviceProofCanonicalInput({
      method: input.method,
      path: input.path,
      bodyDigest: input.bodyDigest,
      correlationId: input.correlationId,
      issuedAt: input.proof.issuedAt,
      proofId: input.proof.proofId,
    });
    const signature = Buffer.from(input.proof.signature, "base64url");
    if (!verify(null, Buffer.from(canonical), publicKey, signature)) throw deviceProofError();
    return {
      publicKey: input.proof.publicKey,
      deviceThumbprint: deriveDeviceThumbprint(input.proof.publicKey),
      issuedAt,
      proofId: input.proof.proofId,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "Device proof is invalid") throw error;
    throw deviceProofError();
  }
}

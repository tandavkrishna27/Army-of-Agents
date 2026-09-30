/**
 * AOA-DEVICE-PROOF-V1 canonicalizer + Ed25519 signer (WRK-002).
 *
 * This reproduces — byte-for-byte — the SERVER verify-side canonicalization in
 * `server/src/services/worker-device-proof.ts`. The worker cannot import the
 * server signer, so parity is enforced by the neutral shared vector fixture
 * `tests/fixtures/device-proof/v1/vectors.json` (E4-F001): `buildDeviceProofCanonical`
 * must reproduce every positive vector's `canonical` and reject every reject
 * input. The canonical signing tuple is EXACTLY:
 *
 *   ["AOA-DEVICE-PROOF-V1", METHOD.toUpperCase(), normalizedPath,
 *    sha256hex(rawBody), correlationId, issuedAt, proofId].join("\n")
 *
 * where normalizedPath = `new URL(path, "https://aoa.invalid").pathname` with a
 * foreign resolved origin rejected. No proof/canonical drift is permitted.
 */

import { createHash, sign as cryptoSign } from "node:crypto";

import { WORKER_CONTROL_HEADERS } from "../transport/headers.js";
import type { DeviceKey } from "./device-key.js";

export const DEVICE_PROOF_PREFIX = "AOA-DEVICE-PROOF-V1";
export const DEVICE_PROOF_VERSION = "1";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PROOF_ID = /^[A-Za-z0-9_-]{8,128}$/;
const PROOF_ORIGIN = "https://aoa.invalid";

/** Thrown for any invalid canonical input — the closed failure mode. */
export class DeviceProofError extends Error {
  constructor(message = "device proof is invalid") {
    super(message);
    this.name = "DeviceProofError";
  }
}

/**
 * Resolve `path` against the fixed neutral origin and return its pathname. A
 * query/fragment is stripped; `.`/`..` segments resolve; a `//host` or absolute
 * URL that changes the origin is rejected (it would let a foreign path sign).
 */
export function normalizeDeviceProofPath(path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(path, PROOF_ORIGIN);
  } catch {
    throw new DeviceProofError("device proof path is not parseable");
  }
  if (parsed.origin !== PROOF_ORIGIN) {
    throw new DeviceProofError("device proof path resolves to a foreign origin");
  }
  return parsed.pathname;
}

export interface DeviceProofCanonicalInput {
  readonly method: string;
  readonly path: string;
  readonly bodyDigest: string;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly proofId: string;
}

/**
 * Build the canonical AOA-DEVICE-PROOF-V1 signing string. Validation ORDER +
 * predicates mirror the server so the shared reject vectors fail identically:
 * bodyDigest must be sha256 hex, proofId must match the pattern, correlationId
 * must be non-empty + newline-free, issuedAt must be newline-free, and the path
 * must resolve inside the fixed origin.
 */
export function buildDeviceProofCanonical(input: DeviceProofCanonicalInput): string {
  if (
    typeof input.method !== "string" ||
    typeof input.path !== "string" ||
    typeof input.bodyDigest !== "string" ||
    typeof input.correlationId !== "string" ||
    typeof input.issuedAt !== "string" ||
    typeof input.proofId !== "string"
  ) {
    throw new DeviceProofError("device proof field is not a string");
  }
  if (!SHA256_HEX.test(input.bodyDigest) || !PROOF_ID.test(input.proofId)) {
    throw new DeviceProofError("device proof bodyDigest/proofId is invalid");
  }
  if (input.correlationId.length === 0 || input.correlationId.includes("\n") || input.issuedAt.includes("\n")) {
    throw new DeviceProofError("device proof correlationId/issuedAt is invalid");
  }
  return [
    DEVICE_PROOF_PREFIX,
    input.method.toUpperCase(),
    normalizeDeviceProofPath(input.path),
    input.bodyDigest,
    input.correlationId,
    input.issuedAt,
    input.proofId,
  ].join("\n");
}

/** Lowercase sha256 hex of the given bytes (the transport body digest). */
export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SignDeviceProofInput {
  readonly method: string;
  readonly path: string;
  readonly rawBody: Buffer | Uint8Array | string;
  readonly correlationId: string;
  readonly issuedAt: string;
  readonly proofId: string;
  readonly key: DeviceKey;
}

export interface SignedDeviceProof {
  readonly canonical: string;
  readonly bodyDigest: string;
  readonly signature: string;
  /** The five `aoa-device-*` proof headers (NOT the enrollment code/session). */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Sign a device proof over the EXACT transport bytes. `bodyDigest` is computed
 * from `rawBody` (never a re-serialization), so the server's `sha256(rawBody)`
 * matches. Returns the canonical string, digest, base64url signature, and the
 * `aoa-device-*` headers to attach to the request.
 */
export function signDeviceProof(input: SignDeviceProofInput): SignedDeviceProof {
  const bodyDigest = sha256Hex(input.rawBody);
  const canonical = buildDeviceProofCanonical({
    method: input.method,
    path: input.path,
    bodyDigest,
    correlationId: input.correlationId,
    issuedAt: input.issuedAt,
    proofId: input.proofId,
  });
  const signature = cryptoSign(null, Buffer.from(canonical, "utf8"), input.key.privateKey).toString("base64url");
  const headers = Object.freeze({
    [WORKER_CONTROL_HEADERS.proofVersion]: DEVICE_PROOF_VERSION,
    [WORKER_CONTROL_HEADERS.publicKey]: input.key.publicKeyDer,
    [WORKER_CONTROL_HEADERS.signature]: signature,
    [WORKER_CONTROL_HEADERS.issuedAt]: input.issuedAt,
    [WORKER_CONTROL_HEADERS.proofId]: input.proofId,
  });
  return { canonical, bodyDigest, signature, headers };
}

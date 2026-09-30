// packages/worker-keystore/src/receipt-envelope.ts
//
// DSK-001 — the enrollment receipt codec.
//
// The receipt is what lets a booted device know it has ALREADY enrolled, so it
// short-circuits before reading the ticket and before contacting the control
// plane. That makes it a correctness artifact, not a cache: a receipt that
// decodes when it should not would let a device skip an enrolment it never
// completed, and one that fails to decode when it should not would send a device
// back to the control plane with a code that has long since expired.
//
// Same discipline as the identity envelope, deliberately: a partial or damaged
// record THROWS. It is never softened into a half-record and never into absence —
// absence is the filesystem's answer, not this codec's.
//
// It carries NO key material. The identity blob holds the private key; this holds
// only the facts needed to recognise a completed enrolment.

/** Bumping this is a deliberate migration, not an accident. */
export const RECEIPT_ENVELOPE_VERSION = 1;

export interface DeviceEnrollmentReceipt {
  readonly v: 1;
  readonly workerId: string;
  readonly targetId: string;
  readonly deviceGeneration: number;
  readonly deviceThumbprint: string;
}

export function encodeEnrollmentReceipt(receipt: DeviceEnrollmentReceipt): Uint8Array {
  if (!receipt.workerId) throw new Error("enrollment receipt: workerId is required");
  if (!receipt.targetId) throw new Error("enrollment receipt: targetId is required");
  if (!receipt.deviceThumbprint) throw new Error("enrollment receipt: deviceThumbprint is required");
  if (!Number.isInteger(receipt.deviceGeneration) || receipt.deviceGeneration < 1) {
    throw new Error("enrollment receipt: deviceGeneration must be a positive integer");
  }
  // Fixed key order, so an unchanged receipt re-encodes to identical bytes.
  return new TextEncoder().encode(
    JSON.stringify({
      v: RECEIPT_ENVELOPE_VERSION,
      workerId: receipt.workerId,
      targetId: receipt.targetId,
      deviceGeneration: receipt.deviceGeneration,
      deviceThumbprint: receipt.deviceThumbprint,
    }),
  );
}

export function decodeEnrollmentReceipt(bytes: Uint8Array): DeviceEnrollmentReceipt {
  const text = new TextDecoder().decode(bytes).trim();
  if (text.length === 0) throw new Error("enrollment receipt: empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`enrollment receipt: not valid JSON (${(err as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("enrollment receipt: not an object");
  }

  const { v, workerId, targetId, deviceGeneration, deviceThumbprint } =
    parsed as Partial<DeviceEnrollmentReceipt>;

  if (v !== RECEIPT_ENVELOPE_VERSION) {
    throw new Error(`enrollment receipt: unsupported version ${String(v)}`);
  }
  if (typeof workerId !== "string" || workerId.length === 0) {
    throw new Error("enrollment receipt: missing workerId");
  }
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("enrollment receipt: missing targetId");
  }
  if (typeof deviceThumbprint !== "string" || deviceThumbprint.length === 0) {
    throw new Error("enrollment receipt: missing deviceThumbprint");
  }
  if (typeof deviceGeneration !== "number" || !Number.isInteger(deviceGeneration) || deviceGeneration < 1) {
    throw new Error("enrollment receipt: deviceGeneration must be a positive integer");
  }

  return { v: 1, workerId, targetId, deviceGeneration, deviceThumbprint };
}

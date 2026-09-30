/**
 * Device-bound Ed25519 key material (WRK-002).
 *
 * A `DeviceKey` carries the PUBLIC identity (base64url SPKI DER + sha256
 * thumbprint) as plain string fields and the underlying `KeyObject`s for
 * signing. The PRIVATE key material is held ONLY inside the non-enumerable
 * `KeyObject` (which serializes to `{}`), so `JSON.stringify(deviceKey)`,
 * `String(deviceKey)`, and any accidental log/metric of the object can never
 * emit private bytes. Private material leaves the process by exactly ONE
 * explicit path — `exportDevicePrivateKeyPkcs8Der` — used only by the mounted-
 * secret key store to persist to a strict-perm file. `device_key_load_failed`
 * and every other observable signal carries the thumbprint, never the key.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";

export interface DeviceKey {
  /** Base64url of the SPKI DER-encoded Ed25519 public key (safe to send/log). */
  readonly publicKeyDer: string;
  /** Lowercase sha256 hex of the SPKI DER bytes — the device thumbprint. */
  readonly deviceThumbprint: string;
  /** The public key object (verification). */
  readonly publicKey: KeyObject;
  /** The private key object. Never serialized; used only for signing. */
  readonly privateKey: KeyObject;
}

function spkiDer(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" }) as Buffer;
}

function deviceThumbprintOf(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex");
}

function fromKeyObjects(publicKey: KeyObject, privateKey: KeyObject): DeviceKey {
  if (publicKey.asymmetricKeyType !== "ed25519" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("device key must be an Ed25519 key pair");
  }
  const der = spkiDer(publicKey);
  // The private KeyObject is intentionally an enumerable field, but a KeyObject
  // has no enumerable own properties, so JSON.stringify emits `{}` for it — no
  // private bytes ever reach a serialized record.
  return Object.freeze({
    publicKeyDer: der.toString("base64url"),
    deviceThumbprint: deviceThumbprintOf(der),
    publicKey,
    privateKey,
  });
}

/** Generate a fresh device-bound Ed25519 key pair. */
export function generateDeviceKey(): DeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return fromKeyObjects(publicKey, privateKey);
}

/**
 * Reconstruct a `DeviceKey` from a stored PKCS8 DER private key. Fails closed on
 * unparseable bytes or a non-Ed25519 algorithm (a corrupt/foreign stored key is
 * refused rather than silently accepted).
 */
export function deviceKeyFromPkcs8Der(pkcs8Der: Buffer | Uint8Array): DeviceKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(pkcs8Der), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("stored device key is not a parseable PKCS8 DER key");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("stored device key is not Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  return fromKeyObjects(publicKey, privateKey);
}

/**
 * Export the private key as PKCS8 DER for STORAGE ONLY (mounted-secret key
 * store). This is the single sanctioned egress of private material; callers must
 * never log, config, or metric the result.
 */
export function exportDevicePrivateKeyPkcs8Der(key: DeviceKey): Buffer {
  return key.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
}

/** Ed25519 sign `message` with the device private key (algorithm = null). */
export function signWithDeviceKey(key: DeviceKey, message: Buffer): Buffer {
  return cryptoSign(null, message, key.privateKey);
}

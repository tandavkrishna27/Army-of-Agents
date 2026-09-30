// DSK-001 / I6 — `workerId` and the private key are ONE artifact.
//
// No filesystem state may ever hold one without the other. The reason is the
// lockout chain: a device that has a key but no `workerId` must mint one, and a
// device that has a `workerId` but no key must mint a key — either way it enrols
// a NEW identity, the server denies it permanently as `worker_transfer_denied`,
// and because `findWorkerForBinding` has no status predicate the stale row keeps
// matching forever with no reset route.
//
// So the envelope is a single encoded record. A partial write must decode as a
// FAULT, never as "half a record" and never as absence.

import { describe, expect, it } from "vitest";
import { createWorkerLogger } from "@armyofagents/worker-daemon";
import {
  decodeIdentityEnvelope,
  encodeIdentityEnvelope,
  IDENTITY_ENVELOPE_VERSION,
  type DeviceIdentityRecord,
} from "../envelope.js";

const WORKER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const DER = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]);

const TARGET_ID = "a3000000-0000-4000-8000-000000000003";

/** The encoded name of the key-bearing field, in ONE place. */
const KEY_FIELD = "privateKeyPkcs8B64";
const record: DeviceIdentityRecord = {
  v: 1,
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: 1,
  privateKeyPkcs8Der: DER,
};

describe("DSK-001/I6 — the envelope round-trips exactly", () => {
  it("preserves EVERY field byte-for-byte", () => {
    const decoded = decodeIdentityEnvelope(encodeIdentityEnvelope(record));
    expect(decoded.workerId).toBe(WORKER_ID);
    expect(decoded.targetId).toBe(TARGET_ID);
    expect(decoded.deviceGeneration).toBe(1);
    expect(Array.from(decoded.privateKeyPkcs8Der)).toEqual(Array.from(DER));
  });

  it("persists targetId — without it a re-enrolment cannot be refused", () => {
    // The coordinator's "persisted identity belongs to a different target"
    // refusal reads identity.targetId. A codec that drops it makes that check
    // compare against `undefined`, which throws on EVERY subsequent boot and
    // leaves --reset-identity (a second mint, denied forever) as the only way
    // out. Design D7 and plan remedy A4(iv) both require this field.
    const text = new TextDecoder().decode(encodeIdentityEnvelope(record));
    expect(JSON.parse(text).targetId).toBe(TARGET_ID);
  });

  it("persists deviceGeneration — the server compares it for exact equality", () => {
    const text = new TextDecoder().decode(encodeIdentityEnvelope(record));
    expect(JSON.parse(text).deviceGeneration).toBe(1);
  });

  it("carries an explicit version so a future format is a deliberate migration", () => {
    const text = new TextDecoder().decode(encodeIdentityEnvelope(record));
    expect(JSON.parse(text).v).toBe(IDENTITY_ENVELOPE_VERSION);
  });

  it("is stable across encodes — byte-identical output for identical input", () => {
    const a = encodeIdentityEnvelope(record);
    const b = encodeIdentityEnvelope({ ...record, privateKeyPkcs8Der: DER.slice() });
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("DSK-001/I6 — a partial or damaged record is a FAULT, never half a record", () => {
  const bad: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array()],
    ["whitespace", new TextEncoder().encode("   ")],
    ["not json", new TextEncoder().encode("not-json-at-all")],
    ["truncated json", encodeIdentityEnvelope(record).slice(0, 20)],
    ["json but not an object", new TextEncoder().encode('"a string"')],
    ["missing workerId", new TextEncoder().encode(JSON.stringify({ v: 1, targetId: TARGET_ID, deviceGeneration: 1, [KEY_FIELD]: "AAAA" }))],
    ["missing key", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1 }))],
    ["missing targetId", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, deviceGeneration: 1, [KEY_FIELD]: "AAAA" }))],
    ["missing deviceGeneration", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, targetId: TARGET_ID, [KEY_FIELD]: "AAAA" }))],
    ["zero deviceGeneration", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 0, [KEY_FIELD]: "AAAA" }))],
    ["empty workerId", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: "", targetId: TARGET_ID, deviceGeneration: 1, [KEY_FIELD]: "AAAA" }))],
    ["empty key", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, [KEY_FIELD]: "" }))],
    ["wrong version", new TextEncoder().encode(JSON.stringify({ v: 99, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, [KEY_FIELD]: "AAAA" }))],
    ["non-base64 key", new TextEncoder().encode(JSON.stringify({ v: 1, workerId: WORKER_ID, targetId: TARGET_ID, deviceGeneration: 1, [KEY_FIELD]: "!!!!" }))],
  ];

  for (const [name, bytes] of bad) {
    it(`throws on ${name}, rather than returning a partial record`, () => {
      expect(() => decodeIdentityEnvelope(bytes)).toThrow();
    });
  }

  it("never yields a record with one half missing, for ANY input that decodes", () => {
    // The property, stated directly: if decode returns at all, both halves are
    // present and non-empty. That is what makes "one artifact" true rather than
    // merely intended.
    for (const [, bytes] of bad) {
      let decoded: DeviceIdentityRecord | undefined;
      try {
        decoded = decodeIdentityEnvelope(bytes);
      } catch {
        continue;
      }
      expect(decoded!.workerId.length).toBeGreaterThan(0);
      expect(decoded!.targetId.length).toBeGreaterThan(0);
      expect(decoded!.deviceGeneration).toBeGreaterThan(0);
      expect(decoded!.privateKeyPkcs8Der.length).toBeGreaterThan(0);
    }
  });
});

describe("DSK-001/I5 — the key field is named so the DAEMON LOGGER redacts it", () => {
  // This test previously asserted the opposite-facing property: that the field
  // names pass the frozen WIRE-safety normalizer. That is the wrong guard. The
  // record never travels the wire — the whole design keeps it on the local disk —
  // so `wire-safety.ts` never runs on it. The guard that actually applies to a
  // stray diagnostic is the daemon logger's `SENSITIVE_SUBSTRINGS`
  // (`logging/logger.ts:37-49`), and optimising the name for the scan that never
  // runs made it INVISIBLE to the scan that does: `k` normalizes to `k` and
  // matches nothing, while `privatekey` is in the list. A field called `k` prints
  // the base64 private key in full.
  //
  // Asserted through the REAL logger rather than against a copied word list, so
  // the test cannot drift from the redactor it is claiming to satisfy.

  function logged(value: unknown): string {
    const chunks: string[] = [];
    const logger = createWorkerLogger({
      destination: { write: (chunk: string) => { chunks.push(chunk); } },
    });
    logger.error({ envelope: value }, "diagnostic");
    return chunks.join("");
  }

  it("does not print the private key when the envelope is logged", () => {
    const parsed = JSON.parse(new TextDecoder().decode(encodeIdentityEnvelope(record)));
    const keyText = parsed[KEY_FIELD] as string;
    expect(typeof keyText).toBe("string");
    expect(keyText.length).toBeGreaterThan(8);
    const text = logged(parsed);
    expect(text).not.toContain(keyText);
    // Positively: the field was REDACTED, not silently dropped — otherwise this
    // would pass for a logger that logged nothing at all.
    expect(text).toContain("[redacted]");
  });

  it("still prints the non-secret fields, so the diagnostic stays useful", () => {
    const parsed = JSON.parse(new TextDecoder().decode(encodeIdentityEnvelope(record)));
    const text = logged(parsed);
    expect(text).toContain(WORKER_ID);
    expect(text).toContain(TARGET_ID);
  });
});

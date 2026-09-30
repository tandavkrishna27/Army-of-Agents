import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateDeviceKey } from "../identity/device-key.js";
import { signDeviceProof } from "../identity/device-proof.js";
import { InMemoryKeyStore } from "../identity/key-store.js";
import { createEnroller, EnrollmentError, type Enroller } from "../enrollment/enroll.js";
import { buildEnrollmentRequest } from "../transport/envelope.js";
import { createControlPlaneClient } from "../transport/client.js";
import { WORKER_CONTROL_HEADERS } from "../transport/headers.js";

import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import { buildHello, sampleProviderConstraints } from "./support/enroll-fixtures.js";

const CODE = "test-code-1";

let fake: FakeControlPlane;
let targetId: string;

beforeEach(async () => {
  targetId = randomUUID();
  fake = await startFakeControlPlane({
    enrollments: [{ code: CODE, targetId, deviceGeneration: 1, providerConstraints: sampleProviderConstraints() }],
  });
});
afterEach(async () => {
  await fake.close();
});

function makeEnroller(keyStore = new InMemoryKeyStore()): { enroller: Enroller; keyStore: InMemoryKeyStore } {
  const client = createControlPlaneClient({ baseUrl: fake.baseUrl, path: fake.enrollPath });
  return { enroller: createEnroller({ keyStore, client }), keyStore };
}

async function rawPost(bytes: Buffer, code: string | null, proofHeaders: Record<string, string>): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json", ...proofHeaders };
  if (code !== null) headers[WORKER_CONTROL_HEADERS.enrollmentCode] = code;
  const response = await fetch(new URL(fake.enrollPath, fake.baseUrl), { method: "POST", headers, body: bytes });
  await response.text();
  return response.status;
}

describe("enrollment.component — happy path", () => {
  it("a valid enroll yields an enrolled identity + a session (single consume)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const { enroller } = makeEnroller();
    const result = await enroller.enroll({ hello, code: CODE });

    expect(result.outcome).toBe("enrolled");
    expect(result.targetId).toBe(targetId);
    expect(result.deviceGeneration).toBe(1);
    expect(result.session.token).toMatch(/^sess_/);
    expect(result.session.expiresAtMs).toBeGreaterThan(result.session.obtainedAtMs);
    expect(result.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    expect(fake.consumeCountFor(CODE)).toBe(1);
  });

  it("persists a generated device key so a second flow reuses the same identity", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const { enroller, keyStore } = makeEnroller();
    const result = await enroller.enroll({ hello, code: CODE });
    const stored = keyStore.load();
    expect(stored).not.toBeNull();
    expect(stored!.deviceThumbprint).toBe(result.deviceThumbprint);
  });
});

describe("enrollment.component — rejection matrix (the fake verifies proofs independently)", () => {
  it("rejects a consumed code replayed with an UNRELATED device key (no double consume)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const { enroller } = makeEnroller();
    const first = await enroller.enroll({ hello, code: CODE });

    // Attacker holds the code + a copied session but NOT the private key.
    const { enroller: attacker } = makeEnroller(new InMemoryKeyStore());
    await expect(
      attacker.renew({ hello, code: CODE, idempotencyKey: first.idempotencyKey }),
    ).rejects.toMatchObject({ kind: "unauthorized", stopAndBackoff: true });
    expect(fake.consumeCountFor(CODE)).toBe(1);
  });

  it("rejects a missing signature header", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: fake.enrollPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    const { [WORKER_CONTROL_HEADERS.signature]: _dropped, ...noSignature } = proof.headers;
    expect(await rawPost(bytes, CODE, noSignature)).toBe(401);
  });

  it("rejects an invalid signature (no fabricated pass)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: fake.enrollPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    const status = await rawPost(bytes, CODE, {
      ...proof.headers,
      [WORKER_CONTROL_HEADERS.signature]: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status).toBe(401);
  });

  it("rejects a tampered body (proof digested different bytes)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const idempotencyKey = randomUUID();
    const signed = buildEnrollmentRequest({
      correlationId,
      idempotencyKey,
      issuedAt: new Date().toISOString(),
      nonce: "signed-nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: fake.enrollPath,
      rawBody: signed.bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    // A schema-valid but DIFFERENT body — digest no longer matches the signature.
    const tampered = buildEnrollmentRequest({
      correlationId,
      idempotencyKey,
      issuedAt: new Date().toISOString(),
      nonce: "tampered-nonce",
      hello,
    });
    expect(await rawPost(tampered.bytes, CODE, proof.headers)).toBe(401);
  });

  it("rejects a tampered path (proof signed a different path)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: "/api/worker-control/not-enroll",
      rawBody: bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    expect(await rawPost(bytes, CODE, proof.headers)).toBe(401);
  });

  it("rejects a tampered method (proof signed GET, request is POST)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "GET",
      path: fake.enrollPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    expect(await rawPost(bytes, CODE, proof.headers)).toBe(401);
  });

  it("rejects a reused proof id (fresh-proof requirement)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const { bytes } = buildEnrollmentRequest({
      correlationId,
      idempotencyKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      hello,
    });
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: fake.enrollPath,
      rawBody: bytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    expect(await rawPost(bytes, CODE, proof.headers)).toBe(200);
    // Same proof id again → refused even though the signature is valid.
    expect(await rawPost(bytes, CODE, proof.headers)).toBe(401);
  });

  it("rejects a wrong audience (schema reject → malformed)", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const correlationId = randomUUID();
    const rawObject = {
      protocolVersion: 1,
      correlationId,
      issuedAt: new Date().toISOString(),
      nonce: "nonce",
      audience: "worker_poll",
      idempotencyKey: randomUUID(),
      hello,
    };
    const rawBytes = Buffer.from(JSON.stringify(rawObject), "utf8");
    const key = generateDeviceKey();
    const proof = signDeviceProof({
      method: "POST",
      path: fake.enrollPath,
      rawBody: rawBytes,
      correlationId,
      issuedAt: new Date().toISOString(),
      proofId: `prf_${randomUUID()}`,
      key,
    });
    expect(await rawPost(rawBytes, CODE, proof.headers)).toBe(400);
  });

  it("rejects a wrong target id", async () => {
    const wrongTarget = buildHello({ targetId: randomUUID(), deviceGeneration: 1 });
    const { enroller } = makeEnroller();
    await expect(enroller.enroll({ hello: wrongTarget, code: CODE })).rejects.toBeInstanceOf(EnrollmentError);
    await expect(enroller.enroll({ hello: wrongTarget, code: CODE })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects a wrong device generation", async () => {
    const wrongGen = buildHello({ targetId, deviceGeneration: 2 });
    const { enroller } = makeEnroller();
    await expect(enroller.enroll({ hello: wrongGen, code: CODE })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects an unknown enrollment code", async () => {
    const hello = buildHello({ targetId, deviceGeneration: 1 });
    const { enroller } = makeEnroller();
    await expect(enroller.enroll({ hello, code: "no-such-code" })).rejects.toMatchObject({ kind: "unauthorized" });
  });
});

// -----------------------------------------------------------------------------
// U1-PROVENANCE — is a container daemon's enrolment DISTINGUISHABLE, at the row
// level, from a harness-enrolled synthetic device?
//
// This file is a MEASUREMENT, not a feature. It exists because the whole
// "boot a daemon in a container and let its rows be the evidence" lane rests on
// one unexamined premise: that a real container daemon writes something into the
// control plane that a test runner holding an enrolment code cannot write.
//
// It runs BOTH producers through the SERVER'S OWN code:
//
//   container path  — the exact functions `bin/container-host.js` reaches:
//                     `generateDeviceKey` (via `loadOrCreateKey`, enroll.ts:134),
//                     `buildDesktopHello` (enroll-once.ts:265),
//                     `deriveEnrollmentIdempotencyKey` (enroll-once.ts:271),
//                     `signDeviceProof` (enroll.ts:135).
//   synthetic path  — a hand-rolled Ed25519 keypair, a hand-written hello object
//                     literal, and a hand-built canonical proof string: exactly
//                     what `tests/d1/lib/e6f-harness.mjs` does
//                     (generateDeviceKey:180, buildWorkerHello:208,
//                     DEVICE_PROOF_SNIPPET:258, enroll:447), reproduced here with
//                     no import from the daemon.
//
// …and then computes, with the SERVER'S formulas, every value the enrolment
// commits: `workers.device_thumbprint` / `device_public_key` / `profile_hash` /
// `profile_snapshot`, and `worker_enrollment_codes.semantic_idempotency_key` /
// `semantic_digest`. The server's own `verifyDeviceProof` accepts both.
//
// ★ THE RESULT IS A NEGATIVE. Every one of those values is byte-reproducible by
// the synthetic path. There is no attested field, no server-issued nonce bound to
// an execution environment, and no transport fact recorded at all. So a row
// cannot tell you a container ran; only the daemon's own stdout can, and stdout
// is what the lane was trying to improve on.
//
// WHAT THIS TEST PINS. If someone later adds a discriminator a synthetic cannot
// forge — an attestation quote, a CP-issued environment nonce, a recorded peer
// identity — the byte-identity assertions below go RED, and that is the signal to
// re-read the U1 finding rather than a bug to paper over. The pin is deliberate:
// the finding is true only for as long as these bytes match.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildDesktopHello,
  deriveEnrollmentIdempotencyKey,
  generateDeviceKey,
  signDeviceProof,
} from "@armyofagents/worker-daemon";

import { verifyDeviceProof } from "../services/worker-device-proof.js";

/** `server/src/services/worker-enrollment.ts:71-73` verbatim. */
function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * `server/src/services/worker-enrollment.ts:114-131` verbatim — the digest the
 * server pins onto `worker_enrollment_codes.semantic_digest`.
 */
function enrollmentSemanticDigest(input: {
  protocolVersion: number;
  audience: string;
  idempotencyKey: string;
  hello: unknown;
  deviceThumbprint: string;
  scope: string;
  authoritativeOrganizationId: string | null;
  executionTargetId: string;
}): string {
  return sha256(JSON.stringify({
    protocolVersion: input.protocolVersion,
    audience: input.audience,
    idempotencyKey: input.idempotencyKey,
    hello: input.hello,
    deviceThumbprint: input.deviceThumbprint,
    scope: input.scope,
    authoritativeOrganizationId: input.authoritativeOrganizationId,
    executionTargetId: input.executionTargetId,
  }));
}

// The committed D1 fixture (`docker/d1/worker-b.enrollment-ticket`) — the target
// the one real container daemon in the tree actually enrols against.
const WORKER_B_TARGET_ID = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION = 1;

const ENROLL_PATH = "/api/worker-control/enroll";

/** What the container daemon builds. `enroll-once.ts:265` + `:271`. */
function containerDaemonFacts() {
  const hello = buildDesktopHello({
    workerId: WORKER_ID,
    targetId: WORKER_B_TARGET_ID,
    deviceGeneration: GENERATION,
    // `bin/worker-daemon.ts:502` passes `process.platform` / `process.arch`; the
    // D1 worker image is linux/x64.
    platform: "linux",
    arch: "x64",
  });
  return {
    hello,
    idempotencyKey: deriveEnrollmentIdempotencyKey(WORKER_ID, WORKER_B_TARGET_ID, GENERATION),
  };
}

/**
 * What a synthetic device CAN build. Nothing here imports the daemon: it is a
 * plain object literal, which is all a test runner (or anything else holding the
 * enrolment code) has.
 *
 * `mutate` exists for the non-vacuity control below — it perturbs exactly one
 * field of the forged hello so the byte-identity assertions can be observed RED.
 */
function syntheticFacts(mutate: (hello: Record<string, unknown>) => void = () => {}) {
  const hello: Record<string, unknown> = {
    protocolVersion: 1,
    workerId: WORKER_ID,
    targetId: WORKER_B_TARGET_ID,
    deviceGeneration: GENERATION,
    // Free-form `z.string().min(1).max(100)` — `packages/worker-protocol/src/
    // capabilities.ts:372`. The harness happens to write "e6f-03-harness"; it is
    // under no obligation to, and the server never checks.
    agentVersion: "0.1.0",
    supportedProtocol: { min: 1, max: 1 },
    // `runtime` is likewise free-form (`capabilities.ts:110`), and
    // `desktop-hello.ts:62-69` documents the DELIBERATE choice to emit a constant
    // rather than anything fingerprintable.
    platform: { os: "linux", arch: "x64", runtime: "desktop" },
    reportedCapabilities: [],
    capacity: {
      batchSlots: 0,
      browserSessionSlots: 0,
      serviceSlots: 0,
      freeCpuMillis: 0,
      freeMemoryMiB: 0,
      freeDiskMiB: 0,
    },
    policyHash: "0".repeat(64),
  };
  mutate(hello);
  return {
    hello,
    // A pure function of three values the row itself carries — no secret input.
    idempotencyKey: deriveEnrollmentIdempotencyKey(WORKER_ID, WORKER_B_TARGET_ID, GENERATION),
  };
}

/** `tests/d1/lib/e6f-harness.mjs:180-187`, reproduced with no daemon import. */
function syntheticDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyDer: der.toString("base64url"),
    deviceThumbprint: createHash("sha256").update(der).digest("hex"),
  };
}

/** `tests/d1/lib/e6f-harness.mjs:258-285` (DEVICE_PROOF_SNIPPET), reproduced. */
function syntheticProofSignature(input: {
  method: string;
  path: string;
  bodyString: string;
  correlationId: string;
  issuedAt: string;
  proofId: string;
  privateKeyPem: string;
}): string {
  const canonical = [
    "AOA-DEVICE-PROOF-V1",
    input.method.toUpperCase(),
    input.path,
    sha256(Buffer.from(input.bodyString, "utf8")),
    input.correlationId,
    input.issuedAt,
    input.proofId,
  ].join(String.fromCharCode(10));
  const key: KeyObject = createPrivateKey(input.privateKeyPem);
  return edSign(null, Buffer.from(canonical, "utf8"), key).toString("base64url");
}

describe("U1 — container-daemon vs synthetic-device provenance", () => {
  it("(a) the persisted thumbprint is sha256(SPKI DER) of a key the enroller HOLDS — and a synthetic holds one too", () => {
    const bodyString = JSON.stringify({ probe: "u1" });
    const bodyDigest = sha256(Buffer.from(bodyString, "utf8"));
    const correlationId = randomUUID();
    const issuedAt = new Date().toISOString();

    // --- the container daemon's own signing path -----------------------------
    const daemonKey = generateDeviceKey();
    const daemonProof = signDeviceProof({
      method: "POST",
      path: ENROLL_PATH,
      rawBody: Buffer.from(bodyString, "utf8"),
      correlationId,
      issuedAt,
      proofId: "prf_u1_daemon_probe_0001",
      key: daemonKey,
    });
    const daemonVerified = verifyDeviceProof({
      method: "POST",
      path: ENROLL_PATH,
      bodyDigest,
      correlationId,
      proof: {
        version: "1",
        publicKey: daemonKey.publicKeyDer,
        signature: daemonProof.signature,
        issuedAt,
        proofId: "prf_u1_daemon_probe_0001",
      },
    });

    // (a) is TRUE — `worker-device-proof.ts:92` derives the thumbprint from the
    // presented SPKI, and the signature check at :89 proves the private half was
    // held. Nothing weaker would have been enough for a daemon lane.
    expect(daemonVerified.deviceThumbprint).toBe(daemonKey.deviceThumbprint);
    expect(daemonVerified.publicKey).toBe(daemonKey.publicKeyDer);

    // --- and the identical property holds for a synthetic --------------------
    // The property proves KEY POSSESSION. It says nothing whatever about where
    // the key was minted, which is the only thing a daemon lane needs it to say.
    const synthetic = syntheticDeviceKey();
    const syntheticVerified = verifyDeviceProof({
      method: "POST",
      path: ENROLL_PATH,
      bodyDigest,
      correlationId,
      proof: {
        version: "1",
        publicKey: synthetic.publicKeyDer,
        signature: syntheticProofSignature({
          method: "POST",
          path: ENROLL_PATH,
          bodyString,
          correlationId,
          issuedAt,
          proofId: "e6f_u1_synth_probe_001",
          privateKeyPem: synthetic.privateKeyPem,
        }),
        issuedAt,
        proofId: "e6f_u1_synth_probe_001",
      },
    });
    expect(syntheticVerified.deviceThumbprint).toBe(synthetic.deviceThumbprint);
    expect(syntheticVerified.publicKey).toBe(synthetic.publicKeyDer);
  });

  it("(d) every value the enrolment commits is byte-reproducible by a synthetic device", () => {
    const daemon = containerDaemonFacts();
    const synthetic = syntheticFacts();

    // `workers.profile_snapshot` is the hello verbatim and `workers.profile_hash`
    // is `sha256(JSON.stringify(request.hello))` (`worker-enrollment.ts:409`).
    // Zod's `.strict()` object rebuilds in SCHEMA key order, so the wire order of
    // the forged literal is irrelevant — only the VALUES have to match.
    expect(JSON.parse(JSON.stringify(synthetic.hello))).toStrictEqual(
      JSON.parse(JSON.stringify(daemon.hello)),
    );
    expect(sha256(JSON.stringify(synthetic.hello))).toBe(sha256(JSON.stringify(daemon.hello)));

    // `worker_enrollment_codes.semantic_idempotency_key`. The daemon's is DERIVED
    // rather than random — which reads like a provenance signal right up until you
    // notice the derivation takes only public values and no secret at all
    // (`enrollment/idempotency.ts:12` says so outright).
    expect(synthetic.idempotencyKey).toBe(daemon.idempotencyKey);

    // `worker_enrollment_codes.semantic_digest` — the server's own formula over
    // both, with an identical thumbprint (each enroller mints its own key and the
    // server binds whatever key signed, so the thumbprint is not a discriminator).
    const thumbprint = "a".repeat(64);
    const digestOf = (facts: { hello: unknown; idempotencyKey: string }) =>
      enrollmentSemanticDigest({
        protocolVersion: 1,
        audience: "target_enrollment",
        idempotencyKey: facts.idempotencyKey,
        hello: JSON.parse(JSON.stringify(facts.hello)),
        deviceThumbprint: thumbprint,
        scope: "organization",
        authoritativeOrganizationId: ORGANIZATION_ID,
        executionTargetId: WORKER_B_TARGET_ID,
      });
    expect(digestOf(synthetic)).toBe(digestOf(daemon));
  });

  it("the identity assertion is NON-VACUOUS — perturbing one forged field breaks it", () => {
    const daemon = containerDaemonFacts();
    // `agentVersion` is the most daemon-looking field in the hello. It is also a
    // free-form string the server never checks against anything, which is exactly
    // why it is a label and not a proof.
    const mutated = syntheticFacts((hello) => {
      hello.agentVersion = "e6f-03-harness";
    });
    expect(sha256(JSON.stringify(mutated.hello))).not.toBe(sha256(JSON.stringify(daemon.hello)));
  });

  it("(c/d) the enrolment path reads NO transport fact, so none can reach a column", () => {
    // A SOURCE scan, not a prose claim. If a future change starts recording a peer
    // address, a TLS identity, or a user agent on the enrolment or worker-control
    // path, that WOULD be a genuine discriminator — and this case goes red so the
    // U1 finding is re-read rather than silently outlived.
    const here = fileURLToPath(new URL(".", import.meta.url));
    const sources = [
      "../services/worker-enrollment.ts",
      "../routes/worker-control.ts",
      "../middleware/worker-session-auth.ts",
      "../services/worker-device-proof.ts",
    ];
    const transportFacts = [
      "remoteAddress",
      "req.ip",
      "x-forwarded-for",
      "user-agent",
      "userAgent",
      "getPeerCertificate",
    ];
    const found: string[] = [];
    for (const rel of sources) {
      const text = readFileSync(new URL(rel, `file://${here.replace(/\\/g, "/")}`), "utf8");
      for (const token of transportFacts) {
        if (text.includes(token)) found.push(`${rel}: ${token}`);
      }
    }
    expect(found).toStrictEqual([]);
  });
});

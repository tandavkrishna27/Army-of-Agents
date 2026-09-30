// server/src/__tests__/worker-hello-refresh.test.ts
//
// WRK-011 (Sprint 2.75) — the PURE wire bits of the hello-refresh route: the local
// request schema, the operation descriptor, and the canonical digest.
//
// The digest is defined HERE and only here (design §3.1/§8 M11): a caller that hashed a
// hand-built object instead of the zod-parsed one would mint a value placement can never
// re-derive (job-placement.ts:543). These tests pin the two properties that guarantee it.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { workerHelloV1Schema, type WorkerHelloV1 } from "@armyofagents/worker-protocol";
import {
  SELF_HELLO_DESCRIPTOR,
  digestHello,
  selfHelloRequestSchema,
} from "../services/worker-hello-refresh.js";

const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "55555555-5555-4555-8555-555555555555";

const helloFields = {
  protocolVersion: 1 as const,
  workerId: WORKER_ID,
  targetId: TARGET_ID,
  deviceGeneration: 3,
  agentVersion: "1.0.0",
  supportedProtocol: { min: 1, max: 1 },
  platform: { os: "linux" as const, arch: "x64" as const, runtime: "desktop" },
  reportedCapabilities: ["workload.batch" as const],
  capacity: {
    batchSlots: 1,
    browserSessionSlots: 0,
    serviceSlots: 0,
    freeCpuMillis: 1000,
    freeMemoryMiB: 512,
    freeDiskMiB: 1024,
  },
  policyHash: "a".repeat(64),
};

function hello(): WorkerHelloV1 {
  return workerHelloV1Schema.parse(helloFields);
}

describe("digestHello", () => {
  it("equals what worker-enrollment.ts:409 produces — sha256(JSON.stringify(zod-parsed hello))", () => {
    const h = hello();
    const enrolmentEquivalent = createHash("sha256").update(JSON.stringify(h)).digest("hex");
    expect(digestHello(h)).toBe(enrolmentEquivalent);
  });

  it("is stable across a key-reordered body (the parse-first property — §0e / M11)", () => {
    // Build a raw body whose top-level keys are in a DIFFERENT order, parse it, and confirm
    // the digest of the parsed value matches. zod emits keys in SCHEMA order, so the digest
    // is invariant to input order ONLY because it hashes the parsed value, not the raw body.
    const reordered = {
      policyHash: helloFields.policyHash,
      capacity: helloFields.capacity,
      reportedCapabilities: helloFields.reportedCapabilities,
      platform: helloFields.platform,
      supportedProtocol: helloFields.supportedProtocol,
      agentVersion: helloFields.agentVersion,
      deviceGeneration: helloFields.deviceGeneration,
      targetId: helloFields.targetId,
      workerId: helloFields.workerId,
      protocolVersion: helloFields.protocolVersion,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(helloFields)); // different raw order
    const parsed = workerHelloV1Schema.parse(reordered);
    expect(digestHello(parsed)).toBe(digestHello(hello()));
  });

  it("★ is stable across a key-reordered body THROUGH the envelope schema (M11 — the envelope must PARSE the hello, not passthrough)", () => {
    // This is the mutation-load-bearing case: the digest's stability rests on
    // `selfHelloRequestSchema.hello` being the FROZEN schema (which normalizes key order),
    // not a passthrough. If M11 replaces it with a passthrough, the reordered body keeps its
    // order and this digest diverges — exactly what job-placement.ts:543 would then never
    // re-derive. The earlier case parses in the TEST, so it cannot see a missing envelope parse.
    const reordered = {
      policyHash: helloFields.policyHash, capacity: helloFields.capacity,
      reportedCapabilities: helloFields.reportedCapabilities, platform: helloFields.platform,
      supportedProtocol: helloFields.supportedProtocol, agentVersion: helloFields.agentVersion,
      deviceGeneration: helloFields.deviceGeneration, targetId: helloFields.targetId,
      workerId: helloFields.workerId, protocolVersion: helloFields.protocolVersion,
    };
    const a = selfHelloRequestSchema.parse({ protocolVersion: 1, correlationId: CORRELATION_ID, hello: reordered });
    const b = selfHelloRequestSchema.parse({ protocolVersion: 1, correlationId: CORRELATION_ID, hello: helloFields });
    expect(digestHello(a.hello)).toBe(digestHello(b.hello));
  });
});

describe("selfHelloRequestSchema", () => {
  it("accepts a well-formed refresh request", () => {
    const parsed = selfHelloRequestSchema.parse({ protocolVersion: 1, correlationId: CORRELATION_ID, hello: helloFields });
    expect(parsed.hello.workerId).toBe(WORKER_ID);
  });

  it("is .strict() — an unknown top-level field is rejected", () => {
    expect(
      selfHelloRequestSchema.safeParse({ protocolVersion: 1, correlationId: CORRELATION_ID, hello: helloFields, extra: 1 }).success,
    ).toBe(false);
  });

  it("rejects a malformed hello (the frozen schema is composed, not bypassed)", () => {
    expect(
      selfHelloRequestSchema.safeParse({ protocolVersion: 1, correlationId: CORRELATION_ID, hello: { ...helloFields, policyHash: "nope" } }).success,
    ).toBe(false);
  });
});

describe("SELF_HELLO_DESCRIPTOR", () => {
  it("bounds the request STRICTLY below the global 20mb body limit (otherwise express refuses first and the handler guard is dead code)", () => {
    const GLOBAL_BODY_LIMIT_BYTES = 20 * 1024 * 1024; // app.ts:302 express.json({ limit: "20mb" })
    expect(SELF_HELLO_DESCRIPTOR.maxRequestBytes).toBeLessThan(GLOBAL_BODY_LIMIT_BYTES);
    expect(SELF_HELLO_DESCRIPTOR.audience).toBe("device_session");
  });
});

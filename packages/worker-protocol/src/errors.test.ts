import { describe, expect, it } from "vitest";
import {
  PROTOCOL_ERROR_CODES,
  RETRYABLE_PROTOCOL_ERROR_CODES,
  isKnownProtocolErrorCode,
  isRetryableProtocolErrorCode,
  protocolErrorCodeSchema,
  protocolErrorV1Schema,
} from "./errors.js";

const ISO = "2026-08-09T00:00:00.000Z";

/** A minimally valid non-retryable protocol error (malformed). */
function malformedError(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    code: "malformed",
    correlationId: "00000000-0000-4000-8000-000000000001",
    message: "the request body failed schema validation",
    retryAfterMs: null,
    serverTime: ISO,
    redaction: "secret",
    detail: {},
  };
}

/** A minimally valid retryable protocol error (throttled) with a retry hint. */
function throttledError(): Record<string, unknown> {
  return { ...malformedError(), code: "throttled", retryAfterMs: 2500 };
}

describe("errors.ts — the stable ProtocolErrorV1 code vocabulary", () => {
  it("locks the exact 13 stable error codes in order", () => {
    expect(PROTOCOL_ERROR_CODES).toEqual([
      "malformed",
      "unauthorized",
      "incompatible_protocol",
      "incompatible_capability",
      "incompatible_policy",
      "stale_fence",
      "sequence_gap",
      "target_revoked",
      "event_hash_mismatch",
      "throttled",
      "payload_too_large",
      "attempt_terminal",
      "internal_unavailable",
    ]);
  });

  it("only throttled and internal_unavailable are retryable", () => {
    expect([...RETRYABLE_PROTOCOL_ERROR_CODES].sort()).toEqual(["internal_unavailable", "throttled"]);
    expect(isRetryableProtocolErrorCode("throttled")).toBe(true);
    expect(isRetryableProtocolErrorCode("internal_unavailable")).toBe(true);
    expect(isRetryableProtocolErrorCode("stale_fence")).toBe(false);
    expect(isRetryableProtocolErrorCode("malformed")).toBe(false);
  });

  it("classifies known vs unknown codes fail-closed", () => {
    for (const code of PROTOCOL_ERROR_CODES) expect(isKnownProtocolErrorCode(code)).toBe(true);
    expect(isKnownProtocolErrorCode("teapot")).toBe(false);
    expect(isKnownProtocolErrorCode("")).toBe(false);
    expect(isKnownProtocolErrorCode(42)).toBe(false);
    expect(isKnownProtocolErrorCode(null)).toBe(false);
  });

  it("the code enum rejects an unknown code (unknown fails closed)", () => {
    expect(protocolErrorCodeSchema.safeParse("stale_fence").success).toBe(true);
    expect(protocolErrorCodeSchema.safeParse("not_a_real_code").success).toBe(false);
  });
});

describe("errors.ts — protocolErrorV1Schema", () => {
  it("accepts a well-formed non-retryable error", () => {
    expect(protocolErrorV1Schema.safeParse(malformedError()).success).toBe(true);
  });

  it("accepts a well-formed retryable error carrying retryAfterMs", () => {
    expect(protocolErrorV1Schema.safeParse(throttledError()).success).toBe(true);
  });

  it("rejects an unknown protocol version", () => {
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), protocolVersion: 2 }).success).toBe(false);
  });

  it("rejects an unknown error code (fail closed)", () => {
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), code: "kaboom" }).success).toBe(false);
  });

  it("requires retryAfterMs for a retryable code and forbids it for a non-retryable code", () => {
    // throttled MUST carry a non-null retryAfterMs.
    expect(protocolErrorV1Schema.safeParse({ ...throttledError(), retryAfterMs: null }).success).toBe(false);
    // internal_unavailable MUST carry a non-null retryAfterMs.
    expect(
      protocolErrorV1Schema.safeParse({ ...malformedError(), code: "internal_unavailable", retryAfterMs: null }).success,
    ).toBe(false);
    // a non-retryable code MUST NOT carry retryAfterMs.
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), retryAfterMs: 1000 }).success).toBe(false);
  });

  it("rejects a negative retryAfterMs", () => {
    expect(protocolErrorV1Schema.safeParse({ ...throttledError(), retryAfterMs: -1 }).success).toBe(false);
  });

  it("rejects an unknown key (strict) — no existence-disclosure side channel", () => {
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), foreignTenantResourceExists: true }).success).toBe(false);
  });

  it("rejects a detail object that carries a credential-bearing key (redaction fail-closed)", () => {
    expect(
      protocolErrorV1Schema.safeParse({ ...malformedError(), detail: { authorization: "Bearer x" } }).success,
    ).toBe(false);
  });

  it("rejects an over-long message (bounded)", () => {
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), message: "z".repeat(1001) }).success).toBe(false);
  });

  it("requires the explicit secret redaction marker", () => {
    expect(protocolErrorV1Schema.safeParse({ ...malformedError(), redaction: "none" }).success).toBe(false);
  });
});

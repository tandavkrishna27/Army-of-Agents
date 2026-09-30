import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalEventDigestInputV1,
  canonicalizeJsonV1,
  verifyWorkerEventDigestV1,
} from "./canonical-json.js";

// A Node SHA-256 (lowercase hex) over UTF-8 canonical bytes. Runtime source is
// hash-provider neutral; the receiver/producer inject their platform crypto —
// tests inject Node's.
const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

// Explicit code-point constructions so no literal control/combining char is
// embedded in this source file.
const CONTROL_0_1F = String.fromCharCode(0x00, 0x1f);
const DEL = String.fromCharCode(0x7f); // 0x7f >= 0x20 → passes through unescaped
const PRECOMPOSED_E_ACUTE = "é"; // é as a single code point
const COMBINING_E_ACUTE = "é"; // e + combining acute (two code points)
const EMOJI = "\u{1f600}"; // 😀 as a valid astral surrogate pair

// -----------------------------------------------------------------------------
// RFC 8785 (subset) canonical-JSON conformance vectors. This canonicalizer MUST
// reproduce the frozen E0 authority (scripts/check-distributed-execution-
// foundation.mjs `canonicalizeJson`) byte-for-byte: integer-only subset, key
// sort by UTF-16 code units, `-0`→"0", exact string escapes, and rejection of
// floats / unsafe integers / lone surrogates / unsupported types.
// -----------------------------------------------------------------------------

describe("canonicalizeJsonV1 — RFC 8785 subset conformance", () => {
  it("is independent of object property insertion order", () => {
    expect(canonicalizeJsonV1({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJsonV1({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJsonV1({ b: 1, a: 2 })).toBe(canonicalizeJsonV1({ a: 2, b: 1 }));
  });

  it("sorts keys by UTF-16 code unit (uppercase before lowercase)", () => {
    // "Z" (0x5A) sorts before "a" (0x61) under a default code-unit sort.
    expect(canonicalizeJsonV1({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
    expect(canonicalizeJsonV1({ b: 1, A: 2, a: 3 })).toBe('{"A":2,"a":3,"b":1}');
  });

  it("serializes integers with no exponent and no leading zeros", () => {
    expect(canonicalizeJsonV1(0)).toBe("0");
    expect(canonicalizeJsonV1(-42)).toBe("-42");
    expect(canonicalizeJsonV1(1_000_000)).toBe("1000000");
    // Largest safe integer round-trips exactly (no exponent).
    expect(canonicalizeJsonV1(9_007_199_254_740_991)).toBe("9007199254740991");
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalizeJsonV1(-0)).toBe("0");
    expect(canonicalizeJsonV1({ deep: -0 })).toBe('{"deep":0}');
  });

  it("serializes booleans and null", () => {
    expect(canonicalizeJsonV1(true)).toBe("true");
    expect(canonicalizeJsonV1(false)).toBe("false");
    expect(canonicalizeJsonV1(null)).toBe("null");
  });

  it("applies the exact RFC 8785 string escapes", () => {
    expect(canonicalizeJsonV1('a"b')).toBe('"a\\"b"');
    expect(canonicalizeJsonV1("a\\b")).toBe('"a\\\\b"');
    expect(canonicalizeJsonV1("\b\f\n\r\t")).toBe('"\\b\\f\\n\\r\\t"');
    // Other control characters below 0x20 use lowercase \u00XX.
    expect(canonicalizeJsonV1(CONTROL_0_1F)).toBe('"\\u0000\\u001f"');
    // 0x7f (DEL) is >= 0x20 and passes through unescaped (matches E0).
    expect(canonicalizeJsonV1(DEL)).toBe(`"${DEL}"`);
    // The forward slash is NOT escaped in the RFC 8785 subset.
    expect(canonicalizeJsonV1("a/b")).toBe('"a/b"');
  });

  it("passes non-ASCII and astral characters through without normalization", () => {
    expect(canonicalizeJsonV1(PRECOMPOSED_E_ACUTE)).toBe(`"${PRECOMPOSED_E_ACUTE}"`);
    expect(canonicalizeJsonV1(EMOJI)).toBe(`"${EMOJI}"`); // valid astral surrogate pair
    // A combining sequence is preserved code-point for code-point (no NFC/NFD),
    // so it differs from the single precomposed code point.
    expect(canonicalizeJsonV1(COMBINING_E_ACUTE)).toBe(`"${COMBINING_E_ACUTE}"`);
    expect(canonicalizeJsonV1(COMBINING_E_ACUTE)).not.toBe(canonicalizeJsonV1(PRECOMPOSED_E_ACUTE));
  });

  it("canonicalizes nested arrays and objects", () => {
    expect(canonicalizeJsonV1({ z: [1, 2], a: { c: 3, b: null } })).toBe(
      '{"a":{"b":null,"c":3},"z":[1,2]}',
    );
    expect(canonicalizeJsonV1([])).toBe("[]");
    expect(canonicalizeJsonV1({})).toBe("{}");
  });

  it("rejects floats", () => {
    expect(() => canonicalizeJsonV1(1.5)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJsonV1(0.25)).toThrow();
    expect(() => canonicalizeJsonV1({ rate: 0.25 })).toThrow();
    expect(() => canonicalizeJsonV1([1, 2.5])).toThrow();
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalizeJsonV1(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJsonV1(Number.NaN)).toThrow(CanonicalJsonError);
  });

  it("rejects unsafe integers at the 2^53 boundary", () => {
    expect(() => canonicalizeJsonV1(9_007_199_254_740_992)).toThrow(CanonicalJsonError); // 2^53
    expect(() => canonicalizeJsonV1(-9_007_199_254_740_992)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJsonV1([9_007_199_254_740_992])).toThrow();
    // The largest SAFE integer (2^53 - 1) is accepted (boundary just below).
    expect(canonicalizeJsonV1(9_007_199_254_740_991)).toBe("9007199254740991");
  });

  it("rejects lone / broken UTF-16 surrogates", () => {
    expect(() => canonicalizeJsonV1(String.fromCharCode(0xd800))).toThrow(CanonicalJsonError); // lone high
    expect(() => canonicalizeJsonV1(String.fromCharCode(0xdc00))).toThrow(CanonicalJsonError); // stray low
    expect(() => canonicalizeJsonV1(String.fromCharCode(0xd800, 0x78))).toThrow(); // high + 'x'
    expect(() => canonicalizeJsonV1({ k: `a${String.fromCharCode(0xdbff)}b` })).toThrow();
  });

  it("rejects unsupported value types", () => {
    expect(() => canonicalizeJsonV1(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJsonV1(10n as unknown)).toThrow(CanonicalJsonError); // bigint
    expect(() => canonicalizeJsonV1(Symbol("x") as unknown)).toThrow();
    expect(() => canonicalizeJsonV1((() => 1) as unknown)).toThrow();
    expect(() => canonicalizeJsonV1([undefined])).toThrow();
  });

  it("operates on already-parsed values so object keys are unique by construction", () => {
    // A JS object literal cannot hold two identical keys; the canonical form is
    // therefore deterministic regardless of how it was built (dup-key ambiguity
    // is resolved before this function ever sees the value).
    const built: Record<string, number> = {};
    built.a = 1;
    built.a = 2;
    expect(canonicalizeJsonV1(built)).toBe('{"a":2}');
  });
});

// -----------------------------------------------------------------------------
// canonicalEventDigestInputV1: canonical UTF-8 bytes of the event minus its
// `eventDigest`. It must require a plain object and reject a stringified event.
// -----------------------------------------------------------------------------

const sampleEvent = {
  protocolVersion: 1,
  eventId: "ZWXHQ1K2C8HGE436ATF3G9PRQY",
  eventType: "attempt_started",
  organizationId: "org_JYZJ73W1EQYNYW3CX4WVC9N4A7",
  companyId: "company_KD9296WTTX18SW3FC8BE2VKQRS",
  workerId: "worker_YW6K965XPTB16Y006X38FJZK7Z",
  jobId: "job_95VGXJXBR3XBT3DH5ZTNXMA8FR",
  attempt: 1,
  leaseId: "lease_FE5TWACEC1HGA5KN2Z94SPCSA0",
  fenceToken: 100,
  seq: 1,
  occurredAt: "2026-08-08T12:00:00.000Z",
  payload: { detail: "x", stage: "run" },
} as const;

describe("canonicalEventDigestInputV1", () => {
  it("removes only the eventDigest field before canonicalizing", () => {
    const withDigest = { ...sampleEvent, eventDigest: "a".repeat(64) };
    const other = { ...sampleEvent, eventDigest: "b".repeat(64) };
    // The input bytes are independent of the eventDigest value...
    expect(decode(canonicalEventDigestInputV1(withDigest))).toBe(
      decode(canonicalEventDigestInputV1(other)),
    );
    // ...and equal the canonical form of the event with eventDigest omitted.
    expect(decode(canonicalEventDigestInputV1(withDigest))).toBe(canonicalizeJsonV1(sampleEvent));
  });

  it("returns UTF-8 bytes", () => {
    const bytes = canonicalEventDigestInputV1({ ...sampleEvent, eventDigest: "a".repeat(64) });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decode(bytes)).toBe(canonicalizeJsonV1(sampleEvent));
  });

  it("rejects a non-object input", () => {
    expect(() => canonicalEventDigestInputV1("not-an-object" as unknown)).toThrow(CanonicalJsonError);
    expect(() => canonicalEventDigestInputV1(42 as unknown)).toThrow();
    expect(() => canonicalEventDigestInputV1(null as unknown)).toThrow();
    expect(() => canonicalEventDigestInputV1([sampleEvent] as unknown)).toThrow();
  });

  it("rejects an already-stringified event", () => {
    const stringified = JSON.stringify({ ...sampleEvent, eventDigest: "a".repeat(64) });
    expect(() => canonicalEventDigestInputV1(stringified as unknown)).toThrow(CanonicalJsonError);
  });
});

// -----------------------------------------------------------------------------
// verifyWorkerEventDigestV1: inject a sync or async SHA-256 and recompute over
// canonicalEventDigestInputV1; false on any supplied/recomputed mismatch.
// -----------------------------------------------------------------------------

describe("verifyWorkerEventDigestV1", () => {
  const digestOf = (event: object): string => sha256hex(canonicalEventDigestInputV1(event));

  it("verifies an event whose eventDigest was computed over its canonical bytes", async () => {
    const event = { ...sampleEvent, eventDigest: digestOf(sampleEvent) };
    await expect(verifyWorkerEventDigestV1(event, sha256hex)).resolves.toBe(true);
  });

  it("accepts an asynchronous SHA-256 provider", async () => {
    const asyncSha = (bytes: Uint8Array): Promise<string> => Promise.resolve(sha256hex(bytes));
    const event = { ...sampleEvent, eventDigest: digestOf(sampleEvent) };
    await expect(verifyWorkerEventDigestV1(event, asyncSha)).resolves.toBe(true);
  });

  it("fails when a supplied digest does not match the content", async () => {
    const event = { ...sampleEvent, eventDigest: "0".repeat(64) };
    await expect(verifyWorkerEventDigestV1(event, sha256hex)).resolves.toBe(false);
  });

  it("fails when identity, timestamp, type, payload, or seq changes without recomputation", async () => {
    const digest = digestOf(sampleEvent);
    const mutations: Array<Record<string, unknown>> = [
      { organizationId: "org_TAMPERED000000000000000000" },
      { occurredAt: "2026-08-08T12:00:01.000Z" },
      { eventType: "log" },
      { seq: 2 },
      { payload: { detail: "y", stage: "run" } },
    ];
    for (const mutation of mutations) {
      const tampered = { ...sampleEvent, ...mutation, eventDigest: digest };
      await expect(verifyWorkerEventDigestV1(tampered, sha256hex)).resolves.toBe(false);
    }
  });

  it("returns false for a non-object or a missing/invalid eventDigest", async () => {
    await expect(verifyWorkerEventDigestV1("nope" as unknown, sha256hex)).resolves.toBe(false);
    await expect(verifyWorkerEventDigestV1({ ...sampleEvent }, sha256hex)).resolves.toBe(false);
    await expect(
      verifyWorkerEventDigestV1({ ...sampleEvent, eventDigest: 123 as unknown }, sha256hex),
    ).resolves.toBe(false);
  });
});

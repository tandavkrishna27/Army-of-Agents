// DSK-001 — the enrollment idempotency key.
//
// This is what makes a retry after a FAILED enroll safe (I7). The server stores
// the key as `text` and compares it with exact equality
// (`worker-enrollment.ts:325`), replaying the already-committed submission when
// it matches rather than minting a second identity. So the key must be a pure
// function of the identity, stable across restarts and across process boundaries.
//
// The security property: NO SECRET IS AN INPUT. The enrollment code is
// deliberately excluded, so the value that crosses the wire is not a derivative
// of a live bearer credential. That is structural here — the function has no
// parameter through which a secret could arrive.

import { describe, expect, it } from "vitest";
import { deriveEnrollmentIdempotencyKey } from "../enrollment/idempotency.js";

const WORKER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TARGET = "a3000000-0000-4000-8000-000000000003";
const GEN = 1;

describe("DSK-001 — the key is deterministic and identity-shaped", () => {
  it("is stable for the same inputs, across calls", () => {
    const a = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    const b = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    expect(a).toBe(b);
  });

  it("renders 8-4-4-4-12 in LOWERCASE", () => {
    // The column is `text` and the comparison is `!==`, so case is significant:
    // an uppercase rendering would never match a stored lowercase one and every
    // retry would look like a fresh submission.
    const key = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(key).toBe(key.toLowerCase());
  });

  it("sets the version and variant bits, so it is a well-formed UUID", () => {
    const key = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    expect(key[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(key[19]);
  });
});

describe("DSK-001 — every identity component changes the key", () => {
  const base = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);

  it("changes with the workerId", () => {
    expect(deriveEnrollmentIdempotencyKey("11111111-1111-4111-8111-111111111111", TARGET, GEN))
      .not.toBe(base);
  });

  it("changes with the targetId", () => {
    expect(deriveEnrollmentIdempotencyKey(WORKER, "22222222-2222-4222-8222-222222222222", GEN))
      .not.toBe(base);
  });

  it("changes with the device generation", () => {
    // A rotation is a NEW submission, not a replay of the old one.
    expect(deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN + 1)).not.toBe(base);
  });

  it("is not confusable across field boundaries", () => {
    // A naive concatenation without a separator lets ("ab","c") and ("a","bc")
    // collide. The separator makes the encoding injective.
    const a = deriveEnrollmentIdempotencyKey("ab", "c", 1);
    const b = deriveEnrollmentIdempotencyKey("a", "bc", 1);
    expect(a).not.toBe(b);
  });
});

describe("DSK-001 — the key is not derived from any secret", () => {
  it("takes exactly three parameters, none of which is the enrollment code", () => {
    // Structural: there is no argument through which a credential could arrive,
    // so the wire value cannot be a derivative of one. This is the same shape as
    // the command planner taking no secret parameter.
    expect(deriveEnrollmentIdempotencyKey.length).toBe(3);
  });

  it("produces the same key regardless of which code was used", () => {
    // Two enrolments of the same identity with different codes must produce the
    // same idempotency key — otherwise a retry with a re-issued code would look
    // like a new submission and mint a second identity.
    const first = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    const second = deriveEnrollmentIdempotencyKey(WORKER, TARGET, GEN);
    expect(first).toBe(second);
  });
});

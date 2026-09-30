import { describe, expect, it } from "vitest";
import {
  attemptNumberSchema,
  companyIdSchema,
  eventSequenceSchema,
  fenceTokenSchema,
  jobIdSchema,
  organizationIdSchema,
  principalIdSchema,
  sandboxIdSchema,
  sha256DigestSchema,
} from "./ids.js";

describe("wire identities", () => {
  it("accepts UUID identities and positive counters", () => {
    expect(organizationIdSchema.parse("00000000-0000-4000-8000-000000000001")).toBeTruthy();
    expect(jobIdSchema.parse("00000000-0000-4000-8000-000000000002")).toBeTruthy();
    expect(attemptNumberSchema.parse(1)).toBe(1);
    expect(eventSequenceSchema.parse(1)).toBe(1);
  });

  it("rejects malformed identities and non-positive counters", () => {
    expect(jobIdSchema.safeParse("job-1").success).toBe(false);
    expect(attemptNumberSchema.safeParse(0).success).toBe(false);
    expect(eventSequenceSchema.safeParse(-1).success).toBe(false);
  });

  it("accepts only bounded base64url fences and lowercase SHA-256", () => {
    expect(fenceTokenSchema.safeParse("a".repeat(43)).success).toBe(true);
    expect(fenceTokenSchema.safeParse("short").success).toBe(false);
    expect(sha256DigestSchema.safeParse("f".repeat(64)).success).toBe(true);
    expect(sha256DigestSchema.safeParse("F".repeat(64)).success).toBe(false);
  });
});

describe("branded UUID domain identities", () => {
  it("rejects non-UUID and non-string values across UUID-branded schemas", () => {
    for (const schema of [organizationIdSchema, companyIdSchema, jobIdSchema]) {
      expect(schema.parse("00000000-0000-4000-8000-000000000009")).toBe(
        "00000000-0000-4000-8000-000000000009",
      );
      expect(schema.safeParse("not-a-uuid").success).toBe(false);
      expect(schema.safeParse("").success).toBe(false);
      expect(schema.safeParse(123 as unknown as string).success).toBe(false);
    }
  });
});

describe("opaque principal identities (Better Auth style)", () => {
  it("accepts opaque non-empty text and preserves the exact bytes", () => {
    const parsed = principalIdSchema.parse("better-auth-user-17");
    expect(parsed).toBe("better-auth-user-17");
    // No normalization: an internal (non-edge) space is preserved verbatim.
    expect(principalIdSchema.parse("org|user 42")).toBe("org|user 42");
  });

  it("rejects empty, leading/trailing whitespace, and oversized principal IDs", () => {
    expect(principalIdSchema.safeParse("").success).toBe(false);
    expect(principalIdSchema.safeParse(" leading").success).toBe(false);
    expect(principalIdSchema.safeParse("trailing ").success).toBe(false);
    expect(principalIdSchema.safeParse("\ttab-lead").success).toBe(false);
    expect(principalIdSchema.safeParse("newline-trail\n").success).toBe(false);
  });

  it("counts the 200-byte ceiling in UTF-8 bytes, not code units", () => {
    // ASCII: exactly 200 bytes passes, 201 fails.
    expect(principalIdSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(principalIdSchema.safeParse("a".repeat(201)).success).toBe(false);
    // "€" is 3 UTF-8 bytes: 66 chars = 198 bytes passes, 67 chars = 201 bytes fails.
    expect(principalIdSchema.safeParse("€".repeat(66)).success).toBe(true);
    expect(principalIdSchema.safeParse("€".repeat(67)).success).toBe(false);
  });
});

describe("sandbox identities and bounded counters", () => {
  it("bounds sandbox IDs to 1..200 characters", () => {
    expect(sandboxIdSchema.parse("sbx-1")).toBe("sbx-1");
    expect(sandboxIdSchema.safeParse("").success).toBe(false);
    expect(sandboxIdSchema.safeParse("s".repeat(200)).success).toBe(true);
    expect(sandboxIdSchema.safeParse("s".repeat(201)).success).toBe(false);
  });

  it("bounds and integer-checks attempt/sequence counters", () => {
    expect(attemptNumberSchema.parse(1_000_000)).toBe(1_000_000);
    expect(attemptNumberSchema.safeParse(1_000_001).success).toBe(false);
    expect(attemptNumberSchema.safeParse(1.5).success).toBe(false);
    expect(eventSequenceSchema.safeParse(0).success).toBe(false);
    expect(eventSequenceSchema.safeParse(2.5).success).toBe(false);
    expect(eventSequenceSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("fence token and digest boundaries", () => {
  it("enforces the base64url alphabet and 32..256 length window", () => {
    expect(fenceTokenSchema.safeParse("A".repeat(32)).success).toBe(true);
    expect(fenceTokenSchema.safeParse("A".repeat(31)).success).toBe(false);
    expect(fenceTokenSchema.safeParse("A".repeat(256)).success).toBe(true);
    expect(fenceTokenSchema.safeParse("A".repeat(257)).success).toBe(false);
    // base64url alphabet is [A-Za-z0-9_-]; "+", "/", and "=" are rejected.
    expect(fenceTokenSchema.safeParse("Az0_-".padEnd(43, "-")).success).toBe(true);
    expect(fenceTokenSchema.safeParse("+".repeat(43)).success).toBe(false);
    expect(fenceTokenSchema.safeParse("/".repeat(43)).success).toBe(false);
    expect(fenceTokenSchema.safeParse("=".repeat(43)).success).toBe(false);
  });

  it("requires a lowercase 64-hex SHA-256 digest", () => {
    expect(sha256DigestSchema.parse("a".repeat(64))).toBe("a".repeat(64));
    expect(sha256DigestSchema.safeParse("f".repeat(63)).success).toBe(false);
    expect(sha256DigestSchema.safeParse("f".repeat(65)).success).toBe(false);
    expect(sha256DigestSchema.safeParse(`${"a".repeat(63)}g`).success).toBe(false);
  });
});

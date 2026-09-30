// DEP-012 Slice 4+5 (P3) — the AM↔CP lease-truth bearer peer-auth (drizzle-free).
//
// Proves the [Img-2] fail-closed contract for the THIRD gate arm on the control-plane
// lease-truth route: an UNSET configured secret is a REJECT (never `header === env`
// falling open on two undefineds), a matching bearer passes, a wrong/absent bearer is
// rejected, and the constant-time compare NEVER throws on a length mismatch.

import { describe, expect, it } from "vitest";

import {
  TRUTH_SHARED_SECRET_ENV,
  TRUTH_SHARED_SECRET_HEADER,
  bearerMatches,
  truthBearerAccepted,
} from "../routes/adapter-manager-control-auth.js";

const SECRET = "s3cr3t-staging-bearer-value";

describe("DEP-012 P3 — lease-truth bearer peer-auth", () => {
  it("freezes the env + header names that cross the AM↔CP + compose boundary", () => {
    // These MUST match packages/adapter-manager/src/reaper-truth-client.ts.
    expect(TRUTH_SHARED_SECRET_ENV).toBe("AOA_ADAPTER_MANAGER_TRUTH_SHARED_SECRET");
    expect(TRUTH_SHARED_SECRET_HEADER).toBe("x-aoa-adapter-manager-truth");
  });

  describe("bearerMatches (constant-time over hashes)", () => {
    it("accepts an exact match", () => {
      expect(bearerMatches(SECRET, SECRET)).toBe(true);
    });
    it("rejects a wrong value", () => {
      expect(bearerMatches(SECRET, `${SECRET}-nope`)).toBe(false);
    });
    it("rejects an absent presented header", () => {
      expect(bearerMatches(SECRET, undefined)).toBe(false);
    });
    it("NEVER throws on a length mismatch (hashing first fixes timingSafeEqual's throw)", () => {
      // Different lengths: a raw timingSafeEqual would throw; the sha256 hashes are always
      // 32 bytes, so the compare is safe and simply returns false.
      expect(() => bearerMatches("short", "a-much-longer-presented-value")).not.toThrow();
      expect(bearerMatches("short", "a-much-longer-presented-value")).toBe(false);
    });
  });

  describe("truthBearerAccepted (fail-closed)", () => {
    it("★ UNSET configured secret ⇒ REJECT even with a presented header (route enabled + no bearer configured ⇒ 404)", () => {
      expect(truthBearerAccepted({}, SECRET)).toBe(false);
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: undefined }, SECRET)).toBe(false);
    });
    it("EMPTY / whitespace configured secret ⇒ REJECT (fail-closed, no fall-open)", () => {
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: "" }, "")).toBe(false);
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: "   " }, "   ")).toBe(false);
    });
    it("configured + matching presented ⇒ ACCEPT", () => {
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: SECRET }, SECRET)).toBe(true);
    });
    it("configured + wrong presented ⇒ REJECT", () => {
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: SECRET }, "wrong")).toBe(false);
    });
    it("configured + NO presented header ⇒ REJECT", () => {
      expect(truthBearerAccepted({ [TRUTH_SHARED_SECRET_ENV]: SECRET }, undefined)).toBe(false);
    });
  });
});

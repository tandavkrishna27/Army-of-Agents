import { describe, expect, it } from "vitest";
import {
  createOrganizationSchema,
  inviteToOrganizationSchema,
} from "../validators/organization.js";

describe("organization validators", () => {
  it("accepts the self-serve create payload", () => {
    const parsed = createOrganizationSchema.parse({ name: "  Acme  " });
    expect(parsed.name).toBe("Acme");
  });
  it("accepts an optional UUID request id and rejects a malformed one", () => {
    const creationRequestId = "d259a6f1-d10a-4f79-a057-d47d3ef11152";
    expect(createOrganizationSchema.parse({ name: "Acme", creationRequestId }))
      .toMatchObject({ creationRequestId });
    expect(() =>
      createOrganizationSchema.parse({ name: "Acme", creationRequestId: "not-a-uuid" }),
    ).toThrow();
  });
  it("normalizes organization names to NFC", () => {
    const parsed = createOrganizationSchema.parse({ name: "  Cafe\u0301  " });
    expect(parsed.name).toBe("Caf\u00e9");
  });
  it("rejects empty, control/bidi/invisible, and oversized names", () => {
    expect(() => createOrganizationSchema.parse({ name: "" })).toThrow();
    expect(() => createOrganizationSchema.parse({ name: "   " })).toThrow();
    for (const name of [
      "Acme\0Corp",
      "Acme\nCorp",
      "Acme\u001bCorp",
      "Acme\u202eCorp",
      "Acme\u200bCorp",
      "Acme\u2028Corp",
      "Acme\u2029Corp",
      "Acme\u2061Corp",
      "\u200C\u200D",
    ]) {
      expect(() => createOrganizationSchema.parse({ name })).toThrow();
    }
    expect(() => createOrganizationSchema.parse({ name: "a".repeat(101) })).toThrow();
  });
  it("preserves ZWNJ and ZWJ used by international scripts", () => {
    expect(createOrganizationSchema.parse({ name: "A\u200cB\u200dC" }).name).toBe("A\u200cB\u200dC");
  });
  it("rejects caller-controlled slug and plan fields", () => {
    expect(() => createOrganizationSchema.parse({ name: "Acme", slug: "acme" })).toThrow();
    expect(() => createOrganizationSchema.parse({ name: "Acme", plan: "enterprise" })).toThrow();
  });
  it("invite defaults role to member and requires a valid email", () => {
    const parsed = inviteToOrganizationSchema.parse({ email: "a@b.com" });
    expect(parsed.role).toBe("member");
    expect(() => inviteToOrganizationSchema.parse({ email: "nope" })).toThrow();
  });
  it("invite rejects a role outside owner|admin|member|billing", () => {
    expect(() =>
      inviteToOrganizationSchema.parse({ email: "a@b.com", role: "founder" }),
    ).toThrow();
  });
});

// DSK-001 / I8 — the enrollment ticket codec.
//
// The ticket is what a founder pastes into a desktop to enrol it. It carries
// `{v, targetId, code}` and NOTHING else, round-trips exactly, and rejects
// malformed input.
//
// Two properties are easy to get subtly wrong and are tested directly:
//
//   "AND NOTHING ELSE" is an EXHAUSTIVE KEY CHECK, not a destructure. A
//   destructure silently ignores extra fields, so a ticket carrying an unexpected
//   key would be accepted and its extra data would flow onward unexamined. The
//   codec compares the sorted key list for equality, which is the only shape that
//   makes "nothing else" a testable claim rather than an aspiration.
//
//   AN ERROR MESSAGE MUST NEVER ECHO THE INPUT. The ticket embeds an enrollment
//   CODE — a live bearer credential with a 10-minute TTL. A parse error that
//   interpolates what it was given puts that credential into whatever caught it:
//   a log line, an error report, a support bundle. Every rejection here names the
//   failing constraint and nothing more.

import { describe, expect, it } from "vitest";
import {
  decodeEnrollmentTicket,
  encodeEnrollmentTicket,
  ENROLLMENT_TICKET_PREFIX,
  type EnrollmentTicket,
} from "../enrollment/ticket.js";

const TARGET_ID = "a3000000-0000-4000-8000-000000000003";
const CODE = "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(43);
const TICKET: EnrollmentTicket = { v: 1, targetId: TARGET_ID, code: CODE };

describe("DSK-001/I8 — the ticket round-trips exactly", () => {
  it("decodes back to the same three fields", () => {
    expect(decodeEnrollmentTicket(encodeEnrollmentTicket(TICKET))).toEqual(TICKET);
  });

  it("carries the documented prefix", () => {
    expect(encodeEnrollmentTicket(TICKET).startsWith(ENROLLMENT_TICKET_PREFIX)).toBe(true);
  });

  it("is byte-stable — the same ticket always encodes identically", () => {
    const a = encodeEnrollmentTicket(TICKET);
    const b = encodeEnrollmentTicket({ code: CODE, targetId: TARGET_ID, v: 1 });
    expect(a).toBe(b);
  });

  it("uses base64url, so a ticket survives a URL, a shell, and a text field intact", () => {
    const body = encodeEnrollmentTicket(TICKET).slice(ENROLLMENT_TICKET_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("DSK-001/I8 — 'and NOTHING else' is exhaustive, not a destructure", () => {
  it("REJECTS a ticket carrying an extra field", () => {
    // A destructure would silently accept this and let the extra data through.
    const body = Buffer.from(
      JSON.stringify({ v: 1, targetId: TARGET_ID, code: CODE, extra: "smuggled" }),
    ).toString("base64url");
    expect(() => decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body)).toThrow();
  });

  it("REJECTS a ticket missing any of the three fields", () => {
    for (const omit of ["v", "targetId", "code"] as const) {
      const payload: Record<string, unknown> = { v: 1, targetId: TARGET_ID, code: CODE };
      delete payload[omit];
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      expect(() => decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body), omit).toThrow();
    }
  });
});

describe("DSK-001/I8 — malformed input is rejected before it is trusted", () => {
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["prefix only", ENROLLMENT_TICKET_PREFIX],
    ["wrong prefix", "aoa_enr_" + Buffer.from(JSON.stringify(TICKET)).toString("base64url")],
    ["no prefix", Buffer.from(JSON.stringify(TICKET)).toString("base64url")],
    ["not base64url", ENROLLMENT_TICKET_PREFIX + "!!!!not-base64!!!!"],
    ["base64url of non-JSON", ENROLLMENT_TICKET_PREFIX + Buffer.from("not json").toString("base64url")],
    ["JSON array", ENROLLMENT_TICKET_PREFIX + Buffer.from("[1,2,3]").toString("base64url")],
    ["JSON string", ENROLLMENT_TICKET_PREFIX + Buffer.from('"hello"').toString("base64url")],
    ["JSON null", ENROLLMENT_TICKET_PREFIX + Buffer.from("null").toString("base64url")],
  ];
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      expect(() => decodeEnrollmentTicket(input)).toThrow();
    });
  }

  it("REJECTS an oversized body BEFORE attempting to decode it", () => {
    // Never decode unbounded input: the body is length-checked first, so a
    // multi-megabyte paste costs a regex test rather than an allocation.
    const huge = ENROLLMENT_TICKET_PREFIX + "A".repeat(513);
    expect(() => decodeEnrollmentTicket(huge)).toThrow(/length|too long|bounds/i);
  });

  it("REJECTS a wrong version rather than guessing at a future format", () => {
    const body = Buffer.from(JSON.stringify({ ...TICKET, v: 2 })).toString("base64url");
    expect(() => decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body)).toThrow(/version/i);
  });

  it("REJECTS a targetId that is not a UUID", () => {
    for (const targetId of ["not-a-uuid", "", "a3000000-0000-4000-8000", 42 as unknown as string]) {
      const body = Buffer.from(JSON.stringify({ ...TICKET, targetId })).toString("base64url");
      expect(() => decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body), String(targetId)).toThrow();
    }
  });

  it("REJECTS a code that does not match the server's own shape", () => {
    // Mirrors worker-enrollment.ts:81 exactly. Rejecting client-side turns a
    // 10-minute round trip and a consumed code into an instant, local error.
    for (const code of [
      "aoa_enr_short.BBBB",
      "wrong_prefix_" + "A".repeat(22) + "." + "B".repeat(43),
      "aoa_enr_" + "A".repeat(22),
      "aoa_enr_" + "A".repeat(65) + "." + "B".repeat(43),
      "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(129),
      "aoa_enr_" + "A".repeat(22) + "." + "B".repeat(43) + ".extra",
    ]) {
      const body = Buffer.from(JSON.stringify({ ...TICKET, code })).toString("base64url");
      expect(() => decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body), code.slice(0, 24)).toThrow();
    }
  });
});

describe("DSK-001/I8 + I13 — a rejection never echoes the input", () => {
  it("never puts the enrollment code into an error message", () => {
    // The ticket embeds a live bearer credential. An error that interpolates its
    // input hands that credential to whatever catches it.
    const secretish = "aoa_enr_" + "S".repeat(22) + "." + "T".repeat(43);
    const bodies = [
      JSON.stringify({ v: 2, targetId: TARGET_ID, code: secretish }),
      JSON.stringify({ v: 1, targetId: "not-a-uuid", code: secretish }),
      JSON.stringify({ v: 1, targetId: TARGET_ID, code: secretish, extra: 1 }),
    ];
    for (const body of bodies) {
      const ticket = ENROLLMENT_TICKET_PREFIX + Buffer.from(body).toString("base64url");
      try {
        decodeEnrollmentTicket(ticket);
        throw new Error("expected a rejection");
      } catch (err) {
        const text = `${(err as Error).message} ${(err as Error).stack ?? ""}`;
        expect(text).not.toContain(secretish);
        expect(text).not.toContain("S".repeat(22));
        expect(text).not.toContain("T".repeat(43));
        expect(text).not.toContain(ticket);
      }
    }
  });

  it("names the failing constraint, so the error is still actionable", () => {
    const body = Buffer.from(JSON.stringify({ ...TICKET, v: 9 })).toString("base64url");
    try {
      decodeEnrollmentTicket(ENROLLMENT_TICKET_PREFIX + body);
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain("version");
    }
  });
});

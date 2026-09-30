// DSK-001 — the entry guard's redaction.
//
// The daemon's entry guard ends in `console.error(err.stack)`, which is the one
// path in the process that bypasses the logger's redactor. This host is the one
// holding an enrollment ticket, so that path is where a credential would print
// if any error between reading the ticket and enrolling ever carried it.
//
// Nothing interpolates the credential today. This exists so that "the credential
// cannot print" does not depend on every future error message remembering not to
// include it.

import { describe, expect, it } from "vitest";
import { redactEnrollmentCodes } from "../bin/aoa-worker-desktop.js";

const CODE = "aoa_enr_abcdefgh12345678.0123456789abcdef0123456789abcdef";

describe("DSK-001/I13 — the entry guard cannot print an enrollment code", () => {
  it("masks a credential embedded in a stack trace", () => {
    const stack = [
      "Error: control plane rejected the ticket",
      `    at enrollOnce (file:///app/enroll-once.js:42:11) ${CODE}`,
      "    at bootstrapWorkerDaemon (file:///app/worker-daemon.js:180:5)",
    ].join("\n");
    const out = redactEnrollmentCodes(stack);
    expect(out).not.toContain(CODE);
    expect(out).toContain("aoa_enr_[redacted]");
    // The rest of the diagnostic must survive, or an operator is left with
    // nothing and reaches for --reset-identity.
    expect(out).toContain("control plane rejected the ticket");
    expect(out).toContain("worker-daemon.js:180:5");
  });

  it("masks EVERY occurrence, not just the first", () => {
    const out = redactEnrollmentCodes(`${CODE} and again ${CODE}`);
    expect(out).not.toContain(CODE);
    expect(out.match(/aoa_enr_\[redacted\]/g)).toHaveLength(2);
  });

  it("leaves text with no credential untouched", () => {
    const plain = "Error: ENOENT: no such file or directory, open '/run/secrets/ticket'";
    expect(redactEnrollmentCodes(plain)).toBe(plain);
  });

  it("does not mask a workerId or targetId, which are opaque ids the logs keep", () => {
    const ids = "workerId=3f2504e0-4f89-41d3-9a0c-0305e82c3301 targetId=a3000000-0000-4000-8000-000000000003";
    expect(redactEnrollmentCodes(ids)).toBe(ids);
  });

  it("matches the credential SHAPE, so a near-miss is not silently trusted", () => {
    // Too short to be a real code: it must not match, because a pattern that
    // matched anything starting `aoa_enr_` would mask ordinary diagnostics and
    // hide what an operator needs.
    const nearMiss = "aoa_enr_short.tiny";
    expect(redactEnrollmentCodes(nearMiss)).toBe(nearMiss);
  });
});

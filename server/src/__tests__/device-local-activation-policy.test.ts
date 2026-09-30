// DSK-002 Lane D / I10 + I11 — the device-local activation POLICY.
//
// DSK-001 Lane B left this bound explicitly unenforced and named this ticket:
//
//   "D10 specifies `expiresAt <= the lease deadline`. NOTHING ENFORCES THAT BOUND
//    TODAY … no lease deadline reaches this layer … an explicit deferral to DSK-002."
//
// It was safe only because `failClosedDeviceLocalBroker` throws, so no activation could
// be minted at all. The moment anything mints one, an unbounded activation exists.
//
// D7 — a non-materializing activation is preferred, because destruction is only as good
// as what is left behind:
//
//   proxy_endpoint  a loopback endpoint the broker owns   → process death IS destruction
//   env_name        a value in a child's environment      → dies with the child
//   file_path       BYTES ON DISK                         → a kill -9 orphans them
//
// The policy is pure: no clock of its own, no fs, no OS. That is what makes the ranking
// and the clamp testable at all, and it is the same shape as Lane A's binding.

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_REFERENCE_PREFERENCE,
  clampActivationExpiry,
  preferredReferenceKind,
} from "../services/device-local-activation-policy.js";

const LEASE_DEADLINE = 1_000_000;

describe("DSK-002/I10 — an activation may never outlive its lease", () => {
  it("clamps a TTL that would run past the lease deadline", () => {
    const result = clampActivationExpiry({
      nowMs: LEASE_DEADLINE - 1_000,
      requestedTtlMs: 60_000, // would end at deadline + 59s
      leaseExpiresAtMs: LEASE_DEADLINE,
    });
    expect(result).toEqual({ ok: true, expiresAtMs: LEASE_DEADLINE });
  });

  it("keeps a TTL that ends before the deadline", () => {
    // Non-vacuity: the clamp is not simply "always return the deadline".
    const result = clampActivationExpiry({
      nowMs: LEASE_DEADLINE - 60_000,
      requestedTtlMs: 10_000,
      leaseExpiresAtMs: LEASE_DEADLINE,
    });
    expect(result).toEqual({ ok: true, expiresAtMs: LEASE_DEADLINE - 50_000 });
  });

  it("refuses to mint at or past the deadline", () => {
    // Not "mint a zero-length activation" — refuse. A zero-length activation is still an
    // activation, and something downstream would have to remember to treat it as dead.
    for (const nowMs of [LEASE_DEADLINE, LEASE_DEADLINE + 1]) {
      expect(clampActivationExpiry({ nowMs, requestedTtlMs: 1_000, leaseExpiresAtMs: LEASE_DEADLINE }))
        .toEqual({ ok: false, reason: "lease_expired" });
    }
  });

  it("refuses a non-positive TTL rather than minting something already dead", () => {
    for (const requestedTtlMs of [0, -1]) {
      expect(clampActivationExpiry({ nowMs: 0, requestedTtlMs, leaseExpiresAtMs: LEASE_DEADLINE }))
        .toEqual({ ok: false, reason: "invalid_ttl" });
    }
  });

  it("refuses a missing lease deadline instead of treating it as unbounded", () => {
    // The failure mode DSK-001 warned about: no deadline reaches this layer today, so an
    // implementation that read `undefined` as "no limit" would mint a forever-activation.
    expect(clampActivationExpiry({ nowMs: 0, requestedTtlMs: 1_000, leaseExpiresAtMs: undefined }))
      .toEqual({ ok: false, reason: "no_lease_deadline" });
    expect(clampActivationExpiry({ nowMs: 0, requestedTtlMs: 1_000, leaseExpiresAtMs: Number.NaN }))
      .toEqual({ ok: false, reason: "no_lease_deadline" });
  });
});

describe("DSK-002/I11 — proxy_endpoint is preferred, file_path is last resort", () => {
  it("ranks proxy_endpoint above env_name above file_path", () => {
    expect(ACTIVATION_REFERENCE_PREFERENCE).toEqual(["proxy_endpoint", "env_name", "file_path"]);
  });

  it("picks proxy_endpoint whenever the consumer supports it", () => {
    expect(preferredReferenceKind(["file_path", "env_name", "proxy_endpoint"])).toBe("proxy_endpoint");
    expect(preferredReferenceKind(["proxy_endpoint"])).toBe("proxy_endpoint");
  });

  it("falls back in order, never skipping to the worst option", () => {
    expect(preferredReferenceKind(["file_path", "env_name"])).toBe("env_name");
    expect(preferredReferenceKind(["file_path"])).toBe("file_path");
  });

  it("returns null when the consumer supports nothing we offer", () => {
    // Fail closed: an unknown reference kind is not a reason to guess.
    expect(preferredReferenceKind([])).toBeNull();
    expect(preferredReferenceKind(["something_else" as never])).toBeNull();
  });

  it("ignores order and duplicates in the caller's list", () => {
    // The CALLER's ordering is not a preference — ours is. A consumer listing file_path
    // first must not thereby get bytes on disk.
    expect(preferredReferenceKind(["file_path", "file_path", "proxy_endpoint", "env_name"]))
      .toBe("proxy_endpoint");
  });
});

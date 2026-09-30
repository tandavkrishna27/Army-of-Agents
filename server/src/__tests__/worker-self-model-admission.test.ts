// WRK-008 slice 1 — admission for a worker reading its OWN self-model.
//
// Pure decision function, so every guard is directly unit- and mutation-testable
// without a route, a session or a database.
//
// The self-model (registered target profile + provider-constraint profile) is the
// artefact that lets a worker lease and execute tenant work. Each refusal below is
// therefore the fail-closed direction of a real question, not defensive noise.

import { describe, expect, it } from "vitest";
import {
  admitSelfModelRead,
  selfModelRefusalWireCode,
  type SelfModelReadInput,
  type SelfModelReadRefusal,
} from "../services/worker-self-model-admission.js";

type ExecutionSecretMintRefusalLike = SelfModelReadRefusal;

function input(overrides: Partial<SelfModelReadInput> = {}): SelfModelReadInput {
  return {
    authorityKind: "session",
    principalTargetGeneration: 7,
    profileDeviceGeneration: 7,
    revokedAt: null,
    targetStatus: "active",
    hasRegisteredProfile: true,
    hasProviderConstraintProfile: true,
    ...overrides,
  };
}

describe("admitSelfModelRead — admission", () => {
  it("admits a current, unrevoked session whose generation matches", () => {
    expect(admitSelfModelRead(input())).toEqual({ admit: true });
  });
});

describe("admitSelfModelRead — the legacy credential is refused (design 4.1)", () => {
  it("refuses a legacy worker token even though the middleware accepts one", () => {
    // requireWorkerHeartbeatAuthority admits BOTH a legacy bearer token and the
    // device-proof-bound session. The self-model must not be reachable by the
    // weaker of the two merely because the shared middleware tolerates it.
    expect(admitSelfModelRead(input({ authorityKind: "legacy" })))
      .toEqual({ admit: false, reason: "legacy_authority_refused" });
  });

  it("refuses legacy FIRST, before any other property is consulted", () => {
    // Everything else is simultaneously wrong; the credential reason must still win,
    // so a weak credential is never reported as a generation or revocation problem.
    expect(admitSelfModelRead(input({
      authorityKind: "legacy",
      principalTargetGeneration: 1,
      profileDeviceGeneration: 9,
      revokedAt: "2026-01-01T00:00:00.000Z",
      hasRegisteredProfile: false,
      hasProviderConstraintProfile: false,
    }))).toEqual({ admit: false, reason: "legacy_authority_refused" });
  });
});

describe("admitSelfModelRead — generation staleness (design 4.2)", () => {
  it("refuses a session whose proven generation is BEHIND the target's", () => {
    // The session predates a device-generation bump: the worker is asking for a
    // self-model it is no longer entitled to act on.
    expect(admitSelfModelRead(input({ principalTargetGeneration: 6, profileDeviceGeneration: 7 })))
      .toEqual({ admit: false, reason: "generation_stale" });
  });

  it("refuses a session whose generation is AHEAD of the target's", () => {
    // Should be impossible. If it happens, one of the two authorities is wrong and
    // neither may be trusted to authorize handing over a self-model.
    expect(admitSelfModelRead(input({ principalTargetGeneration: 8, profileDeviceGeneration: 7 })))
      .toEqual({ admit: false, reason: "generation_stale" });
  });

  it("refuses when either generation is absent rather than treating it as a match", () => {
    expect(admitSelfModelRead(input({ profileDeviceGeneration: null })))
      .toEqual({ admit: false, reason: "generation_stale" });
    expect(admitSelfModelRead(input({ principalTargetGeneration: null })))
      .toEqual({ admit: false, reason: "generation_stale" });
  });
});

describe("admitSelfModelRead — revocation (design 4.3)", () => {
  it("serves nothing for a revoked target", () => {
    // The self-model is exactly the artefact a revoked worker needs to start leasing.
    expect(admitSelfModelRead(input({ revokedAt: "2026-08-01T00:00:00.000Z" })))
      .toEqual({ admit: false, reason: "target_revoked" });
  });

  it("checks revocation even when the generation matches perfectly", () => {
    expect(admitSelfModelRead(input({
      revokedAt: "2026-08-01T00:00:00.000Z",
      principalTargetGeneration: 3,
      profileDeviceGeneration: 3,
    }))).toEqual({ admit: false, reason: "target_revoked" });
  });
});

describe("admitSelfModelRead — target status", () => {
  it("refuses a DISABLED target - the operator said do not use it", () => {
    expect(admitSelfModelRead(input({ targetStatus: "disabled" })))
      .toEqual({ admit: false, reason: "target_disabled" });
  });

  it("still serves a DRAINING target", () => {
    // Drain means "take no NEW work" and that is the poll response's job. Withholding
    // the self-model would break the drain semantics of a worker legitimately
    // finishing in-flight work.
    expect(admitSelfModelRead(input({ targetStatus: "draining" }))).toEqual({ admit: true });
  });

  it("still serves an OFFLINE target", () => {
    // Offline is a LIVENESS observation, not an authorization one. Refusing would turn
    // a transient outage into a permanent one by denying the worker its recovery path.
    expect(admitSelfModelRead(input({ targetStatus: "offline" }))).toEqual({ admit: true });
  });

  it("reports revocation ahead of disablement", () => {
    expect(admitSelfModelRead(input({ targetStatus: "disabled", revokedAt: "2026-08-01T00:00:00.000Z" })))
      .toEqual({ admit: false, reason: "target_revoked" });
  });
});

describe("admitSelfModelRead — absent profile (design 5)", () => {
  it.each([
    ["registered profile", { hasRegisteredProfile: false }],
    ["provider-constraint profile", { hasProviderConstraintProfile: false }],
    ["both", { hasRegisteredProfile: false, hasProviderConstraintProfile: false }],
  ])("refuses when the %s was never set by an operator", (_label, overrides) => {
    // Enrolment alone does not produce a dispatchable worker: PUT .../placement-profile
    // is admin-guarded and is the only writer. This is a product state, not a fault.
    expect(admitSelfModelRead(input(overrides)))
      .toEqual({ admit: false, reason: "profile_absent" });
  });

  it("reports revocation ahead of absence, so a revoked target is never reported as unconfigured", () => {
    expect(admitSelfModelRead(input({
      revokedAt: "2026-08-01T00:00:00.000Z",
      hasRegisteredProfile: false,
    }))).toEqual({ admit: false, reason: "target_revoked" });
  });
});

describe("selfModelRefusalWireCode — the retryable/terminal branch", () => {
  it("makes an unconfigured target RETRYABLE, because an operator simply has not acted yet", () => {
    // `unauthorized` is non-retryable on the wire (only throttled/internal_unavailable
    // may carry retryAfterMs). Collapsing this into it told a freshly-enrolled worker
    // "stop forever" for a state that resolves by itself when an operator configures it.
    expect(selfModelRefusalWireCode("profile_absent")).toBe("internal_unavailable");
  });

  it.each([
    "legacy_authority_refused",
    "generation_stale",
    "target_revoked",
    "target_disabled",
  ] as const)("keeps %s terminal — a human must resolve it", (reason) => {
    expect(selfModelRefusalWireCode(reason)).toBe("unauthorized");
  });

  it("covers every refusal in the union, so a new one cannot default to retryable", () => {
    const ALL: ExecutionSecretMintRefusalLike[] = [
      "legacy_authority_refused", "generation_stale", "target_revoked",
      "target_disabled", "profile_absent",
    ];
    expect(ALL.filter((r) => selfModelRefusalWireCode(r) === "internal_unavailable"))
      .toEqual(["profile_absent"]);
  });
});

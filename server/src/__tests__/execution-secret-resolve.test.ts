// DAT-008 slice 4 — the two load-bearing refusals on the sandbox-local resolve channel.
//
// Both are enforced at the TRANSPORT, not only at mint, so the tests must present
// outcomes the broker would genuinely have produced. A test that refuses a handle which
// would have failed anyway proves nothing.

import { describe, expect, it } from "vitest";
import {
  admitSandboxLocalResolution,
  EXECUTION_SECRET_RESOLVE_DESCRIPTOR,
} from "../services/execution-secret-resolve.js";
import type { SecretResolveOutcome } from "../services/secret-broker.js";

const resolved = (over: Partial<{
  seam: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only";
  materialization: "proxy" | "env" | "file";
  materializationTarget: string | null;
  destination: string | null;
  value: string;
}> = {}): SecretResolveOutcome => ({
  outcome: "resolved",
  seam: over.seam ?? "sandbox_local_only",
  material: {
    value: over.value ?? "sk-live-secret",
    materialization: over.materialization ?? "env",
    materializationTarget: over.materializationTarget === undefined
      ? "ANTHROPIC_API_KEY"
      : over.materializationTarget,
    destination: over.destination ?? null,
  },
});

describe("EXECUTION_SECRET_RESOLVE_DESCRIPTOR", () => {
  it("pins the fence-bearing audience, not the poll audience", () => {
    // A worker_poll session must never redeem a secret, and
    // verifyWorkerOperationProof checks only the session's organization and scope.
    expect(EXECUTION_SECRET_RESOLVE_DESCRIPTOR.audience).toBe("worker_run");
  });

  it("carries the ceilings a frozen descriptor would have supplied", () => {
    expect(EXECUTION_SECRET_RESOLVE_DESCRIPTOR.maxRequestBytes).toBeGreaterThan(0);
    expect(EXECUTION_SECRET_RESOLVE_DESCRIPTOR.timeoutMs).toBeGreaterThan(0);
  });
});

describe("admitSandboxLocalResolution — admission", () => {
  it("returns the value and its declared env target for a sandbox-local env handle", () => {
    expect(admitSandboxLocalResolution(resolved())).toEqual({
      outcome: "resolved",
      envTarget: "ANTHROPIC_API_KEY",
      value: "sk-live-secret",
    });
  });
});

describe("admitSandboxLocalResolution — refusal 1, the credential-class boundary", () => {
  it("refuses a fence_proxy handle the broker RESOLVED SUCCESSFULLY", () => {
    // The anti-vacuity point: this outcome is a full success carrying a real value.
    // The refusal must come from the class check, not from a failure elsewhere.
    const outcome = resolved({ seam: "fence_proxy", materialization: "proxy", destination: "https://api.notion.com:443" });
    expect(outcome.outcome).toBe("resolved");
    expect(admitSandboxLocalResolution(outcome)).toEqual({ outcome: "denied", reason: "malformed" });
  });

  it("refuses remote_server_fenced even with an env materialization", () => {
    expect(admitSandboxLocalResolution(resolved({ seam: "remote_server_fenced" })))
      .toEqual({ outcome: "denied", reason: "malformed" });
  });

  it("refuses a file materialization on this channel", () => {
    expect(admitSandboxLocalResolution(resolved({ materialization: "file", materializationTarget: "/run/aoa/secrets/k" })))
      .toEqual({ outcome: "denied", reason: "malformed" });
  });

  it("refuses a sandbox-local handle that somehow carries a network destination", () => {
    expect(admitSandboxLocalResolution(resolved({ destination: "https://api.anthropic.com:443" })))
      .toEqual({ outcome: "denied", reason: "malformed" });
  });
});

describe("admitSandboxLocalResolution — refusal 2, device_local is not an empty value", () => {
  it("refuses a device_handoff rather than coercing it to an empty credential", () => {
    const handoff: SecretResolveOutcome = {
      outcome: "device_handoff",
      handoff: {
        refKind: "device_local",
        refId: "cred-1",
        ownerPrincipalKind: "user",
        ownerPrincipalId: "user-1",
        materialization: "env",
        usePolicy: "sandbox_local_only",
        companyId: "co-1",
        handleId: "h-1",
        boundTargetGeneration: 1,
        destination: null,
      },
    };
    expect(admitSandboxLocalResolution(handoff)).toEqual({ outcome: "denied", reason: "malformed" });
  });
});

describe("admitSandboxLocalResolution — target integrity", () => {
  it.each([
    ["null", null],
    ["empty", ""],
  ])("refuses when the env target is %s rather than guessing one", (_label, target) => {
    expect(admitSandboxLocalResolution(resolved({ materializationTarget: target })))
      .toEqual({ outcome: "denied", reason: "malformed" });
  });
});

describe("admitSandboxLocalResolution — fence denials pass through verbatim", () => {
  it.each(["stale_fence", "attempt_terminal", "target_revoked", "malformed"] as const)(
    "preserves the %s reason without widening or renaming it",
    (reason) => {
      expect(admitSandboxLocalResolution({ outcome: "denied", reason }))
        .toEqual({ outcome: "denied", reason });
    },
  );
});

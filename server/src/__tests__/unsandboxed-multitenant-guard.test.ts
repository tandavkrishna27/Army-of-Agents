import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard imports the app logger; stub it so importing the module has no side
// effects. The tests inject their own `log`, so this stub is belt-and-suspenders.
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn() }) },
}));

import {
  assertUnsandboxedMultitenantAllowed,
  isUnsandboxedLocalTarget,
  resetUnsandboxedMultitenantWarning,
  UNSANDBOXED_MULTITENANT_OPT_IN_ENV,
} from "../services/unsandboxed-multitenant-guard.js";

describe("assertUnsandboxedMultitenantAllowed (D1)", () => {
  beforeEach(() => resetUnsandboxedMultitenantWarning());

  const local = { type: "local" as const };
  // Runtime-less docker resolves to runc (shared host kernel + default bridge
  // egress) — NOT genuine per-tenant isolation on cloud_auth without a gVisor pool.
  const dockerSandbox = { type: "sandbox-docker" as const, image: "node:22" };
  const dockerSandboxRunc = { type: "sandbox-docker" as const, image: "node:22", runtime: "runc" as const };
  // A runtime string alone does not prove that a validated gVisor worker exists.
  const dockerSandboxRunsc = { type: "sandbox-docker" as const, image: "node:22", runtime: "runsc" as const };
  const providerSandbox = {
    type: "provider-sandbox" as const,
    provider: "modal",
    providerLeaseId: "lease-1",
    remoteCwd: "/workspace",
    shell: "sh" as const,
    env: {},
    runner: { execute: async () => ({}) } as any,
  };
  const noEnv: NodeJS.ProcessEnv = {};
  const optedIn: NodeJS.ProcessEnv = { [UNSANDBOXED_MULTITENANT_OPT_IN_ENV]: "1" };

  it("throws on cloud_auth (isolation enforced) + local target + no opt-in", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).toThrow(/org agent/);
  });

  it("throws on cloud_auth + null/undefined target (treated as local) + no opt-in", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed(null, { tenantIsolationEnforced: true, sink: "crew agent", env: noEnv }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(undefined, { tenantIsolationEnforced: true, sink: "Commander", env: noEnv }),
    ).toThrow();
  });

  it("allows (no throw) and warns ONCE on cloud_auth + local + opt-in", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: optedIn, log }),
    ).not.toThrow();
    // second call in the same process must NOT warn again
    assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: true, sink: "org agent", env: optedIn, log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][1]).toContain(UNSANDBOXED_MULTITENANT_OPT_IN_ENV);
  });

  it("throws on cloud_auth + non-gVisor docker target (runc / runtime-less) + no opt-in", () => {
    // A tenant-authored sandbox-docker that resolves to runc (or unset runtime)
    // shares the host kernel + default bridge egress → reachable weaker-than-promised
    // isolation on cloud_auth without a gVisor pool. Fail closed exactly like `local`.
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandbox, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandboxRunc, { tenantIsolationEnforced: true, sink: "crew agent", env: noEnv }),
    ).toThrow(/crew agent/);
  });

  it("allows a non-gVisor docker target on cloud_auth when opted in (warns once)", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandbox, { tenantIsolationEnforced: true, sink: "org agent", env: optedIn, log }),
    ).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when tenant isolation is NOT enforced (self-hosted local_trusted / authenticated)", () => {
    const log = { warn: vi.fn() };
    // A plain self-hosted install...
    expect(() =>
      assertUnsandboxedMultitenantAllowed(local, { tenantIsolationEnforced: false, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    // ...and an `authenticated` self-host (multi_tenant boundary but NOT cloud_auth):
    // still allowed — this is the whole point of gating on cloud_auth, not trustBoundary.
    expect(() =>
      assertUnsandboxedMultitenantAllowed(null, { tenantIsolationEnforced: false, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    // ...and a runc docker target on a self-host is likewise never refused.
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandbox, { tenantIsolationEnforced: false, sink: "crew agent", env: noEnv, log }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("refuses a claimed runsc Docker target but allows provider-sandbox on cloud_auth", () => {
    const log = { warn: vi.fn() };
    expect(() =>
      assertUnsandboxedMultitenantAllowed(dockerSandboxRunsc, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv, log }),
    ).toThrow(/runtime name is not proof/);
    expect(() =>
      assertUnsandboxedMultitenantAllowed(providerSandbox, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv, log }),
    ).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("permits the provider-sandbox target for the crew + Commander sinks too (all three run types flip, not only org)", () => {
    // The org-agent case is covered by the runsc test above; pin crew + Commander
    // here so the three-way D1 flip is anchored in the guard's canonical suite.
    // Commander (W7.5d/W7.5f) is the third run sink passing a resolved
    // provider-sandbox target — it must be permitted exactly like org/crew.
    const log = { warn: vi.fn() };
    for (const sink of ["crew agent", "Commander"]) {
      expect(() =>
        assertUnsandboxedMultitenantAllowed(providerSandbox, { tenantIsolationEnforced: true, sink, env: noEnv, log }),
      ).not.toThrow();
    }
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("permits a future tenant-operated isolated runner on cloud_auth (Scenario 2 seam — closed refuse-enumeration)", () => {
    // Not local, not a docker-family type → must be allowed, so adding Scenario 2
    // later is a NEW target category, not a carve-out of `local`. This locks that
    // the guard never inverts to an allow-list of only provider-sandbox.
    const remoteRunner = { type: "remote-tenant-runner" } as never;
    expect(() =>
      assertUnsandboxedMultitenantAllowed(remoteRunner, { tenantIsolationEnforced: true, sink: "org agent", env: noEnv }),
    ).not.toThrow();
  });

  it("tenant workspace-command sink STILL refuses a local target on cloud_auth (U6 owns host-orchestration git; the commander branch must not neutralize it)", () => {
    // The untouched tenant shell-command guards must keep failing closed — the
    // commander additions (W7.5a-f) added a new run sink, they did not weaken the
    // workspace-command refusal.
    expect(() =>
      assertUnsandboxedMultitenantAllowed({ type: "local" }, {
        tenantIsolationEnforced: true,
        sink: "workspace command configuration",
        env: noEnv,
      }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
  });

  it("isUnsandboxedLocalTarget classifies targets", () => {
    expect(isUnsandboxedLocalTarget(local)).toBe(true);
    expect(isUnsandboxedLocalTarget(null)).toBe(true);
    expect(isUnsandboxedLocalTarget(undefined)).toBe(true);
    expect(isUnsandboxedLocalTarget(dockerSandbox)).toBe(false);
    expect(isUnsandboxedLocalTarget(providerSandbox)).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard imports the app logger; stub it so importing the module has no side
// effects (mirrors unsandboxed-multitenant-guard.test.ts).
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn() }) },
}));

import {
  assertUnsandboxedMultitenantAllowed,
  resetUnsandboxedMultitenantWarning,
} from "../services/unsandboxed-multitenant-guard.js";
import { RESERVED_TENANT_RUNNER_DRIVER } from "../services/cloud-environment-policy.js";
import type { AdapterExecutionTarget } from "@armyofagents/adapter-utils";

// The resolved Commander sandbox target (W7.5d Task 3a) — exactly the shape the
// D1 guard sees once cli-mode's acquire resolves an E2B lease. `provider` is the
// INFRA provider (e2b), not the model family.
const commanderE2b: AdapterExecutionTarget = {
  type: "provider-sandbox",
  provider: "e2b",
  providerLeaseId: "e2b-1",
  remoteCwd: "/workspace",
  shell: "sh",
  env: {},
  runner: { execute: async () => ({}) } as never,
} as AdapterExecutionTarget;

const cloud = { tenantIsolationEnforced: true, env: {} as NodeJS.ProcessEnv };

describe("commander guard extensibility (mirrors U8.3)", () => {
  beforeEach(() => resetUnsandboxedMultitenantWarning());

  it("a resolved commander provider-sandbox target passes the guard on cloud_auth", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed(commanderE2b, { ...cloud, sink: "Commander" }),
    ).not.toThrow();
  });

  it("a commander LOCAL target still refuses on cloud_auth (no platform default = no silent host fallback)", () => {
    expect(() =>
      assertUnsandboxedMultitenantAllowed({ type: "local" }, { ...cloud, sink: "Commander" }),
    ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
  });

  it("the Scenario-2 seam is intact: a future remote-tenant-runner target is permitted by construction", () => {
    // Not local, not docker-family → the closed refuse-enumeration permits it,
    // so a future tenant-operated isolated runner is an ALLOWED target category,
    // never a carve-out of `local`.
    expect(() =>
      assertUnsandboxedMultitenantAllowed(
        { type: "remote-tenant-runner" } as unknown as AdapterExecutionTarget,
        { ...cloud, sink: "Commander" },
      ),
    ).not.toThrow();
    // The cloud-policy reserves the driver name for that future category.
    expect(RESERVED_TENANT_RUNNER_DRIVER).toBe("remote-runner");
  });
});

/**
 * U6.1 — host-orchestration git guard sink.
 *
 * All host-side workspace git flows through `assertLocalWorkspaceCommandAllowed`,
 * which refuses on cloud_auth (it hardcodes a `{type:"local"}` D1 execution
 * target). This is correct for tenant-controlled workspace commands, but wrong
 * for AoA-authored git run against a host clone (clone/diff-base/commit/push) —
 * that is host-controlled AoA code, not tenant model output executing in an
 * unsandboxed context, so it should be permitted on cloud (spec §9
 * blast-radius reframe). `assertHostOrchestrationGitAllowed` is the distinct
 * sink for that path; `assertLocalWorkspaceCommandAllowed` must stay refused,
 * byte-for-byte, on cloud.
 *
 * Deployment-mode mock pattern mirrors `adapter-probe-cloud-guard.test.ts`:
 * `setDeploymentMode` is real exported mutable module state (not a vi.mock),
 * and `tenantIsolationEnforced()` reads it directly (`deployment-mode.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../services/unsandboxed-multitenant-guard.js";
import {
  assertHostOrchestrationGitAllowed,
  assertLocalWorkspaceCommandAllowed,
} from "../services/local-workspace-command-guard.js";

let savedOptIn: string | undefined;

beforeEach(() => {
  // The opt-in env would turn the tenant-command refusal into a no-op too;
  // ensure it is absent so the divergence being tested is the carve-out
  // itself, not the operator override.
  savedOptIn = process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
});

afterEach(() => {
  setDeploymentMode("local_trusted"); // module default; do not leak cloud_auth
  if (savedOptIn === undefined) delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  else process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV] = savedOptIn;
});

describe("assertHostOrchestrationGitAllowed vs assertLocalWorkspaceCommandAllowed (U6.1)", () => {
  it("on cloud_auth: permits host-orchestration git but refuses tenant workspace commands", () => {
    setDeploymentMode("cloud_auth");

    expect(() => assertHostOrchestrationGitAllowed("org clone")).not.toThrow();
    expect(() => assertLocalWorkspaceCommandAllowed("tenant workspace Git command")).toThrow(
      /without genuine per-tenant isolation/,
    );
  });

  it("on desktop (local_trusted, tenant isolation not enforced): both are permitted, unchanged", () => {
    setDeploymentMode("local_trusted");

    expect(() => assertHostOrchestrationGitAllowed("org clone")).not.toThrow();
    expect(() => assertLocalWorkspaceCommandAllowed("tenant workspace Git command")).not.toThrow();
  });
});

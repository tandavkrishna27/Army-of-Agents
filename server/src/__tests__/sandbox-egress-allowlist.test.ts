/**
 * S4 (U6.2) — sandbox provider create/resume path accepts an optional
 * `egressAllowlist?: string[]` and records it verbatim in the returned
 * `SandboxProviderLease.metadata`. Best-effort only: the spec said "managed
 * E2B egress is not fully lockable" (§11/§12) — a CAPABILITY claim that the
 * installed e2b SDK refutes, see E8-F007; what is actually true, and what
 * this test pins, is that the value crosses as `metadata` and is enforced by
 * nothing (E8-F003 measured that). So the provider records the allowlist
 * for later reference but must never throw when it cannot enforce it. When
 * no allowlist is supplied the key stays absent (not defaulted to `[]`) so
 * the pre-existing exact-shape lease-metadata assertions elsewhere in
 * sandbox-provider-runtime.test.ts are unaffected.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createE2bSandboxRuntimeProvider,
  createFakeSandboxRuntimeProvider,
} from "../services/sandbox-provider-runtime.js";

describe("sandbox provider egress allowlist (S4, U6.2)", () => {
  describe("fake provider", () => {
    it("records the egress allowlist verbatim in lease metadata when provided", async () => {
      const provider = createFakeSandboxRuntimeProvider();

      const lease = await provider.acquireLease({
        companyId: "company-1",
        environmentId: "env-1",
        issueId: null,
        heartbeatRunId: "run-1",
        config: { remoteCwd: "/workspace" },
        workspaceMode: "per_task",
        egressAllowlist: ["api.github.com", "registry.npmjs.org"],
      });

      expect(lease.metadata.egressAllowlist).toEqual(["api.github.com", "registry.npmjs.org"]);
    });

    it("leaves the key absent (not thrown, not defaulted) when no allowlist is supplied", async () => {
      const provider = createFakeSandboxRuntimeProvider();

      const lease = await provider.acquireLease({
        companyId: "company-1",
        environmentId: "env-1",
        issueId: null,
        heartbeatRunId: "run-2",
        config: { remoteCwd: "/workspace" },
        workspaceMode: "per_task",
      });

      expect(lease.metadata.egressAllowlist).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(lease.metadata, "egressAllowlist")).toBe(false);
    });
  });

  describe("e2b provider", () => {
    function makeSandbox() {
      const commandsRun = vi.fn(async (command: string) => ({
        exitCode: 0,
        stdout: command === "pwd" ? "/home/user\n" : "",
        stderr: "",
      }));
      return {
        sandboxId: "e2b-sandbox-1",
        sandboxDomain: "sandbox.example",
        commands: { run: commandsRun },
        setTimeout: vi.fn(async () => undefined),
        kill: vi.fn(async () => undefined),
      };
    }

    it("records the allowlist verbatim in lease metadata and best-effort-passes it to Sandbox.create, without throwing", async () => {
      const sandbox = makeSandbox();
      const create = vi.fn(async () => sandbox);
      const provider = createE2bSandboxRuntimeProvider({
        importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
        env: { E2B_API_KEY: "key-from-env" },
      });

      const lease = await provider.acquireLease({
        companyId: "company-1",
        environmentId: "env-1",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
        config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true },
        workspaceMode: "per_task",
        egressAllowlist: ["api.github.com", "registry.npmjs.org"],
      });

      expect(lease.metadata.egressAllowlist).toEqual(["api.github.com", "registry.npmjs.org"]);
      // Best-effort managed recording only — the spec's "managed E2B egress is
      // not fully lockable" (§11/§12) is REFUTED as a capability claim, E8-F007;
      // this asserts only the shape that ships today: passed through
      // Sandbox.create metadata, never used to gate/throw on acquisition.
      expect(create).toHaveBeenCalledWith(
        "base",
        expect.objectContaining({
          metadata: expect.objectContaining({
            egressAllowlist: "api.github.com,registry.npmjs.org",
          }),
        }),
      );
    });

    it("does not throw and omits the Sandbox.create metadata key when no allowlist is supplied", async () => {
      const sandbox = makeSandbox();
      const create = vi.fn(async () => sandbox);
      const provider = createE2bSandboxRuntimeProvider({
        importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
        env: { E2B_API_KEY: "key-from-env" },
      });

      const lease = await provider.acquireLease({
        companyId: "company-1",
        environmentId: "env-1",
        issueId: null,
        heartbeatRunId: "run-2",
        config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true },
        workspaceMode: null,
      });

      expect(lease.providerLeaseId).toBe("e2b-sandbox-1");
      expect(lease.metadata.egressAllowlist).toBeUndefined();
      const [, createOptions] = create.mock.calls[0] as [string, { metadata?: Record<string, unknown> }];
      expect(createOptions.metadata).not.toHaveProperty("egressAllowlist");
    });
  });
});

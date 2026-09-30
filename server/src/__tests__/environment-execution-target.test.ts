import { describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import {
  resolveEnvironmentExecutionTarget,
  resolveEnvironmentExecutionTargetConfigPatch,
} from "../services/environment-execution-target.js";

const COMPANY = "00000000-0000-0000-0000-000000000001";
const ENVIRONMENT_ID = "00000000-0000-0000-0000-000000000010";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: ENVIRONMENT_ID,
    companyId: COMPANY,
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    metadata: null,
    envVars: {},
    connectionTarget: null,
    target: null,
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeLease(overrides: Partial<EnvironmentLease> = {}): EnvironmentLease {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    companyId: COMPANY,
    environmentId: ENVIRONMENT_ID,
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: "00000000-0000-0000-0000-000000000030",
    status: "active",
    leasePolicy: "ephemeral",
    provider: "local",
    providerLeaseId: null,
    acquiredAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    lastUsedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    expiresAt: null,
    releasedAt: null,
    failureReason: null,
    cleanupStatus: null,
    metadata: { driver: "local" },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("resolveEnvironmentExecutionTarget", () => {
  it("returns local for a local environment with no legacy target", () => {
    expect(resolveEnvironmentExecutionTarget({
      environment: makeEnvironment(),
      lease: makeLease(),
      adapterType: "codex_local",
    })).toEqual({ type: "local" });
  });

  it("preserves AoA sandbox-docker target compatibility from the environment row", () => {
    expect(resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({
        target: {
          type: "sandbox-docker",
          image: "node:22-bookworm",
          workdir: "/workspace/app",
          shell: "bash",
          env: { NODE_ENV: "test", IGNORED: 123 },
        },
      }),
      lease: makeLease(),
      adapterType: "codex_local",
      multiTenant: false, // self-hosted: environments.target honored as authored
    })).toEqual({
      type: "sandbox-docker",
      image: "node:22-bookworm",
      workdir: "/workspace/app",
      shell: "bash",
      network: "bridge",
      remove: true,
      env: { NODE_ENV: "test" },
      installCommand: null,
      runtime: null,
      isolation: null,
      allowHostGateway: false,
    });
  });

  it("rejects invalid legacy environment targets before adapter execution", () => {
    expect(() => resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({ target: { type: "sandbox-docker" } }),
      lease: makeLease(),
      adapterType: "codex_local",
    })).toThrow('executionTarget.image is required for target "sandbox-docker"');
  });

  it("returns null for future remote drivers until adapter-utils supports remote targets", () => {
    expect(resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({ driver: "ssh", config: { host: "example.com" } }),
      lease: makeLease({ provider: "ssh" }),
      adapterType: "codex_local",
    })).toBeNull();
  });

  it("maps Docker-shaped sandbox environments to sandbox-docker execution targets", () => {
    expect(resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({
        driver: "sandbox",
        config: {
          provider: "sandbox-docker",
          image: "node:22-bookworm",
          workdir: "/workspace/app",
          shell: "bash",
          network: "none",
          env: { NODE_ENV: "test", IGNORED: 123 },
          installCommand: "npm install -g @openai/codex",
        },
      }),
      lease: makeLease({ provider: "sandbox-docker" }),
      adapterType: "codex_local",
      multiTenant: false, // self-hosted: non-gvisor sandbox config honored as authored
    })).toEqual({
      type: "sandbox-docker",
      image: "node:22-bookworm",
      workdir: "/workspace/app",
      shell: "bash",
      network: "none",
      remove: true,
      env: { NODE_ENV: "test" },
      installCommand: "npm install -g @openai/codex",
      runtime: null,
      isolation: null,
      allowHostGateway: false,
    });
  });

  it("MULTI_TENANT: neutralizes a weakened environments.target on shared infra", () => {
    const target = resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({
        target: {
          type: "sandbox-docker",
          image: "node:22-bookworm",
          network: "host",
          allowHostGateway: true,
          isolation: { capDropAll: false, readOnlyRootfs: false, noNewPrivileges: false, user: "0:0" },
        },
      }),
      lease: makeLease(),
      adapterType: "codex_local",
      multiTenant: true,
    });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(target.network).toBe("none"); // host clamped
    expect(target.allowHostGateway).toBe(false); // SSRF route closed
    expect(target.isolation?.capDropAll).toBe(true);
    expect(target.isolation?.readOnlyRootfs).toBe(true);
    expect(target.isolation?.noNewPrivileges).toBe(true);
    expect(target.isolation?.user).toBe("1000:1000");
  });

  it("MULTI_TENANT: neutralizes a weakened non-gvisor environments.config on shared infra", () => {
    const target = resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({
        driver: "sandbox",
        config: {
          provider: "sandbox-docker",
          image: "node:22-bookworm",
          network: "host",
          allowHostGateway: true,
          isolation: { capDropAll: false, readOnlyRootfs: false, noNewPrivileges: false, user: "0:0" },
        },
      }),
      lease: makeLease({ provider: "sandbox-docker" }),
      adapterType: "codex_local",
      multiTenant: true,
    });
    if (!target || target.type !== "sandbox-docker") throw new Error("expected sandbox-docker");
    expect(target.network).toBe("none");
    expect(target.allowHostGateway).toBe(false);
    expect(target.isolation?.capDropAll).toBe(true);
    expect(target.isolation?.user).toBe("1000:1000");
  });

  it("maps provider-backed sandbox leases to provider-sandbox execution targets", () => {
    const runner = { execute: vi.fn() };
    const target = resolveEnvironmentExecutionTarget({
      environment: makeEnvironment({
        driver: "sandbox",
        config: {
          provider: "fake",
        },
      }),
      lease: makeLease({
        provider: "fake",
        providerLeaseId: "fake-lease-1",
        metadata: {
          providerMetadata: {
            remoteCwd: "/workspace/app",
            shellCommand: "bash",
            timeoutMs: 120000,
          },
        },
      }),
      adapterType: "codex_local",
      providerRunner: runner,
    });

    expect(target).toEqual({
      type: "provider-sandbox",
      provider: "fake",
      providerLeaseId: "fake-lease-1",
      remoteCwd: "/workspace/app",
      shell: "bash",
      env: {},
      runner,
    });
  });
});

describe("resolveEnvironmentExecutionTargetConfigPatch", () => {
  it("builds a config patch containing only the resolved execution target", () => {
    expect(resolveEnvironmentExecutionTargetConfigPatch({
      environment: makeEnvironment({ target: { type: "local" } }),
      lease: makeLease(),
      adapterType: "codex_local",
    })).toEqual({ executionTarget: { type: "local" } });
  });

  it("returns an empty patch when no compatible execution target exists", () => {
    expect(resolveEnvironmentExecutionTargetConfigPatch({
      environment: makeEnvironment({ driver: "plugin" }),
      lease: makeLease({ provider: "plugin" }),
      adapterType: "cursor_cloud",
    })).toEqual({});
  });
});

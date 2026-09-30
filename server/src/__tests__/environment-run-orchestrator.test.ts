import { afterEach, describe, expect, it, vi } from "vitest";
import type { Environment, EnvironmentLease } from "@armyofagents/shared";
import {
  EnvironmentRunError,
  environmentRunOrchestrator,
} from "../services/environment-run-orchestrator.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const COMPANY = "00000000-0000-0000-0000-000000000001";
const ENVIRONMENT_ID = "00000000-0000-0000-0000-000000000010";
const RUN_ID = "00000000-0000-0000-0000-000000000030";

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
    heartbeatRunId: RUN_ID,
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

describe("environmentRunOrchestrator", () => {
  afterEach(() => setDeploymentMode("local_trusted"));

  it("resolves an active environment and acquires a lease for a run", async () => {
    const environment = makeEnvironment();
    const lease = makeLease();
    const runtime = {
      acquireRunLease: vi.fn(async () => ({
        environment,
        lease,
        leaseContext: {
          executionWorkspaceId: "workspace-1",
          executionWorkspaceMode: "per_task",
        },
      })),
    };
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => environment) },
      environmentRuntime: runtime,
    });

    const result = await orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: "issue-1",
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: { id: "workspace-1", mode: "per_task" },
    });

    expect(result.environment).toBe(environment);
    expect(result.lease).toBe(lease);
    expect(result.leaseContext.executionWorkspaceId).toBe("workspace-1");
    expect(result.configPatch).toEqual({ executionTarget: { type: "local" } });
    expect(runtime.acquireRunLease).toHaveBeenCalledWith({
      companyId: COMPANY,
      environment: { ...environment, executionTargetId: null },
      issueId: "issue-1",
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: { id: "workspace-1", mode: "per_task" },
      multiTenant: false,
      // S4 — placeholder threaded from acquireForRun; U11 populates it.
      egressAllowlist: [],
      // U7.5 / W7.5c — warm decision + warm keys; default ephemeral/null here.
      warmPreference: false,
      agentId: null,
      commanderConversationId: null,
    });
  });

  it("U11: forwards a caller-supplied egressAllowlist verbatim to runtime.acquireRunLease", async () => {
    const environment = makeEnvironment();
    const lease = makeLease();
    const runtime = {
      acquireRunLease: vi.fn(async () => ({
        environment,
        lease,
        leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
      })),
    };
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => environment) },
      environmentRuntime: runtime,
    });

    await orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
      egressAllowlist: ["mcp.notion.com", "registry.npmjs.org"],
    });

    expect(runtime.acquireRunLease).toHaveBeenCalledWith(
      expect.objectContaining({ egressAllowlist: ["mcp.notion.com", "registry.npmjs.org"] }),
    );
  });

  it("returns a sandbox-docker config patch when the environment has an AoA target", async () => {
    const environment = makeEnvironment({
      target: { type: "sandbox-docker", image: "node:22-bookworm" },
    });
    const lease = makeLease();
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => environment) },
      environmentRuntime: {
        acquireRunLease: vi.fn(async () => ({
          environment,
          lease,
          leaseContext: {
            executionWorkspaceId: null,
            executionWorkspaceMode: null,
          },
        })),
      },
    });

    const result = await orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    });

    expect(result.configPatch).toEqual({
      executionTarget: {
        type: "sandbox-docker",
        image: "node:22-bookworm",
        workdir: "/workspace",
        shell: "sh",
        network: "bridge",
        remove: true,
        env: {},
        installCommand: null,
        runtime: null,
        isolation: null,
        allowHostGateway: false,
      },
    });
  });

  it("rejects a persisted Docker/gVisor environment in cloud before acquiring a lease", async () => {
    setDeploymentMode("cloud_auth");
    const environment = makeEnvironment({
      driver: "sandbox",
      config: { provider: "gvisor", runtime: "runsc" },
      target: { type: "sandbox-docker", image: "node:22-bookworm", runtime: "runsc" },
      executionTargetId: "00000000-0000-4000-8000-000000000099",
    });
    const acquireRunLease = vi.fn();
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => environment) },
      environmentRuntime: { acquireRunLease },
    });

    await expect(orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject<Partial<EnvironmentRunError>>({
      code: "environment_target_unavailable",
      environmentId: ENVIRONMENT_ID,
      driver: "sandbox",
    });
    expect(acquireRunLease).not.toHaveBeenCalled();
  });

  it("returns provider-backed sandbox execution targets that call the runtime provider", async () => {
    const environment = makeEnvironment({
      driver: "sandbox",
      config: { provider: "fake" },
    });
    const lease = makeLease({
      provider: "fake",
      providerLeaseId: "fake-lease-1",
      metadata: {
        providerMetadata: {
          remoteCwd: "/workspace/fake",
          shellCommand: "bash",
        },
      },
    });
    const runtime = {
      acquireRunLease: vi.fn(async () => ({
        environment,
        lease,
        leaseContext: {
          executionWorkspaceId: null,
          executionWorkspaceMode: null,
        },
      })),
      executeRunLeaseCommand: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
      })),
    };
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => environment) },
      environmentRuntime: runtime,
    });

    const result = await orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    });

    expect(result.configPatch.executionTarget).toMatchObject({
      type: "provider-sandbox",
      provider: "fake",
      providerLeaseId: "fake-lease-1",
      remoteCwd: "/workspace/fake",
      shell: "bash",
    });
    const target = result.configPatch.executionTarget;
    if (!target || target.type !== "provider-sandbox") throw new Error("Expected provider target");
    await expect(target.runner.execute({
      runId: RUN_ID,
      provider: "fake",
      providerLeaseId: "fake-lease-1",
      command: "codex",
      args: ["--json"],
      cwd: "/workspace/fake",
      env: { A: "1" },
      timeoutSec: 30,
      graceSec: 2,
      onLog: vi.fn(),
    })).resolves.toEqual({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok",
      stderr: "",
    });
    expect(runtime.executeRunLeaseCommand).toHaveBeenCalledWith({
      environment,
      lease,
      command: "codex",
      args: ["--json"],
      cwd: "/workspace/fake",
      env: { A: "1" },
      stdin: undefined,
      timeoutSec: 30,
      // U7.5b — buildProviderRunner now maps the adapter's onLog into the
      // execute seam's onStdout/onStderr (E2B live-log parity with docker).
      onStdout: expect.any(Function),
      onStderr: expect.any(Function),
    });
  });

  it("rejects missing environments with a typed error", async () => {
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => null) },
      environmentRuntime: { acquireRunLease: vi.fn() },
    });

    await expect(orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: "missing",
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({
      name: "EnvironmentRunError",
      code: "environment_not_found",
    });
  });

  it("rejects archived environments before acquiring a lease", async () => {
    const runtime = { acquireRunLease: vi.fn() };
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn(async () => makeEnvironment({ status: "archived" })) },
      environmentRuntime: runtime,
    });

    await expect(orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: ENVIRONMENT_ID,
      adapterType: "codex_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    })).rejects.toBeInstanceOf(EnvironmentRunError);
    expect(runtime.acquireRunLease).not.toHaveBeenCalled();
  });

  it("resolves the platform-default e2b environment when environmentId is null on cloud", async () => {
    setDeploymentMode("cloud_auth");
    process.env.E2B_API_KEY = "op-key";
    const lease = makeLease({ provider: "e2b" });
    const acquireRunLease = vi.fn(async ({ environment }: { environment: Environment }) => ({
      environment,
      lease,
      leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
    }));
    const getEnv = vi.fn();
    // U1b: resolving the null-environmentId branch now materializes a real
    // persisted `environments` row (ensurePlatformDefaultEnvironmentRow),
    // which needs a real db. This is a pure unit test with `db = {} as
    // never`, so inject a fake via the DI seam instead — mirrors the
    // `environments`/`environmentRuntime` DI already used throughout this
    // file. The real materialize path is proven for real against a real db
    // in platform-default-environment-materialization.integration.test.ts.
    const ensurePlatformDefault = vi.fn(async () =>
      makeEnvironment({
        id: "platform-default-e2b",
        driver: "sandbox",
        config: { provider: "e2b", template: "base", timeoutMs: 3_600_000, reuseLease: false },
      }),
    );
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: getEnv },
      environmentRuntime: { acquireRunLease },
      ensurePlatformDefault,
    });

    const result = await orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: null,
      adapterType: "claude_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    });

    expect(ensurePlatformDefault).toHaveBeenCalledWith({ companyId: COMPANY, deploymentMode: "cloud_auth" });
    expect(getEnv).not.toHaveBeenCalled();
    expect(acquireRunLease).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({
          driver: "sandbox",
          config: expect.objectContaining({ provider: "e2b" }),
        }),
      }),
    );
    expect(result.environment.driver).toBe("sandbox");
    expect(result.adapterType).toBe("claude_local");

    delete process.env.E2B_API_KEY;
  });

  it("still throws environment_not_found for null environmentId off-cloud", async () => {
    setDeploymentMode("local_trusted");
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn() },
      environmentRuntime: { acquireRunLease: vi.fn() },
    });

    await expect(orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: null,
      adapterType: "claude_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({ code: "environment_not_found" });
  });

  it("throws environment_not_found for null environmentId on cloud with no operator key", async () => {
    setDeploymentMode("cloud_auth");
    delete process.env.E2B_API_KEY;
    const orchestrator = environmentRunOrchestrator({} as never, {
      environments: { get: vi.fn() },
      environmentRuntime: { acquireRunLease: vi.fn() },
    });

    await expect(orchestrator.acquireForRun({
      companyId: COMPANY,
      environmentId: null,
      adapterType: "claude_local",
      issueId: null,
      heartbeatRunId: RUN_ID,
      persistedExecutionWorkspace: null,
    })).rejects.toMatchObject({ code: "environment_not_found" });
  });
});

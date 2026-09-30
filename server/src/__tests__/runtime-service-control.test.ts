import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmitRuntimeServiceTaskOutput = vi.hoisted(() => vi.fn().mockResolvedValue(null));

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNotNull: vi.fn((col: any) => ({ isNotNull: col })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  ne: vi.fn((a: any, b: any) => ({ ne: [a, b] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
}));

vi.mock("@armyofagents/db", () => ({
  executionWorkspaces: {
    id: "ew_id",
    companyId: "ew_company_id",
    projectId: "ew_project_id",
    projectWorkspaceId: "ew_project_workspace_id",
    sourceIssueId: "ew_source_issue_id",
    mode: "ew_mode",
    strategyType: "ew_strategy_type",
    name: "ew_name",
    status: "ew_status",
    cwd: "ew_cwd",
    repoUrl: "ew_repo_url",
    baseRef: "ew_base_ref",
    branchName: "ew_branch_name",
    providerType: "ew_provider_type",
    providerRef: "ew_provider_ref",
    derivedFromExecutionWorkspaceId: "ew_derived_from",
    lastUsedAt: "ew_last_used_at",
    openedAt: "ew_opened_at",
    closedAt: "ew_closed_at",
    cleanupEligibleAt: "ew_cleanup_eligible_at",
    cleanupReason: "ew_cleanup_reason",
    metadata: "ew_metadata",
    createdAt: "ew_created_at",
    updatedAt: "ew_updated_at",
  },
  projectWorkspaces: {
    id: "pw_id",
    companyId: "pw_company_id",
    projectId: "pw_project_id",
    cwd: "pw_cwd",
    repoUrl: "pw_repo_url",
    repoRef: "pw_repo_ref",
    defaultRef: "pw_default_ref",
    metadata: "pw_metadata",
  },
  workspaceRuntimeServices: {
    id: "wrs_id",
    companyId: "wrs_company_id",
    projectId: "wrs_project_id",
    projectWorkspaceId: "wrs_project_workspace_id",
    executionWorkspaceId: "wrs_execution_workspace_id",
    scopeType: "wrs_scope_type",
    scopeId: "wrs_scope_id",
    serviceName: "wrs_service_name",
    status: "wrs_status",
    lifecycle: "wrs_lifecycle",
    reuseKey: "wrs_reuse_key",
    command: "wrs_command",
    cwd: "wrs_cwd",
    port: "wrs_port",
    url: "wrs_url",
    provider: "wrs_provider",
    providerRef: "wrs_provider_ref",
    processOwnerId: "wrs_process_owner_id",
    lastUsedAt: "wrs_last_used_at",
    startedAt: "wrs_started_at",
    stoppedAt: "wrs_stopped_at",
    stopPolicy: "wrs_stop_policy",
    healthStatus: "wrs_health_status",
    createdAt: "wrs_created_at",
    updatedAt: "wrs_updated_at",
  },
}));

vi.mock("../adapters/utils.js", () => ({
  asNumber: (value: unknown, fallback: number) => (typeof value === "number" ? value : fallback),
  asString: (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback),
  parseObject: (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}),
  renderTemplate: (template: string) => template,
}));

vi.mock("../home-paths.js", () => ({
  resolveHomeAwarePath: (p: string) => p,
}));

// `../middleware/logger.js` (used by workspace-runtime.ts after the C1 audit
// log) eagerly resolves AoA's config + log directory at import time, which in
// turn drags in `../home-paths.js` exports beyond `resolveHomeAwarePath`.
// Stub the logger here so the mock above remains a minimal partial.
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  },
}));

vi.mock("../services/task-output-emitters.js", () => ({
  emitRuntimeServiceTaskOutput: mockEmitRuntimeServiceTaskOutput,
}));

// ── Imports under test ────────────────────────────────────────────────────────

import {
  areRuntimeServicesTrackedLocally,
  buildWorkspaceRuntimeDesiredStatePatch,
  listConfiguredRuntimeServiceEntries,
  resetRuntimeServicesForTests,
  reconcilePersistedRuntimeServicesOnStartup,
  resolveConfiguredRuntimeServiceIndexForRow,
  resolveShell,
  RuntimeServiceActivationFenceError,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  resolveWorkspaceRuntimeReadinessTimeoutSec,
  restartDesiredRuntimeServicesOnStartup,
  stopRuntimeServicesForExecutionWorkspace,
  stopRuntimeServicesForProjectWorkspace,
  terminatePersistedLocalRuntimeProcess,
  withRuntimeControlLocks,
} from "../services/workspace-runtime.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  mergeProjectWorkspaceRuntimeConfig,
  readProjectWorkspaceRuntimeConfig,
} from "../services/project-workspace-runtime-config.js";
import {
  selectCurrentRuntimeServiceRows,
} from "../services/workspace-runtime-read-model.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRuntimeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "svc-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    issueId: null,
    scopeType: "execution_workspace",
    scopeId: "ws-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: "reuse-1",
    command: "pnpm dev",
    cwd: "/tmp/ws",
    port: 3000,
    url: "http://localhost:3000",
    provider: "local_process",
    providerRef: null,
    processOwnerId: "owner-a",
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: now,
    startedAt: now,
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  setDeploymentMode("local_trusted");
  delete process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT;
  process.env.AOA_RUNTIME_PROCESS_OWNER_ID = "owner-a";
  await resetRuntimeServicesForTests();
});

afterEach(() => {
  setDeploymentMode("local_trusted");
  delete process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT;
  delete process.env.AOA_RUNTIME_PROCESS_OWNER_ID;
});

// ── Pure function tests ───────────────────────────────────────────────────────

describe("resolveShell", () => {
  it("returns a non-empty string", () => {
    const shell = resolveShell();
    expect(typeof shell).toBe("string");
    expect(shell.length).toBeGreaterThan(0);
  });

  it("falls back to platform default when SHELL is empty", () => {
    const originalShell = process.env.SHELL;
    delete process.env.SHELL;
    try {
      const shell = resolveShell();
      if (process.platform === "win32") {
        expect(shell).toBe("cmd.exe");
      } else {
        expect(shell).toBe("/bin/sh");
      }
    } finally {
      if (originalShell !== undefined) process.env.SHELL = originalShell;
    }
  });
});

describe("resolveWorkspaceRuntimeReadinessTimeoutSec", () => {
  it("returns explicit readiness.timeoutSec when provided", () => {
    const timeout = resolveWorkspaceRuntimeReadinessTimeoutSec({
      readiness: { timeoutSec: 120 },
    });
    expect(timeout).toBe(120);
  });

  it("returns 90 for dev server commands when no explicit timeout", () => {
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({ command: "pnpm dev" })).toBe(90);
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({ command: "npm run dev" })).toBe(90);
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({ command: "yarn dev" })).toBe(90);
  });

  it("returns 30 for non-dev commands", () => {
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({ command: "pnpm test" })).toBe(30);
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({})).toBe(30);
  });

  it("floors to 1 when explicit timeout is 0 but command is not a dev server", () => {
    expect(resolveWorkspaceRuntimeReadinessTimeoutSec({ readiness: { timeoutSec: 0 } })).toBe(30);
  });
});

describe("listConfiguredRuntimeServiceEntries", () => {
  it("returns services array from workspaceRuntime", () => {
    const entries = listConfiguredRuntimeServiceEntries({
      workspaceRuntime: {
        services: [
          { name: "web", command: "pnpm dev" },
          { name: "api", command: "pnpm dev:api" },
        ],
      },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.name).toBe("web");
  });

  it("returns empty array when no services configured", () => {
    expect(listConfiguredRuntimeServiceEntries({})).toEqual([]);
    expect(listConfiguredRuntimeServiceEntries({ workspaceRuntime: {} })).toEqual([]);
    expect(listConfiguredRuntimeServiceEntries({ workspaceRuntime: { services: null } })).toEqual([]);
  });

  it("filters out non-object entries", () => {
    const entries = listConfiguredRuntimeServiceEntries({
      workspaceRuntime: {
        services: [{ name: "web" }, "invalid", null, { name: "api" }],
      },
    });
    expect(entries).toHaveLength(2);
  });
});

describe("buildWorkspaceRuntimeDesiredStatePatch", () => {
  const config = {
    workspaceRuntime: {
      services: [
        { name: "web", command: "pnpm dev" },
        { name: "api", command: "pnpm dev:api" },
      ],
    },
  };

  it("sets all services to running when action=start and no serviceIndex", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "stopped",
      currentServiceStates: null,
      action: "start",
    });
    expect(patch.desiredState).toBe("running");
    expect(patch.serviceStates).toEqual({ "0": "running", "1": "running" });
  });

  it("sets all services to stopped when action=stop and no serviceIndex", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "running",
      currentServiceStates: { "0": "running", "1": "running" },
      action: "stop",
    });
    expect(patch.desiredState).toBe("stopped");
    expect(patch.serviceStates).toEqual({ "0": "stopped", "1": "stopped" });
  });

  it("restart is equivalent to start for desiredState", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "running",
      currentServiceStates: { "0": "running", "1": "running" },
      action: "restart",
    });
    expect(patch.desiredState).toBe("running");
    expect(patch.serviceStates).toEqual({ "0": "running", "1": "running" });
  });

  it("only affects the targeted service when serviceIndex is set", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "running",
      currentServiceStates: { "0": "running", "1": "running" },
      action: "stop",
      serviceIndex: 1,
    });
    expect(patch.serviceStates).toEqual({ "0": "running", "1": "stopped" });
    expect(patch.desiredState).toBe("running");
  });

  it("computes desiredState=stopped when all service states are stopped", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "running",
      currentServiceStates: { "0": "running", "1": "stopped" },
      action: "stop",
      serviceIndex: 0,
    });
    expect(patch.serviceStates).toEqual({ "0": "stopped", "1": "stopped" });
    expect(patch.desiredState).toBe("stopped");
  });

  it("returns null serviceStates when no configured services", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config: {},
      currentDesiredState: null,
      currentServiceStates: null,
      action: "start",
    });
    expect(patch.serviceStates).toBeNull();
    expect(patch.desiredState).toBe("stopped");
  });

  it("ignores out-of-range serviceIndex without crashing", () => {
    const patch = buildWorkspaceRuntimeDesiredStatePatch({
      config,
      currentDesiredState: "stopped",
      currentServiceStates: null,
      action: "start",
      serviceIndex: 99,
    });
    expect(patch.serviceStates).toEqual({ "0": "stopped", "1": "stopped" });
    expect(patch.desiredState).toBe("stopped");
  });
});

describe("runtime service row targeting", () => {
  it("resolves a persisted runtime service row to the matching configured service index", () => {
    const services = [
      { name: "api", command: "pnpm dev:api", cwd: "apps/api" },
      { name: "web", command: "pnpm dev", cwd: "apps/web" },
    ];
    const row = makeRuntimeRow({
      serviceName: "web",
      command: "pnpm dev",
      cwd: "/repo/apps/web",
    });

    expect(resolveConfiguredRuntimeServiceIndexForRow({
      services,
      row,
      workspaceCwd: "/repo",
    })).toBe(1);
  });

  it("returns null when a persisted runtime service row maps ambiguously", () => {
    const services = [
      { name: "web", command: "pnpm dev" },
      { name: "web", command: "pnpm dev" },
    ];
    const row = makeRuntimeRow({
      serviceName: "web",
      command: "pnpm dev",
      cwd: null,
    });

    expect(resolveConfiguredRuntimeServiceIndexForRow({
      services,
      row,
      workspaceCwd: "/repo",
    })).toBeNull();
  });
});

describe("startRuntimeServicesForWorkspaceControl", () => {
  it("rolls back an uncommitted batch when its activation fence is superseded", async () => {
    const workspace = {
      baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-fence",
      workspaceId: "workspace-fence", repoUrl: null, repoRef: null,
      strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
      worktreePath: null, warnings: [], created: false,
    };
    const service = {
      name: "fenced-web",
      lifecycle: "shared",
      command: "node -e \"setInterval(() => {}, 1000)\"",
    };
    const baseInput = {
      actor: { id: "agent-1", name: "Board", companyId: "company-fence" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-fence",
      adapterEnv: {},
      config: { workspaceRuntime: { services: [service] } },
    };

    await expect(startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      commitGuard: async () => false,
    })).rejects.toBeInstanceOf(RuntimeServiceActivationFenceError);

    const retry = await startRuntimeServicesForWorkspaceControl(baseInput);
    expect(retry[0]?.reused).toBe(false);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-fence",
      workspaceCwd: process.cwd(),
    });
  });

  it("fails activation when a concurrent stop removes the service before commit", async () => {
    let enterGuard!: () => void;
    let releaseGuard!: () => void;
    const guardEntered = new Promise<void>((resolve) => { enterGuard = resolve; });
    const guardRelease = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const executionWorkspaceId = "execution-stop-at-guard";
    const start = startRuntimeServicesForWorkspaceControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-stop-at-guard" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-stop-at-guard",
        workspaceId: "workspace-stop-at-guard", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId,
      config: {
        workspaceRuntime: {
          services: [{
            name: "stop-at-guard",
            command: "node -e \"setInterval(() => {}, 1000)\"",
            reuseScope: "execution_workspace",
          }],
        },
      },
      adapterEnv: {},
      commitGuard: async () => {
        enterGuard();
        await guardRelease;
        return true;
      },
    });

    await guardEntered;
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId,
      workspaceCwd: process.cwd(),
    });
    releaseGuard();

    await expect(start).rejects.toBeInstanceOf(RuntimeServiceActivationFenceError);
  });

  it("validates the whole batch before committing any service", async () => {
    let enterGuard!: () => void;
    let releaseGuard!: () => void;
    const guardEntered = new Promise<void>((resolve) => { enterGuard = resolve; });
    const guardRelease = new Promise<void>((resolve) => { releaseGuard = resolve; });
    const baseInput = {
      actor: { id: "agent-1", name: "Board", companyId: "company-two-pass" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-two-pass",
        workspaceId: "workspace-two-pass", repoUrl: null, repoRef: null,
        strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "execution-two-pass",
      adapterEnv: {},
    };
    const firstService = {
      name: "two-pass-stable",
      command: "node -e \"setInterval(() => {}, 1000)\"",
      reuseScope: "execution_workspace",
    };
    const start = startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      config: {
        workspaceRuntime: {
          services: [
            firstService,
            { name: "two-pass-exits", command: "node -e \"setTimeout(() => process.exit(0), 100)\"" },
          ],
        },
      },
      commitGuard: async () => {
        enterGuard();
        await guardRelease;
        return true;
      },
    });

    await guardEntered;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    releaseGuard();
    await expect(start).rejects.toBeInstanceOf(RuntimeServiceActivationFenceError);

    const retry = await startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      config: { workspaceRuntime: { services: [firstService] } },
    });
    expect(retry[0]?.reused).toBe(false);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: baseInput.executionWorkspaceId,
      workspaceCwd: process.cwd(),
    });
  });

  it("does not reuse a shared service after its effective command or cwd changes", async () => {
    const baseInput = {
      actor: { id: "agent-1", name: "Board", companyId: "company-reuse-config" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-reuse-config",
        workspaceId: "workspace-reuse-config", repoUrl: null, repoRef: null,
        strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "execution-reuse-config",
      adapterEnv: {},
    };
    const start = async (command: string, cwd = ".") => await startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      config: {
        workspaceRuntime: {
          services: [{ name: "config-sensitive", command, cwd, reuseScope: "project_workspace" }],
        },
      },
    });

    const original = await start("node -e \"setInterval(() => {}, 1000)\"");
    const changedCommand = await start("node -e \"setInterval(() => {}, 2000)\"");
    const changedCwd = await start("node -e \"setInterval(() => {}, 2000)\"", "server");

    expect(new Set([original[0]?.id, changedCommand[0]?.id, changedCwd[0]?.id]).size).toBe(3);
    expect([original[0]?.reused, changedCommand[0]?.reused, changedCwd[0]?.reused]).toEqual([false, false, false]);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: baseInput.executionWorkspaceId,
      workspaceCwd: process.cwd(),
    });
  });

  it("rolls back newly created services when a later service in the batch fails", async () => {
    const workspace = {
      baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-1",
      workspaceId: "workspace-root-rollback", repoUrl: null, repoRef: null,
      strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
      worktreePath: null, warnings: [], created: false,
    };
    const firstService = {
      name: "rollback-web",
      lifecycle: "shared",
      command: "node -e \"setInterval(() => {}, 1000)\"",
    };
    const baseInput = {
      actor: { id: "agent-1", name: "Board", companyId: "company-rollback" },
      issue: null,
      workspace,
      executionWorkspaceId: "workspace-rollback",
      adapterEnv: {},
    };

    await expect(startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      config: {
        workspaceRuntime: {
          services: [firstService, { name: "broken-service" }],
        },
      },
    })).rejects.toThrow(/missing command/);

    const retry = await startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      config: { workspaceRuntime: { services: [firstService] } },
    });
    expect(retry).toHaveLength(1);
    expect(retry[0]?.reused).toBe(false);

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "workspace-rollback",
      workspaceCwd: process.cwd(),
    });
  });

  it("does not roll back a shared service adopted by a concurrent successful batch", async () => {
    const workspace = {
      baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-concurrent-rollback",
      workspaceId: "workspace-concurrent-rollback", repoUrl: null, repoRef: null,
      strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
      worktreePath: null, warnings: [], created: false,
    };
    const sharedService = {
      name: "shared-adopted-web",
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      command: "node -e \"setInterval(() => {}, 1000)\"",
    };
    const baseInput = {
      actor: { id: "agent-1", name: "Board", companyId: "company-concurrent-rollback" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-concurrent-rollback",
      adapterEnv: {},
    };
    const failingBatch = startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      invocationId: "failing-batch",
      config: {
        workspaceRuntime: {
          services: [
            sharedService,
            {
              name: "never-ready",
              command: "node -e \"setInterval(() => {}, 1000)\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 1,
                intervalMs: 100,
              },
            },
          ],
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const successfulBatch = await startRuntimeServicesForWorkspaceControl({
      ...baseInput,
      invocationId: "successful-batch",
      config: { workspaceRuntime: { services: [sharedService] } },
    });
    expect(successfulBatch[0]?.reused).toBe(true);

    await expect(failingBatch).rejects.toThrow(/Readiness check failed/);
    expect(areRuntimeServicesTrackedLocally([successfulBatch[0]!.id])).toBe(true);

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-concurrent-rollback",
      workspaceCwd: process.cwd(),
    });
  }, 10_000);

  it("single-flights concurrent shared starts with the same reuse key", async () => {
    const input = {
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-1",
        workspaceId: "workspace-root-1", repoUrl: null, repoRef: null,
        strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "workspace-concurrent",
      config: {
        workspaceRuntime: {
          services: [{
            name: "shared-web",
            lifecycle: "shared",
            command: "node -e \"setInterval(() => {}, 1000)\"",
            port: { type: "auto" },
          }],
        },
      },
      adapterEnv: {},
    };

    const [first, second] = await Promise.all([
      startRuntimeServicesForWorkspaceControl(input),
      startRuntimeServicesForWorkspaceControl(input),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).toBe(second[0]?.id);
    expect([first[0]?.reused, second[0]?.reused].sort()).toEqual([false, true]);
    expect(areRuntimeServicesTrackedLocally([first[0]!.id])).toBe(true);

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "workspace-concurrent",
      workspaceCwd: process.cwd(),
    });
  });

  it("reuses an omitted-lifecycle service using the documented shared default", async () => {
    const input = {
      actor: { id: "agent-1", name: "Board", companyId: "company-default-shared" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary" as const, projectId: "project-default-shared",
        workspaceId: "workspace-default-shared", repoUrl: null, repoRef: null,
        strategy: "project_primary" as const, cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "execution-default-shared",
      config: {
        workspaceRuntime: {
          services: [{ name: "default-shared", command: "node -e \"setInterval(() => {}, 1000)\"" }],
        },
      },
      adapterEnv: {},
    };

    const first = await startRuntimeServicesForWorkspaceControl(input);
    const second = await startRuntimeServicesForWorkspaceControl(input);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.reused).toBe(true);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: input.executionWorkspaceId,
      workspaceCwd: process.cwd(),
    });
  });

  it("does not reuse shared processes across companies or effective adapter environments", async () => {
    const start = async (companyId: string, executionWorkspaceId: string, credential: string) =>
      await startRuntimeServicesForWorkspaceControl({
        actor: { id: `agent-${companyId}`, name: "Board", companyId },
        issue: null,
        workspace: {
          baseCwd: process.cwd(), source: "agent_home", projectId: null,
          workspaceId: null, repoUrl: null, repoRef: null,
          strategy: "project_primary", cwd: process.cwd(), branchName: null,
          worktreePath: null, warnings: [], created: false,
        },
        executionWorkspaceId,
        config: {
          workspaceRuntime: {
            services: [{
              name: "shared-web",
              lifecycle: "shared",
              reuseScope: "project_workspace",
              command: "node -e \"setInterval(() => {}, 1000)\"",
            }],
          },
        },
        adapterEnv: { PROVIDER_TOKEN: credential },
      });

    const companyAFirst = await start("company-a", "workspace-a1", "token-a");
    const companyB = await start("company-b", "workspace-b", "token-a");
    const companyASecond = await start("company-a", "workspace-a2", "token-b");

    expect(new Set([
      companyAFirst[0]?.id,
      companyB[0]?.id,
      companyASecond[0]?.id,
    ]).size).toBe(3);
    expect([companyAFirst[0]?.reused, companyB[0]?.reused, companyASecond[0]?.reused])
      .toEqual([false, false, false]);

    for (const executionWorkspaceId of ["workspace-a1", "workspace-b", "workspace-a2"]) {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: process.cwd(),
      });
    }
  });

  it("preserves project-scoped infrastructure when a shared session is archived", async () => {
    const refs = await startRuntimeServicesForWorkspaceControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-1",
        workspaceId: "project-workspace-1", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "shared-session-1",
      config: {
        workspaceRuntime: {
          services: [{
            name: "shared-web",
            command: "node -e \"setInterval(() => {}, 1000)\"",
            reuseScope: "project_workspace",
          }],
        },
      },
      adapterEnv: {},
    });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "shared-session-1",
      workspaceCwd: null,
      preserveProjectWorkspaceServices: true,
    });
    expect(areRuntimeServicesTrackedLocally([refs[0]!.id])).toBe(true);

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "shared-session-1",
      workspaceCwd: process.cwd(),
    });
    expect(areRuntimeServicesTrackedLocally([refs[0]!.id])).toBe(false);
  });

  it("refuses local runtime-service commands in cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    await expect(startRuntimeServicesForWorkspaceControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-1",
        workspaceId: "workspace-root-1", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "workspace-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "echo unsafe" }] } },
      adapterEnv: { SECRET_VALUE: "must-not-reach-a-process" },
    })).rejects.toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
  });

  it("requires a unique process owner before the unsafe cloud override can spawn", async () => {
    setDeploymentMode("cloud_auth");
    process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT = "1";
    delete process.env.AOA_RUNTIME_PROCESS_OWNER_ID;

    await expect(startRuntimeServicesForWorkspaceControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-1",
        workspaceId: "workspace-root-1", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "workspace-1",
      config: { workspaceRuntime: { services: [{ name: "web", command: "echo unsafe" }] } },
      adapterEnv: {},
    })).rejects.toThrow(/AOA_RUNTIME_PROCESS_OWNER_ID is required/);
  });

  it("does not persist a fake startedByRunId for manual runtime service starts", async () => {
    const refs = await startRuntimeServicesForWorkspaceControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(),
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-root-1",
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        cwd: process.cwd(),
        branchName: null,
        worktreePath: null,
        warnings: [],
        created: false,
      },
      executionWorkspaceId: "workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: "node -e \"require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT, '127.0.0.1')\"",
              port: { type: "auto" },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(refs[0]?.startedByRunId).toBeNull();
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "workspace-1",
      workspaceCwd: process.cwd(),
    });
  });
});

describe("terminatePersistedLocalRuntimeProcess", () => {
  it("does not inspect or signal foreign and legacy persisted PIDs", async () => {
    const isAlive = vi.fn(async () => true);
    const inspectIdentity = vi.fn(() => "matching" as const);
    const terminate = vi.fn();

    for (const processOwnerId of ["owner-b", null]) {
      await expect(terminatePersistedLocalRuntimeProcess(
        { processOwnerId, providerRef: "4242", startedAt: new Date() },
        { processOwnerId: "owner-a", isAlive, inspectIdentity, terminate },
      )).resolves.toBe(false);
    }

    expect(isAlive).not.toHaveBeenCalled();
    expect(inspectIdentity).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("identity-verifies and confirms exit before accepting a stale process as reaped", async () => {
    let aliveChecks = 0;
    const terminate = vi.fn();
    const safe = await terminatePersistedLocalRuntimeProcess(
      { processOwnerId: "owner-a", providerRef: "4242", startedAt: new Date("2026-08-02T00:00:00Z") },
      {
        platform: "linux",
        isAlive: async () => aliveChecks++ === 0,
        inspectIdentity: () => "matching",
        terminate,
        waitForExitMs: 10,
      },
    );

    expect(safe).toBe(true);
    expect(terminate).toHaveBeenCalledWith(
      4242,
      4242,
    );
  });

  it("fails closed when the persisted POSIX leader is gone but its process group is alive", async () => {
    const inspectIdentity = vi.fn();
    const terminate = vi.fn();
    const isAlive = vi.fn(async (target: number) => target === -4242);

    const safe = await terminatePersistedLocalRuntimeProcess(
      { processOwnerId: "owner-a", providerRef: "4242", startedAt: new Date("2026-08-02T00:00:00Z") },
      { platform: "linux", isAlive, inspectIdentity, terminate },
    );

    expect(safe).toBe(false);
    expect(isAlive).toHaveBeenNthCalledWith(1, 4242);
    expect(isAlive).toHaveBeenNthCalledWith(2, -4242);
    expect(inspectIdentity).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("does not report success when only the POSIX leader exits after group termination", async () => {
    let leaderChecks = 0;
    const isAlive = vi.fn(async (target: number) => {
      if (target === 4242) return leaderChecks++ === 0;
      return target === -4242;
    });

    const safe = await terminatePersistedLocalRuntimeProcess(
      { processOwnerId: "owner-a", providerRef: "4242", startedAt: new Date("2026-08-02T00:00:00Z") },
      {
        platform: "linux",
        isAlive,
        inspectIdentity: () => "matching",
        terminate: vi.fn(),
        waitForExitMs: 10,
      },
    );

    expect(safe).toBe(false);
    expect(isAlive).toHaveBeenCalledWith(-4242);
  });

  it("fails closed when a live persisted PID cannot be identity-verified", async () => {
    const safe = await terminatePersistedLocalRuntimeProcess(
      { processOwnerId: "owner-a", providerRef: "4242", startedAt: new Date() },
      { isAlive: async () => true, inspectIdentity: () => "unknown" },
    );
    expect(safe).toBe(false);
  });

  it("accepts a confirmed reused PID without signalling the unrelated process", async () => {
    const terminate = vi.fn();
    const safe = await terminatePersistedLocalRuntimeProcess(
      { processOwnerId: "owner-a", providerRef: "4242", startedAt: new Date() },
      {
        isAlive: async () => true,
        inspectIdentity: () => "different",
        terminate,
      },
    );
    expect(safe).toBe(true);
    expect(terminate).not.toHaveBeenCalled();
  });

  it("blocks cloud startup and preserves tracking rows when a live PID is unverifiable", async () => {
    setDeploymentMode("cloud_auth");
    const update = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ id: "service-1", providerRef: "4242", startedAt: new Date(), status: "running" }],
        }),
      }),
      update,
    } as never;

    const isAlive = vi.fn(async () => true);
    await expect(reconcilePersistedRuntimeServicesOnStartup(db, {
      isAlive,
      inspectIdentity: () => "unknown",
    })).rejects.toThrow(/Cloud startup refused/);
    expect(update).not.toHaveBeenCalled();
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("blocks cloud startup without OS calls when persisted rows exist but owner config is missing", async () => {
    setDeploymentMode("cloud_auth");
    const isAlive = vi.fn(async () => true);
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: "service-foreign",
            processOwnerId: "owner-a",
            providerRef: "4242",
            startedAt: new Date(),
            status: "running",
          }],
        }),
      }),
      update: vi.fn(),
    } as never;

    await expect(reconcilePersistedRuntimeServicesOnStartup(db, {
      processOwnerId: null,
      isAlive,
    })).rejects.toThrow(/AOA_RUNTIME_PROCESS_OWNER_ID is unset/);
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("reconciles only current-owner rows and clears their fenced PID identity", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const startedAt = new Date("2026-08-03T00:00:00Z");
    const rows = [
      { id: "owned", processOwnerId: "owner-a", providerRef: "4242", startedAt, status: "running" },
      { id: "foreign", processOwnerId: "owner-b", providerRef: "4242", startedAt, status: "running" },
      { id: "legacy", processOwnerId: null, providerRef: "4242", startedAt, status: "running" },
    ];
    const db = {
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              updates.push(values);
              return [{
                ...rows[0],
                companyId: "company-1",
                issueId: "issue-1",
                executionWorkspaceId: "workspace-1",
                serviceName: "web",
                provider: "local_process",
                url: null,
                status: "stopped",
                healthStatus: "unknown",
                providerRef: null,
                processOwnerId: null,
              }];
            },
          }),
        }),
      }),
    } as never;
    const isAlive = vi.fn(async () => false);

    await expect(reconcilePersistedRuntimeServicesOnStartup(db, {
      processOwnerId: "owner-a",
      platform: "linux",
      isAlive,
    })).resolves.toEqual({ reconciled: 1, unresolved: 1, foreign: 1 });

    expect(isAlive).toHaveBeenCalledTimes(2);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "stopped",
      providerRef: null,
      processOwnerId: null,
    });
    expect(mockEmitRuntimeServiceTaskOutput).toHaveBeenCalledWith(db, expect.objectContaining({
      id: "owned",
      issueId: "issue-1",
      status: "stopped",
      healthStatus: "unknown",
      url: null,
      providerRef: null,
    }));
  });

  it("persists process ownership with the PID before readiness can wait", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          writes.push(value);
          return { onConflictDoUpdate: async () => undefined };
        },
      }),
    } as never;

    const refs = await startRuntimeServicesForWorkspaceControl({
      db,
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-1",
        workspaceId: "workspace-root-1", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      executionWorkspaceId: "workspace-owned",
      config: {
        workspaceRuntime: {
          services: [{
            name: "owned",
            command: "node -e \"setInterval(() => {}, 1000)\"",
          }],
        },
      },
      adapterEnv: {},
    });

    expect(writes[0]).toMatchObject({
      status: "starting",
      processOwnerId: "owner-a",
    });
    expect(writes[0]?.providerRef).toMatch(/^\d+$/);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "workspace-owned",
      workspaceCwd: process.cwd(),
    });
    expect(refs).toHaveLength(1);
  });
});

describe("runWorkspaceJobForControl", () => {
  it("refuses a local one-shot workspace command in cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    await expect(runWorkspaceJobForControl({
      actor: { id: "agent-1", name: "Board", companyId: "company-1" },
      issue: null,
      workspace: {
        baseCwd: process.cwd(), source: "project_primary", projectId: "project-1",
        workspaceId: "workspace-root-1", repoUrl: null, repoRef: null,
        strategy: "project_primary", cwd: process.cwd(), branchName: null,
        worktreePath: null, warnings: [], created: false,
      },
      command: { name: "unsafe", command: "echo unsafe" },
      adapterEnv: { SECRET_VALUE: "must-not-reach-a-process" },
    })).rejects.toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
  });
});

// ── project-workspace-runtime-config tests ────────────────────────────────────

describe("readProjectWorkspaceRuntimeConfig", () => {
  it("returns null for missing runtimeConfig", () => {
    expect(readProjectWorkspaceRuntimeConfig(null)).toBeNull();
    expect(readProjectWorkspaceRuntimeConfig({})).toBeNull();
    expect(readProjectWorkspaceRuntimeConfig({ other: "value" })).toBeNull();
  });

  it("reads desiredState + workspaceRuntime + serviceStates", () => {
    const config = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: {
        workspaceRuntime: { services: [{ name: "web" }] },
        desiredState: "running",
        serviceStates: { "0": "running" },
      },
    });
    expect(config).toEqual({
      workspaceRuntime: { services: [{ name: "web" }] },
      desiredState: "running",
      serviceStates: { "0": "running" },
    });
  });

  it("rejects invalid desiredState values", () => {
    const config = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: { desiredState: "bogus" },
    });
    expect(config).toBeNull();
  });

  it("filters invalid service state values", () => {
    const config = readProjectWorkspaceRuntimeConfig({
      runtimeConfig: {
        workspaceRuntime: { services: [] },
        serviceStates: { "0": "running", "1": "bogus" },
      },
    });
    expect(config?.serviceStates).toEqual({ "0": "running" });
  });
});

describe("mergeProjectWorkspaceRuntimeConfig", () => {
  it("merges patch onto existing config", () => {
    const merged = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "stopped" } },
      { desiredState: "running" },
    );
    expect((merged as any)?.runtimeConfig?.desiredState).toBe("running");
  });

  it("removes runtimeConfig when patch is null", () => {
    const merged = mergeProjectWorkspaceRuntimeConfig(
      { runtimeConfig: { desiredState: "running" }, other: "value" },
      null,
    );
    expect(merged).toEqual({ other: "value" });
  });
});

// ── workspace-runtime-read-model tests ────────────────────────────────────────

describe("selectCurrentRuntimeServiceRows", () => {
  it("deduplicates by reuseKey, keeping first", () => {
    const now = new Date();
    const rows = [
      makeRuntimeRow({ id: "a", reuseKey: "key-1", updatedAt: new Date(now.getTime() + 1000) }),
      makeRuntimeRow({ id: "b", reuseKey: "key-1", updatedAt: now }),
    ];
    const result = selectCurrentRuntimeServiceRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("deduplicates by identity tuple when reuseKey is null", () => {
    const rows = [
      makeRuntimeRow({ id: "a", reuseKey: null, scopeType: "execution_workspace", scopeId: "ws-1", serviceName: "web", command: "pnpm dev", cwd: "/tmp" }),
      makeRuntimeRow({ id: "b", reuseKey: null, scopeType: "execution_workspace", scopeId: "ws-1", serviceName: "web", command: "pnpm dev", cwd: "/tmp" }),
    ];
    const result = selectCurrentRuntimeServiceRows(rows);
    expect(result).toHaveLength(1);
  });

  it("keeps rows with distinct identities", () => {
    const rows = [
      makeRuntimeRow({ id: "a", reuseKey: "k1" }),
      makeRuntimeRow({ id: "b", reuseKey: "k2" }),
    ];
    expect(selectCurrentRuntimeServiceRows(rows)).toHaveLength(2);
  });
});

// ── stopRuntimeServicesForProjectWorkspace — DB-persisted path ────────────────

describe("stopRuntimeServicesForProjectWorkspace", () => {
  it("updates persisted rows to stopped for a project workspace", async () => {
    const updates: unknown[] = [];
    const setCalls: unknown[] = [];
    const db: any = {
      update: vi.fn(() => ({
        set: vi.fn((values: unknown) => {
          setCalls.push(values);
          return {
            where: vi.fn((conditions: unknown) => {
              updates.push(conditions);
              return Promise.resolve();
            }),
          };
        }),
      })),
    };

    await stopRuntimeServicesForProjectWorkspace({
      db,
      projectWorkspaceId: "pw-1",
    });

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    const setCall = setCalls[0] as Record<string, unknown>;
    expect(setCall.status).toBe("stopped");
    expect(setCall.healthStatus).toBe("unknown");
  });

  it("targets a specific runtimeServiceId when provided", async () => {
    const db: any = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
    };

    await stopRuntimeServicesForProjectWorkspace({
      db,
      projectWorkspaceId: "pw-1",
      runtimeServiceId: "svc-123",
    });

    expect(db.update).toHaveBeenCalled();
  });

  it("is a no-op without db when no matching in-memory records", async () => {
    await expect(
      stopRuntimeServicesForProjectWorkspace({ projectWorkspaceId: "pw-999" }),
    ).resolves.toBeUndefined();
  });
});

// ── restartDesiredRuntimeServicesOnStartup ────────────────────────────────────

describe("restartDesiredRuntimeServicesOnStartup", () => {
  it("fails a startup activation when any persisted spawn input changes before commit", async () => {
    const initial = {
      id: "pw-fenced",
      companyId: "company-fenced",
      projectId: "project-fenced",
      cwd: process.cwd(),
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      metadata: {
        runtimeConfig: {
          workspaceRuntime: { services: [] },
          desiredState: "running",
        },
      },
    };
    const superseded = {
      ...initial,
      cwd: `${process.cwd()}-moved`,
    };
    let callIndex = 0;
    const responses = [[initial], [superseded], []];
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(responses[callIndex++] ?? []))),
      })),
    };

    await expect(restartDesiredRuntimeServicesOnStartup(db)).resolves.toEqual({
      restarted: 0,
      failed: 1,
    });
  });

  it("returns restarted=0 when no rows have desiredState=running", async () => {
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn([]))),
      })),
    };

    const result = await restartDesiredRuntimeServicesOnStartup(db);
    expect(result).toEqual({ restarted: 0, failed: 0 });
  });

  it("skips rows without runtime config or cwd", async () => {
    const projectWorkspaceRows = [
      { id: "pw-1", companyId: "c", projectId: "p", cwd: null, repoUrl: null, repoRef: null, defaultRef: null, metadata: null },
      { id: "pw-2", companyId: "c", projectId: "p", cwd: "/tmp", repoUrl: null, repoRef: null, defaultRef: null, metadata: {} },
    ];
    let callIdx = 0;
    const responses = [projectWorkspaceRows, []];
    const db: any = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(responses[callIdx++] ?? []))),
      })),
    };

    const result = await restartDesiredRuntimeServicesOnStartup(db);
    expect(result.restarted).toBe(0);
  });
});

// ── resetRuntimeServicesForTests ──────────────────────────────────────────────

describe("resetRuntimeServicesForTests", () => {
  it("is a safe no-op when nothing is registered", async () => {
    await expect(resetRuntimeServicesForTests()).resolves.toBeUndefined();
  });
});

describe("withRuntimeControlLocks", () => {
  it("serializes overlapping start/stop ownership scopes until the first transition finishes", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const stop = withRuntimeControlLocks(["execution:ws-1", "project:pw-1"], async () => {
      events.push("stop:begin");
      markEntered();
      await firstGate;
      events.push("stop:end");
    });
    await entered;
    const start = withRuntimeControlLocks(["project:pw-1", "execution:ws-1"], async () => {
      events.push("start:begin");
      events.push("start:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["stop:begin"]);
    releaseFirst();
    await Promise.all([stop, start]);
    expect(events).toEqual(["stop:begin", "stop:end", "start:begin", "start:end"]);
  });
});

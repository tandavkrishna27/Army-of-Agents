import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionWorkspace } from "@armyofagents/shared";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../services/unsandboxed-multitenant-guard.js";

// ── Pure function tests ─────────────────────────────────────────────────────
// readExecutionWorkspaceConfig + mergeExecutionWorkspaceConfig are pure; we
// can test them without mocking drizzle. But the module imports @armyofagents/db
// at the top, which requires the drizzle stubs below to be set up FIRST.

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    executionWorkspaces: makeTable("execution_workspaces"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    workspaceRuntimeServices: makeTable("workspace_runtime_services"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _type: "and", args }),
  eq: (col: unknown, value: unknown) => ({ _type: "eq", col, value }),
  ne: (col: unknown, value: unknown) => ({ _type: "ne", col, value }),
  desc: (col: unknown) => ({ _type: "desc", col }),
  inArray: (col: unknown, values: unknown[]) => ({ _type: "inArray", col, values }),
}));

import {
  executionWorkspaceService,
  inspectGitCloseReadiness,
  mergeExecutionWorkspaceConfig,
  mergeExecutionWorkspaceMetadataPatch,
  readExecutionWorkspaceConfig,
} from "../services/execution-workspaces.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

interface MockDbOptions {
  selects?: MockRow[][];
}

function createMockDb(options: MockDbOptions = {}) {
  const selects = options.selects ?? [];
  let selectIdx = 0;

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.then = (resolve: (rows: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeSelectChain(() => selects[selectIdx++] ?? []),
  };

  return { db: db as never };
}

function buildWorkspaceRow(overrides: Partial<Record<string, unknown>> = {}): MockRow {
  const now = new Date("2026-04-22T00:00:00Z");
  return {
    id: "ws-1",
    companyId: "co-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "feature-x",
    status: "active",
    cwd: null,
    repoUrl: null,
    baseRef: null,
    branchName: "feature-x",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildExecutionWorkspace(overrides: Partial<ExecutionWorkspace> & {
  providerType?: ExecutionWorkspace["providerType"];
  cwd?: string | null;
}): ExecutionWorkspace {
  const now = new Date("2026-04-22T00:00:00Z");
  const providerType = overrides.providerType ?? "git_worktree";
  return {
    id: "ws-1",
    companyId: "co-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: providerType === "git_worktree" ? "git_worktree" : "project_primary",
    name: "feature-x",
    status: "active",
    cwd: overrides.cwd ?? null,
    repoUrl: null,
    baseRef: "main",
    branchName: "feature-x",
    providerType,
    providerRef: overrides.cwd ?? null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: now,
    openedAt: now,
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── readExecutionWorkspaceConfig ─────────────────────────────────────────────

describe("readExecutionWorkspaceConfig", () => {
  it("returns null when metadata is null/undefined", () => {
    expect(readExecutionWorkspaceConfig(null)).toBeNull();
    expect(readExecutionWorkspaceConfig(undefined)).toBeNull();
  });

  it("returns null when metadata has no config key", () => {
    expect(readExecutionWorkspaceConfig({ createdByRuntime: true })).toBeNull();
  });

  it("returns null when all config fields are null/empty", () => {
    expect(readExecutionWorkspaceConfig({
      config: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: null,
      },
    })).toBeNull();
  });

  it("extracts populated config fields", () => {
    const result = readExecutionWorkspaceConfig({
      config: {
        provisionCommand: "pnpm install",
        teardownCommand: "pnpm teardown",
        cleanupCommand: "pnpm clean",
        workspaceRuntime: { services: [{ name: "api" }] },
        desiredState: "running",
        serviceStates: { api: "running", worker: "stopped", invalid: "bogus" },
      },
    });
    expect(result).toEqual({
      provisionCommand: "pnpm install",
      teardownCommand: "pnpm teardown",
      cleanupCommand: "pnpm clean",
      workspaceRuntime: { services: [{ name: "api" }] },
      desiredState: "running",
      serviceStates: { api: "running", worker: "stopped" },
    });
  });

  it("drops non-string / empty-string command fields", () => {
    const result = readExecutionWorkspaceConfig({
      config: {
        provisionCommand: "   ",
        teardownCommand: 42,
        cleanupCommand: null,
        workspaceRuntime: { a: 1 },
      },
    });
    expect(result).toEqual({
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: { a: 1 },
      desiredState: null,
      serviceStates: null,
    });
  });
});

// ── mergeExecutionWorkspaceConfig ────────────────────────────────────────────

describe("mergeExecutionWorkspaceConfig", () => {
  it("returns null when no metadata and patch is null", () => {
    expect(mergeExecutionWorkspaceConfig(null, null)).toBeNull();
  });

  it("strips config when patch is null but keeps other metadata", () => {
    const result = mergeExecutionWorkspaceConfig(
      { createdByRuntime: true, config: { cleanupCommand: "x" } },
      null,
    );
    expect(result).toEqual({ createdByRuntime: true });
  });

  it("layers patch over existing config, preserving untouched fields", () => {
    const result = mergeExecutionWorkspaceConfig(
      { config: { provisionCommand: "install", teardownCommand: "tear" } },
      { cleanupCommand: "clean" },
    );
    expect((result?.config as Record<string, unknown>)).toEqual({
      provisionCommand: "install",
      teardownCommand: "tear",
      cleanupCommand: "clean",
      workspaceRuntime: null,
      desiredState: null,
      serviceStates: null,
    });
  });

  it("writes new config from scratch when metadata has none", () => {
    const result = mergeExecutionWorkspaceConfig(null, {
      provisionCommand: "pnpm install",
      workspaceRuntime: { port: 3000 },
    });
    const config = result?.config as Record<string, unknown>;
    expect(config.provisionCommand).toBe("pnpm install");
    expect(config.workspaceRuntime).toEqual({ port: 3000 });
  });

  it("drops config entirely when every field becomes null after patch", () => {
    const result = mergeExecutionWorkspaceConfig(
      { unrelated: "keep", config: { provisionCommand: "old" } },
      { provisionCommand: null },
    );
    expect(result).toEqual({ unrelated: "keep" });
  });
});

// ── inspectGitCloseReadiness (real temp git repos) ───────────────────────────

describe("mergeExecutionWorkspaceMetadataPatch", () => {
  it("drops direct metadata.config writes while preserving existing config", () => {
    const result = mergeExecutionWorkspaceMetadataPatch({
      existingMetadata: {
        config: { provisionCommand: "pnpm install" },
        existing: "not preserved",
      },
      incomingMetadata: {
        note: "updated",
        config: { provisionCommand: "malicious" },
      },
    });

    expect(result).toEqual({
      note: "updated",
      config: { provisionCommand: "pnpm install" },
    });
  });

  it("does not accept direct metadata.config when no existing config exists", () => {
    const result = mergeExecutionWorkspaceMetadataPatch({
      existingMetadata: null,
      incomingMetadata: {
        note: "updated",
        config: { workspaceRuntime: { services: [{ command: "pnpm dev" }] } },
      },
    });

    expect(result).toEqual({ note: "updated" });
  });

  it("is safe to use as the metadata base before applying an explicit config patch", () => {
    const metadataBase = mergeExecutionWorkspaceMetadataPatch({
      existingMetadata: null,
      incomingMetadata: {
        config: { provisionCommand: "malicious" },
        note: "updated",
      },
    });

    expect(mergeExecutionWorkspaceConfig(metadataBase, { cleanupCommand: "pnpm clean" })).toEqual({
      note: "updated",
      config: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: "pnpm clean",
        workspaceRuntime: null,
        desiredState: null,
        serviceStates: null,
      },
    });
  });
});

const execFileAsync = promisify(execFile);
const tempDirsToCleanup = new Set<string>();

async function runGitTest(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-close-readiness-"));
  tempDirsToCleanup.add(repoRoot);
  await runGitTest(repoRoot, ["init", "--initial-branch=main"]);
  await runGitTest(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGitTest(repoRoot, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGitTest(repoRoot, ["add", "README.md"]);
  await runGitTest(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

afterEach(async () => {
  setDeploymentMode("local_trusted");
  const dirs = Array.from(tempDirsToCleanup);
  tempDirsToCleanup.clear();
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe("inspectGitCloseReadiness", () => {
  it("cloud mode refuses before inspecting a local Git workspace", async () => {
    const repoRoot = await createTempRepo();
    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: repoRoot,
      providerRef: repoRoot,
      baseRef: "main",
      branchName: "main",
    });
    const previousOverride = process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
    delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
    setDeploymentMode("cloud_auth");

    try {
      await expect(inspectGitCloseReadiness(workspace)).rejects.toThrow(
        "Refusing to dispatch a workspace Git close-readiness command",
      );
    } finally {
      if (previousOverride === undefined) {
        delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
      } else {
        process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV] = previousOverride;
      }
      setDeploymentMode("local_trusted");
    }
  });

  it("returns null git when providerType is adapter_managed + no repo metadata", async () => {
    const workspace = buildExecutionWorkspace({
      providerType: "adapter_managed",
      cwd: null,
      repoUrl: null,
      baseRef: null,
      branchName: null,
      providerRef: null,
    });
    const { git } = await inspectGitCloseReadiness(workspace);
    expect(git).toBeNull();
  });

  it("warns when workspacePath is missing for git_worktree", async () => {
    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: null,
      providerRef: null,
    });
    const { git, warnings } = await inspectGitCloseReadiness(workspace);
    expect(git).toBeNull();
    expect(warnings.some((w) => w.includes("no local path"))).toBe(true);
  });

  it("warns when workspacePath does not exist but returns placeholder git info", async () => {
    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: "/definitely/does/not/exist/aoa-test",
      providerRef: "/definitely/does/not/exist/aoa-test",
    });
    const { git, warnings } = await inspectGitCloseReadiness(workspace);
    expect(warnings.some((w) => w.includes("does not exist"))).toBe(true);
    expect(git).not.toBeNull();
    expect(git?.dirtyEntryCount).toBe(0);
    expect(git?.untrackedEntryCount).toBe(0);
    expect(git?.repoRoot).toBeNull();
  });

  it("parses dirty + untracked file counts accurately", async () => {
    const repoRoot = await createTempRepo();
    // Modify tracked file
    await fs.writeFile(path.join(repoRoot, "README.md"), "modified\n", "utf8");
    // Add untracked files
    await fs.writeFile(path.join(repoRoot, "new.txt"), "x\n", "utf8");
    await fs.writeFile(path.join(repoRoot, "another.txt"), "y\n", "utf8");

    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: repoRoot,
      providerRef: repoRoot,
      baseRef: "main",
      branchName: "main",
    });
    const { git } = await inspectGitCloseReadiness(workspace);
    expect(git).not.toBeNull();
    expect(git?.hasDirtyTrackedFiles).toBe(true);
    expect(git?.dirtyEntryCount).toBe(1);
    expect(git?.hasUntrackedFiles).toBe(true);
    expect(git?.untrackedEntryCount).toBe(2);
  });

  it("computes isMergedIntoBase=true for a clean branch at base", async () => {
    const repoRoot = await createTempRepo();
    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: repoRoot,
      providerRef: repoRoot,
      baseRef: "main",
      branchName: "main",
    });
    const { git } = await inspectGitCloseReadiness(workspace);
    expect(git?.isMergedIntoBase).toBe(true);
    expect(git?.aheadCount).toBe(0);
    expect(git?.behindCount).toBe(0);
  });

  it("reports ahead count + isMergedIntoBase=false when branch advances past base", async () => {
    const repoRoot = await createTempRepo();
    await runGitTest(repoRoot, ["checkout", "-b", "feature"]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "feature\n", "utf8");
    await runGitTest(repoRoot, ["add", "feature.txt"]);
    await runGitTest(repoRoot, ["commit", "-m", "feature commit"]);

    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: repoRoot,
      providerRef: repoRoot,
      baseRef: "main",
      branchName: "feature",
    });
    const { git } = await inspectGitCloseReadiness(workspace);
    expect(git?.aheadCount).toBe(1);
    expect(git?.behindCount).toBe(0);
    expect(git?.isMergedIntoBase).toBe(false);
  });

  it("surfaces createdByRuntime from workspace metadata", async () => {
    const repoRoot = await createTempRepo();
    const workspace = buildExecutionWorkspace({
      providerType: "git_worktree",
      cwd: repoRoot,
      providerRef: repoRoot,
      baseRef: "main",
      branchName: "main",
      metadata: { createdByRuntime: true },
    });
    const { git } = await inspectGitCloseReadiness(workspace);
    expect(git?.createdByRuntime).toBe(true);
  });
});

// ── executionWorkspaceService.getCloseReadiness ──────────────────────────────

describe("executionWorkspaceService.getCloseReadiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when workspace is not found", async () => {
    const { db } = createMockDb({
      selects: [[]], // workspace lookup returns empty
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("missing");
    expect(result).toBeNull();
  });

  it("state=blocked when workspace has active linked issues (non-shared mode)", async () => {
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
        })], // workspace
        [], // runtime services
        [{ id: "issue-1", identifier: "FOO-1", title: "Do the thing", status: "todo" }], // linked issues
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result).not.toBeNull();
    expect(result?.state).toBe("blocked");
    expect(result?.blockingReasons.length).toBeGreaterThan(0);
    expect(result?.isDestructiveCloseAllowed).toBe(false);
    expect(result?.linkedIssues).toHaveLength(1);
    expect(result?.linkedIssues[0]?.isTerminal).toBe(false);
  });

  it("converts blocker to warning in shared_workspace mode", async () => {
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "shared_workspace",
        })],
        [], // runtime services
        [{ id: "issue-1", identifier: "FOO-1", title: "Linked", status: "todo" }], // linked issues
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result?.state).toBe("ready_with_warnings");
    expect(result?.blockingReasons).toEqual([]);
    expect(result?.warnings.some((w) => w.includes("detach"))).toBe(true);
    expect(result?.isSharedWorkspace).toBe(true);
  });

  it("state=ready when no issues, no services, no git inspection needed", async () => {
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
        })],
        [], // runtime services empty
        [], // linked issues empty
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result?.state).toBe("ready");
    expect(result?.plannedActions.map((a) => a.kind)).toEqual(["archive_record"]);
  });

  it("planned actions include git_worktree_remove for git_worktree provider", async () => {
    const repoRoot = await createTempRepo();
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "git_worktree",
          cwd: repoRoot,
          providerRef: repoRoot,
          branchName: "main",
          baseRef: "main",
          mode: "isolated_workspace",
          metadata: { createdByRuntime: true },
        })],
        [], // runtime services
        [], // linked issues
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result).not.toBeNull();
    const kinds = result!.plannedActions.map((a) => a.kind);
    expect(kinds).toContain("archive_record");
    expect(kinds).toContain("git_worktree_remove");
    // createdByRuntime + branch is_merged_into_base + branchName set → git_branch_delete
    expect(kinds).toContain("git_branch_delete");
  });

  it("omits git_branch_delete when createdByRuntime is false", async () => {
    const repoRoot = await createTempRepo();
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "git_worktree",
          cwd: repoRoot,
          providerRef: repoRoot,
          branchName: "main",
          baseRef: "main",
          mode: "isolated_workspace",
          metadata: { createdByRuntime: false },
        })],
        [],
        [],
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result!.plannedActions.map((a) => a.kind)).not.toContain("git_branch_delete");
  });

  it("refuses remove_local_directory when workspace path contains project workspace", async () => {
    const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-close-parent-"));
    tempDirsToCleanup.add(parentDir);
    const projectWorkspaceDir = path.join(parentDir, "project");
    await fs.mkdir(projectWorkspaceDir, { recursive: true });

    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "local_fs",
          cwd: parentDir,
          providerRef: parentDir,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
          projectWorkspaceId: "pw-1",
          metadata: { createdByRuntime: true },
        })],
        [], // runtime services
        [], // linked issues
        [{ id: "pw-1", cwd: projectWorkspaceDir, cleanupCommand: null, isPrimary: true }], // projectWorkspace
        [{ id: "pw-1" }], // primaryProjectWorkspace
        [], // projectPolicy
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result!.plannedActions.map((a) => a.kind)).not.toContain("remove_local_directory");
    expect(result!.warnings.some((w) => w.includes("contains the project workspace"))).toBe(true);
  });

  it("includes cleanup_command from config + project workspace", async () => {
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
          projectWorkspaceId: "pw-1",
          metadata: {
            createdByRuntime: false,
            config: {
              cleanupCommand: "pnpm clean",
              provisionCommand: null,
              teardownCommand: null,
              workspaceRuntime: null,
            },
          },
        })],
        [], // runtime services
        [], // linked issues
        [{ id: "pw-1", cwd: null, cleanupCommand: "make clean", isPrimary: false }], // projectWorkspace
        [], // primaryProjectWorkspace
        [], // projectPolicy
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    const cleanupActions = result!.plannedActions.filter((a) => a.kind === "cleanup_command");
    expect(cleanupActions).toHaveLength(2);
    expect(cleanupActions.map((a) => a.command)).toEqual(["pnpm clean", "make clean"]);
  });

  it("adds stop_runtime_services action when any service is not stopped", async () => {
    const now = new Date("2026-04-22T00:00:00Z");
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
        })],
        [
          // one running service
          {
            id: "svc-1",
            companyId: "co-1",
            projectId: null,
            projectWorkspaceId: null,
            executionWorkspaceId: "ws-1",
            issueId: null,
            scopeType: "execution_workspace",
            scopeId: "ws-1",
            serviceName: "api",
            status: "running",
            lifecycle: "shared",
            reuseKey: null,
            command: "npm start",
            cwd: null,
            port: 3000,
            url: null,
            provider: "local_process",
            providerRef: null,
            ownerAgentId: null,
            startedByRunId: null,
            lastUsedAt: now,
            startedAt: now,
            stoppedAt: null,
            stopPolicy: null,
            healthStatus: "healthy",
            createdAt: now,
            updatedAt: now,
          },
        ],
        [], // linked issues
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    const kinds = result!.plannedActions.map((a) => a.kind);
    expect(kinds).toContain("stop_runtime_services");
    expect(result!.warnings.some((w) => w.includes("stop 1 attached runtime service"))).toBe(true);
    expect(result!.runtimeServices).toHaveLength(1);
  });

  it("returns terminal-status issues without blocking", async () => {
    const { db } = createMockDb({
      selects: [
        [buildWorkspaceRow({
          providerType: "adapter_managed",
          cwd: null,
          providerRef: null,
          branchName: null,
          baseRef: null,
          repoUrl: null,
          mode: "isolated_workspace",
        })],
        [],
        [
          { id: "issue-1", identifier: "FOO-1", title: "Completed", status: "done" },
          { id: "issue-2", identifier: "FOO-2", title: "Cancelled", status: "cancelled" },
        ],
      ],
    });
    const svc = executionWorkspaceService(db);
    const result = await svc.getCloseReadiness("ws-1");
    expect(result?.state).toBe("ready");
    expect(result?.blockingReasons).toEqual([]);
    expect(result?.linkedIssues).toHaveLength(2);
    expect(result?.linkedIssues.every((i) => i.isTerminal)).toBe(true);
  });
});

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areRuntimeServicesTrackedLocally,
  buildRuntimeServiceProcessTreeKillCommand,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  normalizeAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  refreshAdapterManagedPreviewRuntimeServiceRows,
  refreshLocalProcessRuntimeServiceRows,
  refreshPersistedRuntimeServiceRows,
  resolveRuntimeServiceReadinessOptions,
  RuntimeServiceActivationFenceError,
  startLocalRuntimeService,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  terminateChildProcess,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { resolveAoaConfigPath } from "../paths.ts";
import type { WorkspaceOperation } from "@armyofagents/shared";
import type { WorkspaceOperationRecorder } from "../services/workspace-operations.ts";
import { setDeploymentMode } from "../config/deployment-mode.ts";

const execFileAsync = promisify(execFile);
const leasedRunIds = new Set<string>();

async function expectSameRealPath(actual: string, expected: string): Promise<void> {
  await expect(fs.realpath(actual)).resolves.toBe(await fs.realpath(expected));
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function expectLinuxProcessExited(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    expect(err).toMatchObject({ code: "ESRCH" });
    return;
  }

  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    expect(closeParen).toBeGreaterThanOrEqual(0);
    expect(stat.slice(closeParen + 2).split(" ")[0]).toBe("Z");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

describe("runtime service process cleanup", () => {
  it("uses taskkill tree mode for Windows runtime service cleanup", () => {
    expect(buildRuntimeServiceProcessTreeKillCommand(1234, "win32")).toEqual({
      command: "taskkill.exe",
      args: ["/PID", "1234", "/T", "/F"],
    });

    expect(buildRuntimeServiceProcessTreeKillCommand(1234, "linux")).toBeNull();
  });

  it("escalates a POSIX process group to SIGKILL and confirms exit", async () => {
    const signal = vi.fn();
    const waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const child = { pid: 1234, kill: vi.fn() } as unknown as ChildProcess;

    await expect(terminateChildProcess(child, {
      platform: "linux",
      signal,
      waitForExit,
    })).resolves.toBe(true);

    expect(signal).toHaveBeenNthCalledWith(1, -1234, "SIGTERM");
    expect(signal).toHaveBeenNthCalledWith(2, -1234, "SIGKILL");
    expect(waitForExit).toHaveBeenNthCalledWith(1, -1234, 500);
    expect(waitForExit).toHaveBeenNthCalledWith(2, -1234, 2_000);
  });

  it("does not claim Windows tree termination when taskkill cannot confirm it", async () => {
    const runWindowsTreeKill = vi.fn().mockRejectedValue(new Error("taskkill unavailable"));
    const waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const kill = vi.fn();
    const child = { pid: 1234, kill } as unknown as ChildProcess;

    await expect(terminateChildProcess(child, {
      platform: "win32",
      runWindowsTreeKill,
      waitForExit,
    })).resolves.toBe(false);

    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.skipIf(process.platform === "win32")(
    "kills a detached process that ignores SIGTERM before reporting success",
    async () => {
      const child = spawn(process.execPath, [
        "-e",
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
      ], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pid = child.pid!;

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("child did not become ready")), 2_000);
          child.stdout!.once("data", () => {
            clearTimeout(timer);
            resolve();
          });
          child.once("error", reject);
        });

        await expect(terminateChildProcess(child)).resolves.toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Expected after the termination assertion succeeds.
        }
      }
    },
    10_000,
  );
});

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-repo-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  await runGit(repoRoot, ["checkout", "-B", "main"]);
  return repoRoot;
}

function buildWorkspace(cwd: string): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "project_primary",
    cwd,
    branchName: null,
    worktreePath: null,
    warnings: [],
    created: false,
  };
}

function createWorkspaceOperationRecorderDouble() {
  const operations: Array<{
    phase: string;
    command: string | null;
    cwd: string | null;
    metadata: Record<string, unknown> | null;
    result: {
      status?: string;
      exitCode?: number | null;
      stdout?: string | null;
      stderr?: string | null;
      system?: string | null;
      metadata?: Record<string, unknown> | null;
    };
  }> = [];
  let executionWorkspaceId: string | null = null;

  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async (nextExecutionWorkspaceId) => {
      executionWorkspaceId = nextExecutionWorkspaceId;
    },
    recordOperation: async (input) => {
      const result = await input.run();
      operations.push({
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        metadata: {
          ...(input.metadata ?? {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
        },
        result,
      });
      return {
        id: `op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId,
        heartbeatRunId: "run-1",
        phase: input.phase,
        command: input.command ?? null,
        cwd: input.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: "local_file",
        logRef: `op-${operations.length}.ndjson`,
        logBytes: 0,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: input.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  return { recorder, operations };
}

function createConcurrentWorktreeCreationRecorder(input: {
  repoRoot: string;
  branchName: string;
  worktreePath: string;
}) {
  let injected = false;
  const operations: string[] = [];

  const recorder: WorkspaceOperationRecorder = {
    attachExecutionWorkspaceId: async () => undefined,
    recordOperation: async (operationInput) => {
      operations.push(operationInput.command ?? "");
      if (
        !injected &&
        operationInput.phase === "worktree_prepare" &&
        operationInput.command?.includes("git worktree add") &&
        operationInput.command.includes(input.branchName)
      ) {
        injected = true;
        await runGit(input.repoRoot, [
          "worktree",
          "add",
          "-b",
          input.branchName,
          input.worktreePath,
          "HEAD",
        ]);
      }

      const result = await operationInput.run();
      return {
        id: `race-op-${operations.length}`,
        companyId: "company-1",
        executionWorkspaceId: null,
        heartbeatRunId: "run-1",
        phase: operationInput.phase,
        command: operationInput.command ?? null,
        cwd: operationInput.cwd ?? null,
        status: (result.status ?? "succeeded") as WorkspaceOperation["status"],
        exitCode: result.exitCode ?? null,
        logStore: "local_file",
        logRef: `race-op-${operations.length}.ndjson`,
        logBytes: 0,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: result.stdout ?? null,
        stderrExcerpt: result.stderr ?? null,
        metadata: operationInput.metadata ?? null,
        startedAt: new Date(),
        finishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  };

  return { recorder, operations };
}

afterEach(async () => {
  await Promise.all(
    Array.from(leasedRunIds).map(async (runId) => {
      await releaseRuntimeServicesForRun(runId);
      leasedRunIds.delete(runId);
    }),
  );
  delete process.env.AOA_CONFIG;
  delete process.env.AOA_HOME;
  delete process.env.AOA_INSTANCE_ID;
  delete process.env.AOA_WORKTREES_DIR;
  delete process.env.DATABASE_URL;
  setDeploymentMode("local_trusted");
});

describe("resolveRuntimeServiceReadinessOptions", () => {
  it("uses the dev-server-aware readiness timeout when starting services", () => {
    expect(resolveRuntimeServiceReadinessOptions({
      service: {
        name: "web",
        command: "pnpm dev",
        readiness: { type: "http" },
      },
    })).toEqual({ type: "http", timeoutSec: 90, intervalMs: 500 });
  });
});

describe("realizeExecutionWorkspace", () => {
  it("creates and reuses a git worktree for an issue-scoped branch", async () => {
    const repoRoot = await createTempRepo();

    const first = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(first.strategy).toBe("git_worktree");
    expect(first.created).toBe(true);
    expect(first.branchName).toBe("PAP-447-add-worktree-support");
    expect(first.cwd).toContain(path.join(".aoa", "worktrees"));
    await expect(fs.stat(path.join(first.cwd, ".git"))).resolves.toBeTruthy();

    const second = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Add Worktree Support",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(second.created).toBe(false);
    expect(second.cwd).toBe(first.cwd);
    expect(second.branchName).toBe(first.branchName);
  });

  it("reuses a worktree created concurrently between path check and git add", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-451-concurrent-worktree-race";
    const worktreePath = path.join(repoRoot, ".aoa", "worktrees", branchName);
    const { recorder, operations } = createConcurrentWorktreeCreationRecorder({
      repoRoot,
      branchName,
      worktreePath,
    });

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Concurrent worktree race",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(workspace.created).toBe(false);
    expect(workspace.branchName).toBe(branchName);
    await expectSameRealPath(workspace.cwd, worktreePath);
    expect(operations.filter((command) => command.includes("git worktree add"))).toHaveLength(1);

    const currentBranch = (
      await execFileAsync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspace.cwd })
    ).stdout.trim();
    expect(currentBranch).toBe(branchName);
  });

  // Skipped on Windows: provision script is bash with `#!/usr/bin/env bash`
  // shebang and `set -euo pipefail`. Production runWorkspaceCommand() falls
  // back to /bin/sh when SHELL is unset, which the Windows runner does not
  // provide. Shell-specific behavior — skip rather than rewrite. (Issue #113)
  it.skipIf(process.platform === "win32")("runs a configured provision command inside the derived worktree", async () => {
    const repoRoot = await createTempRepo();
    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf '%s\\n' \"$AOA_WORKSPACE_BRANCH\" > .aoa-provision-branch",
        "printf '%s\\n' \"$AOA_WORKSPACE_BASE_CWD\" > .aoa-provision-base",
        "printf '%s\\n' \"$AOA_WORKSPACE_CREATED\" > .aoa-provision-created",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(workspace.cwd, ".aoa-provision-branch"), "utf8")).resolves.toBe(
      "PAP-448-run-provision-command\n",
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".aoa-provision-base"), "utf8")).resolves.toBe(
      `${repoRoot}\n`,
    );
    await expect(fs.readFile(path.join(workspace.cwd, ".aoa-provision-created"), "utf8")).resolves.toBe(
      "true\n",
    );

    const reused = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-448",
        title: "Run provision command",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await expect(fs.readFile(path.join(reused.cwd, ".aoa-provision-created"), "utf8")).resolves.toBe("false\n");
  });

  // Skipped on Windows: provisionCommand uses a bash script. (Issue #113)
  it.skipIf(process.platform === "win32")("writes an isolated repo-local Paperclip config and worktree branding when provisioning", async () => {
    const repoRoot = await createTempRepo();
    const previousCwd = process.cwd();
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktree-home-"));
    const isolatedWorktreeHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-worktrees-"));
    const instanceId = "worktree-base";
    const sharedConfigDir = path.join(paperclipHome, "instances", instanceId);
    const sharedConfigPath = path.join(sharedConfigDir, "config.json");
    const sharedEnvPath = path.join(sharedConfigDir, ".env");

    process.env.AOA_HOME = paperclipHome;
    process.env.AOA_INSTANCE_ID = instanceId;
    process.env.AOA_WORKTREES_DIR = isolatedWorktreeHome;

    await fs.mkdir(sharedConfigDir, { recursive: true });
    await fs.writeFile(
      sharedConfigPath,
      JSON.stringify(
        {
          $meta: {
            version: 1,
            updatedAt: "2026-03-26T00:00:00.000Z",
            source: "doctor",
          },
          database: {
            mode: "embedded-postgres",
            embeddedPostgresDataDir: path.join(sharedConfigDir, "db"),
            embeddedPostgresPort: 54329,
            backup: {
              enabled: true,
              intervalMinutes: 60,
              retentionDays: 30,
              dir: path.join(sharedConfigDir, "backups"),
            },
          },
          logging: {
            mode: "file",
            logDir: path.join(sharedConfigDir, "logs"),
          },
          server: {
            deploymentMode: "local_trusted",
            exposure: "private",
            host: "127.0.0.1",
            port: 3100,
            allowedHostnames: [],
            serveUi: true,
          },
          auth: {
            baseUrlMode: "auto",
            disableSignUp: false,
          },
          storage: {
            provider: "local_disk",
            localDisk: {
              baseDir: path.join(sharedConfigDir, "storage"),
            },
            s3: {
              bucket: "paperclip",
              region: "us-east-1",
              prefix: "",
              forcePathStyle: false,
            },
          },
          secrets: {
            provider: "local_encrypted",
            strictMode: false,
            localEncrypted: {
              keyFilePath: path.join(sharedConfigDir, "master.key"),
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    await fs.writeFile(sharedEnvPath, 'DATABASE_URL="postgres://worktree:test@db.example.com:6543/paperclip"\n', "utf8");

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.copyFile(
      fileURLToPath(new URL("../../../scripts/provision-worktree.sh", import.meta.url)),
      path.join(repoRoot, "scripts", "provision-worktree.sh"),
    );
    await runGit(repoRoot, ["add", "scripts/provision-worktree.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add worktree provision script"]);

    try {
      const workspace = await realizeExecutionWorkspace({
        base: {
          baseCwd: repoRoot,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "HEAD",
        },
        config: {
          workspaceStrategy: {
            type: "git_worktree",
            branchTemplate: "{{issue.identifier}}-{{slug}}",
            provisionCommand: "bash ./scripts/provision-worktree.sh",
          },
        },
        issue: {
          id: "issue-1",
          identifier: "PAP-885",
          title: "Show worktree banner",
        },
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
      });

      const configPath = path.join(workspace.cwd, ".aoa", "config.json");
      const envPath = path.join(workspace.cwd, ".aoa", ".env");
      const envContents = await fs.readFile(envPath, "utf8");
      const configContents = JSON.parse(await fs.readFile(configPath, "utf8"));
      const configStats = await fs.lstat(configPath);
      const expectedInstanceId = "pap-885-show-worktree-banner";
      const expectedInstanceRoot = path.join(
        isolatedWorktreeHome,
        "instances",
        expectedInstanceId,
      );

      expect(configStats.isSymbolicLink()).toBe(false);
      expect(configContents.database.embeddedPostgresDataDir).toBe(path.join(expectedInstanceRoot, "db"));
      expect(configContents.database.embeddedPostgresDataDir).not.toBe(path.join(sharedConfigDir, "db"));
      expect(configContents.server.port).not.toBe(3100);
      expect(configContents.secrets.localEncrypted.keyFilePath).toBe(
        path.join(expectedInstanceRoot, "secrets", "master.key"),
      );
      expect(envContents).not.toContain("DATABASE_URL=");
      expect(envContents).toContain(`AOA_HOME=${JSON.stringify(isolatedWorktreeHome)}`);
      expect(envContents).toContain(`AOA_INSTANCE_ID=${JSON.stringify(expectedInstanceId)}`);
      expect(envContents).toContain(`AOA_CONFIG=${JSON.stringify(configPath)}`);
      expect(envContents).toContain("AOA_IN_WORKTREE=true");
      expect(envContents).toContain(
        `AOA_WORKTREE_NAME=${JSON.stringify("PAP-885-show-worktree-banner")}`,
      );

      process.chdir(workspace.cwd);
      expect(resolveAoaConfigPath()).toBe(configPath);
    } finally {
      process.chdir(previousCwd);
    }
  });

  // Skipped on Windows: provisionCommand uses a bash script. (Issue #113)
  it.skipIf(process.platform === "win32")("records worktree setup and provision operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    await fs.mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "scripts", "provision.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "printf 'provisioned\\n'",
      ].join("\n"),
      "utf8",
    );
    await runGit(repoRoot, ["add", "scripts/provision.sh"]);
    await runGit(repoRoot, ["commit", "-m", "Add recorder provision script"]);

    await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
          provisionCommand: "bash ./scripts/provision.sh",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-540",
        title: "Record workspace operations",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "worktree_prepare",
      "workspace_provision",
    ]);
    expect(operations[0]?.command).toContain("git worktree add");
    expect(operations[0]?.metadata).toMatchObject({
      branchName: "PAP-540-record-workspace-operations",
      created: true,
    });
    expect(operations[1]?.command).toBe("bash ./scripts/provision.sh");
  });

  it("reuses an existing branch without resetting it when recreating a missing worktree", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "PAP-450-recreate-missing-worktree";

    await runGit(repoRoot, ["checkout", "-b", branchName]);
    await fs.writeFile(path.join(repoRoot, "feature.txt"), "preserve me\n", "utf8");
    await runGit(repoRoot, ["add", "feature.txt"]);
    await runGit(repoRoot, ["commit", "-m", "Add preserved feature"]);
    const expectedHead = (await execFileAsync("git", ["rev-parse", branchName], { cwd: repoRoot })).stdout.trim();
    await runGit(repoRoot, ["checkout", "main"]);

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-450",
        title: "Recreate missing worktree",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    expect(workspace.branchName).toBe(branchName);
    const featureContent = await fs.readFile(path.join(workspace.cwd, "feature.txt"), "utf8");
    expect(featureContent.replace(/\r\n/g, "\n")).toBe("preserve me\n");
    const actualHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd })).stdout.trim();
    expect(actualHead).toBe(expectedHead);
  });

  it("removes a created git worktree and branch during cleanup", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-449",
        title: "Cleanup workspace",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([]);
    await expect(fs.stat(workspace.cwd)).rejects.toThrow();
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: "",
    });
  });

  it("preserves a forged runtime-created local path outside approved roots", async () => {
    const victimRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cleanup-victim-"));
    const marker = path.join(victimRoot, "keep.txt");
    await fs.writeFile(marker, "keep", "utf8");

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-forged-path",
        cwd: victimRoot,
        providerType: "local_fs",
        providerRef: victimRoot,
        branchName: null,
        repoUrl: null,
        baseRef: null,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        sourceIssueId: "issue-1",
        metadata: { createdByRuntime: true },
      },
      projectWorkspace: {
        cwd: path.join(victimRoot, "..", "unrelated-project"),
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toEqual([
      expect.stringContaining("outside approved runtime workspace roots"),
    ]);
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("keep");
  });

  it("keeps an unmerged runtime-created branch and warns instead of force deleting it", async () => {
    const repoRoot = await createTempRepo();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-451",
        title: "Keep unmerged branch",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await fs.writeFile(path.join(workspace.cwd, "unmerged.txt"), "still here\n", "utf8");
    await runGit(workspace.cwd, ["add", "unmerged.txt"]);
    await runGit(workspace.cwd, ["commit", "-m", "Keep unmerged work"]);

    const cleanup = await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: null,
      },
    });

    expect(cleanup.cleaned).toBe(true);
    expect(cleanup.warnings).toHaveLength(1);
    expect(cleanup.warnings[0]).toContain(`Skipped deleting branch "${workspace.branchName}"`);
    await expect(
      execFileAsync("git", ["branch", "--list", workspace.branchName!], { cwd: repoRoot }),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(workspace.branchName!),
    });
  });

  // Skipped on Windows: cleanupCommand uses `printf` which is not available
  // on the Windows runner. Same shell-availability constraint as the
  // provision-command tests below (Issue #113).
  it.skipIf(process.platform === "win32")("records teardown and cleanup operations when a recorder is provided", async () => {
    const repoRoot = await createTempRepo();
    const { recorder, operations } = createWorkspaceOperationRecorderDouble();

    const workspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: repoRoot,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "HEAD",
      },
      config: {
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-541",
        title: "Cleanup recorder",
      },
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
    });

    await cleanupExecutionWorkspaceArtifacts({
      workspace: {
        id: "execution-workspace-1",
        cwd: workspace.cwd,
        providerType: "git_worktree",
        providerRef: workspace.worktreePath,
        branchName: workspace.branchName,
        repoUrl: workspace.repoUrl,
        baseRef: workspace.repoRef,
        projectId: workspace.projectId,
        projectWorkspaceId: workspace.workspaceId,
        sourceIssueId: "issue-1",
        metadata: {
          createdByRuntime: true,
        },
      },
      projectWorkspace: {
        cwd: repoRoot,
        cleanupCommand: "printf 'cleanup ok\\n'",
      },
      recorder,
    });

    expect(operations.map((operation) => operation.phase)).toEqual([
      "workspace_teardown",
      "worktree_cleanup",
      "worktree_cleanup",
    ]);
    expect(operations[0]?.command).toBe("printf 'cleanup ok\\n'");
    expect(operations[1]?.metadata).toMatchObject({
      cleanupAction: "worktree_remove",
    });
    expect(operations[2]?.metadata).toMatchObject({
      cleanupAction: "branch_delete",
    });
  });
});

describe("ensureRuntimeServicesForRun", () => {
  it("rejects and rolls back the whole run batch when an earlier service exits during later readiness", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-run-late-exit-"));
    const workspace = buildWorkspace(workspaceRoot);
    const delayedReadyService = {
      name: "delayed-ready-survivor",
      command: "node -e \"setTimeout(() => require('node:http').createServer((_, r) => r.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'), 700); setInterval(() => {}, 1000)\"",
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      port: { type: "auto" },
      readiness: {
        type: "http",
        urlTemplate: "http://127.0.0.1:{{port}}",
        timeoutSec: 3,
        intervalMs: 100,
      },
      stopPolicy: { type: "manual" },
    };
    const common = {
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-run-late-exit" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-run-late-exit",
      adapterEnv: {},
    };

    await expect(ensureRuntimeServicesForRun({
      ...common,
      runId: "run-late-exit",
      config: {
        workspaceRuntime: {
          services: [
            { name: "exits-early", command: "node -e \"setTimeout(() => process.exit(0), 100)\"" },
            delayedReadyService,
          ],
        },
      },
    })).rejects.toBeInstanceOf(RuntimeServiceActivationFenceError);

    const retry = await startRuntimeServicesForWorkspaceControl({
      ...common,
      actor: common.agent,
      config: { workspaceRuntime: { services: [delayedReadyService] } },
    });
    expect(retry[0]?.reused).toBe(false);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: common.executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    });
  }, 15_000);

  it("rolls back a shared manual service when a later run service fails", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-run-batch-"));
    const workspace = buildWorkspace(workspaceRoot);
    const sharedService = {
      name: "run-batch-shared",
      command: "node -e \"setInterval(() => {}, 1000)\"",
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      stopPolicy: { type: "manual" },
    };
    const common = {
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-run-batch" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-run-batch",
      adapterEnv: {},
    };

    await expect(ensureRuntimeServicesForRun({
      ...common,
      runId: "run-batch-failed",
      config: { workspaceRuntime: { services: [sharedService, { name: "missing-command" }] } },
    })).rejects.toThrow(/missing command/);

    const retry = await startRuntimeServicesForWorkspaceControl({
      ...common,
      actor: common.agent,
      config: { workspaceRuntime: { services: [sharedService] } },
    });
    expect(retry[0]?.reused).toBe(false);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: common.executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    });
  });

  it("serializes concurrent run acquisition so a failed batch rolls back before the next run starts", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-run-adopt-"));
    const workspace = buildWorkspace(workspaceRoot);
    const sharedService = {
      name: "run-adopted-shared",
      command: "node -e \"setInterval(() => {}, 1000)\"",
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      stopPolicy: { type: "manual" },
    };
    const common = {
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-run-adopt" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-run-adopt",
      adapterEnv: {},
    };
    const failingRun = ensureRuntimeServicesForRun({
      ...common,
      runId: "run-adopt-failing",
      config: {
        workspaceRuntime: {
          services: [
            sharedService,
            {
              name: "run-never-ready",
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
    const failingOutcome = failingRun.then(
      () => null,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    const successful = await ensureRuntimeServicesForRun({
      ...common,
      runId: "run-adopt-successful",
      config: { workspaceRuntime: { services: [sharedService] } },
    });
    expect(successful[0]?.reused).toBe(false);
    expect(String(await failingOutcome)).toMatch(/Readiness check failed/);
    expect(areRuntimeServicesTrackedLocally([successful[0]!.id])).toBe(true);

    await releaseRuntimeServicesForRun("run-adopt-successful");
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: common.executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    });
  }, 10_000);

  it("still rolls back a failed run batch when lease-release persistence fails", async () => {
    let persistCalls = 0;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            persistCalls += 1;
            if (persistCalls === 3) throw new Error("lease release persistence failed");
          },
        }),
      }),
    } as never;
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-run-release-fail-"));
    const workspace = buildWorkspace(workspaceRoot);
    const sharedService = {
      name: "run-release-fail-shared",
      command: "node -e \"setInterval(() => {}, 1000)\"",
      lifecycle: "shared",
      reuseScope: "execution_workspace",
      stopPolicy: { type: "manual" },
    };
    const common = {
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-run-release-fail" },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-run-release-fail",
      adapterEnv: {},
    };

    await expect(ensureRuntimeServicesForRun({
      ...common,
      db,
      runId: "run-release-fail",
      config: { workspaceRuntime: { services: [sharedService, { name: "missing-command" }] } },
    })).rejects.toThrow(/missing command/);

    const retry = await startRuntimeServicesForWorkspaceControl({
      ...common,
      actor: common.agent,
      config: { workspaceRuntime: { services: [sharedService] } },
    });
    expect(retry[0]?.reused).toBe(false);
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: common.executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    });
  });

  it("releases every service lease even when an earlier persistence operation fails", async () => {
    let persistCalls = 0;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            persistCalls += 1;
            if (persistCalls === 5) throw new Error("release persistence failed");
          },
        }),
      }),
    } as never;
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-release-all-"));
    const services = await ensureRuntimeServicesForRun({
      db,
      runId: "run-release-all",
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace: buildWorkspace(workspaceRoot),
      executionWorkspaceId: "execution-workspace-release-all",
      config: {
        workspaceRuntime: {
          services: ["one", "two"].map((name) => ({
            name,
            command: "node -e \"setInterval(() => {}, 1000)\"",
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: { type: "on_run_finish" },
          })),
        },
      },
      adapterEnv: {},
    });

    expect(services).toHaveLength(2);
    await expect(releaseRuntimeServicesForRun("run-release-all"))
      .rejects.toThrow("release persistence failed");
    expect(areRuntimeServicesTrackedLocally(services.map((service) => service.id))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "terminates a detached service when the final running-state persist fails",
    async () => {
      let persistCalls = 0;
      let processId: number | null = null;
      const db = {
        insert: () => ({
          values: (values: { providerRef?: string | null }) => ({
            onConflictDoUpdate: async () => {
              if (values.providerRef) processId = Number(values.providerRef);
              persistCalls += 1;
              if (persistCalls === 2) throw new Error("final running persist failed");
            },
          }),
        }),
      } as never;
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-final-persist-"));

      await expect(startLocalRuntimeService({
        db,
        runId: "run-final-persist-failure",
        agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace: buildWorkspace(workspaceRoot),
        executionWorkspaceId: "execution-workspace-final-persist-failure",
        adapterEnv: {},
        service: {
          name: "final-persist-failure",
          command: "node -e \"setInterval(() => {}, 1000)\"",
          lifecycle: "ephemeral",
          stopPolicy: { type: "on_run_finish" },
        },
        reuseKey: null,
        scopeType: "run",
        scopeId: "run-final-persist-failure",
      })).rejects.toThrow("final running persist failed");

      expect(processId).not.toBeNull();
      await expectLinuxProcessExited(processId!);
      expect(persistCalls).toBe(3);
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps a stopped service retryable until its terminal state is durable",
    async () => {
      let persistCalls = 0;
      const db = {
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: async () => {
              persistCalls += 1;
              if (persistCalls === 3) throw new Error("terminal persist failed");
            },
          }),
        }),
      } as never;
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-terminal-retry-"));
      const executionWorkspaceId = "execution-workspace-terminal-retry";
      const record = await startLocalRuntimeService({
        db,
        runId: "run-terminal-retry",
        agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace: buildWorkspace(workspaceRoot),
        executionWorkspaceId,
        adapterEnv: {},
        service: {
          name: "terminal-retry",
          command: "node -e \"setInterval(() => {}, 1000)\"",
          lifecycle: "shared",
          stopPolicy: { type: "manual" },
        },
        reuseKey: "terminal-retry",
        scopeType: "execution_workspace",
        scopeId: executionWorkspaceId,
      });

      await expect(stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      })).rejects.toThrow("terminal persist failed");
      expect(areRuntimeServicesTrackedLocally([record.id])).toBe(true);

      await expect(stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId,
        workspaceCwd: workspaceRoot,
      })).resolves.toBeUndefined();
      expect(areRuntimeServicesTrackedLocally([record.id])).toBe(false);
      expect(persistCalls).toBe(4);
    },
    15_000,
  );

  it("observes a rejecting runtime log sink without escaping the service lifecycle", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-log-sink-"));
    const executionWorkspaceId = "execution-workspace-log-sink";
    const onLog = vi.fn(async () => {
      throw new Error("log persistence unavailable");
    });

    const record = await startLocalRuntimeService({
      runId: "run-log-sink",
      agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
      issue: null,
      workspace: buildWorkspace(workspaceRoot),
      executionWorkspaceId,
      adapterEnv: {},
      service: {
        name: "log-sink",
        command: "node -e \"console.log('hello'); setInterval(() => {}, 1000)\"",
        lifecycle: "shared",
        stopPolicy: { type: "manual" },
      },
      onLog,
      reuseKey: "log-sink",
      scopeType: "execution_workspace",
      scopeId: executionWorkspaceId,
    });

    await vi.waitFor(() => expect(onLog).toHaveBeenCalled());
    await expect(stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId,
      workspaceCwd: workspaceRoot,
    })).resolves.toBeUndefined();
    expect(areRuntimeServicesTrackedLocally([record.id])).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "blocks a queued shared start when failed readiness leaves the first process unresolved",
    async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-single-flight-fail-"));
      const workspace = buildWorkspace(workspaceRoot);
      const pidPath = path.join(workspaceRoot, "service-pids.jsonl");
      const command = `node -e ${JSON.stringify(
        `require('node:fs').appendFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: process.pid, pgid: process.ppid }) + '\\n'); setInterval(() => {}, 1000);`,
      )}`;
      const config = {
        workspaceRuntime: {
          services: [{
            name: "never-ready-shared",
            command,
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 1,
              intervalMs: 100,
            },
            stopPolicy: { type: "manual" },
          }],
        },
      };
      const common = {
        agent: { id: "agent-1", name: "Codex Coder", companyId: "company-1" },
        issue: null,
        workspace,
        executionWorkspaceId: "execution-workspace-single-flight-fail",
        config,
        adapterEnv: {},
        terminationDeps: {
          platform: "linux" as const,
          signal: () => undefined,
          waitForExit: async () => false,
        },
      };
      let processGroupId: number | null = null;

      try {
        const results = await Promise.allSettled([
          ensureRuntimeServicesForRun({ ...common, runId: "run-single-flight-fail-1" }),
          ensureRuntimeServicesForRun({ ...common, runId: "run-single-flight-fail-2" }),
        ]);

        expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(results.some((result) =>
          result.status === "rejected" && /stop or reconcile/.test(String(result.reason)),
        )).toBe(true);

        const identities = (await fs.readFile(pidPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; pgid: number });
        expect(identities).toHaveLength(1);
        processGroupId = identities[0]!.pgid;
        expect(() => process.kill(identities[0]!.pid, 0)).not.toThrow();

        await stopRuntimeServicesForExecutionWorkspace({
          executionWorkspaceId: "execution-workspace-single-flight-fail",
          workspaceCwd: workspace.cwd,
        });
        await expectLinuxProcessExited(identities[0]!.pid);
      } finally {
        if (processGroupId) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // Expected when tracked cleanup succeeded.
          }
        }
      }
    },
    15_000,
  );

  it("reuses shared runtime services across runs and starts a new service after release", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-workspace-"));
    const workspace = buildWorkspace(workspaceRoot);
    const serviceCommand =
      "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"";

    const config = {
      workspaceRuntime: {
        services: [
          {
            name: "web",
            command: serviceCommand,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 10,
              intervalMs: 100,
            },
            expose: {
              type: "url",
              urlTemplate: "http://127.0.0.1:{{port}}",
            },
            lifecycle: "shared",
            reuseScope: "project_workspace",
            stopPolicy: {
              type: "on_run_finish",
            },
          },
        ],
      },
    };

    const run1 = "run-1";
    const run2 = "run-2";
    leasedRunIds.add(run1);
    leasedRunIds.add(run2);

    const first = await ensureRuntimeServicesForRun({
      runId: run1,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(first).toHaveLength(1);
    expect(first[0]?.reused).toBe(false);
    expect(first[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(first[0]!.url!);
    expect(await response.text()).toBe("ok");

    const second = await ensureRuntimeServicesForRun({
      runId: run2,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(second).toHaveLength(1);
    expect(second[0]?.reused).toBe(true);
    expect(second[0]?.id).toBe(first[0]?.id);

    const persistFailureDb = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: async () => {
            throw new Error("persist reuse failed");
          },
        }),
      }),
    } as never;
    await expect(ensureRuntimeServicesForRun({
      db: persistFailureDb,
      runId: "run-persist-failure",
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    })).rejects.toThrow("persist reuse failed");

    await releaseRuntimeServicesForRun(run1);
    leasedRunIds.delete(run1);
    await releaseRuntimeServicesForRun(run2);
    leasedRunIds.delete(run2);

    const run3 = "run-3";
    leasedRunIds.add(run3);
    const third = await ensureRuntimeServicesForRun({
      runId: run3,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      config,
      adapterEnv: {},
    });

    expect(third).toHaveLength(1);
    expect(third[0]?.reused).toBe(false);
    expect(third[0]?.id).not.toBe(first[0]?.id);
  });

  it.skipIf(process.platform === "win32")("does not leak parent Paperclip instance env into runtime service commands", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-env-"));
    const workspace = buildWorkspace(workspaceRoot);
    const envCapturePath = path.join(workspaceRoot, "captured-env.json");
    const serviceCommand = [
      "node -e",
      JSON.stringify(
        [
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(envCapturePath)}, JSON.stringify({`,
          "paperclipConfig: process.env.AOA_CONFIG ?? null,",
          "paperclipHome: process.env.AOA_HOME ?? null,",
          "paperclipInstanceId: process.env.AOA_INSTANCE_ID ?? null,",
          "databaseUrl: process.env.DATABASE_URL ?? null,",
          "customEnv: process.env.RUNTIME_CUSTOM_ENV ?? null,",
          "port: process.env.PORT ?? null,",
          "}));",
          "require('node:http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
        ].join(" "),
      ),
    ].join(" ");

    process.env.AOA_CONFIG = "/tmp/base-paperclip-config.json";
    process.env.AOA_HOME = "/tmp/base-paperclip-home";
    process.env.AOA_INSTANCE_ID = "base-instance";
    process.env.DATABASE_URL = "postgres://shared-db.example.com/paperclip";

    const runId = "run-env";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: serviceCommand,
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "on_run_finish",
              },
            },
          ],
        },
      },
      adapterEnv: {
        RUNTIME_CUSTOM_ENV: "from-adapter",
      },
    });

    expect(services).toHaveLength(1);
    const captured = JSON.parse(await fs.readFile(envCapturePath, "utf8")) as Record<string, string | null>;
    expect(captured.paperclipConfig).toBeNull();
    expect(captured.paperclipHome).toBeNull();
    expect(captured.paperclipInstanceId).toBeNull();
    expect(captured.databaseUrl).toBeNull();
    expect(captured.customEnv).toBe("from-adapter");
    expect(captured.port).toMatch(/^\d+$/);
    expect(services[0]?.executionWorkspaceId).toBe("execution-workspace-1");
    expect(services[0]?.scopeType).toBe("execution_workspace");
    expect(services[0]?.scopeId).toBe("execution-workspace-1");
  });

  it.skipIf(process.platform === "win32")("stops execution workspace runtime services by executionWorkspaceId", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-"));
    const workspace = buildWorkspace(workspaceRoot);
    const runId = "run-stop";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-stop",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    expect(services[0]?.url).toBeTruthy();
    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-stop",
      workspaceCwd: workspace.cwd,
    });
    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await expect(fetch(services[0]!.url!)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "confirms a SIGTERM-resistant descendant exits before completing a tracked stop",
    async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-stop-tree-"));
      const workspace = buildWorkspace(workspaceRoot);
      const runId = "run-stop-tree";
      leasedRunIds.add(runId);
      const descendantScript = [
        "process.on('SIGTERM', () => {});",
        "require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');",
      ].join(" ");
      const command = `trap 'exit 0' TERM; node -e ${JSON.stringify(descendantScript)} & wait`;

      const services = await ensureRuntimeServicesForRun({
        runId,
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        issue: null,
        workspace,
        executionWorkspaceId: "execution-workspace-stop-tree",
        config: {
          workspaceRuntime: {
            services: [
              {
                name: "web",
                command,
                port: { type: "auto" },
                readiness: {
                  type: "http",
                  urlTemplate: "http://127.0.0.1:{{port}}",
                  timeoutSec: 10,
                  intervalMs: 100,
                },
                lifecycle: "shared",
                reuseScope: "execution_workspace",
                stopPolicy: { type: "manual" },
              },
            ],
          },
        },
        adapterEnv: {},
      });

      try {
        await expect(stopRuntimeServicesForExecutionWorkspace({
          executionWorkspaceId: "execution-workspace-stop-tree",
          workspaceCwd: workspace.cwd,
        })).resolves.toBeUndefined();
        await expect(fetch(services[0]!.url!)).rejects.toThrow();
      } finally {
        await releaseRuntimeServicesForRun(runId);
        leasedRunIds.delete(runId);
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps a readiness-failed process tracked when cleanup cannot be confirmed",
    async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-readiness-fail-"));
      const workspace = buildWorkspace(workspaceRoot);
      const pidPath = path.join(workspaceRoot, "service.pid");
      const command = `node -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ pid: process.pid, pgid: process.ppid })); setInterval(() => {}, 1000);`,
      )}`;
      let processGroupId: number | null = null;

      try {
        await expect(startLocalRuntimeService({
          runId: "run-readiness-fail",
          agent: {
            id: "agent-1",
            name: "Codex Coder",
            companyId: "company-1",
          },
          issue: null,
          workspace,
          executionWorkspaceId: "execution-workspace-readiness-fail",
          adapterEnv: {},
          service: {
            name: "never-ready",
            command,
            port: { type: "auto" },
            readiness: {
              type: "http",
              urlTemplate: "http://127.0.0.1:{{port}}",
              timeoutSec: 1,
              intervalMs: 100,
            },
            lifecycle: "shared",
            stopPolicy: { type: "manual" },
          },
          reuseKey: "readiness-fail",
          scopeType: "execution_workspace",
          scopeId: "execution-workspace-readiness-fail",
          terminationDeps: {
            platform: "linux",
            signal: () => undefined,
            waitForExit: async () => false,
          },
        })).rejects.toThrow("process remains tracked as starting/unhealthy");

        const identity = JSON.parse(await fs.readFile(pidPath, "utf8")) as { pid: number; pgid: number };
        const descendantPid = identity.pid;
        processGroupId = identity.pgid;
        expect(() => process.kill(descendantPid, 0)).not.toThrow();

        await stopRuntimeServicesForExecutionWorkspace({
          executionWorkspaceId: "execution-workspace-readiness-fail",
          workspaceCwd: workspace.cwd,
        });
        await expectLinuxProcessExited(descendantPid);
      } finally {
        if (processGroupId) {
          try {
            process.kill(-processGroupId, "SIGKILL");
          } catch {
            // Expected when the tracked cleanup succeeded.
          }
        }
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "does not signal a stale PID after the readiness child already exited",
    async () => {
      const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-readiness-exit-"));
      const signal = vi.fn();

      await expect(startLocalRuntimeService({
        runId: "run-readiness-exit",
        agent: {
          id: "agent-1",
          name: "Codex Coder",
          companyId: "company-1",
        },
        issue: null,
        workspace: buildWorkspace(workspaceRoot),
        executionWorkspaceId: "execution-workspace-readiness-exit",
        adapterEnv: {},
        service: {
          name: "exits-before-ready",
          command: "node -e \"process.exit(1)\"",
          port: { type: "auto" },
          readiness: {
            type: "http",
            urlTemplate: "http://127.0.0.1:{{port}}",
            timeoutSec: 1,
            intervalMs: 100,
          },
          lifecycle: "shared",
          stopPolicy: { type: "manual" },
        },
        reuseKey: "readiness-exit",
        scopeType: "execution_workspace",
        scopeId: "execution-workspace-readiness-exit",
        terminationDeps: {
          platform: "linux",
          signal,
          waitForExit: async () => true,
        },
      })).rejects.toThrow("Failed to start runtime service");

      expect(signal).not.toHaveBeenCalled();
    },
    10_000,
  );

  it("does not stop services in sibling directories when matching by workspace cwd", async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-sibling-"));
    const targetWorkspaceRoot = path.join(workspaceParent, "project");
    const siblingWorkspaceRoot = path.join(workspaceParent, "project-extended", "service");
    await fs.mkdir(targetWorkspaceRoot, { recursive: true });
    await fs.mkdir(siblingWorkspaceRoot, { recursive: true });

    const siblingWorkspace = buildWorkspace(siblingWorkspaceRoot);
    const runId = "run-sibling";
    leasedRunIds.add(runId);

    const services = await ensureRuntimeServicesForRun({
      runId,
      agent: {
        id: "agent-1",
        name: "Codex Coder",
        companyId: "company-1",
      },
      issue: null,
      workspace: siblingWorkspace,
      executionWorkspaceId: "execution-workspace-sibling",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command:
                "node -e \"require('node:http').createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: {
                type: "manual",
              },
            },
          ],
        },
      },
      adapterEnv: {},
    });

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-target",
      workspaceCwd: targetWorkspaceRoot,
    });

    const response = await fetch(services[0]!.url!);
    expect(await response.text()).toBe("ok");

    await releaseRuntimeServicesForRun(runId);
    leasedRunIds.delete(runId);
  });
});

describe("normalizeAdapterManagedRuntimeServices", () => {
  it("namespaces every adapter service identity branch by company", () => {
    const workspace = buildWorkspace("/tmp/project");
    const reports = [
      {
        id: "adapter-service-1",
        serviceName: "reported-id",
        scopeType: "execution_workspace" as const,
        providerRef: "sandbox-123",
      },
      {
        serviceName: "preview-url",
        scopeType: "execution_workspace" as const,
        url: "https://preview.example/",
        command: null,
        providerRef: null,
      },
      {
        serviceName: "fallback",
        scopeType: "run" as const,
        providerRef: "sandbox-456",
      },
    ];
    const normalizeForCompany = (companyId: string) => normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: { id: `agent-${companyId}`, name: "Gateway Agent", companyId },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports,
    });

    const companyA = normalizeForCompany("company-a");
    const companyB = normalizeForCompany("company-b");
    const companyARepeat = normalizeForCompany("company-a");

    expect(companyA).toHaveLength(3);
    for (let index = 0; index < companyA.length; index += 1) {
      expect(companyA[index]?.id).not.toBe(reports[index]?.id);
      expect(companyA[index]?.id).not.toBe(companyB[index]?.id);
      expect(companyA[index]?.id).toBe(companyARepeat[index]?.id);
    }
  });

  it("fills workspace defaults and derives stable ids for adapter-managed services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const now = new Date("2026-03-09T12:00:00.000Z");

    const first = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    const second = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: {
        id: "issue-1",
        identifier: "PAP-447",
        title: "Worktree support",
      },
      workspace,
      reports: [
        {
          serviceName: "preview",
          url: "https://preview.example/run-1",
          providerRef: "sandbox-123",
          scopeType: "run",
        },
      ],
      now,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      companyId: "company-1",
      projectId: "project-1",
      projectWorkspaceId: "workspace-1",
      executionWorkspaceId: null,
      issueId: "issue-1",
      serviceName: "preview",
      provider: "adapter_managed",
      status: "running",
      healthStatus: "healthy",
      startedByRunId: "run-1",
    });
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(first[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("prefers execution workspace ids over cwd for execution-scoped adapter services", () => {
    const workspace = buildWorkspace("/tmp/project");

    const refs = normalizeAdapterManagedRuntimeServices({
      adapterType: "openclaw_gateway",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Gateway Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "preview",
          scopeType: "execution_workspace",
        },
      ],
    });

    expect(refs[0]).toMatchObject({
      scopeType: "execution_workspace",
      scopeId: "execution-workspace-1",
      executionWorkspaceId: "execution-workspace-1",
    });
  });

  it("deduplicates reports that resolve to the same stable service id", () => {
    const workspace = buildWorkspace("/tmp/project");

    const refs = normalizeAdapterManagedRuntimeServices({
      adapterType: "codex_local",
      runId: "run-1",
      agent: {
        id: "agent-1",
        name: "Codex Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "localhost:54853",
          scopeType: "execution_workspace",
          url: "http://127.0.0.1:54853/",
          port: 54853,
          healthStatus: "healthy",
        },
        {
          serviceName: "localhost:54853",
          scopeType: "execution_workspace",
          url: "http://127.0.0.1:54853/",
          port: 54853,
          healthStatus: "healthy",
        },
      ],
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      serviceName: "localhost:54853",
      scopeType: "execution_workspace",
      scopeId: "execution-workspace-1",
      url: "http://127.0.0.1:54853/",
      port: 54853,
    });
  });

  it("uses the execution workspace and URL as the stable identity for preview services", () => {
    const workspace = buildWorkspace("/tmp/project");
    const commonInput = {
      adapterType: "codex_local",
      agent: {
        id: "agent-1",
        name: "Codex Agent",
        companyId: "company-1",
      },
      issue: null,
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      reports: [
        {
          serviceName: "localhost:54853",
          scopeType: "execution_workspace" as const,
          url: "http://127.0.0.1:54853/",
          port: 54853,
          command: null,
          providerRef: null,
          healthStatus: "healthy" as const,
        },
      ],
    };

    const first = normalizeAdapterManagedRuntimeServices({
      ...commonInput,
      runId: "run-1",
    });
    const second = normalizeAdapterManagedRuntimeServices({
      ...commonInput,
      runId: "run-2",
    });

    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe("refreshAdapterManagedPreviewRuntimeServiceRows", () => {
  const baseRow = {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    executionWorkspaceId: "execution-workspace-1",
    issueId: "issue-1",
    scopeType: "execution_workspace",
    scopeId: "execution-workspace-1",
    serviceName: "localhost:54853",
    status: "running",
    lifecycle: "ephemeral",
    reuseKey: null,
    command: null,
    cwd: "/tmp/project",
    port: 54853,
    url: "http://127.0.0.1:54853/",
    provider: "adapter_managed",
    providerRef: null,
    ownerAgentId: "agent-1",
    startedByRunId: "run-1",
    lastUsedAt: new Date("2026-05-16T00:00:00.000Z"),
    startedAt: new Date("2026-05-16T00:00:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    healthCheckedAt: null,
    createdAt: new Date("2026-05-16T00:00:00.000Z"),
    updatedAt: new Date("2026-05-16T00:00:00.000Z"),
  };

  it("does not probe adapter-managed loopback previews from a cloud control-plane replica", async () => {
    setDeploymentMode("cloud_auth");
    const probeUrl = vi.fn(async () => true);

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [baseRow as any],
      now: new Date("2026-05-17T10:01:00.000Z"),
      ttlMs: 0,
      probeUrl,
    });

    expect(probeUrl).not.toHaveBeenCalled();
    expect(result.rows[0]).toBe(baseRow);
    expect(result.updates).toEqual([]);
  });

  it("does not probe preview rows checked within the TTL", async () => {
    let probes = 0;
    const now = new Date("2026-05-17T10:00:30.000Z");
    const freshRow = {
      ...baseRow,
      healthCheckedAt: new Date("2026-05-17T10:00:10.000Z"),
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [freshRow as any],
      now,
      ttlMs: 30_000,
      probeUrl: async () => {
        probes += 1;
        return false;
      },
    });

    expect(probes).toBe(0);
    expect(result.rows[0]).toBe(freshRow);
    expect(result.updates).toEqual([]);
  });

  it("probes preview rows whose health check is stale", async () => {
    let probes = 0;
    const now = new Date("2026-05-17T10:01:00.000Z");
    const staleRow = {
      ...baseRow,
      healthCheckedAt: new Date("2026-05-17T10:00:00.000Z"),
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [staleRow as any],
      now,
      ttlMs: 30_000,
      probeUrl: async () => {
        probes += 1;
        return true;
      },
    });

    expect(probes).toBe(1);
    expect(result.rows[0]).toMatchObject({
      status: "running",
      healthStatus: "healthy",
      healthCheckedAt: now,
      stoppedAt: null,
      updatedAt: now,
    });
  });

  it("keeps an active adapter-managed preview recoverable after one failed probe", async () => {
    const now = new Date("2026-05-16T10:00:00.000Z");

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [baseRow as any],
      now,
      probeUrl: async () => false,
    });

    expect(result.rows[0]).toMatchObject({
      id: baseRow.id,
      status: "running",
      healthStatus: "unhealthy",
      stoppedAt: null,
      healthCheckedAt: now,
      updatedAt: now,
    });
    expect(result.updates).toEqual([
      {
        id: baseRow.id,
        status: "running",
        healthStatus: "unhealthy",
        stoppedAt: null,
        healthCheckedAt: now,
        updatedAt: now,
      },
    ]);
  });

  it("marks adapter-managed previews stopped after a consecutive failed probe", async () => {
    const now = new Date("2026-05-16T10:01:00.000Z");
    const unhealthyRow = {
      ...baseRow,
      healthStatus: "unhealthy",
      healthCheckedAt: new Date("2026-05-16T10:00:00.000Z"),
      stoppedAt: null,
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [unhealthyRow as any],
      now,
      ttlMs: 30_000,
      probeUrl: async () => false,
    });

    expect(result.rows[0]).toMatchObject({
      id: baseRow.id,
      status: "stopped",
      healthStatus: "unhealthy",
      stoppedAt: now,
      healthCheckedAt: now,
      updatedAt: now,
    });
  });

  it("does not resurrect stopped adapter-managed previews even when the URL is reachable", async () => {
    const now = new Date("2026-05-16T10:00:00.000Z");
    let probes = 0;
    const stoppedRow = {
      ...baseRow,
      status: "stopped",
      healthStatus: "unhealthy",
      stoppedAt: new Date("2026-05-16T09:00:00.000Z"),
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [stoppedRow as any],
      now,
      probeUrl: async () => {
        probes += 1;
        return true;
      },
    });

    expect(probes).toBe(0);
    expect(result.rows[0]).toBe(stoppedRow);
    expect(result.updates).toEqual([]);
  });

  it("marks reachable starting adapter-managed previews running and healthy", async () => {
    const now = new Date("2026-05-16T10:00:00.000Z");
    const startingRow = {
      ...baseRow,
      status: "starting",
      healthStatus: "unknown",
      stoppedAt: null,
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [startingRow as any],
      now,
      probeUrl: async () => true,
    });

    expect(result.rows[0]).toMatchObject({
      id: baseRow.id,
      status: "running",
      healthStatus: "healthy",
      stoppedAt: null,
      healthCheckedAt: now,
      updatedAt: now,
    });
  });

  it("does not probe controllable local process services", async () => {
    let probes = 0;
    const localProcessRow = {
      ...baseRow,
      id: "22222222-2222-4222-8222-222222222222",
      provider: "local_process",
      command: "pnpm dev",
      providerRef: "pid:123",
    };

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: [localProcessRow as any],
      now: new Date("2026-05-16T10:00:00.000Z"),
      probeUrl: async () => {
        probes += 1;
        return false;
      },
    });

    expect(probes).toBe(0);
    expect(result.rows[0]).toBe(localProcessRow);
    expect(result.updates).toEqual([]);
  });

  it("limits concurrent preview probes without dropping previews", async () => {
    let active = 0;
    let maxActive = 0;
    let probes = 0;
    const now = new Date("2026-05-17T10:00:00.000Z");
    const rows = Array.from({ length: 12 }, (_, index) => ({
      ...baseRow,
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      serviceName: `localhost:${55000 + index}`,
      port: 55000 + index,
      url: `http://127.0.0.1:${55000 + index}/`,
      healthCheckedAt: null,
    }));

    const result = await refreshAdapterManagedPreviewRuntimeServiceRows({
      rows: rows as any,
      now,
      ttlMs: 30_000,
      maxConcurrency: 5,
      probeUrl: async () => {
        probes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return true;
      },
    });

    expect(probes).toBe(12);
    expect(maxActive).toBeLessThanOrEqual(5);
    expect(result.rows).toHaveLength(12);
    expect(result.rows.every((row) => row.status === "running")).toBe(true);
  });

  it("deduplicates concurrent probes for the same preview service", async () => {
    let probes = 0;
    const now = new Date("2026-05-17T10:00:00.000Z");
    const row = {
      ...baseRow,
      healthCheckedAt: null,
    };

    const probeUrl = async () => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return true;
    };

    const [first, second] = await Promise.all([
      refreshAdapterManagedPreviewRuntimeServiceRows({
        rows: [row as any],
        now,
        ttlMs: 30_000,
        probeUrl,
      }),
      refreshAdapterManagedPreviewRuntimeServiceRows({
        rows: [row as any],
        now,
        ttlMs: 30_000,
        probeUrl,
      }),
    ]);

    expect(probes).toBe(1);
    expect(first.rows[0]?.healthStatus).toBe("healthy");
    expect(second.rows[0]?.healthStatus).toBe("healthy");
  });
});

describe("refreshLocalProcessRuntimeServiceRows", () => {
  const baseRow = {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-1",
    executionWorkspaceId: "execution-workspace-1",
    issueId: "issue-1",
    scopeType: "execution_workspace",
    scopeId: "execution-workspace-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/tmp/project",
    port: 54853,
    url: "http://127.0.0.1:54853/",
    provider: "local_process",
    providerRef: "12345",
    processOwnerId: "owner-a",
    ownerAgentId: "agent-1",
    startedByRunId: null,
    lastUsedAt: new Date("2026-05-16T00:00:00.000Z"),
    startedAt: new Date("2026-05-16T00:00:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "unknown",
    healthCheckedAt: null,
    createdAt: new Date("2026-05-16T00:00:00.000Z"),
    updatedAt: new Date("2026-05-16T00:00:00.000Z"),
  };

  it("probes stale local-process service URLs", async () => {
    let probes = 0;
    const now = new Date("2026-05-17T10:00:00.000Z");

    const result = await refreshLocalProcessRuntimeServiceRows({
      processOwnerId: "owner-a",
      rows: [baseRow as any],
      now,
      probeUrl: async () => {
        probes += 1;
        return true;
      },
    });

    expect(probes).toBe(1);
    expect(result.rows[0]).toMatchObject({
      status: "running",
      healthStatus: "healthy",
      stoppedAt: null,
      healthCheckedAt: now,
      updatedAt: now,
    });
  });

  it("does not resurrect stopped local-process services even when the URL is reachable", async () => {
    let probes = 0;
    const stoppedRow = {
      ...baseRow,
      status: "stopped",
      healthStatus: "unhealthy",
      stoppedAt: new Date("2026-05-16T09:00:00.000Z"),
      healthCheckedAt: new Date("2026-05-16T09:00:00.000Z"),
    };

    const result = await refreshLocalProcessRuntimeServiceRows({
      processOwnerId: "owner-a",
      rows: [stoppedRow as any],
      now: new Date("2026-05-17T10:00:00.000Z"),
      probeUrl: async () => {
        probes += 1;
        return true;
      },
    });

    expect(probes).toBe(0);
    expect(result.rows[0]).toBe(stoppedRow);
    expect(result.updates).toEqual([]);
  });

  it("probes stale local-process URLs even when the process is still registered in memory", async () => {
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
      executionWorkspaceId: "execution-workspace-1",
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

    try {
      let probes = 0;
      const now = new Date("2026-05-17T10:00:00.000Z");
      const result = await refreshLocalProcessRuntimeServiceRows({
        processOwnerId: "owner-a",
        rows: [{
          ...baseRow,
          id: refs[0]!.id,
          port: refs[0]!.port,
          url: `http://127.0.0.1:${refs[0]!.port}/`,
          status: "running",
          healthStatus: "healthy",
          healthCheckedAt: null,
        } as any],
        now,
        probeUrl: async () => {
          probes += 1;
          return false;
        },
      });

      expect(probes).toBe(1);
      expect(result.rows[0]).toMatchObject({
        status: "running",
        healthStatus: "unhealthy",
        stoppedAt: null,
        healthCheckedAt: now,
        updatedAt: now,
      });
    } finally {
      await stopRuntimeServicesForExecutionWorkspace({
        executionWorkspaceId: "execution-workspace-1",
        workspaceCwd: process.cwd(),
      });
    }
  });

  it("marks local-process services stopped after a consecutive failed probe", async () => {
    const now = new Date("2026-05-17T10:01:00.000Z");
    const unhealthyRow = {
      ...baseRow,
      status: "running",
      healthStatus: "unhealthy",
      stoppedAt: null,
      healthCheckedAt: new Date("2026-05-17T10:00:00.000Z"),
    };

    const result = await refreshLocalProcessRuntimeServiceRows({
      processOwnerId: "owner-a",
      rows: [unhealthyRow as any],
      now,
      ttlMs: 30_000,
      probeUrl: async () => false,
    });

    expect(result.rows[0]).toMatchObject({
      status: "stopped",
      healthStatus: "unhealthy",
      stoppedAt: now,
      healthCheckedAt: now,
      updatedAt: now,
    });
  });

  it("terminates a persisted local process before writing a health-driven stopped state", async () => {
    const now = new Date("2026-05-17T10:01:00.000Z");
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (value: Record<string, unknown>) => {
          updates.push(value);
          return { where: async () => [] };
        },
      }),
    } as never;
    let aliveChecks = 0;
    const terminate = vi.fn();

    const result = await refreshPersistedRuntimeServiceRows({
      processOwnerId: "owner-a",
      db,
      rows: [{
        ...baseRow,
        issueId: null,
        healthStatus: "unhealthy",
        healthCheckedAt: new Date("2026-05-17T10:00:00.000Z"),
      } as any],
      now,
      ttlMs: 30_000,
      probeUrl: async () => false,
      terminationDeps: {
        isAlive: async () => aliveChecks++ === 0,
        inspectIdentity: () => "matching",
        terminate,
        waitForExitMs: 10,
      },
    });

    expect(terminate).toHaveBeenCalled();
    expect(result[0]).toMatchObject({ status: "stopped", healthStatus: "unhealthy" });
    expect(updates.at(-1)).toMatchObject({ status: "stopped" });
  });

  it("keeps an unverifiable local process active and tracked after failed health probes", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (value: Record<string, unknown>) => {
          updates.push(value);
          return { where: async () => [] };
        },
      }),
    } as never;

    const result = await refreshPersistedRuntimeServiceRows({
      processOwnerId: "owner-a",
      db,
      rows: [{
        ...baseRow,
        issueId: null,
        healthStatus: "unhealthy",
        healthCheckedAt: new Date("2026-05-17T10:00:00.000Z"),
      } as any],
      now: new Date("2026-05-17T10:01:00.000Z"),
      ttlMs: 30_000,
      probeUrl: async () => false,
      terminationDeps: {
        isAlive: async () => true,
        inspectIdentity: () => "unknown",
      },
    });

    expect(result[0]).toMatchObject({
      status: "running",
      healthStatus: "unhealthy",
      stoppedAt: null,
    });
    expect(updates.at(-1)).toMatchObject({
      status: "running",
      healthStatus: "unhealthy",
      stoppedAt: null,
    });
  });

  it("does not probe, terminate, or update a foreign-owner local service", async () => {
    const probeUrl = vi.fn(async () => false);
    const isAlive = vi.fn(async () => true);
    const update = vi.fn();

    const result = await refreshPersistedRuntimeServiceRows({
      db: { update } as never,
      rows: [{ ...baseRow, processOwnerId: "owner-b" } as any],
      processOwnerId: "owner-a",
      probeUrl,
      terminationDeps: { isAlive },
    });

    expect(result[0]).toMatchObject({ status: "running", processOwnerId: "owner-b" });
    expect(probeUrl).not.toHaveBeenCalled();
    expect(isAlive).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

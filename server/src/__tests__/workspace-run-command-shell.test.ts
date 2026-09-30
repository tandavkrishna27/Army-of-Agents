import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

// Capture every spawn() invocation made by the workspace-runtime module so we
// can assert that runWorkspaceCommand (reached via the no-recorder branch of
// recordWorkspaceCommandOperation) honours the platform shell on Windows.
//
// A-M13: runWorkspaceCommand previously hardcoded `process.env.SHELL || "/bin/sh"`
// with args ["-c", cmd]. On Windows with SHELL unset that is `spawn('/bin/sh', …)`
// → ENOENT. The fix routes through shellInvocation(), which returns
// powershell.exe -NoProfile -NonInteractive -Command on win32.

interface SpawnCall {
  command: string;
  args: string[];
}

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // Resolve executeProcess immediately with a success exit code.
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }),
  };
});

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_SHELL = process.env.SHELL;

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function findShellSpawnCall(command: string): SpawnCall | undefined {
  // The cleanup command we feed is unique enough to identify the
  // runWorkspaceCommand spawn among any incidental spawns.
  return spawnCalls.find((call) => call.args.some((arg) => arg.includes(command)));
}

beforeEach(() => {
  spawnCalls.length = 0;
  delete process.env.SHELL;
  delete process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT;
  setDeploymentMode("local_trusted");
});

afterEach(() => {
  setDeploymentMode("local_trusted");
  delete process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT;
  Object.defineProperty(process, "platform", {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
  if (ORIGINAL_SHELL === undefined) {
    delete process.env.SHELL;
  } else {
    process.env.SHELL = ORIGINAL_SHELL;
  }
  vi.clearAllMocks();
});

// Drive runWorkspaceCommand through the exported public surface:
// cleanupExecutionWorkspaceArtifacts → recordWorkspaceCommandOperation(null, …)
// → runWorkspaceCommand. A non-git, non-local_fs providerType isolates the
// shell-command path from any git/fs side-effects.
async function runCleanupCommand(cleanupCommand: string) {
  const { cleanupExecutionWorkspaceArtifacts } = await import(
    "../services/workspace-runtime.ts"
  );
  return cleanupExecutionWorkspaceArtifacts({
    workspace: {
      id: "ws-am13",
      cwd: process.cwd(),
      providerType: "none",
      providerRef: process.cwd(),
      branchName: null,
      repoUrl: null,
      baseRef: null,
      projectId: "project-1",
      projectWorkspaceId: null,
      sourceIssueId: null,
      metadata: null,
    },
    cleanupCommand,
    recorder: null,
  });
}

describe("runWorkspaceCommand — platform shell (A-M13)", () => {
  it("refuses persisted cleanup commands in cloud_auth before spawning a shell", async () => {
    setDeploymentMode("cloud_auth");

    const result = await runCleanupCommand("echo persisted-legacy-command");
    expect(result.warnings.join("\n")).toMatch(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("uses powershell.exe with -Command on win32 when SHELL is unset", async () => {
    setPlatform("win32");
    const cmd = "echo am13-windows-marker";

    await runCleanupCommand(cmd);

    const call = findShellSpawnCall(cmd);
    expect(call).toBeDefined();
    expect(call!.command).toBe("powershell.exe");
    expect(call!.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      cmd,
    ]);
    // It must NOT use the POSIX /bin/sh -c form.
    expect(call!.command).not.toBe("/bin/sh");
    expect(call!.args).not.toContain("-c");
  });

  it("uses the posix /bin/sh with -lc on linux when SHELL is unset", async () => {
    setPlatform("linux");
    const cmd = "echo am13-linux-marker";

    await runCleanupCommand(cmd);

    const call = findShellSpawnCall(cmd);
    expect(call).toBeDefined();
    // Matches shellInvocation()'s posix output, NOT a hardcoded "/bin/sh -c".
    expect(call!.command).toBe("/bin/sh");
    expect(call!.args).toEqual(["-lc", cmd]);
    expect(call!.args).not.toContain("-c");
  });
});

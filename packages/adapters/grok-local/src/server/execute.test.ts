import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@armyofagents/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async (): Promise<{
  workspaceRemoteDir: string | null;
  runtimeRootDir: string | null;
  restoreWorkspace: () => Promise<void>;
}> => ({
  workspaceRemoteDir: null,
  runtimeRootDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "grok"));
const runProcessMock = vi.hoisted(() => vi.fn());
const syncDirectoryMock = vi.hoisted(() => vi.fn(async () => {}));
const syncFileMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@armyofagents/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: (target: { type?: string } | null | undefined) =>
    target?.type === "sandbox-docker" || target?.type === "provider-sandbox",
  adapterExecutionTargetRemoteCwd: (target: { type?: string; remoteCwd?: string; workdir?: string } | null | undefined, cwd: string) =>
    target?.type === "provider-sandbox" ? target.remoteCwd : target?.type === "sandbox-docker" ? target.workdir : cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: { type?: string } | null | undefined, cwd: string) =>
    target?.type === "provider-sandbox" ? { ...target, remoteCwd: cwd } : target?.type === "sandbox-docker" ? { ...target, workdir: cwd } : target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: (target: { type?: string; provider?: string; remoteCwd?: string } | null | undefined) =>
    target?.type === "provider-sandbox" ? `provider-sandbox ${target.provider} at ${target.remoteCwd}` : "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { type: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  })),
  syncAdapterExecutionTargetDirectory: syncDirectoryMock,
  syncAdapterExecutionTargetFile: syncFileMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "AoA-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

describe("grok_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
    syncDirectoryMock.mockClear();
    syncFileMock.mockClear();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "AoA");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: AoA\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_target, options) => {
      expect(options.args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
          "--permission-mode",
          "dontAsk",
        ]),
      );
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "AoA", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        aoaRuntimeSkills: [{
          key: "AoA",
          runtimeName: "AoA",
          source: skillSource,
          required: false,
        }],
        aoaSkillSync: { desiredSkills: ["AoA"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "AoA"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "AoA");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: AoA\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        aoaRuntimeSkills: [{
          key: "AoA",
          runtimeName: "AoA",
          source: skillSource,
          required: false,
        }],
        aoaSkillSync: { desiredSkills: ["AoA"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "AoA"))).toBe(false);
  });

  it("syncs staged Grok instructions, skills, and fallback rules into provider-sandbox targets", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "AoA");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "Remote Grok rules.\n", "utf8");
    await fs.writeFile(path.join(root, "Agents.md"), "Existing remote workspace instructions.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: AoA\ndescription: test\n---\n", "utf8");
    prepareRuntimeMock.mockResolvedValueOnce({
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: "/remote/workspace/.aoa-runtime/grok",
      restoreWorkspace: async () => {},
    });
    runProcessMock.mockImplementation(async (_target, options) => {
      expect(options.args).toEqual(
        expect.arrayContaining([
          "--cwd",
          "/remote/workspace",
          "--rules",
          "@/remote/workspace/.aoa-runtime/grok/grok-rules/AGENTS.md",
        ]),
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "remote done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-remote", requestId: "req-remote" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-remote",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        cwd: root,
        instructionsFilePath: instructionsPath,
        aoaRuntimeSkills: [{
          key: "AoA",
          runtimeName: "AoA",
          source: skillSource,
          required: false,
        }],
        aoaSkillSync: { desiredSkills: ["AoA"] },
      },
      context: {},
      executionTarget: {
        type: "provider-sandbox",
        provider: "e2b",
        providerLeaseId: "lease-1",
        remoteCwd: "/remote/workspace",
        runner: { execute: vi.fn() },
      },
      authToken: "run-token",
      onLog: async () => {},
    };

    const result = await execute(ctx);

    expect(result.sessionId).toBe("sess-remote");
    expect(syncDirectoryMock).toHaveBeenCalledWith(expect.objectContaining({
      localDir: path.join(root, ".claude", "skills"),
      remoteDir: "/remote/workspace/.claude/skills",
      target: expect.objectContaining({ type: "provider-sandbox" }),
    }));
    expect(syncFileMock).toHaveBeenCalledWith(expect.objectContaining({
      localPath: instructionsPath,
      remotePath: "/remote/workspace/.aoa-runtime/grok/grok-rules/AGENTS.md",
      target: expect.objectContaining({ type: "provider-sandbox" }),
    }));
  });
});

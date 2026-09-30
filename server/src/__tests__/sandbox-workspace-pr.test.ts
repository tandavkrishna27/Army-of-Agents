/**
 * U6.4 — org host commit/push/PR from the pulled in-VM diff.
 *
 * `createPullRequest`/`resolveGitHubAuth` are mocked (real GitHub-pr unit
 * coverage lives in github-pr.test.ts) and git is driven through an injected
 * recording `HostGitRunner` double so the suite never shells a real `git` or
 * touches the network — but the REAL `assertHostOrchestrationGitAllowed` /
 * `assertLocalWorkspaceCommandAllowed` guards from
 * `local-workspace-command-guard.ts` run unmocked, so test (d) below proves
 * the U6.1 host-orchestration carve-out is actually wired, not merely
 * asserted against a stub.
 *
 * Deployment-mode mock pattern mirrors `host-orchestration-git-guard.test.ts`:
 * `setDeploymentMode` is real exported mutable module state (not a vi.mock).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../services/unsandboxed-multitenant-guard.js";

const createPullRequest = vi.hoisted(() => vi.fn());
const resolveGitHubAuth = vi.hoisted(() => vi.fn(async () => "fake-pat-token"));
vi.mock("../services/github-pr.js", () => ({ createPullRequest, resolveGitHubAuth }));

import { finalizeSandboxOrgWorkspace, type HostGitRunner } from "../services/sandbox-workspace-pr.js";

const BASE = {
  companyId: "company-1",
  repoUrl: "https://github.com/acme/widget.git",
  branchName: "aoa/task-123",
  baseRef: "main",
  prTitle: "Add widget feature",
  prBody: "Produced by an AoA org agent run in an isolated sandbox.",
};

let savedOptIn: string | undefined;

beforeEach(() => {
  // The opt-in env would turn the tenant-command refusal into a no-op too;
  // ensure it is absent so test (d)'s divergence is the U6.1 carve-out
  // itself, not the operator override (mirrors host-orchestration-git-guard.test.ts).
  savedOptIn = process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  createPullRequest.mockReset();
  resolveGitHubAuth.mockReset();
  resolveGitHubAuth.mockResolvedValue("fake-pat-token");
});

afterEach(() => {
  setDeploymentMode("local_trusted"); // module default; do not leak cloud_auth
  if (savedOptIn === undefined) delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  else process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV] = savedOptIn;
});

function makeRecordingGitRunner(): {
  runner: HostGitRunner;
  calls: Array<{ args: string[]; cwd: string }>;
} {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const runner: HostGitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

const tempDirs = new Set<string>();
async function makeTempClone(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-host-clone-"));
  tempDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("finalizeSandboxOrgWorkspace (U6.4)", () => {
  it("writes pulled files into the clone, commits/pushes hooks-off, and opens exactly one PR", async () => {
    const cwd = await makeTempClone();
    const { runner, calls } = makeRecordingGitRunner();
    createPullRequest.mockResolvedValue({
      url: "https://github.com/acme/widget/pull/7",
      number: 7,
      state: "open",
      draft: false,
    });

    const result = await finalizeSandboxOrgWorkspace({
      db: {} as never,
      ...BASE,
      hostClonePath: cwd,
      files: [
        { path: "src/a.ts", content: Buffer.from("export const a = 1;\n") },
        { path: "nested/b.txt", content: Buffer.from("hello\n") },
      ],
      gitRunner: runner,
    });

    // (a) files written into the clone
    expect(await fs.readFile(path.join(cwd, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await fs.readFile(path.join(cwd, "nested/b.txt"), "utf8")).toBe("hello\n");

    // (b) every git invocation runs hooks-off
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args).toEqual(expect.arrayContaining(["-c", "core.hooksPath="]));
      expect(call.cwd).toBe(cwd);
    }
    // add -A, commit -m <prTitle>, push origin <branch> all ran
    expect(calls.some((c) => c.args.includes("add") && c.args.includes("-A"))).toBe(true);
    expect(calls.some((c) => c.args.includes("commit") && c.args.includes(BASE.prTitle))).toBe(true);
    expect(
      calls.some(
        (c) => c.args.includes("push") && c.args.includes("origin") && c.args.includes(BASE.branchName),
      ),
    ).toBe(true);

    // (c) createPullRequest called once with head = branch
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: BASE.companyId,
        repoUrl: BASE.repoUrl,
        base: BASE.baseRef,
        head: BASE.branchName,
        draft: false,
      }),
    );

    expect(result).toMatchObject({
      branch: BASE.branchName,
      pushed: true,
      prUrl: "https://github.com/acme/widget/pull/7",
      prNumber: 7,
      rejectedFiles: [],
    });
  });

  it("(d) on cloud_auth, commit/push still proceeds — proves the U6.1 host-orchestration carve-out is wired", async () => {
    setDeploymentMode("cloud_auth");
    const cwd = await makeTempClone();
    const { runner, calls } = makeRecordingGitRunner();
    createPullRequest.mockResolvedValue({
      url: "https://github.com/acme/widget/pull/8",
      number: 8,
      state: "open",
      draft: false,
    });

    await expect(
      finalizeSandboxOrgWorkspace({
        db: {} as never,
        ...BASE,
        hostClonePath: cwd,
        files: [{ path: "a.txt", content: Buffer.from("x") }],
        gitRunner: runner,
      }),
    ).resolves.toMatchObject({ pushed: true, branch: BASE.branchName });

    expect(calls.length).toBeGreaterThan(0);
  });

  it("(e) rejects a path-traversal entry — never writes outside the clone root", async () => {
    const cwd = await makeTempClone();
    const { runner } = makeRecordingGitRunner();
    createPullRequest.mockResolvedValue({
      url: "https://github.com/acme/widget/pull/9",
      number: 9,
      state: "open",
      draft: false,
    });

    const result = await finalizeSandboxOrgWorkspace({
      db: {} as never,
      ...BASE,
      hostClonePath: cwd,
      files: [
        { path: "../evil.txt", content: Buffer.from("pwned") },
        { path: "ok.txt", content: Buffer.from("fine") },
      ],
      gitRunner: runner,
    });

    expect(result.rejectedFiles).toEqual(["../evil.txt"]);
    const escapedPath = path.resolve(cwd, "..", "evil.txt");
    await expect(fs.stat(escapedPath)).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, "ok.txt"), "utf8")).toBe("fine");
  });

  it("(g) rejects pulled files that target .git/ inside the clone (RW4 defense-in-depth)", async () => {
    const cwd = await makeTempClone();
    const { runner } = makeRecordingGitRunner();
    createPullRequest.mockResolvedValue({
      url: "https://github.com/acme/widget/pull/10",
      number: 10,
      state: "open",
      draft: false,
    });

    const result = await finalizeSandboxOrgWorkspace({
      db: {} as never,
      ...BASE,
      hostClonePath: cwd,
      files: [
        { path: ".git/hooks/pre-commit", content: Buffer.from("#!/bin/sh\necho pwned\n") },
        { path: ".git/config", content: Buffer.from("[core]\n\tfoo = bar\n") },
        { path: "ok.txt", content: Buffer.from("fine") },
      ],
      gitRunner: runner,
    });

    expect(result.rejectedFiles).toEqual([".git/hooks/pre-commit", ".git/config"]);
    await expect(fs.stat(path.join(cwd, ".git", "hooks", "pre-commit"))).rejects.toThrow();
    await expect(fs.stat(path.join(cwd, ".git", "config"))).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, "ok.txt"), "utf8")).toBe("fine");
  });

  it("(f) on createPullRequest failure, still reports the pushed branch (partial-success)", async () => {
    const cwd = await makeTempClone();
    const { runner } = makeRecordingGitRunner();
    createPullRequest.mockRejectedValue(new Error("GitHub API error"));

    const result = await finalizeSandboxOrgWorkspace({
      db: {} as never,
      ...BASE,
      hostClonePath: cwd,
      files: [{ path: "a.txt", content: Buffer.from("x") }],
      gitRunner: runner,
    });

    expect(result).toMatchObject({
      branch: BASE.branchName,
      pushed: true,
      prUrl: null,
      prNumber: null,
    });
  });
});

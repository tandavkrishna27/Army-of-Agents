/**
 * U6.2 — org stage-in: host clone -> upload working tree (incl. `.git`) into
 * the sandbox `remoteCwd`.
 *
 * Drives `stageRepoIntoSandbox` against the fake `SandboxRuntimeProvider`
 * extended with an in-memory FS (`sandbox-provider-runtime.ts`). The fake's
 * `execute()` interprets the exact `sh -c "mkdir -p … && tar -xf … -C … &&
 * rm -f …"` script `stageRepoIntoSandbox` emits (a minimal ustar reader, not
 * a general tar implementation — verified separately against a REAL `tar
 * --format=ustar` archive produced from a scratch fixture during
 * development; see sandbox-provider-runtime.ts's parseUstarBuffer).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createFakeSandboxRuntimeProvider,
  type SandboxRuntimeProvider,
} from "../services/sandbox-provider-runtime.js";
import { stageRepoIntoSandbox, type SandboxFileMovementRunner } from "../services/sandbox-file-movement.js";

/**
 * Adapts the raw `SandboxRuntimeProvider` (provider-keyed, lease-id-keyed
 * calls) into the small `SandboxFileMovementRunner` shape `stageRepoIntoSandbox`
 * expects — i.e. a stand-in for what `environment-run-orchestrator.ts`'s
 * `buildProviderRunner` produces for a real run, without pulling in
 * orchestrator/environment-runtime plumbing for this unit test.
 */
function makeRunner(provider: SandboxRuntimeProvider, providerLeaseId: string): SandboxFileMovementRunner {
  return {
    async execute(input) {
      return provider.execute({
        providerLeaseId,
        leaseMetadata: null,
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd ?? undefined,
        env: input.env ?? {},
        stdin: input.stdin ?? null,
        timeoutMs: (input.timeoutSec ?? 30) * 1000,
      });
    },
    async writeFiles(files) {
      if (!provider.writeFiles) throw new Error("fake provider is missing writeFiles");
      await provider.writeFiles({ providerLeaseId, leaseMetadata: null, files });
    },
    async readFiles(input) {
      if (!provider.readFiles) throw new Error("fake provider is missing readFiles");
      return provider.readFiles({ providerLeaseId, leaseMetadata: null, paths: input.paths });
    },
  };
}

describe("stageRepoIntoSandbox (U6.2)", () => {
  let fixtureRepo: string;

  beforeAll(() => {
    fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "aoa-stagein-fixture-"));
    fs.mkdirSync(path.join(fixtureRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, "src", "a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(fixtureRepo, ".git", "objects", "ab"), { recursive: true });
    fs.writeFileSync(path.join(fixtureRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(fixtureRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    fs.writeFileSync(path.join(fixtureRepo, ".git", "objects", "ab", "cdef1234567890"), "blob\n");
  });

  afterAll(() => {
    fs.rmSync(fixtureRepo, { recursive: true, force: true });
  });

  it("uploads the host clone working tree + .git into remoteCwd", async () => {
    const provider = createFakeSandboxRuntimeProvider();
    const lease = await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: null,
      heartbeatRunId: "run-1",
      config: { remoteCwd: "/home/user/aoa-workspace" },
      workspaceMode: "per_task",
    });
    const runner = makeRunner(provider, lease.providerLeaseId);

    await stageRepoIntoSandbox({
      runner,
      hostClonePath: fixtureRepo,
      remoteCwd: "/home/user/aoa-workspace",
    });

    const ls = await runner.execute({
      command: "sh",
      args: ["-c", "ls -a /home/user/aoa-workspace && test -d /home/user/aoa-workspace/.git"],
      cwd: null,
      env: {},
      stdin: null,
      timeoutSec: 30,
    });

    expect(ls.exitCode).toBe(0);
  });

  it("stages exact file bytes, not just presence (verified via readFiles)", async () => {
    const provider = createFakeSandboxRuntimeProvider();
    const lease = await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: null,
      heartbeatRunId: "run-2",
      config: { remoteCwd: "/workspace/run-2" },
      workspaceMode: "per_task",
    });
    const runner = makeRunner(provider, lease.providerLeaseId);

    await stageRepoIntoSandbox({
      runner,
      hostClonePath: fixtureRepo,
      remoteCwd: "/workspace/run-2",
    });

    const [srcFile, gitHead] = await runner.readFiles!({
      paths: ["/workspace/run-2/src/a.ts", "/workspace/run-2/.git/HEAD"],
    });

    expect(srcFile.content.toString("utf8")).toBe("export const a = 1;\n");
    expect(gitHead.content.toString("utf8")).toBe("ref: refs/heads/main\n");
  });

  it("cleans up the staged tar archive after extraction", async () => {
    const provider = createFakeSandboxRuntimeProvider();
    const lease = await provider.acquireLease({
      companyId: "company-1",
      environmentId: "env-1",
      issueId: null,
      heartbeatRunId: "run-3",
      config: { remoteCwd: "/workspace/run-3" },
      workspaceMode: "per_task",
    });
    const runner = makeRunner(provider, lease.providerLeaseId);

    await stageRepoIntoSandbox({
      runner,
      hostClonePath: fixtureRepo,
      remoteCwd: "/workspace/run-3",
    });

    const [tarFile] = await runner.readFiles!({ paths: ["/tmp/aoa-repo.tar"] });
    expect(tarFile.content.length).toBe(0);
  });
});

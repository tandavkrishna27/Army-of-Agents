/**
 * U6.3 — org in-VM diff pull-out.
 *
 * `collectSandboxDiff` needs a sandbox that actually behaves like `git`
 * (staged/unstaged diff, untracked files). The shared fake
 * `SandboxRuntimeProvider` (`sandbox-provider-runtime.ts`) only emulates the
 * fixed `mkdir`/`tar`/`rm`/`ls`/`test -d` shell shapes `stageRepoIntoSandbox`
 * emits (U6.2) — it has no git object model, so extending it to emulate real
 * `git diff`/`ls-files` semantics would mean building a miniature git
 * implementation for no real coverage gain. Per the wave-4 plan's own
 * fallback, this suite instead drives `collectSandboxDiff` against a
 * hand-built `SandboxFileMovementRunner` double whose `execute` returns
 * canned git stdout for the two known invocations and whose `readFiles`
 * returns canned contents — a real E2B/`sh` VM interprets the identical
 * `sh -c "git -c core.hooksPath= …"` script for real.
 */
import { describe, expect, it } from "vitest";
import {
  collectSandboxDiff,
  type SandboxExecuteInput,
  type SandboxExecuteResult,
  type SandboxFileMovementRunner,
} from "../services/sandbox-file-movement.js";

const REMOTE_CWD = "/home/user/aoa-workspace";

/**
 * A runner double that recognizes the two git invocations
 * `collectSandboxDiff` issues (each a single `sh -c "git -c
 * core.hooksPath=…"` script, mirroring `stageRepoIntoSandbox`'s own style in
 * the same module) and serves canned stdout for each, plus canned file
 * contents keyed by absolute in-VM path for `readFiles`.
 */
function makeInjectedRunner(input: {
  diffStdout?: string;
  diffExitCode?: number;
  untrackedStdout?: string;
  untrackedExitCode?: number;
  fileContents?: Record<string, Buffer>;
  readFiles?: boolean;
}): { runner: SandboxFileMovementRunner; calls: SandboxExecuteInput[] } {
  const calls: SandboxExecuteInput[] = [];
  const fileContents = input.fileContents ?? {};

  const runner: SandboxFileMovementRunner = {
    async execute(execInput): Promise<SandboxExecuteResult> {
      calls.push(execInput);
      const script = typeof execInput.args?.[1] === "string" ? execInput.args[1] : "";
      if (script.includes("diff --name-only HEAD")) {
        return {
          exitCode: input.diffExitCode ?? 0,
          signal: null,
          timedOut: false,
          stdout: input.diffStdout ?? "",
          stderr: "",
        };
      }
      if (script.includes("ls-files --others --exclude-standard")) {
        return {
          exitCode: input.untrackedExitCode ?? 0,
          signal: null,
          timedOut: false,
          stdout: input.untrackedStdout ?? "",
          stderr: "",
        };
      }
      return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: `unrecognized script: ${script}` };
    },
    async writeFiles() {
      // not exercised by collectSandboxDiff
    },
    ...(input.readFiles === false
      ? {}
      : {
          async readFiles(readInput: { paths: string[] }) {
            return readInput.paths.map((p) => ({ path: p, content: fileContents[p] ?? Buffer.alloc(0) }));
          },
        }),
  };

  return { runner, calls };
}

describe("collectSandboxDiff (U6.3)", () => {
  it("returns exactly the changed + untracked files with byte contents, running hooks-neutralized git", async () => {
    const { runner, calls } = makeInjectedRunner({
      diffStdout: "src/a.ts\n",
      untrackedStdout: "new.txt\n",
      fileContents: {
        [`${REMOTE_CWD}/src/a.ts`]: Buffer.from("export const a = 2;\n"),
        [`${REMOTE_CWD}/new.txt`]: Buffer.from("hello\n"),
      },
    });

    const diff = await collectSandboxDiff({ runner, remoteCwd: REMOTE_CWD });

    expect(diff.map((d) => d.path).sort()).toEqual(["new.txt", "src/a.ts"]);
    expect(diff.find((d) => d.path === "src/a.ts")?.content.toString("utf8")).toBe("export const a = 2;\n");
    expect(diff.find((d) => d.path === "new.txt")?.content.toString("utf8")).toBe("hello\n");

    // Security requirement: both git invocations neutralize hooks, and both
    // run in the target remoteCwd via `-C`.
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call.command).toBe("sh");
      expect(call.args?.[0]).toBe("-c");
      expect(call.args?.[1]).toContain("core.hooksPath=");
      expect(call.args?.[1]).toContain(`-C '${REMOTE_CWD}'`);
    }
  });

  it("dedupes a path reported by both diff and ls-files, and drops noise paths", async () => {
    const { runner } = makeInjectedRunner({
      diffStdout: "src/a.ts\nnode_modules/pkg/index.js\n",
      untrackedStdout: "src/a.ts\nnew.txt\ndebug.log\n",
      fileContents: {
        [`${REMOTE_CWD}/src/a.ts`]: Buffer.from("a\n"),
        [`${REMOTE_CWD}/new.txt`]: Buffer.from("b\n"),
      },
    });

    const diff = await collectSandboxDiff({ runner, remoteCwd: REMOTE_CWD });

    expect(diff.map((d) => d.path).sort()).toEqual(["new.txt", "src/a.ts"]);
  });

  it("returns [] when both git commands fail, without calling readFiles", async () => {
    let readFilesCalled = false;
    const { runner: base } = makeInjectedRunner({ diffExitCode: 1, untrackedExitCode: 1 });
    const runner: SandboxFileMovementRunner = {
      ...base,
      async readFiles(input) {
        readFilesCalled = true;
        return input.paths.map((p) => ({ path: p, content: Buffer.alloc(0) }));
      },
    };

    const diff = await collectSandboxDiff({ runner, remoteCwd: REMOTE_CWD });

    expect(diff).toEqual([]);
    expect(readFilesCalled).toBe(false);
  });

  it("throws when the runner does not support readFiles but there are candidate files", async () => {
    const { runner } = makeInjectedRunner({
      diffStdout: "src/a.ts\n",
      readFiles: false,
    });

    await expect(collectSandboxDiff({ runner, remoteCwd: REMOTE_CWD })).rejects.toThrow(
      /does not support readFiles/,
    );
  });
});

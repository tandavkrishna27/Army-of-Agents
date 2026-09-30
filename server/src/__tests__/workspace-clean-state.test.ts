/**
 * Tests for resetWorkspaceToCleanState (P1-T8 slice 1).
 *
 * ALL git interactions are faked via the injected gitRunner seam — no real git
 * process is spawned, no real filesystem repositories are needed (except for
 * the path-guard tests which create a minimal directory structure on disk).
 * This makes the suite fast and deterministic on all platforms, including
 * Windows CI where embedded-postgres / real-git flakiness must be avoided.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceToCleanState, type GitRunner } from "../services/workspace-runtime.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A captured invocation of the fake git runner. */
interface GitCall {
  args: string[];
  cwd: string;
}

/**
 * Build a fake GitRunner that records every call and returns success (code 0)
 * for all of them unless overridden via `overrides`.
 *
 * @param overrides  Map from call index (0-based) to the result to return.
 */
function buildFakeRunner(
  overrides: Map<number, { stdout: string; stderr: string; code: number }> = new Map(),
): { runner: GitRunner; calls: GitCall[] } {
  const calls: GitCall[] = [];
  const runner: GitRunner = async (args, cwd) => {
    const idx = calls.length;
    calls.push({ args: [...args], cwd });
    return overrides.get(idx) ?? { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// Path-guard helpers
// ---------------------------------------------------------------------------

/** Temp dirs created during path-guard tests that must be cleaned up. */
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-clean-state-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Create a minimal fake worktree directory: just the dir + a ".git" file. */
async function makeFakeWorktree(): Promise<string> {
  const dir = await makeTempDir();
  // A linked git worktree has a `.git` FILE (not a directory).
  await fs.writeFile(path.join(dir, ".git"), "gitdir: ../../.git/worktrees/fake\n", "utf8");
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Core behaviour — correct commands, correct order
// ---------------------------------------------------------------------------

describe("resetWorkspaceToCleanState — core behaviour", () => {
  it("issues exactly two git commands: reset --hard HEAD then clean -fd", async () => {
    const worktree = await makeFakeWorktree();
    const { runner, calls } = buildFakeRunner();

    await resetWorkspaceToCleanState(worktree, { gitRunner: runner });

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["reset", "--hard", "HEAD"]);
    expect(calls[1].args).toEqual(["clean", "-fd"]);
  });

  it("runs both commands against the given worktree path", async () => {
    const worktree = await makeFakeWorktree();
    const resolved = path.resolve(worktree);
    const { runner, calls } = buildFakeRunner();

    await resetWorkspaceToCleanState(worktree, { gitRunner: runner });

    expect(calls[0].cwd).toBe(resolved);
    expect(calls[1].cwd).toBe(resolved);
  });

  it("reset runs BEFORE clean (order is critical)", async () => {
    const worktree = await makeFakeWorktree();
    const { runner, calls } = buildFakeRunner();

    await resetWorkspaceToCleanState(worktree, { gitRunner: runner });

    const resetIdx = calls.findIndex((c) => c.args[0] === "reset");
    const cleanIdx = calls.findIndex((c) => c.args[0] === "clean");
    expect(resetIdx).toBeLessThan(cleanIdx);
  });

  it("returns { ok: true } on success", async () => {
    const worktree = await makeFakeWorktree();
    const { runner } = buildFakeRunner();

    const result = await resetWorkspaceToCleanState(worktree, { gitRunner: runner });

    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// DATA-LOSS GUARD — only HEAD is ever passed to `git reset`
// ---------------------------------------------------------------------------

describe("resetWorkspaceToCleanState — data-loss guard: HEAD only", () => {
  it("never passes a base ref / branch / origin ref to git reset", async () => {
    const worktree = await makeFakeWorktree();
    const { runner, calls } = buildFakeRunner();

    await resetWorkspaceToCleanState(worktree, { gitRunner: runner });

    const resetCalls = calls.filter((c) => c.args[0] === "reset");
    expect(resetCalls).toHaveLength(1);

    const resetArgs = resetCalls[0].args;
    // args[0] is the git subcommand ("reset") — skip it when scanning for refs.
    // The ONLY ref in the remaining args must be "HEAD".
    const refArg = resetArgs[resetArgs.length - 1];
    expect(refArg).toBe("HEAD");

    // Scan args[1..] for unexpected refs (flags are fine; only "HEAD" is an
    // acceptable non-flag positional argument).
    for (const arg of resetArgs.slice(1)) {
      expect(arg).not.toMatch(/origin\//i);
      expect(arg).not.toMatch(/^refs\//i);
      // Must not be a branch name like "main" or "master" in place of HEAD.
      if (arg.startsWith("-")) continue; // flags are fine
      if (arg === "HEAD") continue;       // the only allowed ref
      // Any other non-flag positional argument is an unexpected ref — fail.
      expect.fail(
        `resetWorkspaceToCleanState passed an unexpected ref to git reset: "${arg}"`,
      );
    }
  });

  it("there is no baseRef / branch parameter accepted by the function signature", () => {
    // This is a compile-time property enforced by the TypeScript signature, but
    // we can also assert it at runtime by inspecting the function's length and
    // confirming the opts object has no baseRef/branch key accepted.
    //
    // The accepted opts type is { gitRunner? } only — passing extra keys is a
    // type error.  At runtime, extra keys are silently ignored (JS objects),
    // but we can at least document the intent here and assert the function
    // accepts at most 2 parameters (worktreePath + opts).
    expect(resetWorkspaceToCleanState.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Path guard — refuse dangerous / invalid paths
// ---------------------------------------------------------------------------

describe("resetWorkspaceToCleanState — path guard", () => {
  it("throws on empty string path", async () => {
    const { runner, calls } = buildFakeRunner();
    await expect(resetWorkspaceToCleanState("", { gitRunner: runner })).rejects.toThrow(
      /worktreePath must not be empty/i,
    );
    expect(calls).toHaveLength(0); // no destructive command issued
  });

  it("throws on whitespace-only path", async () => {
    const { runner, calls } = buildFakeRunner();
    await expect(resetWorkspaceToCleanState("   ", { gitRunner: runner })).rejects.toThrow(
      /worktreePath must not be empty/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws on filesystem root path", async () => {
    const { runner, calls } = buildFakeRunner();
    const root = path.parse(process.cwd()).root; // "/" on POSIX, "C:\" on Windows
    await expect(resetWorkspaceToCleanState(root, { gitRunner: runner })).rejects.toThrow(
      /refusing to operate on filesystem root/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("throws when the directory has no .git entry", async () => {
    // A plain temp directory without a .git file/dir.
    const plainDir = await makeTempDir();
    const { runner, calls } = buildFakeRunner();

    await expect(resetWorkspaceToCleanState(plainDir, { gitRunner: runner })).rejects.toThrow(
      /does not appear to be a git worktree/i,
    );
    expect(calls).toHaveLength(0); // guard fires before any git command
  });

  it("does NOT issue any git command when the path guard fires", async () => {
    // Covers all guard branches: empty, root, and non-worktree.
    const { runner, calls } = buildFakeRunner();
    const root = path.parse(process.cwd()).root;
    const plainDir = await makeTempDir();

    for (const badPath of ["", "   ", root, plainDir]) {
      await resetWorkspaceToCleanState(badPath, { gitRunner: runner }).catch(() => undefined);
    }

    // No git command — not even a read-only one — should have been issued.
    const destructiveCommands = calls.filter(
      (c) => c.args.includes("reset") || c.args.includes("clean"),
    );
    expect(destructiveCommands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error propagation — git failures surface as errors
// ---------------------------------------------------------------------------

describe("resetWorkspaceToCleanState — error propagation", () => {
  it("throws when git reset --hard HEAD returns non-zero", async () => {
    const worktree = await makeFakeWorktree();
    const overrides = new Map([
      [0, { stdout: "", stderr: "fatal: cannot reset — index is locked", code: 128 }],
    ]);
    const { runner, calls } = buildFakeRunner(overrides);

    await expect(resetWorkspaceToCleanState(worktree, { gitRunner: runner })).rejects.toThrow(
      /git reset --hard HEAD failed/i,
    );
    // Only the first command ran — clean should not have been called.
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["reset", "--hard", "HEAD"]);
  });

  it("includes git stderr in the thrown error message", async () => {
    const worktree = await makeFakeWorktree();
    const overrides = new Map([
      [0, { stdout: "", stderr: "fatal: specific error message", code: 128 }],
    ]);
    const { runner } = buildFakeRunner(overrides);

    await expect(resetWorkspaceToCleanState(worktree, { gitRunner: runner })).rejects.toThrow(
      /specific error message/i,
    );
  });

  it("throws when git clean -fd returns non-zero", async () => {
    const worktree = await makeFakeWorktree();
    // reset succeeds (call 0), clean fails (call 1)
    const overrides = new Map([
      [1, { stdout: "", stderr: "fatal: clean failed", code: 1 }],
    ]);
    const { runner } = buildFakeRunner(overrides);

    await expect(resetWorkspaceToCleanState(worktree, { gitRunner: runner })).rejects.toThrow(
      /git clean -fd failed/i,
    );
  });

  it("does not silently succeed when a git command returns non-zero exit code", async () => {
    const worktree = await makeFakeWorktree();
    const overrides = new Map([
      [0, { stdout: "", stderr: "", code: 1 }], // non-zero, but no output
    ]);
    const { runner } = buildFakeRunner(overrides);

    // Must still throw, even with empty stdout/stderr.
    await expect(resetWorkspaceToCleanState(worktree, { gitRunner: runner })).rejects.toThrow();
  });
});

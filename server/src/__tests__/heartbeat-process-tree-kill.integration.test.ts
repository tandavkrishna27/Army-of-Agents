import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveProcessGroupId,
  signalRunningProcess,
} from "@armyofagents/adapter-utils/server-utils";

/**
 * Integration test: prove signalRunningProcess actually kills the whole
 * process tree on POSIX, not just the parent.
 *
 * Strategy:
 *   1. Write a small fixture script to a tempdir.
 *   2. spawn() the script with detached:true (matches runChildProcess).
 *   3. The fixture script spawns its own child (a long-running sleep).
 *   4. Wait until the grandchild has its PID printed to a file we read.
 *   5. Call signalRunningProcess on the parent.
 *   6. Verify both the parent AND the grandchild PIDs are gone.
 *
 * Skipped on Windows: process.kill(-pgid) is POSIX-only. Windows uses
 * child.kill which only signals the parent (known limitation; a
 * separate follow-up could add taskkill /T /F).
 */
describe("signalRunningProcess (integration)", () => {
  it.skipIf(process.platform === "win32")(
    "kills both the parent and any subprocess children via process group signaling",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "aoa-tree-kill-"));
      const fixtureScript = join(dir, "spawn-child.sh");
      const grandchildPidFile = join(dir, "grandchild.pid");

      // Bash script: background a sleep, write its PID, then wait.
      // `wait` keeps bash itself alive, giving us a 2-process tree
      // (bash parent + sleep grandchild) for the test.
      await writeFile(
        fixtureScript,
        [
          "#!/bin/bash",
          "set -e",
          "sleep 30 &",
          'echo "$!" > "' + grandchildPidFile + '"',
          "wait",
        ].join("\n"),
        { mode: 0o755 },
      );

      const child = spawn("/bin/bash", [fixtureScript], {
        detached: true,
        stdio: "ignore",
      });

      try {
        const processGroupId = resolveProcessGroupId(child);
        expect(processGroupId).toBe(child.pid);
        expect(processGroupId).toBeGreaterThan(0);

        // Wait for the fixture to write the grandchild PID. Poll up to 5s.
        const grandchildPid = await waitForPidFile(grandchildPidFile, 5000);
        expect(grandchildPid).toBeGreaterThan(0);

        // Both should be alive at this point.
        expect(isAlive(child.pid!)).toBe(true);
        expect(isAlive(grandchildPid)).toBe(true);

        // Signal the whole group with SIGTERM.
        signalRunningProcess({ child, processGroupId }, "SIGTERM");

        // Wait up to 5 seconds for both to die. Bash signal-dispatch on a
        // hot-loaded CI runner can take >1s; 5s gives comfortable headroom
        // without hiding a real failure (the test exits as soon as both
        // PIDs are reaped, typically <500ms locally).
        await waitForDeath([child.pid!, grandchildPid], 5000);

        expect(isAlive(child.pid!)).toBe(false);
        expect(isAlive(grandchildPid)).toBe(false);
      } finally {
        // Cleanup: best-effort kill in case the test bailed mid-flight.
        try {
          if (child.pid && isAlive(child.pid)) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // ignore
        }
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    20_000,
  );
});

/**
 * Returns true if a process is currently alive (POSIX `kill -0` semantics
 * via Node's process.kill with signal 0).
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // process.kill(pid, 0) ALSO succeeds for a ZOMBIE (a dead process awaiting
  // reaping). When the group SIGTERM kills the bash parent before it reaps its
  // `sleep` grandchild, the grandchild zombies until init reaps it. A zombie is
  // effectively dead, so on Linux inspect /proc and treat state 'Z' as dead;
  // otherwise trust the kill(0) result.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
    return state !== "Z";
  } catch {
    // On Linux a failed /proc read after a successful kill(0) means the pid was
    // just reaped (dead). Other platforms have no /proc; trust kill(0) (alive).
    return process.platform !== "linux";
  }
}

/**
 * Polls `path` until a numeric PID is written, or timeoutMs elapses.
 */
async function waitForPidFile(path: string, timeoutMs: number): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(path, "utf-8")).trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // ENOENT — fixture hasn't written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for PID file at ${path}`);
}

/**
 * Polls until all PIDs are dead, or timeoutMs elapses.
 */
async function waitForDeath(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Don't throw — let the assertion fail with a precise message.
}

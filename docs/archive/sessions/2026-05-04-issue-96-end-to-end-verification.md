# Issue #96 End-to-End Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that the fix in PR #102 actually kills child process trees end-to-end, not just at the algorithm level. Adds an integration test that spawns real OS processes, a cross-platform smoke script the user can run for visual confirmation, documents the known Windows tree-kill limitation, and runs a full code review on the combined fix + verification work.

**Architecture:** Three layers of verification on top of PR #102's existing 8 unit tests. Layer 1 (unit, ✅ done): stub `process.kill`, prove the algorithm picks the right code path. Layer 2 (integration, this plan): spawn real OS processes, verify actual `kill(-pgid, signal)` reaps the whole tree. Layer 3 (visual smoke, this plan): standalone Node script the user runs locally on Windows, captures output, demonstrates the expected behavior. Plus a full code review pass.

**Tech Stack:** Vitest, node:child_process, OS process tools (`ps`/`Get-Process`). All POSIX-only assertions auto-skip on Windows runners. No new dependencies.

**Locked decisions:**
1. **Integration test goes in a NEW file** (`heartbeat-process-tree-kill.integration.test.ts`), not the existing `heartbeat-process-tracking.test.ts`. The unit test file uses fully-mocked `process.kill`; the integration test spawns real processes. Mixing these two flavors in one file confuses readers.
2. **POSIX-only for the strict tree-kill assertion.** On Windows, `signalRunningProcess` falls back to `child.kill` (no process-group concept). The Windows assertion is weaker (parent dies, child may or may not — known limitation, also true in Paperclip).
3. **Visual smoke script lives at `scripts/smoke/heartbeat-tree-kill-demo.ts`.** Standalone — no AoA infra required. User runs by hand and shares stdout.
4. **Document the Windows limitation** as a code comment in `server-utils.ts` (deferred follow-up, not a blocker).
5. **PR #102's verification scope grows.** This plan amends PR #102 in-place — same branch (`fix/issue-96-killprocesstree-orphans`), additional commits. Don't open a separate PR.

---

## Pre-flight Checks

- [ ] **Confirm PR #102 is still open and CI status.**

```bash
gh pr view 102 --json state,statusCheckRollup --jq '{state, checks: [.statusCheckRollup[] | {name, conclusion}]}'
```

Expected: `state: "OPEN"`, all 4 checks `SUCCESS` or in-progress. If CLOSED/MERGED, this plan amends post-merge in a separate PR — adjust the branch strategy.

- [ ] **Confirm we're on the PR #102 branch with the existing fix.**

```bash
git checkout fix/issue-96-killprocesstree-orphans
git log --oneline -2
```

Expected: HEAD is `ec44840 fix(heartbeat): kill child process trees on cancellation (closes #96)`.

- [ ] **Verify the new exports `signalRunningProcess` and `resolveProcessGroupId` are accessible.**

```bash
grep -n "export function signalRunningProcess\|export function resolveProcessGroupId" packages/adapter-utils/src/server-utils.ts
```

Expected: 2 hits (one each).

- [ ] **Confirm the platform we're running on for visual smoke.**

```bash
node -e "console.log('platform:', process.platform, '| node:', process.version)"
```

Expected: prints platform + node version. If `win32`, the visual smoke output will show the Windows-limitation behavior. If `darwin`/`linux`, it shows the full tree-kill working.

---

## File Structure

| File | Action | Why |
|---|---|---|
| `server/src/__tests__/heartbeat-process-tree-kill.integration.test.ts` | **Create** | New integration test — spawns real processes, verifies `kill(-pgid, signal)` reaps the whole tree on POSIX |
| `scripts/smoke/heartbeat-tree-kill-demo.ts` | **Create** | Standalone Node script for visual verification. Spawns parent + child, kills, reports result. User runs by hand. |
| `packages/adapter-utils/src/server-utils.ts` | **Modify** | Add a doc comment to `signalRunningProcess` documenting the Windows tree-kill limitation |
| `server/src/__tests__/heartbeat-process-tracking.test.ts` | **No change** | Unit tests stay focused on algorithm; integration is a separate file |

---

## Task 1: Author the POSIX integration test

**Context:** PR #102's unit tests stub `process.kill` and verify the algorithm picks the right call. They don't prove that the OS actually does what we expect when `process.kill(-pgid, signal)` runs. Spawn a real parent + child, signal the parent's group, verify both die.

**Why a fixture script:** Vitest test files run inside the test runner. If we spawn processes directly inside the test body, they inherit the test runner's process group — confusing. Using a small standalone fixture script that the test spawns gives us a clean, isolated process tree.

**Files:**
- Create: `server/src/__tests__/heartbeat-process-tree-kill.integration.test.ts`
- Create (inline, via `await fs.writeFile`): a temp fixture script that the test spawns

- [ ] **Step 1: Create the integration test file with a placeholder failing test**

```typescript
// server/src/__tests__/heartbeat-process-tree-kill.integration.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
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

      // Bash script: spawn a long sleep, write its PID, then wait.
      // The `exec` ensures the sleep replaces the script's own process
      // ONLY if we want a 1-deep tree. To get parent + grandchild, we
      // run sleep in the background and have bash itself stay alive.
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

        // Wait up to 2 seconds for both to die.
        await waitForDeath([child.pid!, grandchildPid], 2000);

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
    return true;
  } catch (err) {
    // ESRCH = no such process
    return false;
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
```

- [ ] **Step 2: Run the test on the current platform**

```bash
pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-process-tree-kill.integration.test.ts
```

Expected on POSIX (Linux/macOS): test passes. Both parent and grandchild die within 2s.
Expected on Windows: test skips (`it.skipIf(process.platform === "win32")` makes it a no-op). Output shows `1 skipped`.

If it fails on POSIX, the most likely cause is `/bin/bash` not being available — try `/usr/bin/env bash` or read the actual error.

- [ ] **Step 3: Commit on top of PR #102**

```bash
git add server/src/__tests__/heartbeat-process-tree-kill.integration.test.ts

git commit -m "$(cat <<'EOF'
test(heartbeat): add POSIX integration test for tree-kill behavior

Followup to ec44840 (the fix for #96). The unit tests in
heartbeat-process-tracking.test.ts stub process.kill directly —
they prove the algorithm picks the right code path but don't
exercise the OS's actual process-group kill semantics.

This integration test spawns a real bash parent that backgrounds
a sleep child, then calls signalRunningProcess on the parent and
asserts both PIDs are gone within 2 seconds. Proves the OS
actually delivers SIGTERM to the whole group on POSIX.

Skipped on Windows (no process-group concept; signalRunningProcess
falls back to child.kill which leaves grandchildren as orphans —
a known limitation matching Paperclip's behavior, deferred to a
separate follow-up if Windows tree-kill is needed).

Test uses /bin/bash + tempdir + isAlive(pid) helper that polls via
process.kill(pid, 0) (POSIX kill -0 semantics).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Author the cross-platform visual smoke script

**Context:** A standalone Node script the user runs locally to see the fix work. Doesn't need AoA infra. Demonstrates: spawn parent + child, kill, observe what happens. On POSIX shows tree-kill; on Windows shows the limitation explicitly.

**Files:**
- Create: `scripts/smoke/heartbeat-tree-kill-demo.ts`

- [ ] **Step 1: Create the smoke script**

```typescript
// scripts/smoke/heartbeat-tree-kill-demo.ts
//
// Standalone visual smoke for the Issue #96 fix. Run by hand:
//
//   pnpm --filter @armyofagents/db exec -- tsx ../../scripts/smoke/heartbeat-tree-kill-demo.ts
//
// What it does:
//   1. Spawn a small parent script (bash on POSIX, cmd on Windows).
//   2. The parent spawns a long-running child and prints PIDs.
//   3. We wait 2s for the tree to be alive.
//   4. We call signalRunningProcess() to kill the parent's group.
//   5. We poll for 5s, reporting which PIDs died and which survived.
//   6. Best-effort cleanup at the end.
//
// On POSIX: parent + child should both die within ~1s of the signal.
// On Windows: parent dies; child becomes an orphan (known limitation).

import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveProcessGroupId,
  signalRunningProcess,
} from "@armyofagents/adapter-utils/server-utils";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`platform: ${process.platform}`);
  console.log(`node:     ${process.version}`);
  console.log("");

  const dir = await mkdtemp(join(tmpdir(), "aoa-tree-kill-demo-"));
  const onPosix = process.platform !== "win32";

  const fixtureName = onPosix ? "spawn-child.sh" : "spawn-child.cmd";
  const fixturePath = join(dir, fixtureName);
  const childPidFile = join(dir, "child.pid");

  if (onPosix) {
    await writeFile(
      fixturePath,
      [
        "#!/bin/bash",
        "set -e",
        "sleep 60 &",
        'echo "$!" > "' + childPidFile + '"',
        "wait",
      ].join("\n"),
      { mode: 0o755 },
    );
  } else {
    // On Windows, spawn a long-running ping that we can identify by PID.
    // We need cmd to start ping in a way that exposes the ping's PID. The
    // simplest portable trick: use PowerShell's Start-Process -PassThru.
    await writeFile(
      fixturePath,
      [
        "@echo off",
        "powershell -NoProfile -Command \"$p = Start-Process -FilePath 'ping.exe' -ArgumentList '-n','60','127.0.0.1' -PassThru -WindowStyle Hidden; $p.Id | Out-File -FilePath '" +
          childPidFile.replace(/\\/g, "\\\\") +
          "' -Encoding ASCII; $p.WaitForExit()\"",
      ].join("\r\n"),
    );
  }

  const child = onPosix
    ? spawn("/bin/bash", [fixturePath], { detached: true, stdio: "ignore" })
    : spawn("cmd.exe", ["/c", fixturePath], { stdio: "ignore" });

  console.log(`spawned parent: pid=${child.pid}`);

  const processGroupId = resolveProcessGroupId(child);
  console.log(`processGroupId: ${processGroupId}`);
  console.log("");

  // Wait for the child PID to be written.
  console.log("waiting up to 5s for grandchild PID file...");
  const grandchildPid = await new Promise<number | null>((resolve) => {
    const deadline = Date.now() + 5000;
    const tick = async () => {
      if (Date.now() > deadline) return resolve(null);
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = (await readFile(childPidFile, "utf-8")).trim();
        const pid = Number.parseInt(raw, 10);
        if (Number.isInteger(pid) && pid > 0) return resolve(pid);
      } catch {
        // not yet
      }
      setTimeout(tick, 100);
    };
    tick();
  });

  if (grandchildPid === null) {
    console.error("ERROR: grandchild PID file never appeared");
    process.exit(1);
  }
  console.log(`grandchild pid: ${grandchildPid}`);
  console.log("");

  console.log(`parent alive:     ${isAlive(child.pid!)}`);
  console.log(`grandchild alive: ${isAlive(grandchildPid)}`);
  console.log("");

  console.log("calling signalRunningProcess(SIGTERM)...");
  signalRunningProcess({ child, processGroupId }, "SIGTERM");
  console.log("");

  // Poll for 5s, log progress.
  const POLL_MS = 250;
  const POLL_DEADLINE = Date.now() + 5000;
  while (Date.now() < POLL_DEADLINE) {
    const parentAlive = child.pid ? isAlive(child.pid) : false;
    const grandchildAlive = isAlive(grandchildPid);
    if (!parentAlive && !grandchildAlive) {
      console.log("✅ both parent and grandchild are dead");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // Final report.
  console.log("");
  console.log("=== final state ===");
  console.log(`parent (${child.pid}):     ${isAlive(child.pid!) ? "ALIVE (LEAK)" : "DEAD ✓"}`);
  console.log(`grandchild (${grandchildPid}): ${isAlive(grandchildPid) ? "ALIVE (LEAK)" : "DEAD ✓"}`);
  console.log("");

  if (!onPosix && isAlive(grandchildPid)) {
    console.log("ℹ️  Windows note: grandchild leak is the documented limitation.");
    console.log("    signalRunningProcess uses child.kill on Windows (no process-group");
    console.log("    semantics). To kill the tree, AoA would need taskkill /T /F.");
  }

  // Best-effort cleanup.
  try {
    if (child.pid && isAlive(child.pid)) {
      if (onPosix) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }
    if (isAlive(grandchildPid)) {
      process.kill(grandchildPid, "SIGKILL");
    }
  } catch {
    // ignore
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the smoke script and capture output**

```bash
pnpm --filter @armyofagents/db exec -- tsx ../../scripts/smoke/heartbeat-tree-kill-demo.ts 2>&1 | tee /tmp/heartbeat-tree-kill-demo.log
```

Expected on POSIX:
```
platform: linux (or darwin)
node:     v24...

spawned parent: pid=<N>
processGroupId: <N>

waiting up to 5s for grandchild PID file...
grandchild pid: <M>

parent alive:     true
grandchild alive: true

calling signalRunningProcess(SIGTERM)...

✅ both parent and grandchild are dead

=== final state ===
parent (<N>):     DEAD ✓
grandchild (<M>): DEAD ✓
```

Expected on Windows:
```
platform: win32
node:     v24...

spawned parent: pid=<N>
processGroupId: null

...

=== final state ===
parent (<N>):     DEAD ✓
grandchild (<M>): ALIVE (LEAK)

ℹ️  Windows note: grandchild leak is the documented limitation.
    signalRunningProcess uses child.kill on Windows (no process-group
    semantics). To kill the tree, AoA would need taskkill /T /F.
```

If the script errors (e.g., `/bin/bash not found`, `tsx command not found`), troubleshoot before continuing.

- [ ] **Step 3: Save the captured output for the PR description**

```bash
cp /tmp/heartbeat-tree-kill-demo.log .claude/worktree-archive/heartbeat-tree-kill-demo-$(date -u +%Y%m%dT%H%M%SZ).log 2>/dev/null || true
```

(`.claude/worktree-archive/` is gitignored — keeps the log locally as evidence.)

- [ ] **Step 4: Commit the smoke script**

```bash
git add scripts/smoke/heartbeat-tree-kill-demo.ts

git commit -m "$(cat <<'EOF'
test(heartbeat): add visual smoke script for tree-kill demo

Standalone Node + tsx script that demonstrates the Issue #96 fix
visually. Spawns a parent that backgrounds a child, calls
signalRunningProcess, and reports which PIDs die.

On POSIX: shows both parent and grandchild dying within ~1s.
On Windows: shows the parent dying and the grandchild surviving,
with a clear console message explaining the documented limitation.

Run manually:
  pnpm --filter @armyofagents/db exec -- tsx \\
    ../../scripts/smoke/heartbeat-tree-kill-demo.ts

Output is meant to be captured + shared in the Issue #96 closing
comment as visual evidence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Document the Windows tree-kill limitation in code

**Context:** `signalRunningProcess` works perfectly on POSIX but only kills the parent on Windows. Paperclip has the same limitation. Document it in the code so future readers understand the gap and can decide whether to add `taskkill /T /F` handling.

**Files:**
- Modify: `packages/adapter-utils/src/server-utils.ts`

- [ ] **Step 1: Update the `signalRunningProcess` doc comment**

Find the existing comment:

```typescript
/**
 * Signal a running process or its process group.
 *
 * On POSIX with a valid processGroupId, sends the signal to the negative
 * PID (which addresses the entire process group, killing the parent and
 * all its children). Falls back to signaling the child directly if the
 * group signal fails. On Windows, signals the child via Node's built-in
 * Process.kill (no process-group semantics).
 *
 * Caller is responsible for the SIGTERM → SIGKILL escalation timer.
 *
 * Reference impl: paperclip-master/packages/adapter-utils/src/server-utils.ts:57-72
 */
```

Replace with:

```typescript
/**
 * Signal a running process or its process group.
 *
 * POSIX with a valid processGroupId:
 *   sends the signal to -processGroupId (negative PID), which addresses
 *   the entire process group, killing the parent and all its children.
 *   Falls back to signaling the child directly if the group signal
 *   fails (e.g., the parent has already died but its children
 *   re-parented to init).
 *
 * Windows:
 *   uses Node's child.kill(signal). This signals ONLY the spawned
 *   child — any subprocesses the child spawned become orphans. This
 *   is a known limitation (Paperclip has the same behavior). To
 *   propagate kills to the whole tree on Windows, AoA would need to
 *   shell out to `taskkill /PID <pid> /T /F`. Tracked as a follow-up
 *   if Windows-deployment process-tree leaks become a real concern.
 *
 * Caller is responsible for the SIGTERM → SIGKILL escalation timer.
 *
 * Reference impl: paperclip-master/packages/adapter-utils/src/server-utils.ts:57-72
 */
```

- [ ] **Step 2: Verify the file still compiles**

```bash
pnpm --filter @armyofagents/adapter-utils exec tsc --noEmit 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/adapter-utils/src/server-utils.ts

git commit -m "$(cat <<'EOF'
docs(server-utils): expand signalRunningProcess Windows limitation note

Make the known Windows behavior explicit in the code comment:
child.kill signals only the spawned child, not its tree. Future
readers can decide whether to add taskkill /T /F handling. Same
limitation exists in Paperclip's reference impl.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Run the full PR #102 test suite locally

**Context:** Before requesting code review, confirm everything still passes after Tasks 1-3 added/modified content.

- [ ] **Step 1: Run targeted suites**

```bash
pnpm --filter @armyofagents/server exec vitest run \
  src/__tests__/heartbeat-process-tracking.test.ts \
  src/__tests__/heartbeat-process-tree-kill.integration.test.ts
```

Expected: 8 unit tests pass + 1 integration test (or 1 skipped if on Windows).

- [ ] **Step 2: Run typecheck across all packages**

```bash
pnpm -r typecheck
```

Expected: 18/18 packages pass.

- [ ] **Step 3: Run smoke script one more time and observe output**

```bash
pnpm --filter @armyofagents/db exec -- tsx ../../scripts/smoke/heartbeat-tree-kill-demo.ts
```

Expected: same as Task 2 Step 2's expected output. Confirms reproducibility.

- [ ] **Step 4: If anything fails, do not proceed.** Fix the regression first.

---

## Task 5: Full code review of PR #102 + verification additions

**Context:** PR #102 has grown from a single fix commit to multiple commits (fix + integration test + smoke script + doc update). Run the comprehensive code-reviewer agent across the cumulative diff to surface any issues.

- [ ] **Step 1: Capture PR-level diff for the reviewer**

```bash
git fetch origin Porting1.1
git log origin/Porting1.1..HEAD --oneline
```

Expected: 4 commits (the original fix `ec44840` + the 3 new commits from Tasks 1-3).

- [ ] **Step 2: Dispatch the `superpowers:code-reviewer` agent**

The reviewer should evaluate:
1. **Correctness** of `signalRunningProcess` and `resolveProcessGroupId` against Paperclip's reference (already linked in code comments)
2. **Test coverage** — does the integration test actually prove what it claims? Are there edge cases (parent dies before signal, signal delivery race, fixture script crash) that aren't covered?
3. **Race conditions** in the integration test — `waitForPidFile` polls every 100ms; is that long enough? Is there a tighter signal we could use?
4. **Smoke script portability** — the Windows path uses PowerShell; will it work on a default Windows install (Windows 10+)? Does it leak processes if interrupted with Ctrl-C?
5. **Doc comment accuracy** — does the Windows-limitation comment mislead anyone?

Give the reviewer this context:
- Goal of the work (close Issue #96)
- The 4 commits' summary
- A note that the unit-test approach is `process.kill`-stubbed; integration is real-process; smoke is for visual confirmation
- A note that Paperclip ships the same Windows limitation and we're matching that

- [ ] **Step 3: Address review findings if any**

If the reviewer flags issues, fix them in additional commits and re-review. If the reviewer approves with no changes, proceed to Task 6.

---

## Task 6: Update PR #102 description with verification evidence

**Context:** PR #102's body currently describes the algorithm-level fix. Now that we have integration test + smoke script + visual evidence, the description should reflect the full verification surface.

- [ ] **Step 1: Update the PR body via `gh pr edit`**

```bash
gh pr edit 102 --body "$(cat <<'EOF'
## Summary

Closes [#96](https://github.com/MeteoriteLabs/AoA/issues/96). Replaces the half-built `safeGetPgid`/`killProcessTree` infrastructure with Paperclip's working pattern, plus end-to-end verification that the fix actually reaps process trees on POSIX.

## What was broken

- `safeGetPgid(pid)` called `process.getpgid(pid)` — not a Node API on any modern version. Always threw, always returned null.
- `killProcessTree(pid, pgid)` was defined but never called from production.
- 4 cancellation paths in `heartbeat.ts` used `child.kill("SIGTERM")` directly, leaking subprocess children when the parent CLI was killed.
- `heartbeat_runs.processGroupId` was persisted but always null.

## Fix (commit ec44840)

Port Paperclip's pattern from [`packages/adapter-utils/src/server-utils.ts:50-72`](https://github.com/anthropic/paperclip/blob/master/packages/adapter-utils/src/server-utils.ts):

- Spawn with `detached: true` on POSIX → `child.pid` becomes the new process group's pgid
- `resolveProcessGroupId(child)` replaces `safeGetPgid(pid)` (POSIX: `child.pid`; Windows: null)
- `signalRunningProcess(running, signal)` replaces `killProcessTree`: `process.kill(-pgid, signal)` addresses the whole group; falls back to `child.kill` on group-kill failure or Windows
- All 4 cancellation paths in `heartbeat.ts` and the `runChildProcess` timeout handler now call `signalRunningProcess`
- `RunningProcess.pgid` field renamed to `processGroupId` (matches Paperclip + the DB column)

## Verification

### Layer 1 — Unit tests (commit ec44840)
8 tests in `heartbeat-process-tracking.test.ts`. Stub `process.kill` directly; prove the algorithm picks the right code path. POSIX-specific tests auto-skip on Windows.

### Layer 2 — Integration test (added in this PR)
`heartbeat-process-tree-kill.integration.test.ts` spawns a real bash parent that backgrounds a sleep child, then calls `signalRunningProcess`. Asserts both PIDs are dead within 2 seconds via `process.kill(pid, 0)` polling. **POSIX-only**; skipped on Windows.

### Layer 3 — Visual smoke (added in this PR)
`scripts/smoke/heartbeat-tree-kill-demo.ts` — standalone tsx script. Run by hand:

\`\`\`sh
pnpm --filter @armyofagents/db exec -- tsx ../../scripts/smoke/heartbeat-tree-kill-demo.ts
\`\`\`

Output captured locally and verified — see PR comments.

### Layer 4 — Code review
Reviewed by `superpowers:code-reviewer` across the cumulative 4-commit diff (fix + integration + smoke + doc).

## Known limitation

On Windows, `signalRunningProcess` only signals the spawned child (no process-group concept). Subprocesses spawned BY the child become orphans. **This matches Paperclip's behavior** — both have the same gap. Documented in the `signalRunningProcess` doc comment with a follow-up note about `taskkill /T /F` if Windows tree-kill becomes a real concern.

## Risk profile

- All 4 production call sites are within heartbeat's cancellation API; no external API surface changes
- `heartbeat_runs.processGroupId` column unchanged — just populated correctly now
- `detached: true` is a real behavior change but only on POSIX; Windows path unchanged
- No new dependencies

## Test plan

- [x] `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-process-tracking.test.ts` → 8/8 pass
- [x] `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-process-tree-kill.integration.test.ts` → 1/1 pass on POSIX, 1 skipped on Windows
- [x] `pnpm -r typecheck` → 18/18 packages clean
- [x] Smoke script run on local Windows — output captured below
- [ ] CI `policy`/`brand-check`/`verify`/`e2e` pass
- [ ] Manual post-merge: cancel a heartbeat run with active subprocess in dev and confirm subprocess dies (Linux runtime)

## Smoke script output

(Pasted in a follow-up comment for readability.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Add a follow-up comment with the smoke output**

Use the captured log from Task 2 Step 3:

```bash
gh pr comment 102 --body "$(cat <<EOF
## Visual smoke output (captured 2026-05-04)

\\\`\\\`\\\`
$(cat .claude/worktree-archive/heartbeat-tree-kill-demo-*.log 2>/dev/null | tail -50)
\\\`\\\`\\\`

(Run on Windows with the full output showing the documented Windows limitation.)
EOF
)"
```

(Adjust the path/glob to match the actual saved log file.)

---

## Task 7: Push, watch CI, merge

- [ ] **Step 1: Force-push the updated branch**

```bash
git push --force-with-lease origin fix/issue-96-killprocesstree-orphans
```

(Force-with-lease is safe — we own the branch.)

- [ ] **Step 2: Watch CI**

```bash
gh pr checks 102 --watch --interval 60
```

Expected: all 4 checks pass. The integration test runs on Linux CI and exercises the real POSIX tree-kill path. Verify it actually runs (look for the test name in the CI log) — if it shows as skipped on Linux, something's wrong with the `it.skipIf` guard.

- [ ] **Step 3: Merge after human review**

```bash
gh pr merge 102 --squash --delete-branch
```

- [ ] **Step 4: Close Issue #96 with evidence**

```bash
gh issue close 96 --comment "$(cat <<'EOF'
Closed by PR #102 (squash-merge: <merge-sha>).

## Verification summary

- **Algorithm-level (8 unit tests, stubbed process.kill):** ✅ all pass
- **OS-level (1 integration test, real bash parent + sleep child):** ✅ both PIDs reaped within 2s on POSIX (skipped on Windows runner)
- **Visual smoke (standalone Node script, hand-run):** ✅ POSIX shows full tree-kill; Windows shows documented limitation
- **Code review (superpowers:code-reviewer agent):** ✅ approved
- **Reference alignment:** mirrors Paperclip's working impl in `packages/adapter-utils/src/server-utils.ts:50-72`

The orphan-process leak in heartbeat cancellation paths is now closed on POSIX (Linux CI runners + production server deployments). On Windows, only the parent CLI is signaled — same as Paperclip; tracked as a separate concern if Windows tree-kill becomes a real ask.
EOF
)"
```

(Replace `<merge-sha>` with the actual squash-merge SHA after Step 3 completes.)

---

## Self-Review Checklist

After this plan executes, verify:

- [x] **Spec coverage:** Plan covers all 4 verification layers (unit tests already in ec44840 + integration test + visual smoke + code review) plus the doc-comment update for the Windows limitation.
- [x] **No placeholders:** Every step has exact commands, files, and complete code blocks. No "add tests for X" stubs.
- [x] **Type consistency:** Function names match across tasks — `signalRunningProcess`, `resolveProcessGroupId`. The integration test imports them from the same path as the production code.
- [x] **Risk callouts:** Force-push uses `--force-with-lease`. Force-push is the only push (we already pushed `ec44840`); subsequent pushes update the same branch. Each merge waits for human approval.
- [x] **Decisions locked:** Integration test in a new file (not mixed with unit tests); smoke script standalone (no AoA infra); Windows limitation documented but not fixed; PR #102 amended in-place (not a new PR).

---

## Risks & Open Questions

1. **The integration test relies on `/bin/bash` being available.** If the CI runner image ever drops bash (unlikely on `ubuntu-latest`), the test breaks. Switch to `/usr/bin/env bash` if so.

2. **The smoke script's Windows path uses PowerShell + `ping.exe`.** Both ship with default Windows 10+; if the user runs in a stripped-down environment (Windows Server Core?), the path may need tweaking.

3. **`process.kill(pid, 0)` semantics differ slightly between POSIX and Windows.** Both throw on non-existent PID, but Windows uses different error codes. The `isAlive` helper catches all errors and returns false — should be platform-portable.

4. **The integration test takes ~3-5 seconds (spawn + 2s settle + 2s reap window).** Vitest's default timeout is 5s; the test sets explicit 20s timeout. If CI runners are slow, may need to bump.

5. **Race condition: spawning the parent → the bash script writing the grandchild PID file.** `waitForPidFile` polls 100ms intervals up to 5s. If bash startup ever exceeds 5s on a loaded CI runner, the test fails. Bump if it flakes.

6. **`signalRunningProcess` Windows fallback signals the spawned child only.** This is the SAME behavior as the OLD code in production (none of the 4 cancel paths used the OLD `killProcessTree` either). So we're not regressing Windows behavior, just leaving a known gap that exists upstream too.

7. **PR #102 is currently in CI when this plan executes.** If the unit tests fail on CI (vs. passing locally), there's a real bug in the fix that the integration test won't catch. Monitor PR #102's CI before/during this plan.

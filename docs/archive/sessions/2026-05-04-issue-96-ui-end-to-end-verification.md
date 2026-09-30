# Issue #96 UI-Driven End-to-End Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify Issue #96's killProcessTree fix works in the actual production code path — not just in unit tests, integration tests, or smoke scripts. Run the AoA dev stack, create a real heartbeat task that spawns a known process tree, cancel it via the UI, observe whether subprocess children actually die. Document findings; if behavior diverges from expectations, open a follow-up.

**Architecture:** Configure a `process`-type agent whose runtime command spawns a parent + child process tree (parent backgrounds a long-running command and waits). Trigger a heartbeat run by creating a task. Capture parent + child PIDs from the `heartbeat_runs` row + the OS process table. Cancel via UI button. Capture process tree state again. Compare against platform-specific expectations.

**Tech Stack:** AoA dev (PGlite + embedded Postgres), `process` adapter (`packages/adapters/process` not a separate package — defined in `server/src/adapters/process/execute.ts`). OS observation: `tasklist` on Windows, `ps` on POSIX. Optional Playwright for UI automation.

**Locked decisions:**
1. **Use the `process` adapter, not `claude_local`/`codex_local`.** The process adapter takes any command — no LLM tokens, fully controllable, testable without API keys.
2. **The test command spawns a 2-deep tree** (parent + child). Sufficient to demonstrate tree-kill semantics. Going deeper adds noise without new signal.
3. **Capture PIDs via DB query**, not parsing logs. After spawn, `heartbeat_runs.processPid` and `heartbeat_runs.processGroupId` are populated by `onSpawn`. Querying them is more reliable than scanning stdout.
4. **Manual UI clicks for the cancel action** (initial pass), Playwright automation as a follow-up if we want to bake this into CI.
5. **Two platform paths in the same plan:**
   - **Path A (Windows, primary):** confirms documented Windows limitation matches reality. User is on Windows; lowest setup overhead.
   - **Path B (WSL/Linux, optional):** validates the actual POSIX tree-kill works in the heartbeat dispatcher. Already proven by the integration test on Linux CI; doing this locally is belt-and-suspenders.

---

## Pre-flight Checks

- [ ] **Confirm AoA dev environment can start.**

```bash
git checkout Porting1.1
git pull
pnpm install --frozen-lockfile
```

Expected: clean install. If `pnpm-lock.yaml` is out of sync (rare after the recent merges), the install will error — re-fetch and try again.

- [ ] **Confirm Issue #96's fix is actually on Porting1.1.**

```bash
grep -n "signalRunningProcess\|resolveProcessGroupId" packages/adapter-utils/src/server-utils.ts | head -5
```

Expected: at least 2 hits (the function definitions). If empty, the fix didn't merge — STOP and investigate.

- [ ] **Confirm the `process` adapter is registered.**

```bash
grep -n "process_local\|adapterType.*process" server/src/adapters/registry.ts 2>&1 | head -5
```

Expected: shows `"process"` listed in the adapter registry.

- [ ] **Pick the platform path** (A or B) and continue with that path's tasks. Path A is shorter and what most readers will use.

---

## File Structure

| File | Action | Why |
|---|---|---|
| `(no production code changes)` | — | This is verification only; no code modifications |
| `scripts/smoke/heartbeat-tree-kill-via-ui.md` | **Create** | Step-by-step recipe with exact UI clicks + verification commands. Lives next to the existing smoke script for discoverability. |
| `(local test instance)` | **Use ad-hoc** | Company, agent, task created during the test; deleted after |

---

## Path A: Windows Verification (~30 min)

**Expected behavior:** Parent process (cmd.exe wrapping our test command) dies on cancel. Grandchild (`ping.exe`) survives — same documented limitation as the smoke script demonstrated.

If actual behavior differs, that's a real surprise worth investigating.

### Task A1: Start AoA dev server

**Files:** none modified.

- [ ] **Step 1: In a dedicated terminal, start AoA dev**

```bash
pnpm dev
```

Expected: prints something like `API + UI: http://localhost:3100`. Leave the terminal running.

- [ ] **Step 2: In a separate browser, open http://localhost:3100**

Expected: AoA UI loads. If it errors with `database not initialized` or similar, run `pnpm db:migrate` and restart `pnpm dev`.

- [ ] **Step 3: Confirm at least one company exists**

In the UI, look at the company switcher (top-left). If empty, create a company:
1. Click `+ New Company` (or wherever the create flow is)
2. Name it `KillTreeTest`
3. Use issuePrefix `KTT`

If a company already exists, use it — name doesn't matter.

### Task A2: Create the test agent with the `process` adapter

**Files:** none modified — config-via-UI.

- [ ] **Step 1: Navigate to the Team page**

Click `TEAM` in the left sidebar.

- [ ] **Step 2: Click `+ Hire Agent` or the equivalent "create agent" button**

(If the company has agent-board-approval enabled, this opens a hire-approval flow — approve it through the Inbox. Otherwise the agent is created directly.)

- [ ] **Step 3: Fill in the agent form with these exact values**

| Field | Value |
|---|---|
| Name | `Tree Kill Test Agent` |
| Role | `general` |
| Adapter Type | `process` |
| Command | `cmd.exe` |
| Args (JSON array) | `["/c", "echo started && ping -n 60 127.0.0.1 > nul && echo done"]` |
| cwd | (leave empty / default) |
| timeoutSec | `0` (no timeout — we'll cancel manually) |
| graceSec | `5` (short grace period to make SIGKILL escalation visible) |

The `args` create a 2-process tree: cmd.exe is the parent (the spawned child), and `ping.exe` becomes the grandchild.

- [ ] **Step 4: Save the agent**

If the UI lacks a freeform "command + args" editor for the process adapter, **fall back to direct DB insertion**:

```bash
node -e "
const path = require('path');
process.chdir('packages/db');
const { execSync } = require('child_process');
execSync('pnpm migrate', { stdio: 'inherit' });
const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
// (full insert SQL below for brevity — see Task A2 fallback in this plan's repo)
"
```

(If you hit this fallback, ask the controller for the exact SQL — it depends on the schema state at the time.)

### Task A3: Trigger the heartbeat run by creating a task

**Files:** none modified.

- [ ] **Step 1: Navigate to Tasks page**

Click `Tasks` in the WORK sidebar.

- [ ] **Step 2: Click `+ New Task`**

- [ ] **Step 3: Fill in the task form**

| Field | Value |
|---|---|
| Title | `KillTree experiment task` |
| Description | `Used by the Issue #96 UI verification plan.` |
| Assigned To | `Tree Kill Test Agent` (the one from Task A2) |
| Status | `todo` (initial) |

Save the task.

- [ ] **Step 4: Wait for the heartbeat to pick it up**

The heartbeat polling interval is short (every few seconds in dev). Within ~10s, the task status flips from `todo` → `in_progress`, and the agent's status flips from `idle` → `active`.

In the UI, refresh the task page or watch the agent card on the Team page.

If after 30s nothing happens, check the AoA dev server stdout for errors (e.g., adapter registration issues). STOP and investigate.

### Task A4: Capture the parent PID and grandchild PID before cancel

**Files:** none modified — observation only.

- [ ] **Step 1: Query the heartbeat_runs row for the parent PID + PGID**

In the dev terminal (or a new one):

```bash
# Find the run for our agent. PostgreSQL via pglite:
node -e "
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect().then(async () => {
  const { rows } = await c.query(
    \"SELECT id, agent_id, status, process_pid, process_group_id, started_at FROM heartbeat_runs ORDER BY started_at DESC LIMIT 5\"
  );
  console.log(rows);
  await c.end();
});
"
```

If `DATABASE_URL` isn't set (PGlite mode), use the AoA HTTP API instead:

```bash
curl -s http://localhost:3100/api/companies | jq .
# Get the companyId, then:
curl -s "http://localhost:3100/api/companies/<COMPANY_ID>/heartbeat-runs?limit=3" | jq '.[] | {id, status, processPid, processGroupId}'
```

Expected output: a recent run with `status: "running"` and `processPid` set to a number (e.g. `19284`). On Windows, `processGroupId` should be `null` (because `resolveProcessGroupId` returns null on Windows).

**Record the parentPid value.** Call it `PARENT_PID`. Example: `PARENT_PID=19284`.

- [ ] **Step 2: Find the grandchild PID via tasklist**

```powershell
# Windows: tasklist /fi to get processes whose ParentProcessId == PARENT_PID
$parentPid = 19284  # replace with actual PARENT_PID
Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentPid" |
  Select-Object ProcessId, Name, ParentProcessId, CommandLine
```

Expected output: one row, `Name: ping.exe`, with its own `ProcessId` (the grandchild). **Record this as `GRANDCHILD_PID`.**

If multiple rows show up, identify the one running `ping`. If zero, the cmd.exe command may not have spawned ping yet — wait 2 seconds and retry.

- [ ] **Step 3: Confirm both processes are alive**

```powershell
$parentPid = 19284  # PARENT_PID
$grandchildPid = 21976  # GRANDCHILD_PID

@($parentPid, $grandchildPid) | ForEach-Object {
  $alive = (Get-Process -Id $_ -ErrorAction SilentlyContinue) -ne $null
  Write-Host "PID $_ alive: $alive"
}
```

Expected: both `alive: True`.

### Task A5: Cancel the run via UI

**Files:** none modified.

- [ ] **Step 1: In the AoA UI, navigate to the running task**

Go to Tasks → click the `KillTree experiment task`.

- [ ] **Step 2: Find the cancel button**

The task slide-over shows the active run. There should be a `Cancel run` button or similar. Click it.

(If you can't find it, the task may have an `Active runs` section with a per-run cancel button. If still nothing, fall back to the cancel-via-API:)

```bash
curl -X POST -H "Content-Type: application/json" \
  http://localhost:3100/api/companies/<COMPANY_ID>/agents/<AGENT_ID>/cancel-active
```

(Replace `<COMPANY_ID>` and `<AGENT_ID>` with the actual IDs from the URL or the heartbeat-runs query.)

- [ ] **Step 3: Wait for the run status to flip**

In the UI, watch the task. Within ~5 seconds, the agent should return to `idle` and the run status should flip to `cancelled`.

If after 30s the status hasn't changed, the cancel didn't reach the heartbeat layer — STOP and investigate the dev server logs.

### Task A6: Capture the post-cancel process tree state

**Files:** none modified.

- [ ] **Step 1: Re-check both PIDs**

```powershell
$parentPid = 19284  # PARENT_PID from Task A4
$grandchildPid = 21976  # GRANDCHILD_PID from Task A4

@($parentPid, $grandchildPid) | ForEach-Object {
  $proc = Get-Process -Id $_ -ErrorAction SilentlyContinue
  $alive = $proc -ne $null
  $name = if ($proc) { $proc.ProcessName } else { "(dead)" }
  Write-Host "PID $_ ($name): $alive"
}
```

- [ ] **Step 2: Compare against expected behavior**

| PID | Expected | Why |
|---|---|---|
| PARENT_PID (cmd.exe) | **DEAD** | `signalRunningProcess` calls `child.kill("SIGTERM")` → Node maps to `TerminateProcess` on Windows |
| GRANDCHILD_PID (ping.exe) | **ALIVE (LEAK)** | Windows has no process-group concept; `child.kill` only signals the spawned cmd.exe, not its children |

**Pass criteria:** parent dead, grandchild alive (matches documented Windows limitation).

If parent stays alive, the cancel button didn't actually run `signalRunningProcess` — investigate the cancel pipeline.

If grandchild dies (unexpected!), great surprise — Windows is doing more than expected. File a follow-up to update the `signalRunningProcess` JSDoc.

### Task A7: Cleanup

**Files:** none modified.

- [ ] **Step 1: Kill the leaked grandchild manually**

```powershell
Stop-Process -Id $grandchildPid -Force
```

- [ ] **Step 2: Delete the test task and agent (optional)**

If you want a clean dev DB:
- UI: navigate to the agent, terminate + delete
- UI: delete the task

Otherwise leave them for the next test run.

- [ ] **Step 3: Document findings**

Write a short markdown summary at `scripts/smoke/heartbeat-tree-kill-via-ui.md` (create the file). Include:
- Date + platform
- Test agent config (command + args)
- Captured PIDs before + after cancel
- Pass/fail per the table in Task A6
- Any surprises

If everything matches, commit + push as a follow-up doc PR. If something surprised, open a follow-up issue with the captured data.

---

## Path B: POSIX Verification via WSL or Linux container (~45 min)

**Expected behavior:** Parent process (bash) dies on cancel. Grandchild (sleep) ALSO dies — `process.kill(-pgid, SIGTERM)` reaps the whole process group.

This is what we want to see for full confidence. Already proven by the integration test on Linux CI; this just provides visual proof on the user's machine.

### Task B1: Choose the POSIX environment

**Three options, pick one:**

#### Option B1a: WSL2 with Ubuntu

```bash
# In WSL Ubuntu shell:
cd "/mnt/c/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5"
pnpm install --frozen-lockfile
pnpm dev
```

Pro: closest to a real Linux environment, runs against the same source tree.
Con: WSL filesystem performance is sluggish for `pnpm install`; the OneDrive sync may interfere.

#### Option B1b: Docker

```bash
# From the repo root on Windows:
docker build -t aoa-dev -f Dockerfile.onboard-smoke .
docker run -p 3100:3100 -it aoa-dev
```

Pro: fully isolated, deterministic.
Con: image build is slow (5-10 min first time); the smoke-onboard Dockerfile may not be ideal for a long-lived dev session.

#### Option B1c: A real Linux machine

If you have access to a Linux dev box, sync the repo there and run `pnpm dev`. Best signal-to-noise but slowest setup.

**Pick one and continue.** The rest of Path B is identical regardless of which env runs the AoA server.

### Task B2: Repeat Tasks A1-A4 with POSIX equivalents

The flow is identical to Path A, but with the **command + args adjusted for bash**:

| Field | Value |
|---|---|
| Command | `/bin/bash` |
| Args (JSON array) | `["-c", "echo started; sleep 60 & wait $!"]` |

This bash script backgrounds a `sleep 60`, then `wait`s on the background job. Backgrounded `sleep` is the grandchild; bash itself is the parent (the spawned process).

Capture `PARENT_PID` from the heartbeat_runs row. Find the grandchild via `ps`:

```bash
ps -ef | grep " $PARENT_PID " | grep -v grep
ps --ppid $PARENT_PID
```

Expected: the second command shows a `sleep` process with the parent_pid matching `PARENT_PID`. **Record its PID as `GRANDCHILD_PID`.**

### Task B3: Cancel via UI, observe the tree

Same as Task A5 — click the cancel button.

After the run flips to `cancelled`, run:

```bash
PARENT_PID=12345  # actual value
GRANDCHILD_PID=12346  # actual value

for pid in $PARENT_PID $GRANDCHILD_PID; do
  if kill -0 $pid 2>/dev/null; then
    echo "PID $pid: ALIVE"
  else
    echo "PID $pid: DEAD"
  fi
done
```

**Pass criteria:** BOTH PIDs report `DEAD`. This is the actual Issue #96 fix in action.

If grandchild survives, the fix isn't reaching the heartbeat path on POSIX — major surprise, file an urgent follow-up.

If parent stays alive, the cancel button didn't reach `signalRunningProcess` — investigate the cancel pipeline.

### Task B4: Cleanup + documentation

Same as Task A7 — kill any leaked PIDs, document findings in the same `scripts/smoke/heartbeat-tree-kill-via-ui.md` (just add a Path B section to whatever Path A wrote).

---

## Optional Task: Automate via Playwright (followup)

**Context:** Manual UI clicks are great for one-off verification, but if Issue #96 is the kind of bug that could regress (large refactor of heartbeat or adapter spawn logic), an automated e2e test that creates the task + cancels + checks PIDs would be worth shipping.

**Files:** Create `tests/e2e/heartbeat-tree-kill.spec.ts` modeled on existing e2e tests.

**Skipping detailed task breakdown** — this is a stretch goal. Only pursue if Path A or Path B reveals a regression worth catching automatically.

---

## Self-Review Checklist

- [x] **Spec coverage:** Plan covers Path A (Windows, primary) and Path B (POSIX, validation). Both end with documented findings or follow-up issues.
- [x] **No placeholders:** Each task has explicit commands. The "fall back to DB insertion" in Task A2 has a placeholder script — but it's a fallback, with explicit instructions to ask the controller for the exact SQL if needed. The runtime config schema (command/args/cwd/timeoutSec/graceSec) is captured as a concrete table.
- [x] **Type consistency:** PARENT_PID, GRANDCHILD_PID variables used consistently across observation steps. Same UI flow on both platforms (only the adapter command differs).
- [x] **Risk callouts:** Mentioned in pre-flight + tasks: dev env not running, adapter not registered, UI lacks command-args editor, cancel doesn't reach heartbeat. Each has a documented next step.
- [x] **Decisions locked:** `process` adapter (not LLM); 2-deep tree; DB query for PID capture; manual UI clicks for cancel.

---

## Risks & Open Questions

1. **The UI may not have a freeform `command + args` editor for `process`-adapter agents.** The plan documents a fallback to direct DB insertion if the UI is restrictive. If neither works, would need to extend the UI — out of scope.

2. **PGlite vs embedded-postgres.** Default dev mode uses PGlite; queries through `node -e` with `DATABASE_URL` won't work. Plan documents an HTTP-API fallback via `curl` for capturing PIDs.

3. **Heartbeat polling interval.** If it's >5s in dev, the "create task → see it run" wait is annoying. The dev server prints an interval in startup logs — adjust expectations if needed.

4. **WSL/Docker first-time setup overhead.** Path B is gated by environment readiness. If neither WSL nor Docker is set up, the user might choose to skip Path B and rely on the integration test's Linux CI evidence.

5. **The cancel button's UI location may have moved.** The plan says "find the cancel button" — if the slide-over UI was reorganized, the user may need to look for it in a different spot. The API fallback works regardless.

6. **Process-tree leak observation timing on Windows.** `Get-CimInstance Win32_Process` is a snapshot; if the test command finishes before observation, the grandchild isn't visible. The 60-second `ping -n 60` gives a comfortable observation window.

7. **Cleanup after a leaked grandchild.** If the user forgets Step A7 Step 1, ping.exe runs for 60s and exits. Not catastrophic but worth flagging.

# W5c Implementation Plan — `codex_local` Runtime-Decision Bridge via Codex `app-server`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Task 1 is a genuine in-repo go/no-go gate — not a formality.** An out-of-repo scratchpad spike (`w5c-spike/appserver-drive.mjs`) proved the blocking approve/deny loop works against a live `codex app-server`, but that file is NOT committed, so nothing in this repo verifies the claim. Task 1 commits the spike into a guarded harness, confirms the approval policy for **both** command and file-change, captures fixtures, and nails framing — and keeps a command-only descope fallback if file-change approvals don't fire. Do not treat any later task's fixtures/policy as settled until Task 1 lands them.

**Status:** Ready to execute · **Base:** main (worktree `C:/Users/TK/.aoa/wt/inbox-hub`, W5b merged) · **Date:** 2026-07-03

---

## Goal

Give `codex_local` agents the same human-in-the-loop **runtime permission bridge** W5b gave `claude_local`: when a supervised Codex run proposes a **risky shell command** or a **file-change patch**, pause the run, surface an approval in the AoA Hub, and relay the founder's decision back into the running turn — **fail-closed** on timeout/error. Permission-only; `work_question` deferred.

Unlike W5b (Claude's approval arrives out-of-process via a `PreToolUse` hook → HTTP callback → per-run token → registry → forwarder), the Codex approval request arrives **in-process on the adapter's own JSON-RPC stdio read loop**. So W5c needs **no HTTP endpoint, no per-run token, no registry, no forwarder** — the adapter calls `ctx.runtimeDecisionBroker.requestPermissionBounded(...)` directly and writes the JSON-RPC response. The hard part is **re-platforming the Codex driver** from `codex exec --json` (one-shot JSONL) to `codex app-server` (a long-lived JSON-RPC 2.0 stdio session), preserving `parseCodexJsonl`'s output contract **and preserving process-lifecycle tracking so the supervised child stays cancellable and un-reapable while it blocks on an approval.**

---

## Architecture

### Two execution paths (dual-path, gated)

```
heartbeat.run()
  └─ resolveRuntimeDecisionRoutingEnabled({ adapterType, executionTargetType, agentRuntimeConfig, instanceEnv })
       │   (true for BOTH claude_local and codex_local when all guards pass)
       │   heartbeat sets ctx.runtimeDecisionRoutingEnabled = true
       │
       ├─ codex_local, flag false → execute()  → EXISTING codex exec --json path (unchanged)
       └─ codex_local, flag true + local target → execute()  → NEW codex app-server driver path
                        │  stdio JSON-RPC 2.0 (newline-delimited)
                        │  child spawned via spawnTrackedChild() → registered in runningProcesses Map
                        ▼
              codex app-server (child): initialize → initialized → thread/start → turn/start → …events…
                   ── SERVER REQUEST: item/commandExecution/requestApproval (or item/fileChange/requestApproval)
                        │ in-process, dispatched OFF the read loop to an async handler
                        ▼
              ctx.runtimeDecisionBroker.requestPermissionBounded({ command|path, cwd, reason, ... }, 300_000ms)
                   allow_once   → result { decision: "accept" }
                   allow_always → result { decision: "acceptForSession" }
                   deny / timeout / throw / unparseable → result { decision: "decline" }   (FAIL-CLOSED)
```

### Key insight (shrinks the bridge)

The broker (`AdapterRuntimeDecisionBroker`) + `requestPermissionBounded` were shipped in W5a/W5b and are **reused unmodified**. `heartbeat.ts` **already passes `runtimeDecisionBroker` into every adapter's execute ctx** (`~:4108`) — codex_local currently ignores it. W5c's server-side wiring is limited to: (1) extend the flag resolver to permit `codex_local` (allow-list); (2) have heartbeat set a new **non-secret boolean** `runtimeDecisionRoutingEnabled` on the ctx whenever the resolver returns true (for BOTH adapters); (3) make codex `execute.ts` branch on that flag. **No new heartbeat registry/token/HTTP surface** — the `mintRuntimeHookToken` / `registerRuntimeHook` / `runtimeHookBridge` / `runtimeHookToken` machinery stays **claude-only and untouched** (codex is in-process and needs no token or registry).

### Process-lifecycle tracking is load-bearing (BLOCKER — the core of the driver)

`heartbeat.cancelRun` (`~:5450`), `cancelActiveForAgent`, and `reapOrphanedRuns` (`~:2163`) **all key on the exported in-memory `runningProcesses` Map** in `packages/adapter-utils/src/server-utils.ts` (`runningProcesses.get(run.id)` / `runningProcesses.has(run.id)`). Today the codex exec path gets tracked because `runChildProcess` inserts the child into that Map at spawn (`server-utils.ts:347`). `ctx.onSpawn` does **not** insert into the Map — it only lets the controller persist `(pid, pgid, startedAt)` to the DB row.

If the app-server driver spawned a bare `node:child_process.spawn` + called `onSpawn`, the child would be **absent from `runningProcesses`**, and two failures follow **directly from the code**:

1. **Uncancellable.** `cancelRun` reads `runningProcesses.get(run.id)`; a `undefined` result means it flips the DB row to `cancelled` **without ever signalling the child** — codex keeps running (and keeps holding the approval prompt open).
2. **Wrongfully reaped at ~5 min.** `reapOrphanedRuns` skips any run where `runningProcesses.has(run.id)` (`:2163`) — **that `has()` skip, which runs BEFORE the staleness check, is exactly and solely what protects W5b's blocked runs** (it is independent of `updatedAt`). For an unregistered child it does **not** skip; it then fails the run against `updatedAt` staleness (`:2176`) with `staleThresholdMs = 5min` (the periodic sweep). Note the timing precisely (do NOT mis-state it in tests): `markRunWaiting` (`~:4050`) calls `setRunStatus(run.id, "running", …)`, and `setRunStatus` **DOES bump `updatedAt`** unconditionally (`:1663`) — once, at the moment the prompt is raised. So an unregistered blocked child gets a fresh `updatedAt` at block-start and then goes stale ~300s later. The approval SLA is `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300s` (`adapter-utils/runtime-hooks.ts:14`), which **coincides** with that 5-min staleness window — so an unregistered supervised run would be reaped right around the moment the human is expected to answer. The registered child is safe purely via the `has()` skip, not via `updatedAt`. (Liveness during the block is written as the string `"waiting_on_human"` at `:4052`; note this string is a W5b runtime value **not present in `RUN_LIVENESS_STATES`** in `constants.ts` — out of scope to fix here, but do NOT wire a test to the typed enum expecting it.)

**Therefore the app-server child MUST be registered in the SAME `runningProcesses` Map, keyed by `run.id`, exactly like `runChildProcess` does.** This is the core of Task 2's client, not a footnote. The fix is a shared `spawnTrackedChild()` helper extracted from `runChildProcess` (§ below), so the exec path and the app-server driver share one registration/kill/escalation/env-strip code path and cannot drift.

### Parse contract the driver must reproduce

`parseCodexJsonl(stdout)` returns `{ sessionId, summary, chunks, usage, errorMessage }`. The app-server path re-derives each from **notifications** using the **same shared parser helpers** (`liftOutputRefs` + `parseActionConfirmation`, exported from a shared parser module — see Task 4) so the two paths cannot diverge:

| Field | `exec --json` source | `app-server` source |
|---|---|---|
| `sessionId` | `thread.started`.`thread_id` | `thread/start` response `result.thread.id` (fallback `thread/started`.`threadId` notification) |
| `summary` | `item.completed` `agent_message`.text | `item/completed` `agentMessage`.text **and/or** accumulated `item/agentMessage/delta` — **deduped** (if both a delta stream and a completed text for the same message arrive, count the text once, not twice) |
| `usage` | `turn.completed`.usage.{input_tokens,cached_input_tokens,output_tokens} | `thread/tokenUsage/updated` (last-wins). **Task 1 must confirm this notification carries a `cached_input_tokens` (or equivalent) field**; if it does not, cost under-reports — flag it in the protocol doc and map whatever field the app-server emits, defaulting `cachedInputTokens` to 0 rather than dropping the whole usage object. |
| `errorMessage` | `error`/`turn.failed` | `error` (`params.message`, note `willRetry`) / `turn/failed` (`params.error.message`) |
| `errorCode` | (exec path leaves null) | best-effort from `turn/failed` error `code`/`type` when present (so heartbeat's error classification has parity with claude) |
| detected files (`outputFiles`) | heartbeat diffs the workspace | additive hint from `item/completed` `fileChange` — normalized + validated against cwd (Task 7) |
| `chunks` | reasoning / tool_result / mcp_tool_call | `item/completed` `reasoning` / MCP tool results — via the **shared** `liftOutputRefs` + `parseActionConfirmation` (mcp-only `outputRefs` gate preserved) |

---

## Open product decisions (recommendations)

**(a) Dual-path vs always-app-server.** RECOMMEND **dual-path** — `codex app-server` only when supervision is enabled; keep `codex exec --json` for every unbridged run (smaller blast radius; resume/fast-mode/remote-target/skills keep working). Always-app-server rejected.

**(b) SLA / timeout.** RECOMMEND **mirror W5b** — reuse `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300`; `requestPermissionBounded(prompt, 300_000)`; on `{timedOut:true}` → `decline` to codex + prompt `timeoutPolicy:"escalate"` (Hub row stays visible; the broker never marks it relayed on timeout, so a late human answer never silently allows). **Because the 300s SLA equals the 5-min reap threshold, the tracked-child registration in the shared helper is what keeps the blocked run out of `reapOrphanedRuns` — this SLA choice is only safe *given* the BLOCKER fix.**

**(c) Approval policy.** Spike used `"untrusted"` (benign `echo` auto-approved; network fetch prompted). RECOMMEND `"untrusted"` on `thread/start` + `turn/start`. **Task 1 must confirm** `"on-request"` vs `"untrusted"` for the benign-auto-approve / risky-prompt split for **both** command **and** file-change, and that `item/fileChange/requestApproval` actually fires for a write/patch. Do NOT pass `--dangerously-bypass-approvals-and-sandbox` on the bridged path; if a bridged agent has `config.dangerouslyBypassApprovalsAndSandbox`, **log a warning and ignore it** (never bypass when supervised).

**(d) Parse-remap scope.** Re-derive `sessionId/usage/summary/status/errorMessage/errorCode`; use the **shared** `chunks` lift; add best-effort `outputFiles` from `fileChange`. Produce a **neutral intermediate** that both paths build (see Task 3/§`toResult` refactor), then assemble the exact `AdapterExecutionResult` shape once — reproducing every field heartbeat reads (`signal`, `errorCode`, `outputFiles` included).

---

## Tech Stack

TypeScript ESM (Node ≥20). Transport: newline-delimited JSON-RPC 2.0 over the tracked `codex app-server` child's stdio. Protocol types: generate via `codex app-server generate-ts --out <dir>` (v2/ subdir) as a dev reference; **vendor a hand-written minimal subset** into the adapter (no runtime dep on a generated dir). Reused unmodified: `AdapterRuntimeDecisionBroker.requestPermissionBounded`, `AdapterRuntimePermissionPrompt`, `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC`, and — via the new `spawnTrackedChild()` helper — the `runningProcesses` registry + `signalRunningProcess` + `resolveProcessGroupId`.

**Why not `runAdapterExecutionTargetProcess`:** it is a **one-shot collect-to-EOF** runner (spawn → capture stdout/stderr to buffers → wait for close). It cannot host a long-lived interactive session with **bidirectional** stdio (we must keep `stdin` open to write JSON-RPC requests/responses while streaming `stdout` frames). So the bridged path spawns the child through the new `spawnTrackedChild()` helper (local target only), which registers it in `runningProcesses` **exactly like `runChildProcess`** but leaves stdio open for the driver to own. `onSpawn` is still forwarded so heartbeat persists `(pid, pgid, startedAt)`.

Tests: root `pnpm test:run <pattern>`; per-package typecheck `pnpm --filter @armyofagents/<pkg> typecheck`.

---

## `spawnTrackedChild()` — shared helper (extracted from `runChildProcess`)

New export in `packages/adapter-utils/src/server-utils.ts`. `runChildProcess` is refactored to call it (its existing collect-to-EOF behavior is layered on top), so there is a single source of truth for spawn flags, the `runningProcesses` registration, the SIGTERM→SIGKILL escalation, and the env strip.

```ts
export interface TrackedChildHandle {
  child: ChildProcess;
  pid: number | null;
  pgid: number | null;
  startedAt: Date;
  /** SIGTERM then, after graceSec, SIGKILL. Idempotent; safe after close. */
  terminate(): void;
}

export function spawnTrackedChild(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    graceSec: number;
    /** Keys to strip from inherited parent env unless `env` set them (e.g. ["OPENAI_API_KEY"]). */
    unsetEnvKeys?: string[];
    /** stdio for the child. Driver uses ["pipe","pipe","pipe"] to keep JSON-RPC bidirectional. */
    stdio?: StdioOptions;
    shell?: boolean;
  },
): TrackedChildHandle;
```

Requirements (each maps to an existing line in `runChildProcess` today):
- Build env with `ensurePathInEnv(mergeChildEnv(process.env, opts.env, opts.unsetEnvKeys))` — **preserves the `unsetEnvKeys:["OPENAI_API_KEY"]` behavior** so the app-server path cannot leak the server's ambient `OPENAI_API_KEY` and silently flip codex to api-key billing/auth (the exec path strips it at execute.ts:468; the bridged path MUST too).
- `spawn(command, args, { cwd, env, shell: opts.shell ?? process.platform === "win32", detached: process.platform !== "win32", stdio })` — `detached:true` on POSIX puts the child in its own process group (`pgid === pid`) so `signalRunningProcess(-pgid, …)` kills the whole subtree; `shell:true` on Windows runs the `.cmd`/`.bat` wrapper for npm-installed CLIs.
- Capture `pid = child.pid ?? null`, `pgid = resolveProcessGroupId(child)`, `startedAt = new Date()`.
- **`runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId: pgid })`** — the same exported Map + shape `cancelRun`/`reapOrphanedRuns`/`signalRunningProcess` consume.
- `child.on("close")` and `child.on("error")` both **`runningProcesses.delete(runId)`** (mirrors `runChildProcess` lines 401/413) so the entry never leaks and a completed/errored bridged run doesn't linger in the Map.
- `terminate()` calls `signalRunningProcess({ child, processGroupId: pgid }, "SIGTERM")`, then after `max(1,graceSec)*1000` ms, if `runningProcesses.has(runId)`, `signalRunningProcess(..., "SIGKILL")` — the same escalation `runChildProcess`'s timeout branch and `cancelRun`'s grace timer use.
- Returns the handle; the driver owns `child.stdout`/`child.stdin` for framing.

`runChildProcess` after refactor: call `spawnTrackedChild(...)` with `stdio: [stdin!=null?"pipe":"ignore","pipe","pipe"]`, then attach its existing stdin-write / stdout-capture / stderr-capture / timeout / close-resolve logic to `handle.child`. Net behavior of the exec path is unchanged; a regression test asserts an existing codex exec run still registers + deregisters in `runningProcesses`.

---

## File Structure

| File | New/Edit | Purpose |
|---|---|---|
| `packages/adapter-utils/src/server-utils.ts` | Edit | Extract `spawnTrackedChild()` (shared registration/kill/env-strip); refactor `runChildProcess` to use it. |
| `packages/adapter-utils/src/types.ts` | Edit | Add non-secret `runtimeDecisionRoutingEnabled?: boolean` to `AdapterExecutionContext` (plain boolean, safe to log). |
| `packages/adapters/codex-local/src/server/app-server/protocol.ts` | New | Vendored minimal JSON-RPC + Codex v2 types (ClientRequest/ServerRequest/ServerNotification discriminants, ThreadStartParams, TurnStartParams, AskForApproval, CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams, ReviewDecision enum + the v2 decision constants). |
| `packages/adapters/codex-local/src/server/app-server/jsonrpc-client.ts` | New | Framing + I/O over the tracked child: newline-delimited encode/decode with carry-buffer + max-frame cap; **non-blocking synchronous decode into a queue**; request/response id correlation; notification + server-request dispatch to async handlers; serialized write queue with `drain` backpressure; reject-all-pending on close/error. No Codex semantics. Spawns via `spawnTrackedChild` + forwards `onSpawn`. |
| `packages/adapters/codex-local/src/server/app-server/driver.ts` | New | Turn lifecycle: initialize→initialized→thread/start(or thread/resume)→turn/start→drive to turn/completed|failed. Owns the approval callback + the event→neutral-intermediate accumulator + cancel/teardown. |
| `packages/adapters/codex-local/src/server/parse-shared.ts` | New | **Moved** `liftOutputRefs`, `parseActionConfirmation`, `normalizeToolResultText`, `extractConfirmPayload`, `LiftedOutputRef`/`CodexParsedChunk` types out of `parse.ts` so both `parseCodexJsonl` (exec) and the app-server accumulator import ONE copy. |
| `packages/adapters/codex-local/src/server/parse.ts` | Edit | Import the shared helpers from `parse-shared.ts` (behavior identical). |
| `packages/adapters/codex-local/src/server/app-server/parse-events.ts` | New | Event→neutral-intermediate remap (sessionId/summary/usage/errorMessage/errorCode/chunks/outputFiles) using `parse-shared.ts`. |
| `packages/adapters/codex-local/src/server/app-server/approval-bridge.ts` | New | Pure `(ServerRequest, broker, bridged, timeoutMs) → ReviewDecision`. accept/acceptForSession/decline; fail-closed; path-trust-boundary validation for fileChange. |
| `packages/adapters/codex-local/src/server/execute.ts` | Edit | Refactor `toResult` to take a **neutral intermediate**; branch bridged→`driveCodexAppServer(...)`; unbridged→existing exec path (unchanged); both build `AdapterExecutionResult` via the shared assembler. |
| `server/src/services/heartbeat.ts` | Edit | Set `runtimeDecisionRoutingEnabled: bridged` on the execute ctx (for BOTH adapters); keep token/registry/`runtimeHookBridge` **claude-only** (gate the existing block on `adapterType === "claude_local"`). |
| `server/src/services/runtime-decision-routing-flag.ts` | Edit | Allow-list `["claude_local","codex_local"]`; keep env/local/per-agent guards; update the stale doc-comment. |
| `server/src/__tests__/runtime-decision-routing-flag.test.ts` | Edit | Allow-list truth-table for BOTH adapters. |
| `.../__tests__/server-utils-tracked-child.test.ts` | New | `spawnTrackedChild` registers/deregisters in `runningProcesses`; env-strip preserved; exec-path regression. |
| `.../__tests__/appserver-jsonrpc-client.test.ts` | New | framing/correlation/partial-line/multi-frame/backpressure/close-rejects unit tests. |
| `.../__tests__/appserver-parse-events.test.ts` | New | event→intermediate remap (Task-1 fixtures) + summary dedupe + usage/cached parity + shared-helper parity. |
| `.../__tests__/appserver-approval-bridge.test.ts` | New | decision-map + fail-closed + fileChange path-escape decline. |
| `.../__tests__/appserver-driver.test.ts` | New | driver lifecycle vs mock app-server (approve/decline/failures/cancel-teardown/resume). |
| `.../__tests__/appserver-spike.test.ts` | New | Task-1 live harness (committed spike), guarded by `AOA_CODEX_APPSERVER_LIVE=1` (skipped in CI). |
| `.../__tests__/fixtures/appserver-turn.json` | New | Task-1 captured notification stream. |
| `tests/e2e/runtime-decision-bridge-codex.spec.ts` | New | guarded e2e (skips unless codex authed + flag). |
| `docs/architecture/decisions.md` | Edit | New Decision entry. |
| `docs/adapters/codex-local.md` | Edit | bridge section + policy note. |
| `docs/adapters/codex-appserver-protocol.md` | New | committed generate-ts v2 subset + Task-1 policy verdict + usage-field verdict + fixture description. |

---

## Tasks (TDD — failing test → implement → typecheck; root `pnpm test:run <pattern>`)

### Task 1 — App-server driver PROOF (in-repo go/no-go gate)
The out-of-repo scratchpad drive (`w5c-spike/appserver-drive.mjs`) demonstrated a working blocking approve/deny loop, but it is **not committed**, so nothing in-repo verifies it — treat this task as a real gate, not a rubber-stamp. Do:
1. **Commit the spike as a guarded harness** `appserver-spike.test.ts` (`it.skip` unless `AOA_CODEX_APPSERVER_LIVE=1`) that drives a real `codex app-server`: initialize→initialized→thread/start→turn/start, triggers a command approval and a file-change approval, and exercises accept + decline.
2. **Confirm the approval policy** (`"untrusted"` vs `"on-request"`) yields **benign-auto-approve + risky-prompt for BOTH command and file-change**. Record which policy on `thread/start`/`turn/start` produces it.
3. **Confirm `item/fileChange/requestApproval` fires** for a write/patch under the chosen policy.
4. **Capture fixtures** into `__tests__/fixtures/appserver-turn.json` — the raw notification stream: `thread/started`, `item/started`+`item/completed` for agentMessage / commandExecution / fileChange / reasoning, `item/agentMessage/delta`, `thread/tokenUsage/updated` (INSPECT its shape for a `cached_input_tokens` equivalent — record the exact field names), `turn/completed`, and an `error` with `willRetry`.
5. **Nail JSONL partial-line framing** — confirm frames may split across chunks and multiple frames may arrive in one chunk.
6. Record the v2 decision enum (`accept|acceptForSession|acceptWithExecpolicyAmendment|applyNetworkPolicyAmendment|decline|cancel`) and the exact request `method` + `params` for both approval kinds.
7. Write the verdict (policy, file-change fires yes/no, usage field names, decision enum, request shapes) into `docs/adapters/codex-appserver-protocol.md`.

**Gate / descope fallback:** if no single policy both auto-approves benign commands AND prompts for file-change, **descope file-change to a follow-up** (ship command-only): Task 5/7/9 handle only `item/commandExecution/requestApproval`, the file-change path-trust code and its tests are deferred, and this is noted in the Decision entry + protocol doc. The command bridge still ships.

### Task 2 — Tracked child + JSON-RPC stdio client (framing + correlation + backpressure)
**(a) `spawnTrackedChild()` in `server-utils.ts`** — extract from `runChildProcess` per the §helper spec above: registers the child in the exported `runningProcesses` Map keyed by `runId` with `{child, graceSec, processGroupId: resolveProcessGroupId(child)}`; `detached` on POSIX; Windows `.cmd`/`shell`; `unsetEnvKeys` env-strip preserved; `delete` on close/error; `terminate()` does SIGTERM→(graceSec)→SIGKILL; **keeps stdio open** for the driver. Refactor `runChildProcess` to call it. Test (`server-utils-tracked-child.test.ts`): a tracked child appears in `runningProcesses` at spawn and is removed on close/error; `unsetEnvKeys:["OPENAI_API_KEY"]` drops an ambient key but keeps an overlay-set one; an existing `runChildProcess` (exec-style) run still registers+deregisters (regression).

**(b) `jsonrpc-client.ts`** — spawn `codex app-server` via `spawnTrackedChild` (local target only; forward `onSpawn(pid,pgid,startedAt)`). **Read loop invariant (explicit):** on each `stdout` chunk, append to a carry buffer, split on `\n`, `JSON.parse` each COMPLETE line **synchronously** and push decoded messages into an in-memory queue; keep the trailing partial as carry; enforce a **max-frame-size cap** (reject/close on a single line exceeding it — no unbounded buffer). Dispatch from the queue: `{id,result|error}` → resolve/reject the correlated pending request; `{method,id}` → server request → `onServerRequest` (an **async** handler); `{method}` (no id) → notification → `onNotification`. **Never `await` an approval (or any long async handler) inside the stdout-drain path** — server requests are handed to async handlers whose completion writes the response later; parsing/correlation must keep running so a 2nd frame in the same chunk (or a later notification) is decoded while an approval is pending. **Outbound writes** go through a **serialized write queue**: `JSON.stringify(msg)+"\n"`; if `stdin.write()` returns `false`, wait for `drain` before the next write. `close()` rejects all pending requests and drains/clears the queues. Tests: correlation across interleaved ids; a partial line split across 2 chunks parsed exactly once; multiple frames in one chunk dispatched in order; **a server-request arrives with an approval await still pending and a 2nd notification in the same chunk is still parsed/dispatched**; garbage lines ignored; oversized frame → error/close; `close()` rejects pending; write backpressure honored (a `false` from `write` defers until `drain`).

### Task 3 — Turn lifecycle driver
`driver.ts` + test (mock app-server via the Task-2 client against a scripted stdin/stdout). `driveCodexAppServer(input)`: initialize→initialized→thread/start (or thread/resume when a resumable session is present)→turn/start→drive to turn/completed|failed; honor `timeoutSec` by calling the tracked child's `terminate()`; route server requests to `onServerApproval` (async), notifications to the accumulator (Task 4).

**Resume semantics (preserve `execute.ts` exactly):** map AoA `runtimeSessionId`→codex `thread.id`; replicate the `canResumeSession` cwd-match guard (`runtimeSessionCwd` empty OR `path.resolve` equal to cwd) and its warn-and-skip log. On resume-unavailable (thread/resume errors with an unknown-session/thread error — reuse `isCodexUnknownSessionError` semantics): **start fresh via thread/start, capture the NEW thread.id, and set `clearSession` ONLY when no replacement session id was obtained** (mirrors `toResult`'s `clearSession: clearSessionOnMissingSession && !resolvedSessionId` — never wipe a freshly-created thread id).

**Cross-path resume decision (portability):** supervision is per-run, so a session created by `codex exec` (unsupervised) could later be resumed by a supervised (app-server) run and vice-versa. Task 3 must EITHER (a) verify thread ids are portable exec↔app-server (resume a stored exec `thread.id` via `thread/resume` and continue), OR (b) if they are not portable, **document that toggling supervision resets the session** and make the driver treat a foreign-format session id as resume-unavailable → fresh + `clearSession` (so no stale-id resume is attempted). Record which in the Decision entry + protocol doc; add the corresponding test.

Tests: happy path; resume (portable case); resume-unavailable → fresh + `clearSession`; **fresh-thread-captured on resume-fail does NOT set `clearSession`**; turn/failed → errorMessage(+errorCode); timeout → `terminate()` called + timedOut result; cwd-mismatch → fresh + warn.

### Task 4 — Shared parser extraction + event→intermediate remap
**(a) Extract to `parse-shared.ts`:** move `liftOutputRefs`, `parseActionConfirmation`, `normalizeToolResultText`, `extractConfirmPayload`, and the `LiftedOutputRef`/`CodexParsedChunk` types out of `parse.ts` and **export** them; `parse.ts` re-imports them so `parseCodexJsonl` is behavior-identical (they are currently private — this is required so both paths share ONE copy and cannot drift).

**(b) `parse-events.ts`:** `createAppServerResultAccumulator()` consuming notifications → the **neutral intermediate** `{ sessionId, summary, usage, errorMessage, errorCode, chunks, outputFiles }`. Uses the shared `liftOutputRefs`+`parseActionConfirmation`; keeps the **mcp-only** `outputRefs` gate (plain tool_result never lifts a ref chip). Summary: accumulate `item/agentMessage/delta` and prefer/dedupe against the completed `agentMessage.text` so a message isn't double-counted. Usage: from `thread/tokenUsage/updated` (last-wins), mapping the field names Task 1 recorded, defaulting `cachedInputTokens` to 0 if the app-server omits it (flagged in the doc). `fileChange` → `outputFiles` hint (raw path here; normalization/validation happens in Task 7's approval path and before assembly).

Tests: fixture→intermediate fields match; agentMessage delta+completed dedupe matches `parseCodexJsonl`'s join semantics; **parity** — the shared helpers produce identical `chunks` for the same tool payloads across exec and app-server; mcp tool result lifts a tool_result chunk while a plain tool_result does not (mcp-only gate); error `willRetry` / `turn/failed` set errorMessage(+errorCode); `fileChange` → `outputFiles`.

### Task 5 — Approval bridge (+ file-change trust boundary)
`approval-bridge.ts` + test. `handleApprovalRequest(msg, { broker, bridged, timeoutMs, cwd, onLog }) → ReviewDecision`. Build the `AdapterRuntimePermissionPrompt`: command request → `command`/`cwd`/`reason`; file-change request → validated `path`; always set `timeoutPolicy:"escalate"`. Call `broker.requestPermissionBounded(prompt, timeoutMs)` and map: `allow_once`→`accept`, `allow_always`→`acceptForSession`, `deny`/`{timedOut:true}`/thrown/unparseable→`decline`. **Never throws** (fail-closed).

**File-change trust boundary:** normalize the `item/fileChange/requestApproval` target path and validate it is inside `cwd`/the workspace root; if it escapes the allowed root, **decline** (don't relay an out-of-tree write for approval). Carry BOTH the normalized display path and the raw path into the prompt metadata for audit.

Tests: full decision map; timeout→decline; thrown broker→decline; `bridged:false`/missing broker→decline; fileChange vs command prompt shape; escape-root path→decline; escalate policy present; normalized+raw path both in metadata.

### Task 6 — Extend flag resolver to codex_local (allow-list)
`runtime-decision-routing-flag.ts` + test. Replace the hard `adapterType !== "claude_local"` guard with an allow-list invariant: `const RUNTIME_DECISION_ADAPTERS = new Set(["claude_local","codex_local"]); if (!RUNTIME_DECISION_ADAPTERS.has(adapterType)) return false;`. Keep env kill-switch, local-target, and per-agent guards. **Update the doc-comment** — it currently says "only claude_local supports PreToolUse hooks"; replace with the allow-list rationale (claude_local via out-of-process PreToolUse hooks; codex_local via in-process app-server JSON-RPC; both gated identically). Tests (truth-table for BOTH adapters): codex_local all-on→true; codex_local env≠1→false; codex_local non-local→false; codex_local per-agent off→false; claude_local all-on→true (unchanged); claude_local per-agent off→false; unknown adapter→false.

### Task 7 — Wire heartbeat + execute.ts (dual-path, explicit flag)
**(a) heartbeat.ts:** the existing `bridged = resolveRuntimeDecisionRoutingEnabled(...)` block (`~:4067`) already covers both adapters via Task 6. Add `runtimeDecisionRoutingEnabled: bridged` to the `adapter.execute({...})` ctx (`~:4097`) for BOTH adapters. **Gate the token/registry/`runtimeHookBridge`/`runtimeHookToken` machinery on `adapterType === "claude_local"`** — i.e. only mint/register/pass those when bridged AND claude (codex needs none). Do NOT route on broker presence anywhere.

**(b) types.ts:** add `runtimeDecisionRoutingEnabled?: boolean` to `AdapterExecutionContext` (non-secret plain boolean, safe in logged meta).

**(c) execute.ts:** branch **`bridged ⇔ ctx.runtimeDecisionRoutingEnabled === true && executionTarget.type === "local"`** (NOT `runtimeDecisionBroker != null` — the broker is present on every run). Broker/flag present but non-local target → exec + warn. Bridged → `driveCodexAppServer` with `onServerApproval` = Task 5's handler (broker, `timeoutMs = RUNTIME_HOOK_BLOCK_TIMEOUT_SEC*1000`, cwd); refactor `toResult` (below) and assemble the result from the driver's neutral intermediate. Ignore+warn `dangerouslyBypassApprovalsAndSandbox` on the bridged path. Unbridged → existing exec path unchanged. onMeta: app-server-flavored (command `codex app-server`), env redacted.

**`toResult` refactor (P2 — de-entangle from `proc`):** the current `toResult` closes over `attempt.proc.stdout/stderr` + `parseCodexJsonl` output; "share verbatim" won't compile. Refactor it to accept the **neutral intermediate** both paths produce:
```
{ timedOut, exitCode, signal, sessionId, summary, usage, errorMessage, errorCode,
  stdoutForResultJson, stderrForResultJson, outputFiles }
```
and build `AdapterExecutionResult` once from it. The exec path fills the intermediate from `attempt.proc` + `parsed` (with `errorCode: null`, `outputFiles` from none/heartbeat). The bridged path fills it from the driver's accumulator. **The bridged result MUST reproduce every field heartbeat reads.** Precisely (verified against `execute.ts:499-556`): the current `toResult` **already sets `signal`** (`:505`/`:534` = `attempt.proc.signal`), so the bridged path must **preserve** `signal` (map the tracked child's exit signal). It **omits `errorCode`** (never set today) and **omits `outputFiles`** — heartbeat consumes `outputFiles` for output detection (`heartbeat.ts:4385`), so the bridged path must **newly produce** both. Plus `sessionParams`/`sessionDisplayId`/`clearSession` per the resume rules.

Tests: flag true + local → driver; flag absent/false but broker present → exec (regression — the P1 miswire); flag true + non-local → exec + warn; bypass-on-bridged → warn + not bypassed; result carries `signal` (preserved), `errorCode` (newly produced), and `outputFiles` (newly produced) on the bridged path — assert `signal` is passed through, NOT that it was newly added.

### Task 8 — Failure modes + cancel→teardown coupling
Extend driver test (scripted mock app-server): user-never-answers → decline → no hang (broker `{timedOut:true}`); **run-cancelled: `requestPermissionBounded` throws `RuntimeDecisionCancelledError` → the bridge maps throw→decline (fail-closed) AND the driver `terminate()`s the tracked child and unwinds** (so we don't decline the approval yet leave codex running — this depends on Task 2's tracked child making the kill possible); codex crash / `error` willRetry → errorMessage set, no double-answer, all pending JSON-RPC rejected on child exit; malformed message → ignore or `respondError`, never fail-open (never `accept`); duplicate approval for the same itemId → respond each with the cached decision (idempotent); stdin write-after-close → swallowed (no unhandled rejection). Assert the child is removed from `runningProcesses` after each terminal path.

### Task 9 — Integration loop (real broker + mock app-server)
Approve: force a command approval → real broker `allow_once` → `accept` → turn completes. Decline: broker `deny` → `decline` → errorMessage. `allow_always` → `acceptForSession` → no second prompt for the same session. **Cancel mid-approval:** broker throws `RuntimeDecisionCancelledError` → decline + child terminated + run unwinds (integration-level assertion of the Task 8 coupling). fileChange approve (only if Task 1 confirmed file-change fires; else `it.skip` with the descope reason).

### Task 10 — Guarded e2e
`runtime-decision-bridge-codex.spec.ts` mirroring W5b, `test.skip` unless codex is authed + `AOA_RUNTIME_DECISION_ROUTING=1` + a `codex_local` agent with `runtimeConfig.runtimeDecisionRoutingEnabled=true`. Windows-skip consistent with the e2e matrix. Not a required check; must skip cleanly in CI.

### Task 11 — Docs + Decision entry
Decision entry: dual-path; in-process JSON-RPC bridge (no token/registry/HTTP — claude-only machinery untouched); **tracked child via `spawnTrackedChild` is mandatory** (cancel + reap correctness; 300s SLA == 5-min reap threshold); v2 decision-enum map; fail-closed; 5-min SLA + escalate; permission-only, work_question deferred (noting `item/tool/requestUserInput`); file-change trust boundary (decline out-of-tree); cross-path resume verdict (portable vs supervision-resets-session); flag-gated default-OFF + `AOA_RUNTIME_DECISION_ROUTING` kill-switch; Task-1 policy verdict + command-only descope status. `codex-local.md` bridge section. `codex-appserver-protocol.md`: generate-ts v2 subset + policy verdict + usage-field verdict + fixture description.

---

## Verification
Root typecheck: `pnpm --filter @armyofagents/adapter-utils typecheck` + `pnpm --filter @armyofagents/adapter-codex-local typecheck` + server typecheck.
Unit/integration: `pnpm test:run server-utils-tracked-child`; `pnpm test:run appserver-jsonrpc-client appserver-parse-events appserver-approval-bridge appserver-driver`; `pnpm test:run runtime-decision-routing-flag`; `pnpm test:run codex-local` (exec regression — child still registers/deregisters, exec result unchanged).
Live (machine with codex authed): `AOA_CODEX_APPSERVER_LIVE=1 pnpm test:run appserver-spike` (Task 1 gate).
Manual live smoke: bridged approve/decline (command; file-change if confirmed) + cancel-mid-approval kills the child + unbridged exec unchanged. Confirm a bridged run blocked on approval is (i) cancellable via `cancelRun` (child actually signalled) and (ii) NOT failed by `reapOrphanedRuns` at ~5 min.
Guarded e2e skips cleanly in CI; full gate suite green.

## Scope Guard
**In scope:** codex_local only; permission-only (command + file-change approvals, file-change subject to the Task-1 gate); dual-path (app-server only when bridged; exec untouched); **local execution target only**; reuse W5a broker + `requestPermissionBounded` + `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC` unmodified; **new `spawnTrackedChild()` shared helper** so the bridged child is registered in the SAME `runningProcesses` Map as exec runs (cancel + reap parity, env-strip preserved); new **non-secret** `runtimeDecisionRoutingEnabled` ctx boolean; extend the existing W5b per-agent flag (allow-list) + `AOA_RUNTIME_DECISION_ROUTING` kill-switch (no new flag); default OFF.

**NOT in scope:** work_question / `item/tool/requestUserInput` (deferred, noted); any change to claude_local's out-of-process hook/registry/HTTP forwarder (that machinery stays claude-only and is only *gated* on `adapterType === "claude_local"`, not modified); always-app-server; non-local targets; `codex-config-toml.ts` `[mcp_servers.aoa]` (codex-as-MCP-client, wrong direction — leave it); concurrency/hire-approval defaults (Paperclip D5/D6); new hosted-API calls (Rule #11); DB migration (bridge is runtime-only; flag reuses `agents.runtimeConfig`).

**Do not relitigate:** the live-proven JSON-RPC sequence + v2 decision enum (Task 1 commits + re-verifies it in-repo); the broker contract + fail-closed semantics; that the bridged child MUST live in `runningProcesses` (cancel/reap depend on it).

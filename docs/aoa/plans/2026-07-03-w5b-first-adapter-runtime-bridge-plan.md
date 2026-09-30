# W5b: First Real Adapter Runtime Bridge (`claude_local`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Task 1 is a proof spike that gates the whole plan — do not implement Tasks 2+ until it passes.**

**Goal:** Make the `claude_local` adapter route CLI **permission prompts** to the W5a human-decision hub instead of ignoring the broker (inert W5a) or bypassing prompts (`--dangerously-skip-permissions`). When W5b is enabled for a run, a `PreToolUse` hook intercepts permission-requiring tool calls, blocks the CLI synchronously, calls `runtimeDecisionBroker.requestPermission(...)`, and returns the founder's allow/deny to the live CLI session. Default OFF; unbridged runs are byte-for-byte unchanged.

**Architecture:** A per-run authenticated hook endpoint on the **existing** Express server (shares DB + broker + hub + auth). **Heartbeat** mints a per-run token, registers `token → {broker, companyId, agentId, runId, expiresAt}` in an in-process `RuntimeHookRegistry`, and passes only plain strings `{enabled, selfBaseUrl, path, timeoutSec}` to the adapter via a dedicated typed field `runtimeHookBridge` on `AdapterExecutionContext` (never on generic `config`/`context`). `execute.ts` reads those strings to write a per-run `settings.json` with a `PreToolUse` hook (passed via `--settings`) and sets the forwarder env; it never sees the broker or the registry. The hook calls the endpoint via a bundled `hook-forward.mjs` forwarder (type `"command"`); the forwarder POSTs to the AoA endpoint and on ANY error emits a `deny` to stdout (fail-CLOSED) and exits 0. Heartbeat deregisters the token in a `finally` block around `await adapter.execute(...)`. The per-run bearer token travels only via env (`AOA_RUNTIME_HOOK_TOKEN`) — never in argv, config blobs, `AdapterInvocationMeta.context`, run-log NDJSON, prompt snapshots, or run-summary comments. Fail-safe **deny** on every error path.

**Why `type:"command"` forwarder, not native `type:"http"`:** Claude Code docs specify that an HTTP hook returning non-2xx / timeout / connection-fail is non-blocking — the CLI continues (fail-OPEN). That violates the fail-safe-deny contract. A `type:"command"` hook running `hook-forward.mjs` POSTs to the AoA endpoint; on any network error, non-2xx, malformed response, or timeout the forwarder emits a `deny` and exits 0. This makes every error path fail-CLOSED. Task 1 must empirically confirm this is the correct transport on 2.1.126.

**Hook = `PreToolUse` with a scoped matcher (SPIKE-CONFIRMED 2026-07-03).** The Task-1 spike found `PermissionRequest` is NOT a firing hook event on 2.1.126 (0 hook calls), while **`PreToolUse` fires, its `permissionDecision:"deny"` blocks the tool, and the run resumes** (`permission_denials` recorded, exit 0). To avoid prompting on benign tools, the `PreToolUse` hook `matcher` is scoped to permission-requiring tools (e.g. `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch`) — NOT `"*"` — so auto-allowed tools (Read/Grep/Glob/LS/TodoWrite) never generate a prompt. Headless `--print` also default-denies permission-requiring tools when no hook decides, so the hook is what enables *allow*. (The `hookSpecificOutput.hookEventName` in responses is `"PreToolUse"`.)

**Tech Stack:** Existing W5a (`agent-runtime-decisions.ts`, heartbeat broker, `adapter-utils/types.ts`); `packages/adapters/claude-local`; Express 5; Drizzle (no schema changes — reuses `agent_runtime_decisions` + `agent_runtime_trust_rules`); Claude Code CLI 2.1.126 (`--settings` + `PreToolUse` hooks); Vitest (root `pnpm test:run <pattern>`).

---

## Non-goals (scope guard)

`claude_local` only · permission decisions only · flag-gated (per-agent + instance kill-switch, default OFF) · fail-safe deny on every error path · unbridged runs byte-for-byte unchanged. **No** work-question routing (`AskUserQuestion` is SDK-only — no clean CLI interception), **no** other adapters, **no** Mail, **no** RBAC changes, **no** blanket/implicit allow-always, **no** new hosted-API calls. W5a service, schema, and broker are reused unmodified.

---

## Resolved product decisions (LOCKED 2026-07-03)

**(a) Timeout / founder SLA — two distinct outcomes, both required.** The CLI hook blocks synchronously (max ~600s). W5b uses a **5-minute SLA**: `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300` (does NOT touch W5a's 1h default).
- **CLI-facing (anti-hang):** on block-timeout the route's `requestPermissionBounded` returns **`deny`** to the CLI, strictly ≤ the hook `timeout`, so a frozen subprocess can never wedge.
- **Founder-facing (never lose it):** the W5b prompt's `timeoutPolicy = "escalate"` so a **missed prompt STAYS VISIBLE** in the hub as a follow-up — NOT deny-and-vanish. `expiresAt = now + 300s`; the W5a sweep reconciles it to the visible parked/escalated state.
- **Overnight / away is NOT solved by the timeout.** Hook supervision is inherently synchronous (founder reachable within minutes). Overnight story: **trust rules (allow-always)** so agents don't block while you sleep, and **keep unsupervised agents on bypass**. Answering a parked follow-up later sets a trust rule / re-runs the task — it does not resume the dead subprocess.

**(b) Feature-flag scope — per-agent, default bypass.** Default behavior is **unchanged (bypass permissions)**. Supervision is **opt-in per-agent** via `runtimeConfig.runtimeDecisionRoutingEnabled`, gated behind an **instance kill-switch** env `AOA_RUNTIME_DECISION_ROUTING=1` (default off). The flag only controls whether *this* agent's permission prompts route to the hub vs. keep running hands-off. Per-company inheritance is a later convenience — not in W5b.

**(c) `ask` — never returned; W5b is permission-only.** `ask` is only the CLI hook's wire protocol, not the hub's decision model. Map `allow_once|allow_always → allow`, `deny → deny`; **never return `ask`** (headless `--print` runs would hang). The rich multi-choice / free-text decisions belong to the **`work_question` kind, which is DEFERRED** (no CLI interception yet — a later bridge). W5b handles the `permission` kind only.

**Architecture note (workspace ↔ hub):** single store (`agent_runtime_decisions` + hub item) + single API. Any surface (hub now, workspace later) reads/writes the same record → they cannot drift. Do NOT add a second store. A workspace surface is additive and out of W5b scope.

---

## File Structure

| File | Change | Purpose |
|------|--------|---------|
| `packages/adapters/claude-local/src/server/runtime-hook-settings.ts` | new | Pure builder `buildPreToolUseSettings({endpointUrl, timeoutSec, forwarderPath})` — token goes via env only, NOT embedded in the hook object — + `writeRuntimeHookSettingsFile`. |
| `packages/adapters/claude-local/src/server/hook-forward.mjs` | new | stdin→POST→stdout forwarder; reads bearer token from `AOA_RUNTIME_HOOK_TOKEN` env; fail-safe deny on ANY error (network/non-2xx/malformed/timeout). Never imported by TS — spawned as a subprocess. |
| `packages/adapters/claude-local/src/server/execute.ts` | edit | Bridged: read `runtimeHookBridge` strings, write settings file, add `--settings`, omit skip-permissions, set env for forwarder (`AOA_RUNTIME_HOOK_TOKEN`, `AOA_RUNTIME_HOOK_URL`). Never mints/registers token — heartbeat owns that. |
| `packages/adapters/claude-local/src/__tests__/runtime-hook-settings.test.ts` | new | Settings builder unit tests. |
| `packages/adapters/claude-local/src/__tests__/execute-runtime-hooks.test.ts` | new | argv: `--settings` added, skip-permissions omitted when bridged; token absent from argv/commandString; unbridged unchanged. |
| `packages/adapters/claude-local/vitest.config.ts` | edit | Add `exclude: ["**/*.spike.*"]` so spike files are never collected by the default suite. |
| `server/src/services/runtime-hook-registry.ts` | new | In-process `Map<token,{broker,companyId,agentId,runId,expiresAt}>`; `mintRuntimeHookToken`/`register`/`resolve`/`deregister`/`pruneExpired`; timing-safe compare. Server-only — never imported by adapter packages. |
| `server/src/services/runtime-hook-bridge.ts` | new | Pure `hookPayload → AdapterRuntimePermissionPrompt` (+ redaction) and `answer → hookResponse`. |
| `server/src/routes/runtime-hooks.ts` | new | `POST /internal/runtime-hooks/permission-request` + per-run bearer auth. `requestPermissionBounded` wraps broker call with timeout + late-answer guard. |
| `server/src/app.ts` | edit | Mount `runtimeHooksRoutes(db)` at `/internal` (outside `/api`, before errorHandler). |
| `server/src/services/heartbeat.ts` | edit | Resolve `runtimeDecisionRoutingEnabled`; mint token; `registry.register(...)`; attach `runtimeHookBridge` to `AdapterExecutionContext`; `registry.deregister` in `finally` around `await adapter.execute(...)`. Also gate on `executionTarget.type === "local"`. |
| `server/src/__tests__/runtime-hook-registry.test.ts` | new | Registry lifecycle + TTL + token compare. |
| `server/src/__tests__/runtime-hook-bridge.test.ts` | new | Mapping + redaction + decision mapping. |
| `server/src/__tests__/runtime-hooks-route.test.ts` | new | Auth, allow/deny/allow_always, spoof, timeout→deny, late-answer-no-relay. |
| `server/src/__tests__/runtime-decision-routing-flag.test.ts` | new | Flag resolver (env kill-switch + per-agent + adapter guard + local-execution-target guard). |
| `packages/shared/src/agent-runtime.ts` (or nearest constants) | edit | `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300`, `RUNTIME_HOOK_PATH`. |
| `packages/adapter-utils/src/types.ts` | edit | Add `runtimeHookBridge?: RuntimeHookBridgeSpec` to `AdapterExecutionContext`. `RuntimeHookBridgeSpec = {enabled: boolean; selfBaseUrl: string; path: string; timeoutSec: number}` — no token field (token is env-only). |
| `tests/e2e/runtime-decision-bridge.spec.ts` | new (advisory) | E2E allow/deny + a CI-Linux integration loop that drives the route directly. |
| `docs/architecture/decisions.md`, `docs/adapters/claude-local.md` | edit | Locked decision + adapter docs. |

---

## Tasks

> Discipline every task: failing test → run (`pnpm test:run <pattern>` from repo root) → fail → implement → run → pass → typecheck (`pnpm --filter @armyofagents/<pkg> typecheck`) → commit. The `server`/`db` packages have NO `test:run` script — only root does. Commit messages end with the `Co-Authored-By` trailer.

### Task 1 — PROOF SPIKE (gates the whole plan) — ✅ DONE 2026-07-03: PASS

**SPIKE RESULT (verified against installed Claude Code 2.1.126 on Windows):**
- ✅ **Core mechanism proven.** A `PreToolUse` hook (`type:"command"` forwarder) fired on a `claude --print - --output-format stream-json` run, delivered `tool_name:"Write"` + full `tool_input` (`file_path`, `content`) to a local stub, and `permissionDecision:"deny"` **blocked the tool** (file never created); the run **resumed and completed** (exit 0, `end_turn`, `permission_denials` recorded). This is the go/no-go → GO.
- ✅ **Transport = `type:"command"` forwarder** works on Windows. (Native `type:"http"` remains excluded — fail-open per docs.)
- ❌ **`PermissionRequest` is NOT a firing hook event** on 2.1.126 (0 hook calls). The chosen hook is therefore **`PreToolUse` with a `matcher` scoped to permission-requiring tools** (Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch), so benign Read/Grep/Glob/LS/TodoWrite don't prompt.
- ℹ️ Headless `--print` **default-denies** permission-requiring tools when no hook decides — so the hook is what enables *allow*; deny is the safe baseline.
- ⏳ **Still to confirm during implementation (Task 5):** exact scoped-matcher tool set (which tools fire `PreToolUse`), fail-closed behavior of the forwarder on 500/malformed/timeout/refused (forwarder emits deny), and `--settings` merge-vs-replace (builder writes only the `hooks` key regardless).

The original spike instructions below are retained for reproducibility; the gate is PASSED — proceed to Task 2.

**If the CLI does not demonstrably block on the hook and honor `permissionDecision:"deny"` on 2.1.126, STOP and escalate — W5b is infeasible as designed.**

**Spike file naming:** `packages/adapters/claude-local/src/__tests__/spike-permissionrequest-hook.spike.ts` (note: `.spike.ts`, not `.spike.test.ts`). Also add `exclude: ["**/*.spike.*"]` to `packages/adapters/claude-local/vitest.config.ts` before running — verify `pnpm test:run` collects **zero** spike files before relying on it. The spike is run explicitly only: `npx vitest run packages/adapters/claude-local/src/__tests__/spike-permissionrequest-hook.spike.ts`.

- [ ] Add `exclude: ["**/*.spike.*"]` to `packages/adapters/claude-local/vitest.config.ts`. Confirm the spike file is not collected by `pnpm test:run`.
- [ ] Local `node:http` stub on an ephemeral port; logs every POST body; always responds `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"spike deny"}}`.
- [ ] **Primary test: `PreToolUse` hook.** Temp `settings.json` with a `PreToolUse` hook using `type:"command"` invoking a tiny Node forwarder that reads stdin, POSTs to the stub, echoes the response. Spawn `claude --print - --output-format stream-json --verbose --include-hook-events --settings <file> --add-dir <tmp>` with stdin = a prompt that forces a permission-requiring tool call (e.g. "Create spike.txt containing hello using the Write tool. Do it now."). Assert: (a) stub received ≥1 POST with `tool_name` + `tool_input`; (b) the tool was blocked/denied (no `spike.txt`, or a PreToolUse-deny in the hook-events stream); (c) the process still exits (session resumed past the deny).
- [ ] **Secondary test: `PreToolUse "*"` hook** (same setup, same prompt). Record how many hook events fire per session (compare with `PreToolUse` count). Confirm whether `PreToolUse "*"` delivers only permission events or fires on every tool call. **Expected finding: `PreToolUse` is the correct hook; `PreToolUse "*"` fires on every tool call.** If findings contradict, document and escalate before proceeding.
- [ ] **Confirm `type:"command"` is fail-CLOSED:** test stub returning HTTP 500, malformed JSON, timeout (stub hangs), and connection-refused; record whether the tool is allowed or blocked in each case. All must be BLOCKED (fail-CLOSED) — the forwarder must emit `deny` on any error path.
- [ ] **Confirm `--settings` merge-vs-replace** on 2.1.126: the builder (Task 5) must write ONLY the `hooks`/`PreToolUse` key — never `permissions`/`mcpServers`/`env` keys — so it cannot clobber the run's MCP/permissions even if `--settings` replaces rather than merges. Document the observed behavior.
- [ ] **Confirm skip-off does not deadlock:** assert a tool-forcing `--print` run with permissions NOT skipped and NO hook does not hang waiting for interactive approval. Document result.
- [ ] Run spike explicitly; do NOT use `pnpm test:run` (spike must not appear there).
- [ ] **Decision gate:** PASS → record the exact settings shape, delivered payload fields, confirmed hook name (`PreToolUse`), and transport (`command`) in the spike comment + PR description; proceed. FAIL → STOP, document the failure mode, escalate.

**Exit criterion:** reproducible evidence a `PreToolUse` hook (via `type:"command"` forwarder) blocks a `--print` run and `deny` prevents the tool on 2.1.126; and that `PreToolUse "*"` fires on every tool call (confirms `PreToolUse` is the right hook).

### Task 2 — Constants + per-run token + registry

**Files:** `packages/shared/src/agent-runtime.ts`, `packages/adapter-utils/src/types.ts`, `server/src/services/runtime-hook-registry.ts`, `server/src/__tests__/runtime-hook-registry.test.ts`.

**Key constraint:** The registry is server-side only. `execute.ts` never imports it. Heartbeat is the sole caller of `register`/`deregister`. The adapter receives only plain string data via `runtimeHookBridge` on `AdapterExecutionContext`.

- [ ] Failing tests: `mintRuntimeHookToken()` ≥32-byte base64url, unique over 1000; `register`/`resolve`/`deregister`; expired entry prunes on next `resolve`; `pruneExpired()` batch; timing-safe compare (`crypto.timingSafeEqual`, unequal length → null without throw); `resolve` of an unknown/deregistered token returns null.
- [ ] Implement `server/src/services/runtime-hook-registry.ts`: module-level `Map<string, {broker: AdapterRuntimeDecisionBroker; companyId: string; agentId: string; runId: string; expiresAt: Date}>`, `mintRuntimeHookToken` using `randomBytes(32).toString("base64url")`, lazy prune on resolve, exported `pruneExpired()`. Export `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC = 300`, `RUNTIME_HOOK_PATH = "/internal/runtime-hooks/permission-request"` (also re-export from shared constants for adapter-side use without server import).
- [ ] Add `RuntimeHookBridgeSpec = {enabled: boolean; selfBaseUrl: string; path: string; timeoutSec: number}` to `packages/adapter-utils/src/types.ts` and add `runtimeHookBridge?: RuntimeHookBridgeSpec` to `AdapterExecutionContext`. **No token field** — token is env-only.
- [ ] Document the **single-process assumption** in a JSDoc comment: the adapter `execute` runs in the same Node process as the Express server, so the module-level Map is the correct shared handle. Multi-process execution is out of scope; would require DB-backed token storage keyed by run token.
- [ ] Typecheck + commit `feat(runtime-hooks): per-run hook token registry + block-timeout constant`.

### Task 3 — Hook payload ↔ broker mapping (+ redaction)

**Files:** `server/src/services/runtime-hook-bridge.ts`, `server/src/__tests__/runtime-hook-bridge.test.ts`.

- [ ] Failing tests for `buildPermissionPromptFromHook(payload)`:
  - `tool_name → toolName`; Bash → `command` + `riskClass:"shell"`; Write/Edit/Read → `path` + `riskClass:"filesystem"`; WebFetch → `networkTarget`(host) + `riskClass:"network"`; `cwd` forwarded.
  - Readable `title`/`summary`/`promptText`.
  - **Deterministic nonce:** `nonce = sha256(session_id + ":" + tool_name + ":" + canonicalJSON(tool_input))` where `canonicalJSON` serializes `tool_input` with sorted keys. Test: same payload with reordered `tool_input` keys → identical nonce. This nonce becomes `source_unique_key` so CLI retries dedupe to the same W5a row.
  - `timeoutPolicy: "escalate"` — founder-facing: a missed prompt stays visible in the hub (per Resolved decision (a); the route separately returns `deny` to the CLI on block-timeout).
  - `expiresAt = now + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000`.
  - **Redaction:** secrets in `tool_input` scrubbed via existing `redactSecretsInString`/`safeText`/`redactJsonSecrets` (assert raw secret absent from all prompt fields).
  - Scope fields `{toolName, command, commandHash, path, networkTarget, riskClass}` match exactly what `trustRuleMatchesPrompt` keys on in W5a — so a prior "allow always" rule correctly short-circuits without re-prompting.
- [ ] Failing tests for `mapAnswerToHookResponse`: `allow_once|allow_always → {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}`; `deny → {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Denied by founder"}}`. Never returns `ask`.
- [ ] Keep pure (drizzle-free). Typecheck + commit `feat(runtime-hooks): PreToolUse payload→prompt mapping + redaction`.

### Task 4 — Hook route + per-run bearer auth

**Files:** `server/src/routes/runtime-hooks.ts`, `server/src/app.ts`, `server/src/__tests__/runtime-hooks-route.test.ts`.

**Critical: no naive `Promise.race`.** The heartbeat broker's `waitForAnswer` polls indefinitely (no `timeoutMs` in current W5a). The route must use `requestPermissionBounded(prompt, timeoutMs)` which: starts `broker.requestPermission(prompt)`, races it against `timeoutMs`, on timeout returns `deny` AND ensures the underlying `waitForAnswer` loop cannot later call `markRelayed` (e.g. cancel the subscription or use an internal settled flag). Regression test: a founder answer arriving after route timeout must NOT result in `markRelayed` being called.

- [ ] Failing tests: no/invalid bearer → **200 with `deny`** (fail-safe, NOT 401 — a hook auth error must never hang/fail-open) + broker NOT called; valid token + `allow_once` → `allow`; `deny` → `deny`; `allow_always` → `allow` (trust-rule persistence is W5a's job); broker throws (cancelled / timeout) → `deny` + logged; token `companyId` mismatch → deny; unregistered token → deny; spoofed token (timing-safe mismatch) → deny + broker never invoked.
- [ ] **Timeout regression test:** founder answer arrives AFTER `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC` → route already returned `deny`; assert `markRelayed` is NOT called on the decision row.
- [ ] Implement bearer middleware: extract token from `Authorization: Bearer <token>` header; `registry.resolve(token)`; timing-safe compare via registry; on fail → 200 + deny immediately. Handler: build prompt via bridge → `requestPermissionBounded(prompt, RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000)` → map answer. Try/catch entire handler → deny. Mount at `/internal` after `express.json`, before `errorHandler`, outside `/api` (loopback-only surface; token is auth boundary for authenticated deployments).
- [ ] **Route mount test:** assert the route is mounted before any SPA/static fallthrough middleware (a request to `/internal/runtime-hooks/permission-request` must not be caught by the static file handler and return HTML).
- [ ] Typecheck + commit `feat(runtime-hooks): PreToolUse route with fail-safe deny + per-run token auth`.

### Task 5 — Settings builder + hook forwarder (adapter side, pure)

**Files:** `packages/adapters/claude-local/src/server/runtime-hook-settings.ts`, `packages/adapters/claude-local/src/server/hook-forward.mjs`, `packages/adapters/claude-local/src/__tests__/runtime-hook-settings.test.ts`.

**Transport is `type:"command"` (proven in Task 1).** The builder always emits a `PreToolUse` hook with `type:"command"`. `hook-forward.mjs` is always shipped. Native `type:"http"` is NOT used — it is fail-OPEN (CLI continues on hook error) and violates the fail-safe-deny contract.

- [ ] Failing tests for `buildPreToolUseSettings({endpointUrl, timeoutSec, forwarderPath})`:
  - Output has `hooks.PreToolUse[0].matcher` scoped to permission-requiring tools (e.g. `"Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch"` — NOT `"*"`, to avoid prompting on benign Read/Grep/Glob/LS/TodoWrite), `type: "command"`, `command: forwarderPath`, `timeout === timeoutSec`. Verify the exact firing set against the Task-1 spike findings.
  - Output does **NOT** contain `permissions`, `mcpServers`, or `env` keys at the top level — safe regardless of whether `--settings` merges or replaces.
  - `AOA_RUNTIME_HOOK_TOKEN` is NOT embedded in the hook object (token goes via env, not hook config).
  - `writeRuntimeHookSettingsFile(opts)` writes valid JSON to a tmpdir path, returns the path.
- [ ] **Forwarder tests for `hook-forward.mjs`:**
  - Stub returns valid `deny` response → forwarder echoes it to stdout, exits 0.
  - Stub returns HTTP 500 → forwarder emits `deny` to stdout, exits 0 (fail-CLOSED).
  - Stub hangs (timeout) → forwarder emits `deny` to stdout, exits 0 (fail-CLOSED).
  - Stub refuses connection → forwarder emits `deny` to stdout, exits 0 (fail-CLOSED).
  - Stub returns malformed JSON → forwarder emits `deny` to stdout, exits 0 (fail-CLOSED).
  - Forwarder crashes/throws internally → exits 0 with `deny` (no uncaught exception propagates to CLI).
- [ ] Implement `hook-forward.mjs`: reads full stdin as JSON, reads `AOA_RUNTIME_HOOK_URL` + `AOA_RUNTIME_HOOK_TOKEN` from env, POSTs to URL with `Authorization: Bearer <token>`, writes response JSON to stdout; wraps everything in try/catch — on ANY error writes `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"hook-forward error"}}` and exits 0.
- [ ] Typecheck + commit `feat(claude-local): PreToolUse settings builder + fail-safe hook forwarder`.

### Task 6 — execute.ts injection + flag gating (adapter side)

**Files:** `packages/adapters/claude-local/src/server/execute.ts`, `packages/adapters/claude-local/src/__tests__/execute-runtime-hooks.test.ts`.

**Key constraint:** `execute.ts` does NOT mint tokens or touch the registry. It only reads `context.runtimeHookBridge` (a `RuntimeHookBridgeSpec`) passed from heartbeat. The token is received only via env that heartbeat pre-sets before calling `execute`; `execute.ts` passes it along to the forwarder subprocess env.

- [ ] Failing tests (argv-capture like existing `execute-target.test.ts`):
  - **Bridged:** `context.runtimeHookBridge.enabled === true` → argv contains `--settings <path>`; the file has a `PreToolUse` hook pointing at `runtimeHookBridge.selfBaseUrl + runtimeHookBridge.path`; argv does **NOT** contain `--dangerously-skip-permissions` even if `config.dangerouslySkipPermissions === true` (bridging overrides skip; log a warning); `AOA_RUNTIME_HOOK_TOKEN` is present in the subprocess env; raw token is absent from argv string.
  - **Token absence from meta:** the `onMeta` callback receives `AdapterInvocationMeta`; assert the `AOA_RUNTIME_HOOK_TOKEN` value is absent from all serialized fields (`command`, `commandArgs`, `context`, `env` values) — heartbeat persists this as a run event.
  - **Unbridged:** `runtimeHookBridge` absent or `enabled === false` → argv byte-for-byte current behavior (regression guard); `--settings` not added; skip-permissions behavior unchanged.
- [ ] Implement in `execute.ts`: `const bridge = ctx.runtimeHookBridge; const bridged = bridge?.enabled === true;` (heartbeat already applied the local-target guard before setting `enabled`). When bridged: call `buildPreToolUseSettings` + `writeRuntimeHookSettingsFile`, push `--settings <path>`, skip the `--dangerously-skip-permissions` branch, set `AOA_RUNTIME_HOOK_TOKEN` and `AOA_RUNTIME_HOOK_URL` in the subprocess env. Guard: `--settings` and `--dangerously-skip-permissions` never coexist. Clean up the settings tempfile after the subprocess exits (in a finally).
- [ ] Run `execute-runtime-hooks` + `execute-target` (regression). Typecheck + commit `feat(claude-local): inject PreToolUse settings + omit skip-permissions when bridged`.

### Task 7 — Heartbeat flag resolution + bridge context

**Files:** `server/src/services/heartbeat.ts`, `server/src/services/runtime-hook-registry.ts` (used here), `server/src/__tests__/runtime-decision-routing-flag.test.ts`.

**Heartbeat owns the full token lifecycle:** mint → register → pass plain strings to adapter → deregister in `finally`.

- [ ] Failing tests for pure `resolveRuntimeDecisionRoutingEnabled({agentRuntimeConfig, instanceEnv, adapterType, executionTargetType})`:
  - env unset/`0` → false (instance kill-switch off).
  - env `1` + agent flag true + `adapterType === "claude_local"` + `executionTargetType === "local"` → true.
  - env `1` + agent flag absent → false.
  - `adapterType !== "claude_local"` → false (adapter guard).
  - `executionTargetType !== "local"` → false (execution-target guard: `sandbox-docker`/`provider-sandbox` cannot reach `127.0.0.1:PORT`).
- [ ] Implement resolver (exported for test). In `heartbeat.ts` near broker build (~line 3957): call `resolveRuntimeDecisionRoutingEnabled`. When true: `const token = mintRuntimeHookToken(); registry.register(token, {broker: runtimeDecisionBroker, companyId, agentId: agent.id, runId: run.id, expiresAt: new Date(Date.now() + RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000 + 60_000)});` (slight TTL buffer). Set `runtimeHookBridge: {enabled: true, selfBaseUrl: resolveSelfBaseUrl(), path: RUNTIME_HOOK_PATH, timeoutSec: RUNTIME_HOOK_BLOCK_TIMEOUT_SEC}` on the `AdapterExecutionContext`. Set `AOA_RUNTIME_HOOK_TOKEN = token` in the run env (passed to adapter). Wrap `await adapter.execute(...)` in `try { ... } finally { registry.deregister(token); }` — deregisters on both success AND rejected promise (including mid-block cancellation).
- [ ] `resolveSelfBaseUrl()`: reuse existing `AOA_API_URL`/`127.0.0.1:${PORT}` resolution (same pattern as ~line 3820).
- [ ] Typecheck + commit `feat(heartbeat): gate claude_local runtime-decision bridge behind per-agent flag + instance kill-switch + local-target guard`.

### Task 8 — Timeout / expiry reconciliation

**Files:** extend route test + `server/src/__tests__/runtime-hook-timeout.test.ts`.

- [ ] Tests: broker `requestPermission` never resolves within `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC` → `requestPermissionBounded` returns `deny` before the CLI hook `timeout` (fake clock / never-resolving broker stub); the W5a row has `expiresAt ≈ now + blockTimeout` so `expireDuePrompts` (`escalate` policy) reconciles it independently — no orphaned `created` rows.
- [ ] **Late-answer regression:** `requestPermissionBounded` has returned `deny`; simulate founder answering via API afterwards; assert `markRelayed` is NOT called and the row remains in its reconciled state (escalated/expired, not `relayed`).
- [ ] Commit `fix(runtime-hooks): server-side block timeout aligns with CLI hook deadline + W5a sweep reconciliation`.

### Task 9 — Failure modes

**Files:** extend route + execute tests. Named tests, each asserting the safe outcome:

- [ ] User never answers → `requestPermissionBounded` timeout → deny + sweep reconciles row to escalated/expired state.
- [ ] Run exits mid-block → `cancelActiveForRun` → `waitForAnswer` throws `RuntimeDecisionCancelledError` → route catch → deny; `finally` in heartbeat deregisters (no leaked registry entry).
- [ ] Relay fails (`markRelayed` throws) → route deny; W5a marks `relay_failed`.
- [ ] Adapter session gone (registry TTL-pruned) → `resolve(token)` returns null → deny; broker never invoked.
- [ ] Stale/duplicate prompt (CLI retry) → deterministic nonce/`source_unique_key` (sorted-key canonical JSON) → same W5a row; no duplicate hub items; single decision drives both hook responses.
- [ ] **Allow-always match (prior trust rule covers this scope):** W5a `createPrompt` auto-answers the decision (`status = answered`, `decision = allow_always`) AND still emits a hub item (in an already-answered state — NOT an open, founder-actionable prompt). Assert: (a) the decision is **auto-answered without any founder action** — do NOT assert "zero hub items"; assert the emitted item is already `answered`/`relayed`, not `open`; (b) the route returns `allow` immediately (broker resolves without a wait); (c) the scope fields `{toolName, command, commandHash, path, networkTarget, riskClass}` built by `buildPermissionPromptFromHook` match exactly what `trustRuleMatchesPrompt` inspects (so the match actually fires).
- [ ] Spoofed hook call (guessed token) → timing-safe mismatch → deny; broker never invoked.
- [ ] Commit `test(runtime-hooks): cancel/relay-fail/stale/allow-always/spoof failure modes`.

### Task 10 — End-to-end / test-bridge

**Files:** `tests/e2e/runtime-decision-bridge.spec.ts` (advisory; Windows e2e skipped per CI matrix; gate on a logged-in CLI else `test.skip`).

- [ ] Seed company + `claude_local` agent with `runtimeConfig.runtimeDecisionRoutingEnabled=true`, env `AOA_RUNTIME_DECISION_ROUTING=1`; run a tool-forcing prompt; assert a hub item appears; answer `allow`; assert the run proceeds; second run, answer `deny`, assert blocked.
- [ ] **CI-Linux integration variant** (no real CLI): drive the route directly with a synthetic hook payload against a real broker + test DB to prove create→wait→answer→relay→allow end-to-end.
- [ ] Commit `test(e2e): runtime-decision bridge allow/deny acceptance (advisory) + CI integration loop`.

### Task 11 — Docs + decision record

- [ ] `docs/architecture/decisions.md`: append locked decision (claude_local `PreToolUse` bridge, `type:"command"` forwarder fail-CLOSED rationale, permission-only, flag-gated including local-execution-target guard, fail-safe deny, token-via-env-only, single-process registry assumption + multi-process follow-up). `docs/adapters/claude-local.md`: document the flag + hook. Commit `docs: record W5b claude_local runtime-decision bridge decision`.

---

## Verification

From repo root: focused suites (`runtime-hook-registry`, `runtime-hook-bridge`, `runtime-hooks-route`, `runtime-hook-timeout`, `runtime-hook-settings`, `execute-runtime-hooks`, `execute-target` regression, `runtime-decision-routing-flag`, `agent-runtime-decision` W5a regression); `pnpm -r typecheck`; full `pnpm test:run`; `pnpm build`; e2e (advisory non-Linux; CI integration-loop on required Linux `e2e`); manual live smoke with a logged-in CLI 2.1.126.

## Self-Review

Spec coverage: every File-Structure row maps to a task. No standalone override section — all corrections are integrated inline. Hook type: `PreToolUse` throughout (Task 1 confirms; `PreToolUse "*"` ruled out for volume). Transport: `type:"command"` forwarder throughout — native `type:"http"` removed (fail-OPEN documented and excluded). Token hygiene: token travels only via env (`AOA_RUNTIME_HOOK_TOKEN`); never in argv, `AdapterInvocationMeta`, `context`/`config` blobs, run-log NDJSON, prompt snapshots, or run-summary comments; tested in Tasks 5, 6, 9. Registry ownership: server/heartbeat only; adapter never imports it; tested in Tasks 2, 7. `requestPermissionBounded`: replaces naive `Promise.race`; late-answer-no-relay regression tested in Tasks 4, 8. Execution-target guard: `executionTarget.type === "local"` required; tested in Task 7. Allow-always test (Task 9): asserts the decision is auto-answered without a founder action and the emitted hub item is already-answered — does NOT assert "zero hub items" (W5a `createPrompt` still emits a hub item on a trust-rule match, but immediately answered). Spike file: `.spike.ts` suffix, excluded via vitest config, never collected by default suite. Type consistency: `RUNTIME_HOOK_BLOCK_TIMEOUT_SEC`/`RUNTIME_HOOK_PATH` (Task 2) used in Tasks 3/4/5/6/7; `buildPermissionPromptFromHook`/`mapAnswerToHookResponse` (Task 3) used in Task 4; registry API (Task 2) used in Tasks 4/7. Scope guard: claude_local only, permission-only, flag-gated, fail-safe deny, W5a reused unmodified.

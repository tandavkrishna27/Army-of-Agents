# MCP stdio bridge — robust fix (design / spec)

**Status:** approved design (2026-06-06). Next: writing-plans → plan-eng-review → implement (TDD).
**Branch:** `fix/codex-mcp-bridge` off `origin/feat/v1-combined`.
**Decision:** no shortcuts — replace the hand-rolled stdio protocol loop with the official MCP SDK transport; do not band-aid the custom loop.

## Goal

Make the AoA MCP **stdio bridge** correct and robust so CLI-adapter crew agents (codex / opencode / gemini) can actually execute their MCP tools (`post_entry`, `thread.updateSummary`, …) end-to-end, and so a transport failure can never again be reported as a silent `succeeded`. claude is unaffected and must stay working.

## Root cause (confirmed + reproduced live)

`server/src/services/internal-agent/mcp-bridge.ts` is a hand-rolled JSON-RPC-over-stdio server (readline loop + `process.stdout.write` + `process.exit`). At lines 261-263:

```js
rl.on("close", () => { process.exit(0); });
```

When the CLI client half-closes stdin between request batches, `rl`'s `close` fires and the process exits **before in-flight async `tools/call` handlers finish and write their response**. The client sees `Transport closed` for every call. The agent run still completes and reports `succeeded` while posting nothing.

**Evidence:** codex session transcripts contain *"every AoA MCP call failed with `Transport closed`, including thread.listEntries … and post_entry."* Deterministic repro: spawn the real bridge, send `initialize`→`tools/list`→`tools/call` then EOF → init+list respond, `tools/call` gets **no** response, process exits 0, stderr empty. Hold stdin open → the same `tools/call` responds correctly. So tool/DB/model/auth are all fine; the premature exit is the whole bug.

## Blast radius (verified)

| Adapter | Uses `mcp-bridge` (shared)? | Wiring |
|---|---|---|
| codex-local | ✅ | `config.toml [mcp_servers.aoa]`, `tsx mcp-bridge.ts` |
| opencode-local | ✅ | `opencode.json`, `node mcp-bridge.js` |
| gemini-local | ✅ | gemini MCP config |
| **claude-local** | ❌ | native `--mcp-config <file>` (`isClaudeFamily`, `runner.ts:360`) — **untouched** |
| cursor / grok / openclaw / acpx / pi | ❌ | no MCP bridge |

One file, three providers. The fix must keep all three working (test the shared contract); claude carries zero risk.

## Latent fragilities in the same file (all addressed)

- **Unguarded stdout:** protocol frames via raw `process.stdout.write`; any `console.log` / DB notice corrupts framing.
- **Crash on tool error:** approval path (`mcp-bridge.ts:~98,109`) awaited *outside* try/catch in the async readline handler → uncaught rejection kills the process.
- **No protocol negotiation:** hardcoded `protocolVersion "2024-11-05"`.
- **Naive line framing:** readline assumes one JSON object per line.

## Design

### A. Transport: official MCP SDK (foundation) — but NOT the correctness mechanism

Replace the readline/`process.stdout.write`/`process.exit` loop in `mcp-bridge.ts` with `@modelcontextprotocol/sdk`:
- `Server` (`@modelcontextprotocol/sdk/server/index.js`) + `StdioServerTransport` (`…/server/stdio.js`).
- Register `ListToolsRequestSchema` → `buildToolListResponse(filterAuthorizedToolsForContext(...))` and `CallToolRequestSchema` → existing `handleToolCall`.
- **Keep the entire tool layer unchanged:** `createToolRegistry`, `executeTool`, `authorize-tool`, env-derived `ToolContext`, `createToolCallHandler`. Only the transport/protocol switch is replaced. `createToolCallHandler` and `buildToolListResponse` stay exported (existing unit tests keep passing).
- **Pin v1 `@modelcontextprotocol/sdk`** (NOT the newer split `@modelcontextprotocol/server`). Verify ESM export-maps resolve under BOTH `tsx mcp-bridge.ts` (codex) and `node mcp-bridge.js` (opencode). Verify our `McpToolResult` shape passes the SDK's (stricter) result-schema validation.

> **Correction from cross-model review (codex checked the v1 SDK source):** the SDK avoids the explicit `process.exit(0)`, but it does **NOT** implement graceful "drain in-flight then close" on stdin EOF. The SDK is the maintained protocol/framing foundation; it is **not, by itself, a fix for the EOF-mid-call drop.** The actual fix is the explicit lifecycle in §B, proven by the repro test (§Tests). Do not assume `transport.onclose` fires on EOF or that the SDK drains for us.

### B. Lifecycle: explicit in-flight drain + parent-liveness watchdog (the real fix)

The correctness mechanism, independent of the transport:
- **Track in-flight `tools/call` count** (`inFlight`), incremented on dispatch, decremented on response write.
- **On stdin EOF:** do NOT `process.exit`. **Drain** — wait for `inFlight === 0` (the in-flight handlers complete and write to stdout, which stays open) — then close the transport and exit 0. Never exit from a stdin event while `inFlight > 0`.
- **Plan task #0 (linchpin):** empirically determine the client's stdin lifecycle — does codex/opencode/gemini **half-close stdin per request-batch** (so EOF is NOT session-end and the bridge must keep serving) or **hold stdin open for the whole session** (EOF == session end → drain-then-exit is correct)? Instrument a real run (count `tools/call` per bridge spawn vs. when stdin EOFs). This decision sets whether EOF triggers drain-then-exit or just drain-and-keep-serving.
- **Watchdog (parent liveness), with codex's Windows hazards baked in:** PPID polling is fragile on Windows — `tsx`/`.cmd`/shell wrappers and reparenting mean the *logical* MCP client may not be the direct parent, and PID reuse exists. Rules: **never terminate while `inFlight > 0`**; use a grace window; treat a failed liveness probe as **"unknown," not "dead"** (require N consecutive failures). Goal: no orphaned bridges (the piled-up codex.exe) without ever killing mid-call. Verify behavior for remote/sandbox execution targets too.

### C. stdout discipline + crash isolation

- **Actively redirect** `console.*` → **stderr** and guard `process.stdout.write` so a tool's stray `console.log` cannot corrupt the protocol frame. (Per codex: "SDK owns stdout" is necessary but NOT sufficient — stray writes still hit `process.stdout` unless intercepted.) stdout is reserved for protocol only.
- **Crash isolation lives around the request handlers:** every tool handler (incl. the approval path at `mcp-bridge.ts:~98,109`) wrapped so a throw becomes an `isError` tool result, never a process crash.
- **Global handlers:** `process.on('unhandledRejection'|'uncaughtException')` → **log fatally to stderr**. Do NOT blanket-swallow-and-continue (a truly-uncaught process-level exception can mean corrupted state; per-tool failures are already isolated above, so a global one is genuinely unexpected and should be loud — log + let the process end cleanly rather than limp on corrupted).

### D. Loud failure (detect → fail the run → surface)

Today a run whose every MCP call failed still reports `succeeded`. Detection feeds a **shared helper both the parsed events AND the raw stdout/stderr** (per codex — the marker can appear in any of them depending on CLI/version):
- Detect **MCP transport/connection-class failures only** (`Transport closed`, MCP server disconnect, tool-call transport errors) — explicitly **distinguish from a tool legitimately returning `isError`** (a real tool error must NOT mark the run failed, or we cry wolf). Count transport-class failures.
- Per-provider fidelity (verified by codex): codex JSONL has structured `error`/`turn.failed`; opencode inspects `tool_use` errors in `parseOpenCodeJsonl` — both plausible. **gemini's stream is broader / less MCP-specific → higher false-negative risk.** Where a provider exposes **no clean transport marker**, record an explicit **"unknown transport status"** and document the gap — do NOT fake coverage.
- If a run had MCP tool-call attempts and ≥1 failed with a transport-class error, set the adapter result to **failed** with `errorMessage` ("AoA MCP bridge transport failed: <detail>"). `runner.ts` propagates → `heartbeat_runs.status = failed` + error, surfaced in the run record/UI. **No auto-retry, no new UI surface** beyond the run record (per decision).
- One shared detection helper, fed by all three adapters' parse paths (raw + parsed), to avoid drift.

### E. Cross-provider safety

The bridge change is shared by codex/opencode/gemini and must be verified for all three, not assumed (see Tests). claude is on the native `--mcp-config` path and is explicitly out of the change.

## Components / files

| File | Change |
|---|---|
| `server/src/services/internal-agent/mcp-bridge.ts` | Swap transport to SDK `Server`+`StdioServerTransport`; keep tool layer; stderr-only logging; crash handlers; watchdog. |
| `server/package.json` | Add pinned `@modelcontextprotocol/sdk`. |
| `server/src/services/internal-agent/cli-mode.ts` | `buildMcpBridgeSpec` — unchanged command/args/env contract (verify the SDK bridge still launches under `tsx …ts` and `node …js`). |
| `packages/adapters/{codex,opencode,gemini}-local/src/server/*` | No logic change expected; verify wiring + add the transport-failure detection hook to each parse path (shared helper). |
| `server/src/services/internal-agent/aoa-agents/runner.ts` | Propagate adapter "transport failed" → run `failed` + error. |
| Shared detection helper (new, small) | Detect MCP transport-class failures from a CLI run's parsed events. |
| Tests (below) | New across unit / integration / cross-provider E2E / regression. |

## Test matrix (all types — explicit)

1. **Unit (bridge handler):** `createToolCallHandler` responds for known tools; unknown tool → `isError`; approval-path throw → `isError` result (process does NOT exit). Pure, no subprocess.
2. **Unit (stdout discipline):** a tool handler that calls `console.log` / writes to stdout does NOT corrupt the protocol stream (assert the redirect/guard works and frames stay intact).
3. **Unit (watchdog):** parent alive → stays up; N consecutive failed liveness probes → terminates; **never terminates while `inFlight > 0`**; failed probe once → treated as "unknown," not "dead."
4. **Integration (THE regression for this bug):** spawn the real bridge subprocess (BOTH `tsx …ts` and `node …js`); `initialize`→`tools/list`→`tools/call` then close stdin immediately; **assert the `tools/call` response lands.** Fails on old code, passes on new. This is the gate for the whole fix.
5. **Integration (lifecycle edge cases — codex's gaps):**
   - **Two in-flight calls at EOF**, one slow + one failing → both responses land (or fail) before exit; neither dropped.
   - **Concurrent / out-of-order** `tools/call` (overlapping) → each response matches its `id`; ordering safe.
   - **Large tool payload** (backpressure over the SDK's stdout buffer) → full frame delivered, not truncated.
   - **Malformed JSON / partial frame before EOF** → parse error response (or clean ignore), no crash.
   - **`notifications/initialized`** handled (no response); **protocol-version negotiation** with the client succeeds.
   - **EPIPE on send** (client closed stdout) → bridge logs + exits cleanly, no unhandled crash.
6. **Unit (loud-failure detection):** transport-class failure (in parsed events OR raw stdout/stderr) → failed+message; a legitimate tool `isError` → **NOT** marked failed (no false positive); provider with no clean marker → "unknown transport status." Per-adapter (codex/opencode/gemini) fixtures.
7. **Cross-provider E2E (gated live):** a real crew agent posts a thread entry end-to-end through the bridge for **codex_local, opencode_local, gemini_local**. Gated/live (each CLI must be installed/authed); unavailable CLI → **skip loudly with a logged reason** (no silent skip). codex confirmed available; opencode/gemini gated.
8. **Regression (loud failure):** a run whose bridge calls all fail with transport errors → `heartbeat_runs.status = failed` (not `succeeded`), error surfaced.
9. **Compat:** existing `mcp-bridge` / adapter tests still green (`codex-config-toml.test.ts`, `opencode-config-json.test.ts`, the existing `createToolCallHandler`/`buildToolListResponse` unit tests). SDK result-shape compatibility asserted.
10. **Gate:** `pnpm -r typecheck` + full server vitest suite green.

## Rollout

- Worktree `fix/codex-mcp-bridge` off `origin/feat/v1-combined`; TDD (failing integration repro first, then SDK swap to green).
- Land via PR. Do **not** commit to `feat/v1-combined` directly. Never `git add -A`.
- Live re-verify on the existing isolated QA instance (codex crew posts an entry) before calling it done.

## Out of scope (tracked separately)

- Consolidating the **inbound** HTTP MCP server (`server/src/mcp/server.ts`, hand-rolled JSON-RPC over Express) onto the SDK — separate, larger project.
- Auto-retry of a run on transport failure; new UI banners beyond the run record.
- The unrelated discussions findings (F1 onboarding crew-provider ignored, F2 Reviewer not seeded, F4 codex default model, hop-cap UX, etc.) — separate triage.

## Open risks / verification points (cross-model review: codex + claude)

- **[Task #0 — linchpin] Client stdin lifecycle:** does the CLI half-close stdin per request-batch (EOF ≠ session end → keep serving) or hold it open for the session (EOF == end → drain-then-exit)? Resolve empirically before locking §B. Everything downstream depends on this.
- **SDK does NOT drain on EOF by itself** (codex verified against v1 source) — the drain lifecycle in §B is mandatory and explicit; the repro test (§Tests #4) is the proof, not the SDK.
- **SDK package identity:** pin **v1 `@modelcontextprotocol/sdk`**, NOT the newer split `@modelcontextprotocol/server`. Verify ESM export-maps resolve under `tsx .ts` AND `node .js`. Verify `McpToolResult` passes the SDK's stricter result-schema validation (could reject slightly-noncompliant shapes).
- **Watchdog on Windows:** PPID may not be the logical MCP client (`tsx`/`.cmd`/shell wrappers reparent; PID reuse). Never kill while `inFlight>0`; grace + N-consecutive-failures before "dead"; verify remote/sandbox targets.
- **stdout discipline is active, not passive:** must redirect/guard `process.stdout.write` (a tool's `console.log` still corrupts frames otherwise).
- **Loud-failure fidelity:** feed parsed events + raw stdout/stderr; gemini's stream is broad (false-negative risk) → "unknown transport status" when no clean marker; never flag a legit tool `isError` as a transport failure.
- **Verify-in-branch:** confirm `claude_local` truly does not use this bridge on `fix/codex-mcp-bridge` (runner still references `buildMcpConfig` + `--mcp-config`) — guard the "claude unaffected" claim.
- **New dependency hygiene:** `@modelcontextprotocol/sdk` license, transitive size, and clean bundling in the server build / npm distribution.

## Success criteria

- A codex_local crew agent posts a real thread entry + the Chronicler writes a summary, live, on the QA instance.
- The integration repro test fails on the old code and passes on the SDK transport.
- opencode_local and gemini_local each verified (live or gated) to post through the bridge.
- A forced transport failure marks the run `failed`, not `succeeded`.
- claude_local crew still works (no regression); full server test suite + typecheck green.

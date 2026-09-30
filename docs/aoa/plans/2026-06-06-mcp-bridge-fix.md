# MCP stdio bridge robust-fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **The user wants `plan-eng-review` BEFORE execution.**

**Goal:** Make the shared AoA MCP stdio bridge correct so codex/opencode/gemini crew agents can execute their MCP tools end-to-end, and so a transport failure surfaces as a `failed` run instead of a silent `succeeded`.

**Architecture:** Replace the hand-rolled readline/`process.exit` loop in `mcp-bridge.ts` with the official `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport` (keep the tool layer). The **actual** correctness mechanism is an explicit lifecycle: **never `process.exit` on stdin EOF**; terminate only via a parent-liveness watchdog that never fires while a call is in flight. Add stdout discipline, crash isolation, and transport-failure detection that marks the run failed. claude is on a different path and is untouched.

**Tech Stack:** Node ESM + TypeScript, `@modelcontextprotocol/sdk` (v1, pinned), Drizzle ORM, vitest. Worktree `AoA-mcp-fix` / branch `fix/codex-mcp-bridge`.

---

## Refinements applied (plan-eng-review, 2026-06-06) — READ FIRST, they amend the tasks below

- **F1 — Split Task 3 into 3a then 3b (fix-first, refactor-second; Beck's "make the change easy, then make the easy change").**
  - **Task 3a:** implement the lifecycle fix on the **existing hand-rolled readline loop** — create `bridge-lifecycle.ts` (`createInFlightCounter` + `startParentWatchdog`), stop calling `process.exit(0)` on `rl.on("close")`, increment/decrement `inFlight` around the `tools/call` await, start the watchdog. **The Task 2 repro test goes GREEN here, with no SDK yet.** Commit.
  - **Task 3b:** swap the transport to the SDK `Server` + `StdioServerTransport` (the code shown in old Task 3 Step 2), keeping the exact lifecycle behavior. **Repro + all unit tests stay GREEN — this is a structural-only, green-to-green refactor.** Commit. (If 3b regresses anything, the bug fix from 3a is already isolated and shippable.)
- **F2 — Loud-failure uses the EXISTING error channel, structured-events-first.** Do NOT add a `transportFailure` field to the parse result. Instead set **`errorCode: "MCP_TRANSPORT_FAILED"`** (+ `errorMessage`, `errorMeta`) on the adapter's `AdapterExecutionResult` (the channel already exists — `packages/adapter-utils/src/types.ts:112-114`). `runner.ts` checks `adapterResult.errorCode === "MCP_TRANSPORT_FAILED"` → mark run `failed`. Feed `detectTransportFailure` the CLI's **structured error events first**; use raw stdout/stderr only as a **tight** fallback so a thread whose *content* mentions "transport closed" cannot false-positive the run to failed. (Replaces Task 9's `transportFailure`-field approach.)
- **F3 — stdout discipline: redirect `console.*` only; do NOT guard `process.stdout.write`.** The SDK writes protocol frames directly to `process.stdout` — guarding/throwing on it would break the SDK. Task 5 implements `installStdoutGuard` as a `console.*`→stderr redirect ONLY. **Delete Task 5's "bare `process.stdout.write` of non-protocol throws" assertion** — keep just the "console.log goes to stderr, frames intact" assertion.
- **F4 — Task 0 also answers "is the watchdog even needed?"** In the probe, additionally determine whether the OS **already reaps the bridge** when the spawning CLI dies (process-group / Windows Job Object). If yes, the PPID watchdog is a thin backstop. If no, add **`stdin-EOF + grace + inFlight===0`** as a second termination signal, because PPID alone may point at an intermediate `tsx`/`.cmd` process, not the logical MCP client. Record the verdict.
- **F5 — Integration test (Task 2) asserts the response ARRIVES, not its content.** The assertion is `ids.toContain(3)` (a result OR `isError` both count) so it passes without a seeded thread. Document the `AOA_TEST_DATABASE_URL` requirement and **skip-loudly** (logged reason) if no DB is reachable, rather than failing opaquely.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `server/src/services/internal-agent/mcp-bridge.ts` | the bridge | Swap transport→SDK; new lifecycle (no-exit-on-EOF + watchdog); stdout redirect; crash isolation. Tool layer (`createToolCallHandler`, `buildToolListResponse`, `executeAndFormat`, exports) **unchanged**. |
| `server/src/services/internal-agent/bridge-lifecycle.ts` | **new** | `trackInFlight()` counter + `startParentWatchdog()` — small, unit-testable, no bridge coupling. |
| `server/src/services/internal-agent/transport-failure.ts` | **new** | `detectTransportFailure({ parsedErrorMessages, rawStdout, rawStderr })` shared helper — transport-class only, returns `{ failed, detail }` or `{ status: "unknown" }`. |
| `server/package.json` | deps | add pinned `@modelcontextprotocol/sdk`. |
| `packages/adapters/codex-local/src/server/parse.ts` | codex parse | feed `detectTransportFailure` (parsed + raw). |
| `packages/adapters/opencode-local/src/server/parse.ts` | opencode parse | same. |
| `packages/adapters/gemini-local/src/server/parse.ts` | gemini parse | same; "unknown" when no marker. |
| `server/src/services/internal-agent/aoa-agents/runner.ts` | run result | propagate adapter transport-failed → `heartbeat_runs.status='failed'` + error. |
| `server/src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts` | **new** | spawn real bridge, EOF mid-call, edge cases. |
| `server/src/services/internal-agent/__tests__/bridge-lifecycle.test.ts` | **new** | watchdog + inFlight unit. |
| `server/src/services/internal-agent/__tests__/transport-failure.test.ts` | **new** | detection unit. |

---

## Task 0: Empirical probe — client stdin lifecycle (LINCHPIN, no code)

**Why:** decides whether stdin EOF means "session over" or "just a batch boundary." Everything in Task 3/7 depends on it. This is investigation, not TDD.

**Files:** none (capture findings in the commit message + append to the spec's "Open risks").

- [ ] **Step 1: Instrument a throwaway probe bridge.** Copy `mcp-bridge.ts` to `/tmp/probe-bridge.mjs` (compiled/JS) and add stderr logging on every event: `stdin 'data'` (count requests), `stdin 'end'`, `stdin 'close'`, and a timestamp. Do NOT exit on close.

- [ ] **Step 2: Point one provider at it.** On the running QA instance (company `8d7569f2-…`), temporarily set one crew agent's `adapter_config.cwd`/bridge command to the probe (or run codex directly with a `config.toml` whose `[mcp_servers.aoa].command` is the probe). Trigger one crew run (an @mention).

Run: observe `/tmp/probe.stderr`.
Expected to learn: **how many `tools/call` arrive per bridge process, and whether `stdin 'end'` fires once at session end or repeatedly between calls.**

- [ ] **Step 3: Record the verdict.** Write one of:
  - **(A) stdin held open for the session** → EOF == session end. Lifecycle may drain-then-exit on EOF (watchdog is backstop).
  - **(B) stdin half-closed per batch** → EOF ≠ session end. Lifecycle MUST NOT exit on EOF; watchdog-only termination.
  - If inconclusive → **default to (B)** (it can never drop a call).

- [ ] **Step 4: Commit the finding.**
```bash
git -C "<worktree>" add docs/aoa/plans/2026-06-06-mcp-bridge-fix-design.md
git -C "<worktree>" commit -m "docs(probe): client stdin lifecycle = <A|B|inconclusive->B>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: Worktree setup + pin the SDK

**Files:** Modify `server/package.json`.

- [ ] **Step 1: Install + build the libs.**
```bash
pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-mcp-fix" install
pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-mcp-fix" --filter "./packages/**" build
```
Expected: install completes; all packages build (`packages/db`, `shared`, adapters, plugin-sdk). (Fresh worktree has no `dist/`; the `node mcp-bridge.js` path + server boot need it.)

- [ ] **Step 2: Add the pinned SDK.**
```bash
pnpm -C "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-mcp-fix\server" add @modelcontextprotocol/sdk@^1.0.0
```
Expected: `server/package.json` gains `"@modelcontextprotocol/sdk": "^1.x.x"` under dependencies. Confirm it is `@modelcontextprotocol/sdk`, NOT `@modelcontextprotocol/server`.

- [ ] **Step 3: Import smoke test** — create `server/src/services/internal-agent/__tests__/sdk-import.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("mcp sdk export-map", () => {
  it("resolves Server, StdioServerTransport, schemas", () => {
    expect(typeof Server).toBe("function");
    expect(typeof StdioServerTransport).toBe("function");
    expect(ListToolsRequestSchema).toBeTruthy();
    expect(CallToolRequestSchema).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run it.**
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/sdk-import.test.ts`
Expected: PASS. (If the import fails, the export-map/version is wrong — fix the pin before continuing.)

- [ ] **Step 5: Commit.**
```bash
git -C "<worktree>" add server/package.json package.json pnpm-lock.yaml server/src/services/internal-agent/__tests__/sdk-import.test.ts
git -C "<worktree>" commit -m "deps: pin @modelcontextprotocol/sdk v1 + import smoke test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: FAILING integration regression — EOF mid-call (the gate)

**Files:** Create `server/src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts`.

- [ ] **Step 1: Write the failing test.** It spawns the REAL bridge via `tsx mcp-bridge.ts`, sends `initialize`→`tools/list`→`tools/call`, then closes stdin immediately, and asserts the `tools/call` response (id 3) arrives. It needs a DB — use the same QA DB URL (or a test DB). Use `thread.listEntries` against a known thread, or any read tool.

```ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const BRIDGE = path.resolve(__dirname, "../mcp-bridge.ts");
const DB_URL = process.env.AOA_TEST_DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54440/paperclip";

function runBridge(input: string, opts: { closeStdinAfterMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("tsx", [BRIDGE], {
      env: {
        ...process.env,
        AOA_SESSION_COMPANY_ID: process.env.AOA_TEST_COMPANY_ID ?? "8d7569f2-43e9-4b57-8709-2a4687364e44",
        AOA_SESSION_USER_ID: "aoa-subagent",
        AOA_SESSION_USER_ROLE: "founder",
        AOA_SESSION_ENABLED_CAPABILITIES: "discussion_processing,system_actions",
        AOA_AGENT_KIND: "aoa",
        AOA_TOOL_ALLOWLIST: "thread.listEntries,get_thread_summary,thread.updateSummary",
        AOA_EFFECTIVE_AUTONOMY: "2",
        DATABASE_URL: DB_URL,
      },
      shell: true, // Windows: resolve tsx(.cmd)
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code }));
    proc.stdin.write(input);
    setTimeout(() => proc.stdin.end(), opts.closeStdinAfterMs); // EOF right after the call
    setTimeout(() => proc.kill(), 30_000); // safety
  });
}

describe("mcp-bridge EOF-mid-call (regression)", () => {
  it("delivers the tools/call response even when stdin EOFs immediately after the call", async () => {
    const tid = process.env.AOA_TEST_THREAD_ID ?? "376592a2-91e6-4327-81fb-8fb7e498b6c4";
    const input =
      JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }) + "\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "thread.listEntries", arguments: { threadId: tid } } }) + "\n";
    const { stdout } = await runBridge(input, { closeStdinAfterMs: 5 });
    const ids = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).id; } catch { return null; } });
    expect(ids).toContain(3); // the tools/call response MUST land
  }, 40_000);
});
```

- [ ] **Step 2: Run it against the CURRENT code.**
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts`
Expected: **FAIL** — `ids` does not contain 3 (the current `rl.on('close')→process.exit(0)` drops it). This proves the test is meaningful.

- [ ] **Step 3: Commit the failing test** (red).
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts
git -C "<worktree>" commit -m "test: failing EOF-mid-call regression for the MCP bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: lifecycle fix + SDK transport (make the repro pass)

> **⚠️ F1 (plan-eng-review): do this in TWO commits.** **3a:** lifecycle fix on the EXISTING readline loop (`createInFlightCounter` + watchdog + stop exiting on `rl.on("close")`) → Task 2 repro GREEN, no SDK. Commit. **3b:** swap the transport to SDK `Server`+`StdioServerTransport` (the code in Step 2 below), keeping the lifecycle behavior → repro + units stay GREEN (structural-only refactor). Commit. Never do the structural swap and the behavioral fix in one commit.

**Files:** Create `server/src/services/internal-agent/bridge-lifecycle.ts`; Modify `server/src/services/internal-agent/mcp-bridge.ts` (replace `startBridge`'s readline loop; keep everything above it).

- [ ] **Step 1: Create the lifecycle helper** `bridge-lifecycle.ts`:
```ts
/** In-flight tool-call counter — the watchdog must never terminate while > 0. */
export function createInFlightCounter() {
  let n = 0;
  return {
    enter() { n++; },
    leave() { n = Math.max(0, n - 1); },
    get count() { return n; },
  };
}

/**
 * Terminate the bridge only when its parent (the spawning CLI) is gone — and
 * NEVER while a tool call is in flight. PPID liveness is fragile (Windows
 * reparenting / .cmd wrappers), so a single failed probe is "unknown", not
 * "dead": require N consecutive failures.
 */
export function startParentWatchdog(opts: {
  getInFlight: () => number;
  onDead: () => void;
  ppid?: number;
  intervalMs?: number;
  graceFailures?: number;
}) {
  const ppid = opts.ppid ?? process.ppid;
  const graceFailures = opts.graceFailures ?? 3;
  let failures = 0;
  const timer = setInterval(() => {
    let alive = true;
    try { process.kill(ppid, 0); } catch (e: any) { alive = e?.code === "EPERM"; } // EPERM = exists, no perm = alive
    if (alive) { failures = 0; return; }
    if (++failures < graceFailures) return;          // unknown, not dead yet
    if (opts.getInFlight() > 0) return;              // never kill mid-call
    clearInterval(timer);
    opts.onDead();
  }, opts.intervalMs ?? 1000);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
```

- [ ] **Step 2: Rewrite `startBridge` in `mcp-bridge.ts`** — keep all env/db/`toolContext`/`handleToolCall` setup (lines ~438-510), then replace the `readline` block (lines ~512-562) with the SDK server + lifecycle:
```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createInFlightCounter, startParentWatchdog } from "./bridge-lifecycle.js";

// ... unchanged setup up to: const handleToolCall = createToolCallHandler({ tools, executeTool, toolContext });

  const inFlight = createInFlightCounter();
  const server = new Server(
    { name: "aoa-mcp-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visibleTools = filterAuthorizedToolsForContext(tools, toolContext);
    return { tools: buildToolListResponse(visibleTools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    inFlight.enter();
    try {
      // handleToolCall already returns { content, isError } and never throws.
      return await handleToolCall(req.params.name, req.params.arguments ?? {});
    } finally {
      inFlight.leave();
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // LIFECYCLE (Task 0 verdict). Default = (B) do NOT exit on stdin EOF; the
  // watchdog terminates on parent death (never while in flight). This avoids
  // the SDK "response sent after handler returns" drain race entirely: the
  // process stays alive long enough for the SDK to flush the response.
  startParentWatchdog({ getInFlight: () => inFlight.count, onDead: () => process.exit(0) });
  // NOTE: intentionally NO transport.onclose -> process.exit. If Task 0 = (A),
  // add a drain-then-exit on onclose guarded by `while (inFlight.count) await sleep`.
```
Also delete the old `const isMainModule = …; if (isMainModule) { startBridge()… }` only if it changes; keep the `startBridge().catch(...)` entrypoint guard (it stays valid).

- [ ] **Step 3: Run the repro test.**
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts`
Expected: **PASS** — `ids` now contains 3. (The bridge no longer exits on stdin EOF; the watchdog kills it only after the test ends / parent gone.)

- [ ] **Step 4: Add the `node .js` entrypoint variant** to the integration test (second `it`) that builds the server (`pnpm -C "<worktree>/server" build`) once and spawns `node dist/.../mcp-bridge.js`. Assert the same.
Run: same vitest file. Expected: PASS for both entrypoints.

- [ ] **Step 5: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/bridge-lifecycle.ts server/src/services/internal-agent/mcp-bridge.ts server/src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts
git -C "<worktree>" commit -m "fix(mcp-bridge): SDK transport + watchdog lifecycle; never exit on stdin EOF

Fixes Transport-closed: the bridge no longer process.exit(0)s on stdin EOF,
so in-flight tools/call responses are delivered. Repro test passes.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Keep the tool-layer unit tests green + SDK schema compat

**Files:** Test: existing `server/src/services/internal-agent/__tests__/*mcp-bridge*`/handler tests; add one schema-compat assertion.

- [ ] **Step 1: Run the existing handler unit tests.**
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__ -t "mcp-bridge|tool call|handler"`
Expected: PASS (the tool layer is unchanged; `createToolCallHandler`/`buildToolListResponse` still exported).

- [ ] **Step 2: Add a schema-compat unit test** in a new `server/src/services/internal-agent/__tests__/mcp-result-schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

describe("McpToolResult is SDK-compliant", () => {
  it("a typical handler result parses against CallToolResultSchema", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ success: true, data: {} }) }], isError: false };
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });
  it("an error result parses too", () => {
    const result = { content: [{ type: "text", text: "Tool execution error: boom" }], isError: true };
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });
});
```
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/mcp-result-schema.test.ts`
Expected: PASS. (If it fails, our `content` shape needs adjusting to satisfy the SDK — fix in `executeAndFormat`.)

- [ ] **Step 3: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/mcp-result-schema.test.ts
git -C "<worktree>" commit -m "test: assert McpToolResult passes SDK CallToolResultSchema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: stdout discipline (active redirect)

**Files:** Modify `mcp-bridge.ts` (top of `startBridge`, before `server.connect`).

- [ ] **Step 1: Write the failing test** `server/src/services/internal-agent/__tests__/stdout-discipline.test.ts` — a tool whose handler calls `console.log` must not corrupt frames. Use the integration harness from Task 2 but register/allowlist a tool that logs (or assert via a unit that `console.log` is rerouted). Minimal unit form:
```ts
import { describe, it, expect, vi } from "vitest";
import { installStdoutGuard } from "../mcp-bridge.js"; // export this small fn

describe("stdout guard", () => {
  it("reroutes console.log to stderr; bare process.stdout.write of non-protocol throws/logs", () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const restore = installStdoutGuard();
    console.log("stray log");
    expect(errSpy).toHaveBeenCalled();   // went to stderr, not stdout
    restore();
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`installStdoutGuard` not defined).
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/stdout-discipline.test.ts` → FAIL.

- [ ] **Step 3: Implement `installStdoutGuard` in `mcp-bridge.ts`** (export it) and call it first in `startBridge`:
```ts
export function installStdoutGuard(): () => void {
  const origConsole = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const toErr = (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = toErr; console.info = toErr; console.debug = toErr; console.warn = toErr;
  return () => { Object.assign(console, origConsole); };
}
```
Call `installStdoutGuard();` as the first line of `startBridge()`. (Protocol writes go through the SDK transport, which owns `process.stdout` directly — untouched.)

- [ ] **Step 4: Run → PASS.** Run the repro test again too (no regression).

- [ ] **Step 5: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/mcp-bridge.ts server/src/services/internal-agent/__tests__/stdout-discipline.test.ts
git -C "<worktree>" commit -m "fix(mcp-bridge): reroute console.* to stderr so logs cannot corrupt protocol frames

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Crash isolation

**Files:** Modify `mcp-bridge.ts`.

- [ ] **Step 1: Confirm per-tool isolation already holds.** `handleToolCall`→`executeAndFormat` wraps tool execution in try/catch → `isError`. Add a unit asserting a throwing tool yields `isError:true` (not a throw):
```ts
// server/src/services/internal-agent/__tests__/handler-crash-isolation.test.ts
import { describe, it, expect } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";
describe("handler crash isolation", () => {
  it("a tool that throws returns isError, never rejects", async () => {
    const tool = { name: "boom", description: "", parameters: { type: "object" } } as any;
    const handle = createToolCallHandler({
      tools: [tool],
      executeTool: async () => { throw new Error("kaboom"); },
      toolContext: { /* minimal */ } as any,
      runtimeApprovals: { findTrustedExact: async () => true, createPending: async () => ({ id: "x" }) } as any,
    });
    const r = await handle("boom", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("kaboom");
  });
});
```
Run → adjust the `toolContext` minimal stub until it PASSES (policy must allow the tool; if approval is required the stub returns trusted).

- [ ] **Step 2: Add global fatal handlers in `startBridge`** (log, do NOT silently continue):
```ts
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`MCP Bridge fatal unhandledRejection: ${String((reason as any)?.stack ?? reason)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`MCP Bridge fatal uncaughtException: ${err?.stack ?? err}\n`);
  // per-tool errors are already isolated; a process-level one is genuinely unexpected.
});
```
(Decision per spec: log loudly; do not blanket-swallow into "keep limping." Per-tool failures never reach here.)

- [ ] **Step 3: Run** the handler-isolation test + repro test. Expected: PASS.

- [ ] **Step 4: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/mcp-bridge.ts server/src/services/internal-agent/__tests__/handler-crash-isolation.test.ts
git -C "<worktree>" commit -m "fix(mcp-bridge): per-tool isolation test + loud global crash handlers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Watchdog unit tests

**Files:** Create `server/src/services/internal-agent/__tests__/bridge-lifecycle.test.ts`.

- [ ] **Step 1: Write the tests** (inject a fake `ppid` and a controllable liveness via `opts.ppid` pointing at a known-dead/known-alive pid; use fake timers):
```ts
import { describe, it, expect, vi } from "vitest";
import { startParentWatchdog, createInFlightCounter } from "../bridge-lifecycle.js";

describe("parent watchdog", () => {
  it("never terminates while inFlight > 0", () => {
    vi.useFakeTimers();
    const inFlight = createInFlightCounter(); inFlight.enter();
    const onDead = vi.fn();
    startParentWatchdog({ getInFlight: () => inFlight.count, onDead, ppid: 999999999, graceFailures: 1, intervalMs: 10 });
    vi.advanceTimersByTime(100);
    expect(onDead).not.toHaveBeenCalled(); // in flight -> never kill
    inFlight.leave();
    vi.advanceTimersByTime(100);
    expect(onDead).toHaveBeenCalled();     // now idle + dead parent
    vi.useRealTimers();
  });
  it("treats a single failed probe as unknown (graceFailures)", () => {
    vi.useFakeTimers();
    const onDead = vi.fn();
    startParentWatchdog({ getInFlight: () => 0, onDead, ppid: 999999999, graceFailures: 3, intervalMs: 10 });
    vi.advanceTimersByTime(10); expect(onDead).not.toHaveBeenCalled(); // 1 fail
    vi.advanceTimersByTime(10); expect(onDead).not.toHaveBeenCalled(); // 2 fails
    vi.advanceTimersByTime(10); expect(onDead).toHaveBeenCalled();     // 3rd -> dead
    vi.useRealTimers();
  });
  it("stays alive while the parent is alive", () => {
    vi.useFakeTimers();
    const onDead = vi.fn();
    startParentWatchdog({ getInFlight: () => 0, onDead, ppid: process.pid, graceFailures: 1, intervalMs: 10 });
    vi.advanceTimersByTime(100);
    expect(onDead).not.toHaveBeenCalled(); // self pid is alive
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run → PASS** (implementation exists from Task 3). If pid 999999999 is unexpectedly "alive" on Windows, pick a guaranteed-dead pid or stub `process.kill`.
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/bridge-lifecycle.test.ts`

- [ ] **Step 3: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/bridge-lifecycle.test.ts
git -C "<worktree>" commit -m "test: parent watchdog (never-kill-in-flight, grace, parent-alive)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Lifecycle edge-case integration tests

**Files:** Modify `mcp-bridge-lifecycle.integration.test.ts` (add `it`s).

- [ ] **Step 1: Add the edge cases**, each spawning the real bridge:
  - **two in-flight at EOF (one slow, one failing):** send two `tools/call` (id 3 = a read tool; id 4 = an unknown tool → isError), then EOF; assert BOTH id 3 and id 4 responses land.
  - **concurrent / out-of-order:** send id 3 and id 4 back-to-back; assert each response carries its own id (no cross-wiring).
  - **large payload:** call a tool returning a large `data` (or list a thread with many entries); assert the full JSON frame parses (not truncated).
  - **malformed/partial frame before EOF:** write `'{ "jsonrpc": "2.0", "method": "tools/li'` then EOF; assert no crash (process exits via watchdog/kill, no unhandled error in stderr).
  - **notifications/initialized:** send it; assert no response line for it and the next request still works.
```ts
it("delivers both responses when two calls are in flight at EOF", async () => {
  const tid = process.env.AOA_TEST_THREAD_ID ?? "376592a2-91e6-4327-81fb-8fb7e498b6c4";
  const input =
    JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 3, params: { name: "thread.listEntries", arguments: { threadId: tid } } }) + "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 4, params: { name: "nope_unknown", arguments: {} } }) + "\n";
  const { stdout } = await runBridge(input, { closeStdinAfterMs: 5 });
  const ids = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).id; } catch { return null; } });
  expect(ids).toContain(3);
  expect(ids).toContain(4);
}, 40_000);
```

- [ ] **Step 2: Run → PASS** (fix any drop/ordering bug in the lifecycle if a case fails).
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts`

- [ ] **Step 3: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/mcp-bridge-lifecycle.integration.test.ts
git -C "<worktree>" commit -m "test: bridge lifecycle edge cases (two-in-flight, concurrent, large, partial, notifications)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Loud-failure detection (shared helper + 3 adapters + runner)

> **IMPLEMENTATION NOTE (landed server-side — see commit `24773eeb9`):** the
> three adapter `parse.ts` files were NOT modified. `packages/adapters/*` cannot
> import from `server/src`, so detection was centralized in the pure
> `buildAoaRunResultFromAdapter` (`aoa-run-result.ts`), fed by the adapter
> result's `errorMessage` + raw `resultJson.stdout/stderr` that already flow to
> the runner. This is lower-blast-radius (zero adapter changes) and more robust
> (scans the raw output where the marker actually lands even when an adapter's
> parse misses it). The runner passes `{ mcpAttempted: !isClaudeFamily,
> markerSupported: adapterType !== "gemini_local" }`. Steps below describe the
> original per-adapter plan; the helper + tests are as written.

**Files:** Create `transport-failure.ts`; Modify `parse.ts` ×3; Modify `runner.ts`; Tests.

- [ ] **Step 1: Write the helper unit test** `server/src/services/internal-agent/__tests__/transport-failure.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { detectTransportFailure } from "../transport-failure.js";

describe("detectTransportFailure", () => {
  it("flags Transport closed from raw stderr", () => {
    expect(detectTransportFailure({ parsedErrorMessages: [], rawStdout: "", rawStderr: "MCP error: Transport closed" }).failed).toBe(true);
  });
  it("flags from a parsed event message", () => {
    expect(detectTransportFailure({ parsedErrorMessages: ["every AoA MCP call failed with Transport closed"], rawStdout: "", rawStderr: "" }).failed).toBe(true);
  });
  it("does NOT flag a legitimate tool isError", () => {
    expect(detectTransportFailure({ parsedErrorMessages: ["Tool execution error: validation failed"], rawStdout: "", rawStderr: "" }).failed).toBe(false);
  });
  it("returns unknown when there is no marker at all but MCP was used", () => {
    const r = detectTransportFailure({ parsedErrorMessages: [], rawStdout: "", rawStderr: "", mcpAttempted: true, markerSupported: false });
    expect(r.status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run → FAIL** (helper missing).

- [ ] **Step 3: Implement `transport-failure.ts`:**
```ts
const TRANSPORT_RE = /transport closed|mcp .*(disconnect|connection closed|server (?:exited|closed))|connection to mcp server lost/i;
// Explicitly NOT matching "Tool execution error" / generic isError text.

export interface TransportFailureInput {
  parsedErrorMessages: string[];
  rawStdout: string;
  rawStderr: string;
  mcpAttempted?: boolean;
  markerSupported?: boolean; // false for providers w/o a clean marker (e.g. gemini)
}
export type TransportFailureResult =
  | { failed: true; detail: string }
  | { failed: false; status?: "unknown" };

export function detectTransportFailure(input: TransportFailureInput): TransportFailureResult {
  const hay = [...input.parsedErrorMessages, input.rawStdout, input.rawStderr].join("\n");
  const m = hay.match(TRANSPORT_RE);
  if (m) return { failed: true, detail: m[0] };
  if (input.mcpAttempted && input.markerSupported === false) return { failed: false, status: "unknown" };
  return { failed: false };
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Wire each adapter parse.** In `codex-local/.../parse.ts` and `opencode-local/.../parse.ts`, after building `errorMessage`, also compute `transportFailure = detectTransportFailure({ parsedErrorMessages: [...collectedEventErrors], rawStdout: stdout, rawStderr: stderr, mcpAttempted: true, markerSupported: true })` and return it on the parse result. For `gemini-local/.../parse.ts`, pass `markerSupported: false`. (Feed BOTH parsed events and raw.) Keep the existing return shape; ADD a `transportFailure` field.

- [ ] **Step 6: Propagate in `runner.ts`.** Where the adapter result is turned into the run outcome (~line 449), if `adapterResult.transportFailure?.failed` (or the parse surfaced it), set the heartbeat run `status='failed'` + `error = "AoA MCP bridge transport failed: " + detail`. Add a unit/integration around the runner result mapping (mock the adapter result with a transportFailure and assert the run row is `failed`).

- [ ] **Step 7: Run the adapter parse tests + runner test → PASS.**
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/transport-failure.test.ts` and the adapter `parse` tests.

- [ ] **Step 8: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/transport-failure.ts server/src/services/internal-agent/__tests__/transport-failure.test.ts packages/adapters/codex-local/src/server/parse.ts packages/adapters/opencode-local/src/server/parse.ts packages/adapters/gemini-local/src/server/parse.ts server/src/services/internal-agent/aoa-agents/runner.ts
git -C "<worktree>" commit -m "feat: loud-failure detection — transport-closed marks run failed (not succeeded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Verify-in-branch — claude does not use the bridge

**Files:** Test only.

- [ ] **Step 1: Add a guard test** `server/src/services/internal-agent/__tests__/claude-not-bridged.test.ts` asserting the runner gate: for `adapterType === "claude_local"`, the MCP delivery is the `--mcp-config` path and `ctx.mcpBridge` is NOT consumed (claude adapter has no `mcpBridge` reference). Assert via the runner's `isClaudeFamily` branch (unit) and a grep-style source assertion (`fs.readFileSync(claude execute.ts).includes("mcpBridge") === false`).

- [ ] **Step 2: Run → PASS.** Commit.
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/claude-not-bridged.test.ts
git -C "<worktree>" commit -m "test: guard that claude_local never consumes the MCP stdio bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Cross-provider E2E (gated live)

**Files:** Create `server/src/services/internal-agent/__tests__/crew-post-e2e.live.test.ts` (gated).

- [ ] **Step 1: Write the gated test.** For each provider in `["codex_local","opencode_local","gemini_local"]`: if the CLI isn't installed/authed (probe `which <cli>` / a 1-line adapter probe), `it.skip` with a **logged reason** (`console.warn` via stderr — no silent skip). Otherwise: seed/point a crew agent at that adapter, run a real participation that should call `post_entry`, and assert a `discussion_entries` row with `author_agent_id = <agent>` appears (DB check). Reuse the QA DB.
```ts
const PROVIDERS = ["codex_local", "opencode_local", "gemini_local"] as const;
for (const p of PROVIDERS) {
  const available = isCliAvailable(p); // which codex / opencode / gemini
  (available ? it : it.skip)(`${p}: crew agent posts an entry end-to-end`, async () => {
    // arrange: agent on adapter p; act: trigger a participation; assert: new agent-authored entry in DB
  }, 180_000);
  if (!available) console.warn(`[e2e] SKIP ${p}: CLI not installed/authed`);
}
```

- [ ] **Step 2: Run** (codex available → runs; opencode/gemini skip-loudly if absent).
Run: `pnpm -C "<worktree>/server" exec vitest run src/services/internal-agent/__tests__/crew-post-e2e.live.test.ts`
Expected: codex PASS; others PASS or loud-skip.

- [ ] **Step 3: Commit.**
```bash
git -C "<worktree>" add server/src/services/internal-agent/__tests__/crew-post-e2e.live.test.ts
git -C "<worktree>" commit -m "test: gated cross-provider E2E — crew posts an entry via the bridge (codex/opencode/gemini)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final gate + live re-verify

**Files:** none (verification).

- [ ] **Step 1: Typecheck.** Run: `pnpm -C "<worktree>" -r typecheck` → no errors.
- [ ] **Step 2: Full server suite.** Run: `pnpm -C "<worktree>/server" exec vitest run` → green (incl. existing `codex-config-toml.test.ts`, `opencode-config-json.test.ts`).
- [ ] **Step 3: Live re-verify** on the isolated QA instance: switch the crew back to `codex_local` (the DB update from the QA session), restart the QA server on this branch's build, @mention Scout, and confirm via psql that a Scout-authored `discussion_entries` row appears AND the Chronicler writes a non-null summary.
- [ ] **Step 4: Final commit** if any cleanup; otherwise open the PR (finishing-a-development-branch).

---

## Self-Review

**Spec coverage:** §A SDK transport → Task 1,3,4. §B drain/watchdog lifecycle → Task 0,3,7,8. §C stdout+crash → Task 5,6. §D loud-failure → Task 9. §E cross-provider → Task 11. Task-0 linchpin → Task 0. Verify-claude → Task 10. Tests 1-10 in spec → Tasks 2,5,6,7,8,9,11 + compat in 4. Gate → Task 12. ✅ all spec sections mapped.

**Placeholder scan:** the `<worktree>` token is a fixed path defined in Tech Stack/Task 1 (substitute the AoA-mcp-fix absolute path). The runner propagation (Task 9 Step 6) references "~line 449" — the implementer confirms the exact result-mapping site; the behavior (set status failed + error) is concrete. No "TBD/handle edge cases" placeholders.

**Type consistency:** `createInFlightCounter`/`startParentWatchdog` (Task 3) used identically in Task 7. `detectTransportFailure` signature (Task 9 Step 3) matches its test (Step 1) and the adapter call sites (Step 5). `installStdoutGuard` (Task 5) returns a restore fn, used so in its test. `handleToolCall`/`createToolCallHandler`/`buildToolListResponse` names match `mcp-bridge.ts`.

**Open dependency:** Task 0's verdict (A/B) feeds Task 3's lifecycle comment — default (B) is safe and is what Task 3 implements; (A) only adds an optional drain-then-exit, noted inline.

---

## NOT in scope (deferred, with rationale)

- Migrating the **inbound** HTTP MCP server (`server/src/mcp/server.ts`) onto the SDK — separate, larger project; this plan only fixes the outbound stdio bridge.
- Auto-retry of a run on transport failure / new UI surface beyond the run record — YAGNI for the fix; the run record + `failed` status is enough to make it loud.
- The other discussions findings (F1 onboarding crew-provider ignored, F2 Reviewer not seeded, F4 codex default model, hop-cap UX) — separate triage, unrelated to the bridge.

## What already exists (reused, not rebuilt)

- The whole **tool layer** (`createToolCallHandler`, `executeAndFormat`, `buildToolListResponse`, `filterAuthorizedToolsForContext`, `tool-registry`, `authorize-tool`) — unchanged; only the transport swaps.
- `AdapterExecutionResult.errorCode/errorMessage/errorMeta` (`packages/adapter-utils/src/types.ts:112-114`) — the loud-failure signal rides this existing channel (F2), not a new field.
- Per-adapter parse (`parseCodexJsonl`, `parseOpenCodeJsonl`, `parseGeminiJsonl`) — extended to feed the shared detector, not duplicated.
- `buildMcpBridgeSpec` (tsx-for-.ts / node-for-.js) — contract unchanged.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | n/a (bug fix, not a product change) |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES → RESOLVED | spec cross-model reviewed; "SDK doesn't drain on EOF" correction + hardening folded in |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 5 findings (F1–F5), 0 critical, all applied to the plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (backend protocol work) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | n/a |

- **CODEX:** independently reviewed the spec against the v1 SDK source; surfaced the key correction (SDK does not implement graceful EOF-drain) — folded into the design before the plan was written.
- **CROSS-MODEL:** codex (spec) + claude (spec + plan) converged. No unresolved tension — both agree the lifecycle drain is the real fix and the SDK is the transport foundation.
- **UNRESOLVED:** 0.
- **FAILURE MODES:** the one silent-failure mode (transport-closed → `succeeded`) is now covered by loud-failure detection (Task 9) + its regression test; no untested-AND-unhandled-AND-silent path remains.
- **PARALLELIZATION:** sequential — every task touches the bridge or its directly-coupled adapters/runner; no independent lanes.
- **VERDICT: ENG CLEARED** (+ codex outside-voice on the spec) — ready to implement. The EOF-mid-call repro (Task 2) is the gate: it must fail on current code and pass after Task 3a.

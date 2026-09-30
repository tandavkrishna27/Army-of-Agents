# Commander Codex E2E — Targeted Additions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the one concentrated high-risk coverage gap the 3-source review found — the Commander **codex** path has ZERO end-to-end coverage — with TARGETED additions (a `fake-codex` fixture + a handful of specs/contract tests), NOT a full-suite rewrite.

**Architecture:** Mirror the existing, proven `fake-claude` fixture. Commander's cli-mode resolves the literal binary `codex` from PATH and spawns `codex exec --json … -` (prompt over stdin, one process per turn). A deterministic `fake-codex` shim on the e2e PATH reads a control file and emits codex JSONL (`thread.started` / `item.completed` reasoning + agent_message / `turn.completed` usage / `turn.failed`) that `parseCodexJsonl` already accepts. Browser specs drive the real UI; a server-side SSE-contract test and a done-invariant test cover the route/parse seams without a browser (so they run on every platform, not just the Linux-gated e2e).

**Tech Stack:** Playwright, Vitest, Node ESM shim, the existing e2e harness (`tests/e2e/`), `@armyofagents/adapter-codex-local` JSONL shapes.

---

## Background: verified codex JSONL shapes (from real `codex exec --json`, captured this session)

`parseCodexJsonl` (`packages/adapters/codex-local/src/server/parse.ts`) consumes exactly:
- `{"type":"thread.started","thread_id":"<id>"}` → sessionId (for resume)
- `{"type":"turn.started"}` → ignored
- `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"…"}}` → reasoning chunk
- `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}` → assistant reply (summary)
- `{"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N}}` → usage
- `{"type":"turn.failed","error":{"message":"…"}}` (or `{"type":"error","message":"…"}`) → errorMessage → `runCodexTurn` yields `{type:"error"}`

The Commander codex spawn argv (post-fix): `["exec","--json","--dangerously-bypass-approvals-and-sandbox","--model",<resolved>,"-c","model_reasoning_effort=high","-c","model_reasoning_summary=detailed", …("resume",<id>),"-"]`. The shim ignores argv except `resume <id>` (reuse thread_id) and may honor a control-driven failure to simulate the gpt-5.3-codex 400.

---

## File Structure

- **Create** `tests/e2e/fixtures/fake-codex/codex` + `codex.cmd` + `fake-codex.mjs` — the shim (mirror fake-claude).
- **Create** `tests/e2e/helpers/fake-codex.ts` — `FAKE_CODEX_CONTROL_PATH` + control types + `writeFakeCodexControl()` (mirror `helpers/fake-claude.ts`).
- **Modify** `tests/e2e/playwright.config.ts` — add `FAKE_CODEX_BIN_DIR` to the webServer `PATH` (alongside fake-claude) + `AOA_E2E_FAKE_CODEX_CONTROL` env.
- **Create** `server/src/__tests__/internal-agent-chat-route-sse.test.ts` (P0, no browser) — route SSE-contract + persistence.
- **Create** `server/src/__tests__/cli-mode-done-invariant.test.ts` (P1, no browser) — exactly-one-done across claude-result / claude-plaintext-MCP / codex.
- **Create** `tests/e2e/commander-codex-reply.spec.ts` (P0) — codex reply + reasoning render + persist.
- **Create** `tests/e2e/commander-error-states.spec.ts` (P1) — not-configured + CLI-unavailable → error bubble.
- **Create** `tests/e2e/commander-codex-tokens-cost.spec.ts` (P1) — codex run → Settings Run History tokens + Est. Cost.
- **Create** `tests/e2e/commander-codex-resume.spec.ts` (P2) — two-turn codex resume continuity + reasoning both turns.

No product-code change. No schema change.

---

### Task 1: The `fake-codex` shim + helper

**Files:**
- Create: `tests/e2e/helpers/fake-codex.ts`
- Create: `tests/e2e/fixtures/fake-codex/fake-codex.mjs`
- Create: `tests/e2e/fixtures/fake-codex/codex` (bash shim) + `codex.cmd` (Windows shim)

- [ ] **Step 1: Read the fake-claude originals to mirror exactly**

Read `tests/e2e/helpers/fake-claude.ts`, `tests/e2e/fixtures/fake-claude/fake-claude.mjs`, `tests/e2e/fixtures/fake-claude/claude`, and `claude.cmd`. Mirror their structure (control-path computation, the EPIPE guard, the `claude`/`claude.cmd` → `fake-*.mjs` dispatch).

- [ ] **Step 2: Write `helpers/fake-codex.ts`**

```ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Shared control-file path between the playwright config (exports it to the
 *  webServer env as AOA_E2E_FAKE_CODEX_CONTROL) and the specs (which rewrite it
 *  before each Commander send). Deterministic tmpdir path — identical in the
 *  config process, the spec runner, and the shim's fallback. */
export const FAKE_CODEX_CONTROL_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-codex-control.json",
);

export interface FakeCodexControl {
  /** thread_id the shim echoes in thread.started; the resume turn reuses it. */
  sessionId?: string;
  /** reasoning summary text — emitted as an item.completed reasoning item. Omit for none. */
  reasoning?: string;
  /** the assistant reply — emitted as an item.completed agent_message item. */
  text: string;
  /** usage echoed in turn.completed. */
  usage?: { input?: number; cached?: number; output?: number };
  /** force a failure: "model-400" simulates the gpt-5.3-codex ChatGPT-account
   *  rejection; "generic" emits a generic error. Omit for success. */
  fail?: "model-400" | "generic";
}

export function writeFakeCodexControl(c: FakeCodexControl): void {
  fs.writeFileSync(FAKE_CODEX_CONTROL_PATH, JSON.stringify(c), "utf8");
}
```

- [ ] **Step 3: Write `fixtures/fake-codex/fake-codex.mjs`**

```js
#!/usr/bin/env node
// Deterministic fake `codex` CLI for the Commander codex e2e. Commander's
// cli-mode resolves the literal binary "codex" from PATH and spawns
// `codex exec --json … -` (one process per turn; prompt over stdin). The
// playwright config prepends this dir to the webServer PATH. All argv is
// ignored except `resume <id>` (reuse thread_id). The control file
// (AOA_E2E_FAKE_CODEX_CONTROL) is rewritten by the spec before each send.
//
// Emits codex JSONL exactly as parseCodexJsonl consumes it:
//   {"type":"thread.started","thread_id"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id","type":"reasoning","text"}}
//   {"type":"item.completed","item":{"id","type":"agent_message","text"}}
//   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}}
//   {"type":"turn.failed","error":{"message"}}   (on fail)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONTROL_PATH =
  process.env.AOA_E2E_FAKE_CODEX_CONTROL ||
  path.join(os.tmpdir(), "aoa-e2e-fake-codex-control.json");

process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
  process.stderr.write(`fake-codex stdout error: ${err?.stack ?? err}\n`);
  process.exit(1);
});

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// Drain stdin (the prompt) so the parent's writable end closes cleanly.
try { fs.readFileSync(0); } catch { /* no stdin */ }

let control;
try {
  control = JSON.parse(fs.readFileSync(CONTROL_PATH, "utf8"));
} catch {
  control = { text: "(fake-codex: no control file)" };
}

const argv = process.argv.slice(2);
const resumeIdx = argv.indexOf("resume");
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : null;
const threadId = resumeId || control.sessionId || "fake-codex-thread-1";

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

if (control.fail) {
  const message =
    control.fail === "model-400"
      ? "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."
      : "fake-codex: forced generic failure";
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

if (control.reasoning) {
  emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: control.reasoning } });
}
emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: control.text ?? "" } });
emit({
  type: "turn.completed",
  usage: {
    input_tokens: control.usage?.input ?? 100,
    cached_input_tokens: control.usage?.cached ?? 0,
    output_tokens: control.usage?.output ?? 50,
  },
});
process.exit(0);
```

- [ ] **Step 4: Write the `codex` + `codex.cmd` shims (copy fake-claude's, swap the .mjs name)**

`tests/e2e/fixtures/fake-codex/codex` (bash) and `codex.cmd` (Windows) — byte-mirror `fake-claude`'s `claude`/`claude.cmd` but invoke `fake-codex.mjs`. Ensure the bash shim is executable (`chmod +x`).

- [ ] **Step 5: Verify the shim emits valid JSONL standalone**

```bash
cd "<worktree>/tests/e2e/fixtures/fake-codex"
node -e "require('fs').writeFileSync(process.env.TMP+'/aoa-e2e-fake-codex-control.json', JSON.stringify({reasoning:'thinking…',text:'hello',usage:{input:5,output:3}}))"
echo "prompt" | AOA_E2E_FAKE_CODEX_CONTROL="$TMP/aoa-e2e-fake-codex-control.json" node fake-codex.mjs exec --json --model gpt-5.5 -
```
Expected: 5 JSONL lines (thread.started, turn.started, 2× item.completed [reasoning+agent_message], turn.completed). Then with `{fail:"model-400"}` → thread.started, turn.started, turn.failed (exit 1).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/helpers/fake-codex.ts tests/e2e/fixtures/fake-codex/
git commit -m "test(e2e): add deterministic fake-codex CLI fixture + control helper"
```

---

### Task 2: Wire `fake-codex` into the playwright webServer PATH

**Files:** Modify `tests/e2e/playwright.config.ts`

- [ ] **Step 1: Add the bin dir constant + env wiring**

Near the existing `FAKE_CLAUDE_BIN_DIR` definition (the `path.join(__dirname,"fixtures","fake-claude")` around line 28-33), add:
```ts
const FAKE_CODEX_BIN_DIR = path.join(__dirname, "fixtures", "fake-codex");
```
Import the control path at top (next to the fake-claude import, line 6):
```ts
import { FAKE_CODEX_CONTROL_PATH } from "./helpers/fake-codex";
```
In the webServer `env` block, extend `PATH` to include BOTH fixtures and add the codex control env:
```ts
          PATH: `${FAKE_CLAUDE_BIN_DIR}${path.delimiter}${FAKE_CODEX_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
          AOA_E2E_FAKE_CLAUDE_CONTROL: FAKE_CLAUDE_CONTROL_PATH,
          AOA_E2E_FAKE_CODEX_CONTROL: FAKE_CODEX_CONTROL_PATH,
```

- [ ] **Step 2: Typecheck the config**

Run: `cd tests/e2e && npx tsc --noEmit -p tsconfig.json 2>/dev/null || cd "<worktree>" && pnpm -C tests/e2e exec tsc --noEmit` (use whatever the repo uses to typecheck e2e; if none, `node --check` the compiled form is not applicable — rely on the playwright run).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/playwright.config.ts
git commit -m "test(e2e): put fake-codex on the webServer PATH + control env"
```

---

### Task 3 (P0): Route SSE-contract + persistence test (no browser)

**Files:** Create `server/src/__tests__/internal-agent-chat-route-sse.test.ts`

This is the highest-value codex coverage that runs WITHOUT the e2e harness: it drives the real `/chat` route handler with a mocked `cliService.chat` and asserts the SSE event contract + the run persistence (the SSE→DB seam the review flagged as never integration-tested).

- [ ] **Step 1: Read the existing route-contract test harness**

Read `server/src/__tests__/internal-agent-routes-contract.test.ts` (and `internal-agent-run-persist.test.ts`) to reuse the established mock-db + route-invocation pattern (how the suite mocks `@armyofagents/db` + drizzle and drives the express handler / SSE writer).

- [ ] **Step 2: Write the failing test**

Mock `cliModeService.chat` (or `agentLoopService.chat`) to yield a fixed chunk sequence: `{type:"reasoning",delta}` → `{type:"tool_call",name}` → `{type:"tool_result",name,result:{success,summary}}` → `{type:"text",delta}` → `{type:"done",summary:{tokenUsage,costCents,durationMs,model:"gpt-5.5",provider:"openai"}}`. Capture the SSE writes. Assert:
- exactly ONE `event: done`, ONE `event: reasoning`, ONE `event: tool_result` (carrying `success` + `summary`, NOT `input`), ONE `event: content` (text).
- the persisted `internalAgentRuns` row has `tokenUsage`, `costCents` (from `resolveRunCostCents`), and `model:"gpt-5.5"`/`provider:"openai"` (the F1 provenance preference), and the done payload's `costCents`/`tokenUsage` match the DB row (F2).

Run: `cd server && pnpm vitest run src/__tests__/internal-agent-chat-route-sse.test.ts` → FAIL (file/assertions missing).

- [ ] **Step 3: Implement to green**

(No product change — the route already behaves this way post-fix; write the test to the real behavior. If the SSE writer is not easily capturable, factor the assertion around the same seam `internal-agent-routes-contract.test.ts` uses.)
Run again → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/__tests__/internal-agent-chat-route-sse.test.ts
git commit -m "test(commander): route SSE-contract + run persistence (reasoning/tool_result/done, model provenance)"
```

---

### Task 4 (P1): done-invariant test (no browser)

**Files:** Create `server/src/__tests__/cli-mode-done-invariant.test.ts`

- [ ] **Step 1: Write + green**

Drive `cliModeService.chat` (with a mocked spawn / parser) for three turn shapes and assert EXACTLY ONE `done` chunk each (the `sawRealDone` guard), with the expected `tokenUsage` source:
(a) claude result-event turn (real usage from the `result` event),
(b) claude plain-text MCP-tool turn with NO result event (fallback done),
(c) codex turn (usage from `turn.completed`).
Reuse the spawn-mock harness from `cli-mode.test.ts`. Run `cd server && pnpm vitest run src/__tests__/cli-mode-done-invariant.test.ts` → PASS.

- [ ] **Step 2: Commit**

```bash
git add server/src/__tests__/cli-mode-done-invariant.test.ts
git commit -m "test(commander): exactly-one-done invariant across claude/codex turn shapes"
```

---

### Task 5 (P0): `commander-codex-reply.spec.ts`

**Files:** Create `tests/e2e/commander-codex-reply.spec.ts`

- [ ] **Step 1: Read the codex-relevant existing specs**

Read `tests/e2e/commander-reasoning.spec.ts` (the Claude reasoning render+persist pattern to mirror) and `tests/e2e/commander-viewer.spec.ts` (how it seeds `internal_agent_config`, opens `/…/commander`, sends a message, and waits). Find how the spec sets the company's `cliTool` (DB write helper or API). 

- [ ] **Step 2: Write the spec**

- Seed `internal_agent_config.cliTool = "codex"` for the e2e company (mirror the config-seeding the reasoning spec uses; flip cliTool to codex).
- `writeFakeCodexControl({ reasoning: "Planning the launch sequence…", text: "Here is the 3-step plan: …", usage: {input:120,output:60} })`.
- Open `/…/commander`, new chat, send a message.
- Assert: the assistant reply renders the `text` (NOT raw JSONL), the `[data-testid="commander-reasoning"]` "Thinking" block appears and contains the reasoning, and after `page.reload()` the reasoning block persists (codex analogue of `commander-reasoning.spec`).

- [ ] **Step 3: Run it (provide DATABASE_URL so the Windows webServer boots)**

Run via the repo's e2e command with a DB (the harness skips the webServer on Windows only when DATABASE_URL is absent). Example: `cd "<worktree>" && DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/aoa_e2e AOA_E2E_PORT=<free> pnpm test:e2e tests/e2e/commander-codex-reply.spec.ts` (match the exact invocation the earlier commander-viewer e2e used this session). Expected: PASS. If the local harness cannot boot, verify the fixture JSONL standalone (Task 1 Step 5) and note the spec is Linux-CI-gated like the rest of the e2e suite.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/commander-codex-reply.spec.ts
git commit -m "test(e2e): codex Commander reply renders + reasoning persists across reload"
```

---

### Task 6 (P1): `commander-error-states.spec.ts`

**Files:** Create `tests/e2e/commander-error-states.spec.ts`

- [ ] **Step 1: Write + run**

Two cases, asserting the chat surface shows an ERROR bubble (not a hung "Thinking"):
- **not-configured:** ensure NO `internal_agent_config` row (or `cliTool=null`) → send → assert the "not configured / select a CLI tool" error renders.
- **CLI-unavailable:** with `cliTool="codex"` but the fake-codex shim NOT on PATH (or `fail:"model-400"` via the control file to exercise the route's `{type:"error"}` path) → send → assert the error bubble with the codex error message renders, and no perpetual spinner.
Run as in Task 5 Step 3. Commit:
```bash
git add tests/e2e/commander-error-states.spec.ts
git commit -m "test(e2e): commander error states (not-configured, codex failure) show an error bubble"
```

---

### Task 7 (P1): `commander-codex-tokens-cost.spec.ts`

**Files:** Create `tests/e2e/commander-codex-tokens-cost.spec.ts`

- [ ] **Step 1: Write + run**

- Seed `cliTool="codex"`, control with a known `usage`, send one codex message.
- Navigate to Settings → Commander → Run History.
- Assert the latest row shows a real **Tokens** cell (in/out from the usage) and an **Est. Cost** label (the list-price estimate disclaimer). This is the only true end-to-end of the tokens/cost-in-Settings seam (SSE → DB → RunHistory read-back). Commit:
```bash
git add tests/e2e/commander-codex-tokens-cost.spec.ts
git commit -m "test(e2e): codex run surfaces tokens + Est. cost in Settings Run History"
```

---

### Task 8 (P2): `commander-codex-resume.spec.ts`

**Files:** Create `tests/e2e/commander-codex-resume.spec.ts`

- [ ] **Step 1: Write + run**

Two sequential codex turns in one conversation (rewrite the control file before each send, with the SAME `sessionId`). Assert: turn 2 spawns with `resume <sessionId>` continuity (the shim echoes the thread_id; the reply renders), and the reasoning block renders on BOTH turns. Guards the resume argv path (currently only argv-shape unit-tested). Commit:
```bash
git add tests/e2e/commander-codex-resume.spec.ts
git commit -m "test(e2e): codex two-turn resume continuity + reasoning on both turns"
```

---

### Task 9: Full verification

- [ ] **Step 1: Server unit suites green**

Run: `cd server && pnpm vitest run` — expect the two new no-browser tests (Task 3, 4) green + no regression. tsc clean.

- [ ] **Step 2: Run the new e2e specs (best-effort local; otherwise standalone-fixture verified)**

Run the codex e2e specs with a DB as in Task 5 Step 3. Report pass/fail. If the Windows harness cannot boot the webServer, explicitly note: fixture JSONL verified standalone; specs are Linux-CI-gated (consistent with CLAUDE.md: Windows e2e skipped, Issue #114) and will run on the Linux required gate.

- [ ] **Step 3: Report**

Summarize: fixture behavior, new test counts, which ran live vs are CI-gated, commit SHAs.

---

## Self-Review

**Spec coverage (vs the review's proposed tests):** fake-codex fixture (Task 1) ✓, playwright wiring (Task 2) ✓, P0 route-SSE-contract (Task 3) ✓, P0 codex-reply (Task 5) ✓, P1 done-invariant (Task 4) ✓, P1 error-states (Task 6) ✓, P1 tokens-cost (Task 7) ✓, P2 resume (Task 8) ✓. This is the full targeted set — no full-suite rewrite.

**Placeholder scan:** the fixture + helper are complete code. Specs reference the real seeding/assertion patterns to be read first (Task 5 Step 1) — flagged, not hand-waved (the exact config-seed mechanism must be read from the existing specs).

**Type consistency:** `FAKE_CODEX_CONTROL_PATH`, `FakeCodexControl`, `writeFakeCodexControl`, `AOA_E2E_FAKE_CODEX_CONTROL`, `FAKE_CODEX_BIN_DIR` used identically across the helper, shim, and config. Control fields (`sessionId/reasoning/text/usage/fail`) match between the helper type and the shim's reads.

**Risks:**
- The codex cli-mode path writes a per-session CODEX_HOME config.toml + tries `ensureCodexAuthInHome` (copies `~/.codex/auth.json`); in e2e there's no `~/.codex` so it no-ops — the fake shim needs no auth. Confirm the spawn still proceeds (it does: auth copy is best-effort).
- Windows local e2e needs DATABASE_URL to boot the webServer (the config skips it otherwise). The no-browser tests (Task 3/4) are the platform-independent safety net.
- If `parseCodexJsonl` field names drift from the captured shapes, the fixture must track them — Task 1 Step 5 (standalone JSONL check) catches that early.

---

## Plan-review resolutions (real Codex CLI, `ship-with-fixes` — applied)

- **#1 control-file race (P0) — MITIGATED, no change.** `playwright.config.ts` forces `workers: 1` ("not worker-safe; multiple workers race on /api/companies"), so the single global control file is never clobbered by parallel specs. (Codex specs still run serially under one worker like the fake-claude specs.)
- **#5 reuse-existing-server (P1) — MITIGATED, no change.** The config sets `reuseExistingServer: false` (always boots a throwaway instance), so the webServer always inherits the fake-codex PATH + control/invocation env. (Do NOT run these specs against a hand-started dev server.)
- **#2/#3 invocation recording (P0) — APPLIED in the fixture.** `fake-codex.mjs` appends one JSON line per spawn to `FAKE_CODEX_INVOCATIONS_PATH` (`{argv, stdin, codexHome, configTomlExists}`); `helpers/fake-codex.ts` exports `readFakeCodexInvocations()` / `clearFakeCodexInvocations()`. **Task 2** must also add `AOA_E2E_FAKE_CODEX_INVOCATIONS: FAKE_CODEX_INVOCATIONS_PATH` to the webServer env. Verified standalone: a resume turn records `argv` containing `resume <sessionId>`; both turns carry `--json` + `model_reasoning_effort=high` + end with `-`.
  - **Task 5 (codex-reply)** must additionally assert the invocation record: first turn argv = `exec --json … --model <m> -c model_reasoning_effort=high -c model_reasoning_summary=detailed -`, `codexHome` set, `configTomlExists === true` (Commander wrote the per-session config.toml). This is what actually proves the cli-mode codex contract.
  - **Task 8 (resume)** must assert turn-2's recorded argv contains `resume <sessionId>` (clear invocations before turn 2) — the shim's own thread_id defaulting is NOT sufficient proof.
- **#4 "CLI-unavailable" mislabeled (P1) — RESTRUCTURED.** `fail:"model-400"` tests a codex JSONL failure, not a missing binary. **Task 6** covers (a) not-configured and (b) codex-failure (model-400 → error bubble) in the browser; the TRUE binary-missing case becomes a **no-browser server unit test** (`detectCliTool` returns unavailable → `chat` yields `{type:"error"}`), since you cannot un-prepend the fixture from PATH per-spec.
- **#6 failure-JSONL-wins (P1) — ADD a no-browser unit test.** Assert that when codex stdout contains `turn.failed` AND exit code is 1, `runCodexTurn` surfaces the parsed `errorMessage` (the 400 text), not the generic "exited with code 1" (verified in code: `parsed.errorMessage ?? exitFallback`). Fold into Task 4's file or the route-SSE test.
- **#7 tokens/cost too loose (P2) — TIGHTEN Task 7.** Seed a unique reply + exact `usage`; assert the EXACT input/output token numbers and scope the Run-History row to the codex run (by model/provider or the unique reply), not "the latest row".
- **#8 route-SSE ≠ codex-path proof (noted).** Task 3 (mocked `cliService.chat`) covers the route/SSE/persistence seam only. Codex-path coverage = the e2e specs (real fake-codex spawn) + the invocation-record assertions. Keep both; don't conflate.

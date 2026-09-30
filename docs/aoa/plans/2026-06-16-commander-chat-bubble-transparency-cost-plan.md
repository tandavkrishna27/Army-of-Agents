# Commander Chat — Bubble + Tool Transparency + Real Tokens & Est. Cost (Plan 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Commander chat read like the workspace and tell the truth about what it did — a neutral (non‑brand‑red) user bubble with a hover timestamp, an inline expandable activity list of the tools Commander ran (with status + duration), and real per‑run token counts plus an honest *estimated* cost in Settings → Run History.

**Architecture:** All work is in the **AoA-commander** worktree on branch **`feat/v1-commander-chat`**. The Commander chat is a self-contained pipeline distinct from the heartbeat-run transcript: `parse-stream-json.ts` / `parseCodexJsonl` → `cli-mode.ts` → `agent-loop.ts` → `POST /chat` SSE → `InternalAgentPanel.tsx`. A shared root-cause bug (a trailing hardcoded zero `done` that overwrites the parser's real summary) is fixed first; that one fix unblocks both duration display and token/cost capture. **No DB migration** — every column already exists. Cost is a list-price **estimate** (subscription CLI reports $0 by design), always labeled "Est." Thinking/reasoning is explicitly **out of scope** (Plan 2).

**Tech Stack:** TypeScript, React + Vite + Tailwind v4 (`ui/src`), Express 5 (`server/src`), Drizzle ORM, Vitest, the running `:3201` dev server (`/PIN/commander`).

---

## Review fixes — APPLIED (2026-06-16, 3 independent reviewers, 0 blockers)

The plan was reviewed by three adversarial code-reading reviewers (accuracy / regression / ship-breaker). All verdicts were *ship-with-fixes*; the foundation, type threading, and no-migration claim were verified correct against source. Fixes folded in:
- **Tool summary = human text, not raw JSON** (major): MCP tool summary now extracts the envelope's `summary` field via a shared `tool-summary.ts` (`humanToolSummary`), used by both the route and agent-loop. (Tasks 3.1/3.2/3.5)
- **Cost estimate priced by active `cliTool`, not the dormant `config.model`** (major): `rateModelForCliTool` maps claude_cli→claude rates, codex→gpt rates; +test. (Task 1.4)
- **Guard regression test** (major): a test asserting exactly ONE `done` with real numbers when a result event is present. (Task 1.2)
- **Enriched single `toolCalls` array** (matched by first-unmatched-name) replaces parallel toolCalls/toolResults arrays → reload maps 1:1, and the client `AgentMessage` keeps no `toolResults` field so the existing `outputRefs.test` stays green. (Tasks 3.2/3.3/3.4)
- **Dropped unbounded/unused tool `input`** from forward + persist. (Tasks 3.1/3.2)
- **Settings fixes**: Step 2 is a no-op (whole-object flatMap), `@/lib/utils` alias import, keep the Trigger column. (Task 2.2)
- **Remove dead `Wrench` import**; duplicate-import removed from the parser test; decision uses `##`; "Worked for Xs" documented as a live-only affordance. (Tasks 3.5/1.2/4.3)

---

## Context the implementer must not get wrong (read first)

1. **The double-`done` root cause.** The Claude `result` event and the Codex `turn.completed` event carry real token usage; the Claude parser already extracts `duration_ms`. But `cli-mode.ts` appends a **second, hardcoded zero** `done` after streaming (Claude `cli-mode.ts:733-743`, Codex `cli-mode.ts:577-586`), and the route keeps the **last** `done` it sees (`internal-agent.ts:292`). So the zero wins. Every numeric fix is pointless until this trailing zero-`done` is guarded.
2. **Cost is an estimate, never a bill.** Under CLI subscription auth (the normal Commander case) `total_cost_usd` is `0` by design — confirmed in `cost-model.ts:6-7`, `cost-caps.ts:36`, `aoa-run-result.ts`. Cost shown in Settings = `total_cost_usd * 100` when > 0, else `computeCostCents(provider, model, in, out)` (a token × list-price estimate). It is **always labeled "Est."** Tokens, by contrast, are real and metered.
3. **Reuse the working blueprint.** `server/src/services/internal-agent/aoa-agents/runner.ts:515-533` already does "prefer adapter cost, else `computeCostCents`, persist tokenUsage incl. cached + costCents." Mirror it; do not invent a new shape.
4. **No DB migration.** `internal_agent_runs` already has `toolsCalled`, `summary`, `tokenUsage` (jsonb, documents `{inputTokens,outputTokens,cachedInputTokens}`), `costCents`, `provider`, `model`. `internal_agent_messages` already has `toolCalls`, `toolResults`. `conversationService.appendMessage` already accepts `toolCalls`/`toolResults` (`conversation.ts:70-71`). The gap is population, not schema.
5. **Security: no raw HTML.** Tool result / summary text is raw tool output. It reaches the client and must render through `MarkdownBody` (react-markdown without `rehype-raw`) or as plain text — never injected as HTML. Always truncate before forwarding/persisting.
6. **Scope fence.** Cost numbers appear **only** in Settings → Run History, never in the chat. The chat shows tool activity + duration ("Worked for Xs") but **no cost/tokens**. `GET /runs` stays founder-only (unchanged RBAC). Thinking is Plan 2.
7. **Both providers.** Wire Claude **and** Codex for every backend change. Opencode/others degrade gracefully (no crash, zeros).

### File map (what each touched file is responsible for)

| File | Responsibility in this plan |
|------|------------------------------|
| `server/src/services/internal-agent/parse-stream-json.ts` | Claude: extract real usage+cost+duration into the `done` summary |
| `server/src/services/internal-agent/cli-mode.ts` | Guard the trailing zero-`done` (both providers); Codex `runCodexTurn` emits a real-usage `done` |
| `server/src/services/internal-agent/agent-loop.ts` | Widen `RunSummary`; accumulate + persist `toolCalls`/`toolResults` on the assistant turn |
| `server/src/routes/internal-agent.ts` | Capture provider+model on the run; persist real tokenUsage+costCents (estimate); forward tool input/result + duration over SSE |
| `server/src/services/internal-agent/cost-model.ts` | (no change — reused) |
| `ui/src/api/internal-agent.ts` | Widen `AgentMessage` (toolResults, typed toolCalls), `AgentRun.tokenUsage` (cached), `SSEEventType` payloads |
| `ui/src/components/InternalAgentPanel.tsx` | Neutral bubble + hover timestamp; expandable tool activity rows; consume tool input/result/duration; map toolCalls on reload |
| `ui/src/components/settings/sections/CommanderSection.tsx` | "Est. Cost" relabel + Tokens column |
| `docs/architecture/decisions.md`, `docs/architecture/design-system.md` | Record the chat-bubble + cost-estimate decision |
| tests | **unit:** `parse-stream-json.test.ts`, `internal-agent-run-persist.test.ts` · **fixture:** `fake-claude.mjs` · **component:** `InternalAgentPanel.toolCalls.test.tsx`, `InternalAgentPanel.timestamp.test.tsx`, `RunHistoryTabContent.test.tsx` · **e2e (Playwright, fake-claude harness):** `commander-transparency.spec.ts` (new) + `commander-viewer.spec.ts` (de-stale) |

### Verification baseline (run once before starting)

- [ ] **Step 0: Confirm clean baseline.**
  Run (from the AoA-commander worktree root):
  `cd ui && pnpm tsc -b && pnpm vitest run` then `cd ../server && pnpm vitest run`
  Expected: green (note any pre-existing unrelated failures — MemoryExplorer / ThreadsWorkspace×2 / ThreadDetail are known-unrelated per prior sessions). Live app is at `http://127.0.0.1:3201/PIN/commander`.

---

## Phase 1 — Real run summary end-to-end (backend foundation)

Fixes the double-`done`, extracts real usage/cost/duration for **both** providers, and persists it. Unblocks Phase 2 (Settings cost/tokens) and Phase 3 (chat duration).

### Task 1.1: Widen `RunSummary` to carry cached tokens + model/provider

**Files:**
- Modify: `server/src/services/internal-agent/agent-loop.ts:27-33`

- [ ] **Step 1: Edit the type.** Replace the `RunSummary` interface:

```ts
interface RunSummary {
  runId: string;
  toolsCalled: string[];
  durationMs: number;
  costCents: number;
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  /** Model/provider actually used, when the adapter reports it (cost estimate input). */
  model?: string | null;
  provider?: string | null;
}
```

- [ ] **Step 2: Typecheck.** Run: `cd server && pnpm tsc -b`
  Expected: PASS (zeros in cli-mode/parse still satisfy the optional fields).

- [ ] **Step 3: Commit.**
```bash
git add server/src/services/internal-agent/agent-loop.ts
git commit -m "refactor(commander): widen RunSummary for cached tokens + model/provider"
```

### Task 1.2: Claude — extract real usage/cost/duration in `handleResultEvent` (TDD)

**Files:**
- Modify: `server/src/services/internal-agent/parse-stream-json.ts:296-315`
- Test: `server/src/__tests__/parse-stream-json.test.ts`

- [ ] **Step 1: Write the failing test.** Append to `parse-stream-json.test.ts`. **Do NOT re-import `StreamJsonParser`** — the file already imports it at line 13 (a duplicate import is a TS2300 compile error). Append only the `describe` blocks:

```ts
describe("handleResultEvent extracts real usage + cost", () => {
  it("maps total_cost_usd + usage into the done summary", () => {
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 1234,
      total_cost_usd: 0.0321,
      usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
    });
    const chunks = parser.push(line + "\n");
    const done = chunks.find((c) => c.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") throw new Error("no done");
    expect(done.summary.durationMs).toBe(1234);
    expect(done.summary.tokenUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cachedInputTokens: 800,
    });
    // 0.0321 USD -> 3.21 cents -> rounded 3
    expect(done.summary.costCents).toBe(3);
  });

  it("yields zero cost when total_cost_usd is 0 (subscription) but keeps real tokens", () => {
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      type: "result",
      duration_ms: 60,
      total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const done = parser.push(line + "\n").find((c) => c.type === "done");
    if (done?.type !== "done") throw new Error("no done");
    expect(done.summary.costCents).toBe(0);
    expect(done.summary.tokenUsage.inputTokens).toBe(10);
    expect(done.summary.tokenUsage.outputTokens).toBe(5);
  });

  // REVIEW FIX (Lens B): pin the guard — a stream WITH a result event must
  // produce EXACTLY ONE done carrying the real numbers (no double-done).
  it("emits exactly one done with real numbers when a result event is present", () => {
    const parser = new StreamJsonParser();
    const out = [
      ...parser.push(
        JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }) + "\n",
      ),
      ...parser.push(
        JSON.stringify({ type: "result", duration_ms: 5, total_cost_usd: 0.01, usage: { input_tokens: 9, output_tokens: 4 } }) + "\n",
      ),
      ...parser.flush(),
    ];
    const dones = out.filter((c) => c.type === "done");
    expect(dones).toHaveLength(1);
    if (dones[0]?.type !== "done") throw new Error("no done");
    expect(dones[0].summary.tokenUsage.inputTokens).toBe(9);
    expect(dones[0].summary.costCents).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — verify it fails.** Run: `cd server && pnpm vitest run parse-stream-json`
  Expected: FAIL (durationMs ok but tokenUsage zeros / costCents 0 on the first test).

- [ ] **Step 3: Implement.** Replace `handleResultEvent` (`parse-stream-json.ts:296-315`):

```ts
// ── result event ───────────────────────────────────────────────────────────────

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function handleResultEvent(event: Record<string, unknown>): AgentStreamChunk[] {
  const usageObj =
    typeof event.usage === "object" && event.usage !== null
      ? (event.usage as Record<string, unknown>)
      : {};
  const inputTokens = asNum(usageObj.input_tokens);
  const outputTokens = asNum(usageObj.output_tokens);
  const cachedInputTokens = asNum(usageObj.cache_read_input_tokens);

  // Subscription CLI runs report total_cost_usd:0 — that's correct/intentional.
  // We forward it verbatim; the route falls back to a token-based estimate when 0.
  const costUsd = asNum(event.total_cost_usd);
  const costCents = costUsd > 0 ? Math.round(costUsd * 100) : 0;

  return [
    {
      type: "done",
      summary: {
        runId: "",
        toolsCalled: [],
        durationMs: asNum(event.duration_ms),
        costCents,
        tokenUsage: { inputTokens, outputTokens, cachedInputTokens },
      },
    },
  ];
}
```

- [ ] **Step 4: Run it — verify it passes.** Run: `cd server && pnpm vitest run parse-stream-json`
  Expected: PASS (all tests, including the existing thinking-skip tests which are untouched).

- [ ] **Step 5: Commit.**
```bash
git add server/src/services/internal-agent/parse-stream-json.ts server/src/__tests__/parse-stream-json.test.ts
git commit -m "feat(commander): extract real usage+cost+duration from claude result event"
```

### Task 1.3: Guard the trailing zero-`done` (both providers) + Codex real-usage done

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (codex done ~577-586, claude done ~733-743, `runCodexTurn` ~973-983)

- [ ] **Step 1: Track whether a real done was seen.** In the `chat()` generator (the `async *chat(...)` method), find the `try {` that wraps the streaming branches. Immediately inside it add:

```ts
let sawRealDone = false;
```

- [ ] **Step 2: Mark the flag in every streaming loop.** There are three `for await (const chunk of ...) { ... yield chunk; }` loops in the Claude/Codex branches (`cli-mode.ts` ~571-574 codex, ~695-698 first-message claude, ~719-722 subsequent claude). In each, add the flag set alongside the existing text accumulation. Example (do this in all three):

```ts
for await (const chunk of streamProcessOutput(cliProcess, useStreamJson)) {
  if (chunk.type === "text") accumulatedText += chunk.delta;
  if (chunk.type === "done") sawRealDone = true;
  yield chunk;
}
```

and the codex loop:

```ts
for await (const chunk of runCodexTurn({ /* unchanged args */ })) {
  if (chunk.type === "text") accumulatedText += chunk.delta;
  if (chunk.type === "done") sawRealDone = true;
  yield chunk;
}
```

- [ ] **Step 3: Guard the Codex trailing done.** Replace the codex done block (`cli-mode.ts:577-586`) with:

```ts
          // Fallback only — runCodexTurn now emits a real-usage done.
          if (!sawRealDone) {
            yield {
              type: "done",
              summary: {
                runId: "",
                toolsCalled: [],
                durationMs: 0,
                costCents: 0,
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
              },
            };
          }
          return;
```

- [ ] **Step 4: Guard the Claude trailing done.** Replace the claude done block (`cli-mode.ts:733-743`) with:

```ts
        // Fallback only — handleResultEvent emits the real done from the
        // stream-json `result` event. This covers the plain-text MCP-tool turn
        // (no result event) so the route always sees exactly one done.
        if (!sawRealDone) {
          yield {
            type: "done",
            summary: {
              runId: "",
              toolsCalled: [],
              durationMs: 0,
              costCents: 0,
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
            },
          };
        }
```

- [ ] **Step 5: Codex `runCodexTurn` emits a real-usage done.** At the end of `runCodexTurn` (`cli-mode.ts`, after the `if (parsed.summary) { yield { type: "text", delta: parsed.summary }; }` at ~980-982), append:

```ts
  // Real-usage done (cost left 0 — codex subscription has no per-run billing;
  // the route estimates from tokens via computeCostCents).
  yield {
    type: "done",
    summary: {
      runId: "",
      toolsCalled: [],
      durationMs: 0,
      costCents: 0,
      tokenUsage: {
        inputTokens: parsed.usage?.inputTokens ?? 0,
        outputTokens: parsed.usage?.outputTokens ?? 0,
        cachedInputTokens: parsed.usage?.cachedInputTokens ?? 0,
      },
    },
  };
```

- [ ] **Step 6: Typecheck + existing suite.** Run: `cd server && pnpm tsc -b && pnpm vitest run cli-mode` (or the nearest cli-mode test file; if none, run the full `pnpm vitest run` and confirm no regressions).
  Expected: PASS.

- [ ] **Step 7: Commit.**
```bash
git add server/src/services/internal-agent/cli-mode.ts
git commit -m "fix(commander): stop trailing zero-done from clobbering the real run summary"
```

### Task 1.4: Route — capture provider+model and persist real tokens + est. cost + wall-clock duration (TDD)

**Files:**
- Modify: `server/src/routes/internal-agent.ts:154-318`
- Test: `server/src/__tests__/internal-agent-run-persist.test.ts` (new — contract test, no drizzle internals)

The route already selects `enabledCapabilities` from `internal_agent_config` (`internal-agent.ts:216-219`). Extend that select to also read `model`/`provider`, capture them on the run insert, time the turn, and compute cost via the runner blueprint.

- [ ] **Step 1: Write a pure-helper test for the cost choice.** Because the route mixes drizzle, extract the cost decision into a tiny pure function and test that. Create `server/src/services/internal-agent/run-cost.ts`:

```ts
import { computeCostCents } from "./cost-model.js";

/**
 * Cost for a finished Commander run, in cents.
 * Prefer the adapter-reported cost (already real cents). Subscription CLI
 * reports 0 — fall back to a token × list-price ESTIMATE. Never a real bill.
 */
export function resolveRunCostCents(input: {
  reportedCostCents: number;
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
}): number {
  if (input.reportedCostCents > 0) return input.reportedCostCents;
  return computeCostCents(
    input.provider ?? "anthropic",
    input.model ?? "claude-sonnet-4-6",
    input.inputTokens,
    input.outputTokens,
  );
}

/**
 * REVIEW FIX (Lens C): the estimate's rate model must reflect the ACTIVE CLI
 * tool, not internal_agent_config.model (a dormant legacy API-mode column that
 * defaults to claude-sonnet-4-6 regardless of the CLI in use — so a codex run
 * would otherwise be priced at Claude rates). For claude_cli we honour an
 * explicitly-configured model; otherwise we use a representative model per tool.
 * It is a labelled estimate, not a bill.
 */
export function rateModelForCliTool(
  cliTool: string | null,
  configModel: string | null,
): { provider: string; model: string } {
  switch (cliTool) {
    case "codex":
      return { provider: "openai", model: "gpt-4.1" };
    case "claude_cli":
    default:
      return { provider: "anthropic", model: configModel ?? "claude-sonnet-4-6" };
  }
}
```

Create `server/src/__tests__/internal-agent-run-persist.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveRunCostCents, rateModelForCliTool } from "../services/internal-agent/run-cost.js";

describe("rateModelForCliTool", () => {
  it("prices claude_cli at the configured claude model (or sonnet default)", () => {
    expect(rateModelForCliTool("claude_cli", null)).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(rateModelForCliTool("claude_cli", "claude-opus-4-6")).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });
  it("prices codex at a GPT model, NOT claude rates", () => {
    expect(rateModelForCliTool("codex", "claude-sonnet-4-6")).toEqual({ provider: "openai", model: "gpt-4.1" });
  });
});

describe("resolveRunCostCents", () => {
  it("prefers the adapter-reported cost when > 0", () => {
    expect(
      resolveRunCostCents({ reportedCostCents: 7, provider: "anthropic", model: "claude-opus-4-6", inputTokens: 100, outputTokens: 100 }),
    ).toBe(7);
  });
  it("estimates from tokens when reported cost is 0 (subscription)", () => {
    // sonnet: 300 in/M, 1500 out/M; 1M in + 1M out = 300 + 1500 = 1800 cents
    expect(
      resolveRunCostCents({ reportedCostCents: 0, provider: "anthropic", model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(1800);
  });
  it("falls back to a default model rate when model is null", () => {
    expect(
      resolveRunCostCents({ reportedCostCents: 0, provider: null, model: null, inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(300);
  });
});
```

- [ ] **Step 2: Run it — verify it fails.** Run: `cd server && pnpm vitest run internal-agent-run-persist`
  Expected: FAIL ("Cannot find module ./run-cost.js").

- [ ] **Step 3: Implement `run-cost.ts`** (the code in Step 1) and run again.
  Expected: PASS.

- [ ] **Step 4: Wire the route.** In `internal-agent.ts`:

  (a) Extend the config select (`~216-219`) to capture model/provider:
```ts
        const cfgRows = await db
          .select({
            enabledCapabilities: internalAgentConfig.enabledCapabilities,
            model: internalAgentConfig.model,
            cliTool: internalAgentConfig.cliTool,
          })
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, companyId));
        const enabledCapabilities = (cfgRows[0]?.enabledCapabilities as string[] | null) ?? [];
        // REVIEW FIX (Lens C): price by the ACTIVE cli tool, not the dormant
        // config.model column (which defaults to sonnet for every company).
        const effectiveCliTool = cfgRows[0]?.cliTool ?? "claude_cli";
        const { provider: runProvider, model: runModel } = rateModelForCliTool(
          effectiveCliTool,
          cfgRows[0]?.model ?? null,
        );
```
  Note: this select runs **after** the run insert today (insert is at 158-167, config select at 216-219). Move the config select **above** the insert so model/provider are available at insert time, OR set them on the completion `UPDATE` instead. Simplest: set them on the UPDATE (Step 4d) — no reordering needed. Keep the insert as-is.

  (b) Widen `finalSummary`'s type (`~174-182`) to include cached tokens:
```ts
      let finalSummary:
        | {
            runId: string;
            toolsCalled: string[];
            durationMs: number;
            costCents: number;
            tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
          }
        | null = null;
```

  (c) Time the turn — add right before `res.write("event: thinking...")` (`~169`):
```ts
      const runStartedAt = Date.now();
```

  (d) Replace the completion UPDATE (`~298-307`) with the real-number persist:
```ts
        const tokenUsage = finalSummary?.tokenUsage ?? null;
        const reportedCostCents = finalSummary?.costCents ?? 0;
        const wallClockMs = Date.now() - runStartedAt;
        const durationMs =
          finalSummary && finalSummary.durationMs > 0 ? finalSummary.durationMs : wallClockMs;
        const costCents = tokenUsage
          ? resolveRunCostCents({
              reportedCostCents,
              provider: runProvider,
              model: runModel,
              inputTokens: tokenUsage.inputTokens,
              outputTokens: tokenUsage.outputTokens,
            })
          : reportedCostCents;

        await db
          .update(internalAgentRuns)
          .set({
            status: "completed",
            completedAt: new Date(),
            durationMs,
            costCents,
            tokenUsage,
            model: runModel,
            provider: runProvider,
          })
          .where(eq(internalAgentRuns.id, run.id));
```

  (e) Add the import at the top of the file:
```ts
import { resolveRunCostCents, rateModelForCliTool } from "../services/internal-agent/run-cost.js";
```

  (f) Add `durationMs` to the done SSE payload (`~311-317`) — Phase 3 consumes it for "Worked for Xs":
```ts
        res.write(
          `event: done\ndata: ${JSON.stringify({
            messageId: run.id,
            runId: run.id,
            durationMs,
            tokenUsage: finalSummary?.tokenUsage ?? { inputTokens: 0, outputTokens: 0 },
            costCents: finalSummary?.costCents ?? 0,
          })}\n\n`,
        );
```

- [ ] **Step 5: Typecheck + suite.** Run: `cd server && pnpm tsc -b && pnpm vitest run internal-agent-run-persist`
  Expected: PASS. Then `pnpm vitest run` — no regressions.

- [ ] **Step 6: Commit.**
```bash
git add server/src/routes/internal-agent.ts server/src/services/internal-agent/run-cost.ts server/src/__tests__/internal-agent-run-persist.test.ts
git commit -m "feat(commander): persist real tokens + estimated cost + duration per run"
```

### Task 1.5: Make the fake-claude e2e fixture emit nonzero usage

**Files:**
- Modify: `tests/e2e/fixtures/fake-claude/fake-claude.mjs:169-180`

- [ ] **Step 1: Edit the result event** so e2e exercises real numbers (keep cost 0 to model subscription, set real tokens):

```js
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 60,
    duration_api_ms: 50,
    num_turns: 1,
    result: text,
    session_id: "fake-claude-session",
    total_cost_usd: 0,
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
  });
```

- [ ] **Step 2: Commit.**
```bash
git add tests/e2e/fixtures/fake-claude/fake-claude.mjs
git commit -m "test(commander): fake-claude emits realistic token usage"
```

---

## Phase 2 — Settings → Run History shows tokens + Est. cost (frontend)

Depends on Phase 1. Cost auto-populates via the existing `formatCents(run.costCents)`; we relabel it "Est. Cost" and add a Tokens column.

### Task 2.1: Widen client run types for cached tokens

**Files:**
- Modify: `ui/src/api/internal-agent.ts:65-79`

- [ ] **Step 1: Edit `AgentRun.tokenUsage`:**
```ts
  tokenUsage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
```

- [ ] **Step 2: Typecheck.** Run: `cd ui && pnpm tsc -b`
  Expected: PASS.

- [ ] **Step 3: Commit.**
```bash
git add ui/src/api/internal-agent.ts
git commit -m "refactor(commander): client AgentRun.tokenUsage carries cached tokens"
```

### Task 2.2: Add a Tokens column + relabel Cost → "Est. Cost"

**Files:**
- Modify: `ui/src/components/settings/sections/CommanderSection.tsx:1150-1248`

- [ ] **Step 1: Widen the `allRuns` prop type** (`RunHistoryTabContentProps.allRuns`, ~1151-1158) to carry tokens:
```ts
  allRuns: Array<{
    id: string;
    triggerType: string;
    status: string;
    costCents: number;
    durationMs: number;
    createdAt: string;
    tokenUsage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
  }>;
```

- [ ] **Step 2: (No code change — verified by review.)** `allRuns` at `CommanderSection.tsx:313` is `const allRuns = runsPages?.pages.flatMap((p) => p.runs) ?? []` — it passes whole `AgentRun` objects straight through; there is no per-field mapped object literal to edit. Since `AgentRun.tokenUsage` is already on the wire (Task 2.1) and the prop type is widened (Step 1), `allRuns` structurally carries `tokenUsage`. Nothing to change here.

- [ ] **Step 3: Relabel the aggregate + headers; KEEP the existing Trigger column.** The table currently has 5 columns (Trigger, Status, Cost, Duration, Date); we go to 6 by adding Tokens. Rename "Total Cost" (~1182) → "Est. Cost"; in the header row keep `<th>Trigger</th>` (~1208), rename "Cost" (~1210) → "Est. Cost", and insert a "Tokens" header after it. The header row becomes:
```tsx
                <th className="pb-2 font-medium">Trigger</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Est. Cost</th>
                <th className="pb-2 font-medium">Tokens</th>
                <th className="pb-2 font-medium">Duration</th>
                <th className="pb-2 font-medium">Date</th>
```
and the aggregate tile (~1181-1186):
```tsx
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Est. Cost</p>
            <p className="text-lg font-semibold">{formatCents(runsAggregates.totalCostCents)}</p>
          </div>
```

- [ ] **Step 4: Render the Tokens cell.** After the cost `<td>` (~1232) add the cell below. Add `formatTokens` to the EXISTING `@/lib/utils` import at `CommanderSection.tsx:19` (`import { formatCents, budgetProgressColor, relativeTime } from "@/lib/utils";`) — NOT a new relative-path import:
```tsx
                  <td className="py-2">{formatCents(run.costCents)}</td>
                  <td className="py-2 text-muted-foreground">
                    {run.tokenUsage
                      ? `${formatTokens(run.tokenUsage.inputTokens)} / ${formatTokens(run.tokenUsage.outputTokens)}`
                      : "—"}
                  </td>
```

- [ ] **Step 5: Add a one-line caption clarifying the estimate.** Above the table (after the aggregates grid, ~1200) add:
```tsx
      <p className="text-xs text-muted-foreground">
        Cost is an estimate at list prices. CLI subscription runs have no per-call charge.
      </p>
```

- [ ] **Step 6: Typecheck + tests.** Run: `cd ui && pnpm tsc -b && pnpm vitest run CommanderSection`
  Expected: PASS (update any CommanderSection test asserting the old "Cost" header / column count).

- [ ] **Step 7: Commit.**
```bash
git add ui/src/components/settings/sections/CommanderSection.tsx
git commit -m "feat(commander): Run History shows tokens + Est. cost"
```

---

## Phase 3 — Inline tool transparency (backend forward + frontend render)

Depends on Phase 1 (duration). Forwards tool `input` + `success` + a truncated summary over SSE, persists tool activity, and renders an expandable activity list with a status glyph. Reuses the existing `OutputRefChips`.

### Task 3.1: Forward tool input + result + duration over SSE

**Files:**
- Modify: `server/src/routes/internal-agent.ts:243-256`

- [ ] **Step 1: Create a shared summary helper** (used by both the route and agent-loop — DRY). Create `server/src/services/internal-agent/tool-summary.ts`:
```ts
export const TOOL_SUMMARY_CAP = 600;

export function truncateForWire(s: unknown): string {
  const text = typeof s === "string" ? s : JSON.stringify(s ?? "");
  return text.length > TOOL_SUMMARY_CAP ? text.slice(0, TOOL_SUMMARY_CAP) + "…" : text;
}

/**
 * For MCP tools the parser sets result.summary to the FULL envelope JSON string.
 * Prefer the envelope's human `summary` field so the expandable activity view
 * shows readable text, not raw JSON. Built-in tool output is not an envelope →
 * passed through verbatim (still truncated; always rendered as escaped plaintext).
 */
export function humanToolSummary(name: string, raw: unknown): string {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  if (name.startsWith("mcp__")) {
    try {
      const env = JSON.parse(text) as { summary?: unknown };
      if (typeof env.summary === "string" && env.summary.length > 0) {
        return truncateForWire(env.summary);
      }
    } catch {
      /* not an envelope — fall through to raw */
    }
  }
  return truncateForWire(text);
}
```
Import it in the route: `import { humanToolSummary } from "../services/internal-agent/tool-summary.js";`

- [ ] **Step 2: Forward name on tool_call** (`~243-246`). REVIEW FIX (Lens A/B/C): do NOT forward `input` — it is unbounded (built-in Bash/Read/create_artifact args can be huge), it's never displayed by the render (Task 3.5 shows the label + result summary, not input), and it would bloat the persisted jsonb. Keep the payload to `name`:
```ts
            case "tool_call":
              res.write(
                `event: tool_call\ndata: ${JSON.stringify({ name: chunk.name })}\n\n`,
              );
              break;
```

- [ ] **Step 3: Forward success + human summary on tool_result** (`~248-256`):
```ts
            case "tool_result":
              res.write(
                `event: tool_result\ndata: ${JSON.stringify({
                  name: chunk.name,
                  success: chunk.result?.success ?? true,
                  summary: humanToolSummary(chunk.name, chunk.result?.summary ?? chunk.result?.data),
                  ...(chunk.refs && chunk.refs.length > 0 ? { refs: chunk.refs } : {}),
                })}\n\n`,
              );
              break;
```

- [ ] **Step 4: Typecheck.** Run: `cd server && pnpm tsc -b`
  Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add server/src/routes/internal-agent.ts
git commit -m "feat(commander): forward tool input, success, summary + duration over SSE"
```

### Task 3.2: Persist tool activity on the assistant turn

**Files:**
- Modify: `server/src/services/internal-agent/agent-loop.ts:291-311`

- [ ] **Step 1: Add the import** at the top of `agent-loop.ts`: `import { humanToolSummary } from "./tool-summary.js";`

- [ ] **Step 2: Accumulate ONE enriched toolCalls array** in the streaming loop (`~291-297`). REVIEW FIX (Lens C): match each `tool_result` to the first not-yet-resolved call with the same name — mirrors the live first-running-by-name render so reload maps 1:1 with no index drift. Input is intentionally not persisted (unbounded + unused by the render):
```ts
        let accumulatedAssistant = "";
        const turnRefs: CommanderOutputRef[] = [];
        const turnToolCalls: Array<{ name: string; success?: boolean; summary?: string }> = [];
        for await (const chunk of cliService.chat(cliParams, effectiveConfig)) {
          if (chunk.type === "text") accumulatedAssistant += chunk.delta;
          if (chunk.type === "tool_call") {
            turnToolCalls.push({ name: chunk.name });
          }
          if (chunk.type === "tool_result") {
            const enriched = {
              success: chunk.result?.success ?? true,
              summary: humanToolSummary(chunk.name, chunk.result?.summary ?? chunk.result?.data),
            };
            const match = turnToolCalls.find((c) => c.name === chunk.name && c.success === undefined);
            if (match) Object.assign(match, enriched);
            else turnToolCalls.push({ name: chunk.name, ...enriched });
          }
          collectChunkRefs(turnRefs, chunk);
          yield chunk;
        }
```

- [ ] **Step 3: Persist the enriched toolCalls** in the `appendMessage` call (`~305-310`):
```ts
          const outputRefs = turnRefs.length > 0 ? mergeOutputRefs([], turnRefs) : undefined;
          await convService.appendMessage(conversation.id, {
            role: "assistant",
            content: accumulatedAssistant,
            ...(outputRefs ? { outputRefs } : {}),
            ...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
          });
```

- [ ] **Step 4: Typecheck.** Run: `cd server && pnpm tsc -b`
  Expected: PASS (`MessageInput.toolCalls` is typed `unknown` at `conversation.ts:13`, so the enriched array satisfies it; persisted at `conversation.ts:70`).

- [ ] **Step 4: Commit.**
```bash
git add server/src/services/internal-agent/agent-loop.ts
git commit -m "feat(commander): persist tool calls + results on the assistant turn"
```

### Task 3.3: Client types for tool activity + new SSE payload fields

**Files:**
- Modify: `ui/src/api/internal-agent.ts:23-31`

- [ ] **Step 1: Type the persisted message tool fields.** Replace the `AgentMessage` interface. NOTE: the enriched `toolCalls` already carries `success`/`summary`, so there is NO separate `toolResults` on the client type — which keeps the existing `InternalAgentPanel.outputRefs.test.tsx` literal (toolCalls: null, no toolResults) compiling unchanged:
```ts
export interface AgentMessageToolCall { name: string; success?: boolean; summary?: string }

export interface AgentMessage {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  content: string | null;
  toolCalls: AgentMessageToolCall[] | null;
  outputRefs: CommanderOutputRef[] | null;
  pageContext: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Typecheck.** Run: `cd ui && pnpm tsc -b`
  Expected: PASS. (Component tests placed directly under `src/components/**` ARE type-checked by `tsc -b`; tests under `src/__tests__/` are NOT — so the new test literals in Tasks 3.4/5.1/5.2 must match this exact `AgentMessage` shape, which they do.)

- [ ] **Step 3: Commit.**
```bash
git add ui/src/api/internal-agent.ts
git commit -m "refactor(commander): type AgentMessage tool calls/results"
```

### Task 3.4: Widen `ToolCallEntry` + capture stream fields + map on reload (TDD)

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx:229-233, 258-267, 739-836`
- Test: `ui/src/components/InternalAgentPanel.toolCalls.test.tsx` (new)

- [ ] **Step 1: Widen `ToolCallEntry`** (`~229-233`):
```ts
export interface ToolCallEntry {
  id: number;
  name: string;
  status: "running" | "done";
  success?: boolean;
  summary?: string;
  open?: boolean;
}
```

- [ ] **Step 2: Map persisted toolCalls on reload.** Update `serverToLocal` (`~258-267`) to map the enriched `{name,success?,summary?}` array 1:1 into `ToolCallEntry[]` (status `done`):
```ts
function serverToLocal(m: AgentMessage): LocalMessage {
  const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
  const toolCalls: ToolCallEntry[] | undefined =
    calls.length > 0
      ? calls.map((c, i) => ({
          id: i,
          name: c.name,
          status: "done" as const,
          ...(c.success !== undefined ? { success: c.success } : {}),
          ...(c.summary !== undefined ? { summary: c.summary } : {}),
        }))
      : undefined;
  return {
    id: m.id,
    role: m.role === "tool" ? "system" : m.role,
    content: m.content ?? "",
    streamingDone: true,
    outputRefs: (m.outputRefs ?? undefined) as CommanderOutputRef[] | undefined,
    ...(toolCalls ? { toolCalls } : {}),
    createdAt: m.createdAt,
  };
}
```

- [ ] **Step 3: Write the failing reload test.** Create `ui/src/components/InternalAgentPanel.toolCalls.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "done",
  toolCalls: [{ name: "create_task", success: true, summary: "Created task X" }],
  outputRefs: null,
  pageContext: null,
  createdAt: "2026-06-16T00:00:00Z",
};

describe("tool activity survives server→local mapping", () => {
  it("maps persisted toolCalls+toolResults into done ToolCallEntry", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.toolCalls).toHaveLength(1);
    expect(merged[0]!.toolCalls![0]).toMatchObject({
      name: "create_task",
      status: "done",
      success: true,
      summary: "Created task X",
    });
  });
});
```

- [ ] **Step 4: Run it.** Run: `cd ui && pnpm vitest run InternalAgentPanel.toolCalls`
  Expected: PASS (Step 2 implements it).

- [ ] **Step 5: Capture stream fields in `handleSSEEvent`.** `tool_call` (`~739-749`) is unchanged (name only — no input):
```ts
      case "tool_call": {
        const name = (event.data as { name?: string }).name ?? "unknown";
        const callId = ++toolCallIdRef.current;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, toolCalls: [...(m.toolCalls ?? []), { id: callId, name, status: "running" }] }
              : m,
          ),
        );
        break;
      }
```
  In `tool_result` (`~752-768`) set success + summary when flipping to done:
```ts
            const data = event.data as { name?: string; success?: boolean; summary?: string };
            const toolName = data.name;
            let found = false;
            const updated = (m.toolCalls ?? []).map((tc) => {
              if (!found && tc.name === toolName && tc.status === "running") {
                found = true;
                return { ...tc, status: "done" as const, success: data.success ?? true, summary: data.summary };
              }
              return tc;
            });
```
  In `done` (`~833-835`) stamp duration onto the message (add a `durationMs?: number` field to `LocalMessage` at `~235-256`):
```ts
      case "done": {
        const durationMs = (event.data as { durationMs?: number }).durationMs;
        setMessages((prev) =>
          settleRunningToolCalls(prev, assistantId).map((m) =>
            m.id === assistantId && typeof durationMs === "number" ? { ...m, durationMs } : m,
          ),
        );
        break;
      }
```

- [ ] **Step 6: Typecheck + tests.** Run: `cd ui && pnpm tsc -b && pnpm vitest run InternalAgentPanel`
  Expected: PASS.

- [ ] **Step 7: Commit.**
```bash
git add ui/src/components/InternalAgentPanel.tsx ui/src/components/InternalAgentPanel.toolCalls.test.tsx
git commit -m "feat(commander): capture+persist tool input/result/duration in chat state"
```

### Task 3.5: Render the inline expandable activity list + "Worked for Xs"

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx:1173-1187` (tool render), imports (`~35-40`)

- [ ] **Step 1: Fix the icon imports.** Add `AlertCircle` and `ChevronRight` to the `lucide-react` import (the file already has `Loader2`, `Copy`, `Check`, `ExternalLink`). REVIEW FIX (Lens B/C): **remove `Wrench`** from the import — the new render no longer uses it (it was used only in the flat row being replaced), so leaving it is a dead import.

- [ ] **Step 2: Replace the flat tool render** (`~1173-1187`) with an expandable list + status glyph:
```tsx
              {/* Tool activity — inline, expandable, with status glyph */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div className="space-y-1 mb-2">
                  {msg.toolCalls.map((tc) => (
                    <div key={tc.id} className="text-xs">
                      <button
                        type="button"
                        data-testid={`commander-tool-activity-${tc.id}`}
                        disabled={!tc.summary}
                        onClick={() =>
                          setMessages((prev) =>
                            prev.map((m) =>
                              m.id === msg.id
                                ? { ...m, toolCalls: (m.toolCalls ?? []).map((t) => (t.id === tc.id ? { ...t, open: !t.open } : t)) }
                                : m,
                            ),
                          )
                        }
                        className="flex w-full items-center gap-1.5 text-left text-muted-foreground hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
                      >
                        {tc.status === "running" ? (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                        ) : tc.success === false ? (
                          <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                        ) : (
                          <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                        )}
                        <span className="truncate">
                          {tc.status === "running" ? toolLabel(tc.name) : completedToolLabel(tc.name)}
                        </span>
                        {tc.summary && (
                          <ChevronRight className={cn("h-3 w-3 shrink-0 transition-transform", tc.open && "rotate-90")} />
                        )}
                      </button>
                      {tc.open && tc.summary && (
                        <pre
                          data-testid="commander-tool-summary"
                          className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[11px] text-muted-foreground"
                        >
                          {tc.summary}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
```
  Note: `tc.summary` is rendered inside `<pre>` as **plain text** (React escapes it) — no `dangerouslySetInnerHTML`, no `rehype-raw`. Safe.

- [ ] **Step 3: Add the "Worked for Xs" cap** after the message content block (after the `OutputRefChips` block, ~1216), assistant only. REVIEW FIX (Lens B): `durationMs` is stamped from the live `done` SSE event only; it is NOT persisted on `internal_agent_messages` (it lives on `internal_agent_runs`, which `serverToLocal` does not read). So this caption is a **live-only affordance** — it shows during/just after the turn and is intentionally absent after a reload (the tool-activity rows persist; the duration does not). This is by design for Plan 1 (persisting per-message duration would need a schema migration, which is out of scope). Keep the comment below so a future maintainer doesn't "fix" it by accident:
```tsx
              {/* Live-only: durationMs comes from the done SSE event, not persisted
                  (it's on internal_agent_runs). Absent after reload by design. */}
              {msg.role === "assistant" && msg.streamingDone && typeof msg.durationMs === "number" && msg.durationMs > 0 && (
                <p data-testid="commander-worked-for" className="mt-1 text-[10px] text-muted-foreground">
                  Worked for {(msg.durationMs / 1000).toFixed(1)}s
                </p>
              )}
```

- [ ] **Step 4: Typecheck + tests + lint.** Run: `cd ui && pnpm tsc -b && pnpm vitest run InternalAgentPanel`
  Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): inline expandable tool activity + worked-for duration"
```

---

## Phase 4 — Neutral bubble + hover timestamp + decision record (frontend, independent)

### Task 4.1: Neutral user bubble (match the workspace)

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx:1125-1131, 1140-1151`

- [ ] **Step 1: Change the bubble ternary** (`~1125-1131`):
```tsx
            <div
              className={cn(
                "group relative max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                msg.role === "user"
                  ? "bg-card text-card-foreground shadow-sm"
                  : "bg-muted",
              )}
            >
```

- [ ] **Step 2: Remove the user-only copy-icon override** (`~1145`) — delete this line so the copy icon falls through to the neutral `text-muted-foreground hover:text-foreground`:
```tsx
                    msg.role === "user" && "text-primary-foreground/60 hover:text-primary-foreground",
```

- [ ] **Step 3: Live-verify.** Reload `http://127.0.0.1:3201/PIN/commander`, send a message. The user bubble should be a neutral card surface (not brand red), rounded-2xl, with white-on-red gone. Screenshot for the report.

- [ ] **Step 4: Commit.**
```bash
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): neutral user bubble matching the workspace thread"
```

### Task 4.2: Hover relative-timestamp

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx` (import `~38`, bubble `~1133-1171`)

- [ ] **Step 1: Import `relativeTime`.** Update the `../lib/utils` import (`~38`) from `import { cn } from "../lib/utils";` to:
```ts
import { cn, relativeTime } from "../lib/utils";
```

- [ ] **Step 2: Add a hover-revealed timestamp** inside the `group relative` bubble (place after the ExternalLink button block, ~1171), bottom-right so it clears the top-right icon cluster:
```tsx
              <span
                className={cn(
                  "pointer-events-none absolute bottom-1 right-2 text-[10px] text-muted-foreground",
                  "opacity-0 group-hover:opacity-100 transition-opacity",
                )}
              >
                {relativeTime(msg.createdAt)}
              </span>
```

- [ ] **Step 3: Live-verify.** Hover a message — the relative time ("just now" / "Nm ago") fades in bottom-right, no overlap with Copy/ExternalLink. Confirm 0 console errors.

- [ ] **Step 4: Commit.**
```bash
git add ui/src/components/InternalAgentPanel.tsx
git commit -m "feat(commander): hover relative-timestamp on chat messages"
```

### Task 4.3: Record the decision

**Files:**
- Modify: `docs/architecture/decisions.md`, `docs/architecture/design-system.md`

- [ ] **Step 1: Add a decision** to `decisions.md` (next free number, e.g. #101). Text:
```markdown
## Decision #101 — Commander chat bubble + run-cost semantics (2026-06-16)

- The founder's own chat messages use a **neutral surface** (`bg-card`, `rounded-2xl`),
  NOT brand red (`bg-primary`). Brand red is reserved for primary CTAs; a filled
  brand-red bubble reads as an error. Actor is distinguished by alignment, not hue —
  mirroring the workspace timeline (`TimelineUserMessage.tsx`). Timestamps are
  hover-revealed (relative time), no avatars (1:1 chat).
- Commander **per-run cost is a list-price ESTIMATE**, always labeled "Est." CLI
  subscription runs report `total_cost_usd: 0` by design (see `cost-model.ts`); the
  estimate is `computeCostCents(model, tokens)`. Tokens are real. Cost is surfaced
  only in Settings → Run History, never in the chat. (Partially un-defers the
  per-run accounting deferral of Decision #91, for observability only.)
```

- [ ] **Step 2: Add a design-system entry** to `design-system.md` under the components/chat section: the Commander chat bubble token (neutral `bg-card` user bubble, `bg-muted` assistant, `rounded-2xl`, hover relative-timestamp, no avatars).

- [ ] **Step 3: Commit.**
```bash
git add docs/architecture/decisions.md docs/architecture/design-system.md
git commit -m "docs(commander): record chat-bubble + est-cost decision"
```

---

## Phase 5 — Automated tests & e2e user flows

Unit + component tests live inline in earlier phases (1.2 handleResultEvent, 1.4 resolveRunCostCents, 3.4 toolCalls mapping). This phase adds the **automated Playwright e2e user-flow specs** (driven through the real chat UI against fake-claude — same harness as `commander-viewer.spec.ts`), the **timestamp helper test**, and a **Settings component test**, and updates the now-stale assumption in the existing viewer spec.

### Task 5.1: Timestamp survives server→local mapping (unit)

**Files:**
- Create: `ui/src/components/InternalAgentPanel.timestamp.test.tsx`

- [ ] **Step 1: Write the test** (mirrors `InternalAgentPanel.outputRefs.test.tsx`):
```tsx
import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "hi",
  toolCalls: null,
  outputRefs: null,
  pageContext: null,
  createdAt: "2026-06-16T08:00:00Z",
};

describe("createdAt survives server→local mapping", () => {
  it("mergeServerMessagesWithTransientLocal carries createdAt", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.createdAt).toBe("2026-06-16T08:00:00Z");
  });
});
```

- [ ] **Step 2: Run it.** `cd ui && pnpm vitest run InternalAgentPanel.timestamp` → PASS.
- [ ] **Step 3: Commit.**
```bash
git add ui/src/components/InternalAgentPanel.timestamp.test.tsx
git commit -m "test(commander): createdAt survives message mapping (hover timestamp)"
```

### Task 5.2: Run History renders Tokens + Est. Cost (component)

**Files:**
- Modify: `ui/src/components/settings/sections/CommanderSection.tsx` (export `RunHistoryTabContent`)
- Create: `ui/src/components/settings/sections/RunHistoryTabContent.test.tsx`

- [ ] **Step 1: Export the subcomponent.** Change `function RunHistoryTabContent(` to `export function RunHistoryTabContent(` (~1165).

- [ ] **Step 2: Write the test:**
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunHistoryTabContent } from "./CommanderSection";

describe("RunHistoryTabContent", () => {
  const runs = [
    {
      id: "r1",
      triggerType: "conversation",
      status: "completed",
      costCents: 0,
      durationMs: 1500,
      createdAt: "2026-06-16T08:00:00Z",
      tokenUsage: { inputTokens: 1200, outputTokens: 340 },
    },
  ];

  it("shows an Est. Cost header and a real Tokens cell", () => {
    render(
      <RunHistoryTabContent
        allRuns={runs}
        runsAggregates={{ totalCostCents: 0, totalRuns: 1, avgDurationMs: 1500, failureRate: 0 }}
        hasNextPage={false}
        isFetchingNextPage={false}
        fetchNextPage={() => {}}
      />,
    );
    expect(screen.getAllByText("Est. Cost").length).toBeGreaterThan(0);
    expect(screen.getByText("1.2k / 340")).toBeInTheDocument();
  });

  it("renders an em-dash when tokenUsage is absent", () => {
    render(
      <RunHistoryTabContent
        allRuns={[{ ...runs[0], tokenUsage: undefined }]}
        runsAggregates={undefined}
        hasNextPage={false}
        isFetchingNextPage={false}
        fetchNextPage={() => {}}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```
  (Note `formatTokens(1200)` → `"1.2k"`, `formatTokens(340)` → `"340"`.)

- [ ] **Step 3: Run it.** `cd ui && pnpm vitest run RunHistoryTabContent` → PASS.
- [ ] **Step 4: Commit.**
```bash
git add ui/src/components/settings/sections/CommanderSection.tsx ui/src/components/settings/sections/RunHistoryTabContent.test.tsx
git commit -m "test(commander): Run History tokens + Est. cost rendering"
```

### Task 5.3: e2e — tool activity renders, expands, persists across reload, + "Worked for Xs"

**Files:**
- Create: `tests/e2e/commander-transparency.spec.ts`

This is the headline user-flow test. It uses the exact harness from `commander-viewer.spec.ts` (`seedCompany`, `writeFakeClaudeControl`, `createArtifactTurn`, the "Ask the agent..." composer, `waitForTurnEnd`). The key new assertion is **persistence across reload** — pre-change, tool indicators vanished on the post-turn sync; post-change they survive.

- [ ] **Step 1: Write the spec:**
```ts
import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { createArtifactTurn, writeFakeClaudeControl } from "./helpers/fake-claude";

const TITLE = "Launch Plan Q3";
const CONTENT = `# ${TITLE}\n\nPhase one.`;

async function seedArtifact(request: any, companyId: string) {
  const res = await request.post(`/api/companies/${companyId}/artifacts`, {
    data: { title: TITLE, type: "document", source: "founder", content: CONTENT },
  });
  const b = await res.json();
  return { id: b.id, versionId: b.versions?.[0]?.id ?? b.currentVersionId ?? null, title: TITLE };
}
async function sendMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}
async function waitForTurnEnd(page: Page) {
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });
}

test.describe("Commander tool transparency", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdXparency-/);
  });

  test("tool activity renders with a status glyph, expands, persists across reload, and shows duration", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-CmdXparency-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id);
    await page.goto(`/${company.issuePrefix}/commander`);

    writeFakeClaudeControl(createArtifactTurn(artifact, "Drafted and saved the plan."));
    await sendMessage(page, "Draft a launch plan for Q3");

    // Completed tool activity row renders (completedToolLabel for the mcp tool).
    await expect(page.getByText("Used mcp aoa create artifact")).toBeVisible({ timeout: 30_000 });
    // Expandable — click the activity row, the summary <pre> appears.
    await page.getByTestId("commander-tool-activity-1").click();
    await expect(page.getByTestId("commander-tool-summary")).toBeVisible({ timeout: 10_000 });

    await waitForTurnEnd(page);

    // "Worked for Xs" caption (fake-claude result emits duration_ms:60 → 0.1s).
    await expect(page.getByTestId("commander-worked-for")).toBeVisible({ timeout: 10_000 });

    // PERSISTENCE: reload — tool activity now survives the server sync (the
    // core Phase 3 behavior change). serverToLocal maps persisted toolCalls.
    await page.reload();
    await expect(page.getByText("Used mcp aoa create artifact")).toBeVisible({ timeout: 20_000 });
  });
});
```
  Note: the tool-activity testid index is `1` because `serverToLocal` numbers reloaded entries from `0`, but during the live turn `toolCallIdRef` increments from its prior value — the *live* row's id is `1` for the first tool of the session (the ref starts at 0, `++` → 1). After reload the mapped id is `0`. The assertion targets `commander-tool-activity-1` during the live turn (before reload). If the harness shows a different starting id, target the row by its visible label instead: `page.getByText("Used mcp aoa create artifact").click()`.

- [ ] **Step 2: Run it.** `pnpm test:e2e commander-transparency` (or the repo's e2e invocation; e2e runs on Linux CI — Windows e2e is skipped per the CI matrix, so verify in CI / WSL if not runnable locally). Expected: PASS.
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/commander-transparency.spec.ts
git commit -m "test(commander): e2e tool transparency renders, expands, persists, duration"
```

### Task 5.4: De-stale the existing viewer spec's tool-indicator assumption

**Files:**
- Modify: `tests/e2e/commander-viewer.spec.ts:252-256` (the comment) — and confirm the test still passes.

- [ ] **Step 1: Update the stale comment.** The block at ~252-256 says tool indicators "vanish on the post-turn server sync." After Phase 3 that's no longer true. Replace the comment with:
```ts
    // Tool activity now PERSISTS (Phase 3): toolCalls/toolResults are written to
    // internal_agent_messages and re-hydrated by serverToLocal, so the settled
    // indicator survives the post-turn sync and a reload. holdMs is no longer
    // required to observe it, but is kept here as a stable observation window.
```

- [ ] **Step 2: Run the existing viewer spec to confirm no regression.** `pnpm test:e2e commander-viewer` → PASS (the `getByText("Used mcp aoa create artifact")` assertion still holds; the row is now a `<button>` but the text query still matches).
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/commander-viewer.spec.ts
git commit -m "test(commander): de-stale viewer spec note now that tool activity persists"
```

---

## Final verification (after all phases)

- [ ] **Full suites:** `cd ui && pnpm tsc -b && pnpm vitest run` then `cd ../server && pnpm tsc -b && pnpm vitest run`. All green except the known-unrelated pre-existing failures.
- [ ] **e2e suite:** run the Commander Playwright specs (`commander-transparency`, `commander-viewer`, `commander-viewer-persistence`) on Linux/CI (Windows e2e is skipped per the CI matrix). All green.
- [ ] **Live e2e on :3201** (`/PIN/commander`): send a message that triggers a tool (e.g. "create a task called Launch checklist"). Confirm: neutral user bubble; hover timestamp; an inline activity row with a check glyph + "Used …" that expands to the result; "Worked for Xs" caption; 0 console errors. Then open Settings → Commander → Run History: the run shows real Tokens (in/out) and an "Est. Cost" value (likely $0.00 under subscription — that's correct), with the estimate caption visible.
- [ ] **Codex parity (if a codex config is available):** repeat the tool-triggering message with the provider set to `codex`; confirm tool activity renders and Run History shows tokens. If no codex environment, note it as unverified in the report.
- [ ] **Screenshots** of the neutral bubble + expandable activity + Run History tokens column for the completion report.

---

## Self-Review (author checklist — completed)

**Spec coverage:** Foundation double-done → Task 1.3. Real cost/tokens claude → 1.2/1.4; codex → 1.3/1.4. Settings tokens + Est. cost → Phase 2. Tool transparency forward/persist/render/reload → Phase 3. Bubble + timestamp + decision → Phase 4. Both providers covered (1.2 claude, 1.3 codex). No-migration honored (reuses existing columns). XSS guard called out (3.1 truncate, 3.5 plain-text `<pre>`). Thinking excluded. ✅

**Test coverage:** unit (handleResultEvent extraction 1.2; resolveRunCostCents 1.4), component (toolCalls mapping 3.4; createdAt mapping 5.1; RunHistoryTabContent tokens+Est.Cost 5.2), fixture (fake-claude real tokens 1.5), **automated e2e user flow** (commander-transparency.spec 5.3 — renders/expands/persists/duration; viewer spec de-stale 5.4), plus the manual live `:3201` flow + full suites in Final verification. Every behavior change has at least one automated test. ✅

**Placeholder scan:** No TBD/"handle edge cases"/"similar to" — every code step shows real code. ✅

**Type consistency:** `RunSummary.tokenUsage` (1.1) ↔ `handleResultEvent` (1.2) ↔ route `finalSummary` (1.4) ↔ `AgentRun.tokenUsage` (2.1) all carry `cachedInputTokens?`. `ToolCallEntry` fields (3.4) ↔ render (3.5) ↔ persisted `AgentMessageToolCall/Result` (3.3) ↔ `serverToLocal` map (3.4) consistent. `resolveRunCostCents` signature (1.4) matches its test (1.4) and `computeCostCents` (`cost-model.ts:41`). `durationMs` added to done SSE (1.4) consumed in 3.4. ✅

**Note for reviewers:** Task 1.4 Step 4(a) flags that the config select currently runs *after* the run insert — the chosen resolution is to set `model`/`provider` on the completion UPDATE (no reordering). Confirm that's acceptable vs. moving the select above the insert.

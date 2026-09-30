# Commander Chat — Codex Inline Reasoning (Plan 2, Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Commander's **Codex** engine show the model's reasoning inline, reusing the exact reasoning pipeline the Claude path already ships (collapsible `CommanderReasoningBlock`, persisted in `internal_agent_messages.reasoning`, `event: reasoning` SSE). Net result: Codex users get the same "Thinking" block Claude users get.

**Architecture:** AoA-commander worktree, branch `feat/v1-commander-chat`, on top of Plan 2 Phases 1–3 (Claude reasoning, shipped). The whole downstream pipeline is **provider-agnostic and already wired** — the only gaps are in the Codex layer: (a) the Codex parser drops reasoning items, and (b) the Codex spawn doesn't ask for reasoning summaries. Two small edits + a unit test + a live-verify on real Codex.

**Tech Stack:** TypeScript, Codex CLI (codex-cli 0.130.0, installed + authed here), Vitest, the `:3201` dev server + Docker pgvector.

---

## Context the implementer must not get wrong (read first)

1. **Spike-verified Codex reasoning shape** (real `codex exec --json` output):
   ```json
   {"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"**Breaking down…**\n\n…391…"}}
   ```
   Reasoning is **nested under `item.completed`** with `item.type === "reasoning"` and the text in **`item.text`** (markdown, in the clear — Codex does NOT redact, unlike Claude Opus). There is **no** top-level `{"type":"reasoning"}` event and **no** streaming delta — each reasoning item is one complete block. A turn can emit **0, 1, or 2+** reasoning items (model-driven, intermittent).

2. **Design: push the reasoning chunk straight into `parsed.chunks`** (NOT a separate `parsed.reasoning` field). `runCodexTurn` already re-yields `parsed.chunks` verbatim (cli-mode.ts ~986-988), and `AgentStreamChunk` already has `{type:"reasoning";delta:string}` (agent-loop.ts:41). So the Codex parser must push a chunk of **exactly that shape** (`delta`, not `text`) and `runCodexTurn` needs **no change**. Multiple reasoning items → multiple chunks → agent-loop concatenates them (already does, agent-loop.ts:303).

3. **Enablement: `-c model_reasoning_summary=detailed` ONLY.** The spike proved `model_reasoning_effort` is NOT required to surface reasoning text (summary controls visibility; effort controls depth/token-budget). `effort=high` is too aggressive (latency + tokens) for an always-on assistant — **omit it**; Codex uses the user's config-default effort. (A per-company effort/summary config is a future option, not this plan.)

4. **The whole downstream pipeline is shared + done — change NOTHING below the Codex layer.** agent-loop accumulation+cap(16000)+persist, the `event: reasoning` SSE, `CommanderReasoningBlock`, the `internal_agent_messages.reasoning` column, and `serverToLocal`/history-load are all engine-agnostic and verified on the Claude path. The Codex chunk rides the same rails.

5. **Two UX caveats (acceptable for v1, just true):**
   - **Intermittent:** Codex emits reasoning on *some* turns only. The UI already null-guards (`if (!text.trim()) return null` in `CommanderReasoningBlock`), so absent reasoning = no block. Fine.
   - **Not live-streamed:** `runCodexTurn` buffers the whole turn and parses on exit, so the Codex reasoning block appears **all at once near turn-end** (collapsed), not streaming token-by-token like Claude. It still renders + persists + expands. Token-by-token Codex streaming is a pre-existing deferred polish (cli-mode notes codex isn't streamed) — out of scope.
   - **SSE is NOT capped** (CODEX-REVIEW): the 16000-char cap is applied at *persist* (agent-loop.ts:332), not before the `event: reasoning` SSE write. Codex yields a whole `detailed` summary as ONE reasoning chunk, so a very large summary reaches the UI in full (the DB row is still capped). Acceptable for v1 — the UI renders reasoning in a `max-h-[200px]` scroll area, and `detailed` summaries are a few KB, not megabytes. If oversized summaries are observed live, cap the chunk in the parser (`item.text.slice(0, N)`) before pushing. Noted, not blocking.

6. **Quoting:** match the existing codex-adapter convention (`execute.ts:411` uses `model_reasoning_effort=${JSON.stringify(value)}` → `model_reasoning_effort="medium"`). Confirm the **quoted** form `model_reasoning_summary="detailed"` actually emits reasoning via a quick spike before wiring (Task 2 Step 1).

7. **Out of scope (note, don't build):** the heartbeat/agent Codex path (`execute.ts buildArgs`) also lacks `model_reasoning_summary`, so heartbeat codex runs don't surface reasoning either — a separate consistency follow-up. Codex `turn.completed.usage.reasoning_output_tokens` is not folded into cost accounting — out of scope. No fake-codex e2e fixture exists (only fake-claude) — verify Codex live, unit-test the parser.

### File map
| File | Change |
|------|--------|
| `packages/adapters/codex-local/src/server/parse.ts` | `CodexParsedChunk` += reasoning; `else if (item.type==="reasoning")` arm pushes the chunk |
| `server/src/services/internal-agent/cli-mode.ts` | splice `-c model_reasoning_summary="detailed"` into both codex argv branches |
| codex-local parser test | unit test: reasoning item → reasoning chunk |

### Step 0: baseline
- [ ] `cd packages/adapters/codex-local && pnpm tsc -b` (or root) clean; note the existing codex parser tests pass.

---

## Task 1: Codex parser surfaces reasoning (TDD)

**Files:**
- Modify: `packages/adapters/codex-local/src/server/parse.ts` (union ~23-35; item.completed handler ~202-231)
- Test: the codex-local parser test (find it: `server/src/__tests__/codex-local-adapter.test.ts` or `packages/adapters/codex-local/src/server/*.test.ts` — mirror the existing `parseCodexJsonl` cases)

- [ ] **Step 1: Write the failing test.** Add a case asserting a reasoning item surfaces as a reasoning chunk:
```ts
it("surfaces an item.completed reasoning item as a reasoning chunk", () => {
  const stdout = [
    JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "**Breaking it down**\nStep 1…" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "The answer is 391." } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }),
  ].join("\n");
  const parsed = parseCodexJsonl(stdout);
  // CODEX-REVIEW FIX: cast so the red test type-checks BEFORE the union member exists
  // (some codex-local test configs enforce TS diagnostics). Or add Step 3's union first.
  const reasoning = ((parsed.chunks ?? []) as Array<{ type: string; delta?: string }>).filter((c) => c.type === "reasoning");
  expect(reasoning).toHaveLength(1);
  expect(reasoning[0]).toEqual({ type: "reasoning", delta: "**Breaking it down**\nStep 1…" });
  expect(parsed.summary).toContain("The answer is 391.");
});

// SKILLS-REVIEW FIX: negative case — an empty-text reasoning item emits NO chunk
// (mirrors the `if (text)` guard, so no blank reasoning block renders).
it("ignores an empty reasoning item", () => {
  const stdout = JSON.stringify({ type: "item.completed", item: { id: "r0", type: "reasoning", text: "" } });
  const parsed = parseCodexJsonl(stdout);
  expect(((parsed.chunks ?? []) as Array<{ type: string }>).filter((c) => c.type === "reasoning")).toHaveLength(0);
});
```
> **SKILLS-REVIEW NOTE:** edit **`parseCodexJsonl`** (the chat path) — NOT `parseCodexStdoutLine` (the UI activity-timeline parser at `…/server/parse.ts` / tested in `codex-local-adapter.test.ts:300-319`), which ALREADY maps `item.type:"reasoning"` → `{kind:"thinking"}` for the heartbeat transcript. That existing mapping independently corroborates the codex reasoning shape and must stay untouched.

- [ ] **Step 2: Run it — fails.** (no reasoning branch yet → 0 reasoning chunks). Run the codex-local parser test file.

- [ ] **Step 3: Add the union member** (`parse.ts` ~23-35), after the `tool_result` member:
```ts
  | { type: "reasoning"; delta: string }
```

- [ ] **Step 4: Add the else-if arm** in the `item.completed` handler (after the `agent_message` arm at ~204-206, before/independent of the tool arm). It pushes a chunk (NOT into `messages`):
```ts
      } else if (asString(item.type, "") === "reasoning") {
        const text = asString(item.text, "");
        if (text) chunks.push({ type: "reasoning", delta: text });
      }
```
(The block's trailing `continue;` at ~230 already advances the loop — do NOT add a standalone `if … continue`.)

- [ ] **Step 5: Run it — passes.** Codex-local parser tests green (new + existing).

- [ ] **Step 6: Typecheck.** `cd packages/adapters/codex-local && pnpm tsc -b` (and `cd server && pnpm tsc -b` — `runCodexTurn` re-yields `parsed.chunks`, now including the reasoning variant, which matches `AgentStreamChunk` exactly so it typechecks with no runCodexTurn change).

- [ ] **Step 7: Commit.**
```bash
git add packages/adapters/codex-local/src/server/parse.ts <the test file>
git commit -m "feat(codex): surface reasoning items as reasoning chunks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: enable reasoning on the Commander Codex spawn

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (codex argv, ~437-439)

- [ ] **Step 1: Confirm the quoted flag form via a quick spike** (de-risk the quoting). From a non-repo dir:
```bash
cd /tmp && codex exec --json --skip-git-repo-check --sandbox read-only -c model_reasoning_summary="detailed" "Reason step by step: what is 12+30?" < /dev/null 2>/dev/null | grep -c '"type":"reasoning"'
```
Expected: ≥ 1 (the quoted form emits reasoning). Also confirm the run **exits 0 with no error** (SKILLS-REVIEW RISK: `model_reasoning_summary` is an unknown `-c` key to the existing codex-adapter code — execute.ts only uses `model_reasoning_effort`; if the installed codex rejected an unknown key it would FAIL the whole turn, not just suppress reasoning). The first codex spike already showed exit 0 + reasoning on codex-cli 0.130.0, so this is confirmation, not discovery. If 0 or non-zero exit, fall back to the bare form `model_reasoning_summary=detailed`, or omit the flag and report.

- [ ] **Step 2: Splice the flag into BOTH codex argv branches** (`cli-mode.ts:437-439`). The `-` (and `resume <id> -`) is the positional stdin-prompt sentinel and MUST stay last; insert the `-c` flag after `...codexBypassArgs`:
```ts
      const reasoningArgs = ["-c", `model_reasoning_summary=${JSON.stringify("detailed")}`];
      const codexArgs = resumeCodexSessionId
        ? ["exec", "--json", ...codexBypassArgs, ...reasoningArgs, "resume", resumeCodexSessionId, "-"]
        : ["exec", "--json", ...codexBypassArgs, ...reasoningArgs, "-"];
```
(`JSON.stringify("detailed")` → `"detailed"`, matching `execute.ts:411`'s quoting; if Step 1 showed the quoted form fails, use the bare string instead.)

- [ ] **Step 2b: Add an argv test** (CODEX-REVIEW FIX #1). The existing codex argv tests (`server/src/__tests__/cli-mode.test.ts` ~781 first-turn, ~1049 resumed) assert `codex`/`exec`/`--json` but NOT the new flag. Add assertions (to those tests or a new one) that the resolved codex argv contains `-c` immediately followed by `model_reasoning_summary="detailed"`, and that this pair appears **before** the trailing `-` (and before `resume <id> -` on the resumed turn). Cover: first turn, resumed turn, and the unknown-session fresh-retry path. Run the test: `cd server && pnpm vitest run cli-mode`.

- [ ] **Step 3: Typecheck.** `cd server && pnpm tsc -b` clean.

- [ ] **Step 4: Commit.**
```bash
git add server/src/services/internal-agent/cli-mode.ts server/src/__tests__/cli-mode.test.ts
git commit -m "feat(codex): request reasoning summaries on the Commander codex spawn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: live-verify on real Codex

> No fake-codex e2e fixture exists, so verification is live against the real Codex CLI (installed + authed here). The downstream pipeline is already proven on Claude; this confirms the Codex parser + spawn flag light it up.

- [ ] **Step 1: Point the company at Codex.** The live `:3201` server uses the Docker pgvector (`DATABASE_URL=…@127.0.0.1:5433/aoa`, user/pass postgres). Set the engine to codex (the literal `codex`, not `codex_cli`):
```bash
docker exec aoa-pin-verify psql -U postgres -d aoa -c "update internal_agent_config set cli_tool='codex' where company_id='ae665e58-74a5-42aa-8234-7f733543bd41';"
```

- [ ] **Step 2: Restart the dev server** (clears the in-memory CLI session store so the next turn spawns a fresh authed codex):
  Kill the AoA-commander node procs, relaunch `DATABASE_URL=…/aoa PORT=3201 HOST=127.0.0.1 AOA_DEPLOYMENT_MODE=local_trusted AOA_VITE_HMR_PORT=3211 AOA_INSTANCE_ID=commander-e2e pnpm dev` (NO `ANTHROPIC_MODEL` — that's claude-only), wait for `:3201` 200.

- [ ] **Step 3: Drive a reasoning prompt** at `/PIN/commander` via `/browse`: send "Reason step by step: plan a 3-step launch checklist and explain your reasoning." Poll for `data-testid="commander-reasoning"`. Because Codex buffers, expect the block to appear near turn-end (collapsed). Confirm: block present → expand shows the reasoning text → reload → still present (persisted). Check the DB: the newest assistant `internal_agent_messages.reasoning` is populated. 0 console errors.
  - If Codex didn't emit reasoning that turn (intermittent), retry the prompt 1–2x (it's model-driven). Confirm at least one turn shows it.

- [ ] **Step 4: Restore the engine** (leave the demo on Claude unless the founder wants codex):
```bash
docker exec aoa-pin-verify psql -U postgres -d aoa -c "update internal_agent_config set cli_tool=null where company_id='ae665e58-74a5-42aa-8234-7f733543bd41';"
```
(No commit — DB state only.)

---

## Final verification
- [ ] `cd packages/adapters/codex-local && pnpm tsc -b`; `cd server && pnpm tsc -b` — clean.
- [ ] `cd server && pnpm vitest run` — green (the new codex reasoning parse test passes; no regressions). The 4 pre-existing unrelated UI failures are unaffected (this is server/adapter only).
- [ ] Live: Codex reasoning block rendered + persisted + DB column populated (Task 3). Screenshot.

## Self-Review
**Coverage:** parser (Task 1) + enable (Task 2) + live-verify (Task 3). Downstream untouched (shared, proven). **Shape:** verified nested-under-item.completed, `item.text`, push `{type:"reasoning",delta}` into `chunks` → no runCodexTurn change. **Decisions:** summary=detailed only (no effort); concatenate multiple items; intermittent + non-streamed accepted + documented. **Quoting** de-risked by the Task 2 spike. **Out of scope** flagged: heartbeat codex, reasoning-token cost, fake-codex e2e.

## Open decisions for review
1. `model_reasoning_summary` hardcoded `detailed` vs read from `internal_agent_config` (no column exists today → hardcode for v1; a config field is a future add). Confirm.
2. Omit `model_reasoning_effort` (use codex config default) vs set a modest value — recommend omit (don't inflate always-on latency/cost). Confirm.
3. Non-streamed late-flash for codex reasoning (one block at turn-end) — acceptable for v1, or block on token-by-token codex streaming (bigger, separate)? Recommend accept for v1.

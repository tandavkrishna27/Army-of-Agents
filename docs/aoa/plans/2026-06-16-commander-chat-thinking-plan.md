# Commander Chat — Inline Reasoning / Thinking (Plan 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show the assistant's reasoning inline in the Commander chat, Claude-style — a collapsible "Thinking" block that streams live and **persists** across reload, for Claude (spike-confirmed) and Codex (best-effort).

**Architecture:** AoA-commander worktree, branch `feat/v1-commander-chat`, on top of Plan 1. Reasoning is a new `{type:"reasoning"; delta}` `AgentStreamChunk` emitted by the parser, carried through agent-loop → a new `event: reasoning` SSE → the chat UI, accumulated onto the streaming assistant message, **persisted** in a new `internal_agent_messages.reasoning` column (so it survives reload, unlike Plan 1's live-only duration). Claude is enabled with the `MAX_THINKING_TOKENS` env and captured from the live `thinking_delta` stream event; Codex needs a parser branch + a config-toml reasoning setting and is **unverifiable in this environment** (no codex CLI), so it ships flagged best-effort with graceful no-block.

**Tech Stack:** TypeScript, React+Vite, Express, Drizzle (migration this time), Vitest, the `:3201` dev server + real Claude CLI.

---

## Review fixes — APPLIED (2026-06-16, 3 reviewers; 2 blockers resolved)

3-reviewer adversarial pass; core thesis verified SOUND against source (parser branch slots cleanly; locked tests #8/#18/#19 stay green; `--include-partial-messages` already present so `spawnEnv` is the only enablement; all agent-loop/SSE/UI sites match). Fixes folded in:
- **BLOCKER — no audit redactor:** dropped the nonexistent `redactAndCapPrompt`; reasoning is **cap-only** (16000 chars), no heavy redactor (it would over-redact normal prose). (Context #4, Task 2.2)
- **BLOCKER — history-load path:** the `historyData` inline map carried neither reasoning nor toolCalls → reasoning wouldn't load on a *specific* conversation reload. Route it through `serverToLocal` (also repairs a Plan 1 toolCalls gap). (Task 3.3 Step 2b)
- **Collapse bug:** `CommanderReasoningBlock` is now prop-driven (useEffect), not a mount-only initializer that never collapses. (Task 3.3 Step 1)
- **Migration mechanics:** `pnpm db:generate` from ROOT; migrations in `packages/db/src/migrations`; plain `ADD COLUMN` (no `IF NOT EXISTS`, precedent 0138), ~0141. (Context #5, Task 2.1)
- **Persist gate widened** so reasoning/tool-only (text-less) turns persist. (Task 2.2 Step 2b)
- **Duplicate "Thinking…"** legacy spinner suppressed when reasoning present. (Task 3.3 Step 4b)
- **Codex:** reasoning added as an `else if` inside `item.completed` (not a standalone branch); enablement via the `-c model_reasoning_summary` flag (not the config.toml writer), key unverified → graceful no-block. (Task 4)

---

## Context the implementer must not get wrong (read first)

1. **Capture claude reasoning ONLY from the live `thinking_delta`** (in `handleStreamEvent`). Do NOT also emit from the assistant `thinking` content block (`handleAssistantEvent` keeps skipping it) — emitting both double-counts. This also keeps the locked parser tests #8/#18/#19 valid (we never change content_block_start or assistant-block handling); we only ADD a `thinking_delta` branch.
2. **`--include-partial-messages` is already in the claude args** (cli-mode.ts:385/400). The ONLY missing trigger is the `MAX_THINKING_TOKENS` env. The spawn already merges `invocation.spawnEnv` (`{...process.env, ...invocation.spawnEnv}`), and `CliInvocation` already has an optional `spawnEnv` — so adding `spawnEnv` to the two claude returns is the whole enablement.
3. **Distinct SSE event name.** There is already a textless `event: thinking` (`{status:"processing"}`) written once pre-dispatch (internal-agent.ts:174-176) that the UI uses as a no-op. The new reasoning stream MUST use a different event name: **`reasoning`**. Do not overload `thinking`.
4. **Reasoning IS persisted** (new column) — unlike Plan 1's duration. So it survives reload (collapsed). Persist it **capped to a length bound ONLY** (16000 chars) — do NOT run it through the audit-grade `prompt-snapshot` redactor (REVIEW: its broad JWT/dotted-identifier rule would mangle normal reasoning prose, and there is no `(string)=>string` export named `redactAndCapPrompt`). Reasoning is model output rendered as escaped plaintext — the same trust class as the assistant `content` we already persist unredacted.
5. **Migration required** (Plan 1 had none). Drizzle only: edit the schema, then run **`pnpm db:generate` from the repo ROOT** (it's an alias for `pnpm --filter @armyofagents/db generate`; the package-level script is just `generate`). Migrations land in **`packages/db/src/migrations`** (drizzle.config `out: ./src/migrations`). Expect a plain `ALTER TABLE "internal_agent_messages" ADD COLUMN "reasoning" text;` — **NO `IF NOT EXISTS`** (precedent: `0138_ancient_randall.sql`; do not hand-edit it in). New file ≈ `0141_*.sql`. Never hand-write SQL.
6. **Security:** reasoning text reaches the client and renders via `MarkdownBody`/escaped plaintext — NO `rehype-raw`, no `dangerouslySetInnerHTML` (same invariant as the plain-text fallback note in parse-stream-json.ts).
7. **Codex (Phase 4) is unverified-live** — no codex CLI in this env. Build it, but it ships best-effort: if codex doesn't emit reasoning items (reasoning summaries off), the block simply doesn't appear. Claude is the verified path.
8. **Config:** v1 is **default-on** with a constant `MAX_THINKING_TOKENS = 3000` (the spike value). A per-company `internal_agent_config` flag/budget is a deliberate future option, NOT in this plan.

### File map

| File | Change |
|------|--------|
| `server/src/services/internal-agent/agent-loop.ts` | `AgentStreamChunk` += `reasoning`; accumulate `accumulatedReasoning`; persist via appendMessage |
| `server/src/services/internal-agent/parse-stream-json.ts` | `handleStreamEvent`: emit `reasoning` for `thinking_delta` |
| `server/src/services/internal-agent/cli-mode.ts` | `spawnEnv: { MAX_THINKING_TOKENS }` on both claude returns; (Phase 4) codex config-toml reasoning + runCodexTurn passthrough |
| `server/src/services/internal-agent/thinking-config.ts` | NEW — the `MAX_THINKING_TOKENS` constant |
| `packages/db/src/schema/internal_agent.ts` | `reasoning: text("reasoning")` column + migration |
| `server/src/services/internal-agent/conversation.ts` | `MessageInput.reasoning` + persist (redacted) |
| `server/src/routes/internal-agent.ts` | SSE `case "reasoning"` → `event: reasoning` |
| `ui/src/api/internal-agent.ts` | `SSEEventType` += `reasoning`; `AgentMessage.reasoning` |
| `ui/src/components/InternalAgentPanel.tsx` | `LocalMessage.reasoning`; serverToLocal map; `case "reasoning"` accumulate; `CommanderReasoningBlock` render |
| `packages/adapters/codex-local/src/server/parse.ts` | (Phase 4) `item.type==="reasoning"` branch + `CodexParsedChunk` union |
| tests | parser unit, component, e2e (fake-claude thinking_delta) |

### Step 0: baseline
- [ ] `cd ui && pnpm tsc -b && pnpm vitest run` ; `cd ../server && pnpm tsc -b && pnpm vitest run` — green except the 4 known pre-existing UI failures (MemoryExplorer/ThreadsWorkspace×2/ThreadDetail).

---

## Phase 1 — Claude capture + enablement (server, TDD)

### Task 1.1: the reasoning chunk + parser branch (TDD)

**Files:**
- Modify: `server/src/services/internal-agent/agent-loop.ts` (the `AgentStreamChunk` union, ~39-46)
- Modify: `server/src/services/internal-agent/parse-stream-json.ts` (`handleStreamEvent`, ~152-166)
- Test: `server/src/__tests__/parse-stream-json.test.ts`

- [ ] **Step 1: Add the union member.** In `agent-loop.ts`, add to `AgentStreamChunk`:
```ts
  | { type: "reasoning"; delta: string }
```
(place it right after the `text` member).

- [ ] **Step 2: Write the failing test.** Append to `parse-stream-json.test.ts` (the file already imports `StreamJsonParser` — do not re-import):
```ts
describe("handleStreamEvent surfaces thinking_delta as reasoning", () => {
  it("emits a reasoning chunk for a thinking_delta", () => {
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason..." } },
    });
    const chunks = parser.push(line + "\n");
    expect(chunks).toEqual([{ type: "reasoning", delta: "Let me reason..." }]);
  });

  it("still drops signature_delta (opaque, not human reasoning)", () => {
    const parser = new StreamJsonParser();
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
    });
    expect(parser.push(line + "\n")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it — fails.** `cd server && pnpm vitest run parse-stream-json` → FAIL (thinking_delta currently returns []).

- [ ] **Step 4: Implement.** Replace the tail of `handleStreamEvent` (`parse-stream-json.ts`, the part after `if (inner.type !== "content_block_delta") return [];`):
```ts
  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta) return [];

  if (delta.type === "text_delta") {
    const text = delta.text;
    return typeof text === "string" ? [{ type: "text", delta: text }] : [];
  }

  if (delta.type === "thinking_delta") {
    const thinking = delta.thinking;
    return typeof thinking === "string" ? [{ type: "reasoning", delta: thinking }] : [];
  }

  // signature_delta / input_json_delta and any other delta type: not surfaced.
  return [];
```

- [ ] **Step 5: Update the skip comment** in `handleAssistantEvent` (the `// text and thinking blocks: skip` line) to: `// text + thinking blocks: skip — both stream incrementally via stream_event deltas (text_delta / thinking_delta)`. Do NOT emit from the thinking block here (avoids double-counting).

- [ ] **Step 6: Run — passes.** `cd server && pnpm vitest run parse-stream-json` → PASS (new tests pass; existing Test 8/18/19 still pass — unchanged behavior for assistant-block + signature_delta + content_block_start).

- [ ] **Step 7: Commit.**
```bash
git add server/src/services/internal-agent/agent-loop.ts server/src/services/internal-agent/parse-stream-json.ts server/src/__tests__/parse-stream-json.test.ts
git commit -m "feat(commander): parse claude thinking_delta into a reasoning chunk"
```

### Task 1.2: enable thinking on the claude spawn

**Files:**
- Create: `server/src/services/internal-agent/thinking-config.ts`
- Modify: `server/src/services/internal-agent/cli-mode.ts` (both claude returns, ~377-405)

- [ ] **Step 1: Constant.** Create `thinking-config.ts`:
```ts
/** Token budget that enables Claude CLI extended thinking in --print stream-json
 *  mode (spike-confirmed: with this env set, claude emits thinking + thinking_delta).
 *  v1 is a constant; a per-company internal_agent_config budget is a future option. */
export const COMMANDER_MAX_THINKING_TOKENS = 3000;
```

- [ ] **Step 2: Inject `spawnEnv` on BOTH claude returns** (cli-mode.ts:377-390 systemSplit branch, and :393-405 fallback branch). Add to each returned object:
```ts
          spawnEnv: { MAX_THINKING_TOKENS: String(COMMANDER_MAX_THINKING_TOKENS) },
```
Import the constant at the top: `import { COMMANDER_MAX_THINKING_TOKENS } from "./thinking-config.js";`
(The spawn at the persistent-claude path already does `env: { ...process.env, ...invocation.spawnEnv }`, so this flows through with no other change. `--include-partial-messages` is already present.)

- [ ] **Step 3: Typecheck.** `cd server && pnpm tsc -b` → PASS.

- [ ] **Step 4: Commit.**
```bash
git add server/src/services/internal-agent/thinking-config.ts server/src/services/internal-agent/cli-mode.ts
git commit -m "feat(commander): enable claude extended thinking via MAX_THINKING_TOKENS"
```

---

## Phase 2 — Persist reasoning (migration + agent-loop)

### Task 2.1: add the `reasoning` column (migration)

**Files:**
- Modify: `packages/db/src/schema/internal_agent.ts` (internal_agent_messages, ~200-205)

- [ ] **Step 1: Add the column** after `toolResults`:
```ts
  reasoning: text("reasoning"), // assistant's extended-thinking text (accumulated, redacted)
```

- [ ] **Step 2: Generate the migration.** From the repo ROOT run `pnpm db:generate` (alias for `pnpm --filter @armyofagents/db generate`). The new file appears in **`packages/db/src/migrations/0141_*.sql`**. Inspect it: it must be exactly `ALTER TABLE "internal_agent_messages" ADD COLUMN "reasoning" text;` (a single additive column, NO `IF NOT EXISTS` — matches precedent `0138_ancient_randall.sql`). Do NOT hand-edit.

- [ ] **Step 3: Commit.**
```bash
git add packages/db/src/schema/internal_agent.ts packages/db/src/migrations
git commit -m "feat(db): add internal_agent_messages.reasoning column"
```

### Task 2.2: persist accumulated reasoning (redacted)

**Files:**
- Modify: `server/src/services/internal-agent/conversation.ts` (MessageInput ~10-20, appendMessage insert ~64-77)
- Modify: `server/src/services/internal-agent/agent-loop.ts` (chat loop ~298-314, appendMessage call ~323-328)

- [ ] **Step 1: MessageInput + insert.** In `conversation.ts`, add `reasoning?: string | null;` to `MessageInput`, and `reasoning: message.reasoning ?? null,` to the `internalAgentMessages` insert values.

- [ ] **Step 2: Accumulate + persist in agent-loop.** In the chat for-await loop (alongside `accumulatedAssistant` / `turnToolCalls`), add:
```ts
        const REASONING_CAP = 16000;
        let accumulatedReasoning = "";
```
and inside the loop:
```ts
          if (chunk.type === "reasoning") accumulatedReasoning += chunk.delta;
```
**Cap-only, no heavy redactor** (REVIEW FIX). In the `appendMessage` call add:
```ts
            ...(accumulatedReasoning.trim() ? { reasoning: accumulatedReasoning.slice(0, REASONING_CAP) } : {}),
```

- [ ] **Step 2b: Widen the persist gate** (REVIEW FIX — Lens C minor). The assistant `appendMessage` currently fires only `if (accumulatedAssistant.trim())`, so a text-less turn (tool-only, or reasoning-only) drops BOTH reasoning AND toolCalls. Widen the condition so the turn persists when there's any content:
```ts
        if (accumulatedAssistant.trim() || turnToolCalls.length > 0 || accumulatedReasoning.trim()) {
```
(This also repairs a Plan 1 latent gap where tool activity was lost on text-less turns.)

- [ ] **Step 3: Typecheck + test.** `cd server && pnpm tsc -b && pnpm vitest run` → green (no regressions; the existing agent-loop persistence tests use objectContaining so the extra field is fine).

- [ ] **Step 4: Commit.**
```bash
git add server/src/services/internal-agent/conversation.ts server/src/services/internal-agent/agent-loop.ts
git commit -m "feat(commander): persist redacted assistant reasoning"
```

---

## Phase 3 — SSE forward + UI render (Claude path end-to-end)

### Task 3.1: forward reasoning over SSE

**Files:**
- Modify: `server/src/routes/internal-agent.ts` (chunk switch, ~249-310)

- [ ] **Step 1: Add the case** (distinct event name `reasoning`):
```ts
            case "reasoning":
              res.write(
                `event: reasoning\ndata: ${JSON.stringify({ text: chunk.delta })}\n\n`,
              );
              break;
```
Leave the pre-dispatch `event: thinking` `{status:"processing"}` write untouched.

- [ ] **Step 2: Typecheck + commit.** `cd server && pnpm tsc -b`.
```bash
git add server/src/routes/internal-agent.ts
git commit -m "feat(commander): forward reasoning deltas over SSE"
```

### Task 3.2: client types

**Files:**
- Modify: `ui/src/api/internal-agent.ts` (SSEEventType ~124-132, AgentMessage ~25-33)

- [ ] **Step 1:** Add `| "reasoning"` to `SSEEventType`. Add `reasoning: string | null;` to `AgentMessage` (the GET endpoints bare-`select()`, so the new DB column round-trips automatically).
- [ ] **Step 2: tsc + commit.**
```bash
git add ui/src/api/internal-agent.ts
git commit -m "refactor(commander): client types for reasoning"
```

### Task 3.3: render the collapsible reasoning block (TDD for the model bits)

**Files:**
- Create: `ui/src/components/commander/CommanderReasoningBlock.tsx`
- Modify: `ui/src/components/InternalAgentPanel.tsx` (LocalMessage ~239-261; serverToLocal ~263-284; handleSSEEvent ~744-879; render ~1224-1289)
- Test: `ui/src/components/InternalAgentPanel.reasoning.test.tsx`

- [ ] **Step 1: Component** — mirror `TranscriptThinkingBlock` (workspace), rendered as escaped plaintext:
```tsx
import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

export function CommanderReasoningBlock({
  text,
  streaming,
  defaultCollapsed = false,
}: { text: string; streaming: boolean; defaultCollapsed?: boolean }) {
  // REVIEW FIX (Lens C major): prop-driven collapse. The SAME instance persists
  // across the streaming→settled flip (no remount), so a mount-only initializer
  // never auto-collapses. Expand while streaming; collapse once settled / on reload.
  const [expanded, setExpanded] = useState(streaming && !defaultCollapsed);
  useEffect(() => {
    setExpanded(streaming && !defaultCollapsed);
  }, [streaming, defaultCollapsed]);
  if (!text.trim()) return null;
  return (
    <div className="mb-2 rounded-lg bg-muted/20 p-2" data-testid="commander-reasoning">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60"
      >
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          <>
            <span>Thinking</span>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </>
        )}
      </button>
      {(expanded || streaming) && (
        <p className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap text-xs italic text-muted-foreground/80">
          {text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: LocalMessage + serverToLocal.** Add `reasoning?: string;` to `LocalMessage`. In `serverToLocal`, map it: `...(m.reasoning ? { reasoning: m.reasoning } : {})`.

- [ ] **Step 2b (BLOCKER FIX — Lens C): fix the history-load path.** There are TWO history load paths and only the default-conversation one uses `serverToLocal`. The `historyData` effect (~581-594) builds messages with an INLINE map (id/role/content/streamingDone/outputRefs/createdAt) that carries **neither reasoning NOR toolCalls** — so on a *specific* conversation (sidebar chat, `conversationId` set, the sync effect early-returns at line 598) reasoning (and Plan 1's tool rows) would not load on reload. Replace the inline `.map(...)` in that effect with a `serverToLocal` pass so both paths are consistent:
```ts
    const loaded: LocalMessage[] = historyData.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(serverToLocal);
    setMessages(loaded);
```
(`serverToLocal` already produces the right shape for user/assistant rows; this incidentally repairs the Plan 1 toolCalls-on-specific-conversation gap.)

- [ ] **Step 3: handleSSEEvent.** Leave `case "thinking"` no-op. Add:
```ts
      case "reasoning": {
        const text = (event.data as { text?: string }).text ?? "";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, reasoning: (m.reasoning ?? "") + text } : m,
          ),
        );
        break;
      }
```

- [ ] **Step 4: Render.** Import `CommanderReasoningBlock`. In the message body, render it for assistant messages ABOVE the tool-activity block:
```tsx
              {msg.role === "assistant" && msg.reasoning && (
                <CommanderReasoningBlock
                  text={msg.reasoning}
                  streaming={streaming && !msg.streamingDone}
                  defaultCollapsed={msg.streamingDone}
                />
              )}
```
(Live turn → streaming → expanded; settled / reloaded → collapsed.)

- [ ] **Step 4b (REVIEW FIX — Lens C minor): suppress the duplicate "Thinking…".** The existing render shows a legacy `Loader2 + "Thinking..."` spinner when an assistant message has empty content while streaming (the `msg.content ? … : msg.role==="assistant" && streaming ? <spinner> : null` branch). During the pre-text window reasoning is already streaming, so both would show. Gate the legacy spinner on `!msg.reasoning` so the reasoning block's own "Thinking…" is the single indicator.

- [ ] **Step 5: Test** (`InternalAgentPanel.reasoning.test.tsx`) — reasoning survives server→local mapping (it's persisted, unlike duration):
```tsx
import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1", role: "assistant", content: "answer", toolCalls: null,
  reasoning: "I reasoned about X.", outputRefs: null, pageContext: null,
  createdAt: "2026-06-16T00:00:00Z",
};
describe("reasoning survives server→local mapping (persisted)", () => {
  it("maps the persisted reasoning column", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged.find((m) => m.id === "m1")?.reasoning).toBe("I reasoned about X.");
  });
});
```

- [ ] **Step 6: tsc + test.** `cd ui && pnpm tsc -b && pnpm vitest run InternalAgentPanel` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add ui/src/components/commander/CommanderReasoningBlock.tsx ui/src/components/InternalAgentPanel.tsx ui/src/components/InternalAgentPanel.reasoning.test.tsx
git commit -m "feat(commander): render collapsible inline reasoning block (persisted)"
```

---

## Phase 4 — Codex reasoning (best-effort, UNVERIFIED-LIVE)

> Codex emits reasoning as `item.completed` events with `item.type==="reasoning"` + `text`, but ONLY when reasoning summaries are enabled, and the Commander codex parser currently drops them. No codex CLI in this env → ships best-effort; if reasoning isn't emitted, the block simply doesn't appear (graceful). Claude (Phases 1-3) is the verified path.

### Task 4.1: parse codex reasoning items

**Files:**
- Modify: `packages/adapters/codex-local/src/server/parse.ts` (CodexParsedChunk union ~23-35; item.completed handler ~202-231)

- [ ] **Step 1:** Add `| { type: "reasoning"; delta: string }` to `CodexParsedChunk` (union ~23-35). The reasoning items arrive INSIDE the existing `if (type === "item.completed")` block (~202-231), whose body is an `if / else if` chain on `asString(item.type, "")` (agent_message / tool_result / mcp_tool_call). Add another **`else if`** arm mirroring the agent_message arm — do NOT use a standalone `if … continue` (REVIEW FIX — the existing single `continue` at the end of the block already advances the loop):
```ts
        } else if (asString(item.type, "") === "reasoning") {
          const text = asString(item.text, "");
          if (text) chunks.push({ type: "reasoning", delta: text });
        }
```
(mirrors `cli/format-event.ts:67-71` / `ui/parse-stdout.ts:132-136` — codex reasoning is whole blocks, not token deltas, so one `reasoning` chunk per item.)

- [ ] **Step 2:** `runCodexTurn` (cli-mode.ts ~983-985) already re-yields `parsed.chunks` verbatim — confirm no change needed (the new reasoning chunks flow through). Add a unit test in the codex-local package asserting an `item.completed` reasoning event → a reasoning chunk.

- [ ] **Step 3: Commit.**
```bash
git add packages/adapters/codex-local/src/server/parse.ts packages/adapters/codex-local/...test
git commit -m "feat(codex): surface reasoning items as reasoning chunks"
```

### Task 4.2: enable codex reasoning summaries

**Files:**
- Modify: the codex config-toml writer (find via grep `writeCodexMcpConfigToml` / `model_reasoning` in `packages/adapters/codex-local` + `server/src/services/internal-agent/cli-mode.ts`)

- [ ] **Step 1 (REVIEW FIX — Lens C): prefer the `-c` flag, not the config.toml writer.** Append `-c model_reasoning_summary=<value>` (and optionally `-c model_reasoning_effort=...`) to the Commander codex argv (cli-mode.ts ~434-436), matching how `execute.ts:411` passes `-c model_reasoning_effort=...`. Do NOT extend `writeCodexMcpConfigToml` (it would need new key support). **Verify the exact key name** against the installed codex CLI before relying on it — this is the unverifiable bit; if wrong, codex simply emits no reasoning (graceful no-block, no crash).
- [ ] **Step 2: Commit** (`feat(codex): enable reasoning summaries for commander`).

---

## Phase 5 — e2e + fixture (Claude path)

### Task 5.1: fake-claude emits a thinking_delta

**Files:**
- Modify: `tests/e2e/fixtures/fake-claude/fake-claude.mjs`

- [ ] **Step 1:** Before the text deltas, emit a thinking block + delta so the e2e can assert the reasoning block:
```js
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering the request… " } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
```
(Place after the tool turn / before the reply text deltas. Optional: gate behind a control-file `reasoning` field so other specs are unaffected.)

- [ ] **Step 2: Commit** (`test(commander): fake-claude emits a thinking_delta`).

### Task 5.2: e2e — reasoning renders + persists

**Files:**
- Create: `tests/e2e/commander-reasoning.spec.ts` (mirror `commander-transparency.spec.ts` harness)

- [ ] **Step 1:** Send a message (control file includes the reasoning delta) → assert `getByTestId("commander-reasoning")` visible with the thinking text → `page.reload()` → assert it STILL renders (persisted, collapsed). This is the key difference from Plan 1's live-only duration.
- [ ] **Step 2: Commit** (`test(commander): e2e inline reasoning renders + persists`).

---

## Final verification
- [ ] Full suites: `cd ui && pnpm tsc -b && pnpm vitest run` ; `cd ../server && pnpm tsc -b && pnpm vitest run` — green except the 4 known pre-existing UI failures.
- [ ] **Live on :3201 (real claude):** send a non-trivial prompt → a collapsible **Thinking** block streams live (expanded), then settles collapsed; reload → it persists (collapsed, expandable). Check the DB: the assistant `internal_agent_messages.reasoning` column is populated (redacted). 0 console errors. Screenshot.
- [ ] e2e: `commander-reasoning` + `commander-transparency` + `commander-viewer` on CI/Linux.

## Self-Review
**Coverage:** capture (1.1) · enable (1.2) · persist+migration (2.1/2.2) · SSE (3.1) · UI types+render (3.2/3.3) · codex (4) · e2e (5). **Dedup:** reasoning only from thinking_delta; assistant thinking-block stays skipped → locked tests #8/#18/#19 unchanged, one new test added. **Security:** redact-and-cap on persist; escaped plaintext render. **Migration:** the one schema change; Drizzle-generated. **Risk:** codex is unverified-live (Phase 4), isolated + graceful; claude is spike-confirmed. **Config:** default-on constant (3000); per-company flag noted as future.

## Open decisions for review
1. **Codex (Phase 4):** build now (unverified-live, graceful) or DEFER (claude-only; codex shows no block)? The user's standing pref was "both providers," but codex thinking can't be live-verified here.
2. **Config gating:** default-on constant (this plan) vs a per-company `internal_agent_config` toggle/budget now?
3. **Multiple thinking blocks** in one turn accumulate into one concatenated reasoning string (v1). Acceptable, or separate blocks per thinking segment (more work)?

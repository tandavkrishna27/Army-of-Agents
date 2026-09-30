# Agent Loop & Conversation Management Design

**Date:** 2026-03-26
**Spec refs:** v2_5_discussions_and_agent_tasks.md (T9, T10), v2_5_discussions_and_agent_architecture.md (Agent Loop, Context Assembly), v2_5_discussions_and_agent_gotchas.md (2.3, 2.4, 2.5), v2_5_discussions_and_agent_security.md

## Overview

Build the core agent loop (multi-turn tool use), conversation management, and context assembly for the internal agent. These three services complete the execution pipeline: context assembly feeds the system prompt, conversation service manages history, and the agent loop orchestrates the LLM interaction with streaming, tool execution, budget enforcement, and safety guards.

## Existing Infrastructure (Already Built)

- **DB schema:** 5 tables — `internalAgentConfig`, `internalAgentConversations`, `internalAgentMessages`, `internalAgentRuns`, `internalAgentReminders`
- **LLM providers:** Anthropic, OpenAI, Gemini with `getProviderApiKey` (company_secrets + env fallback) and `createProvider` factory
- **Tool registry:** 8 modules (30+ tools), intent-based filtering via `getToolsForMessage` (max 15/request), `executeTool` with error handling
- **Service container:** 14 services injected via `createServiceContainer(db)`
- **Shared types/constants:** Validators, roles, statuses, trigger types all defined in `packages/shared/src/`

## File 1: `server/src/services/internal-agent/context-assembly.ts`

### Purpose

Builds the system prompt for the LLM from company data, department context, and conversation summary. Priority-ordered, truncated to fit `contextTokenBudget`.

### Interface

Uses the service factory pattern consistent with the rest of the codebase:

```typescript
export function contextAssemblyService(db: Db) {
  return {
    assembleContext(
      companyId: string,
      options: {
        pageContext?: string;
        departmentContext?: string; // department project ID
        conversationSummary?: string | null;
        contextTokenBudget?: number; // default 8000
      }
    ): Promise<{ systemPrompt: string; estimatedTokens: number }>,
  };
}
```

Note: `userId` removed from signature — it is not used in any assembly section. If user-specific context is needed later, it can be added then.

### Assembly Order (Priority High → Low)

1. **System instructions** (~500 tokens) — agent role definition, capabilities list, behavioral rules. Hardcoded template string.
2. **Company identity** (~500 tokens) — fetched from `companies` table (vision, mission) + `memory_items` where `layer = 'identity'` and matching `companyId`.
3. **Department context** (~1500 tokens) — if `departmentContext` is set, fetch department name/description from `projects` table + `memory_items` where `layer = 'domain'` and matching `departmentId`.
4. **Conversation summary** (variable) — the `summarizedContext` field from the active conversation, passed in via options.
5. **Page context** (~500 tokens) — simple string like "User is viewing the Tasks page" derived from the `pageContext` parameter.

### Token Estimation

`Math.ceil(text.length / 4)` — same formula used elsewhere in the codebase.

### Truncation Strategy

Assemble sections top→bottom. If adding a section would exceed `contextTokenBudget`, truncate that section to fit. Lower-priority sections may be dropped entirely. Returns both the assembled prompt and estimated token count.

## File 2: `server/src/services/internal-agent/conversation.ts`

### Purpose

Manages conversation lifecycle — creation, message appending, history retrieval, summarization, and reset.

### Interface

```typescript
export function conversationService(db: Db) {
  return {
    getOrCreateActive(companyId: string, userId: string): Promise<Conversation>,
    appendMessage(conversationId: string, message: MessageInput): Promise<Message>,
    getRecentMessages(conversationId: string, limit?: number): Promise<Message[]>,
    summarizeIfNeeded(conversationId: string, provider: LLMProvider, config: { model: string }): Promise<void>,
    reset(companyId: string, userId: string): Promise<Conversation>,
  };
}
```

### Method Details

**`getOrCreateActive(companyId, userId)`**
- Query `internalAgentConversations` for `status = 'active'` matching company+user.
- If none exists, insert one.
- Returns the conversation row. One active conversation per user per company.

**`appendMessage(conversationId, message)`**
- Insert into `internalAgentMessages`.
- Increment `messageCount` on the conversation.
- Returns the inserted message.
- Input includes: role, content, optional toolCalls/toolResults, optional pageContext/departmentContext, optional tokenCount and runId.

**`getRecentMessages(conversationId, limit?)`**
- Fetch last N messages (default 50) ordered by `createdAt asc`.
- Used to build conversation history for the LLM call.

**`summarizeIfNeeded(conversationId, provider, config)`**
- Pragmatic hybrid approach: message-count-based, not token-based.
- Count total messages. If ≤ 20, no-op.
- If > 20: take all messages except last 20. Feed to LLM with summarization prompt: "Summarize this conversation history concisely, preserving key decisions, action items, and context."
- Store result in `summarizedContext` on conversation row. Set `summarizedUpToMessageId`.
- Old messages stay in DB for retrieval/audit but won't be sent to LLM — only summary + last 20.

**`reset(companyId, userId)`**
- Set active conversation's status to `'archived'`.
- Create and return new active conversation.
- Archived conversation retains all messages for history.

## File 3: `server/src/services/internal-agent/agent-loop.ts`

### Purpose

The multi-turn LLM loop with streaming, tool execution, budget enforcement, action confirmation, and safety guards.

### Stream Chunk Types

```typescript
export type AgentStreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: ToolResult }
  | { type: 'action_confirmation'; toolName: string; params: unknown; runId: string }
  | { type: 'error'; message: string }
  | { type: 'done'; summary: RunSummary }
```

Note: `tool_call` includes `id` to correlate with tool results in the provider protocol.

### Interface

```typescript
export function agentLoopService(db: Db) {
  return {
    chat: async function* (params: ChatInput): AsyncGenerator<AgentStreamChunk>,
    confirmAction: async (companyId: string, runId: string, confirmed: boolean): Promise<void>,
  };
}
```

### `chat()` Flow

1. `conversationService.getOrCreateActive()` → get conversation
2. `appendMessage()` the user message
3. Auto-reject any pending action confirmations from prior turns (Gotcha 2.5 — on new user message, pending actions are expired)
4. `assembleContext()` → build system prompt
5. `getRecentMessages()` → build message history (summary + last 20)
6. Get config → resolve provider + API key via `getProviderApiKey` + `createProvider`
7. `getToolsForMessage()` → select relevant tools (max 15). Tools are selected **once** from the user message and remain fixed for all iterations in this turn. Rationale: re-selecting mid-loop based on LLM output creates unpredictability and the LLM can only call tools it was given. The initial selection already includes core query tools + intent-matched action tools, which covers multi-step workflows (query → act). If the LLM needs a tool it wasn't given, it can tell the user in its text response.
8. Create `internalAgentRuns` row (status: `'running'`). Set `conversationMessageId` to the user message ID from step 2.
9. **Budget check:** If `config.budgetMonthlyCents` is set and `spentMonthlyCents >= budgetMonthlyCents`, yield error chunk "Monthly budget exceeded", mark run failed, return.
10. **The loop** (max 10 iterations):
    - Call `provider.chat()` with messages + tools + system prompt
    - Stream `text` deltas as `{ type: 'text' }` chunks
    - On `tool_call`: check `requiresConfirmation` flag on the tool
      - **If confirmation required** (autonomy level 0 + write tool): yield `action_confirmation` chunk. The generator internally creates a `Promise` and `await`s it. `confirmAction()` resolves this promise (with `confirmed: true/false`). The route handler stores the `resolve` function keyed by `runId` in an in-memory `Map<string, { resolve, timer }>`. A 5-minute `setTimeout` auto-rejects if no response. On server restart, pending actions are naturally lost (no active SSE stream). On new user message (step 3), any pending action for that user is auto-rejected before the new turn starts.
      - **If no confirmation needed**: execute tool via `executeTool()`, yield `tool_result` chunk, append tool_call + tool_result messages, loop back for next LLM call
    - On `done` from provider: accumulate token usage
11. **Iteration limit (Gotcha 2.3):** If 10 rounds hit, inject system message "You have reached the maximum number of tool rounds. Please provide your final response." Give LLM one final call with no tools. If it still tries tool_call, return accumulated text + "I ran into my processing limit."
12. **Summarize if needed:** After the loop completes, call `conversationService.summarizeIfNeeded()` so the *next* turn benefits from compressed history. This runs asynchronously (fire-and-forget) — don't block the response.
13. **Finalize:** Update run record (status, costCents, durationMs, toolsCalled, summary). Update `config.spentMonthlyCents`. Append assistant message to conversation. Yield `done` chunk.

### Error Handling

If `provider.chat()` throws mid-stream (network error, rate limit, API key revoked):
1. Mark the run as `'failed'` with `errorMessage` set.
2. If any text was accumulated before the error, append it as a partial assistant message to the conversation.
3. Yield `{ type: 'error', message: 'Provider error: <message>. Your previous messages are saved.' }`.
4. Yield `done` chunk with whatever cost/duration was accumulated.
5. Do not retry — let the user send a new message to try again.

### Total Token Guard (Gotcha 2.4)

Before each `provider.chat()` call, estimate total tokens: `systemPrompt tokens + sum of message content lengths / 4 + tool definitions (~100 tokens each)`. If this exceeds 80% of the provider's max context (stored as a simple lookup: Claude=200K, GPT-4o=128K, Gemini=1M), trigger `summarizeIfNeeded` synchronously before proceeding. This is a safety net — the message-count-based summarization at step 12 handles the common case.

### `confirmAction(companyId, runId, confirmed)`

- Look up the pending action stored in the run's metadata
- If `confirmed`: execute the tool, resume the loop
- If not confirmed (or timeout — 5 min TTL checked by caller): cancel, append system message "Action cancelled by user", let LLM continue without that tool result

### Cost Tracking

After the loop completes, calculate `costCents` from token usage using a provider-specific pricing lookup map. Write to `internalAgentRuns.costCents` and increment `internalAgentConfig.spentMonthlyCents`. No `cost_events` row — that table is for heartbeat agents with an `agentId` FK. The internal agent tracks cost on its own config table.

### Provider Pricing Map

```typescript
const PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 300, output: 1500 },
  'claude-haiku-4-5-20251001': { input: 80, output: 400 },
  'gpt-4o': { input: 250, output: 1000 },
  'gpt-4o-mini': { input: 15, output: 60 },
  'gemini-2.0-flash': { input: 10, output: 40 },
};
// costCents = Math.ceil((input * pricing.input + output * pricing.output) / 1_000_000)
```

Note: This map is extracted as a top-level constant (`MODEL_PRICING`) in the agent-loop module for easy updates when pricing changes. Unknown models default to the most expensive tier (Claude Sonnet pricing) to avoid under-counting.

### Security (from spec)

- **RBAC enforcement per tool**: permission check at tool execution layer via `tool.requiredRole` vs `userRole`
- **Action confirmation**: write actions require user approval before execution (autonomy level 0)
- **Tool result sandboxing**: tool results are data only; LLM cannot escalate permissions
- **Max tool rounds**: 10-round limit prevents unlimited tool calls

## Conversation History → LLM Messages Mapping

A helper function `buildMessagesForProvider(messages, summarizedContext)` converts DB message rows into `ChatMessage[]` for the provider:

- If `summarizedContext` exists, prepend as: `{ role: 'assistant', content: '[Previous conversation summary]: ' + summary }`
- `role: 'user'` → `{ role: 'user', content }`
- `role: 'assistant'` → `{ role: 'assistant', content }`
- `role: 'tool_call'` → `{ role: 'assistant', content: '', toolCalls: msg.toolCalls }` — The `toolCalls` JSONB contains `Array<{ id: string; name: string; input: unknown }>`. Each provider translates this to its native format (Anthropic: `tool_use` content blocks, OpenAI: `tool_calls` array, Gemini: `functionCall` parts).
- `role: 'tool_result'` → `{ role: 'user', content: '', toolResults: msg.toolResults }` — The `toolResults` JSONB contains `Array<{ toolCallId: string; name: string; result: string }>`. Maps to `ChatMessage.toolResults` which is already typed in `providers/types.ts`.
- `role: 'system'` → skipped (system context goes in `systemPrompt` param, not messages)

The `ChatMessage` type in `providers/types.ts` needs one addition — a `toolCalls` field on assistant messages:

```typescript
export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  toolResults?: ToolResultMessage[];  // existing
  toolCalls?: { id: string; name: string; input: unknown }[];  // new — for tool_call messages
}
```

Each provider implementation handles the translation: Anthropic converts `toolCalls` to `tool_use` content blocks, OpenAI to `tool_calls` array, Gemini to `functionCall` parts.

## Tests

### `server/src/__tests__/agent-loop.test.ts`
- Mock LLM provider to return tool_call → text sequence
- Test loop executes tool and yields text response
- Test max iterations guard stops at 10 rounds
- Test budget exceeded halts conversation
- Test action confirmation flow (yield pending → confirm → execute)
- Test action confirmation timeout (5 min TTL → auto-reject)
- Test cost tracking updates `internalAgentRuns` and `internalAgentConfig.spentMonthlyCents`
- Test provider error mid-stream saves partial response and marks run failed
- Test DB role → ChatMessage role mapping (tool_call, tool_result conversion)

### `server/src/__tests__/conversation-service.test.ts`
- Test `getOrCreateActive` creates new conversation
- Test `getOrCreateActive` returns existing active conversation
- Test `appendMessage` inserts message and increments messageCount
- Test `summarizeIfNeeded` no-ops when ≤ 20 messages
- Test `summarizeIfNeeded` triggers summarization when > 20 messages
- Test `reset` archives old and creates new conversation

### `server/src/__tests__/context-assembly.test.ts`
- Test assembles company identity from companies table + identity memory items
- Test includes department context when departmentContext is set
- Test truncates lower-priority sections when budget exceeded
- Test token estimation formula
- Test handles null/missing vision and mission gracefully

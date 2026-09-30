# API Adapter Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 code quality issues found during code review of the `feature/api-adapters` branch.

**Architecture:** Extract shared feed module from two components with identical logic, fix a regex bug in error mapping, remove dead try/catch blocks, register API adapter types in the UI registry, add configurable `max_tokens` across all API adapters, and remove a stale closure reference.

**Tech Stack:** TypeScript, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-17-api-adapter-review-fixes-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `ui/src/lib/agent-feed.ts` | Shared feed types, constants, and helpers |
| Modify | `ui/src/pages/ActiveAgents.tsx` | Remove duplicated feed code, import from shared module |
| Modify | `ui/src/components/ActiveAgentsPanel.tsx` | Remove duplicated feed code, import from shared module |
| Modify | `server/src/adapters/api-common.ts` | Fix regex bug in `mapErrorToResult` |
| Modify | `server/src/__tests__/api-common.test.ts` | Add regression test for regex fix |
| Modify | `server/src/adapters/claude-api/models.ts` | Remove dead try/catch |
| Modify | `server/src/adapters/openai-api/models.ts` | Remove dead try/catch |
| Modify | `server/src/adapters/gemini-api/models.ts` | Remove dead try/catch |
| Modify | `ui/src/adapters/registry.ts` | Register API adapter types |
| Modify | `server/src/adapters/claude-api/execute.ts` | Read `config.maxTokens` |
| Modify | `server/src/adapters/openai-api/execute.ts` | Read `config.maxTokens` |
| Modify | `server/src/adapters/gemini-api/execute.ts` | Read `config.maxTokens` |
| Modify | `server/src/__tests__/claude-api-adapter.test.ts` | Add maxTokens test |
| Create | `server/src/__tests__/api-adapter-max-tokens.test.ts` | Tests for OpenAI/Gemini maxTokens |

> **Task ordering:** Tasks 1-4 are independent. Task 5 and Task 6 both modify `ActiveAgents.tsx` — execute Task 5 before Task 6.

---

## Chunk 1: Server-side fixes (Tasks 1-3)

### Task 1: Fix regex bug in `mapErrorToResult`

**Files:**
- Modify: `server/src/adapters/api-common.ts:201`
- Modify: `server/src/__tests__/api-common.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/api-common.test.ts` inside the existing `describe("mapErrorToResult")` block:

```typescript
  it("maps 'Invalid API key' messages to authentication_error", () => {
    const err = new Error("Invalid Anthropic API key provided");
    const result = mapErrorToResult(err, "anthropic");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("authentication_error");
    expect(result.errorMessage).toContain("Invalid API key");
  });

  it("maps 'invalid api key' messages case-insensitively", () => {
    const err = new Error("Error: invalid api key format");
    const result = mapErrorToResult(err, "openai");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("authentication_error");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/api-common.test.ts --reporter=verbose`
Expected: FAIL — "Invalid Anthropic API key provided" maps to `unknown_error` instead of `authentication_error`

- [ ] **Step 3: Fix the regex bug**

In `server/src/adapters/api-common.ts`, change line 201 from:
```typescript
    msg.toLowerCase().includes("invalid.*api.*key") ||
```
to:
```typescript
    /invalid.*api.*key/i.test(msg) ||
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/api-common.test.ts --reporter=verbose`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/api-common.ts server/src/__tests__/api-common.test.ts
git commit -m "fix: use regex instead of string includes for API key error matching"
```

---

### Task 2: Remove dead try/catch in `listModels` functions

**Files:**
- Modify: `server/src/adapters/claude-api/models.ts`
- Modify: `server/src/adapters/openai-api/models.ts`
- Modify: `server/src/adapters/gemini-api/models.ts`

- [ ] **Step 1: Run existing adapter-models tests to confirm baseline**

Run: `cd server && npx vitest run src/__tests__/adapter-models.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 2: Remove dead try/catch from claude-api/models.ts**

Replace the function body:
```typescript
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return CLAUDE_MODELS;
}
```

- [ ] **Step 3: Remove dead try/catch from openai-api/models.ts**

Replace the function body:
```typescript
export async function listOpenAIModels(): Promise<AdapterModel[]> {
  return OPENAI_MODELS;
}
```

- [ ] **Step 4: Remove dead try/catch from gemini-api/models.ts**

Replace the function body:
```typescript
export async function listGeminiModels(): Promise<AdapterModel[]> {
  return GEMINI_MODELS;
}
```

- [ ] **Step 5: Run adapter-models tests again**

Run: `cd server && npx vitest run src/__tests__/adapter-models.test.ts --reporter=verbose`
Expected: PASS — no behavior change

- [ ] **Step 6: Commit**

```bash
git add server/src/adapters/claude-api/models.ts server/src/adapters/openai-api/models.ts server/src/adapters/gemini-api/models.ts
git commit -m "refactor: remove dead try/catch from listModels functions"
```

---

### Task 3: Configurable `max_tokens` for API adapters

**Files:**
- Modify: `server/src/adapters/claude-api/execute.ts:34-35`
- Modify: `server/src/adapters/openai-api/execute.ts:33-39`
- Modify: `server/src/adapters/gemini-api/execute.ts:38-41`
- Modify: `server/src/__tests__/claude-api-adapter.test.ts`
- Create: `server/src/__tests__/api-adapter-max-tokens.test.ts`

- [ ] **Step 1: Write failing test for Claude adapter maxTokens**

Add to `server/src/__tests__/claude-api-adapter.test.ts` inside the existing describe block:

```typescript
  it("uses config.maxTokens when provided", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    });

    await execute(makeCtx({ maxTokens: 8192 }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 8192 }),
    );
  });

  it("defaults to 4096 max_tokens when not configured", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    });

    await execute(makeCtx({ maxTokens: undefined }));

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 4096 }),
    );
  });
```

- [ ] **Step 2: Run test to verify the first test fails**

Run: `cd server && npx vitest run src/__tests__/claude-api-adapter.test.ts --reporter=verbose`
Expected: FAIL — `maxTokens: 8192` is ignored, always sends `4096`

- [ ] **Step 3: Implement configurable max_tokens in Claude adapter**

In `server/src/adapters/claude-api/execute.ts`, after the `model` line (line 16), add:

```typescript
  const maxTokens = typeof config.maxTokens === "number" && config.maxTokens > 0
    ? config.maxTokens
    : 4096;
```

Then change line 35 from `max_tokens: 4096,` to `max_tokens: maxTokens,`.

- [ ] **Step 4: Run Claude adapter tests**

Run: `cd server && npx vitest run src/__tests__/claude-api-adapter.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Write tests for OpenAI and Gemini maxTokens**

Create `server/src/__tests__/api-adapter-max-tokens.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

// --- OpenAI mocks ---
vi.mock("openai", () => {
  const createMock = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: createMock } },
    })),
    __createMock: createMock,
  };
});

// --- Gemini mocks ---
vi.mock("@google/generative-ai", () => {
  const generateContentMock = vi.fn();
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: generateContentMock,
      }),
    })),
    __generateContentMock: generateContentMock,
  };
});

vi.mock("../adapters/api-common.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    resolveApiKey: vi.fn().mockResolvedValue("test-key"),
  };
});

import { execute as executeOpenAI } from "../adapters/openai-api/execute.js";
import { execute as executeGemini } from "../adapters/gemini-api/execute.js";

const OpenAI = (await import("openai")) as any;
const openaiCreateMock = OpenAI.__createMock as ReturnType<typeof vi.fn>;

const GeminiSDK = (await import("@google/generative-ai")) as any;
const geminiGenerateMock = GeminiSDK.__generateContentMock as ReturnType<typeof vi.fn>;

function makeCtx(adapterType: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", adapterType } as any,
    runtime: {} as any,
    config: { model: undefined, ...overrides },
    context: {
      company: { name: "Test Co" },
      issueTitle: "Test task",
    },
    onLog: vi.fn().mockResolvedValue(undefined),
    onMeta: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OpenAI max_tokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes config.maxTokens as max_tokens", async () => {
    openaiCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await executeOpenAI(makeCtx("openai_api", { maxTokens: 2048 }));

    expect(openaiCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 2048 }),
    );
  });

  it("omits max_tokens when not configured", async () => {
    openaiCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await executeOpenAI(makeCtx("openai_api"));

    const callArgs = openaiCreateMock.mock.calls[0][0];
    expect(callArgs.max_tokens).toBeUndefined();
  });
});

describe("Gemini maxOutputTokens", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes config.maxTokens as maxOutputTokens in generationConfig", async () => {
    geminiGenerateMock.mockResolvedValue({
      response: {
        text: () => "ok",
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await executeGemini(makeCtx("gemini_api", { maxTokens: 2048 }));

    expect(geminiGenerateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        generationConfig: { maxOutputTokens: 2048 },
      }),
    );
  });

  it("omits maxOutputTokens when not configured", async () => {
    geminiGenerateMock.mockResolvedValue({
      response: {
        text: () => "ok",
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    });

    await executeGemini(makeCtx("gemini_api"));

    const callArgs = geminiGenerateMock.mock.calls[0][0];
    expect(callArgs.generationConfig).toEqual({});
  });
});
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run: `cd server && npx vitest run src/__tests__/api-adapter-max-tokens.test.ts --reporter=verbose`
Expected: FAIL — OpenAI never passes `max_tokens`, Gemini never passes `maxOutputTokens`

- [ ] **Step 7: Implement configurable max_tokens in OpenAI adapter**

In `server/src/adapters/openai-api/execute.ts`, after the `model` line (line 16), add:

```typescript
  const maxTokens = typeof config.maxTokens === "number" && config.maxTokens > 0
    ? config.maxTokens
    : undefined;
```

Then update the `client.chat.completions.create` call to include `max_tokens`:

```typescript
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
    });
```

- [ ] **Step 8: Implement configurable max_tokens in Gemini adapter**

In `server/src/adapters/gemini-api/execute.ts`, after the `modelId` line (line 16), add:

```typescript
  const maxOutputTokens = typeof config.maxTokens === "number" && config.maxTokens > 0
    ? config.maxTokens
    : undefined;
```

Then update the `generationConfig` in the `generateContent` call:

```typescript
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      generationConfig: {
        ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      },
    });
```

- [ ] **Step 9: Run all adapter tests**

Run: `cd server && npx vitest run src/__tests__/claude-api-adapter.test.ts src/__tests__/api-adapter-max-tokens.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/src/adapters/claude-api/execute.ts server/src/adapters/openai-api/execute.ts server/src/adapters/gemini-api/execute.ts server/src/__tests__/claude-api-adapter.test.ts server/src/__tests__/api-adapter-max-tokens.test.ts
git commit -m "feat: support configurable maxTokens for all API adapters"
```

---

## Chunk 2: UI-side fixes (Tasks 4-6)

### Task 4: Register API types in UI adapter registry

**Files:**
- Modify: `ui/src/adapters/registry.ts`

- [ ] **Step 1: Add API adapter types to registry map**

In `ui/src/adapters/registry.ts`, insert three `.set()` calls between the map construction (line 12) and the `export function getUIAdapter` (line 14). API adapters return plain text responses, so they reuse `processUIAdapter`:

```typescript
// Insert these 3 lines after the closing ");" of the Map constructor and before "export function getUIAdapter":
adaptersByType.set("claude_api", processUIAdapter);
adaptersByType.set("openai_api", processUIAdapter);
adaptersByType.set("gemini_api", processUIAdapter);
```

- [ ] **Step 2: Type-check the UI**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add ui/src/adapters/registry.ts
git commit -m "fix: register API adapter types in UI adapter registry"
```

---

### Task 5: Extract shared feed module

**Files:**
- Create: `ui/src/lib/agent-feed.ts`
- Modify: `ui/src/pages/ActiveAgents.tsx`
- Modify: `ui/src/components/ActiveAgentsPanel.tsx`

- [ ] **Step 1: Create the shared feed module**

Create `ui/src/lib/agent-feed.ts` with the shared types, constants, and functions extracted from both components:

```typescript
import type { MutableRefObject } from "react";
import type { LiveRunForIssue } from "../api/heartbeats";
import { getUIAdapter } from "../adapters";
import type { TranscriptEntry } from "../adapters";

// ── Types ──────────────────────────────────────────────────────────

export type FeedTone = "info" | "warn" | "error" | "assistant" | "tool";

export interface FeedItem {
  id: string;
  ts: string;
  runId: string;
  agentId: string;
  agentName: string;
  text: string;
  tone: FeedTone;
  dedupeKey: string;
  streamingKind?: "assistant" | "thinking";
}

// ── Constants ──────────────────────────────────────────────────────

export const MAX_FEED_ITEMS = 40;
export const MAX_FEED_TEXT_LENGTH = 220;
export const MAX_STREAMING_TEXT_LENGTH = 4000;

// ── Helpers ────────────────────────────────────────────────────────

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function summarizeEntry(entry: TranscriptEntry): { text: string; tone: FeedTone } | null {
  if (entry.kind === "assistant") {
    const text = entry.text.trim();
    return text ? { text, tone: "assistant" } : null;
  }
  if (entry.kind === "thinking") {
    const text = entry.text.trim();
    return text ? { text: `[thinking] ${text}`, tone: "info" } : null;
  }
  if (entry.kind === "tool_call") {
    return { text: `tool ${entry.name}`, tone: "tool" };
  }
  if (entry.kind === "tool_result") {
    const base = entry.content.trim();
    return {
      text: entry.isError ? `tool error: ${base}` : `tool result: ${base}`,
      tone: entry.isError ? "error" : "tool",
    };
  }
  if (entry.kind === "stderr") {
    const text = entry.text.trim();
    return text ? { text, tone: "error" } : null;
  }
  if (entry.kind === "system") {
    const text = entry.text.trim();
    return text ? { text, tone: "warn" } : null;
  }
  if (entry.kind === "stdout") {
    const text = entry.text.trim();
    return text ? { text, tone: "info" } : null;
  }
  return null;
}

export function createFeedItem(
  run: LiveRunForIssue,
  ts: string,
  text: string,
  tone: FeedTone,
  nextId: number,
  options?: {
    streamingKind?: "assistant" | "thinking";
    preserveWhitespace?: boolean;
  },
): FeedItem | null {
  if (!text.trim()) return null;
  const base = options?.preserveWhitespace ? text : text.trim();
  const maxLength = options?.streamingKind ? MAX_STREAMING_TEXT_LENGTH : MAX_FEED_TEXT_LENGTH;
  const normalized = base.length > maxLength ? base.slice(-maxLength) : base;
  return {
    id: `${run.id}:${nextId}`,
    ts,
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    text: normalized,
    tone,
    dedupeKey: `feed:${run.id}:${ts}:${tone}:${normalized}`,
    streamingKind: options?.streamingKind,
  };
}

export function parseStdoutChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stdout`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");
  const adapter = getUIAdapter(run.adapterType);

  const summarized: Array<{ text: string; tone: FeedTone; streamingKind?: "assistant" | "thinking" }> = [];
  const appendSummary = (entry: TranscriptEntry) => {
    if (entry.kind === "assistant" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "assistant") {
        last.text += text;
      } else {
        summarized.push({ text, tone: "assistant", streamingKind: "assistant" });
      }
      return;
    }
    if (entry.kind === "thinking" && entry.delta) {
      const text = entry.text;
      if (!text.trim()) return;
      const last = summarized[summarized.length - 1];
      if (last && last.streamingKind === "thinking") {
        last.text += text;
      } else {
        summarized.push({ text: `[thinking] ${text}`, tone: "info", streamingKind: "thinking" });
      }
      return;
    }
    const summary = summarizeEntry(entry);
    if (!summary) return;
    summarized.push({ text: summary.text, tone: summary.tone });
  };

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = adapter.parseStdoutLine(trimmed, ts);
    if (parsed.length === 0) {
      const fallback = createFeedItem(run, ts, trimmed, "info", nextIdRef.current++);
      if (fallback) items.push(fallback);
      continue;
    }
    for (const entry of parsed) {
      appendSummary(entry);
    }
  }

  for (const summary of summarized) {
    const item = createFeedItem(run, ts, summary.text, summary.tone, nextIdRef.current++, {
      streamingKind: summary.streamingKind,
      preserveWhitespace: !!summary.streamingKind,
    });
    if (item) items.push(item);
  }

  return items;
}

export function parseStderrChunk(
  run: LiveRunForIssue,
  chunk: string,
  ts: string,
  pendingByRun: Map<string, string>,
  nextIdRef: MutableRefObject<number>,
): FeedItem[] {
  const pendingKey = `${run.id}:stderr`;
  const combined = `${pendingByRun.get(pendingKey) ?? ""}${chunk}`;
  const split = combined.split(/\r?\n/);
  pendingByRun.set(pendingKey, split.pop() ?? "");

  const items: FeedItem[] = [];
  for (const line of split.slice(-8)) {
    const item = createFeedItem(run, ts, line, "error", nextIdRef.current++);
    if (item) items.push(item);
  }
  return items;
}

export function isRunActive(run: LiveRunForIssue): boolean {
  return run.status === "queued" || run.status === "running";
}

export function mergeFeedItems(
  existing: FeedItem[],
  newItems: FeedItem[],
  seenKeys: Set<string>,
  maxItems: number,
): FeedItem[] {
  const result = [...existing];
  for (const item of newItems) {
    if (seenKeys.has(item.dedupeKey)) continue;
    seenKeys.add(item.dedupeKey);

    const last = result[result.length - 1];
    if (
      item.streamingKind &&
      last &&
      last.runId === item.runId &&
      last.streamingKind === item.streamingKind
    ) {
      const mergedText = `${last.text}${item.text}`;
      result[result.length - 1] = {
        ...last,
        ts: item.ts,
        text: mergedText.length > MAX_STREAMING_TEXT_LENGTH
          ? mergedText.slice(-MAX_STREAMING_TEXT_LENGTH)
          : mergedText,
        dedupeKey: last.dedupeKey,
      };
      continue;
    }

    result.push(item);
  }
  if (seenKeys.size > 6000) seenKeys.clear();
  return result.slice(-maxItems);
}
```

- [ ] **Step 1b: Verify the module compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS — the new module compiles without errors

- [ ] **Step 2: Update `ActiveAgentsPanel.tsx` to use shared module**

**Imports:** Replace lines 1-12 with the following. Note: remove `getUIAdapter` and `TranscriptEntry` imports (now used internally by the shared module), and remove `type MutableRefObject` from the React import:

```typescript
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue, LiveEvent } from "@armyofagents/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { ExternalLink } from "lucide-react";
import { Identity } from "./Identity";
import {
  type FeedItem,
  MAX_FEED_ITEMS,
  MAX_STREAMING_TEXT_LENGTH,
  readString,
  createFeedItem,
  parseStdoutChunk,
  parseStderrChunk,
  isRunActive,
  mergeFeedItems,
} from "../lib/agent-feed";
```

**Remove local definitions:** Delete everything between the new imports and `interface ActiveAgentsPanelProps` — specifically lines 14-191 in the original file:
- `type FeedTone` (line 14)
- `interface FeedItem` (lines 16-26)
- `const MAX_FEED_ITEMS`, `MAX_FEED_TEXT_LENGTH`, `MAX_STREAMING_TEXT_LENGTH` (lines 28-30)
- `function readString` (lines 33-35)
- `function summarizeEntry` (lines 37-69)
- `function createFeedItem` (lines 71-97)
- `function parseStdoutChunk` (lines 99-167)
- `function parseStderrChunk` (lines 169-187)
- `function isRunActive` (lines 189-191)

Keep `const MIN_DASHBOARD_RUNS = 4` (line 31) — this is panel-specific.

**Replace `appendItems`:** Inside the WebSocket `useEffect`, find the `appendItems` function (lines 248-286) and replace it with:

```typescript
    const appendItems = (runId: string, items: FeedItem[]) => {
      if (items.length === 0) return;
      setFeedByRun((prev) => {
        const next = new Map(prev);
        const existing = next.get(runId) ?? [];
        next.set(runId, mergeFeedItems(existing, items, seenKeysRef.current, MAX_FEED_ITEMS));
        return next;
      });
    };
```

This replaces the inline dedup/merge logic (seenKeys check, streaming merge, 6000-key cleanup, slice) with the equivalent `mergeFeedItems` call.

- [ ] **Step 3: Update `ActiveAgents.tsx` to use shared module**

**Imports:** Replace lines 1-15 with the following. Note: keep `getUIAdapter` import (used in log-fetching effect), remove `TranscriptEntry` and `type MutableRefObject`:

```typescript
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import type { Issue, LiveEvent } from "@armyofagents/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { getUIAdapter } from "../adapters";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ExternalLink, Radio } from "lucide-react";
import { Identity } from "../components/Identity";
import { EmptyState } from "../components/EmptyState";
import {
  type FeedItem,
  MAX_FEED_ITEMS,
  MAX_STREAMING_TEXT_LENGTH,
  readString,
  summarizeEntry,
  createFeedItem,
  parseStdoutChunk,
  parseStderrChunk,
  isRunActive,
  mergeFeedItems,
} from "../lib/agent-feed";
```

**Remove local definitions:** Delete lines 17-188 (the comment `// --- Feed types & helpers...` through `function isRunActive`). Same set as Panel minus `MIN_DASHBOARD_RUNS`.

**Replace `appendItems`:** Inside the WebSocket `useEffect`, find the `appendItems` function (lines 330-355) and replace with the same `mergeFeedItems` pattern as Step 2 above.

- [ ] **Step 4: Type-check the UI**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/agent-feed.ts ui/src/pages/ActiveAgents.tsx ui/src/components/ActiveAgentsPanel.tsx
git commit -m "refactor: extract shared agent feed module from page and panel"
```

---

### Task 6: Remove stale `feedByRun` from useEffect filter

> **Note:** This task modifies `ActiveAgents.tsx` which was also modified in Task 5. Execute after Task 5.

**Files:**
- Modify: `ui/src/pages/ActiveAgents.tsx`

- [ ] **Step 1: Remove the `feedByRun.has()` check and eslint-disable comment**

In the log-fetching `useEffect` inside `ActiveAgents.tsx`, change the filter from:

```typescript
    const completedWithoutFeed = runs.filter(
      (r) => !isRunActive(r) && !feedByRun.has(r.id) && !fetchedLogRunsRef.current.has(r.id),
    );
```

to:

```typescript
    const completedWithoutFeed = runs.filter(
      (r) => !isRunActive(r) && !fetchedLogRunsRef.current.has(r.id),
    );
```

And remove the eslint-disable comment:
```typescript
    // eslint-disable-next-line react-hooks/exhaustive-deps
```

- [ ] **Step 2: Type-check the UI**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/ActiveAgents.tsx
git commit -m "fix: remove stale feedByRun closure from log-fetch useEffect"
```

---

## Final Verification

- [ ] **Run all server tests**

Run: `cd server && npx vitest run --reporter=verbose`
Expected: All tests PASS

- [ ] **Type-check the full UI**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS

- [ ] **Visual smoke test**

Open the app in the browser:
1. Navigate to Home dashboard — verify the Agents panel renders feed items for recent runs
2. Navigate to Live Agents page — verify cards render with feed items for completed runs
3. If possible, trigger an agent run and verify live streaming works on both views
4. Verify API adapter runs (openai_api, claude_api, gemini_api) display without errors

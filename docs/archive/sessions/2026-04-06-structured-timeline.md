# Structured Timeline Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw `<pre>` text dump in the workspace timeline with structured, department-aware rendering that shows agent work as scannable pills, cards, and messages.

**Architecture:** Port AoA's `normalizeTranscript()` logic into a new `transcript/` directory under workspace components. Add a new aggregation pass (inspired by vibe-kanban) and a department-aware entry classifier. Build focused rendering components (pills, cards, messages). Wire into existing `TimelineAgentMessage` to replace the `<pre>` dump.

**Tech Stack:** React, TypeScript, TailwindCSS, Vitest, @testing-library/react, Lucide icons

**Spec:** `docs/superpowers/specs/2026-04-06-structured-timeline-design.md`

**Reference file to consult:** `reference/paperclip-RunTranscriptView.tsx` (AoA's transcript rendering — copied into AoA. The `normalizeTranscript()` function and helpers are ported from here)

**CRITICAL PORT NOTES (AoA vs AoA TranscriptEntry differences):**
1. AoA's `tool_call` entry has NO `toolUseId` field (AoA's does). When porting normalizeTranscript, do NOT reference `entry.toolUseId` on tool_call entries — use `extractToolUseId(entry.input)` only.
2. AoA's `tool_result` entry has NO `toolName` field (AoA's does). Use `"tool"` as hardcoded fallback name for unmatched tool_result entries.
3. Remove the `density: TranscriptDensity` parameter from both `summarizeToolInput` and `summarizeToolResult` — always use the "comfortable" defaults (120 char max). We handle density at the component level instead.

---

## File Structure

All new files go in `ui/src/components/workspace/transcript/`:

| File | Responsibility |
|------|---------------|
| `types.ts` | TranscriptBlock, AggregatedGroup, EntryCategory, DepartmentType types |
| `normalize-transcript.ts` | normalizeTranscript() + all helpers (ported from AoA) |
| `classify-entry.ts` | classifyToolEntry() — maps tool name + department to EntryCategory |
| `aggregate-blocks.ts` | aggregateBlocks() — pass 2 consecutive grouping |
| `StructuredRunBlock.tsx` | Container: fetches log, parses, normalizes, aggregates, renders |
| `TranscriptToolPill.tsx` | Single tool call pill (file_read, search, command, etc.) |
| `TranscriptMessageBlock.tsx` | Assistant/user chat bubbles with markdown |
| `TranscriptThinkingBlock.tsx` | Collapsible thinking (dot for previous turns) |
| `TranscriptAggregatedGroup.tsx` | Grouped pills ("Read · 5 files") |
| `TranscriptEditGroup.tsx` | Grouped file edits ("auth.ts · 3 edits · +6 -2") |
| `TranscriptProgressBlock.tsx` | TodoWrite checklist with progress bar |
| `TranscriptEventRow.tsx` | Init, result, system events (single-line) |
| `TranscriptErrorBlock.tsx` | Stderr groups (red accent) |
| `TranscriptStdoutBlock.tsx` | Raw stdout (collapsed by default) |
| `TranscriptToolCard.tsx` | Department-specific rich card (image, report, draft) |

Tests go in `ui/src/__tests__/transcript/`:

| File | Tests for |
|------|----------|
| `normalize-transcript.test.ts` | normalizeTranscript(), groupCommandBlocks(), groupToolBlocks() |
| `classify-entry.test.ts` | classifyToolEntry() all categories |
| `aggregate-blocks.test.ts` | aggregateBlocks() grouping rules |
| `StructuredRunBlock.test.tsx` | Integration: full pipeline rendering |

---

## Task 1: Types

**Files:**
- Create: `ui/src/components/workspace/transcript/types.ts`

- [ ] **Step 1: Create the types file with TranscriptBlock**

```typescript
// ui/src/components/workspace/transcript/types.ts

// --- Department types (matches project.functionType field) ---

export type DepartmentType =
  | "software_development"
  | "marketing"
  | "finance"
  | "support"
  | "hr"
  | "legal"
  | "research"
  | "design"
  | "operations"
  | "general"
  | "custom";

// --- TranscriptBlock (ported from AoA RunTranscriptView.tsx:30-107) ---

export type TranscriptBlock =
  | {
      type: "message";
      role: "assistant" | "user";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "thinking";
      ts: string;
      text: string;
      streaming: boolean;
    }
  | {
      type: "tool";
      ts: string;
      endTs?: string;
      name: string;
      toolUseId?: string;
      input: unknown;
      result?: string;
      isError?: boolean;
      status: "running" | "completed" | "error";
    }
  | {
      type: "activity";
      ts: string;
      activityId?: string;
      name: string;
      status: "running" | "completed";
    }
  | {
      type: "command_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "tool_group";
      ts: string;
      endTs?: string;
      items: Array<{
        ts: string;
        endTs?: string;
        name: string;
        input: unknown;
        result?: string;
        isError?: boolean;
        status: "running" | "completed" | "error";
      }>;
    }
  | {
      type: "stderr_group";
      ts: string;
      endTs?: string;
      lines: Array<{ ts: string; text: string }>;
    }
  | {
      type: "stdout";
      ts: string;
      text: string;
    }
  | {
      type: "event";
      ts: string;
      label: string;
      tone: "info" | "warn" | "error" | "neutral";
      text: string;
      detail?: string;
    };

// --- Entry categories for classification ---

export type UniversalCategory =
  | "message"
  | "thinking"
  | "file_read"
  | "file_edit"
  | "search"
  | "command"
  | "web"
  | "api_call"
  | "file_upload"
  | "file_download"
  | "memory_operation"
  | "approval_requested"
  | "progress_update"
  | "audio_generated"
  | "system_event"
  | "error"
  | "generic_tool";

export type SoftwareDevCategory =
  | "git_operation"
  | "test_run"
  | "build"
  | "diff_view";

export type MarketingCategory =
  | "content_generated"
  | "image_generated"
  | "video_generated"
  | "research"
  | "social_post"
  | "seo_analysis"
  | "email_campaign"
  | "analytics_pulled";

export type FinanceCategory =
  | "calculation"
  | "data_query"
  | "report_generated"
  | "chart_generated"
  | "invoice_generated"
  | "compliance_check";

export type SupportCategory =
  | "ticket_lookup"
  | "knowledge_search"
  | "draft_response"
  | "escalation"
  | "sentiment_analyzed"
  | "macro_applied";

export type DesignCategory =
  | "design_asset"
  | "brand_check"
  | "media_processed"
  | "animation_created"
  | "prototype_created";

export type HRCategory =
  | "candidate_lookup"
  | "document_drafted"
  | "schedule_action"
  | "background_check"
  | "onboarding_step";

export type LegalCategory =
  | "contract_drafted"
  | "clause_reviewed"
  | "regulatory_check";

export type ResearchCategory =
  | "literature_search"
  | "data_analysis"
  | "citation"
  | "experiment_run";

export type OperationsCategory =
  | "workflow_triggered"
  | "inventory_check"
  | "notification_sent";

export type EntryCategory =
  | UniversalCategory
  | SoftwareDevCategory
  | MarketingCategory
  | FinanceCategory
  | SupportCategory
  | DesignCategory
  | HRCategory
  | LegalCategory
  | ResearchCategory
  | OperationsCategory;

// --- Aggregated group types (pass 2 output) ---

export type AggregatedGroup =
  | { type: "read_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "edit_group"; filePath: string; items: Extract<TranscriptBlock, { type: "tool" }>[]; totalAdditions: number; totalDeletions: number }
  | { type: "multi_edit_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; fileCount: number }
  | { type: "search_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "web_group"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "command_group_agg"; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number }
  | { type: "thinking_group"; items: Extract<TranscriptBlock, { type: "thinking" }>[]; isPreviousTurn: boolean }
  | { type: "generic_group"; category: EntryCategory; items: Extract<TranscriptBlock, { type: "tool" }>[]; count: number };

/** Union of block or aggregated group — the input to renderers */
export type DisplayBlock = TranscriptBlock | AggregatedGroup;

/** Aggregated group type strings for runtime checking */
const AGGREGATED_GROUP_TYPES = new Set([
  "read_group", "edit_group", "multi_edit_group", "search_group",
  "web_group", "command_group_agg", "thinking_group", "generic_group",
]);

/** Check if a DisplayBlock is an AggregatedGroup */
export function isAggregatedGroup(block: DisplayBlock): block is AggregatedGroup {
  return AGGREGATED_GROUP_TYPES.has(block.type);
}

// --- Pill metadata helpers ---

/** Parsed +/- stats from a file edit tool result */
export interface EditStats {
  additions: number;
  deletions: number;
}

/** Categories that render as rich cards instead of pills */
export const RICH_CARD_CATEGORIES: Set<EntryCategory> = new Set([
  "image_generated",
  "video_generated",
  "audio_generated",
  "content_generated",
  "report_generated",
  "chart_generated",
  "draft_response",
  "design_asset",
  "animation_created",
  "email_campaign",
]);

/** Categories eligible for consecutive grouping in pass 2 */
export const AGGREGATABLE_CATEGORIES: Set<EntryCategory> = new Set([
  "file_read",
  "file_edit",
  "search",
  "command",
  "web",
  "generic_tool",
]);
```

- [ ] **Step 2: Verify types compile**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx tsc --noEmit ui/src/components/workspace/transcript/types.ts 2>&1 | head -20`

Expected: No errors (or only errors about missing module resolution which is fine for isolated type checking). If there are actual type errors, fix them.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/workspace/transcript/types.ts
git commit -m "feat(workspace): add structured timeline types — TranscriptBlock, EntryCategory, AggregatedGroup"
```

---

## Task 2: Port normalizeTranscript from AoA

**Files:**
- Create: `ui/src/components/workspace/transcript/normalize-transcript.ts`
- Create: `ui/src/__tests__/transcript/normalize-transcript.test.ts`

**Reference:** Read `paperclip-master/paperclip/ui/src/components/transcript/RunTranscriptView.tsx` lines 109-580 — the helper functions and normalizeTranscript(). Port this code, adapting imports to use our local `types.ts`.

- [ ] **Step 1: Write tests for normalizeTranscript**

```typescript
// ui/src/__tests__/transcript/normalize-transcript.test.ts

import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@armyofagents/adapter-utils";
import { normalizeTranscript } from "../../components/workspace/transcript/normalize-transcript";

describe("normalizeTranscript", () => {
  it("merges consecutive assistant messages into one block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-01-01T00:00:00Z", text: "Hello" },
      { kind: "assistant", ts: "2026-01-01T00:00:01Z", text: "World" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "message", role: "assistant", text: "Hello\nWorld" });
  });

  it("matches tool_call with tool_result by toolUseId", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "Read", input: { path: "auth.ts", toolUseId: "t1" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:01Z", toolUseId: "t1", content: "file contents", isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    // After grouping, tool blocks get grouped into tool_group
    const toolBlocks = blocks.filter((b) => b.type === "tool" || b.type === "tool_group");
    expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it("groups consecutive command tools into command_group", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "bash", input: { command: "ls" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:01Z", toolUseId: "", content: "file-a", isError: false },
      { kind: "tool_call", ts: "2026-01-01T00:00:02Z", name: "bash", input: { command: "pwd" } },
      { kind: "tool_result", ts: "2026-01-01T00:00:03Z", toolUseId: "", content: "/home", isError: false },
    ];
    const blocks = normalizeTranscript(entries, false);
    const cmdGroups = blocks.filter((b) => b.type === "command_group");
    expect(cmdGroups).toHaveLength(1);
    if (cmdGroups[0]?.type === "command_group") {
      expect(cmdGroups[0].items).toHaveLength(2);
    }
  });

  it("keeps running command stdout inside the command block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool_call", ts: "2026-01-01T00:00:00Z", name: "command_execution", input: { command: "ls -la" } },
      { kind: "stdout", ts: "2026-01-01T00:00:01Z", text: "file-a\nfile-b" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "command_group",
      items: [{ result: "file-a\nfile-b", status: "running" }],
    });
  });

  it("batches consecutive stderr into stderr_group", () => {
    const entries: TranscriptEntry[] = [
      { kind: "stderr", ts: "2026-01-01T00:00:00Z", text: "Warning: deprecated" },
      { kind: "stderr", ts: "2026-01-01T00:00:01Z", text: "Warning: unused var" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "stderr_group" });
    if (blocks[0]?.type === "stderr_group") {
      expect(blocks[0].lines).toHaveLength(2);
    }
  });

  it("converts init entry to event block", () => {
    const entries: TranscriptEntry[] = [
      { kind: "init", ts: "2026-01-01T00:00:00Z", model: "claude-sonnet", sessionId: "s1" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "event", label: "init", tone: "info" });
  });

  it("converts result entry to event block with error tone on failure", () => {
    const entries: TranscriptEntry[] = [
      { kind: "result", ts: "2026-01-01T00:00:00Z", text: "Failed", inputTokens: 100, outputTokens: 50, cachedTokens: 0, costUsd: 0.01, subtype: "error", isError: true, errors: ["timeout"] },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks[0]).toMatchObject({ type: "event", tone: "error" });
  });

  it("merges consecutive thinking entries", () => {
    const entries: TranscriptEntry[] = [
      { kind: "thinking", ts: "2026-01-01T00:00:00Z", text: "Step 1" },
      { kind: "thinking", ts: "2026-01-01T00:00:01Z", text: "Step 2" },
    ];
    const blocks = normalizeTranscript(entries, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "thinking", text: "Step 1\nStep 2" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/normalize-transcript.test.ts 2>&1 | tail -20`

Expected: FAIL — module not found.

- [ ] **Step 3: Create normalize-transcript.ts by porting from AoA**

Read `paperclip-master/paperclip/ui/src/components/transcript/RunTranscriptView.tsx` lines 109-580. Port the following functions into `ui/src/components/workspace/transcript/normalize-transcript.ts`:

- All helper functions: `asRecord`, `compactWhitespace`, `truncate`, `humanizeLabel`, `stripWrappedShell`, `formatUnknown`, `formatToolPayload`, `extractToolUseId`, `summarizeRecord`, `summarizeToolInput`, `parseStructuredToolResult`, `isCommandTool`, `displayToolName`, `summarizeToolResult`, `parseSystemActivity`, `shouldHideNiceModeStderr`
- `groupCommandBlocks()`
- `groupToolBlocks()`
- `normalizeTranscript()`

Changes from AoA:
1. Import `TranscriptBlock` from `./types` instead of defining inline
2. Import `TranscriptEntry` from `@armyofagents/adapter-utils` (NOT from `../../adapters` — that path is for AoA)
3. Export `normalizeTranscript`, `isCommandTool`, `extractToolUseId`, `summarizeToolInput`, `displayToolName`, `stripWrappedShell`, `summarizeToolResult`, `parseStructuredToolResult` (other helpers stay private)
4. **CRITICAL — AoA type differences:**
   - `tool_call` entries have NO `toolUseId` field. At line ~438 of the reference, change `toolUseId: entry.toolUseId ?? extractToolUseId(entry.input)` to just `toolUseId: extractToolUseId(entry.input)`
   - `tool_result` entries have NO `toolName` field. At line ~465 of the reference, change `name: entry.toolName ?? "tool"` to just `name: "tool"`
5. Remove the `density: TranscriptDensity` parameter from both `summarizeToolInput` and `summarizeToolResult` — hardcode the "comfortable" defaults (120 char max for summarizeToolInput, 140 char max for summarizeToolResult)
6. Remove `shouldHideNiceModeStderr` — keep all stderr (AoA doesn't have the AoA-specific skip logic). If you want to keep it, that's fine too — it's a minor detail.

The file should be approximately 300 lines. The logic is a direct port — do NOT refactor or simplify.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/normalize-transcript.test.ts 2>&1 | tail -20`

Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/transcript/normalize-transcript.ts ui/src/__tests__/transcript/normalize-transcript.test.ts
git commit -m "feat(workspace): port normalizeTranscript from AoA — tool matching, message merging, grouping"
```

---

## Task 3: Entry Classification System

**Files:**
- Create: `ui/src/components/workspace/transcript/classify-entry.ts`
- Create: `ui/src/__tests__/transcript/classify-entry.test.ts`

- [ ] **Step 1: Write tests for classifyToolEntry**

```typescript
// ui/src/__tests__/transcript/classify-entry.test.ts

import { describe, expect, it } from "vitest";
import { classifyToolEntry } from "../../components/workspace/transcript/classify-entry";

describe("classifyToolEntry", () => {
  // Universal
  it("classifies Read as file_read", () => {
    expect(classifyToolEntry("Read", { path: "auth.ts" }, "general")).toBe("file_read");
  });
  it("classifies Edit as file_edit", () => {
    expect(classifyToolEntry("Edit", { file_path: "auth.ts" }, "general")).toBe("file_edit");
  });
  it("classifies Write as file_edit", () => {
    expect(classifyToolEntry("Write", { file_path: "new.ts" }, "general")).toBe("file_edit");
  });
  it("classifies Grep as search", () => {
    expect(classifyToolEntry("Grep", { pattern: "foo" }, "general")).toBe("search");
  });
  it("classifies Glob as search", () => {
    expect(classifyToolEntry("Glob", { pattern: "*.ts" }, "general")).toBe("search");
  });
  it("classifies Bash as command", () => {
    expect(classifyToolEntry("Bash", { command: "ls" }, "general")).toBe("command");
  });
  it("classifies WebFetch as web", () => {
    expect(classifyToolEntry("WebFetch", { url: "https://x.com" }, "general")).toBe("web");
  });
  it("classifies WebSearch as web", () => {
    expect(classifyToolEntry("WebSearch", { query: "test" }, "general")).toBe("web");
  });
  it("classifies TodoWrite as progress_update", () => {
    expect(classifyToolEntry("TodoWrite", { todos: [] }, "general")).toBe("progress_update");
  });
  it("classifies unknown tools as generic_tool", () => {
    expect(classifyToolEntry("some_random_tool", {}, "general")).toBe("generic_tool");
  });

  // Software dev — command content detection
  it("classifies git commands as git_operation in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "git commit -m 'fix'" }, "software_development")).toBe("git_operation");
  });
  it("classifies npm test as test_run in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "npm test" }, "software_development")).toBe("test_run");
  });
  it("classifies npm run build as build in software_development", () => {
    expect(classifyToolEntry("Bash", { command: "npm run build" }, "software_development")).toBe("build");
  });
  it("keeps git as generic command outside software_development", () => {
    expect(classifyToolEntry("Bash", { command: "git status" }, "marketing")).toBe("command");
  });

  // Marketing
  it("classifies generate_image as image_generated in marketing", () => {
    expect(classifyToolEntry("generate_image", {}, "marketing")).toBe("image_generated");
  });
  it("classifies generate_image as generic_tool outside marketing", () => {
    expect(classifyToolEntry("generate_image", {}, "finance")).toBe("generic_tool");
  });

  // Finance
  it("classifies generate_report as report_generated in finance", () => {
    expect(classifyToolEntry("generate_report", {}, "finance")).toBe("report_generated");
  });

  // Support
  it("classifies search_tickets as ticket_lookup in support", () => {
    expect(classifyToolEntry("search_tickets", {}, "support")).toBe("ticket_lookup");
  });
  it("classifies draft_reply as draft_response in support", () => {
    expect(classifyToolEntry("draft_reply", {}, "support")).toBe("draft_response");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/classify-entry.test.ts 2>&1 | tail -20`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement classifyToolEntry**

```typescript
// ui/src/components/workspace/transcript/classify-entry.ts

import type { DepartmentType, EntryCategory } from "./types";

// --- Exact name matches (universal, always checked) ---

const UNIVERSAL_NAME_MAP: Record<string, EntryCategory> = {
  // File read
  Read: "file_read", cat: "file_read", head: "file_read", file_read: "file_read", ReadFile: "file_read",
  // File edit
  Edit: "file_edit", Write: "file_edit", file_edit: "file_edit", EditFile: "file_edit", NotebookEdit: "file_edit",
  // Search
  Grep: "search", Glob: "search", search: "search", find: "search", ripgrep: "search",
  // Command
  Bash: "command", shell: "command", bash: "command", command_execution: "command", shellToolCall: "command",
  // Web
  WebFetch: "web", WebSearch: "web", web_fetch: "web", curl: "web",
  // Progress
  TodoWrite: "progress_update", update_progress: "progress_update", set_status: "progress_update",
  // Memory
  suggest_memory: "memory_operation", context_lookup: "memory_operation",
  // Approval
  request_approval: "approval_requested", needs_review: "approval_requested",
  // File transfer
  upload_file: "file_upload", send_file: "file_upload",
  download_file: "file_download", save_as: "file_download",
  // Audio
  text_to_speech: "audio_generated", generate_audio: "audio_generated",
};

// --- Pattern matches (checked if no exact match) ---

const UNIVERSAL_PATTERNS: Array<[RegExp, EntryCategory]> = [
  [/^recall_/i, "memory_operation"],
  [/^attach_/i, "file_upload"],
  [/^export_/i, "file_download"],
  [/^voice_/i, "audio_generated"],
  [/^podcast_/i, "audio_generated"],
  [/^api_request$/i, "api_call"],
  [/^http_/i, "api_call"],
  [/^rest_/i, "api_call"],
  [/^graphql_/i, "api_call"],
];

// --- Department-specific name maps ---

const DEPARTMENT_NAME_MAPS: Partial<Record<DepartmentType, Record<string, EntryCategory>>> = {
  software_development: {},
  marketing: {
    generate_copy: "content_generated", write_content: "content_generated",
    generate_image: "image_generated", "dall-e": "image_generated", midjourney: "image_generated", "stable-diffusion": "image_generated",
    generate_video: "video_generated", create_video: "video_generated", video_edit: "video_generated",
    analyze_audience: "research", competitor_analysis: "research", market_research: "research",
    schedule_post: "social_post", create_post: "social_post", draft_social: "social_post",
    seo_audit: "seo_analysis", keyword_research: "seo_analysis",
    draft_email: "email_campaign", email_template: "email_campaign",
    pull_analytics: "analytics_pulled", analytics_report: "analytics_pulled",
  },
  finance: {
    calculate: "calculation", compute: "calculation", formula: "calculation",
    query_data: "data_query", sql: "data_query", fetch_report: "data_query", pull_metrics: "data_query",
    generate_report: "report_generated", financial_summary: "report_generated", forecast: "report_generated",
    create_chart: "chart_generated", visualize: "chart_generated", plot: "chart_generated",
    create_invoice: "invoice_generated", generate_statement: "invoice_generated",
    audit_check: "compliance_check", compliance_verify: "compliance_check",
  },
  support: {
    search_tickets: "ticket_lookup", get_ticket: "ticket_lookup",
    search_kb: "knowledge_search", knowledge_base: "knowledge_search", help_center: "knowledge_search",
    draft_reply: "draft_response", compose_response: "draft_response", suggest_answer: "draft_response",
    escalate: "escalation", transfer: "escalation", assign_agent: "escalation",
    analyze_sentiment: "sentiment_analyzed", customer_mood: "sentiment_analyzed",
    apply_macro: "macro_applied", canned_response: "macro_applied", template_reply: "macro_applied",
  },
  design: {
    generate_design: "design_asset", create_mockup: "design_asset",
    brand_guidelines: "brand_check", style_check: "brand_check", consistency_audit: "brand_check",
    resize_image: "media_processed", compress_video: "media_processed", convert_format: "media_processed",
    create_animation: "animation_created",
    create_prototype: "prototype_created", interactive_mockup: "prototype_created",
  },
  hr: {
    search_candidates: "candidate_lookup", get_applicant: "candidate_lookup",
    draft_offer: "document_drafted", draft_policy: "document_drafted", write_handbook: "document_drafted",
    schedule_interview: "schedule_action", book_meeting: "schedule_action",
    run_background: "background_check",
    training_assigned: "onboarding_step", setup_account: "onboarding_step",
  },
  legal: {
    draft_contract: "contract_drafted", generate_agreement: "contract_drafted",
    review_clause: "clause_reviewed", check_terms: "clause_reviewed", legal_review: "clause_reviewed",
    check_regulation: "regulatory_check",
  },
  research: {
    search_papers: "literature_search",
    analyze_data: "data_analysis", run_experiment: "data_analysis", statistical_test: "data_analysis",
    cite: "citation", add_reference: "citation", bibliography: "citation",
    run_simulation: "experiment_run", model_train: "experiment_run",
  },
  operations: {
    trigger_workflow: "workflow_triggered", run_pipeline: "workflow_triggered",
    check_inventory: "inventory_check",
    send_notification: "notification_sent",
  },
};

const DEPARTMENT_PATTERNS: Partial<Record<DepartmentType, Array<[RegExp, EntryCategory]>>> = {
  marketing: [
    [/^draft_/i, "content_generated"],
    [/^animate_/i, "video_generated"],
    [/^campaign_/i, "email_campaign"],
    [/^ga_/i, "analytics_pulled"],
  ],
  finance: [
    [/^spreadsheet_/i, "calculation"],
    [/^validate_/i, "compliance_check"],
  ],
  support: [
    [/^zendesk_/i, "ticket_lookup"],
    [/^freshdesk_/i, "ticket_lookup"],
    [/^nps_/i, "sentiment_analyzed"],
  ],
  design: [
    [/^figma_/i, "design_asset"],
    [/^lottie_/i, "animation_created"],
    [/^motion_/i, "animation_created"],
  ],
  hr: [
    [/^ats_/i, "candidate_lookup"],
    [/^verify_/i, "background_check"],
    [/^onboard_/i, "onboarding_step"],
    [/^calendar_/i, "schedule_action"],
  ],
  legal: [
    [/^nda_/i, "contract_drafted"],
    [/^compliance_/i, "regulatory_check"],
    [/^gdpr_/i, "regulatory_check"],
  ],
  research: [
    [/^arxiv_/i, "literature_search"],
    [/^pubmed_/i, "literature_search"],
    [/^scholar_/i, "literature_search"],
    [/^benchmark_/i, "experiment_run"],
  ],
  operations: [
    [/^automate_/i, "workflow_triggered"],
    [/^stock_/i, "inventory_check"],
    [/^warehouse_/i, "inventory_check"],
    [/^alert_/i, "notification_sent"],
    [/^notify_/i, "notification_sent"],
  ],
};

// --- Command content analysis (for software_development department) ---

function classifyCommandContent(input: unknown): EntryCategory | null {
  const command = extractCommand(input);
  if (!command) return null;

  if (/\bgit\s+(?:commit|push|pull|merge|rebase|checkout|branch|stash|log|diff|add|reset|cherry-pick|tag)\b/i.test(command)) return "git_operation";
  if (/\bgit\s+status\b/i.test(command)) return "git_operation";
  if (/\b(?:npm\s+test|npx\s+vitest|npx\s+jest|pytest|cargo\s+test|go\s+test|rspec|mocha)\b/i.test(command)) return "test_run";
  if (/\b(?:npm\s+run\s+build|npx\s+tsc|cargo\s+build|make\b|gradle\s+build|mvn\s+(?:compile|package))\b/i.test(command)) return "build";

  return null;
}

function extractCommand(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.cmd === "string") return record.cmd;
  }
  return null;
}

// --- Main classifier ---

export function classifyToolEntry(
  name: string,
  input: unknown,
  departmentType: DepartmentType,
): EntryCategory {
  // 1. Universal exact match
  const universal = UNIVERSAL_NAME_MAP[name];
  if (universal) {
    // Special case: command entries get further classified in software_development
    if (universal === "command" && departmentType === "software_development") {
      const commandCategory = classifyCommandContent(input);
      if (commandCategory) return commandCategory;
    }
    return universal;
  }

  // 2. Department-specific exact match
  const deptMap = DEPARTMENT_NAME_MAPS[departmentType];
  if (deptMap) {
    const deptMatch = deptMap[name];
    if (deptMatch) return deptMatch;
  }

  // 3. Universal pattern match
  for (const [pattern, category] of UNIVERSAL_PATTERNS) {
    if (pattern.test(name)) return category;
  }

  // 4. Department-specific pattern match
  const deptPatterns = DEPARTMENT_PATTERNS[departmentType];
  if (deptPatterns) {
    for (const [pattern, category] of deptPatterns) {
      if (pattern.test(name)) return category;
    }
  }

  // 5. Fallback
  return "generic_tool";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/classify-entry.test.ts 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/transcript/classify-entry.ts ui/src/__tests__/transcript/classify-entry.test.ts
git commit -m "feat(workspace): add department-aware entry classifier — 60+ categories across 9 departments"
```

---

## Task 4: Aggregation Pass 2

**Files:**
- Create: `ui/src/components/workspace/transcript/aggregate-blocks.ts`
- Create: `ui/src/__tests__/transcript/aggregate-blocks.test.ts`

- [ ] **Step 1: Write tests for aggregateBlocks**

```typescript
// ui/src/__tests__/transcript/aggregate-blocks.test.ts

import { describe, expect, it } from "vitest";
import { aggregateBlocks } from "../../components/workspace/transcript/aggregate-blocks";
import type { TranscriptBlock } from "../../components/workspace/transcript/types";

const tool = (name: string, input: unknown = {}, status: "completed" | "running" = "completed"): Extract<TranscriptBlock, { type: "tool" }> => ({
  type: "tool", ts: "2026-01-01T00:00:00Z", name, input, status,
});

describe("aggregateBlocks", () => {
  it("groups 3 consecutive file_read tools into read_group", () => {
    const blocks: TranscriptBlock[] = [
      tool("Read", { path: "a.ts" }),
      tool("Read", { path: "b.ts" }),
      tool("Read", { path: "c.ts" }),
    ];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "read_group", count: 3 });
  });

  it("does NOT group a single file_read (minimum 2 required)", () => {
    const blocks: TranscriptBlock[] = [tool("Read", { path: "a.ts" })];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "tool" });
  });

  it("groups consecutive file_edit on same file into edit_group", () => {
    const blocks: TranscriptBlock[] = [
      tool("Edit", { file_path: "auth.ts" }),
      tool("Edit", { file_path: "auth.ts" }),
    ];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "edit_group", filePath: "auth.ts" });
  });

  it("groups consecutive file_edit on different files into multi_edit_group", () => {
    const blocks: TranscriptBlock[] = [
      tool("Edit", { file_path: "auth.ts" }),
      tool("Edit", { file_path: "routes.ts" }),
      tool("Edit", { file_path: "config.ts" }),
    ];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "multi_edit_group", fileCount: 3 });
  });

  it("does not group non-consecutive same-type tools", () => {
    const blocks: TranscriptBlock[] = [
      tool("Read", { path: "a.ts" }),
      { type: "message", role: "assistant", ts: "2026-01-01T00:00:00Z", text: "hello", streaming: false } as TranscriptBlock,
      tool("Read", { path: "b.ts" }),
    ];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: "tool" });
    expect(result[2]).toMatchObject({ type: "tool" });
  });

  it("passes through messages and events unchanged", () => {
    const msg: TranscriptBlock = { type: "message", role: "assistant", ts: "2026-01-01T00:00:00Z", text: "hi", streaming: false };
    const evt: TranscriptBlock = { type: "event", ts: "2026-01-01T00:00:00Z", label: "init", tone: "info", text: "ready" };
    const result = aggregateBlocks([msg, evt], "general");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: "message" });
    expect(result[1]).toMatchObject({ type: "event" });
  });

  it("groups 2 consecutive search tools into search_group", () => {
    const blocks: TranscriptBlock[] = [
      tool("Grep", { pattern: "foo" }),
      tool("Glob", { pattern: "*.ts" }),
    ];
    const result = aggregateBlocks(blocks, "general");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "search_group", count: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/aggregate-blocks.test.ts 2>&1 | tail -20`

Expected: FAIL.

- [ ] **Step 3: Implement aggregateBlocks**

```typescript
// ui/src/components/workspace/transcript/aggregate-blocks.ts

import type {
  TranscriptBlock,
  AggregatedGroup,
  DisplayBlock,
  DepartmentType,
  EntryCategory,
} from "./types";
import { AGGREGATABLE_CATEGORIES } from "./types";
import { classifyToolEntry } from "./classify-entry";

/** Extract file path from tool input for edit grouping */
function extractFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "filename"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/** Parse +/- stats from tool result text */
export function parseEditStats(result: string | undefined): { additions: number; deletions: number } {
  if (!result) return { additions: 0, deletions: 0 };
  const addMatch = result.match(/\+(\d+)/);
  const delMatch = result.match(/-(\d+)/);
  return {
    additions: addMatch ? parseInt(addMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

type ToolBlock = Extract<TranscriptBlock, { type: "tool" }>;

interface PendingGroup {
  category: EntryCategory;
  items: ToolBlock[];
  /** For file_edit: tracks all distinct file paths */
  filePaths: Set<string>;
}

function flushGroup(pending: PendingGroup): DisplayBlock[] {
  const { category, items, filePaths } = pending;
  if (items.length < 2) return items;

  switch (category) {
    case "file_read":
      return [{ type: "read_group", items, count: items.length }];

    case "file_edit": {
      if (filePaths.size === 1) {
        const filePath = [...filePaths][0]!;
        let totalAdditions = 0;
        let totalDeletions = 0;
        for (const item of items) {
          const stats = parseEditStats(item.result);
          totalAdditions += stats.additions;
          totalDeletions += stats.deletions;
        }
        return [{ type: "edit_group", filePath, items, totalAdditions, totalDeletions }];
      }
      return [{ type: "multi_edit_group", items, fileCount: filePaths.size }];
    }

    case "search":
      return [{ type: "search_group", items, count: items.length }];

    case "web":
      return [{ type: "web_group", items, count: items.length }];

    case "command":
      return [{ type: "command_group_agg", items, count: items.length }];

    default:
      return [{ type: "generic_group", category, items, count: items.length }];
  }
}

export function aggregateBlocks(
  blocks: TranscriptBlock[],
  departmentType: DepartmentType,
): DisplayBlock[] {
  const result: DisplayBlock[] = [];
  let pending: PendingGroup | null = null;

  for (const block of blocks) {
    // Only aggregate tool blocks
    if (block.type !== "tool") {
      if (pending) {
        result.push(...flushGroup(pending));
        pending = null;
      }
      result.push(block);
      continue;
    }

    const category = classifyToolEntry(block.name, block.input, departmentType);

    // Only aggregate categories in the AGGREGATABLE set
    if (!AGGREGATABLE_CATEGORIES.has(category)) {
      if (pending) {
        result.push(...flushGroup(pending));
        pending = null;
      }
      result.push(block);
      continue;
    }

    // Start or continue a group
    if (pending && pending.category === category) {
      pending.items.push(block);
      if (category === "file_edit") {
        const fp = extractFilePath(block.input);
        if (fp) pending.filePaths.add(fp);
      }
    } else {
      if (pending) {
        result.push(...flushGroup(pending));
      }
      const filePaths = new Set<string>();
      if (category === "file_edit") {
        const fp = extractFilePath(block.input);
        if (fp) filePaths.add(fp);
      }
      pending = { category, items: [block], filePaths };
    }
  }

  if (pending) {
    result.push(...flushGroup(pending));
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/aggregate-blocks.test.ts 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/workspace/transcript/aggregate-blocks.ts ui/src/__tests__/transcript/aggregate-blocks.test.ts
git commit -m "feat(workspace): add pass-2 aggregation — consecutive grouping for reads, edits, searches"
```

---

## Task 5: TranscriptToolPill Component

**Files:**
- Create: `ui/src/components/workspace/transcript/TranscriptToolPill.tsx`

This is the most-used component. Every tool call that isn't a rich card renders as a pill.

- [ ] **Step 1: Implement TranscriptToolPill**

```tsx
// ui/src/components/workspace/transcript/TranscriptToolPill.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  FileText,
  Search,
  Terminal,
  Globe,
  Wrench,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  GitBranch,
  FlaskConical,
  Hammer,
  Upload,
  Download,
  Brain,
  ShieldCheck,
  Ticket,
  BookOpen,
  FileEdit,
  BarChart3,
  Scale,
  Users,
  Calendar,
  Microscope,
  Cog,
  Bell,
  type LucideIcon,
} from "lucide-react";
import type { EntryCategory, EditStats } from "./types";

const CATEGORY_ICONS: Partial<Record<EntryCategory, LucideIcon>> = {
  file_read: FileText,
  file_edit: FileEdit,
  search: Search,
  command: Terminal,
  web: Globe,
  api_call: Globe,
  file_upload: Upload,
  file_download: Download,
  memory_operation: Brain,
  approval_requested: ShieldCheck,
  generic_tool: Wrench,
  // Software dev
  git_operation: GitBranch,
  test_run: FlaskConical,
  build: Hammer,
  // Support
  ticket_lookup: Ticket,
  knowledge_search: BookOpen,
  // Finance
  calculation: BarChart3,
  report_generated: BarChart3,
  compliance_check: ShieldCheck,
  // Legal
  clause_reviewed: Scale,
  regulatory_check: Scale,
  // HR
  candidate_lookup: Users,
  schedule_action: Calendar,
  // Research
  literature_search: Microscope,
  // Operations
  workflow_triggered: Cog,
  notification_sent: Bell,
};

interface TranscriptToolPillProps {
  name: string;
  summary: string;
  category: EntryCategory;
  status: "running" | "completed" | "error";
  editStats?: EditStats;
  result?: string;
  input?: unknown;
  className?: string;
}

export function TranscriptToolPill({
  name,
  summary,
  category,
  status,
  editStats,
  result,
  input,
  className,
}: TranscriptToolPillProps) {
  const [expanded, setExpanded] = useState(false);
  const Icon = CATEGORY_ICONS[category] ?? Wrench;
  const hasExpandable = Boolean(result || input);

  return (
    <div className={cn("group", className)}>
      <button
        type="button"
        onClick={() => hasExpandable && setExpanded(!expanded)}
        className={cn(
          "flex items-center gap-2 w-full px-3 h-10 rounded-lg text-left transition-colors",
          "bg-muted/30 hover:bg-muted/50",
          status === "error" && "border-l-2 border-l-red-500",
          hasExpandable && "cursor-pointer",
          !hasExpandable && "cursor-default",
        )}
        disabled={!hasExpandable}
        aria-label={`${name} ${summary}, ${status}`}
      >
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-[13px] text-foreground/80 truncate flex-1">
          {category === "file_read" || category === "file_edit" || category === "search" || category === "command"
            ? <span className="font-mono">{summary}</span>
            : summary}
        </span>
        {editStats && (editStats.additions > 0 || editStats.deletions > 0) && (
          <span className="text-xs shrink-0">
            {editStats.additions > 0 && <span className="text-emerald-500">+{editStats.additions}</span>}
            {editStats.additions > 0 && editStats.deletions > 0 && " "}
            {editStats.deletions > 0 && <span className="text-red-400">-{editStats.deletions}</span>}
          </span>
        )}
        {status === "running" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
        {status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
        {status === "error" && <X className="h-3.5 w-3.5 text-red-500 shrink-0" />}
        {hasExpandable && (
          expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
        )}
      </button>
      {expanded && (result || input) && (
        <div className="ml-6 mt-1 mb-2 p-2 rounded-md bg-muted/20 text-xs font-mono max-h-[300px] overflow-auto whitespace-pre-wrap text-foreground/70">
          {result ?? (typeof input === "string" ? input : JSON.stringify(input, null, 2))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify component compiles**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx tsc --noEmit 2>&1 | grep -i "TranscriptToolPill" | head -5`

Expected: No type errors related to TranscriptToolPill. Fix any that appear.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/workspace/transcript/TranscriptToolPill.tsx
git commit -m "feat(workspace): add TranscriptToolPill — the workhorse rendering component for tool calls"
```

---

## Task 6: Remaining Rendering Components

**Files:**
- Create: `ui/src/components/workspace/transcript/TranscriptMessageBlock.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptThinkingBlock.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptEventRow.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptErrorBlock.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptStdoutBlock.tsx`

- [ ] **Step 1: Create TranscriptMessageBlock**

```tsx
// ui/src/components/workspace/transcript/TranscriptMessageBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "../../MarkdownBody";
import { Identity } from "../../Identity";

interface TranscriptMessageBlockProps {
  role: "assistant" | "user";
  text: string;
  streaming: boolean;
  agentName?: string;
  ts?: string;
  className?: string;
}

const MAX_COLLAPSED_LENGTH = 500;

export function TranscriptMessageBlock({
  role,
  text,
  streaming,
  agentName = "Agent",
  ts,
  className,
}: TranscriptMessageBlockProps) {
  const [showFull, setShowFull] = useState(false);
  const truncated = !showFull && text.length > MAX_COLLAPSED_LENGTH;
  const displayText = truncated ? text.slice(0, MAX_COLLAPSED_LENGTH) + "..." : text;

  if (role === "user") {
    return null; // User messages handled by TimelineUserMessage
  }

  return (
    <div className={cn("rounded-2xl rounded-tl-sm bg-card border border-border p-3", className)}>
      <div className="flex items-center gap-2 mb-2">
        <Identity name={agentName} size="xs" />
        <span className="text-xs text-muted-foreground">{agentName}</span>
        {ts && <span className="text-xs text-muted-foreground">·</span>}
        {ts && <span className="text-xs text-muted-foreground">{new Date(ts).toLocaleTimeString()}</span>}
        {streaming && <span className="text-xs text-blue-500 animate-pulse">typing...</span>}
      </div>
      <div className="text-sm">
        <MarkdownBody content={displayText} />
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowFull(true)}
          className="text-xs text-primary hover:underline mt-1"
        >
          Show more
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create TranscriptThinkingBlock**

```tsx
// ui/src/components/workspace/transcript/TranscriptThinkingBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown } from "lucide-react";

interface TranscriptThinkingBlockProps {
  text: string;
  streaming: boolean;
  /** If true, this is from a previous turn and should be collapsed */
  isPreviousTurn?: boolean;
  className?: string;
}

export function TranscriptThinkingBlock({
  text,
  streaming,
  isPreviousTurn = false,
  className,
}: TranscriptThinkingBlockProps) {
  const [expanded, setExpanded] = useState(!isPreviousTurn && streaming);

  if (isPreviousTurn && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground/60 transition-colors",
          className,
        )}
        aria-label="Expand thinking"
      >
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span>Thinking</span>
        <ChevronRight className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className={cn("rounded-lg bg-muted/20 p-3", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60 mb-1"
      >
        {streaming ? (
          <span className="text-muted-foreground animate-pulse">Thinking...</span>
        ) : (
          <>
            <span>Thinking</span>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </>
        )}
      </button>
      {(expanded || streaming) && (
        <p className="text-xs text-muted-foreground/80 italic whitespace-pre-wrap max-h-[200px] overflow-auto">
          {text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create TranscriptEventRow**

```tsx
// ui/src/components/workspace/transcript/TranscriptEventRow.tsx

import { cn } from "@/lib/utils";
import { Info, AlertTriangle, XCircle, Minus } from "lucide-react";

interface TranscriptEventRowProps {
  label: string;
  text: string;
  tone: "info" | "warn" | "error" | "neutral";
  className?: string;
}

const TONE_STYLES = {
  info: { icon: Info, color: "text-blue-500" },
  warn: { icon: AlertTriangle, color: "text-amber-500" },
  error: { icon: XCircle, color: "text-red-500" },
  neutral: { icon: Minus, color: "text-muted-foreground" },
};

export function TranscriptEventRow({ label, text, tone, className }: TranscriptEventRowProps) {
  const { icon: Icon, color } = TONE_STYLES[tone];
  return (
    <div className={cn("flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground", className)}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", color)} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground/60">·</span>
      <span className="truncate">{text}</span>
    </div>
  );
}
```

- [ ] **Step 4: Create TranscriptErrorBlock**

```tsx
// ui/src/components/workspace/transcript/TranscriptErrorBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";

interface TranscriptErrorBlockProps {
  lines: Array<{ ts: string; text: string }>;
  className?: string;
}

export function TranscriptErrorBlock({ lines, className }: TranscriptErrorBlockProps) {
  const [expanded, setExpanded] = useState(lines.length <= 3);

  return (
    <div className={cn("border-l-2 border-l-red-500 bg-red-500/5 rounded-r-lg", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 h-9 w-full text-left text-xs"
      >
        <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        <span className="text-red-500/80">stderr ({lines.length} line{lines.length !== 1 ? "s" : ""})</span>
        {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground ml-auto" /> : <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 font-mono text-xs text-red-400/80 max-h-[200px] overflow-auto whitespace-pre-wrap">
          {lines.map((line, i) => (
            <div key={i}>{line.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create TranscriptStdoutBlock**

```tsx
// ui/src/components/workspace/transcript/TranscriptStdoutBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, FileOutput } from "lucide-react";

interface TranscriptStdoutBlockProps {
  text: string;
  className?: string;
}

export function TranscriptStdoutBlock({ text, className }: TranscriptStdoutBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground hover:text-foreground/60 transition-colors"
      >
        <FileOutput className="h-3.5 w-3.5" />
        <span>Raw output</span>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="mx-3 mb-2 p-2 rounded-md bg-muted/20 font-mono text-xs text-foreground/70 max-h-[200px] overflow-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Verify all components compile**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx tsc --noEmit 2>&1 | grep -i "Transcript" | head -10`

Fix any type errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/workspace/transcript/TranscriptMessageBlock.tsx ui/src/components/workspace/transcript/TranscriptThinkingBlock.tsx ui/src/components/workspace/transcript/TranscriptEventRow.tsx ui/src/components/workspace/transcript/TranscriptErrorBlock.tsx ui/src/components/workspace/transcript/TranscriptStdoutBlock.tsx
git commit -m "feat(workspace): add message, thinking, event, error, stdout transcript components"
```

---

## Task 7: Aggregated Group + Edit Group + Progress Components

**Files:**
- Create: `ui/src/components/workspace/transcript/TranscriptAggregatedGroup.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptEditGroup.tsx`
- Create: `ui/src/components/workspace/transcript/TranscriptProgressBlock.tsx`

- [ ] **Step 1: Create TranscriptAggregatedGroup**

```tsx
// ui/src/components/workspace/transcript/TranscriptAggregatedGroup.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileText, Search, Globe, Terminal, Wrench, ChevronRight, ChevronDown, type LucideIcon } from "lucide-react";
import type { AggregatedGroup } from "./types";
import { TranscriptToolPill } from "./TranscriptToolPill";
import { classifyToolEntry } from "./classify-entry";

const GROUP_CONFIG: Record<string, { icon: LucideIcon; label: (n: number) => string }> = {
  read_group: { icon: FileText, label: (n) => `Read · ${n} files` },
  search_group: { icon: Search, label: (n) => `Search · ${n} queries` },
  web_group: { icon: Globe, label: (n) => `Web · ${n} requests` },
  command_group_agg: { icon: Terminal, label: (n) => `Ran · ${n} commands` },
  generic_group: { icon: Wrench, label: (n) => `Tool · ${n} calls` },
};

interface TranscriptAggregatedGroupProps {
  group: Extract<AggregatedGroup, { type: "read_group" | "search_group" | "web_group" | "command_group_agg" | "generic_group" }>;
  departmentType: string;
  className?: string;
}

export function TranscriptAggregatedGroup({ group, departmentType, className }: TranscriptAggregatedGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const config = GROUP_CONFIG[group.type] ?? GROUP_CONFIG.generic_group!;
  const Icon = config.icon;

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 rounded-lg bg-muted/40 hover:bg-muted/60 text-left transition-colors"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80 flex-1">{config.label(group.count)}</span>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-1">
          {group.items.map((item, i) => {
            const category = classifyToolEntry(item.name, item.input, departmentType as any);
            const summary = extractSummary(item);
            return (
              <TranscriptToolPill
                key={i}
                name={item.name}
                summary={summary}
                category={category}
                status={item.status}
                result={item.result}
                input={item.input}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function extractSummary(item: { name: string; input: unknown }): string {
  if (typeof item.input === "string") return item.input;
  const record = item.input as Record<string, unknown> | null;
  if (!record) return item.name;
  return (
    (typeof record.path === "string" && record.path) ||
    (typeof record.file_path === "string" && record.file_path) ||
    (typeof record.query === "string" && record.query) ||
    (typeof record.pattern === "string" && record.pattern) ||
    (typeof record.url === "string" && record.url) ||
    (typeof record.command === "string" && record.command) ||
    item.name
  );
}
```

- [ ] **Step 2: Create TranscriptEditGroup**

```tsx
// ui/src/components/workspace/transcript/TranscriptEditGroup.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { FileEdit, ChevronRight, ChevronDown } from "lucide-react";
import type { AggregatedGroup } from "./types";
import { parseEditStats } from "./aggregate-blocks";

interface TranscriptEditGroupProps {
  group: Extract<AggregatedGroup, { type: "edit_group" | "multi_edit_group" }>;
  className?: string;
}

export function TranscriptEditGroup({ group, className }: TranscriptEditGroupProps) {
  const [expanded, setExpanded] = useState(false);

  const label = group.type === "edit_group"
    ? group.filePath.split("/").pop() ?? group.filePath
    : `Edited · ${group.fileCount} files`;

  const totalStats = group.type === "edit_group"
    ? { additions: group.totalAdditions, deletions: group.totalDeletions }
    : group.items.reduce(
        (acc, item) => {
          const s = parseEditStats(item.result);
          return { additions: acc.additions + s.additions, deletions: acc.deletions + s.deletions };
        },
        { additions: 0, deletions: 0 },
      );

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 rounded-lg bg-muted/40 hover:bg-muted/60 text-left transition-colors"
      >
        <FileEdit className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80 font-mono flex-1">
          {label} · {group.items.length} edit{group.items.length !== 1 ? "s" : ""}
        </span>
        {(totalStats.additions > 0 || totalStats.deletions > 0) && (
          <span className="text-xs shrink-0">
            {totalStats.additions > 0 && <span className="text-emerald-500">+{totalStats.additions}</span>}
            {totalStats.additions > 0 && totalStats.deletions > 0 && " "}
            {totalStats.deletions > 0 && <span className="text-red-400">-{totalStats.deletions}</span>}
          </span>
        )}
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 space-y-1">
          {group.items.map((item, i) => {
            const stats = parseEditStats(item.result);
            const filePath = extractFilePath(item.input);
            return (
              <div key={i} className="flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground">
                <span className="font-mono truncate flex-1">{filePath ?? `Edit ${i + 1}`}</span>
                {(stats.additions > 0 || stats.deletions > 0) && (
                  <span>
                    {stats.additions > 0 && <span className="text-emerald-500">+{stats.additions}</span>}
                    {stats.additions > 0 && stats.deletions > 0 && " "}
                    {stats.deletions > 0 && <span className="text-red-400">-{stats.deletions}</span>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function extractFilePath(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}
```

- [ ] **Step 3: Create TranscriptProgressBlock**

```tsx
// ui/src/components/workspace/transcript/TranscriptProgressBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ListChecks, ChevronRight, ChevronDown, Check, Circle, Loader2 } from "lucide-react";

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TranscriptProgressBlockProps {
  todos: TodoItem[];
  className?: string;
}

export function TranscriptProgressBlock({ todos, className }: TranscriptProgressBlockProps) {
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const allDone = completed === total;
  const [expanded, setExpanded] = useState(!allDone);
  const pct = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div className={cn("rounded-lg", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 rounded-lg bg-muted/30 hover:bg-muted/50 text-left transition-colors"
      >
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80">
          Tasks · {completed}/{total} complete
        </span>
        <div className="flex-1 mx-2 h-[3px] bg-neutral-200 dark:bg-neutral-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 mb-2 space-y-0.5">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs">
              {todo.status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
              {todo.status === "in_progress" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
              {todo.status === "pending" && <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />}
              <span className={cn(
                "text-foreground/80",
                todo.status === "completed" && "text-muted-foreground",
              )}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/workspace/transcript/TranscriptAggregatedGroup.tsx ui/src/components/workspace/transcript/TranscriptEditGroup.tsx ui/src/components/workspace/transcript/TranscriptProgressBlock.tsx
git commit -m "feat(workspace): add aggregated group, edit group, and progress checklist components"
```

---

## Task 8: TranscriptToolCard (Department-Specific Rich Cards)

**Files:**
- Create: `ui/src/components/workspace/transcript/TranscriptToolCard.tsx`

- [ ] **Step 1: Implement TranscriptToolCard**

This is a shell for rich department-specific rendering. Starts with basic card layout — individual department renderers (image thumbnail, report preview, etc.) get added as departments are actually used.

```tsx
// ui/src/components/workspace/transcript/TranscriptToolCard.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Image,
  Video,
  FileText,
  BarChart3,
  Music,
  Paintbrush,
  Mail,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { EntryCategory } from "./types";

const CARD_CONFIG: Partial<Record<EntryCategory, { icon: LucideIcon; label: string }>> = {
  image_generated: { icon: Image, label: "Image generated" },
  video_generated: { icon: Video, label: "Video generated" },
  audio_generated: { icon: Music, label: "Audio generated" },
  content_generated: { icon: FileText, label: "Content generated" },
  report_generated: { icon: BarChart3, label: "Report generated" },
  chart_generated: { icon: BarChart3, label: "Chart generated" },
  draft_response: { icon: Mail, label: "Draft response" },
  design_asset: { icon: Paintbrush, label: "Design asset" },
  animation_created: { icon: Paintbrush, label: "Animation created" },
  email_campaign: { icon: Mail, label: "Email draft" },
};

interface TranscriptToolCardProps {
  name: string;
  summary: string;
  category: EntryCategory;
  status: "running" | "completed" | "error";
  result?: string;
  input?: unknown;
  className?: string;
}

export function TranscriptToolCard({
  name,
  summary,
  category,
  status,
  result,
  input,
  className,
}: TranscriptToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const config = CARD_CONFIG[category] ?? { icon: FileText, label: name };
  const Icon = config.icon;

  // Truncate preview to 4 lines
  const preview = result ? result.split("\n").slice(0, 4).join("\n") : null;
  const hasMore = result ? result.split("\n").length > 4 : false;

  return (
    <div className={cn("rounded-xl border border-border bg-card shadow-sm overflow-hidden", className)}>
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 h-10 text-left hover:bg-muted/30 transition-colors"
      >
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-[13px] text-foreground/80 flex-1 truncate">
          {config.label} · {summary}
        </span>
        {status === "running" && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />}
        {status === "completed" && <Check className="h-3.5 w-3.5 text-emerald-500" />}
        {status === "error" && <X className="h-3.5 w-3.5 text-red-500" />}
        {result && (expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />)}
      </button>

      {/* Preview (always shown for completed cards with results) */}
      {status === "completed" && preview && !expanded && (
        <div className="px-3 pb-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {preview}
          {hasMore && <span className="text-primary cursor-pointer" onClick={() => setExpanded(true)}> Show more</span>}
        </div>
      )}

      {/* Full result (expanded) */}
      {expanded && result && (
        <div className="px-3 pb-3 text-xs text-foreground/70 whitespace-pre-wrap max-h-[300px] overflow-auto">
          {result}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/workspace/transcript/TranscriptToolCard.tsx
git commit -m "feat(workspace): add TranscriptToolCard — rich card rendering for department-specific entries"
```

---

## Task 9: StructuredRunBlock Container

**Files:**
- Create: `ui/src/components/workspace/transcript/StructuredRunBlock.tsx`
- Create: `ui/src/components/workspace/transcript/index.ts`

This is the orchestrator that wires everything together.

- [ ] **Step 1: Create StructuredRunBlock**

```tsx
// ui/src/components/workspace/transcript/StructuredRunBlock.tsx

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { heartbeatsApi } from "../../../api/heartbeats";
import { getUIAdapter } from "../../../adapters/registry";
import { buildTranscript } from "../../../adapters/transcript";
import type { DepartmentType, DisplayBlock, TranscriptBlock, AggregatedGroup } from "./types";
import { isAggregatedGroup, RICH_CARD_CATEGORIES } from "./types";
import { normalizeTranscript } from "./normalize-transcript";
import { aggregateBlocks } from "./aggregate-blocks";
import { classifyToolEntry } from "./classify-entry";
import { TranscriptToolPill } from "./TranscriptToolPill";
import { TranscriptToolCard } from "./TranscriptToolCard";
import { TranscriptMessageBlock } from "./TranscriptMessageBlock";
import { TranscriptThinkingBlock } from "./TranscriptThinkingBlock";
import { TranscriptAggregatedGroup } from "./TranscriptAggregatedGroup";
import { TranscriptEditGroup } from "./TranscriptEditGroup";
import { TranscriptProgressBlock } from "./TranscriptProgressBlock";
import { TranscriptEventRow } from "./TranscriptEventRow";
import { TranscriptErrorBlock } from "./TranscriptErrorBlock";
import { TranscriptStdoutBlock } from "./TranscriptStdoutBlock";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseEditStats } from "./aggregate-blocks";

interface StructuredRunBlockProps {
  runId: string;
  adapterType: string;
  departmentType: DepartmentType;
  isRunning: boolean;
  isLatest?: boolean;
  compact?: boolean;
  agentName?: string;
  className?: string;
}

export function StructuredRunBlock({
  runId,
  adapterType,
  departmentType,
  isRunning,
  isLatest = false,
  compact = false,
  agentName = "Agent",
  className,
}: StructuredRunBlockProps) {
  const { data: logData, isLoading } = useQuery({
    queryKey: ["run-log", runId],
    queryFn: () => heartbeatsApi.log(runId),
    refetchInterval: isRunning ? 3000 : false,
  });

  const displayBlocks = useMemo<DisplayBlock[]>(() => {
    if (!logData?.content) return [];

    // Parse raw content into NDJSON chunks
    const chunks = parseNdjsonContent(logData.content);

    // Build transcript entries via adapter parser
    const adapter = getUIAdapter(adapterType);
    const entries = buildTranscript(chunks, adapter.parseStdoutLine);

    // Pass 1: normalize (merge messages, match tool_call/result, group commands)
    const blocks = normalizeTranscript(entries, isRunning);

    // Pass 2: aggregate consecutive same-category blocks
    return aggregateBlocks(blocks, departmentType);
  }, [logData?.content, adapterType, departmentType, isRunning]);

  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground", className)}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading run output...</span>
      </div>
    );
  }

  if (displayBlocks.length === 0) {
    if (isRunning) {
      return (
        <div className={cn("flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground", className)}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Waiting for output...</span>
        </div>
      );
    }
    return (
      <p className={cn("px-3 py-4 text-xs text-muted-foreground", className)}>
        No output recorded.
      </p>
    );
  }

  return (
    <div className={cn("space-y-1 py-2", className)}>
      {displayBlocks.map((block, i) => (
        <div key={i}>
          {renderBlock(block, departmentType, agentName)}
        </div>
      ))}
    </div>
  );
}

function renderBlock(block: DisplayBlock, departmentType: DepartmentType, agentName: string) {
  // Aggregated groups
  if (isAggregatedGroup(block)) {
    return renderAggregatedGroup(block as AggregatedGroup, departmentType);
  }

  const b = block as TranscriptBlock;

  switch (b.type) {
    case "message":
      return <TranscriptMessageBlock role={b.role} text={b.text} streaming={b.streaming} agentName={agentName} ts={b.ts} />;

    case "thinking":
      return <TranscriptThinkingBlock text={b.text} streaming={b.streaming} />;

    case "tool": {
      const category = classifyToolEntry(b.name, b.input, departmentType);
      const summary = extractToolSummary(b);

      // Progress update (TodoWrite)
      if (category === "progress_update") {
        const todos = extractTodos(b);
        if (todos) return <TranscriptProgressBlock todos={todos} />;
      }

      // Rich card
      if (RICH_CARD_CATEGORIES.has(category)) {
        return <TranscriptToolCard name={b.name} summary={summary} category={category} status={b.status} result={b.result} input={b.input} />;
      }

      // Default pill
      const editStats = category === "file_edit" ? parseEditStats(b.result) : undefined;
      return <TranscriptToolPill name={b.name} summary={summary} category={category} status={b.status} editStats={editStats} result={b.result} input={b.input} />;
    }

    case "command_group":
      return (
        <TranscriptAggregatedGroup
          group={{ type: "command_group_agg", items: b.items.map((item) => ({ type: "tool" as const, ts: item.ts, endTs: item.endTs, name: "command", input: item.input, result: item.result, isError: item.isError, status: item.status })), count: b.items.length }}
          departmentType={departmentType}
        />
      );

    case "tool_group":
      return (
        <TranscriptAggregatedGroup
          group={{ type: "generic_group", category: "generic_tool", items: b.items.map((item) => ({ type: "tool" as const, ts: item.ts, endTs: item.endTs, name: item.name, input: item.input, result: item.result, isError: item.isError, status: item.status })), count: b.items.length }}
          departmentType={departmentType}
        />
      );

    case "event":
      return <TranscriptEventRow label={b.label} text={b.text} tone={b.tone} />;

    case "stderr_group":
      return <TranscriptErrorBlock lines={b.lines} />;

    case "stdout":
      return <TranscriptStdoutBlock text={b.text} />;

    case "activity":
      return <TranscriptEventRow label={b.name} text={b.status} tone={b.status === "completed" ? "info" : "neutral"} />;

    default:
      return null;
  }
}

function renderAggregatedGroup(group: AggregatedGroup, departmentType: DepartmentType) {
  if (group.type === "edit_group" || group.type === "multi_edit_group") {
    return <TranscriptEditGroup group={group} />;
  }
  if (group.type === "thinking_group") {
    return <TranscriptThinkingBlock text={group.items.map((i) => i.text).join("\n")} streaming={false} isPreviousTurn={group.isPreviousTurn} />;
  }
  // read_group, search_group, web_group, command_group_agg, generic_group
  return <TranscriptAggregatedGroup group={group as any} departmentType={departmentType} />;
}

function extractToolSummary(block: Extract<TranscriptBlock, { type: "tool" }>): string {
  if (typeof block.input === "string") return block.input;
  const record = block.input as Record<string, unknown> | null;
  if (!record) return block.name;
  return (
    (typeof record.path === "string" && record.path) ||
    (typeof record.file_path === "string" && record.file_path) ||
    (typeof record.filePath === "string" && record.filePath) ||
    (typeof record.query === "string" && record.query) ||
    (typeof record.pattern === "string" && record.pattern) ||
    (typeof record.url === "string" && record.url) ||
    (typeof record.command === "string" && record.command) ||
    block.name
  ) as string;
}

function extractTodos(block: Extract<TranscriptBlock, { type: "tool" }>): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null {
  const record = block.input as Record<string, unknown> | null;
  if (!record || !Array.isArray(record.todos)) return null;
  return record.todos.map((t: any) => ({
    content: t.content ?? t.text ?? String(t),
    status: t.status ?? "pending",
  }));
}

/** Parse logData.content (raw string) into NDJSON chunks */
function parseNdjsonContent(content: string): Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> {
  const lines = content.split("\n").filter(Boolean);
  const chunks: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.ts === "string" && typeof parsed.chunk === "string") {
        chunks.push({
          ts: parsed.ts,
          stream: parsed.stream ?? "stdout",
          chunk: parsed.chunk,
        });
      }
    } catch {
      // If not NDJSON, treat entire content as single stdout chunk
      if (chunks.length === 0) {
        return [{ ts: new Date().toISOString(), stream: "stdout", chunk: content }];
      }
    }
  }
  return chunks.length > 0 ? chunks : [{ ts: new Date().toISOString(), stream: "stdout", chunk: content }];
}
```

- [ ] **Step 2: Create index.ts barrel export**

```typescript
// ui/src/components/workspace/transcript/index.ts

export { StructuredRunBlock } from "./StructuredRunBlock";
export { normalizeTranscript } from "./normalize-transcript";
export { classifyToolEntry } from "./classify-entry";
export { aggregateBlocks } from "./aggregate-blocks";
export type { TranscriptBlock, AggregatedGroup, DisplayBlock, DepartmentType, EntryCategory } from "./types";
```

- [ ] **Step 3: Verify compilation**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx tsc --noEmit 2>&1 | grep -i "transcript\|StructuredRun" | head -10`

Fix any type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/workspace/transcript/StructuredRunBlock.tsx ui/src/components/workspace/transcript/index.ts
git commit -m "feat(workspace): add StructuredRunBlock container — full pipeline from NDJSON to structured rendering"
```

---

## Task 10: Wire Into TimelineAgentMessage

**Files:**
- Modify: `ui/src/components/workspace/TimelineAgentMessage.tsx`
- Modify: `ui/src/components/workspace/WorkspaceTimeline.tsx`

- [ ] **Step 1: Read current TimelineAgentMessage to understand what to modify**

Read `ui/src/components/workspace/TimelineAgentMessage.tsx` in full (107 lines). Key structure:
- Lines 11-16: Props interface (`run`, `agentName`, `isLatest`, `compact`)
- Lines 25: `logExpanded` state
- Lines 27-32: `logData` query (heartbeatsApi.log) — REMOVE this, StructuredRunBlock handles its own fetching
- Lines 39-58: Header section — KEEP as-is
- Lines 60-65: File changes summary line — KEEP as-is
- Lines 67-103: "Collapsible raw log" section with `<pre>` dump — REPLACE ENTIRELY with StructuredRunBlock
- Line 92: The `<pre>` dump — this is what we're replacing

- [ ] **Step 2: Modify TimelineAgentMessage to use StructuredRunBlock**

Add two new props to the interface:
```typescript
interface TimelineAgentMessageProps {
  run: RunForIssue;
  agentName: string;
  isLatest?: boolean;
  compact?: boolean;
  adapterType?: string;
  departmentType?: string;
}
```

Add to destructuring:
```typescript
  adapterType = "process",
  departmentType = "general",
```

**Remove entirely:**
- The `logExpanded` state (line 25)
- The `logData` query (lines 27-32)
- The entire "Collapsible raw log" section (lines 67-103)

**Replace lines 67-103 with:**
```tsx
      {/* Structured run output */}
      <div className="border-t border-border">
        <StructuredRunBlock
          runId={run.runId}
          adapterType={adapterType}
          departmentType={departmentType as DepartmentType}
          isRunning={isRunning}
          isLatest={isLatest}
          compact={compact}
          agentName={agentName}
        />
      </div>
```

Add import at top:
```typescript
import { StructuredRunBlock } from "./transcript";
import type { DepartmentType } from "./transcript/types";
```

Remove unused imports: `Loader2`, `ChevronDown`, `ChevronRight` (if no longer used), `heartbeatsApi`.

- [ ] **Step 3: Modify WorkspaceTimeline to pass new props**

In `ui/src/components/workspace/WorkspaceTimeline.tsx`:

**For `adapterType`:** The `RunForIssue` type does NOT include `adapterType`. Get it from the agent object (which does have `adapterType`):
```typescript
const agentAdapterType = agent?.adapterType ?? "process";
```

**For `departmentType`:** The `issue` object has `projectId` (string) but NOT a nested project object. Add a project query:
```typescript
import { projectsApi } from "../../api/projects";

// Inside the component, add this query:
const { data: project } = useQuery({
  queryKey: queryKeys.projects.detail(issue?.projectId ?? ""),
  queryFn: () => projectsApi.get(issue!.projectId!),
  enabled: !!issue?.projectId,
});

const departmentType = project?.functionType ?? "general";
```

If `projectsApi.get()` doesn't exist, check what API is available. The project data may also be accessible via the parent WorkspaceView page — in that case, accept `departmentType` as a prop from the parent instead.

**Pass both to TimelineAgentMessage** at line ~200:
```tsx
<TimelineAgentMessage
  key={`run-${run.runId}`}
  run={run}
  agentName={agent?.name ?? run.agentId.slice(0, 8)}
  isLatest={isLatest}
  compact={compact}
  adapterType={agentAdapterType}
  departmentType={departmentType}
/>
```

- [ ] **Step 4: Verify the app compiles and renders**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx tsc --noEmit 2>&1 | tail -20`

Then: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vite build 2>&1 | tail -10`

Expected: Both pass without errors.

- [ ] **Step 5: Run existing tests to ensure nothing breaks**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run 2>&1 | tail -20`

Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/workspace/TimelineAgentMessage.tsx ui/src/components/workspace/WorkspaceTimeline.tsx
git commit -m "feat(workspace): wire StructuredRunBlock into timeline — replace raw <pre> dump with structured rendering"
```

---

## Task 11: Integration Test

**Files:**
- Create: `ui/src/__tests__/transcript/StructuredRunBlock.test.tsx`

- [ ] **Step 1: Write integration test**

```typescript
// ui/src/__tests__/transcript/StructuredRunBlock.test.tsx

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { StructuredRunBlock } from "../../components/workspace/transcript";

// Mock heartbeatsApi
vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: new Proxy({}, {
    get: () => vi.fn(),
  }),
}));

// Import mocked module
import { heartbeatsApi } from "../../api/heartbeats";

function renderComponent(props: Partial<React.ComponentProps<typeof StructuredRunBlock>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StructuredRunBlock
          runId="test-run-1"
          adapterType="claude_local"
          departmentType="software_development"
          isRunning={false}
          agentName="Claude Code"
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StructuredRunBlock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state initially", () => {
    (heartbeatsApi.log as any).mockReturnValue(new Promise(() => {})); // never resolves
    renderComponent();
    expect(screen.getByText("Loading run output...")).toBeTruthy();
  });

  it("shows empty state for run with no output", async () => {
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "", logRef: "", content: "" });
    renderComponent();
    await waitFor(() => {
      expect(screen.getByText("No output recorded.")).toBeTruthy();
    });
  });

  it("shows waiting state for running run with no output", async () => {
    (heartbeatsApi.log as any).mockResolvedValue({ runId: "test-run-1", store: "", logRef: "", content: "" });
    renderComponent({ isRunning: true });
    await waitFor(() => {
      expect(screen.getByText("Waiting for output...")).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/transcript/StructuredRunBlock.test.tsx 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 3: Run full test suite**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run 2>&1 | tail -20`

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/transcript/StructuredRunBlock.test.tsx
git commit -m "test(workspace): add StructuredRunBlock integration tests"
```

---

## Task 12: Final Build Verification

- [ ] **Step 1: Run full build**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vite build 2>&1 | tail -20`

Expected: Build succeeds.

- [ ] **Step 2: Run full test suite**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run 2>&1 | tail -30`

Expected: All tests pass, including new transcript tests.

- [ ] **Step 3: Verify no regressions in existing workspace components**

Run: `cd "C:/Users/TK/OneDrive/Desktop/Claude Data/AoA-AoA/aoa-2.5" && npx vitest run ui/src/__tests__/RunBlock.test.tsx 2>&1 | tail -10`

Expected: Existing RunBlock tests still pass (RunBlock still exists, just not used in timeline anymore).

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(workspace): structured timeline rendering — complete implementation

Replaces raw <pre> log dump in workspace timeline with structured,
department-aware rendering. Agent work now displays as scannable pills,
cards, and messages instead of raw text.

- Port normalizeTranscript from AoA (tool matching, message merging, grouping)
- Add department-aware entry classifier (60+ categories across 9 departments)
- Add pass-2 aggregation (consecutive grouping for reads, edits, searches)
- Build 12 focused rendering components (pills, cards, messages, events)
- Wire StructuredRunBlock into TimelineAgentMessage"
```

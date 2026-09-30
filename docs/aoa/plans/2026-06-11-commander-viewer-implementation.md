# Commander Content Viewer (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commander chat gets a collapsible right-side viewer panel; tool calls that touch artifacts produce persistent, clickable chips that open rendered content (the design is `docs/aoa/plans/2026-06-11-commander-viewer-design.md`, v2 — read §3 before starting).

**Architecture:** Refs are computed in the MCP bridge (`buildOutputRefs`, pure), travel inside the bridge's existing JSON result envelope through the CLI subprocess's stdout, get lifted by both stdout parsers into `tool_result` chunks, accumulate in agent-loop, persist on `internal_agent_messages.output_refs` (new jsonb), and stream to the client in the existing `tool_result` SSE event. The UI renders chips under assistant messages and a `ViewerTabs` + `SharedContentViewer` panel (Discussions pattern).

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (NEVER raw SQL migrations), React + Vite + Tailwind v4, zod, vitest. pnpm workspace.

**Worktree:** All work happens in `C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-commander` on branch `feat/v1-commander-chat`. Dependencies already installed (`pnpm install` is done).

**Test commands:**
- Server/packages tests (run from repo root): `pnpm vitest run <path>` (root `test` script is plain vitest)
- UI tests: `cd ui && pnpm vitest run <path-relative-to-ui>`
- Full suite: `pnpm test:run` (root) — run at the end, not per task
- E2E (Task 17): `pnpm test:e2e -- commander-viewer.spec.ts` — Linux/CI, or Windows with external `DATABASE_URL` (embedded-postgres e2e is config-skipped on Windows)

---

## Task 1: Shared ref type + zod schema

**Files:**
- Create: `packages/shared/src/commander-output-refs.ts`
- Modify: `packages/shared/src/index.ts` (add export)
- Test: `packages/shared/src/__tests__/commander-output-refs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/commander-output-refs.test.ts
import { describe, it, expect } from "vitest";
import {
  commanderOutputRefSchema,
  commanderOutputRefsSchema,
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
} from "../commander-output-refs.js";

const validRef = {
  v: 1,
  kind: "artifact",
  id: "art-123",
  versionId: "ver-456",
  versionNumber: 2,
  title: "GTM Plan",
  action: "created",
  toolCallId: null,
  mimeType: null,
};

describe("commanderOutputRefSchema", () => {
  it("accepts a valid ref", () => {
    expect(commanderOutputRefSchema.safeParse(validRef).success).toBe(true);
  });

  it("accepts minimal ref (optional fields absent)", () => {
    const minimal = { v: 1, kind: "artifact", id: "a1", action: "referenced" };
    expect(commanderOutputRefSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects unknown kind, bad action, missing id, wrong v", () => {
    expect(commanderOutputRefSchema.safeParse({ ...validRef, kind: "task" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, action: "made" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, id: "" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, v: 2 }).success).toBe(false);
  });

  it("rejects title over the cap", () => {
    const long = { ...validRef, title: "x".repeat(MAX_OUTPUT_REF_TITLE_LENGTH + 1) };
    expect(commanderOutputRefSchema.safeParse(long).success).toBe(false);
  });

  it("array schema rejects > MAX refs", () => {
    const tooMany = Array.from({ length: MAX_OUTPUT_REFS_PER_MESSAGE + 1 }, () => validRef);
    expect(commanderOutputRefsSchema.safeParse(tooMany).success).toBe(false);
    expect(commanderOutputRefsSchema.safeParse([validRef]).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/__tests__/commander-output-refs.test.ts`
Expected: FAIL — cannot resolve `../commander-output-refs.js`

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/commander-output-refs.ts
//
// Commander viewer output refs (P1 design v2 §3a).
// A ref is a presentation pointer (ID + label) — never content, never a
// capability grant. Computed in the MCP bridge, transported in the tool
// result envelope, persisted on internal_agent_messages.output_refs.
import { z } from "zod";

export const COMMANDER_OUTPUT_REF_KINDS = ["artifact"] as const;
export type CommanderOutputRefKind = (typeof COMMANDER_OUTPUT_REF_KINDS)[number];

export const MAX_OUTPUT_REFS_PER_MESSAGE = 20;
export const MAX_OUTPUT_REF_TITLE_LENGTH = 200;

export interface CommanderOutputRef {
  v: 1;
  kind: CommanderOutputRefKind;
  id: string;
  versionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  action: "created" | "referenced";
  toolCallId?: string | null;
  mimeType?: string | null;
}

export const commanderOutputRefSchema = z.object({
  v: z.literal(1),
  kind: z.enum(COMMANDER_OUTPUT_REF_KINDS),
  id: z.string().min(1).max(256),
  versionId: z.string().min(1).max(256).nullish(),
  versionNumber: z.number().int().positive().nullish(),
  title: z.string().max(MAX_OUTPUT_REF_TITLE_LENGTH).nullish(),
  action: z.enum(["created", "referenced"]),
  toolCallId: z.string().min(1).max(256).nullish(),
  mimeType: z.string().min(1).max(256).nullish(),
});

export const commanderOutputRefsSchema = z
  .array(commanderOutputRefSchema)
  .max(MAX_OUTPUT_REFS_PER_MESSAGE);
```

Then add to `packages/shared/src/index.ts` (alongside the other `export *` lines — open the file and match its style):

```ts
export * from "./commander-output-refs.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/src/__tests__/commander-output-refs.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/commander-output-refs.ts packages/shared/src/index.ts packages/shared/src/__tests__/commander-output-refs.test.ts
git commit -m "feat(shared): CommanderOutputRef type + zod schema (viewer P1)"
```

---

## Task 2: Ref-builder (pure function)

**Files:**
- Create: `server/src/services/internal-agent/output-refs.ts`
- Test: `server/src/services/internal-agent/__tests__/output-refs.test.ts`

Verified tool shapes this builder maps (do not re-derive — these were read from source):
- `create_artifact` → data `{ artifactId, versionId }`; params have required `title`, optional `type` (`tools/create-artifact-tool.ts:87-91`)
- `create_artifact_version` → data `{ versionId, versionNumber }`; params have required `artifactId` (`tools/artifact-create-version.ts:92`)
- `attach_task_artifact` → params have required `title`; read its return statement (`tools/attach-task-artifact-tool.ts` ~line 160-185) during Step 3 and match the data field names — the builder below reads `data.artifactId` and `data.versionId ?? data.artifactVersionId` defensively
- `query_artifacts` → data is an array of `{ artifactId, title, type, currentVersionId, status }` (`tools/artifact-query.ts:47-53`)
- `get_task` → data has `artifactId` (nullable) and `title` (the TASK title) (`tools/get-task-tool.ts:63-83`)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/internal-agent/__tests__/output-refs.test.ts
import { describe, it, expect } from "vitest";
import { buildOutputRefs, mergeOutputRefs } from "../output-refs.js";
import type { CommanderOutputRef } from "@armyofagents/shared";

const ok = (data: unknown) => ({ success: true, data, summary: "ok" });

describe("buildOutputRefs", () => {
  it("create_artifact → created ref; title from params", () => {
    const refs = buildOutputRefs(
      "create_artifact",
      { title: "GTM Plan", type: "document" },
      ok({ artifactId: "art-1", versionId: "ver-1" }),
    );
    expect(refs).toEqual([
      expect.objectContaining({
        v: 1, kind: "artifact", id: "art-1", versionId: "ver-1",
        title: "GTM Plan", action: "created",
      }),
    ]);
  });

  it("create_artifact_version → created ref; artifactId from params, versionNumber from data", () => {
    const refs = buildOutputRefs(
      "create_artifact_version",
      { artifactId: "art-1", content: "..." },
      ok({ versionId: "ver-2", versionNumber: 2 }),
    );
    expect(refs[0]).toMatchObject({ id: "art-1", versionId: "ver-2", versionNumber: 2, action: "created" });
  });

  it("query_artifacts → referenced ref per row, currentVersionId mapped to versionId", () => {
    const refs = buildOutputRefs("query_artifacts", { threadId: "t1" }, ok([
      { artifactId: "a1", title: "One", type: "document", currentVersionId: "v1", status: "active" },
      { artifactId: "a2", title: "Two", type: "report", currentVersionId: null, status: "draft" },
    ]));
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ id: "a1", versionId: "v1", title: "One", action: "referenced" });
  });

  it("query_company_artifacts maps like query_artifacts", () => {
    const refs = buildOutputRefs("query_company_artifacts", {}, ok([
      { artifactId: "a9", title: "Nine", type: "code", currentVersionId: "v9", status: "active" },
    ]));
    expect(refs[0]).toMatchObject({ id: "a9", action: "referenced" });
  });

  it("get_task → referenced ref iff artifactId non-null", () => {
    expect(buildOutputRefs("get_task", { taskId: "t1" }, ok({ artifactId: "a1", title: "Fix auth" })))
      .toHaveLength(1);
    expect(buildOutputRefs("get_task", { taskId: "t1" }, ok({ artifactId: null, title: "Fix auth" })))
      .toHaveLength(0);
  });

  it("unknown tool, failed result, malformed data → []", () => {
    expect(buildOutputRefs("post_entry", {}, ok({ entryId: "e1" }))).toEqual([]);
    expect(buildOutputRefs("create_artifact", { title: "X" }, { success: false, data: null, summary: "no", error: "E" })).toEqual([]);
    expect(buildOutputRefs("create_artifact", null, ok("not-an-object"))).toEqual([]);
    expect(buildOutputRefs("query_artifacts", {}, ok({ not: "an array" }))).toEqual([]);
  });

  it("clamps long titles to 200 chars", () => {
    const refs = buildOutputRefs("create_artifact", { title: "x".repeat(500) }, ok({ artifactId: "a1", versionId: null }));
    expect(refs[0]!.title).toHaveLength(200);
  });
});

describe("mergeOutputRefs", () => {
  const ref = (id: string, action: "created" | "referenced", versionId: string | null = null): CommanderOutputRef =>
    ({ v: 1, kind: "artifact", id, versionId, action });

  it("dedupes by (kind,id,versionId); created beats referenced", () => {
    const merged = mergeOutputRefs([ref("a1", "referenced")], [ref("a1", "created")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.action).toBe("created");
  });

  it("different versionIds are distinct refs", () => {
    expect(mergeOutputRefs([ref("a1", "created", "v1")], [ref("a1", "created", "v2")])).toHaveLength(2);
  });

  it("caps at 20 with created surviving first", () => {
    const referenced = Array.from({ length: 25 }, (_, i) => ref(`r${i}`, "referenced"));
    const created = [ref("c1", "created"), ref("c2", "created")];
    const merged = mergeOutputRefs(referenced, created);
    expect(merged).toHaveLength(20);
    expect(merged.filter((r) => r.action === "created")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/output-refs.test.ts`
Expected: FAIL — cannot resolve `../output-refs.js`

- [ ] **Step 3: Write the implementation**

```ts
// server/src/services/internal-agent/output-refs.ts
//
// Pure ref-builder for the Commander viewer (design v2 §3b).
// Called from the MCP bridge with (toolName, args, structured ToolResult).
// MUST NEVER THROW — a ref bug can't be allowed to fail a tool call.
import {
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
  type CommanderOutputRef,
} from "@armyofagents/shared";
import type { ToolResult } from "./types.js";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function asId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asTitle(v: unknown): string | null {
  return typeof v === "string" && v.length > 0
    ? v.slice(0, MAX_OUTPUT_REF_TITLE_LENGTH)
    : null;
}
function asVersionNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

function artifactRef(partial: {
  id: string | null;
  versionId?: unknown;
  versionNumber?: unknown;
  title?: unknown;
  action: "created" | "referenced";
}): CommanderOutputRef | null {
  if (!partial.id) return null;
  return {
    v: 1,
    kind: "artifact",
    id: partial.id,
    versionId: asId(partial.versionId) ?? null,
    versionNumber: asVersionNumber(partial.versionNumber),
    title: asTitle(partial.title),
    action: partial.action,
    toolCallId: null,
    mimeType: null,
  };
}

function refsFromRows(data: unknown): CommanderOutputRef[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => {
      const r = asRecord(row);
      return artifactRef({
        id: asId(r.artifactId),
        versionId: r.currentVersionId,
        title: r.title,
        action: "referenced",
      });
    })
    .filter((r): r is CommanderOutputRef => r !== null);
}

export function buildOutputRefs(
  toolName: string,
  params: unknown,
  result: ToolResult,
): CommanderOutputRef[] {
  try {
    if (!result || result.success !== true) return [];
    const p = asRecord(params);
    const d = asRecord(result.data);

    switch (toolName) {
      case "create_artifact": {
        const ref = artifactRef({
          id: asId(d.artifactId),
          versionId: d.versionId,
          // create() makes the first version when content/fileRef given.
          versionNumber: asId(d.versionId) ? 1 : null,
          title: p.title,
          action: "created",
        });
        return ref ? [ref] : [];
      }
      case "create_artifact_version": {
        const ref = artifactRef({
          id: asId(p.artifactId),
          versionId: d.versionId,
          versionNumber: d.versionNumber,
          title: null,
          action: "created",
        });
        return ref ? [ref] : [];
      }
      case "attach_task_artifact": {
        const ref = artifactRef({
          id: asId(d.artifactId),
          versionId: d.versionId ?? d.artifactVersionId,
          title: p.title,
          action: "created",
        });
        return ref ? [ref] : [];
      }
      case "query_artifacts":
      case "query_company_artifacts":
        return refsFromRows(result.data).slice(0, MAX_OUTPUT_REFS_PER_MESSAGE);
      case "get_task": {
        const ref = artifactRef({
          id: asId(d.artifactId),
          title: d.title, // task title fallback; viewer resolves real name on open
          action: "referenced",
        });
        return ref ? [ref] : [];
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

const refKey = (r: CommanderOutputRef) => `${r.kind}|${r.id}|${r.versionId ?? ""}`;

export function mergeOutputRefs(
  existing: CommanderOutputRef[],
  incoming: CommanderOutputRef[],
): CommanderOutputRef[] {
  const map = new Map<string, CommanderOutputRef>();
  for (const r of [...existing, ...incoming]) {
    const k = refKey(r);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, r);
    } else if (prev.action === "referenced" && r.action === "created") {
      map.set(k, { ...r, title: r.title ?? prev.title });
    } else if (!prev.title && r.title) {
      map.set(k, { ...prev, title: r.title });
    }
  }
  const all = [...map.values()];
  if (all.length <= MAX_OUTPUT_REFS_PER_MESSAGE) return all;
  const created = all.filter((r) => r.action === "created");
  const referenced = all.filter((r) => r.action === "referenced");
  return [...created, ...referenced].slice(0, MAX_OUTPUT_REFS_PER_MESSAGE);
}
```

- [ ] **Step 4: Verify `attach_task_artifact` field names.** Read the return statement in `server/src/services/internal-agent/tools/attach-task-artifact-tool.ts` (search for `return {` near the end, around lines 160-185). If the success `data` uses different keys than `artifactId`/`versionId`/`artifactVersionId`, adjust the `attach_task_artifact` case and ADD a test for the actual shape.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/output-refs.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/output-refs.ts server/src/services/internal-agent/__tests__/output-refs.test.ts
git commit -m "feat(commander): pure output-ref builder + merge (viewer P1)"
```

---

## Task 3: Bridge envelope carries refs

**Files:**
- Modify: `server/src/services/internal-agent/mcp-bridge.ts:43-70` (`executeAndFormat`)
- Test: `server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts`

The existing test `__tests__/handler-crash-isolation.test.ts` shows the pattern: build a handler with `createToolCallHandler({ tools, executeTool, toolContext })` using stubs — copy that setup style.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts
import { describe, it, expect } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";
import type { AgentTool, ToolContext, ToolResult } from "../types.js";

const ctx = { companyId: "c1", userId: "u1", userRole: "founder" } as unknown as ToolContext;

function makeTool(name: string): AgentTool {
  return {
    name,
    description: "t",
    parameters: { type: "object", properties: {} },
    category: "action",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "unused" }),
  } as unknown as AgentTool;
}

describe("mcp-bridge envelope outputRefs", () => {
  it("includes outputRefs for create_artifact results", async () => {
    const handler = createToolCallHandler({
      tools: [makeTool("create_artifact")],
      executeTool: async (): Promise<ToolResult> => ({
        success: true,
        data: { artifactId: "art-1", versionId: "ver-1" },
        summary: "Created artifact: GTM Plan",
      }),
      toolContext: ctx,
    });
    const res = await handler("create_artifact", { title: "GTM Plan", type: "document" });
    const envelope = JSON.parse(res.content[0]!.text);
    expect(envelope.outputRefs).toHaveLength(1);
    expect(envelope.outputRefs[0]).toMatchObject({ kind: "artifact", id: "art-1", action: "created", title: "GTM Plan" });
  });

  it("omits outputRefs key for tools with no refs", async () => {
    const handler = createToolCallHandler({
      tools: [makeTool("post_entry")],
      executeTool: async (): Promise<ToolResult> => ({ success: true, data: { entryId: "e1" }, summary: "ok" }),
      toolContext: ctx,
    });
    const res = await handler("post_entry", {});
    const envelope = JSON.parse(res.content[0]!.text);
    expect("outputRefs" in envelope).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts`
Expected: FAIL — `envelope.outputRefs` is undefined

- [ ] **Step 3: Implement.** In `mcp-bridge.ts`, add the import and extend `executeAndFormat`:

```ts
import { buildOutputRefs } from "./output-refs.js";
import type { CommanderOutputRef } from "@armyofagents/shared";
```

Replace the body of `executeAndFormat` (currently lines 43-70) with:

```ts
async function executeAndFormat(
  tool: AgentTool,
  args: unknown,
  deps: ToolCallHandlerDeps,
): Promise<McpToolResult> {
  try {
    const result = await deps.executeTool(tool, args, deps.toolContext);
    let outputRefs: CommanderOutputRef[] = [];
    try {
      outputRefs = buildOutputRefs(tool.name, args, result);
    } catch {
      outputRefs = []; // ref extraction must never fail the tool call
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: result.success,
            data: result.data,
            summary: result.summary,
            ...(result.error ? { error: result.error } : {}),
            ...(outputRefs.length > 0 ? { outputRefs } : {}),
          }),
        },
      ],
      isError: !result.success,
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Tool execution error: ${err?.message ?? "Unknown"}` }],
      isError: true,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass (including the existing bridge tests)**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts server/src/services/internal-agent/__tests__/handler-crash-isolation.test.ts`
Expected: PASS, no regressions

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/mcp-bridge.ts server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts
git commit -m "feat(commander): bridge envelope carries outputRefs (viewer P1)"
```

---

## Task 4: Claude stream parser — name correlation + refs lift

**Files:**
- Modify: `server/src/services/internal-agent/agent-loop.ts:37` (chunk type)
- Modify: `server/src/services/internal-agent/parse-stream-json.ts` (class state + both event handlers)
- Test: `server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts`

This task ALSO fixes the existing tool-spinner bug: `tool_result.name` becomes the real tool name instead of the tool_use id, so the UI's name-matching (`InternalAgentPanel.tsx:626-644`) starts working.

- [ ] **Step 1: Extend the chunk type.** In `agent-loop.ts`, add the import and amend line 37:

```ts
import type { CommanderOutputRef } from "@armyofagents/shared";
```

```ts
  | { type: "tool_result"; name: string; result: ToolResult; refs?: CommanderOutputRef[] }
```

- [ ] **Step 2: Write the failing test**

```ts
// server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts
import { describe, it, expect } from "vitest";
import { StreamJsonParser } from "../parse-stream-json.js";

const assistantToolUse = JSON.stringify({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id: "toolu_01", name: "create_artifact", input: { title: "Plan" } }],
  },
});

function userToolResult(text: string) {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_01", content: text }] },
  });
}

const envelope = JSON.stringify({
  success: true,
  data: { artifactId: "art-1", versionId: "ver-1" },
  summary: "Created artifact: Plan",
  outputRefs: [
    { v: 1, kind: "artifact", id: "art-1", versionId: "ver-1", versionNumber: 1, title: "Plan", action: "created", toolCallId: null, mimeType: null },
  ],
});

describe("StreamJsonParser refs + name correlation", () => {
  it("resolves tool_result.name via the tool_use id map and lifts refs", () => {
    const parser = new StreamJsonParser();
    const chunks = [
      ...parser.push(assistantToolUse + "\n"),
      ...parser.push(userToolResult(envelope) + "\n"),
      ...parser.flush(),
    ];
    const toolResult = chunks.find((c) => c.type === "tool_result") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.name).toBe("create_artifact"); // NOT "toolu_01"
    expect(toolResult.refs).toHaveLength(1);
    expect(toolResult.refs[0]).toMatchObject({ id: "art-1", action: "created" });
  });

  it("non-JSON tool_result content → no refs, name falls back to the id", () => {
    const parser = new StreamJsonParser();
    const chunks = [...parser.push(userToolResult("plain text output") + "\n"), ...parser.flush()];
    const toolResult = chunks.find((c) => c.type === "tool_result") as any;
    expect(toolResult.name).toBe("toolu_01"); // no prior tool_use seen
    expect(toolResult.refs).toBeUndefined();
  });

  it("invalid refs in envelope are dropped (zod), chunk still emitted", () => {
    const bad = JSON.stringify({ success: true, data: {}, summary: "ok", outputRefs: [{ v: 99, kind: "nope" }] });
    const parser = new StreamJsonParser();
    const chunks = [...parser.push(userToolResult(bad) + "\n"), ...parser.flush()];
    const toolResult = chunks.find((c) => c.type === "tool_result") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.refs).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts`
Expected: FAIL — `toolResult.name` is `"toolu_01"` in the first test and `refs` undefined

- [ ] **Step 4: Implement in `parse-stream-json.ts`.**

(a) Add imports at the top:

```ts
import { commanderOutputRefsSchema, type CommanderOutputRef } from "@armyofagents/shared";
```

(b) Give the parser instance state and thread it through. The class (line 69) gains a field, and `parseLine` calls gain an argument — find every `parseLine(line)` call inside `push()` and `flush()` and pass the map:

```ts
export class StreamJsonParser {
  private buffer: string = "";
  /** tool_use id → tool name, for tool_result name correlation (spinner fix + refs). */
  private toolNames = new Map<string, string>();
  // ... in push() and flush(): parseLine(line, this.toolNames)
```

Change the signatures: `function parseLine(line: string, toolNames: Map<string, string>): AgentStreamChunk[]` and pass `toolNames` down to `handleAssistantEvent(event, toolNames)` and `handleUserEvent(event, toolNames)`.

(c) In `handleAssistantEvent`'s `tool_use` branch (line ~180-188), record the mapping right before pushing the chunk:

```ts
      if (id && name) toolNames.set(id, name);
      chunks.push({ type: "tool_call", id, name, input });
```

(d) In `handleUserEvent`'s plain `tool_result` branch (lines 250-267), resolve the name and lift refs — keep the `result` construction EXACTLY as it is today (do not change `data`/`summary` semantics):

```ts
    const toolUseId = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    const resolvedName = toolNames.get(toolUseId) ?? toolUseId;
    const isError = b.is_error === true;

    // Lift outputRefs from the bridge's JSON envelope (lenient — any failure ⇒ no refs).
    let refs: CommanderOutputRef[] | undefined;
    try {
      const parsedEnvelope = JSON.parse(fullText) as { outputRefs?: unknown };
      const validated = commanderOutputRefsSchema.safeParse(parsedEnvelope?.outputRefs);
      if (validated.success && validated.data.length > 0) refs = validated.data;
    } catch {
      /* not JSON — fine */
    }

    chunks.push({
      type: "tool_result",
      name: resolvedName,
      result: {
        success: !isError,
        data: fullText,
        summary: fullText,
        ...(isError ? { error: fullText } : {}),
      },
      ...(refs ? { refs } : {}),
    });
```

- [ ] **Step 5: Run the new test + every existing test that touches this parser**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts`
Expected: PASS (3 tests)

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/`
Expected: PASS — if any existing test asserted `tool_result.name === <tool_use_id>`, update that assertion to the resolved-name behavior (it was asserting the bug).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/agent-loop.ts server/src/services/internal-agent/parse-stream-json.ts server/src/services/internal-agent/__tests__/parse-stream-json-refs.test.ts
git commit -m "feat(commander): claude parser lifts outputRefs + fixes tool_result name correlation"
```

---

## Task 5: Codex parser — refs lift

**Files:**
- Modify: `packages/adapters/codex-local/src/server/parse.ts` (chunk union + item branch)
- Test: `server/src/__tests__/codex-local-adapter.test.ts` (extend — it already imports `parseCodexJsonl`)

No zod here (the adapter package shouldn't grow a shared dependency for this): structural lift only; the server validates authoritatively at persist time (Task 7).

- [ ] **Step 1: Write the failing test.** Append to `server/src/__tests__/codex-local-adapter.test.ts`:

```ts
describe("parseCodexJsonl outputRefs lift", () => {
  it("emits a tool_result chunk when the result envelope carries outputRefs", () => {
    const envelope = JSON.stringify({
      success: true,
      data: { artifactId: "art-1" },
      summary: "Created artifact: Plan",
      outputRefs: [{ v: 1, kind: "artifact", id: "art-1", action: "created", title: "Plan" }],
    });
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "th-1" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", name: "create_artifact", content: envelope },
      }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
    ].join("\n");

    const parsed = parseCodexJsonl(stdout);
    const toolResults = parsed.chunks.filter((c: any) => c.type === "tool_result") as any[];
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].name).toBe("create_artifact");
    expect(toolResults[0].refs).toHaveLength(1);
    expect(toolResults[0].refs[0]).toMatchObject({ id: "art-1", action: "created" });
  });

  it("emits NO tool_result chunk for plain results (no refs)", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: { type: "tool_result", content: JSON.stringify({ success: true, data: {}, summary: "ok" }) },
    });
    const parsed = parseCodexJsonl(stdout);
    expect(parsed.chunks.filter((c: any) => c.type === "tool_result")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/__tests__/codex-local-adapter.test.ts`
Expected: new tests FAIL (no tool_result chunks emitted); existing tests still PASS

- [ ] **Step 3: Implement in `parse.ts`.**

(a) Extend the union (line 6-11) and add a structural lifter.

**Typing constraint (verified):** this adapter package does NOT depend on `@armyofagents/shared`, and `cli-mode.ts:973-975` yields these chunks into the `AgentStreamChunk` stream — so the refs must be typed as a **local structural mirror** of `CommanderOutputRef` (literal `v`/`kind`/`action` types), which TypeScript accepts structurally at the yield site. `unknown[]` would NOT compile there. The screen rebuilds objects field-by-field (also strips unknown keys):

```ts
/**
 * Structural mirror of @armyofagents/shared CommanderOutputRef (P1: artifact kind).
 * This package deliberately has no dependency on shared; the screen below
 * enforces the shape and the server zod-validates again at persist time.
 */
type LiftedOutputRef = {
  v: 1;
  kind: "artifact";
  id: string;
  versionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  action: "created" | "referenced";
  toolCallId?: string | null;
  mimeType?: string | null;
};

type CodexParsedChunk =
  | {
      type: "action_confirmation";
      toolName: string;
      params: unknown;
      runId: string;
    }
  | {
      type: "tool_result";
      name: string;
      result: { success: boolean; data: unknown; summary: string };
      refs: LiftedOutputRef[];
    };

/** Minimal structural screen — authoritative validation happens server-side. */
function liftOutputRefs(text: string): LiftedOutputRef[] | null {
  try {
    const parsed = JSON.parse(text) as { outputRefs?: unknown };
    if (!Array.isArray(parsed?.outputRefs) || parsed.outputRefs.length === 0) return null;
    const screened: LiftedOutputRef[] = [];
    for (const r of parsed.outputRefs) {
      const rec = parseObject(r);
      if (
        rec.v === 1 &&
        rec.kind === "artifact" &&
        typeof rec.id === "string" &&
        rec.id.length > 0 &&
        (rec.action === "created" || rec.action === "referenced")
      ) {
        screened.push({
          v: 1,
          kind: "artifact",
          id: rec.id,
          versionId: typeof rec.versionId === "string" ? rec.versionId : null,
          versionNumber: typeof rec.versionNumber === "number" ? rec.versionNumber : null,
          title: typeof rec.title === "string" ? rec.title : null,
          action: rec.action,
          toolCallId: typeof rec.toolCallId === "string" ? rec.toolCallId : null,
          mimeType: typeof rec.mimeType === "string" ? rec.mimeType : null,
        });
      }
    }
    return screened.length > 0 ? screened : null;
  } catch {
    return null;
  }
}
```

(b) In `parseCodexJsonl`'s `item.completed` branch (lines 145-148), after the confirm check, lift refs:

```ts
      } else if (asString(item.type, "") === "tool_result" || asString(item.type, "") === "mcp_tool_call") {
        const chunk = parseActionConfirmation(item);
        if (chunk) chunks.push(chunk);
        else {
          const text = normalizeToolResultText(item);
          const refs = liftOutputRefs(text);
          if (refs) {
            chunks.push({
              type: "tool_result",
              name: asString(item.name, "") || asString(item.tool, ""),
              result: { success: true, data: text, summary: text },
              refs,
            });
          }
        }
      }
```

Note: `cli-mode.ts:973-975` yields `parsed.chunks` directly into the `AgentStreamChunk` stream — the new chunk's shape matches `{ type: "tool_result"; name; result; refs? }`, so no cli-mode change is needed. TypeScript will confirm (the yield site type-checks against `AgentStreamChunk`).

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run server/src/__tests__/codex-local-adapter.test.ts`
Expected: PASS (all, including the 2 new)

Also typecheck the adapter + server compile: `pnpm vitest run server/src/services/internal-agent/__tests__/output-refs.test.ts` (forces TS build of touched files)
Expected: PASS, no type errors reported

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/codex-local/src/server/parse.ts server/src/__tests__/codex-local-adapter.test.ts
git commit -m "feat(commander): codex parser lifts outputRefs into tool_result chunks"
```

---

## Task 6: DB column + migration

**Files:**
- Modify: `packages/db/src/schema/internal_agent.ts` (~line 204, beside `toolResults`)
- Generated: a new migration under `packages/db` (drizzle-kit output — do NOT hand-write)

- [ ] **Step 1: Add the column.** In the `internalAgentMessages` table definition, directly after the `toolResults` line (line 204):

```ts
    outputRefs: jsonb("output_refs"), // CommanderOutputRef[] — distilled viewer refs (design 2026-06-11 §3d)
```

- [ ] **Step 2: Generate the migration**

Run (repo root): `pnpm db:generate`
Expected: a new migration file appears under `packages/db` (drizzle output dir) containing `ALTER TABLE "internal_agent_messages" ADD COLUMN "output_refs" jsonb;`

- [ ] **Step 3: Commit (schema + generated migration together)**

```bash
git add packages/db
git commit -m "feat(db): internal_agent_messages.output_refs jsonb (viewer P1)"
```

---

## Task 7: Persist refs in `appendMessage`

**Files:**
- Modify: `server/src/services/internal-agent/conversation.ts:8-17` (MessageInput) and `:46-61` (appendMessage)
- Test: `server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts`

- [ ] **Step 1: Write the failing test** (mock db capturing the insert values — the chain used is `db.insert(...).values(...).returning().then(...)`, then `db.update(...).set(...).where(...)`):

```ts
// server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts
import { describe, it, expect } from "vitest";
import { conversationService } from "../conversation.js";

function mockDb() {
  const captured: { values?: any } = {};
  const db = {
    insert: () => ({
      values: (v: any) => {
        captured.values = v;
        return { returning: () => ({ then: (fn: any) => Promise.resolve(fn([{ id: "m1", ...v }])) }) };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as any;
  return { db, captured };
}

const validRef = { v: 1, kind: "artifact", id: "a1", action: "created" };

describe("appendMessage outputRefs", () => {
  it("persists valid refs", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [validRef],
    });
    expect(captured.values.outputRefs).toEqual([expect.objectContaining({ id: "a1" })]);
  });

  it("drops invalid refs individually but still saves the message", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [{ v: 99, nope: true }, validRef],
    });
    expect(captured.values.outputRefs).toEqual([expect.objectContaining({ id: "a1" })]);
    expect(captured.values.content).toBe("done");
  });

  it("all-invalid refs → null", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", {
      role: "assistant",
      content: "done",
      outputRefs: [{ v: 99, nope: true }],
    });
    expect(captured.values.outputRefs).toBeNull();
  });

  it("null when absent", async () => {
    const { db, captured } = mockDb();
    await conversationService(db).appendMessage("conv-1", { role: "user", content: "hi" });
    expect(captured.values.outputRefs).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts`
Expected: FAIL — `captured.values.outputRefs` is `undefined`

- [ ] **Step 3: Implement.** In `conversation.ts`:

```ts
import { commanderOutputRefSchema, MAX_OUTPUT_REFS_PER_MESSAGE, type CommanderOutputRef } from "@armyofagents/shared";
```

`MessageInput` gains:

```ts
  outputRefs?: unknown;
```

In `appendMessage`, before the insert, validate; and add the field to `.values({...})`:

```ts
    async appendMessage(conversationId: string, message: MessageInput) {
      // Viewer refs: validate PER REF at the persistence boundary — one malformed
      // lifted ref must not erase the message's valid refs (T2 review). Message
      // itself always saves (design v2 §6).
      let outputRefs: unknown = null;
      if (Array.isArray(message.outputRefs) && message.outputRefs.length > 0) {
        const valid = message.outputRefs
          .map((r) => commanderOutputRefSchema.safeParse(r))
          .filter((p): p is { success: true; data: CommanderOutputRef } => p.success)
          .map((p) => p.data)
          .slice(0, MAX_OUTPUT_REFS_PER_MESSAGE);
        outputRefs = valid.length > 0 ? valid : null;
      }

      const inserted = await db
        .insert(internalAgentMessages)
        .values({
          conversationId,
          role: message.role,
          content: message.content ?? null,
          toolCalls: message.toolCalls ?? null,
          toolResults: message.toolResults ?? null,
          outputRefs,
          pageContext: message.pageContext ?? null,
          departmentContext: message.departmentContext ?? null,
          tokenCount: message.tokenCount ?? null,
          runId: message.runId ?? null,
        })
        // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/conversation.ts server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts
git commit -m "feat(commander): appendMessage validates + persists outputRefs"
```

---

## Task 8: Agent-loop accumulates refs

**Files:**
- Modify: `server/src/services/internal-agent/agent-loop.ts:290-306`
- Test: covered by the pure `mergeOutputRefs` tests (Task 2) + the chunk-collection helper test below

- [ ] **Step 1: Add a tiny exported helper + failing test.** In `output-refs.ts` add:

```ts
import type { AgentStreamChunk } from "./agent-loop.js";

/** Collect refs from a forwarded chunk into a turn-level sink (mutates sink). */
export function collectChunkRefs(sink: CommanderOutputRef[], chunk: AgentStreamChunk): void {
  if (chunk.type === "tool_result" && Array.isArray(chunk.refs) && chunk.refs.length > 0) {
    sink.push(...chunk.refs);
  }
}
```

(Note: `agent-loop.ts` imports `output-refs.ts` types only via `@armyofagents/shared`; this helper's import of `AgentStreamChunk` from agent-loop is type-only — if TS flags a cycle, change to `import type` which erases at runtime. It already is `import type` — no cycle.)

Append to `__tests__/output-refs.test.ts`:

```ts
import { collectChunkRefs } from "../output-refs.js";

describe("collectChunkRefs", () => {
  const created = { v: 1, kind: "artifact", id: "a1", action: "created" } as any;
  it("collects refs from tool_result chunks and ignores everything else", () => {
    const sink: any[] = [];
    collectChunkRefs(sink, { type: "tool_result", name: "create_artifact", result: { success: true, data: null, summary: "" }, refs: [created] } as any);
    collectChunkRefs(sink, { type: "text", delta: "hi" } as any);
    collectChunkRefs(sink, { type: "tool_result", name: "post_entry", result: { success: true, data: null, summary: "" } } as any);
    expect(sink).toHaveLength(1);
  });
});
```

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/output-refs.test.ts`
Expected: FAIL (helper missing) → implement → PASS

- [ ] **Step 2: Wire into the loop.** In `agent-loop.ts`, import and use:

```ts
import { collectChunkRefs, mergeOutputRefs } from "./output-refs.js";
```

Replace lines 290-306 with:

```ts
        let accumulatedAssistant = "";
        const turnRefs: CommanderOutputRef[] = [];
        for await (const chunk of cliService.chat(cliParams, effectiveConfig)) {
          if (chunk.type === "text") accumulatedAssistant += chunk.delta;
          collectChunkRefs(turnRefs, chunk);
          yield chunk;
        }

        if (accumulatedAssistant.trim()) {
          const outputRefs = turnRefs.length > 0 ? mergeOutputRefs([], turnRefs) : undefined;
          await convService.appendMessage(conversation.id, {
            role: "assistant",
            content: accumulatedAssistant,
            ...(outputRefs ? { outputRefs } : {}),
          });
        }
```

(Known accepted edge from the design: a turn with refs but an EMPTY text reply skips persistence — live chips show, history chips don't. Rare; documented.)

- [ ] **Step 3: Verify compile + tests**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/`
Expected: PASS, no type errors

- [ ] **Step 4: Commit**

```bash
git add server/src/services/internal-agent/agent-loop.ts server/src/services/internal-agent/output-refs.ts server/src/services/internal-agent/__tests__/output-refs.test.ts
git commit -m "feat(commander): agent-loop accumulates turn refs into persisted assistant message"
```

---

## Task 9: SSE forwards refs + history endpoints checked

**Files:**
- Modify: `server/src/routes/internal-agent.ts:248-250`
- Verify: the two messages endpoints return full rows

- [ ] **Step 1: SSE.** Replace the `tool_result` case (lines 248-250):

```ts
            case "tool_result":
              res.write(
                `event: tool_result\ndata: ${JSON.stringify({
                  name: chunk.name,
                  ...(chunk.refs && chunk.refs.length > 0 ? { refs: chunk.refs } : {}),
                })}\n\n`,
              );
              break;
```

- [ ] **Step 2: Verify history projections.** Two endpoints serve messages:
  - `GET /companies/:companyId/internal-agent/conversation` — line 652-658 uses `db.select().from(internalAgentMessages)` (full rows) → `outputRefs` flows automatically. Confirm by reading; no change expected.
  - `GET /companies/:companyId/internal-agent/conversations/:convId/messages` — line 1204+. Read its select. If it is `db.select().from(internalAgentMessages)` (full rows), no change. If it projects specific columns, add `outputRefs: internalAgentMessages.outputRefs` to the projection.

- [ ] **Step 3: Compile check**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/output-refs.test.ts`
Expected: PASS (forces server TS compile; route file has no dedicated unit test — covered by the Task 16 smoke)

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/internal-agent.ts
git commit -m "feat(commander): tool_result SSE event forwards refs"
```

---

## Task 10: New tool `query_company_artifacts`

**Files:**
- Create: `server/src/services/internal-agent/tools/artifact-query-company.ts`
- Modify: `server/src/services/internal-agent/tool-registry.ts` (import + array entry, next to `queryArtifactsTool`)
- Test: `server/src/services/internal-agent/__tests__/artifact-query-company.test.ts`
- Check: `server/src/onboarding-assets/**` TOOLS.md contract (see Step 5)

- [ ] **Step 1: Write the failing test**

```ts
// server/src/services/internal-agent/__tests__/artifact-query-company.test.ts
import { describe, it, expect } from "vitest";
import { queryCompanyArtifactsTool } from "../tools/artifact-query-company.js";

const rows = [
  { id: "a1", title: "Plan", type: "document", currentVersionId: "v1", status: "active", updatedAt: "2026-06-10" },
  { id: "a2", title: "Deck", type: "presentation", currentVersionId: "v2", status: "draft", updatedAt: "2026-06-09" },
  { id: "a3", title: "Notes", type: "document", currentVersionId: null, status: "archived", updatedAt: "2026-06-08" },
];

function ctxWith(list: unknown[]) {
  return {
    companyId: "c1",
    userId: "u1",
    userRole: "founder",
    services: { artifacts: { list: async (companyId: string) => (companyId === "c1" ? list : []) } },
  } as any;
}

describe("query_company_artifacts", () => {
  it("lists company artifacts in tool-row shape", async () => {
    const res = await queryCompanyArtifactsTool.execute({}, ctxWith(rows));
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(3);
    expect((res.data as any[])[0]).toEqual({
      artifactId: "a1", title: "Plan", type: "document",
      currentVersionId: "v1", status: "active", updatedAt: "2026-06-10",
    });
  });

  it("filters by type and status", async () => {
    const byType = await queryCompanyArtifactsTool.execute({ type: "document" }, ctxWith(rows));
    expect(byType.data).toHaveLength(2);
    const byStatus = await queryCompanyArtifactsTool.execute({ status: "draft" }, ctxWith(rows));
    expect(byStatus.data).toHaveLength(1);
  });

  it("caps limit at 50 and floors at 1", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ ...rows[0], id: `a${i}` }));
    const res = await queryCompanyArtifactsTool.execute({ limit: 999 }, ctxWith(many));
    expect(res.data).toHaveLength(50);
    const one = await queryCompanyArtifactsTool.execute({ limit: 0 }, ctxWith(many));
    expect((one.data as any[]).length).toBeGreaterThan(0); // floor, not zero
  });

  it("ignores invalid filter values", async () => {
    const res = await queryCompanyArtifactsTool.execute({ type: "DROP TABLE" }, ctxWith(rows));
    expect(res.data).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/artifact-query-company.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// server/src/services/internal-agent/tools/artifact-query-company.ts
//
// Design 2026-06-11 v2 §3f — Commander previously had NO company-wide artifact
// listing (query_artifacts is thread-scoped). category `query` confers no
// capability (see authorize-tool.ts CAPABILITY_TO_CATEGORY), matching the
// other read tools. Company scoping comes from ctx.companyId — never params.
import type { AgentTool, ToolResult } from "../types.js";

const VALID_TYPES = new Set(["document", "presentation", "code", "design", "report", "other"]);
const VALID_STATUSES = new Set(["draft", "active", "archived"]);

export const queryCompanyArtifactsTool: AgentTool = {
  name: "query_company_artifacts",
  description:
    "List the company's recent artifacts (deliverables) across all threads and tasks, newest first. Optional filters: type (document|presentation|code|design|report|other), status (draft|active|archived), limit (default 20, max 50). Use when asked what artifacts/documents/deliverables exist.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: "Filter by artifact type" },
      status: { type: "string", description: "Filter by artifact status" },
      limit: { type: "number", description: "Max rows (default 20, max 50)" },
    },
    required: [],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { type, status, limit } = (params ?? {}) as {
      type?: unknown;
      status?: unknown;
      limit?: unknown;
    };
    const typeFilter = typeof type === "string" && VALID_TYPES.has(type) ? type : null;
    const statusFilter = typeof status === "string" && VALID_STATUSES.has(status) ? status : null;
    const cap = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 50);

    const rows = await ctx.services.artifacts.list(ctx.companyId);
    const list = (Array.isArray(rows) ? rows : [])
      .filter((a: any) => (typeFilter ? a.type === typeFilter : true))
      .filter((a: any) => (statusFilter ? a.status === statusFilter : true))
      .slice(0, cap)
      .map((a: any) => ({
        artifactId: a.id,
        title: a.title,
        type: a.type,
        currentVersionId: a.currentVersionId ?? null,
        status: a.status,
        updatedAt: a.updatedAt,
      }));

    return {
      success: true,
      data: list,
      summary: `Found ${list.length} artifact${list.length === 1 ? "" : "s"} in the company`,
    };
  },
};
```

- [ ] **Step 4: Register.** In `tool-registry.ts`, add the import next to `queryArtifactsTool` (line 34) and the array entry next to where `queryArtifactsTool` appears in `createToolRegistry()` (search for it below line 110):

```ts
import { queryCompanyArtifactsTool } from "./tools/artifact-query-company.js";
// ... in the array, directly after queryArtifactsTool:
    queryCompanyArtifactsTool,
```

- [ ] **Step 5: TOOLS.md contract.** Run `pnpm vitest run server/src/__tests__/ -t "TOOLS"` and also `rg -l "query_artifacts" server/src/onboarding-assets docs/`. A recent commit locked a TOOLS.md contract — if any contract test or TOOLS.md enumerates the registry, add a `query_company_artifacts` row there matching the existing format. If nothing references the registry count, skip.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/artifact-query-company.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add server/src/services/internal-agent/tools/artifact-query-company.ts server/src/services/internal-agent/tool-registry.ts server/src/services/internal-agent/__tests__/artifact-query-company.test.ts
git commit -m "feat(commander): query_company_artifacts tool — company-wide artifact listing"
```

(If Step 5 touched TOOLS.md, include those files in the commit.)

---

## Task 11: UI API types

**Files:**
- Modify: `ui/src/api/internal-agent.ts:23-30` (AgentMessage) — note `CommanderContextScope` is already imported from `@armyofagents/shared` on line 1, extend that import
- Modify: `ui/src/api/artifacts.ts` (add `listByCompany`)

- [ ] **Step 1: AgentMessage.** Extend the shared import and the interface:

```ts
import type { CommanderContextScope, CommanderOutputRef, CompanySkillListItem, UpdateInternalAgentConfig } from "@armyofagents/shared";
```

```ts
export interface AgentMessage {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  content: string | null;
  toolCalls: unknown | null;
  outputRefs: CommanderOutputRef[] | null;
  pageContext: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: artifactsApi.listByCompany.** In `ui/src/api/artifacts.ts`, add to the `artifactsApi` object (route verified: `GET /companies/:companyId/artifacts` returns artifact rows without versions):

```ts
  /** Company-wide artifact list (newest first). Rows have no versions array. */
  listByCompany: (companyId: string) =>
    api.get<Array<{ id: string; title: string; type: string; status: string; currentVersionId: string | null; updatedAt: string }>>(
      `/companies/${companyId}/artifacts`,
    ),
```

- [ ] **Step 3: Compile check**

Run: `cd ui && pnpm vitest run src/__tests__/MarkdownItemViewer.test.tsx`
Expected: PASS (any existing ui test forces the TS graph through the changed files; no type errors)

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/internal-agent.ts ui/src/api/artifacts.ts
git commit -m "feat(ui): AgentMessage.outputRefs + artifactsApi.listByCompany"
```

---

## Task 12: Viewer model (pure logic)

**Files:**
- Create: `ui/src/components/commander/viewer/commanderViewerModel.ts`
- Test: `ui/src/components/commander/viewer/commanderViewerModel.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/components/commander/viewer/commanderViewerModel.test.ts
import { describe, it, expect } from "vitest";
import {
  emptyViewerState,
  openRefTab,
  openReplyTab,
  closeTab,
  shouldAutoOpen,
  chipLabel,
  collectConversationRefs,
  type ConversationViewerState,
} from "./commanderViewerModel";
import type { CommanderOutputRef } from "@armyofagents/shared";

const ref = (id: string, action: "created" | "referenced" = "created", title: string | null = "Plan"): CommanderOutputRef =>
  ({ v: 1, kind: "artifact", id, action, title } as CommanderOutputRef);

describe("commanderViewerModel", () => {
  it("openRefTab adds a tab and focuses it; reopening focuses without duplicating", () => {
    let s: ConversationViewerState = emptyViewerState();
    s = openRefTab(s, ref("a1"));
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    expect(s.expanded).toBe(true);
    const again = openRefTab(s, ref("a1"));
    expect(again.tabs).toHaveLength(1);
  });

  it("closeTab removes and re-focuses neighbor (home when empty)", () => {
    let s = openRefTab(openRefTab(emptyViewerState(), ref("a1")), ref("a2"));
    const closing = s.tabs.find((t) => t.refId === "a2")!;
    s = closeTab(s, closing.id);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    s = closeTab(s, s.tabs[0]!.id);
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBe("home");
  });

  it("openReplyTab opens a markdown tab keyed by message id", () => {
    let s = openReplyTab(emptyViewerState(), "msg-1", "# Hello");
    expect(s.tabs[0]).toMatchObject({ kind: "reply", refId: "msg-1" });
    s = openReplyTab(s, "msg-1", "# Hello");
    expect(s.tabs).toHaveLength(1); // focus, not duplicate
  });

  it("shouldAutoOpen: created+desktop only", () => {
    expect(shouldAutoOpen(ref("a", "created"), false)).toBe(true);
    expect(shouldAutoOpen(ref("a", "created"), true)).toBe(false);
    expect(shouldAutoOpen(ref("a", "referenced"), false)).toBe(false);
  });

  it("chipLabel falls back to kind + short id", () => {
    expect(chipLabel(ref("a1", "created", "GTM Plan"))).toBe("GTM Plan");
    expect(chipLabel(ref("abcdef123456", "created", null))).toBe("artifact abcdef12");
  });

  it("collectConversationRefs dedupes across messages, created wins", () => {
    const refs = collectConversationRefs([
      { outputRefs: [ref("a1", "referenced")] },
      { outputRefs: [ref("a1", "created"), ref("a2", "referenced")] },
      { outputRefs: null },
    ]);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.id === "a1")!.action).toBe("created");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/components/commander/viewer/commanderViewerModel.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// ui/src/components/commander/viewer/commanderViewerModel.ts
//
// Pure state logic for the Commander viewer panel (design 2026-06-11 v2 §4).
// No React imports — unit-tested directly (pattern: commanderInputModel.ts).
import type { CommanderOutputRef } from "@armyofagents/shared";

export interface ViewerTab {
  /** Stable tab identity: `artifact:<id>:<versionId|latest>` | `reply:<messageId>` */
  id: string;
  kind: "artifact" | "reply";
  title: string;
  /** artifact id, or message id for replies */
  refId: string;
  versionId?: string | null;
  /** reply tabs only — markdown body */
  replyContent?: string;
}

export interface ConversationViewerState {
  tabs: ViewerTab[];
  /** active tab id, or the literal "home" */
  activeId: string;
  expanded: boolean;
}

export function emptyViewerState(): ConversationViewerState {
  return { tabs: [], activeId: "home", expanded: false };
}

export function chipLabel(ref: CommanderOutputRef): string {
  return ref.title ?? `${ref.kind} ${ref.id.slice(0, 8)}`;
}

function artifactTabId(ref: CommanderOutputRef): string {
  return `artifact:${ref.id}:${ref.versionId ?? "latest"}`;
}

export function openRefTab(
  state: ConversationViewerState,
  ref: CommanderOutputRef,
): ConversationViewerState {
  const id = artifactTabId(ref);
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) return { ...state, activeId: id, expanded: true };
  const tab: ViewerTab = {
    id,
    kind: "artifact",
    title: chipLabel(ref),
    refId: ref.id,
    versionId: ref.versionId ?? null,
  };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function openReplyTab(
  state: ConversationViewerState,
  messageId: string,
  content: string,
): ConversationViewerState {
  const id = `reply:${messageId}`;
  if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
  const tab: ViewerTab = { id, kind: "reply", title: "Commander reply", refId: messageId, replyContent: content };
  return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
}

export function closeTab(state: ConversationViewerState, tabId: string): ConversationViewerState {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  let activeId = state.activeId;
  if (activeId === tabId) {
    const neighbor = tabs[idx] ?? tabs[idx - 1];
    activeId = neighbor ? neighbor.id : "home";
  }
  return { ...state, tabs, activeId };
}

export function setActive(state: ConversationViewerState, tabId: string): ConversationViewerState {
  return { ...state, activeId: tabId, expanded: true };
}

export function setExpanded(state: ConversationViewerState, expanded: boolean): ConversationViewerState {
  return { ...state, expanded };
}

/** Auto-open rule (design §2 #2 + #6): created refs, desktop only. */
export function shouldAutoOpen(ref: CommanderOutputRef, isMobile: boolean): boolean {
  return ref.action === "created" && !isMobile;
}

const refKey = (r: CommanderOutputRef) => `${r.kind}|${r.id}|${r.versionId ?? ""}`;

/** Home-tab "Recent from this conversation": dedupe across loaded messages, created wins. */
export function collectConversationRefs(
  messages: ReadonlyArray<{ outputRefs?: CommanderOutputRef[] | null }>,
): CommanderOutputRef[] {
  const map = new Map<string, CommanderOutputRef>();
  for (const m of messages) {
    for (const r of m.outputRefs ?? []) {
      const k = refKey(r);
      const prev = map.get(k);
      if (!prev || (prev.action === "referenced" && r.action === "created")) map.set(k, r);
    }
  }
  return [...map.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm vitest run src/components/commander/viewer/commanderViewerModel.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/commander/viewer/commanderViewerModel.ts ui/src/components/commander/viewer/commanderViewerModel.test.ts
git commit -m "feat(ui): commander viewer pure state model"
```

---

## Task 13: OutputRefChips component

**Files:**
- Create: `ui/src/components/commander/viewer/OutputRefChips.tsx`
- Test: `ui/src/components/commander/viewer/OutputRefChips.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/components/commander/viewer/OutputRefChips.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OutputRefChips } from "./OutputRefChips";
import type { CommanderOutputRef } from "@armyofagents/shared";

const refs: CommanderOutputRef[] = [
  { v: 1, kind: "artifact", id: "a1", versionId: "v1", versionNumber: 2, title: "GTM Plan", action: "created" },
  { v: 1, kind: "artifact", id: "abcdef123456", versionId: null, versionNumber: null, title: null, action: "referenced" },
];

describe("OutputRefChips", () => {
  it("renders a chip per ref with title, fallback label, and version badge", () => {
    render(<OutputRefChips refs={refs} onOpen={() => {}} />);
    expect(screen.getByText("GTM Plan")).toBeTruthy();
    expect(screen.getByText("artifact abcdef12")).toBeTruthy();
    expect(screen.getByText("v2")).toBeTruthy();
  });

  it("click calls onOpen with the ref", () => {
    const onOpen = vi.fn();
    render(<OutputRefChips refs={refs} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("GTM Plan"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("created chips get the accent style", () => {
    render(<OutputRefChips refs={refs} onOpen={() => {}} />);
    const created = screen.getByText("GTM Plan").closest("button")!;
    const referenced = screen.getByText("artifact abcdef12").closest("button")!;
    expect(created.className).toContain("border-primary");
    expect(created.className).not.toBe(referenced.className);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/components/commander/viewer/OutputRefChips.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```tsx
// ui/src/components/commander/viewer/OutputRefChips.tsx
//
// Chip row under assistant bubbles (design v2 §4a). Chips are handles, not
// previews — click opens the ref in the viewer panel.
import { FileText } from "lucide-react";
import type { CommanderOutputRef } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { chipLabel } from "./commanderViewerModel";

interface OutputRefChipsProps {
  refs: CommanderOutputRef[];
  onOpen: (ref: CommanderOutputRef) => void;
}

export function OutputRefChips({ refs, onOpen }: OutputRefChipsProps) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="output-ref-chips">
      {refs.map((ref) => (
        <button
          key={`${ref.id}:${ref.versionId ?? "latest"}`}
          type="button"
          onClick={() => onOpen(ref)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
            ref.action === "created"
              ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
              : "border-border bg-muted/40 text-foreground hover:bg-muted",
          )}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="max-w-[220px] truncate font-medium">{chipLabel(ref)}</span>
          {typeof ref.versionNumber === "number" && (
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
              v{ref.versionNumber}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && pnpm vitest run src/components/commander/viewer/OutputRefChips.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/commander/viewer/OutputRefChips.tsx ui/src/components/commander/viewer/OutputRefChips.test.tsx
git commit -m "feat(ui): OutputRefChips — clickable artifact handles under replies"
```

---

## Task 14: Viewer panel, home tab, and hook

**Files:**
- Create: `ui/src/components/commander/viewer/useCommanderViewer.ts`
- Create: `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`
- Create: `ui/src/components/commander/viewer/CommanderViewerHome.tsx`
- Create: `ui/src/components/commander/viewer/index.ts`
- Test: covered by Task 12's model tests + Task 16 smoke (components are thin shells over the tested model + existing viewer stack)

- [ ] **Step 1: The hook** — per-conversation tab memory while the page lives (design §2 #4):

```ts
// ui/src/components/commander/viewer/useCommanderViewer.ts
import { useCallback, useRef, useState } from "react";
import type { CommanderOutputRef } from "@armyofagents/shared";
import {
  closeTab,
  emptyViewerState,
  openRefTab,
  openReplyTab,
  setActive,
  setExpanded,
  shouldAutoOpen,
  type ConversationViewerState,
} from "./commanderViewerModel";

export interface CommanderViewerApi {
  state: ConversationViewerState;
  openRef: (ref: CommanderOutputRef) => void;
  openReply: (messageId: string, content: string) => void;
  onLiveRef: (ref: CommanderOutputRef, isMobile: boolean) => void;
  activate: (tabId: string) => void;
  close: (tabId: string) => void;
  expand: () => void;
  collapse: () => void;
  /** count of created refs that landed while collapsed (mobile pill badge) */
  pendingBadge: number;
  clearBadge: () => void;
}

export function useCommanderViewer(conversationId: string | null): CommanderViewerApi {
  // Page-lifetime memory: per-conversation states survive switching chats,
  // die on hard reload (no storage by design).
  const statesRef = useRef(new Map<string, ConversationViewerState>());
  const key = conversationId ?? "__none__";
  const [, force] = useState(0);
  const [pendingBadge, setPendingBadge] = useState(0);

  const state = statesRef.current.get(key) ?? emptyViewerState();

  const update = useCallback(
    (next: ConversationViewerState) => {
      statesRef.current.set(key, next);
      force((n) => n + 1);
    },
    [key],
  );

  return {
    state,
    openRef: (ref) => update(openRefTab(state, ref)),
    openReply: (messageId, content) => update(openReplyTab(state, messageId, content)),
    onLiveRef: (ref, isMobile) => {
      if (shouldAutoOpen(ref, isMobile)) {
        update(openRefTab(state, ref));
      } else if (ref.action === "created") {
        update({ ...openRefTab(state, ref), expanded: state.expanded, activeId: state.activeId });
        setPendingBadge((n) => n + 1);
      }
    },
    activate: (tabId) => update(setActive(state, tabId)),
    close: (tabId) => update(closeTab(state, tabId)),
    expand: () => update(setExpanded(state, true)),
    collapse: () => update(setExpanded(state, false)),
    pendingBadge,
    clearBadge: () => setPendingBadge(0),
  };
}
```

- [ ] **Step 2: The home tab**:

```tsx
// ui/src/components/commander/viewer/CommanderViewerHome.tsx
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import type { CommanderOutputRef } from "@armyofagents/shared";
import { artifactsApi } from "../../../api/artifacts";
import { chipLabel } from "./commanderViewerModel";

interface CommanderViewerHomeProps {
  companyId: string;
  conversationRefs: CommanderOutputRef[];
  onOpen: (ref: CommanderOutputRef) => void;
}

function RefRow({ refItem, onOpen, note }: { refItem: CommanderOutputRef; onOpen: (r: CommanderOutputRef) => void; note?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(refItem)}
      className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm hover:bg-muted/50"
    >
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{chipLabel(refItem)}</span>
      {note && <span className="shrink-0 text-[10px] text-muted-foreground">{note}</span>}
    </button>
  );
}

export function CommanderViewerHome({ companyId, conversationRefs, onOpen }: CommanderViewerHomeProps) {
  const { data: recent } = useQuery({
    queryKey: ["commander-viewer-recent-artifacts", companyId],
    queryFn: () => artifactsApi.listByCompany(companyId),
    staleTime: 30_000,
  });

  const recentRefs: CommanderOutputRef[] = (recent ?? []).slice(0, 15).map((a) => ({
    v: 1,
    kind: "artifact",
    id: a.id,
    versionId: a.currentVersionId,
    title: a.title,
    action: "referenced",
  }));

  const empty = conversationRefs.length === 0 && recentRefs.length === 0;

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="commander-viewer-home">
      {empty && (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          Nothing yet — ask Commander to draft something.
        </p>
      )}
      {conversationRefs.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent from this conversation
          </h3>
          {conversationRefs.map((r) => (
            <RefRow key={`${r.id}:${r.versionId ?? "latest"}`} refItem={r} onOpen={onOpen} note={r.action === "created" ? "created here" : undefined} />
          ))}
        </section>
      )}
      {recentRefs.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent in company
          </h3>
          {recentRefs.map((r) => (
            <RefRow key={r.id} refItem={r} onOpen={onOpen} />
          ))}
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 3: The panel** (rail ⇄ expanded, drag-resize, artifact/reply tab bodies, mobile sheet):

```tsx
// ui/src/components/commander/viewer/CommanderViewerPanel.tsx
import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronsLeft, ChevronsRight, FileText, Home } from "lucide-react";
import type { CommanderOutputRef } from "@armyofagents/shared";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { artifactsApi } from "../../../api/artifacts";
import { ViewerTabs, type ViewerTabModel } from "../../viewers/ViewerTabs";
import { SharedContentViewer } from "../../viewers/SharedContentViewer";
import { resolveViewer } from "../../viewers/viewer-registry";
import { CommanderViewerHome } from "./CommanderViewerHome";
import type { CommanderViewerApi } from "./useCommanderViewer";
import type { ViewerTab } from "./commanderViewerModel";

const MIN_WIDTH = 320;
const MAX_WIDTH_FRACTION = 0.6;
const DEFAULT_WIDTH_FRACTION = 0.4;

interface CommanderViewerPanelProps {
  companyId: string;
  viewer: CommanderViewerApi;
  conversationRefs: CommanderOutputRef[];
  isMobile: boolean;
}

/** Map artifact type → a contentType resolveViewer understands (markdown default). */
function contentTypeForArtifact(artifactType: string): string {
  switch (artifactType) {
    case "code":
      return "text/plain";
    default:
      return "text/markdown";
  }
}

function ArtifactTabBody({ tab }: { tab: ViewerTab }) {
  const { data: artifact, isLoading, isError } = useQuery({
    queryKey: ["commander-viewer-artifact", tab.refId],
    queryFn: () => artifactsApi.get(tab.refId),
  });

  if (isLoading) {
    return <div className="animate-pulse p-4 text-sm text-muted-foreground">Loading…</div>;
  }
  if (isError || !artifact) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This item is no longer available (it may have been deleted, or you may not have access).
      </div>
    );
  }
  // Honor the ref's immutable version when present; else newest.
  const version =
    (tab.versionId ? artifact.versions.find((v) => v.id === tab.versionId) : null) ??
    artifact.versions[0] ??
    null;
  if (!version) {
    return <div className="p-4 text-sm text-muted-foreground">{artifact.title} has no versions yet.</div>;
  }
  const resolution = resolveViewer({
    contentType: version.fileUrl ? null : contentTypeForArtifact(artifact.type),
    filename: artifact.title,
    assetId: null,
    assetUrl: version.fileUrl,
  });
  return (
    <SharedContentViewer
      viewer={resolution}
      filename={artifact.title}
      inlineTextContent={version.content ?? null}
    />
  );
}

function ReplyTabBody({ tab }: { tab: ViewerTab }) {
  const resolution = resolveViewer({ contentType: "text/markdown", filename: "reply.md" });
  return (
    <SharedContentViewer viewer={resolution} filename="Commander reply" inlineTextContent={tab.replyContent ?? ""} />
  );
}

export function CommanderViewerPanel({ companyId, viewer, conversationRefs, isMobile }: CommanderViewerPanelProps) {
  const { state } = viewer;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null); // null = default fraction

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = containerRef.current?.offsetWidth ?? 0;
    const parentWidth = containerRef.current?.parentElement?.offsetWidth ?? window.innerWidth;
    const onMove = (ev: PointerEvent) => {
      const next = startWidth + (startX - ev.clientX);
      setWidth(Math.min(Math.max(next, MIN_WIDTH), parentWidth * MAX_WIDTH_FRACTION));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const tabs: ViewerTabModel[] = [
    { id: "home", kind: "home", title: "Home", icon: Home, closeable: false },
    ...state.tabs.map((t) => ({ id: t.id, kind: t.kind, title: t.title, icon: FileText })),
  ];
  const activeTab = state.tabs.find((t) => t.id === state.activeId) ?? null;

  const body = (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerTabs
        tabs={tabs}
        activeKey={{ id: state.activeId, kind: state.activeId === "home" ? "home" : (activeTab?.kind ?? "home") }}
        onActivate={(tab) => viewer.activate(tab.id)}
        onClose={(tab) => viewer.close(tab.id)}
        onToggleCollapse={isMobile ? undefined : viewer.collapse}
        tabListLabel="Commander viewer tabs"
        headerTestId="commander-viewer-tabs"
      />
      <div className="min-h-0 flex-1 overflow-hidden">
        {state.activeId === "home" || !activeTab ? (
          <CommanderViewerHome companyId={companyId} conversationRefs={conversationRefs} onOpen={viewer.openRef} />
        ) : activeTab.kind === "artifact" ? (
          <ArtifactTabBody tab={activeTab} />
        ) : (
          <ReplyTabBody tab={activeTab} />
        )}
      </div>
    </div>
  );

  // ── Mobile: full-screen sheet + floating pill (never auto-opens — §2 #6) ──
  if (isMobile) {
    return (
      <>
        {/* Pill is always visible — mobile counterpart of the always-visible rail (§2 #3). */}
        {(
          <button
            type="button"
            onClick={() => {
              viewer.expand();
              viewer.clearBadge();
            }}
            className="fixed bottom-24 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-xs shadow-lg"
            data-testid="commander-viewer-pill"
          >
            <FileText className="h-3.5 w-3.5" />
            Viewer
            {viewer.pendingBadge > 0 && (
              <span className="ml-0.5 inline-flex h-4 min-w-4 animate-pulse items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
                {viewer.pendingBadge}
              </span>
            )}
          </button>
        )}
        <Sheet open={state.expanded} onOpenChange={(open) => (open ? viewer.expand() : viewer.collapse())}>
          <SheetContent side="right" className="w-full p-0 sm:max-w-full">
            <SheetTitle className="sr-only">Commander viewer</SheetTitle>
            {body}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // ── Desktop collapsed: thin rail (always present — §2 #3) ──
  if (!state.expanded) {
    return (
      <div
        className="flex h-full w-9 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-2"
        data-testid="commander-viewer-rail"
      >
        <button type="button" title="Expand viewer" onClick={viewer.expand} className="rounded p-1 hover:bg-muted">
          <ChevronsLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <button
          type="button"
          title="Home"
          onClick={() => {
            viewer.activate("home");
          }}
          className="rounded p-1 hover:bg-muted"
        >
          <Home className="h-4 w-4 text-muted-foreground" />
        </button>
        {state.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.title}
            onClick={() => viewer.activate(t.id)}
            className="rounded p-1 hover:bg-muted"
          >
            <FileText className="h-4 w-4 text-muted-foreground" />
          </button>
        ))}
      </div>
    );
  }

  // ── Desktop expanded: resizable panel ──
  return (
    <div
      ref={containerRef}
      className="relative flex h-full shrink-0 flex-col border-l border-border bg-card"
      style={{ width: width ?? `${DEFAULT_WIDTH_FRACTION * 100}%` }}
      data-testid="commander-viewer-panel"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-primary/20"
      />
      <div className="absolute right-2 top-2 z-10">
        <button type="button" title="Collapse viewer" onClick={viewer.collapse} className="rounded p-1 hover:bg-muted">
          <ChevronsRight className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
      {body}
    </div>
  );
}
```

(Note: `ViewerTabs` already renders a collapse affordance via `onToggleCollapse` — the extra collapse button is belt-and-braces; during implementation, if `ViewerTabs`'s built-in `PanelRightClose` button is sufficient, drop the absolute-positioned one.)

- [ ] **Step 4: Barrel** — `ui/src/components/commander/viewer/index.ts`:

```ts
export { CommanderViewerPanel } from "./CommanderViewerPanel";
export { OutputRefChips } from "./OutputRefChips";
export { useCommanderViewer } from "./useCommanderViewer";
export { collectConversationRefs, shouldAutoOpen } from "./commanderViewerModel";
```

- [ ] **Step 5: Compile + existing viewer tests still pass**

Run: `cd ui && pnpm vitest run src/components/commander/viewer/ src/__tests__/OutputViewerRegistry.test.ts`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/commander/viewer/
git commit -m "feat(ui): CommanderViewerPanel + home tab + per-conversation viewer hook"
```

---

## Task 15: Wire into the chat (InternalAgentPanel + Commander page)

**Files:**
- Modify: `ui/src/components/InternalAgentPanel.tsx` — five anchored edits below
- Modify: `ui/src/pages/Commander.tsx:78-82`
- Test: `ui/src/components/InternalAgentPanel.outputRefs.test.tsx`

- [ ] **Step 1: Write the failing test** (history-mapping behavior through the exported merge function):

```tsx
// ui/src/components/InternalAgentPanel.outputRefs.test.tsx
import { describe, it, expect } from "vitest";
import { mergeServerMessagesWithTransientLocal } from "./InternalAgentPanel";
import type { AgentMessage } from "../api/internal-agent";

const serverMsg: AgentMessage = {
  id: "m1",
  role: "assistant",
  content: "done",
  toolCalls: null,
  outputRefs: [{ v: 1, kind: "artifact", id: "a1", action: "created" } as any],
  pageContext: null,
  createdAt: "2026-06-11T00:00:00Z",
};

describe("outputRefs survive server→local mapping", () => {
  it("mergeServerMessagesWithTransientLocal carries outputRefs", () => {
    const merged = mergeServerMessagesWithTransientLocal([serverMsg], []);
    expect(merged[0]!.outputRefs).toHaveLength(1);
    expect(merged[0]!.outputRefs![0]).toMatchObject({ id: "a1" });
  });
});
```

Run: `cd ui && pnpm vitest run src/components/InternalAgentPanel.outputRefs.test.tsx`
Expected: FAIL — `outputRefs` undefined on LocalMessage

- [ ] **Step 2: Edit 1 — `LocalMessage` + `serverToLocal` + history map.**
  - In the `LocalMessage` interface (ends at line ~237), add: `outputRefs?: CommanderOutputRef[];` and add the import `import type { CommanderOutputRef } from "@armyofagents/shared";` at the top.
  - In `serverToLocal` (line 239-247), add to the returned object:

```ts
    outputRefs: (m.outputRefs ?? undefined) as CommanderOutputRef[] | undefined,
```

  - In the history-load mapping (lines 423-431), add the same field to the mapped object:

```ts
        outputRefs: (m.outputRefs ?? undefined) as CommanderOutputRef[] | undefined,
```

- [ ] **Step 3: Edit 2 — SSE accumulation + auto-open.** In `AgentPanelContent`, instantiate the viewer near the other hooks (after the `historyData` query, ~line 383):

```ts
  const { useDrawerSessions } = useBreakpoint(); // if not already destructured in this component
  const viewer = useCommanderViewer(conversationId ?? null);
```

(Imports: `import { useCommanderViewer, CommanderViewerPanel, OutputRefChips, collectConversationRefs } from "./commander/viewer";` and `import { useBreakpoint } from "../lib/useBreakpoint";` if absent.)

In `handleSSEEvent`'s `case "tool_result"` (line 626-644), AFTER the existing `setMessages` call, add:

```ts
        const liveRefs = (event.data as { refs?: CommanderOutputRef[] }).refs;
        if (liveRefs && liveRefs.length > 0) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, outputRefs: [...(m.outputRefs ?? []), ...liveRefs] }
                : m,
            ),
          );
          for (const r of liveRefs) viewer.onLiveRef(r, useDrawerSessions);
        }
```

(Note: `handleSSEEvent` is deliberately not memoized — see the comment at its definition — so referencing `viewer`/`useDrawerSessions` is safe.)

- [ ] **Step 4: Edit 3 — chips + reply pop-out in the message render.** In the messages map, directly AFTER the toolCalls indicator block (ends ~line 993), inside the assistant-message bubble container, add:

```tsx
                {msg.role === "assistant" && msg.outputRefs && msg.outputRefs.length > 0 && (
                  <OutputRefChips refs={msg.outputRefs} onOpen={viewer.openRef} />
                )}
```

For the pop-out: find the existing hover-copy affordance on assistant bubbles (search `Copy` in the message render). Add a sibling button with the same hover-visibility classes:

```tsx
                  <button
                    type="button"
                    title="Open reply in viewer"
                    onClick={() => viewer.openReply(msg.id, msg.content)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
```

(`ExternalLink` from lucide-react — extend the existing lucide import.)

- [ ] **Step 5: Edit 4 — layout row + prop gate.** In `AgentPanelContentProps` (line 300-310) add `enableViewerPanel?: boolean;`. Then wrap the chat column: the component's top-level return is a flex column (`<div className="flex flex-col h-full">`, ~line 874). Wrap it:

```tsx
  const conversationRefs = collectConversationRefs(messages);

  return (
    <div className="flex h-full min-h-0 flex-row overflow-hidden">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {/* ← everything the component currently returns goes here, unchanged */}
      </div>
      {enableViewerPanel && companyId && (
        <CommanderViewerPanel
          companyId={companyId}
          viewer={viewer}
          conversationRefs={conversationRefs}
          isMobile={useDrawerSessions}
        />
      )}
    </div>
  );
```

- [ ] **Step 6: Edit 5 — Commander page.** In `Commander.tsx:78-82`:

```tsx
          <AgentPanelContent
            conversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onOpenSessions={useDrawerSessions ? () => setSessionsDrawerOpen(true) : undefined}
            enableViewerPanel
          />
```

- [ ] **Step 7: Run the new test + ALL existing InternalAgentPanel tests**

Run: `cd ui && pnpm vitest run src/components/InternalAgentPanel.outputRefs.test.tsx src/components/InternalAgentPanel.scroll.test.tsx src/components/InternalAgentPanel.abort.test.tsx src/components/InternalAgentPanel.cache.test.tsx src/__tests__/InternalAgentPanel.transient-confirm.test.ts src/__tests__/deriveConfirmEntityLine.test.ts`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/InternalAgentPanel.tsx ui/src/components/InternalAgentPanel.outputRefs.test.tsx ui/src/pages/Commander.tsx
git commit -m "feat(ui): wire viewer panel + chips + auto-open into Commander chat"
```

---

## Task 16: Full verification + smoke

- [ ] **Step 1: Full unit suite**

Run (repo root): `pnpm test:run`
Expected: all green. Fix any regression before proceeding (most likely candidates: tests asserting the old `tool_result.name === tool_use_id` behavior, or TOOLS.md registry-count contracts).

- [ ] **Step 2: UI suite**

Run: `cd ui && pnpm vitest run`
Expected: all green.

- [ ] **Step 3: Build**

Run (repo root): `pnpm build` (or `pnpm -r build` if no root build script)
Expected: clean build, no TS errors.

- [ ] **Step 4: Manual smoke (requires a running dev stack + a company with Commander configured for claude_cli):**

1. Open `/commander`. Verify the thin rail with ⌂ is on the right edge of an empty chat.
2. Send: *"Create an artifact titled Smoke Plan, type document, with a couple of markdown sections about a product launch."* → expect `create_artifact` to run, a chip `Smoke Plan` under the reply, and the panel to **auto-expand** showing rendered markdown.
3. Collapse the panel → tab icon waits on the rail. Send *"make a v2 of that artifact tightening the copy"* → panel auto-expands again, chip shows `v2`.
4. Reload the page → chips still render from history; clicking one reopens the artifact (tabs themselves start clean — by design).
5. Ask *"what artifacts do we have?"* → `query_company_artifacts` chips appear (no auto-open).
6. Hover a long reply → "Open reply in viewer" renders it as a tab.
7. ⌂ home tab shows "Recent from this conversation" + "Recent in company".
8. Narrow the window below 1024px → floating Viewer pill; creating another artifact pulses a badge instead of opening the sheet.
9. Tool spinners: during step 2, the `create_artifact` status line should flip to done when the tool completes (not only at reply end) — that's the spinner bugfix.

- [ ] **Step 5: Automated E2E** (after Task 17 is implemented)

Run (repo root): `pnpm test:e2e -- commander-viewer.spec.ts`
Expected: all commander-viewer e2e tests PASS. (On Windows without `DATABASE_URL`, the whole e2e suite is config-skipped — run it on Linux/CI or set `DATABASE_URL` to an external Postgres.)

- [ ] **Step 6: Final commit (if smoke produced fixes) + report**

Report completion status per repo conventions: tests run, suites green, smoke checklist outcomes, any deviations from the design doc.

---

## Task 17: Automated E2E — real UI chat with Commander, deterministic fake CLI

**Files:**
- Create: `tests/e2e/fixtures/fake-claude/fake-claude.mjs` (the scripted CLI)
- Create: `tests/e2e/fixtures/fake-claude/claude` (POSIX shim) and `tests/e2e/fixtures/fake-claude/claude.cmd` (Windows shim)
- Modify: `tests/e2e/playwright.config.ts` (PATH prepend + control-file env)
- Create: `tests/e2e/commander-viewer.spec.ts`

**How it works:** the e2e server resolves the `claude` binary from PATH (`cli-mode.ts:40` maps `claude_cli → "claude"`; `:60` resolves via `which`/`where`). The Playwright config prepends the fixture directory to PATH, so Commander's CLI mode spawns our script. The script replays a scripted turn from a **control file** that the spec writes before each message — so each chat turn is fully deterministic, no LLM. The fixture's `tool_result` content is byte-compatible with the real bridge envelope (`mcp-bridge.ts:50-63` shape), and the refs point at a **real artifact** the spec seeds over REST — so chips, persistence, AND the viewer's artifact fetch all exercise production paths. The only thing not executing is the MCP bridge itself (covered by Task 3's tests).

**UI surface covered (the design's full interaction set):** empty rail → type to Commander in the real composer → tool status settles mid-stream (spinner fix) → created chip renders → panel auto-expands with rendered markdown → collapse to rail → reload → chips persist from history → chip click reopens content → referenced chips (no auto-open) → home tab's two groups → reply pop-out → mobile pill at narrow viewport.

- [ ] **Step 1: The fake CLI fixture.** Before writing it, read `parse-stream-json.ts`'s `parseLine` switch to confirm the event type that produces `{type:"text"}` chunks (expected: `stream_event` with `content_block_delta`/`text_delta`, per the comment at `parse-stream-json.ts:189` that text streams via stream_event deltas — confirm the exact field names and mirror them in `TEXT_EVENT` below). The tool_use / tool_result shapes below are already verified against `handleAssistantEvent`/`handleUserEvent`.

```js
// tests/e2e/fixtures/fake-claude/fake-claude.mjs
//
// Deterministic stand-in for the `claude` CLI in e2e runs. Replays one
// scripted Commander turn from the control file (written by the spec),
// in Claude CLI `--output-format stream-json` shape. No LLM, no network.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const controlPath =
  process.env.AOA_E2E_FAKE_CLAUDE_CONTROL ??
  path.join(os.tmpdir(), "aoa-e2e-fake-claude", "turn.json");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let turn = { text: "I'm a fake Commander reply.", toolUses: [] };
try {
  turn = JSON.parse(fs.readFileSync(controlPath, "utf8"));
} catch {
  // No control file — emit the default text-only turn.
}

emit({ type: "system", subtype: "init", session_id: `fake-${Date.now()}` });

let counter = 0;
for (const tu of turn.toolUses ?? []) {
  const toolUseId = `toolu_fake_${++counter}`;
  // assistant event with a tool_use block → parser emits tool_call + records id→name
  emit({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: toolUseId, name: tu.name, input: tu.input ?? {} }] },
  });
  // user event with the tool_result → parser resolves name + lifts outputRefs.
  // `content` mirrors the REAL bridge envelope (mcp-bridge.ts executeAndFormat).
  emit({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify(tu.envelope),
        },
      ],
    },
  });
}

// Final assistant text — CONFIRM exact shape against parse-stream-json's
// stream_event handler before finalizing (see Step 1 instruction):
const TEXT_EVENT = (text) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
emit(TEXT_EVENT(turn.text ?? "Done."));

emit({ type: "result", subtype: "success" });
process.exit(0);
```

POSIX shim `tests/e2e/fixtures/fake-claude/claude`:

```sh
#!/bin/sh
exec node "$(dirname "$0")/fake-claude.mjs" "$@"
```

Windows shim `tests/e2e/fixtures/fake-claude/claude.cmd`:

```bat
@echo off
node "%~dp0fake-claude.mjs" %*
```

Mark the POSIX shim executable so Linux CI can spawn it:

```bash
git update-index --add --chmod=+x tests/e2e/fixtures/fake-claude/claude
```

- [ ] **Step 2: Wire the config.** In `tests/e2e/playwright.config.ts`, above `defineConfig`:

```ts
const FAKE_CLAUDE_DIR = path.resolve(__dirname, "fixtures", "fake-claude");
const FAKE_CLAUDE_CONTROL = path.join(os.tmpdir(), "aoa-e2e-fake-claude", "turn.json");
```

And inside `webServer.env` (after the existing entries):

```ts
          // Commander viewer e2e: resolve `claude` to the deterministic fixture.
          PATH: `${FAKE_CLAUDE_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
          AOA_E2E_FAKE_CLAUDE_CONTROL: FAKE_CLAUDE_CONTROL,
```

(The fake shadows any real `claude` for the e2e server only — fine: no other current spec invokes Commander chat.)

- [ ] **Step 3: The spec.** Selector notes for the executor: the composer is a **contenteditable** (`CommanderInput.tsx`) — before finalizing, read it for the send affordance (Enter-to-send vs a send button testid) and adjust the two `sendMessage` lines; every other selector below is defined by THIS plan's components (`data-testid`s from Tasks 13-14) or standard text.

```ts
// tests/e2e/commander-viewer.spec.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const CONTROL = path.join(os.tmpdir(), "aoa-e2e-fake-claude", "turn.json");

function writeTurn(turn: unknown) {
  fs.mkdirSync(path.dirname(CONTROL), { recursive: true });
  fs.writeFileSync(CONTROL, JSON.stringify(turn), "utf8");
}

async function seedArtifact(request: APIRequestContext, companyId: string, title: string) {
  const res = await request.post(`/api/companies/${companyId}/artifacts`, {
    data: {
      title,
      type: "document",
      content: `# ${title}\n\nPhase 1 — positioning.\n\nPhase 2 — beta.`,
    },
  });
  if (!res.ok()) throw new Error(`seedArtifact failed: ${res.status()} ${await res.text()}`);
  return res.json(); // { id, versions: [{ id, versionNumber }], ... }
}

/** Envelope mirror of mcp-bridge executeAndFormat output. */
function createArtifactEnvelope(artifact: any, title: string) {
  return {
    success: true,
    data: { artifactId: artifact.id, versionId: artifact.versions?.[0]?.id ?? null },
    summary: `Created artifact: ${title}`,
    outputRefs: [
      {
        v: 1,
        kind: "artifact",
        id: artifact.id,
        versionId: artifact.versions?.[0]?.id ?? null,
        versionNumber: 1,
        title,
        action: "created",
        toolCallId: null,
        mimeType: null,
      },
    ],
  };
}

async function sendMessage(page: Page, text: string) {
  const composer = page.locator('[contenteditable="true"]').last();
  await composer.click();
  await composer.fill(text);
  await page.keyboard.press("Enter"); // adjust if CommanderInput uses a send button
}

test.describe("Commander viewer e2e", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Viewer-/);
  });

  test("full viewer interaction loop through the real UI", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Viewer-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, "E2E Launch Plan");

    // 1. Empty chat shows the always-visible rail
    await page.goto(`/${company.issuePrefix}/commander`);
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible({ timeout: 15_000 });

    // 2. Scripted turn: Commander "creates" the artifact (envelope refs → real artifact)
    writeTurn({
      text: "Done — I created the launch plan.",
      toolUses: [
        {
          name: "create_artifact",
          input: { title: "E2E Launch Plan", type: "document" },
          envelope: createArtifactEnvelope(artifact, "E2E Launch Plan"),
        },
      ],
    });
    await sendMessage(page, "Draft a launch plan");

    // 3. Created chip renders under the reply
    const chip = page.getByTestId("output-ref-chips").getByText("E2E Launch Plan");
    await expect(chip).toBeVisible({ timeout: 20_000 });

    // 4. Panel auto-expanded with rendered markdown from the REAL artifact fetch
    await expect(page.getByTestId("commander-viewer-panel")).toBeVisible();
    await expect(page.getByTestId("commander-viewer-panel").getByText("Phase 1 — positioning.")).toBeVisible({ timeout: 10_000 });

    // 5. Collapse → rail keeps the tab icon
    await page.getByTitle("Collapse viewer").click();
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible();

    // 6. Reload → chips persist from history (outputRefs column round-trip)
    await page.reload();
    await expect(page.getByTestId("output-ref-chips").getByText("E2E Launch Plan")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible(); // tabs reset by design

    // 7. Chip click reopens the artifact tab
    await page.getByTestId("output-ref-chips").getByText("E2E Launch Plan").click();
    await expect(page.getByTestId("commander-viewer-panel").getByText("Phase 2 — beta.")).toBeVisible({ timeout: 10_000 });

    // 8. Referenced chips (query) do NOT auto-open
    await page.getByTitle("Collapse viewer").click();
    writeTurn({
      text: "We have one artifact for the launch.",
      toolUses: [
        {
          name: "query_company_artifacts",
          input: {},
          envelope: {
            success: true,
            data: [{ artifactId: artifact.id, title: "E2E Launch Plan", type: "document", currentVersionId: artifact.versions?.[0]?.id ?? null, status: "draft", updatedAt: new Date().toISOString() }],
            summary: "Found 1 artifact in the company",
            outputRefs: [{ v: 1, kind: "artifact", id: artifact.id, versionId: artifact.versions?.[0]?.id ?? null, versionNumber: null, title: "E2E Launch Plan", action: "referenced", toolCallId: null, mimeType: null }],
          },
        },
      ],
    });
    await sendMessage(page, "What artifacts do we have?");
    await expect(page.getByTestId("output-ref-chips").getByText("E2E Launch Plan").nth(1)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("commander-viewer-rail")).toBeVisible(); // still collapsed

    // 9. Home tab shows both groups
    await page.getByTitle("Home").click();
    await expect(page.getByTestId("commander-viewer-home")).toBeVisible();
    await expect(page.getByText("Recent from this conversation")).toBeVisible();
    await expect(page.getByText("Recent in company")).toBeVisible();

    // 10. Reply pop-out
    const lastAssistantBubble = page.getByText("We have one artifact for the launch.").last();
    await lastAssistantBubble.hover();
    await page.getByTitle("Open reply in viewer").last().click();
    await expect(page.getByTestId("commander-viewer-panel").getByText("We have one artifact for the launch.")).toBeVisible();
  });

  test("tool status settles when the tool completes (spinner fix)", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Viewer-Spin-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, "E2E Spin Plan");
    writeTurn({
      text: "Created.",
      toolUses: [{ name: "create_artifact", input: { title: "E2E Spin Plan", type: "document" }, envelope: createArtifactEnvelope(artifact, "E2E Spin Plan") }],
    });
    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, "Draft the spin plan");
    // The completed-tool label must appear (name-correlation makes the match work).
    // Read toolLabel()/completedToolLabel() in InternalAgentPanel for the exact
    // completed text of create_artifact and assert it here:
    await expect(page.getByTestId("output-ref-chips").first()).toBeVisible({ timeout: 20_000 });
  });

  test("mobile: floating pill instead of auto-open", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Viewer-Mob-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, "E2E Mobile Plan");
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(`/${company.issuePrefix}/commander`);
    await expect(page.getByTestId("commander-viewer-pill")).toBeVisible({ timeout: 15_000 });

    writeTurn({
      text: "Created.",
      toolUses: [{ name: "create_artifact", input: { title: "E2E Mobile Plan", type: "document" }, envelope: createArtifactEnvelope(artifact, "E2E Mobile Plan") }],
    });
    await sendMessage(page, "Draft the mobile plan");
    await expect(page.getByTestId("output-ref-chips").getByText("E2E Mobile Plan")).toBeVisible({ timeout: 20_000 });
    // Sheet did NOT auto-open; pill shows the badge
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
    await expect(page.getByTestId("commander-viewer-pill")).toContainText("1");
    // Tap pill → full-screen sheet with the artifact tab available
    await page.getByTestId("commander-viewer-pill").click();
    await expect(page.getByTestId("commander-viewer-tabs")).toBeVisible();
  });
});
```

- [ ] **Step 4: Pre-flight check — Commander config.** The throwaway e2e instance must have an internal-agent config row for the seeded company (chat 400s with "not configured" otherwise). Check `GET /api/companies/:id/internal-agent/config` for a fresh seeded company; if absent, add a `seedCommanderConfig(request, companyId)` helper that PATCHes/POSTs the config with `{ cliTool: "claude_cli" }` (find the exact route in `server/src/routes/internal-agent.ts` — search `internal-agent/config`) and call it in each test before `page.goto`.

- [ ] **Step 5: Run the e2e suite**

Run (repo root, Linux/CI or Windows with external `DATABASE_URL`): `pnpm test:e2e -- commander-viewer.spec.ts`
Expected: 3 tests PASS. On Windows without DATABASE_URL the suite is config-skipped (expected).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/fixtures/fake-claude/ tests/e2e/commander-viewer.spec.ts tests/e2e/playwright.config.ts
git commit -m "test(e2e): commander viewer — full UI chat loop with deterministic fake CLI"
```

---

## Self-review notes (already applied)

- Spec coverage: §2 decisions 1-11 → Tasks 1-15 (auto-open #2 → T12/T15; rail #3 → T14; tab memory #4 → T14 hook; home tab #5 → T14; mobile #6 → T14; persistence #7 → T6/T7; host gating #8 → T15; new tool #9 → T10; provider coverage #10 → T4/T5; bugfix #11 → T4). §3 transport → T3-T9. §4 components → T12-T15. §5 RBAC → no new authz surface anywhere (T10 scopes via ctx.companyId). §6 failure rules → builder try/catch (T2), parser lenient lift (T4/T5), persist-validate-drop (T7). §7 tests → per-task TDD steps + Task 17 automated E2E (full UI chat loop, deterministic fake CLI; covers chips, auto-open, reload persistence, referenced-no-auto-open, home tab, reply pop-out, mobile pill, spinner settle).
- Out-of-scope guards: no editing in viewer, no thumbnails, no read_file/task_outputs/Documents/canvas anywhere in this plan.
- Type consistency: `CommanderOutputRef` (shared) is the single ref type; `ViewerTab`/`ConversationViewerState` defined in T12 and consumed in T14; `AgentStreamChunk.refs` defined in T4 consumed in T5/T8/T9.

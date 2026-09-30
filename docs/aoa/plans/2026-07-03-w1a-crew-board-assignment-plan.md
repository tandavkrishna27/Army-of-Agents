# W1a: Controller-Path Scope Drafts Carry Crew Assignees — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Adjutant proposes crew work on a controller-path thread, the resulting scope draft's task items carry the role-resolved crew `assigneeAgentId`, so applying the draft creates tasks **assigned to crew agents** (not unassigned) — the foundational fix for the empty Crew Board.

**Architecture:** Fix the `create_scope_draft` payload-drop (`thread-agent-actions.ts:707-730` never reads `payload.proposedTasks`). Extract the role→agent resolver into a shared module; the commit handler resolves each `assigneeRole`→`assigneeAgentId` and forwards `proposedTasks` into `createDraftFromThread`, which seeds `task_proposal` scope items (with `assigneeAgentId` in item `payload`) from them — replacing the placeholder stub. The existing apply path already reads `payload.assigneeAgentId` (`thread-scope-versions.ts:1216`), so applied tasks then land assigned. **No autonomy / auto-accept change here** (that is W1b).

**Tech Stack:** TypeScript (ESM), Drizzle ORM, Vitest. Tests use the codebase's Proxy/`createSequenceDb` mock pattern (see `crew-task-service.test.ts`, `thread-scope-accept.test.ts`) and pure-function unit tests.

**Scope note — W1 decomposition (this is W1a):**
- **W1a (this plan):** scope-draft task items carry crew assignees; applying a controller-path draft creates *assigned* tasks. Testable/shippable on its own (removes the "unassigned" bug + kills the placeholder for proposed tasks).
- **W1b (next):** 3-way autonomy gate + auto-accept — Manual=draft only, Assist=auto-accept+apply (board populates, no dispatch), Drive=+dispatch.
- **W1c:** Assist dispatch-approval in the Inbox (approvals + hub source-producer).

---

## File structure

- **Create** `server/src/services/internal-agent/tools/crew-role-map.ts` — shared role→agent-name map (pure) + `resolveRoleToAgentId` (DB lookup), moved out of `propose-crew-work.ts`. One responsibility: crew role resolution.
- **Create** `server/src/__tests__/crew-role-map.test.ts` — unit tests for the map + resolver.
- **Modify** `server/src/services/internal-agent/tools/propose-crew-work.ts` — import the map/resolver from the new module (delete the local copies); no behavior change.
- **Modify** `server/src/services/thread-scope-draft-compiler.ts` — `CompileInput` accepts optional `proposedTasks`; when present, emit a `task_proposal` `CompiledScopeItem` per proposed task (with `payload.assigneeAgentId`) and **suppress the synthetic placeholder task**.
- **Modify** `server/src/services/thread-scope-versions.ts` — `createDraftFromThread` `input` accepts optional `proposedTasks`; forward them into `compileThreadScopeDraft`.
- **Modify** `server/src/services/thread-agent-actions.ts` — the `create_scope_draft` commit handler resolves `payload.proposedTasks[].assigneeRole`→`assigneeAgentId` (via `crew-role-map`) and passes `proposedTasks` into `createDraftFromThread`.
- **Modify** `server/src/__tests__/thread-scope-draft-compiler.test.ts` — add cases for the `proposedTasks` path; update the pinning test that asserts the placeholder title.
- **Create** `server/src/__tests__/thread-scope-assignment.test.ts` — the draft-carries-assignee integration test (compiler → item payload).

---

## Task 1: Extract the crew role→agent resolver into a shared module

**Files:**
- Create: `server/src/services/internal-agent/tools/crew-role-map.ts`
- Create: `server/src/__tests__/crew-role-map.test.ts`
- Modify: `server/src/services/internal-agent/tools/propose-crew-work.ts:15-64` (remove local map/resolver, import shared)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/crew-role-map.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { roleToAgentName, resolveRoleToAgentId } from "../services/internal-agent/tools/crew-role-map.js";

describe("roleToAgentName (pure)", () => {
  it("maps known crew roles to agent names (case/space-insensitive)", () => {
    expect(roleToAgentName("engineer")).toBe("Engineer");
    expect(roleToAgentName(" Engineer ")).toBe("Engineer");
    expect(roleToAgentName("SCOUT")).toBe("Scout");
    expect(roleToAgentName("memory_keeper")).toBe("Memory Keeper");
    expect(roleToAgentName("maker")).toBe("Maker"); // legacy alias
    expect(roleToAgentName("router")).toBe("Navigator"); // legacy alias
  });

  it("returns undefined for unknown/empty roles", () => {
    expect(roleToAgentName("designer")).toBeUndefined();
    expect(roleToAgentName("")).toBeUndefined();
  });
});

describe("resolveRoleToAgentId (db lookup)", () => {
  function dbReturning(rows: Array<{ id: string }>) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => rows }),
        }),
      }),
    };
  }

  it("returns the agent id for a known role with a matching agent", async () => {
    const id = await resolveRoleToAgentId(dbReturning([{ id: "agent-eng" }]), "co-1", "engineer");
    expect(id).toBe("agent-eng");
  });

  it("returns undefined for an unknown role without touching the db", async () => {
    const select = vi.fn();
    const id = await resolveRoleToAgentId({ select }, "co-1", "designer");
    expect(id).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("returns undefined when no agent matches", async () => {
    const id = await resolveRoleToAgentId(dbReturning([]), "co-1", "engineer");
    expect(id).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/crew-role-map.test.ts`
Expected: FAIL — "Cannot find module '.../crew-role-map.js'".

- [ ] **Step 3: Create the shared module**

Create `server/src/services/internal-agent/tools/crew-role-map.ts` (moved verbatim from `propose-crew-work.ts:20-64`, split into a pure map + the db lookup):

```ts
// server/src/services/internal-agent/tools/crew-role-map.ts
//
// Crew role → agent resolution. Extracted from propose-crew-work.ts so both the
// direct tool path AND the controller commit handler (thread-agent-actions.ts)
// resolve assignees the same way. Source of truth for names: ensure-*.ts files.

import { and, eq, ne } from "drizzle-orm";
import { agents } from "@armyofagents/db";

/** Only crew AoA roles are listed; anything else resolves as unassigned (no error). */
const ROLE_TO_AGENT_NAME: Record<string, string> = {
  adjutant: "Adjutant",
  engineer: "Engineer",
  maker: "Maker", // legacy alias for Engineer
  scout: "Scout",
  planner: "Planner",
  navigator: "Navigator",
  router: "Navigator", // legacy alias for Navigator
  memory_keeper: "Memory Keeper",
  scribe: "Scribe",
};

/** Pure: role string → crew agent name, or undefined for unknown/empty. */
export function roleToAgentName(role: string): string | undefined {
  return ROLE_TO_AGENT_NAME[role.toLowerCase().trim()];
}

/**
 * Resolve a role string → crew agent UUID for the given company.
 * Returns undefined when the role is unknown or no matching agent exists.
 */
export async function resolveRoleToAgentId(
  db: { select: Function },
  companyId: string,
  role: string,
): Promise<string | undefined> {
  const agentName = roleToAgentName(role);
  if (!agentName) return undefined;

  const rows = await (db as any)
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, agentName),
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  return rows[0]?.id as string | undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/crew-role-map.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Update `propose-crew-work.ts` to import the shared resolver**

In `server/src/services/internal-agent/tools/propose-crew-work.ts`: delete the local `ROLE_TO_AGENT_NAME` (lines 20-36) and `resolveRoleToAgentId` (lines 38-64) and the now-unused `import { and, eq, ne } from "drizzle-orm";` / `import { agents } from "@armyofagents/db";` (lines 15-16). Add at the top with the other imports:

```ts
import { resolveRoleToAgentId } from "./crew-role-map.js";
```

The existing call site at `propose-crew-work.ts:209` (`await resolveRoleToAgentId(ctx.db as any, ctx.companyId, task.assigneeRole)`) is unchanged.

- [ ] **Step 6: Run the propose-crew-work tests to confirm no regression**

Run: `cd server && npx vitest run src/__tests__/propose-crew-work-tool.test.ts`
Expected: PASS (unchanged behavior — resolution moved, not altered).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/internal-agent/tools/crew-role-map.ts server/src/__tests__/crew-role-map.test.ts server/src/services/internal-agent/tools/propose-crew-work.ts
git commit -m "refactor(crew): extract crew role→agent resolver into shared module"
```

---

## Task 2: Compiler emits assigned task_proposal items from proposedTasks

**Files:**
- Modify: `server/src/services/thread-scope-draft-compiler.ts` (`CompileInput` + task emission)
- Modify: `server/src/__tests__/thread-scope-draft-compiler.test.ts`

**Context:** `compileThreadScopeDraft(input: CompileInput)` builds `CompiledScopeItem[]`. Today, when there are no extracted task items, it synthesizes ONE placeholder `task_proposal` via `titleForGeneratedTask` (`thread-scope-draft-compiler.ts:94-99`, emitted around `:280-288`). We add a `proposedTasks` input; when present and non-empty, we emit one real `task_proposal` per proposed task (carrying `payload.assigneeAgentId`) and **do not** emit the placeholder.

- [ ] **Step 1: Write the failing test**

Add to `server/src/__tests__/thread-scope-draft-compiler.test.ts`:

```ts
import { compileThreadScopeDraft } from "../services/thread-scope-draft-compiler.js";

describe("compileThreadScopeDraft — proposedTasks", () => {
  const base = {
    threadTitle: "Auth rewrite",
    summaryText: "Migrate auth to JWT",
    entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: "let's scope the auth work" }],
    extractedItems: [],
    attachments: [],
  };

  it("emits one assigned task_proposal per proposedTask and no placeholder", () => {
    const out = compileThreadScopeDraft({
      ...base,
      proposedTasks: [
        { title: "Build token endpoint", assigneeAgentId: "agent-eng" },
        { title: "Add refresh rotation", assigneeAgentId: "agent-eng" },
        { title: "Unassigned research" }, // no assignee → null
      ],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.title)).toEqual([
      "Build token endpoint",
      "Add refresh rotation",
      "Unassigned research",
    ]);
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-eng");
    expect(tasks[2].payload.assigneeAgentId).toBeNull();
    // placeholder title must never appear when proposedTasks are given
    expect(tasks.map((t) => t.title)).not.toContain("Implement real multi-message scope generation");
  });

  it("falls back to extracted-item compilation when proposedTasks is absent", () => {
    const out = compileThreadScopeDraft(base); // no proposedTasks
    // no extracted items + text contains 'scope' → legacy placeholder still fires
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Implement real multi-message scope generation");
  });

  it("D1 dedup: proposedTasks suppress extracted task_proposals but keep decisions/memory", () => {
    const out = compileThreadScopeDraft({
      ...base,
      extractedItems: [
        { id: "x1", discussionEntryId: "e1", type: "task", title: "Extracted duplicate task", status: "pending" },
        { id: "x2", discussionEntryId: "e1", type: "decision", title: "Use JWT", status: "pending" },
      ] as any,
      proposedTasks: [{ title: "Adjutant task", assigneeAgentId: "agent-eng" }],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    // ONLY the proposed task — zero extracted task_proposals, zero placeholder
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("Adjutant task");
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-eng");
    // the extracted decision survives
    expect(out.items.some((i) => i.kind === "decision" && i.title === "Use JWT")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/thread-scope-draft-compiler.test.ts -t "proposedTasks"`
Expected: FAIL — `compileThreadScopeDraft` ignores `proposedTasks` (first test: 1 placeholder task, not 3).

- [ ] **Step 3: Add `proposedTasks` to `CompileInput` and emit from it**

In `server/src/services/thread-scope-draft-compiler.ts`:

(a) Extend the `CompileInput` type (the `type CompileInput = { ... }` block, ~lines 61-67) — add one field:

```ts
type CompileInput = {
  threadTitle: string | null;
  summaryText: string | null;
  entries: ScopeCompilerEntry[];
  extractedItems: ScopeCompilerExtractedItem[];
  attachments?: ScopeCompilerAttachment[];
  /** Adjutant-supplied tasks (already role-resolved). When present + non-empty,
   *  these become the task_proposal items and suppress the synthetic placeholder. */
  proposedTasks?: Array<{ title: string; assigneeAgentId?: string | null }>;
};
```

(b) Add a helper near the other item builders:

```ts
function proposedTaskItems(
  proposedTasks: Array<{ title: string; assigneeAgentId?: string | null }>,
  entries: ScopeCompilerEntry[],
): CompiledScopeItem[] {
  const sourceEntryIds = entryIds(entries);
  return proposedTasks.map((t) => ({
    kind: "task_proposal" as const,
    title: cleanText(t.title),
    description: null,
    sourceEntryIds,
    payload: { priority: "medium", assigneeAgentId: t.assigneeAgentId ?? null },
  }));
}
```

(c) In `compileThreadScopeDraft`, make `proposedTasks` the **authoritative task source** when present (decision D1 — "proposedTasks win"). This requires suppressing **both** the placeholder **and** the extracted-item `task_proposal`s, because `mapExtractedItem` emits a `task_proposal` for every `type==='task'` extracted item in the main mapping loop (independent of the placeholder at `:280-288`). Without this, the Adjutant's tasks and the extracted tasks BOTH emit → duplicate cards → duplicate Crew Board tasks.

Precise change — set a flag once, then use it in three places:

```ts
const useProposedTasks = Boolean(input.proposedTasks && input.proposedTasks.length > 0);
```

1. **Extracted-item mapping loop** (where `mapExtractedItem` runs over `extractedItems`): when `useProposedTasks`, **skip** items whose mapped `kind === "task_proposal"` (i.e. `type === "task"`). Keep every other kind (`decision`, `memory_candidate`, `source_signal`, etc.). Concretely, filter after mapping:

```ts
const extractedCompiled = input.extractedItems
  .map(mapExtractedItem)
  .filter((it) => !(useProposedTasks && it.kind === "task_proposal"));
items.push(...extractedCompiled);
```

2. **Placeholder synthesis** (the `!hasGeneratedWorkItem` block, ~`:277-288`): guard it so it never fires when `useProposedTasks`:

```ts
} else if (!hasGeneratedWorkItem && !useProposedTasks) {
  // ...existing placeholder synthesis, unchanged...
}
```

3. **Emit the proposed tasks** (after the extracted-item/placeholder handling):

```ts
if (useProposedTasks) {
  items.push(...proposedTaskItems(input.proposedTasks!, input.entries));
}
```

(Decisions, memory-candidates, and attachments from extracted items still emit in all cases — only `task_proposal` items are governed by `proposedTasks`.)

> Implementer note: `mapExtractedItem` currently runs inline in the item loop; if the exact structure differs, the invariant to preserve is: **when `useProposedTasks`, the only `task_proposal` items in the output come from `proposedTaskItems` — zero from extracted items, zero placeholder.** Assert exactly that in the test below.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/thread-scope-draft-compiler.test.ts`
Expected: PASS — both new tests + the existing suite (the legacy placeholder test still passes because it exercises the no-`proposedTasks` branch).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/thread-scope-draft-compiler.ts server/src/__tests__/thread-scope-draft-compiler.test.ts
git commit -m "feat(scope): compiler emits assigned task_proposal items from proposedTasks"
```

---

## Task 3: `createDraftFromThread` forwards proposedTasks to the compiler

**Files:**
- Modify: `server/src/services/thread-scope-versions.ts:627-756` (`createDraftFromThread` input + compile call)
- Create: `server/src/__tests__/thread-scope-assignment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/thread-scope-assignment.test.ts`. This drives the real `createDraftFromThread` against a `createSequenceDb`-style mock, asserting the `threadScopeItems` insert carries `payload.assigneeAgentId`. Mirror the capture pattern from `thread-scope-accept.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

// drizzle operator + table mocks (same pattern as thread-scope-accept.test.ts)
vi.mock("drizzle-orm", () => {
  const op = (tag: string) => (...args: unknown[]) => ({ _tag: tag, args });
  return {
    and: op("and"), eq: op("eq"), ne: op("ne"), gt: op("gt"), gte: op("gte"),
    lte: op("lte"), asc: op("asc"), desc: op("desc"), isNull: op("isNull"),
    inArray: op("inArray"), sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  };
});
vi.mock("@armyofagents/db", () => ({
  __esModule: true,
  discussions: new Proxy({}, { get: (_t, p) => p }),
  discussionEntries: new Proxy({}, { get: (_t, p) => p }),
  discussionExtractedItems: new Proxy({}, { get: (_t, p) => p }),
  discussionEntryAttachments: new Proxy({}, { get: (_t, p) => p }),
  artifacts: new Proxy({}, { get: (_t, p) => p }),
  assets: new Proxy({}, { get: (_t, p) => p }),
  threadScopeVersions: new Proxy({}, { get: (_t, p) => p }),
  threadScopeItems: new Proxy({}, { get: (_t, p) => p }),
  threadScopeArtifactLinks: new Proxy({}, { get: (_t, p) => p }),
}));

import { threadScopeVersionService } from "../services/thread-scope-versions.js";

/** Minimal db: fixed thread + zero extracted items; captures the scope-items insert. */
function makeDb(captured: { items?: unknown[] }) {
  const thread = { id: "t1", companyId: "co1", subtype: "normal", entrySeq: 1, title: "T", summaryText: null };
  const selectResults: unknown[][] = [
    [thread],           // load thread
    [],                 // loadLatestScopeVersion → none
    [{ id: "e1", seq: 1, inputType: "write", rawContent: "scope it" }], // entries
    [],                 // extractedItems (zero)
    [],                 // attachments
  ];
  let sel = 0;
  const chain = (rows: unknown[]) => ({
    from: () => chain(rows), where: () => chain(rows), leftJoin: () => chain(rows),
    orderBy: () => chain(rows), limit: async () => rows,
    then: (r: (v: unknown[]) => unknown) => Promise.resolve(rows).then(r),
  });
  const tx = {
    insert: (table: unknown) => ({
      values: (vals: unknown) => ({
        returning: async () => {
          if ((table as any) === "threadScopeItems" || Array.isArray(vals)) { captured.items = vals as unknown[]; return []; }
          return [{ id: "v1", versionNumber: 1 }];
        },
      }),
    }),
  };
  return {
    select: () => chain(selectResults[sel++] ?? []),
    transaction: async (fn: (t: unknown) => unknown) => fn({
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          const rec = { returning: async () => {
            const name = String((table as any)?.constructor === Object ? "" : "");
            if (Array.isArray(vals)) { captured.items = vals as unknown[]; return []; }
            return [{ id: "v1", versionNumber: 1 }];
          } };
          return rec;
        },
      }),
    }),
  } as any;
}

describe("createDraftFromThread — proposedTasks assignee", () => {
  it("seeds scope items with assigneeAgentId from proposedTasks", async () => {
    const captured: { items?: unknown[] } = {};
    const svc = threadScopeVersionService(makeDb(captured));
    await svc.createDraftFromThread("co1", "t1", { agentId: "adj" }, {
      summary: "Auth work",
      proposedTasks: [{ title: "Build token endpoint", assigneeAgentId: "agent-eng" }],
    });
    const items = (captured.items ?? []) as Array<{ kind: string; title: string; payload: any }>;
    const task = items.find((i) => i.kind === "task_proposal");
    expect(task).toBeDefined();
    expect(task!.title).toBe("Build token endpoint");
    expect(task!.payload.assigneeAgentId).toBe("agent-eng");
  });
});
```

> Note for the implementer: the mock's exact insert-capture shape may need a small tweak to match how `thread-scope-versions.ts` distinguishes the `threadScopeVersions` insert from the `threadScopeItems` insert (the items insert passes an **array** of values; the version insert passes a single object). Assert on the array-valued insert. Cross-check against the working capture helper in `thread-scope-accept.test.ts:50-88` and reuse it if cleaner.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/thread-scope-assignment.test.ts`
Expected: FAIL — `createDraftFromThread` does not accept `proposedTasks`, so the item has no `assigneeAgentId` (undefined) / the task is the placeholder.

- [ ] **Step 3: Thread `proposedTasks` through `createDraftFromThread`**

In `server/src/services/thread-scope-versions.ts`, extend the `input` param type of `createDraftFromThread` (lines 631-636) and forward it into the compile call (lines 718-756):

```ts
input: {
  summary?: string;
  assumptions?: unknown[];
  decisions?: unknown[];
  openQuestions?: unknown[];
  proposedTasks?: Array<{ title: string; assigneeAgentId?: string | null }>;
},
```

Then in the `compileThreadScopeDraft({ ... })` call add one line alongside `attachments`:

```ts
const compiled = compileThreadScopeDraft({
  threadTitle: thread.title ?? null,
  summaryText: input.summary ?? thread.summaryText ?? null,
  entries: entries.map((entry) => ({ id: entry.id, seq: entry.seq ?? 0, inputType: entry.inputType, rawContent: entry.rawContent })),
  extractedItems: /* ...unchanged... */,
  attachments: /* ...unchanged... */,
  proposedTasks: input.proposedTasks,
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/thread-scope-assignment.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the scope-versions suite for regressions**

Run: `cd server && npx vitest run src/__tests__/thread-scope-drafts.test.ts src/__tests__/thread-scope-accept.test.ts`
Expected: PASS (proposedTasks is optional; absent → identical behavior).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/thread-scope-versions.ts server/src/__tests__/thread-scope-assignment.test.ts
git commit -m "feat(scope): createDraftFromThread forwards proposedTasks to the compiler"
```

---

## Task 4: `create_scope_draft` commit handler resolves roles + forwards proposedTasks

**Files:**
- Modify: `server/src/services/thread-agent-actions.ts:707-730` (the `create_scope_draft` handler)
- Modify: `server/src/__tests__/thread-agent-actions.test.ts` (add a case) OR `thread-commit-idempotency.integration.test.ts`

**Context:** The handler (excerpt from the investigation) currently forwards only `summary`/`assumptions`/`decisions`/`openQuestions`:

```ts
if (action.actionType === "create_scope_draft") {
  const payload = asRecord(action.payload);
  const draft = await scopeVersionCommitter.createDraftFromThread(
    input.companyId, input.threadId,
    { agentId: action.agentId ?? undefined, isHuman: false },
    { summary: asString(payload.summary), assumptions: asArray(payload.assumptions),
      decisions: asArray(payload.decisions), openQuestions: asArray(payload.openQuestions) },
  );
  ...
}
```

- [ ] **Step 1: Write the failing test**

Add a unit test that drives the handler's role-resolution + forwarding. Follow the existing `thread-agent-actions.test.ts` mock style; mock `crew-role-map.resolveRoleToAgentId` and assert `createDraftFromThread` receives resolved `proposedTasks`. Concretely, assert: given `payload.proposedTasks = [{title:"X", assigneeRole:"engineer"}]` and a resolver returning `"agent-eng"`, the `scopeVersionCommitter.createDraftFromThread` mock is called with `input.proposedTasks = [{title:"X", assigneeAgentId:"agent-eng"}]`.

```ts
// in thread-agent-actions.test.ts — add near the create_scope_draft cases
it("create_scope_draft resolves assigneeRole and forwards proposedTasks", async () => {
  const createDraftFromThread = vi.fn().mockResolvedValue({ version: { id: "v1" } });
  const resolveRoleToAgentId = vi.fn().mockResolvedValue("agent-eng");
  // ... wire mocks so the committed action has:
  //   payload: { summary: "S", proposedTasks: [{ title: "X", assigneeRole: "engineer" }] }
  // and scopeVersionCommitter.createDraftFromThread === createDraftFromThread,
  //     crew-role-map.resolveRoleToAgentId === resolveRoleToAgentId
  // ... run commitThreadAgentActions ...
  expect(resolveRoleToAgentId).toHaveBeenCalledWith(expect.anything(), expect.any(String), "engineer");
  expect(createDraftFromThread).toHaveBeenCalledWith(
    expect.any(String), expect.any(String), expect.anything(),
    expect.objectContaining({
      summary: "S",
      proposedTasks: [{ title: "X", assigneeAgentId: "agent-eng" }],
    }),
  );
});
```

> Implementer: match the file's existing harness for constructing a committable action (see the other `create_scope_draft`/`add_scope_item` cases in `thread-agent-actions.test.ts`); reuse its action-builder + db mock rather than hand-rolling.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/thread-agent-actions.test.ts -t "resolves assigneeRole"`
Expected: FAIL — handler doesn't read `payload.proposedTasks` and doesn't resolve roles.

- [ ] **Step 3: Update the handler to resolve roles + forward proposedTasks**

Add the import at the top of `thread-agent-actions.ts` (with the other imports):

```ts
import { resolveRoleToAgentId } from "./internal-agent/tools/crew-role-map.js";
```

Replace the `create_scope_draft` handler body (the `createDraftFromThread` call) with role resolution first:

```ts
if (action.actionType === "create_scope_draft") {
  const payload = asRecord(action.payload);

  // Resolve each proposed task's role → crew agentId (server-side; the tool drops
  // this in controller mode). Unknown/missing roles → null (unassigned).
  const rawTasks = asArray(payload.proposedTasks) as Array<{ title?: unknown; assigneeRole?: unknown }>;
  const proposedTasks = await Promise.all(
    rawTasks
      .filter((t) => typeof t?.title === "string" && (t.title as string).trim().length > 0)
      .map(async (t) => ({
        title: t.title as string,
        assigneeAgentId:
          typeof t.assigneeRole === "string"
            ? (await resolveRoleToAgentId(actionDb as unknown as { select: Function }, input.companyId, t.assigneeRole)) ?? null
            : null,
      })),
  );

  const draft = await scopeVersionCommitter.createDraftFromThread(
    input.companyId, input.threadId,
    { agentId: action.agentId ?? undefined, isHuman: false },
    {
      summary: asString(payload.summary),
      assumptions: asArray(payload.assumptions),
      decisions: asArray(payload.decisions),
      openQuestions: asArray(payload.openQuestions),
      ...(proposedTasks.length > 0 ? { proposedTasks } : {}),
    },
  );
  if (draft.version?.id) batchProducedScopeVersionId = draft.version.id;
  await updateActionStatus(actionDb, action.id, { status: "committed", committedScopeVersionId: draft.version?.id ?? null });
  result.committed += 1;
  continue;
}
```

> Use the same db handle the handler already uses for this action (`actionDb` in the excerpt). If the resolver needs the outer `db` instead, use that — match the variable in scope at that point.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/thread-agent-actions.test.ts`
Expected: PASS (new case + existing suite).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/thread-agent-actions.ts server/src/__tests__/thread-agent-actions.test.ts
git commit -m "feat(scope): create_scope_draft resolves crew roles + forwards proposedTasks"
```

---

## Task 5: End-to-end verification — controller draft → applied tasks are assigned

**Files:**
- Verify only (no new production code): `applyAcceptedDraft` already sets `assigneeAgentId: payload.assigneeAgentId ?? null` (`thread-scope-versions.ts:1216`) and `createOutputItem` at `:1427`.

- [ ] **Step 1: Add an integration assertion**

Extend `server/src/__tests__/thread-scope-assignment.test.ts` with a test that runs `acceptDraft`/`applyAcceptedDraft` on a version whose `task_proposal` item carries `payload.assigneeAgentId = "agent-eng"` and asserts the mocked `issueService.create` receives `assigneeAgentId: "agent-eng"`. Reuse the `issueService` mock + capture pattern from `thread-scope-accept.test.ts:3-12,50-88`.

```ts
it("applying a draft creates an issue assigned to the crew agent", async () => {
  // arrange: a draft version with one accepted task_proposal item,
  //   payload.assigneeAgentId = "agent-eng" (as produced by Tasks 2-4)
  // act: svc.applyAcceptedDraft(...)  (or acceptDraft then apply)
  // assert: issueService.create called with objectContaining({ assigneeAgentId: "agent-eng" })
  expect(issueCreate).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: "agent-eng" }));
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx vitest run src/__tests__/thread-scope-assignment.test.ts`
Expected: PASS.

- [ ] **Step 3: Full-suite regression + typecheck**

Run: `cd server && npx vitest run src/__tests__/thread-scope-drafts.test.ts src/__tests__/thread-scope-accept.test.ts src/__tests__/thread-agent-actions.test.ts src/__tests__/propose-crew-work-tool.test.ts src/__tests__/crew-task-service.test.ts`
Then: `cd server && npx tsc --noEmit`
Expected: PASS / no type errors.

- [ ] **Step 4: Live verification (per quality bar D15)**

Boot a keyless instance (`AOA_INSTANCE_ID=qa4 PORT=3293 pnpm --filter @armyofagents/server dev`), create a company, a discussion, extract, set the thread to **Drive**, and `@Adjutant scope this`. After the controller commits + a human accepts the draft, `GET /companies/:cid/issues?taskScope=crew` should return tasks with a non-null `assigneeAgentId` (the Engineer), i.e. **the Crew Board is populated**. (Full autonomy-gated auto-accept is W1b; here, accept the draft via the scope API to confirm assignment.)

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/thread-scope-assignment.test.ts
git commit -m "test(scope): applied controller draft creates crew-assigned tasks"
```

---

## Test Coverage (D15: unit + integration + contract + E2E)

```
CODE PATHS                                              TESTS
[+] crew-role-map.ts
  ├── roleToAgentName()          [★★★ UNIT]  crew-role-map.test.ts (known/unknown/case)
  └── resolveRoleToAgentId()     [★★★ UNIT]  crew-role-map.test.ts (match / unknown-skips-db / no-match)
[+] thread-scope-draft-compiler.ts
  ├── proposedTaskItems()        [★★★ UNIT]  compiler.test.ts (assigned + null)
  ├── compile w/ proposedTasks   [★★★ UNIT]  compiler.test.ts (emits proposed, D1 dedup suppresses extracted-task + placeholder, keeps decisions)
  └── compile w/o proposedTasks  [★★  UNIT]  compiler.test.ts (REGRESSION — legacy placeholder path unchanged)
[+] thread-scope-versions.createDraftFromThread(proposedTasks)
  ├── seeds item payload.assignee[★★  UNIT]  thread-scope-assignment.test.ts (mock)
  └── real draft+items rows      [→INTEGRATION] w1a-crew-assignment.integration.test.ts
[+] thread-agent-actions.create_scope_draft handler
  ├── resolves role + forwards   [★★  UNIT]  thread-agent-actions.test.ts
  └── commit→draft w/ assignees  [→INTEGRATION] w1a-crew-assignment.integration.test.ts
[+] applyAcceptedDraft (existing) assignee passthrough
  └── apply→issue assigned       [★★  UNIT] thread-scope-assignment.test.ts  +  [→INTEGRATION] real issues row
[+] payload/schema shapes
  └── proposedTasks + item.payload.assigneeAgentId  [→CONTRACT] w1a-scope-assignment-contract.test.ts

USER FLOWS
[+] Controller scope-draft → accept/apply → Crew Board shows ASSIGNED task
  └── [→E2E] tests/e2e/team-aoa-crew-assignment.spec.ts (seeded, no LLM, fake embedder)
[+] Empty thread scoped w/ no proposedTasks → no fake card on board
  └── [★★ UNIT] compiler regression (above)

COVERAGE TARGET: every path above has a test. 3 gaps filled below: INTEGRATION (T6), CONTRACT (T7), E2E (T8).
```

**Regression note (IRON RULE):** Task 2's "compile w/o proposedTasks" case is a mandatory regression test — it proves the legacy Path-B behavior (extracted-item compile + placeholder) is byte-unchanged when `proposedTasks` is absent, so we don't break existing manual-scope threads.

---

## Task 6: Real-DB integration test — controller draft → apply → assigned issue

**Files:**
- Create: `server/src/__tests__/w1a-crew-assignment.integration.test.ts`

**Context:** Unit tests (Tasks 1-4) mock the DB. This is the real-Postgres proof that the whole Path-B chain assigns crew agents: seed a company + crew Engineer + a thread with a committed `create_scope_draft` action carrying `proposedTasks:[{assigneeRole:"engineer"}]`, drive the commit, accept+apply the draft, and assert the created `issues` row has `assigneeAgentId = <Engineer id>`. Model the harness on `thread-commit-idempotency.integration.test.ts` (embedded-postgres; runs in Linux CI, skipped on Windows per Issue #114 — gate with the same skip guard that file uses).

- [ ] **Step 1: Write the failing integration test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTestDb } from "./helpers/withTestDb.js"; // reuse the harness thread-commit-idempotency uses
import { threadAgentActionService } from "../services/thread-agent-actions.js";
import { threadScopeVersionService } from "../services/thread-scope-versions.js";

describe("W1a integration: controller scope draft → apply → assigned crew task", () => {
  it("creates an issue assigned to the role-tagged crew agent", async () => {
    await withTestDb(async (db, seed) => {
      const { companyId } = await seed.company();
      const engineer = await seed.crewAgent({ companyId, name: "Engineer" }); // kind='aoa'
      const { threadId } = await seed.thread({ companyId });
      // queue + seal a create_scope_draft action carrying proposedTasks
      const action = await seed.committableAction({
        companyId, threadId, actionType: "create_scope_draft",
        payload: { summary: "Auth", proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }] },
      });
      // drive the commit (create_scope_draft handler → createDraftFromThread with resolved assignee)
      const res = await threadAgentActionService(db).commitThreadAgentActions({ companyId, threadId });
      expect(res.committed).toBe(1);

      const svc = threadScopeVersionService(db);
      const [version] = (await svc.listVersions(companyId, threadId));
      const detail = await svc.getVersion(companyId, threadId, version.id);
      const task = detail.items.find((i) => i.kind === "task_proposal");
      expect(task).toBeDefined();
      expect((task!.payload as any).assigneeAgentId).toBe(engineer.id);

      // accept + apply → real issue, assigned
      await svc.acceptDraft(companyId, threadId, version.id, [task!.id]);
      const applied = await svc.applyAcceptedDraft(companyId, threadId, version.id);
      const issueId = applied.createdIssueIds?.[0] ?? applied.items?.[0]?.resultIssueId;
      const issue = await seed.getIssue(issueId!);
      expect(issue.assigneeAgentId).toBe(engineer.id);
      expect(issue.originKind).toBe("crew_thread");
    });
  });
});
```

> Implementer: match the exact seed/harness API of `thread-commit-idempotency.integration.test.ts` (its `withTestDb`/seed helpers and the real `committableAction` builder — proposeThreadAction + sealRunActions). The assertions above are the contract; adapt the setup calls to the existing helper names. Add the same Windows-skip guard that file uses.

- [ ] **Step 2: Run it (fails until Tasks 2-4 land)**

Run: `cd server && npx vitest run src/__tests__/w1a-crew-assignment.integration.test.ts`
Expected: FAIL before Tasks 2-4; PASS after.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/w1a-crew-assignment.integration.test.ts
git commit -m "test(scope): integration — controller draft applies to a crew-assigned issue"
```

---

## Task 7: Contract test — payload + item shapes

**Files:**
- Create: `server/src/__tests__/w1a-scope-assignment-contract.test.ts`

**Context:** Contract tests (per CLAUDE.md test patterns) verify API/payload shapes without drizzle internals. Lock the two shapes W1a depends on so a future refactor can't silently drop them: (a) the `create_scope_draft` action payload accepts `proposedTasks[].assigneeRole`; (b) a compiled `task_proposal` scope item carries `payload.assigneeAgentId`.

- [ ] **Step 1: Write the contract test**

```ts
import { describe, it, expect } from "vitest";
import { compileThreadScopeDraft } from "../services/thread-scope-draft-compiler.js";

describe("W1a contract: assignee flows through scope-item payload", () => {
  it("compiled task_proposal exposes payload.assigneeAgentId (string | null)", () => {
    const out = compileThreadScopeDraft({
      threadTitle: "T", summaryText: "S",
      entries: [{ id: "e1", seq: 1, inputType: "write", rawContent: "x" }],
      extractedItems: [], attachments: [],
      proposedTasks: [{ title: "A", assigneeAgentId: "agent-1" }, { title: "B" }],
    });
    const tasks = out.items.filter((i) => i.kind === "task_proposal");
    for (const t of tasks) {
      expect(t.payload).toHaveProperty("assigneeAgentId");
      expect(["string", "object"]).toContain(typeof t.payload.assigneeAgentId); // string | null
    }
    expect(tasks[0].payload.assigneeAgentId).toBe("agent-1");
    expect(tasks[1].payload.assigneeAgentId).toBeNull();
  });
});
```

> If the repo has a `thread-scope-schema-contract.test.ts`, add an assertion there that `thread_scope_items.payload` is the assignee carrier (there is no dedicated assignee column — schema per `packages/db/src/schema/thread_scope_items.ts`), to prevent a future migration from assuming a column that isn't there.

- [ ] **Step 2: Run + commit**

Run: `cd server && npx vitest run src/__tests__/w1a-scope-assignment-contract.test.ts` → PASS (after Task 2).
```bash
git add server/src/__tests__/w1a-scope-assignment-contract.test.ts
git commit -m "test(scope): contract — assignee carried in scope-item payload"
```

---

## Task 8: Playwright E2E — Crew Board shows the assigned task

**Files:**
- Create: `tests/e2e/team-aoa-crew-assignment.spec.ts`

**Context:** Prove the user-visible outcome without an LLM: seed (via REST) a company + crew Engineer + a discussion + a scope version whose `task_proposal` item carries `payload.assigneeAgentId = <Engineer>`, apply it, then open **Team → AoA Team → Tasks** and assert the card shows the Engineer as owner. Model on the existing `tests/e2e/team-aoa-tasks-crew-board.spec.ts` (same page objects + `AOA_E2E_FAKE_EMBEDDER=1`). Linux-gated; Windows e2e is skipped at playwright-config level (Issue #114) — no extra guard needed, the config handles it.

- [ ] **Step 1: Write the E2E spec**

```ts
import { test, expect } from "@playwright/test";
import { seedCompany, seedCrewAgent, api } from "./helpers/seed"; // reuse existing e2e seed helpers

test("crew task from an applied scope draft appears ASSIGNED on the Crew Board", async ({ page, request }) => {
  const { companyId, prefix } = await seedCompany(request, { name: "W1a E2E Co" });
  const engineer = await seedCrewAgent(request, { companyId, name: "Engineer" });

  // Seed a discussion + a scope draft with an assigned task_proposal item, then apply — all via REST (no LLM).
  const did = await api.createDiscussion(request, companyId, { title: "Auth" });
  const versionId = await api.seedScopeDraftWithAssignedTask(request, companyId, did, {
    title: "Build token endpoint", assigneeAgentId: engineer.id,
  });
  await api.acceptAndApplyScope(request, companyId, did, versionId);

  await page.goto(`/${prefix}/team?tab=aoa&aoaTab=tasks`);
  const card = page.getByText("Build token endpoint");
  await expect(card).toBeVisible();
  // owner chip on the card shows the crew Engineer
  await expect(card.locator("xpath=ancestor::*[contains(@class,'card')]").getByText("Engineer")).toBeVisible();
});
```

> Implementer: if `seedScopeDraftWithAssignedTask` doesn't exist as a helper, either add it (POST scope draft + PATCH the item's `payload.assigneeAgentId` + review/accept) or drive it through the real controller path with `AOA_E2E_FAKE_EMBEDDER`. Match the selector/page-object conventions in `team-aoa-tasks-crew-board.spec.ts`. Keep it LLM-free so it's deterministic in CI.

- [ ] **Step 2: Run (Linux/local)**

Run: `AOA_E2E_FAKE_EMBEDDER=1 npx playwright test tests/e2e/team-aoa-crew-assignment.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/team-aoa-crew-assignment.spec.ts
git commit -m "test(e2e): crew board shows assigned task from an applied scope draft"
```

---

## Self-Review

- **Spec coverage:** W1a covers the assignment half of design workstream W1 (D2 — role-tagged → crew agent, tasks land assigned). Autonomy-gate split (Manual/Assist/Drive create behavior) and Inbox dispatch-approval are explicitly deferred to W1b/W1c. The placeholder-stub kill (design W2) is partially addressed for the proposedTasks path (Task 2 suppresses it when proposedTasks exist); the standalone "kill the stub for empty threads" remains a W2 item.
- **Placeholder scan:** Two steps (Task 4 Step 1, Task 5 Step 1) intentionally reference the file's existing test harness rather than duplicating a large mock — flagged inline for the implementer to reuse `thread-agent-actions.test.ts` / `thread-scope-accept.test.ts` builders. All production-code steps show complete code.
- **Type consistency:** `proposedTasks: Array<{ title: string; assigneeAgentId?: string | null }>` is used identically in the compiler (`CompileInput`), `createDraftFromThread` input, and the handler's forwarded object. `roleToAgentName`/`resolveRoleToAgentId` signatures match across the new module and its callers.

---

## Open risk / note for review

- **Which path to fix (locked in eng review):** we fix Path B (controller `create_scope_draft`) in place rather than re-routing controller proposals through `crewTaskService.proposeWork` (Path A). Rationale: preserves the outbox freshness/idempotency guarantees and the founder-facing `thread_scope_versions` Scope-tab model, and reuses the existing `applyAcceptedDraft` assignee handling. Unifying on Path A is a larger change and a different plan.
- **`workMode: "planning"`** on scope-version tasks (`thread-scope-versions.ts:1222`) makes them non-dispatchable until flipped to Standard. That interacts with W1b (Drive auto-dispatch) — called out there, not here.

---

## NOT in scope (deferred)

- **Autonomy-gated auto-accept** (Manual=draft / Assist=auto-create+assign / Drive=+dispatch) — **W1b**. W1a stops at "an *accepted* controller draft yields assigned tasks"; the accept is still manual (via the scope API) in W1a.
- **Assist dispatch-approval in the Inbox** — **W1c** (touches `approvals` + hub source-producers).
- **Kill the placeholder for genuinely-empty threads** (no proposedTasks, no extracted items) — the placeholder still fires there; W1a only suppresses it when `proposedTasks` exist. Standalone stub-removal is design workstream **W2**.
- **Org-agent / human task routing** — separate follow-up (design §6). W1a assigns crew only.
- **Batching `resolveRoleToAgentId`** into one query for N tasks — N is a handful; per-task lookup is fine (YAGNI). Revisit only if a scope proposes many tasks.

## What already exists (reused, not rebuilt)

- **Role→agent resolution** — `resolveRoleToAgentId` + `ROLE_TO_AGENT_NAME` already exist in `propose-crew-work.ts`; Task 1 *moves* them to a shared module, does not reinvent.
- **Assignee passthrough on apply** — `applyAcceptedDraft` (`thread-scope-versions.ts:1216`) and `createOutputItem` (`:1427`) already read `payload.assigneeAgentId`. W1a only has to *populate* it upstream — no apply-path changes.
- **Extracted-item → task/decision/memory mapping** — `mapExtractedItem` already builds `task_proposal`/`decision`/`memory_candidate` items; W1a reuses it and only governs the `task_proposal` subset via D1.
- **Real-DB + E2E harnesses** — `thread-commit-idempotency.integration.test.ts` (integration) and `team-aoa-tasks-crew-board.spec.ts` (E2E) provide the seed/page-object patterns the new T6/T8 tests reuse.

## Failure modes (each has a test + error path)

| Failure | Test | Handling | User-visible? |
|---|---|---|---|
| Unknown/missing `assigneeRole` | `crew-role-map.test.ts` + Task 4 | resolves to `null` → task created unassigned (not an error) | task shows unassigned (correct) |
| Duplicate task from extracted + proposed | Task 2 D1 dedup test + T6 | proposedTasks win, extracted `task_proposal`s suppressed | no duplicate cards |
| Role resolves to a terminated/absent agent | `crew-role-map.test.ts` (no-match) | `null` → unassigned | task unassigned, not a crash |
| Empty thread scoped (no items, no proposed) | Task 2 regression | placeholder still fires (unchanged) — W2 will remove it | placeholder card (known, tracked) |

No silent-failure critical gaps: every path either has a test + explicit `null` fallback, or is an existing tracked item (the empty-thread placeholder → W2).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found → fixed | 1 correctness gap (D1 task dedup) fixed; test pyramid completed (unit + integration + contract + E2E); 1 code-quality note (reuse capture helper) |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX | 0 | — | UI surface is the existing Crew Board (no new UI) |

- **UNRESOLVED:** none.
- **CRITICAL GAPS:** 0 (the one silent-duplicate risk, D1, is fixed + tested).
- **VERDICT:** ENG CLEARED — architecture locked (Path B in-place fix), correctness gap (D1) fixed, full test pyramid in plan (unit + integration + contract + Playwright E2E per D15). Ready to implement W1a.

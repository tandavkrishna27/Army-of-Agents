# Commander Human Context Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Commander resolve a natural-language human query into full human context when there is exactly one match, while preserving explicit `userId` reads and candidate-only responses for ambiguous matches.

**Architecture:** Keep this Commander/internal-agent-only and read-only. Extend `query_human_context` so callers can pass either `userId` or `q`; the tool uses the existing `humanDiscovery` service for query resolution and the existing `humanContext` service for full context reads. Do not add automatic task-context injection or external MCP exposure in this sprint.

**Tech Stack:** TypeScript, Express/internal-agent tools, shared contracts, Vitest, Playwright Commander UI E2E.

---

## Locked Product Decisions

- `find_humans` remains the broad discovery tool.
- `query_human_context` supports direct mode with `userId`.
- `query_human_context` supports resolve mode with `q`.
- If resolve mode finds exactly one result, return full context automatically.
- If resolve mode finds multiple results, return candidates only and do not guess.
- If resolve mode finds no results, return a clean no-match response.
- If both `userId` and `q` are provided, `userId` wins.
- This remains Commander/internal-agent-only for now.

## Task 1: Shared Tool Result Types

**Files:**
- Modify: `packages/shared/src/types/team.ts`
- Modify: `packages/shared/src/types/index.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/team-profile-schema.test.ts`

- [ ] **Step 1: Write failing shared type contract tests**

Add compile/runtime shape tests for a direct result and a multi-match result:

```ts
const directResult: HumanContextResolutionResult = {
  mode: "direct_context",
  query: null,
  selectedHuman: null,
  candidates: [],
  bundle: humanContextBundle,
};
expect(directResult.mode).toBe("direct_context");

const multipleResult: HumanContextResolutionResult = {
  mode: "multiple_matches",
  query: "security",
  selectedHuman: null,
  candidates: [humanSearchResult],
  bundle: null,
};
expect(multipleResult.bundle).toBeNull();
```

- [ ] **Step 2: Run focused shared tests and verify failure**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
```

Expected: fails because `HumanContextResolutionResult` does not exist.

- [ ] **Step 3: Add shared result types**

Add:

```ts
export type HumanContextResolutionMode =
  | "direct_context"
  | "resolved_context"
  | "multiple_matches"
  | "no_match";

export interface HumanContextResolutionResult {
  mode: HumanContextResolutionMode;
  query: string | null;
  selectedHuman: HumanSearchResult | null;
  candidates: HumanSearchResult[];
  bundle: HumanContextBundle | null;
}
```

- [ ] **Step 4: Export shared result types**

Export `HumanContextResolutionMode` and `HumanContextResolutionResult` through the shared type barrels.

- [ ] **Step 5: Verify focused shared tests pass**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
```

Expected: PASS.

## Task 2: Query Human Context Tool Resolution

**Files:**
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Test: `server/src/__tests__/query-human-context-tool.test.ts`

- [ ] **Step 1: Write failing tool tests**

Add tests covering:

- direct `userId` returns `mode: "direct_context"` and bundle
- `q` with one discovery result calls `humanContext.getBundle` and returns `mode: "resolved_context"`
- `q` with multiple discovery results returns `mode: "multiple_matches"` and does not call `getBundle`
- `q` with no discovery results returns `mode: "no_match"` and does not call `getBundle`
- both `userId` and `q` uses direct `userId`
- neither input fails clearly

- [ ] **Step 2: Run focused tool tests and verify failure**

Run:

```bash
pnpm test:run server/src/__tests__/query-human-context-tool.test.ts
```

Expected: fails because the tool requires only `userId` and does not return resolution modes.

- [ ] **Step 3: Implement direct and resolve modes**

Change tool parameters to:

```ts
properties: {
  userId: { type: "string", description: "Human user id to read. Wins when both userId and q are provided." },
  q: { type: "string", description: "Natural-language query to resolve to a human when userId is unknown." },
  limit: { type: "number", description: "Candidate limit for query resolution, default 5, max 10" }
}
```

Execution behavior:

```ts
const raw = (params ?? {}) as Record<string, unknown>;
const userId = typeof raw.userId === "string" ? raw.userId.trim() : "";
const q = typeof raw.q === "string" ? raw.q.trim() : "";
const limit = typeof raw.limit === "number" ? Math.min(Math.max(Math.floor(raw.limit), 1), 10) : 5;

if (userId) {
  const bundle = await ctx.services.humanContext.getBundle(ctx.companyId, userId, ctx.userId ?? null);
  return { success: true, data: { mode: "direct_context", query: null, selectedHuman: null, candidates: [], bundle }, summary: `Human context loaded for ${display}` };
}

if (!q) {
  return { success: false, error: "userId or q is required", data: null, summary: "Missing human context target" };
}

const discovery = await ctx.services.humanDiscovery.search(ctx.companyId, { q, role: "all", limit });
if (discovery.results.length === 0) {
  return { success: true, data: { mode: "no_match", query: discovery.query, selectedHuman: null, candidates: [], bundle: null }, summary: `No humans found for "${discovery.query}"` };
}
if (discovery.results.length > 1) {
  return { success: true, data: { mode: "multiple_matches", query: discovery.query, selectedHuman: null, candidates: discovery.results, bundle: null }, summary: `Found ${discovery.results.length} possible humans for "${discovery.query}"` };
}
const selectedHuman = discovery.results[0];
const bundle = await ctx.services.humanContext.getBundle(ctx.companyId, selectedHuman.userId, ctx.userId ?? null);
return { success: true, data: { mode: "resolved_context", query: discovery.query, selectedHuman, candidates: discovery.results, bundle }, summary: `Resolved "${discovery.query}" to ${display}` };
```

- [ ] **Step 4: Verify focused tool tests pass**

Run:

```bash
pnpm test:run server/src/__tests__/query-human-context-tool.test.ts
```

Expected: PASS.

## Task 3: Commander UI E2E

**Files:**
- Create: `tests/e2e/commander-human-context-resolution.spec.ts`

- [ ] **Step 1: Write failing E2E**

Flow:

1. Seed company and current user.
2. Write a unique phrase to the current human's `skills.md`.
3. Open the company Commander UI.
4. Ask Commander: `Which human can handle <unique phrase>?`
5. Verify the response names the seeded human or includes the unique capability context.

- [ ] **Step 2: Run focused E2E and verify failure**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e commander-human-context-resolution.spec.ts
```

Expected: fails until the tool supports query resolution or until the E2E targets the correct Commander UI affordance.

- [ ] **Step 3: Make E2E pass without adding task injection**

Only use Commander tool calling; do not inject human context into task runs automatically.

- [ ] **Step 4: Verify focused E2E passes**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e commander-human-context-resolution.spec.ts
```

Expected: PASS.

## Task 4: Verification

**Files:** all changed files.

- [ ] **Step 1: Run focused verification**

Run:

```bash
pnpm --filter @armyofagents/shared test -- team-profile-schema.test.ts
pnpm test:run server/src/__tests__/query-human-context-tool.test.ts server/src/__tests__/query-tools.test.ts server/src/__tests__/tool-registry.test.ts
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e commander-human-context-resolution.spec.ts
```

- [ ] **Step 2: Run repository verification**

Run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass.

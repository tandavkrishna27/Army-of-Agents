# Porting1.1 Residual Cleanup Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every test failure, drift item, and spawned-followup that the Paperclip → AoA rename branch (`Porting1.1`) intentionally left for a follow-up branch, so the next release ships with a fully green test suite and no known correctness gaps from the rename.

**Architecture:** One sequential branch (`cleanup/2026-04-26`) off `Porting1.1`, organized as twelve independent task units. Tasks are ordered cheapest-and-most-isolated-first so each can ship as its own commit. Tasks 2–3 introduce a shared drizzle-orm mock helper that the rest of the server tests reuse — every later task that imports from `@armyofagents/db` should switch to that helper. Phase 6 (Hermes wire fields) stays deferred and gets a documented decision lock instead of code.

**Tech Stack:** TypeScript (server, UI, CLI), Vitest + `@testing-library/react`, Playwright, Drizzle ORM (Postgres + embedded-pg in tests), pnpm workspaces.

---

## Test Strategy — how we know nothing broke

Every task ends with the same three gates green for the file(s) it touched:

| Gate | Command |
|---|---|
| **Targeted unit/contract test** | `pnpm --filter @armyofagents/server exec vitest run <file>` or UI/CLI equivalent |
| **Typecheck** | `pnpm typecheck` |
| **Brand-check CI guards 1–9** | `pnpm exec node scripts/brand-check.mjs` (mirrors `.github/workflows/pr.yml`) |

After **all** tasks land, run the full suite once before opening the PR:

```sh
pnpm test:run            # unit + contract
pnpm test:e2e            # Playwright e2e
pnpm test:release-smoke  # auth + onboarding against built server
```

**Rollback safety:** Each task is its own commit. Reverting any single commit only loses that task's value — no shared state between tasks except Tasks 2 → 3 (helper added in 2, consumed in 3+).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `server/src/__tests__/helpers/drizzle-mock.ts` | **Create** | Shared Proxy/symbol mock factory for `@armyofagents/db` + `drizzle-orm` operators. Replaces inline copies in 8+ test files. |
| `server/src/__tests__/helpers/__tests__/drizzle-mock.test.ts` | **Create** | Unit tests for the helper. |
| `server/src/__tests__/embedding-retry-persistence.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/semantic-search.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/v2-memory-qa.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/memory-suggestions.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/debrief-redirect.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/discussions-routes-contract.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/routines-routes-contract.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/routines-service.test.ts` | **Modify** | Switch to shared helper. |
| `server/src/__tests__/cli-mode.test.ts` | **Modify** | Mock `which` lookup so "CLI tool not found" stops failing. |
| `server/src/__tests__/env-compat-mirror.test.ts` | **Create** | Followup #1 — Verify `mirrorAoaEnv` only mirrors when target unset; verify `readAoaEnv` fallback order. |
| `server/src/routes/issues.ts` | **Modify** | Followup #4 — return typed 422 with `fieldError` shape when `assigneeId` / `projectId` reference a missing row (mirrors NewIssueDialog UI fix). |
| `server/src/__tests__/issues-create-fk-422.test.ts` | **Create** | Followup #4 — assert 422 + `{ field, code: "stale_reference" }` body. |
| `ui/src/__tests__/AgentsTab.test.tsx` | **Modify** | Drop "Claude API" assertion (Sprint 2A removed the API adapter). |
| `tests/e2e/onboarding.spec.ts` | **Modify** | Use a per-test API-bootstrapped DB nuke / use-existing-company gate so the wizard pre-condition holds. |
| `tests/e2e/mcp-key-flow.spec.ts` | **Modify** | Fix the two failing tests (investigation in Task 6). |
| `ui/src/__tests__/ProjectDetail*.test.tsx` | **Modify** | Add per-test cleanup so global mocks/state don't leak. |
| `docs/aoa/reference/decisions.md` | **Modify** | Append Decision #92 "Defer Phase 6 Hermes wire-field rename". |
| `docs/superpowers/plans/2026-04-26-localstorage-stale-fk-audit.md` | **Create** | Followup #3 audit notes. Output of the audit, not its execution — the actual fixes spin off from this. |
| `scripts/find-dead-paperclip-filters.mjs` | **Create** | Followup #2 — codemod-style audit script; emits a JSON report of dead `[paperclip]` log-prefix filter sites (consumers that no longer match anything because the prefix was renamed in commit 97eeddc). |

---

## Task 1: Fix AgentsTab Sprint 2A "Claude API" assertion

**Why:** Sprint 2A (Decision #91) removed the API-mode adapters (`claude_api`, `openai_api`, `gemini_api`). The agent factory in this test still calls `makeAgentList()` which probably built one with `adapter.type === "claude_api"`. The render no longer surfaces that adapter label, so the assertion at line 179 always misses. Test-only fix.

**Files:**
- Modify: `ui/src/__tests__/AgentsTab.test.tsx:178-180`

- [ ] **Step 1: Confirm the failure mode**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/AgentsTab.test.tsx`

Expected: FAIL on `expect(screen.getByText("Claude API")).toBeInTheDocument();` with "Unable to find an element with the text: Claude API".

- [ ] **Step 2: Inspect `makeAgentList()` to find what's actually rendered**

Read `ui/src/__tests__/AgentsTab.test.tsx` from the top through the `makeAgentList` definition. Confirm Alice's adapter type is `claude_api` (or similar) and Bob's is `claude_local`. The test renders both rows but only Bob's adapter label shows up post-Sprint-2A because `claude_api` is no longer a registered adapter.

- [ ] **Step 3: Update the test fixture and assertions**

Two valid fixes — pick (a) unless changing the fixture breaks adjacent assertions, in which case use (b):

(a) Change Alice's adapter to a still-supported one (e.g. `codex_local`) and update the assertion:

```ts
// In makeAgentList(): change Alice's adapter:
adapter: { type: "codex_local", config: {} },
// ...
// Line 178-180 assertions:
expect(screen.getByText("Codex (local)")).toBeInTheDocument();
expect(screen.getByText("Claude (local)")).toBeInTheDocument();
```

(b) Drop the line and add a comment:

```ts
// (Sprint 2A removed claude_api — Alice now has no adapter-label assertion.)
expect(screen.getByText("Claude (local)")).toBeInTheDocument();
```

Verify the chosen label string by reading `ui/src/components/AgentsTab.tsx` for how `agent.adapter.type` is rendered (probably a `formatAdapterLabel()` switch).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/AgentsTab.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add ui/src/__tests__/AgentsTab.test.tsx
git commit -m "test(ui): fix AgentsTab Sprint 2A — drop claude_api assertion"
```

---

## Task 2: Create shared drizzle-orm mock helper

**Why:** Eight or more server tests carry near-identical inline mocks for `@armyofagents/db` and `drizzle-orm`. The pattern is a Proxy that returns lazily-created Symbols for table columns plus stub strings for operators. When schema changes land, every copy drifts. A shared helper means one source of truth.

**Files:**
- Create: `server/src/__tests__/helpers/drizzle-mock.ts`
- Create: `server/src/__tests__/helpers/__tests__/drizzle-mock.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `server/src/__tests__/helpers/__tests__/drizzle-mock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "../drizzle-mock.js";

describe("makeTableProxy", () => {
  it("returns a stable symbol per column accessed", () => {
    const t = makeTableProxy("users");
    expect(t.id).toBe(t.id);
    expect(t.email).toBe(t.email);
    expect(t.id).not.toBe(t.email);
  });

  it("exposes the table name on the underscore key (drizzle convention)", () => {
    const t = makeTableProxy("users");
    expect((t as unknown as { _: { name: string } })._.name).toBe("users");
  });

  it("returns an empty object for $inferSelect / $inferInsert", () => {
    const t = makeTableProxy("users");
    expect((t as unknown as { $inferSelect: object }).$inferSelect).toEqual({});
    expect((t as unknown as { $inferInsert: object }).$inferInsert).toEqual({});
  });
});

describe("drizzleOperatorStubs", () => {
  it("returns string sentinels for and/eq/isNull/inArray/desc/asc", () => {
    const ops = drizzleOperatorStubs();
    expect(ops.and()).toBe("and");
    expect(ops.eq()).toBe("eq");
    expect(ops.isNull()).toBe("isNull");
    expect(ops.inArray()).toBe("inArray");
    expect(ops.desc()).toBe("desc");
    expect(ops.asc()).toBe("asc");
  });

  it("provides an sql template tag that returns a string sentinel", () => {
    const ops = drizzleOperatorStubs();
    // Both call form and tagged-template form must work.
    expect((ops.sql as unknown as () => string)()).toBe("sql");
    expect((ops.sql as unknown as (s: TemplateStringsArray) => string)`SELECT 1`).toBe("sql");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/helpers/__tests__/drizzle-mock.test.ts`

Expected: FAIL — module `../drizzle-mock` does not exist.

- [ ] **Step 3: Write the helper implementation**

Create `server/src/__tests__/helpers/drizzle-mock.ts`:

```ts
/**
 * Shared drizzle-orm + @armyofagents/db mock helpers for server tests.
 *
 * Why this exists: importing real schema or real drizzle-orm into Vitest
 * triggers an ESM circular-dependency warning that resolves into runtime
 * `undefined` values. Tests work around this by Proxy-ing every accessed
 * column to a fresh Symbol and stubbing operators as plain strings. This
 * file extracts that pattern so every test gets the same shape.
 *
 * Usage in a test file:
 *
 *   vi.mock("@armyofagents/db", async () => ({
 *     memoryItems: makeTableProxy("memory_items"),
 *     issues: makeTableProxy("issues"),
 *   }));
 *   vi.mock("drizzle-orm", () => drizzleOperatorStubs());
 */

export function makeTableProxy(name: string): Record<string, unknown> {
  const cols: Record<string, symbol> = {};
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "_") return { name };
      if (prop === "$inferSelect" || prop === "$inferInsert") return {};
      if (typeof prop === "string") {
        if (!cols[prop]) cols[prop] = Symbol(prop);
        return cols[prop];
      }
      return undefined;
    },
  });
}

type OperatorStubs = {
  and: (...args: unknown[]) => string;
  or: (...args: unknown[]) => string;
  eq: (...args: unknown[]) => string;
  ne: (...args: unknown[]) => string;
  isNull: (...args: unknown[]) => string;
  isNotNull: (...args: unknown[]) => string;
  inArray: (...args: unknown[]) => string;
  notInArray: (...args: unknown[]) => string;
  gt: (...args: unknown[]) => string;
  gte: (...args: unknown[]) => string;
  lt: (...args: unknown[]) => string;
  lte: (...args: unknown[]) => string;
  like: (...args: unknown[]) => string;
  ilike: (...args: unknown[]) => string;
  desc: (...args: unknown[]) => string;
  asc: (...args: unknown[]) => string;
  sql: unknown;
};

export function drizzleOperatorStubs(): OperatorStubs {
  const sqlProxy = new Proxy(() => "sql", {
    get: () => () => "sql",
    apply: () => "sql",
  });
  return {
    and: () => "and",
    or: () => "or",
    eq: () => "eq",
    ne: () => "ne",
    isNull: () => "isNull",
    isNotNull: () => "isNotNull",
    inArray: () => "inArray",
    notInArray: () => "notInArray",
    gt: () => "gt",
    gte: () => "gte",
    lt: () => "lt",
    lte: () => "lte",
    like: () => "like",
    ilike: () => "ilike",
    desc: () => "desc",
    asc: () => "asc",
    sql: sqlProxy,
  };
}

/**
 * Convenience factory: returns an object with a `select`/`insert`/`update`/`delete`
 * stub where each call resolves to the next pre-configured result.
 *
 * Use when a service-under-test calls db.select().from(...).where(...) twice
 * and you want each call to return a different array.
 */
export function createSequenceDb(results: unknown[][]): {
  select: () => { from: () => { where: () => Promise<unknown[]> } };
  __remaining: () => number;
} {
  const queue = [...results];
  const next = (): Promise<unknown[]> => {
    const r = queue.shift();
    if (!r) throw new Error("createSequenceDb: ran out of pre-configured results");
    return Promise.resolve(r);
  };
  return {
    select: () => ({ from: () => ({ where: () => next() }) }),
    __remaining: () => queue.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/helpers/__tests__/drizzle-mock.test.ts`

Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```sh
git add server/src/__tests__/helpers/drizzle-mock.ts server/src/__tests__/helpers/__tests__/drizzle-mock.test.ts
git commit -m "test(server): add shared drizzle-orm mock helper"
```

---

## Task 3: Migrate failing drizzle-cycle tests to the shared helper

**Why:** Eight server tests fail with "Cannot read properties of undefined" or similar drizzle-orm ESM cycle symptoms. They each have a slightly different inline mock; some are missing operators the test file's code path now uses. Migrating them to the shared helper unblocks all eight in one pass.

**Files (one sub-task per file — commit after each):**
1. `server/src/__tests__/embedding-retry-persistence.test.ts`
2. `server/src/__tests__/semantic-search.test.ts`
3. `server/src/__tests__/v2-memory-qa.test.ts`
4. `server/src/__tests__/memory-suggestions.test.ts`
5. `server/src/__tests__/debrief-redirect.test.ts`
6. `server/src/__tests__/discussions-routes-contract.test.ts`
7. `server/src/__tests__/routines-routes-contract.test.ts`
8. `server/src/__tests__/routines-service.test.ts`

For **each** file, repeat steps 1–5 below.

- [ ] **Step 1: Run the failing test to capture the error message**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/<file>.test.ts`

Expected: FAIL — note exactly which symbol is undefined or which operator is missing. This tells you what to add to the per-table mock list in step 3.

- [ ] **Step 2: Find the existing inline mock block**

Search the file for `vi.mock("@armyofagents/db"` and `vi.mock("drizzle-orm"`. There will be a `makeTable` (or similar) function defined inline plus a list of tables. Note the table names.

- [ ] **Step 3: Replace the inline mock with the shared helper**

Replace this kind of block:

```ts
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => { /* ... */ };
  return {
    memoryItems: makeTable("memory_items"),
    issues: makeTable("issues"),
  };
});
vi.mock("drizzle-orm", () => ({
  and: () => "and",
  eq: () => "eq",
  /* ... */
}));
```

With:

```ts
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  issues: makeTableProxy("issues"),
  // ...all tables the original mock had, plus any the test now references
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
```

If the test uses `createSequenceDb` (or an equivalent inline helper), import that from the same module too:

```ts
import { createSequenceDb } from "./helpers/drizzle-mock.js";
```

If the original inline mock had **additional** stubs the helper doesn't ship (e.g. a custom `count()`), keep them as a spread override:

```ts
vi.mock("drizzle-orm", () => ({ ...drizzleOperatorStubs(), count: () => "count" }));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/<file>.test.ts`

Expected: PASS.

If still failing with a missing-operator error, add the operator to `drizzleOperatorStubs()` in the helper (extend `OperatorStubs` type accordingly, run the helper test to make sure it still passes, then re-run this test).

- [ ] **Step 5: Commit**

```sh
git add server/src/__tests__/<file>.test.ts
git commit -m "test(server): migrate <file> to shared drizzle mock"
```

After all eight files migrate, run the full server suite once:

```sh
pnpm --filter @armyofagents/server test:run
```

Expected: every previously-failing-with-drizzle-cycle test now passes. If a test still fails, the failure is a real bug (or unrelated) — open a separate task, don't roll the migration back.

---

## Task 4: Fix `cli-mode.test.ts` "CLI tool not found"

**Why:** One of the cli-mode tests spawns a child process and calls `which claude` (or similar) to resolve the CLI binary. CI runners don't have `claude` on PATH. The mock for `node:child_process` in the file mocks `execSync` and `spawn` but the test still hits a real PATH lookup somewhere — likely a `which` call inside `cli-mode-service` that bypasses the mock.

**Files:**
- Modify: `server/src/__tests__/cli-mode.test.ts`

- [ ] **Step 1: Reproduce and identify the un-mocked call**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/cli-mode.test.ts`

Expected: FAIL on the test that says "CLI tool not found". Read the stack trace — note which file/line in `server/src/services/internal-agent/cli-mode/` does the lookup. It probably uses `which` from `node:child_process` (`execSync("which claude")`) or `command-exists` package.

- [ ] **Step 2: Read the production lookup code**

Open whichever file the trace points at (likely `cli-mode-service.ts` or a sibling like `cli-binary-resolver.ts`). Find the function that resolves the binary path. Confirm whether it uses `execSync` from `child_process` (in which case the existing mock should cover it but probably returns `""` instead of a path) or a package mock like `command-exists`.

- [ ] **Step 3: Add the missing mock return value**

If `execSync` is the call site, extend the existing mock to return a non-empty path for `which` invocations:

```ts
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === "string" && cmd.startsWith("which ")) {
      return "/usr/local/bin/claude\n";
    }
    return "";
  }),
  spawn: vi.fn(),
}));
```

Or, if a different package does the lookup, mock that package directly above the existing `vi.mock` block:

```ts
vi.mock("command-exists", () => ({
  default: vi.fn(async () => true),
  sync: vi.fn(() => "/usr/local/bin/claude"),
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/cli-mode.test.ts`

Expected: PASS — all tests including "CLI tool not found".

- [ ] **Step 5: Commit**

```sh
git add server/src/__tests__/cli-mode.test.ts
git commit -m "test(server): mock CLI binary lookup in cli-mode tests"
```

---

## Task 5: Fix e2e onboarding wizard pre-condition

**Why:** `tests/e2e/onboarding.spec.ts` loads `/` and expects the OnboardingWizard to auto-open because there are zero companies in the DB. CI passes when the DB is fresh; the test fails locally and on re-runs because previous runs left companies behind. Need a cleanup hook so the pre-condition holds every run.

**Files:**
- Modify: `tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Reproduce the failure**

Run: `pnpm test:e2e -- onboarding.spec.ts`

If it passes on a fresh DB, run it twice in a row — second run should fail because the `E2E-Test-<timestamp>` company from the first run leaves the company list non-empty (the wizard now does NOT auto-open on `/` because `NoCompaniesStartPage` only renders when `companies.length === 0`).

- [ ] **Step 2: Read the existing setup pattern**

Look at `tests/e2e/playwright.config.ts` (or similar) for any pre-test hook that nukes the DB. AoA's e2e probably uses an in-memory or test-scoped embedded-pg per worker. If there's no DB-reset hook, the test must reset state itself.

- [ ] **Step 3: Add a `test.beforeEach` that purges companies via the API**

Update `tests/e2e/onboarding.spec.ts` so the describe block looks like:

```ts
test.describe("Onboarding wizard", () => {
  test.beforeEach(async ({ request }) => {
    // Pre-condition: zero companies in DB so NoCompaniesStartPage renders.
    // Use the local-board admin endpoint to delete any leftover test companies.
    const res = await request.get("/api/companies");
    if (!res.ok()) return; // server might not be up yet — first test will fail loudly
    const companies = (await res.json()) as Array<{ id: string; name: string }>;
    for (const c of companies) {
      // Only delete obvious test artifacts. Be defensive: a dev who runs e2e
      // against a real DB shouldn't lose their work.
      if (!/^E2E-(Test|MCP)-/.test(c.name)) continue;
      await request.delete(`/api/companies/${c.id}`);
    }
  });

  test("opens on first run and advances past step 1", async ({ page }) => {
    // ... existing body unchanged
  });

  // ... rest unchanged
});
```

If `DELETE /api/companies/:id` doesn't exist (check `server/src/routes/companies.ts`), file a separate task — for this PR, replace the `for...of` body with a route that already exists (e.g. `POST /api/test-utils/reset` if there's a test-only endpoint) or open an issue and `test.skip` the whole describe with a TODO comment.

- [ ] **Step 4: Re-run twice in a row to confirm idempotency**

Run twice: `pnpm test:e2e -- onboarding.spec.ts && pnpm test:e2e -- onboarding.spec.ts`

Expected: both runs PASS.

- [ ] **Step 5: Commit**

```sh
git add tests/e2e/onboarding.spec.ts
git commit -m "test(e2e): purge leftover E2E companies before each onboarding test"
```

---

## Task 6: Investigate and fix two failing `mcp-key-flow.spec.ts` tests

**Why:** Two of three tests in this file fail. The "401 unauth" test passes (it doesn't depend on prior state). The two failing tests are "founder issues key, calls me tool, receives own identity" and one we haven't named — probably a sibling Playwright generated. Investigate first because the cause isn't obvious from the summary.

**Files:**
- Modify: `tests/e2e/mcp-key-flow.spec.ts`

- [ ] **Step 1: Reproduce and capture failure output**

Run: `pnpm test:e2e -- mcp-key-flow.spec.ts --reporter=list`

Capture which two tests fail and their error messages. Three likely root causes:

1. **DB state pollution:** `createCompany()` uses `POST /api/companies` with no auth → succeeds in `local_trusted` mode but might 401 in `cloud_auth` test mode. Check the test's run mode.
2. **Missing `local-board` actor** in MCP route: the `me` tool call uses Bearer token but the issued key might not actually authenticate against the test server's MCP route — check `server/src/mcp/server.ts:146` for the `mcp` actor branch and verify the test's token shape matches what the route expects.
3. **DELETE /api/companies/:id missing or 404** (same as Task 5) — but here the test creates with a fresh `Date.now()` name so old rows shouldn't matter.

- [ ] **Step 2: Pinpoint the failure surface**

For each failing test, reproduce in isolation:

```sh
pnpm test:e2e -- mcp-key-flow.spec.ts -g "founder issues key"
```

Read the assertion that fails. Three diagnostic checks in order:
- (a) Does `createCompany` return a 201? If not, the company-creation route changed shape.
- (b) Does `issueMcpKey` return a 201 with a `token` field? If not, `mcpSvc.createKey()` response shape changed.
- (c) Does the `me` tool call return 200 with `body.error === undefined`? If not, the MCP route is rejecting the Bearer token.

- [ ] **Step 3: Fix the failing surface**

Apply **only** the fix(es) the diagnostic actually proves. Common fixes:

(a) If `POST /api/companies` requires auth and the test is missing it, add the local-board cookie or skip-auth header that other e2e specs use. Find the pattern in `tests/e2e/onboarding.spec.ts` (which presumably does work).

(b) If `issueMcpKey` returns the token under `body.key.token` not `body.token`, update the spec's optional-chain to match (the spec already does `body.token ?? body.key?.token` so this is unlikely).

(c) If the `me` tool call returns `error: { code: -32001, message: "Unauthorized" }`, the Bearer token isn't matching `mcp_api_keys`. Most likely cause: the token in the response is the hashed value, not the plaintext. Read `server/src/services/mcp.ts` for `createKey` — find which field of the response is the plaintext token returned exactly once. Update the test's destructuring to read that field.

Do **not** broadly rewrite the test. Make the smallest correctness fix for each failure.

- [ ] **Step 4: Re-run and verify**

Run: `pnpm test:e2e -- mcp-key-flow.spec.ts`

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```sh
git add tests/e2e/mcp-key-flow.spec.ts
git commit -m "test(e2e): fix mcp-key-flow auth + token-field shape"
```

---

## Task 7: Stabilize `ProjectDetail*` test isolation

**Why:** Multiple `ProjectDetail*.test.tsx` (likely `ProjectDetail.test.tsx`, `ProjectDetailMobile.test.tsx`, `ProjectDetailHeader.test.tsx`) flake — passing in isolation, failing in a full run. Cause: shared mocked module state (e.g. a `vi.mock("@/api/projects")` whose mock fn isn't reset) or a global query cache that survives across tests.

**Files:**
- Modify: each `ui/src/__tests__/ProjectDetail*.test.tsx` that flakes (locate via Step 1)

- [ ] **Step 1: Identify the flaky files**

Run the UI suite three times in a row and record which files fail at least once:

```sh
for i in 1 2 3; do pnpm --filter @armyofagents/ui test:run --testPathPattern="ProjectDetail" --reporter=verbose; done
```

(On Windows PowerShell: `1..3 | ForEach-Object { pnpm --filter @armyofagents/ui test:run --testPathPattern="ProjectDetail" --reporter=verbose }`.)

Note the failing test names. Common symptoms: assertions on a query result that "leaked" from a prior test, or a mocked function returning the previous test's return value.

- [ ] **Step 2: Add `beforeEach` cleanup**

For each flaky file, add (or extend) a top-level `beforeEach`:

```ts
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "@testing-library/react";

beforeEach(() => {
  vi.clearAllMocks();
  // If the file uses a per-test QueryClient, reset it here:
  // queryClient.clear();
});

afterEach(() => {
  cleanup(); // RTL @testing-library/react auto-cleanup; explicit is safer
});
```

If the file imports a QueryClient from a shared `test-utils`, replace the import with a per-test factory:

```ts
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}
```

…and instantiate it inside each `it(...)` block.

- [ ] **Step 3: Re-run three times to confirm stability**

```sh
for i in 1 2 3; do pnpm --filter @armyofagents/ui test:run --testPathPattern="ProjectDetail"; done
```

Expected: 3/3 PASS.

- [ ] **Step 4: Commit**

```sh
git add ui/src/__tests__/ProjectDetail*.test.tsx
git commit -m "test(ui): per-test cleanup for ProjectDetail* suites"
```

---

## Task 8: Followup #1 — env-compat unit tests

**Why:** `server/src/env-compat.ts` mirrors `PAPERCLIP_*` → `AOA_*` at module load with a "don't clobber" rule and exposes `readAoaEnv` with fallback. There are no tests pinning that contract — if a future refactor flips the precedence, every Paperclip-era operator's env file silently breaks. The `loving-taussig-d53441` worktree already has a draft test (`server/src/__tests__/env-compat-mirror.test.ts`); bring it into `Porting1.1` cleanup.

**Files:**
- Create: `server/src/__tests__/env-compat-mirror.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/env-compat-mirror.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";

describe("env-compat", () => {
  // env-compat runs its mirror once at module load. Use vi.resetModules()
  // in each test so we get a fresh evaluation.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Strip every PAPERCLIP_ / AOA_ key so each test sets exactly what it needs.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("PAPERCLIP_") || k.startsWith("AOA_")) delete process.env[k];
    }
    // Also clear the require cache so the mirror runs again on import.
    // Vitest's vi.resetModules() handles this.
  });

  it("mirrors PAPERCLIP_FOO into AOA_FOO when AOA_FOO is unset", async () => {
    process.env.PAPERCLIP_FOO = "bar";
    const { default: _ } = await import("../env-compat.js");
    void _;
    expect(process.env.AOA_FOO).toBe("bar");
  });

  it("does NOT overwrite AOA_FOO when both are set", async () => {
    process.env.PAPERCLIP_FOO = "from-paperclip";
    process.env.AOA_FOO = "from-aoa";
    await import("../env-compat.js");
    expect(process.env.AOA_FOO).toBe("from-aoa");
  });

  it("readAoaEnv prefers AOA_FOO over PAPERCLIP_FOO", async () => {
    process.env.AOA_FOO = "aoa-value";
    process.env.PAPERCLIP_FOO = "paperclip-value";
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("FOO")).toBe("aoa-value");
  });

  it("readAoaEnv falls back to PAPERCLIP_FOO when AOA_FOO is unset", async () => {
    process.env.PAPERCLIP_FOO = "paperclip-value";
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("FOO")).toBe("paperclip-value");
  });

  it("readAoaEnv returns undefined when neither is set", async () => {
    const { readAoaEnv } = await import("../env-compat.js");
    expect(readAoaEnv("ABSENT_KEY")).toBeUndefined();
  });
});
```

Note: each `await import` triggers the mirror anew because Vitest isolates modules per test by default. If they collapse into a single shared module instance, prefix each test body with `vi.resetModules();`.

- [ ] **Step 2: Run test to verify it passes**

The implementation already exists — these tests should pass on first run. Run:

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/env-compat-mirror.test.ts
```

Expected: PASS — 5/5.

If a test fails because the mirror didn't run, add `vi.resetModules()` to `beforeEach`. If `readAoaEnv` doesn't behave as the tests assert, **fix the test, not the implementation** — the implementation matches the documented contract.

- [ ] **Step 3: Commit**

```sh
git add server/src/__tests__/env-compat-mirror.test.ts
git commit -m "test(server): pin env-compat mirror + readAoaEnv contract"
```

---

## Task 9: Followup #2 — audit dead `[paperclip]` log-prefix filters

**Why:** Commit `97eeddc` renamed the log prefix from `[paperclip]` → `[aoa]` in adapters and scripts. Any consumer that *filters* logs by `[paperclip]` (alerting rules, log-shipper greps, dev scripts, runbook docs) is now silently dead. We need an audit, not a fix — fixes spin off into deployment-config tickets.

**Files:**
- Create: `scripts/find-dead-paperclip-filters.mjs`

- [ ] **Step 1: Write the audit script**

Create `scripts/find-dead-paperclip-filters.mjs`:

```js
#!/usr/bin/env node
/**
 * Audit: where does the codebase still filter for the legacy "[paperclip]"
 * log prefix? Anything that matches is now dead — adapters and scripts emit
 * "[aoa]" since commit 97eeddc.
 *
 * Output: JSON to stdout with { file, line, snippet } for each match.
 * Allow-list: docs that document the rename itself (the rename plan file
 * and the changelog) — they reference the old prefix as historical context.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PATTERN = /\[paperclip\]/i;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".claude",
  "data",
]);
const ALLOW_LIST_PATTERNS = [
  /docs\/superpowers\/plans\/2026-04-25-paperclip-to-aoa-rename\.md$/,
  /docs\/aoa\/reference\/wire-compat\.md$/,
  /\.changeset\/v1-0-0-rc-4-polish-batch\.md$/,
  /scripts\/find-dead-paperclip-filters\.mjs$/, // self
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile()) out.push(p);
  }
  return out;
}

const findings = [];
for (const path of walk(ROOT)) {
  if (ALLOW_LIST_PATTERNS.some((rx) => rx.test(path.replaceAll("\\", "/")))) continue;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue; // binary / unreadable
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) {
      findings.push({
        file: path.slice(ROOT.length + 1).replaceAll("\\", "/"),
        line: i + 1,
        snippet: lines[i].trim().slice(0, 200),
      });
    }
  }
}

process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
process.exit(findings.length > 0 ? 0 : 0); // exit 0 — informational
```

- [ ] **Step 2: Run the audit and inspect output**

```sh
node scripts/find-dead-paperclip-filters.mjs > tmp-paperclip-filters.json
cat tmp-paperclip-filters.json
```

Expected: a JSON array. Three buckets to triage:

1. **Dev scripts / Makefile / runbook docs** — fix in this commit (rename `[paperclip]` → `[aoa]` or remove if dead).
2. **Test fixtures** — leave alone if they're testing the legacy parser; flag with a comment if they're hot for production.
3. **Operator-shipped configs** (Datadog, Splunk, k8s log-router) — out of scope; document in `docs/deploy/upgrade-guide.md` under "Update your log filters".

- [ ] **Step 3: Apply in-repo fixes**

For each item in bucket 1, edit the file:

```sh
# Example: scripts/tail-server-logs.sh probably has `grep '[paperclip]'`
# Update to `grep -E '\[(aoa|paperclip)\]'` (dual-match for one release)
```

Add a "## Log filter migration" section to `docs/deploy/upgrade-guide.md` listing every operator-side filter the audit found.

- [ ] **Step 4: Delete the temp file and commit**

```sh
rm tmp-paperclip-filters.json
git add scripts/find-dead-paperclip-filters.mjs docs/deploy/upgrade-guide.md <other touched files>
git commit -m "chore: audit dead [paperclip] log filters; document operator migration"
```

---

## Task 10: Followup #3 — localStorage stale-FK pattern audit

**Why:** The NewIssueDialog stale-draft bug had a clear fingerprint: rehydrate an entity-id from localStorage, send it to the server, get a 404 because the entity was deleted. Other dialogs/pages probably share the pattern. This task is an audit — produces a written list of suspect sites; fixes spin off per site.

**Files:**
- Create: `docs/superpowers/plans/2026-04-26-localstorage-stale-fk-audit.md`

- [ ] **Step 1: Locate every `localStorage.getItem(...)` callsite that hydrates an id**

```sh
# Find every UI getItem call:
pnpm exec node -e "console.log('search via Grep tool')"  # placeholder — use Grep tool
```

Actually use the Grep tool with pattern `localStorage\.getItem` filtered to `ui/src/**/*.{ts,tsx}`. For each match, read 5 lines of context and decide:

- Does the value get used as an `id` field in a request body or query? → **suspect, audit**.
- Is it a local-only flag (e.g. `sidebar-collapsed: "1"`)? → **safe, skip**.
- Is it a draft text body / preference? → **safe, skip**.

- [ ] **Step 2: Build the suspect list with severity**

Create `docs/superpowers/plans/2026-04-26-localstorage-stale-fk-audit.md` with this structure:

```markdown
# localStorage Stale-FK Audit

## Method

Searched `ui/src/**/*.{ts,tsx}` for `localStorage.getItem`. Filtered to callsites
where the rehydrated value is used as an entity id (assigneeId, projectId,
agentId, taskId, etc.) in either a request body or a query argument.

## Findings

| File:Line | Hydrated key | Used as | Risk | Mitigation |
|---|---|---|---|---|
| ui/src/components/NewIssueDialog.tsx:?? | aoa:issue-draft | assigneeId, projectId | Fixed in commit ??? | pruneStaleId helper |
| ... | ... | ... | ... | ... |

## Recommended next steps

For each High-risk row, open a separate task that:
1. Imports `pruneStaleId` from `ui/src/lib/issueDraft.ts`
2. Adds a useEffect that prunes after the relevant query resolves
3. Adds a unit test (mirror of issueDraft.test.ts) for the new callsite

## Patterns to keep watching

- New dialogs that persist drafts → add pruning as part of the dialog template
- Filter state with selected entity ids (e.g. "assigned to me" picker) — audit
  in the next sprint
```

Fill in the actual rows from the grep results.

- [ ] **Step 3: Commit the audit**

```sh
git add docs/superpowers/plans/2026-04-26-localstorage-stale-fk-audit.md
git commit -m "docs: localStorage stale-FK audit (followup to NewIssueDialog fix)"
```

The audit is the deliverable. Per-file fixes ship as separate tasks if any high-risk rows surface.

---

## Task 11: Followup #4 — typed 422 errors for stale FKs in `POST /issues`

**Why:** When NewIssueDialog sent a stale `assigneeId`, the server returned a 404 (or generic 500) with no structured body. The UI fix in commit `1e2fb50` added typed 422 handling on the server **for the create-issue route**. Verify it's wired and add a contract test pinning the response shape so future regressions are caught.

**Files:**
- Modify: `server/src/routes/issues.ts` (only if the typed 422 isn't there yet)
- Create: `server/src/__tests__/issues-create-fk-422.test.ts`

- [ ] **Step 1: Read the current create-issue route**

Open `server/src/routes/issues.ts` and find the `POST /` (or `POST /:companyId/issues`) handler. Look for FK validation on `assigneeId` and `projectId`. Confirm:

- (a) Both fields are validated against the live tables before insert, **or**
- (b) The DB-level FK error is caught and re-thrown as 422.

If neither is present, the UI's `fieldError` reading will silently degrade to a generic toast. Add (a) — explicit pre-check is friendlier than catching a Postgres error code.

- [ ] **Step 2: Write the failing contract test**

Create `server/src/__tests__/issues-create-fk-422.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  projects: makeTableProxy("projects"),
  issues: makeTableProxy("issues"),
  // ...add any other tables the create-issue handler reads
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

describe("POST /issues — FK validation 422", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 422 with field=assigneeId when assignee does not exist", async () => {
    // Arrange: db returns [] for the assignee lookup
    // (full setup depends on how routes/issues.ts queries — fill in once
    // you read the handler)
    const res = await callCreateIssue({
      title: "test",
      assigneeId: "agent-ghost",
      projectId: "proj-real",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      field: "assigneeId",
      code: "stale_reference",
    });
  });

  it("returns 422 with field=projectId when project does not exist", async () => {
    const res = await callCreateIssue({
      title: "test",
      assigneeId: "agent-real",
      projectId: "proj-ghost",
    });
    expect(res.status).toBe(422);
    expect((await res.json()).field).toBe("projectId");
  });

  it("returns 201 when both refs exist", async () => {
    const res = await callCreateIssue({
      title: "test",
      assigneeId: "agent-real",
      projectId: "proj-real",
    });
    expect(res.status).toBe(201);
  });
});

// Helper: wire up a supertest-style call to the issues router.
// Mirror the pattern used in routes-finance.test.ts or another route test.
async function callCreateIssue(body: Record<string, unknown>) {
  // ...fill in based on the codebase's existing route-test pattern
  throw new Error("implement");
}
```

Note: the actual `callCreateIssue` body depends on how other route tests in the repo wire `express`. Read `server/src/__tests__/routes-finance.test.ts` (or `routes-adapters.test.ts`) for the pattern and copy it.

- [ ] **Step 3: Run test to verify it fails**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/issues-create-fk-422.test.ts
```

Expected: FAIL — `callCreateIssue` throws "implement" (or, once implemented, the 422 contract isn't met because the route returns 404).

- [ ] **Step 4: Implement the typed 422 in the route**

If the handler doesn't already pre-validate, add this near the top of the create handler:

```ts
// Pre-validate FKs so the UI can show a typed field error.
if (body.assigneeId) {
  const exists = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, body.assigneeId))
    .limit(1);
  if (exists.length === 0) {
    return res.status(422).json({
      error: "Assignee does not exist",
      field: "assigneeId",
      code: "stale_reference",
    });
  }
}
if (body.projectId) {
  const exists = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, body.projectId))
    .limit(1);
  if (exists.length === 0) {
    return res.status(422).json({
      error: "Project does not exist",
      field: "projectId",
      code: "stale_reference",
    });
  }
}
// ...existing insert logic
```

If the validation already exists but uses a different shape (e.g. returns `{ errors: [...] }` array), reconcile: prefer the shape the UI's `ApiError.fieldError()` accessor already reads (commit `056e7fc`). If the UI accessor reads `{ field, code }`, the server must emit those keys.

- [ ] **Step 5: Run test to verify it passes**

```sh
pnpm --filter @armyofagents/server exec vitest run src/__tests__/issues-create-fk-422.test.ts
```

Expected: PASS — 3/3.

- [ ] **Step 6: Commit**

```sh
git add server/src/routes/issues.ts server/src/__tests__/issues-create-fk-422.test.ts
git commit -m "fix(issues): typed 422 + contract test for stale assignee/project FKs"
```

---

## Task 12: Document Phase 6 Hermes deferral

**Why:** Phase 6 of the rename plan (Hermes wire fields) was deliberately deferred — it requires upstream coordination with the Hermes adapter maintainer. Lock it as a decision so future agents don't re-pick it up without context.

**Files:**
- Modify: `docs/aoa/reference/decisions.md`

- [ ] **Step 1: Read the existing decisions file structure**

Open `docs/aoa/reference/decisions.md`, find the highest-numbered decision (Decision #91 per the CLAUDE.md context). Read the format (heading style, "Status / Date / Context / Decision / Consequences" template).

- [ ] **Step 2: Append Decision #92**

Add at the end of the file:

```markdown
## Decision #92 — Defer Phase 6 Hermes wire-field rename to upstream coordination

**Status:** Deferred (locked 2026-04-26)
**Context:** The Paperclip → AoA rename plan (`docs/superpowers/plans/2026-04-25-paperclip-to-aoa-rename.md`) defined Phase 6 as renaming `paperclip*` fields in the Hermes adapter wire protocol. Hermes is owned by an external project; renaming our send-side without coordinating their receive-side breaks the integration.

**Decision:** Phase 6 stays deferred until either (a) the Hermes maintainer confirms readiness for a coordinated rename, or (b) a Hermes adapter v2 ships with both names accepted (one-release migration window).

**Consequences:**
- Existing Hermes wire fields keep `paperclip*` names. Documented as a wire-compat surface in `docs/aoa/reference/wire-compat.md`.
- Brand-check CI Guard 7 (cross-component string drift) must continue to allow `paperclip` matches inside `**/adapters/hermes*` and `packages/adapters/hermes/**`.
- Re-open this decision when a coordination window opens. Owner: whoever picks up Hermes adapter work next.

**Reference:** Original Phase 6 spec lives in the rename plan; do not re-litigate without reading it first.
```

- [ ] **Step 3: Update wire-compat.md to reference this decision**

Open `docs/aoa/reference/wire-compat.md`. Find the row(s) for Hermes wire fields. Append a footnote-style reference: `(Decision #92 — deferred)`.

- [ ] **Step 4: Commit**

```sh
git add docs/aoa/reference/decisions.md docs/aoa/reference/wire-compat.md
git commit -m "docs: lock Decision #92 — defer Phase 6 Hermes rename"
```

---

## Final verification

After Tasks 1–12 land:

- [ ] Run the full unit + contract test suite:

```sh
pnpm test:run
```

Expected: every previously-failing test passes. No new failures.

- [ ] Run e2e:

```sh
pnpm test:e2e
```

Expected: 100% pass rate (onboarding + mcp-key-flow + others).

- [ ] Run brand-check guards:

```sh
pnpm exec node scripts/brand-check.mjs
```

Expected: 9/9 PASS.

- [ ] Run typecheck:

```sh
pnpm typecheck
```

Expected: zero errors.

- [ ] Open the cleanup PR:

```sh
gh pr create --base Porting1.1 --head cleanup/2026-04-26 \
  --title "cleanup: residual test failures + 4 spawned followups" \
  --body "$(cat <<'EOF'
## Summary

Closes the residual cleanup items from the Paperclip → AoA rename branch.

## What's in

- AgentsTab Sprint 2A test fix
- Shared drizzle-orm mock helper + 8 test migrations (resolves drizzle-orm ESM cycle)
- cli-mode.test.ts CLI lookup mock
- e2e onboarding pre-condition (per-test cleanup)
- e2e mcp-key-flow auth + token-shape fix
- ProjectDetail* test isolation hardening
- env-compat unit tests (followup #1)
- Dead [paperclip] log-filter audit + script (followup #2)
- localStorage stale-FK audit (followup #3)
- Typed 422 + contract test for stale assignee/project FKs (followup #4)
- Decision #92: Hermes Phase 6 deferral lock

## Test plan

- [ ] `pnpm test:run` green
- [ ] `pnpm test:e2e` green
- [ ] `pnpm exec node scripts/brand-check.mjs` 9/9 green
- [ ] `pnpm typecheck` zero errors

## What's NOT in (intentionally)

- Phase 6 (Hermes wire fields) — see Decision #92.
- Per-site fixes for findings discovered by Task 10's audit — those spin off as
  separate tasks per the audit doc.
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- AgentsTab Sprint 2A test → Task 1 ✓
- ~18 drizzle-orm cycle test failures → Task 2 (helper) + Task 3 (8 migrations); residual tests beyond the 8 named will surface during Task 3 Step 1 of each file and either pass after migration or get a new task ✓
- cli-mode.test.ts "CLI tool not found" → Task 4 ✓
- e2e onboarding pre-condition → Task 5 ✓
- 2 e2e mcp-key-flow failures → Task 6 ✓
- ProjectDetail* flakiness → Task 7 ✓
- Followup #1 (env-compat unit tests) → Task 8 ✓
- Followup #2 (dead [paperclip] filter cleanup) → Task 9 ✓
- Followup #3 (localStorage stale-FK pattern audit) → Task 10 ✓
- Followup #4 (typed 422 for stale FKs) → Task 11 ✓
- Phase 6 Hermes deferral → Task 12 ✓

**Placeholder scan:**
- Task 6 Step 3 says "Apply only the fix(es) the diagnostic actually proves" — that's intentionally diagnostic-driven, not a placeholder. Three concrete candidate fixes are named.
- Task 7 Step 1 uses the actual flake-detection pattern (run 3x).
- Task 11 Step 2 leaves `callCreateIssue` body to be filled in by reading another route test — this is "follow the existing pattern" rather than a placeholder, and the pattern source files are named.
- Task 10 produces an audit doc as the deliverable — the doc is a written artifact, not a placeholder.

**Type consistency:**
- `makeTableProxy` (Task 2) used identically in Task 3 ✓
- `drizzleOperatorStubs` (Task 2) used identically in Tasks 3, 11 ✓
- `pruneStaleId` (Task 10) reused from existing `ui/src/lib/issueDraft.ts` (created in commit `1e2fb50` — exists already) ✓
- `fieldError` accessor (Task 11 Step 4) — exists already from commit `056e7fc` ✓
- `{ field, code: "stale_reference" }` body shape (Task 11) — must match what UI reads via `ApiError.fieldError()`; verify by reading `ui/src/api/error.ts` (or equivalent) before finalizing the route response

No gaps surfaced. Plan is internally consistent.

---

**Estimated total effort:** ~6 hours assuming sequential single-developer execution. Tasks 1, 4, 5, 7, 8, 12 each ~20–30 min. Tasks 2, 6, 9 each ~45–60 min. Task 3 ~90 min (8 file migrations). Tasks 10, 11 ~45 min each.

**Parallelization potential:** Tasks 1, 4, 5, 6, 7, 8, 9, 10, 12 can run in parallel after Task 2 lands. Task 3's eight sub-tasks must be serialized only because they all touch the same import patterns — no actual conflict, but easier to review one-at-a-time. Task 11 depends on Task 2 (uses the helper). With three parallel implementer subagents, total wall time drops to ~3 hours.

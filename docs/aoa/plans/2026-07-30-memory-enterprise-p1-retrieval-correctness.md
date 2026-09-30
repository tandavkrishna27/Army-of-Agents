# P1 · Memory Retrieval Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `2026-07-30-memory-enterprise-overview.md` for the full suite and shared conventions, `2026-07-30-memory-enterprise-p0-foundation.md` for the shared types this phase consumes, and `2026-07-30-memory-enterprise-real-run-acceptance.md` for the live-CLI acceptance scenarios T8 references.

**Goal:** Make every memory read RBAC-correct **inside the query** for both the ORG (heartbeat) and CREW (crew-context-bundle) run paths, converge on a single RBAC filter, audit CREW retrieval (today it is unaudited), give every run a small always-on core, backfill company identity into memory, and ship the Settings → Memory scaffold with the first autonomy/tier dials. The release gate is **zero cross-scope leakage** (T7).

**Architecture:** Add a db-backed companion to P0's pure `memory-access.ts` — `memory-access-sql.ts` — holding the actor resolvers and a `memoryAccessConditions(actor)` builder that returns Drizzle `WHERE` conditions. `searchMultiPath` gains an `accessConditions` filter so unreadable rows are never fetched (the real "before ranking" guarantee); `filterMemoryForActor` (P0) stays as the post-fetch safety net. The two run-path builders and the MCP read tools all route through the same actor + filter. Nothing new is invented in the retrieval algorithm; we gate its inputs and audit its outputs.

**Tech Stack:** Drizzle ORM (`packages/db`), Express 5 services (`server/src`), React + Vite + Tailwind (`ui/src`), Vitest (+ embedded-Postgres for integration), TypeScript.

---

## Dependencies & preconditions (read before starting)

- **P0 must be merged first.** This phase imports P0's `memory-access.ts` (`MemoryActor`, `AccessibleMemoryRow`, `filterMemoryForActor`) and `memory-tier-policy.ts` (`MemoryTier`, `AutonomyLevel`, `WriteDisposition`, `tierForItem`, `resolveWriteDisposition`), and the additive `memory_items` columns (`ownerType`, `ownerId`, `invalidatedAt`, `tier`, …). Verified 2026-07-30: **neither P0 module exists yet** in this branch (`server/src/services/memory-access.ts` / `memory-tier-policy.ts` are absent) and `memory_items` has no `ownerType`/`invalidatedAt` columns — so P0 is a hard blocker. Do not start P1 until P0's three tasks are green.
- **Migration numbering.** Latest migration in this branch is `0186_cold_psylocke.sql`. The P0 doc hard-codes `0188` for its own migration, but in *this* branch P0 will generate **`0187`** and P1-T10 will generate **`0188`**. Do not hard-code the number — let `pnpm db:generate` assign it and verify against `packages/db/src/migrations/`.
- **File-placement deviation from the overview.** The overview says the actor resolvers + `memoryAccessConditions` land "in `memory-access.ts`". They do **not** — P0's `memory-access.ts` is intentionally pure/dependency-free (its P0 test imports it without mocking `@armyofagents/db`). Adding `import { memoryItems } from "@armyofagents/db"` there would drag the drizzle-orm ESM cycle into that pure test. So the db-backed code goes in a sibling **`server/src/services/memory-access-sql.ts`** that type-imports `MemoryActor` from the pure module. This keeps P0's pure test untouched.

**Verified code anchors (2026-07-30):** `heartbeat.ts` `fetchMemoryContext` = lines 1390–1472, memory-injection site = 3553–3578 ✓; `crew-context-bundle.ts` `loadMemoryLines` = line 406, `projectScope` derivation = 385–390 ✓; `memory.ts` `memoryService` = 209, `searchMultiPath` = 578, `buildConditions` = 585–600, projection = 602–628 ✓; `scope.ts` `filterMemoryForScope` = 203 ✓ (also imported in `mcp/server.ts:36`, used at 510 & 519 — **not** only read-tools.ts); `companies.ts` vision/mission/values = lines 24–26 ✓; `memory_items.ts` `visibility` (text notNull default `"scoped"`) = line 57, `agentId` = 72 ✓.

---

### Task 1: Actor resolver (`actorForAgentRun` / `actorForUser`)

Builds a `MemoryActor` for a run or a user, resolving `departmentIds` from `agent_projects` (agents) / `user_roles` (humans). Everything below depends on this.

**Files:**
- Create: `server/src/services/memory-access-sql.ts`
- Test: `server/src/__tests__/memory-actor-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-actor-resolver.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agentProjects: makeTableProxy("agent_projects"),
  userRoles: makeTableProxy("user_roles"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { actorForAgentRun, actorForUser } from "../services/memory-access-sql.js";

type Row = Record<string, unknown>;

/** Sequence-based mock db — each `select()` consumes the next result array. */
function makeMockDb(selects: Row[][]) {
  let i = 0;
  const chain = (rows: () => Row[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit"]) {
      (c as Record<string, () => unknown>)[m] = () => c;
    }
    (c as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
      Promise.resolve(resolve(rows()));
    return c;
  };
  return { select: () => chain(() => selects[i++] ?? []) } as unknown as Parameters<
    typeof actorForAgentRun
  >[0];
}

describe("actorForAgentRun", () => {
  it("builds an agent actor with departmentIds from agent_projects", async () => {
    const db = makeMockDb([[{ projectId: "deptA" }, { projectId: "deptB" }]]);
    const actor = await actorForAgentRun(db, "co-1", "ag1");
    expect(actor).toEqual({ kind: "agent", agentId: "ag1", departmentIds: ["deptA", "deptB"] });
  });

  it("returns empty departmentIds when the agent is assigned nowhere", async () => {
    const db = makeMockDb([[]]);
    const actor = await actorForAgentRun(db, "co-1", "ag1");
    expect(actor).toEqual({ kind: "agent", agentId: "ag1", departmentIds: [] });
  });
});

describe("actorForUser", () => {
  it("a founder role wins regardless of department rows", async () => {
    const db = makeMockDb([[{ role: "team_lead", projectId: "deptA" }, { role: "founder", projectId: null }]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({ kind: "founder" });
  });

  it("a team_lead role yields a scoped team_lead actor", async () => {
    const db = makeMockDb([[{ role: "team_lead", projectId: "deptA" }]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({
      kind: "team_lead",
      userId: "u1",
      departmentIds: ["deptA"],
    });
  });

  it("zero roles fails closed to team_member with no departments", async () => {
    const db = makeMockDb([[]]);
    expect(await actorForUser(db, "co-1", "u1")).toEqual({
      kind: "team_member",
      userId: "u1",
      departmentIds: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-actor-resolver.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-access-sql.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-access-sql.ts`:

```ts
/**
 * DB-backed companion to the pure `memory-access.ts` (enterprise memory model, P1).
 *
 * `memory-access.ts` is deliberately pure (its P0 test imports it without mocking
 * @armyofagents/db). This sibling holds the code that must touch the DB or Drizzle:
 * the actor resolvers and the `memoryAccessConditions` WHERE-builder (P1-T2). It
 * type-imports MemoryActor from the pure module so both stay in sync.
 */
import { and, eq } from "drizzle-orm";
import { agentProjects, userRoles, type Db } from "@armyofagents/db";
import type { MemoryActor } from "./memory-access.js";

/**
 * Actor for an agent run. departmentIds = the agent's `agent_projects` project ids
 * (both 'department' and 'project' rows; the RBAC filter keys on department scope —
 * see the project-scope note in P1-T2). Fail-open is impossible here: an agent with
 * no assignments simply sees only identity + company-visibility memory.
 */
export async function actorForAgentRun(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<MemoryActor> {
  const rows = await db
    .select({ projectId: agentProjects.projectId })
    .from(agentProjects)
    .where(and(eq(agentProjects.companyId, companyId), eq(agentProjects.agentId, agentId)));
  const departmentIds = rows.map((r) => r.projectId).filter((id): id is string => Boolean(id));
  return { kind: "agent", agentId, departmentIds };
}

/**
 * Actor for a human. A founder role short-circuits to `{ kind: "founder" }`. Otherwise
 * the actor is team_lead (if any team_lead row) or team_member, scoped to the
 * departments named on their role rows. Zero roles → team_member with no departments
 * (least privilege). This mirrors `resolveUserRole` in mcp/tools/scope.ts and is
 * deliberately stricter than `resolveUserScope`'s board-zero-rows→founder rule, which
 * is an MCP-board concept, not a run-path one.
 */
export async function actorForUser(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemoryActor> {
  const roles = await db
    .select({ role: userRoles.role, projectId: userRoles.projectId })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
  if (roles.some((r) => r.role === "founder")) return { kind: "founder" };
  const departmentIds = roles.map((r) => r.projectId).filter((id): id is string => Boolean(id));
  const kind = roles.some((r) => r.role === "team_lead") ? "team_lead" : "team_member";
  return { kind, userId, departmentIds };
}

/** MCP dispatch helper: agent callers resolve via agent_projects, everyone else via user_roles. */
export async function actorForMcp(
  db: Db,
  companyId: string,
  actor: { source: string; userId: string; agentId?: string | null },
): Promise<MemoryActor> {
  if (actor.source === "agent" && actor.agentId) {
    return actorForAgentRun(db, companyId, actor.agentId);
  }
  return actorForUser(db, companyId, actor.userId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-actor-resolver.test.ts`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-access-sql.ts server/src/__tests__/memory-actor-resolver.test.ts
git commit -m "feat(memory): actor resolver for run-path RBAC (P1-T1)"
```

---

### Task 2: RBAC in the SQL (`memoryAccessConditions`) + wire into `buildConditions`

Add `memoryAccessConditions(actor)` (Drizzle `WHERE` conditions), extend `MultiPathSearchFilters` with `accessConditions`, push them in `buildConditions`, and extend the projection with the P0 columns the safety-net filter needs.

**Files:**
- Modify: `server/src/services/memory-access-sql.ts` (add `memoryAccessConditions`)
- Modify: `server/src/services/memory.ts` (`MultiPathSearchFilters` + `buildConditions` at ~585 + projection at ~602)
- Test: `server/src/__tests__/memory-access-conditions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-access-conditions.test.ts`. With `drizzleOperatorStubs`, each operator collapses to its name-string, so this test verifies the **structural branch** each actor takes (founder → non-private `and`-branch; scoped actors → `or(private, scoped)`-branch), always guarded by the invalidated-null condition first. Deep SQL semantics are proven in the T7 integration test.

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  agentProjects: makeTableProxy("agent_projects"),
  userRoles: makeTableProxy("user_roles"),
  memoryItems: makeTableProxy("memory_items"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { memoryAccessConditions } from "../services/memory-access-sql.js";
import type { MemoryActor } from "../services/memory-access.js";

const founder: MemoryActor = { kind: "founder" };
const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };
const agentUnassigned: MemoryActor = { kind: "agent", agentId: "ag2", departmentIds: [] };
const leadA: MemoryActor = { kind: "team_lead", userId: "u1", departmentIds: ["deptA"] };

describe("memoryAccessConditions", () => {
  it("always guards invalidatedAt IS NULL first", () => {
    for (const a of [founder, agentA, leadA]) {
      expect(memoryAccessConditions(a)[0]).toBe("isNull");
    }
  });

  it("founder gets the non-private AND-branch (no scoped OR)", () => {
    expect(memoryAccessConditions(founder)).toEqual(["isNull", "and"]);
  });

  it("an agent gets the OR(private, visible-scoped) branch", () => {
    expect(memoryAccessConditions(agentA)).toEqual(["isNull", "or"]);
  });

  it("a scoped human gets the OR(private, visible-scoped) branch", () => {
    expect(memoryAccessConditions(leadA)).toEqual(["isNull", "or"]);
  });

  it("does not throw for an agent with no departments", () => {
    expect(memoryAccessConditions(agentUnassigned)).toEqual(["isNull", "or"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-access-conditions.test.ts`
Expected: FAIL — `memoryAccessConditions is not a function` (module exists from T1 but does not export it yet).

- [ ] **Step 3: Write the implementation**

Append to `server/src/services/memory-access-sql.ts` (add `inArray`, `isNull`, `notInArray`, `or`, `sql`, `type SQL` to the drizzle import, and `memoryItems` to the db import):

```ts
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { agentProjects, memoryItems, userRoles, type Db } from "@armyofagents/db";

/**
 * RBAC as Drizzle WHERE conditions, applied INSIDE searchMultiPath so unreadable
 * rows are never fetched (the real "before ranking" guarantee). Mirrors
 * `canActorSee` in memory-access.ts; `filterMemoryForActor` remains the post-fetch
 * safety net. Returned as an SQL[] the caller spreads into its condition list.
 *
 * "Private" = agent-owned or user-owned (ownerType in (user,agent) OR agentId set).
 * "Non-private visible" = identity layer OR visibility='company' OR departmentId in
 * the actor's departments. Note: project-scoped memory (projectId) is intentionally
 * NOT matched here — the P0 filter keys on departmentId only; broadening to projectId
 * is a tracked recall follow-up, not a leak (see the overview P1 notes).
 */
export function memoryAccessConditions(actor: MemoryActor): SQL[] {
  // Correction/forgetting: invalidated rows never surface (history stays in the row).
  const conds: SQL[] = [isNull(memoryItems.invalidatedAt)];

  const nonPrivate = and(
    isNull(memoryItems.agentId),
    or(isNull(memoryItems.ownerType), notInArray(memoryItems.ownerType, ["user", "agent"])),
  )!;

  if (actor.kind === "founder") {
    conds.push(nonPrivate);
    return conds;
  }

  const deptClause =
    actor.departmentIds.length > 0
      ? inArray(memoryItems.departmentId, actor.departmentIds)
      : sql`false`;
  const visibleNonPrivate = and(
    nonPrivate,
    or(eq(memoryItems.layer, "identity"), eq(memoryItems.visibility, "company"), deptClause),
  )!;

  if (actor.kind === "agent") {
    conds.push(or(visibleNonPrivate, eq(memoryItems.agentId, actor.agentId))!);
  } else {
    // team_lead | team_member | commander — private means own user rows.
    conds.push(
      or(
        visibleNonPrivate,
        and(eq(memoryItems.ownerType, "user"), eq(memoryItems.ownerId, actor.userId))!,
      )!,
    );
  }
  return conds;
}
```

Then in `server/src/services/memory.ts`, extend `MultiPathSearchFilters` (after `enableTemporal?` at ~line 86):

```ts
  /**
   * Pre-computed RBAC WHERE conditions (from memoryAccessConditions(actor)). Applied
   * INSIDE every pathway so unreadable rows are never fetched. Callers still run the
   * post-fetch filterMemoryForActor safety net. Import type: `import type { SQL } from "drizzle-orm"`.
   */
  accessConditions?: SQL[];
```

In `buildConditions` (after the `goalId` push at ~line 598, before `return conds`):

```ts
        if (filters.accessConditions && filters.accessConditions.length > 0) {
          conds.push(...filters.accessConditions);
        }
```

And extend the `projection` object (~line 602) so the safety-net filter + MCP tools can see ownership/validity (add after `agentId: memoryItems.agentId,`):

```ts
        ownerType: memoryItems.ownerType,
        ownerId: memoryItems.ownerId,
        invalidatedAt: memoryItems.invalidatedAt,
```

(Also add `ownerType`/`ownerId`/`invalidatedAt` to the `MultiPathSearchResult` interface at ~line 94 as `string | null` / `Date | null`, so the result type carries them.)

- [ ] **Step 4: Run the new test + prove no regression in the existing multipath suite**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-access-conditions.test.ts`
Expected: PASS (5 passed).

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-multipath.test.ts`
Expected: PASS (all existing cases still green — the projection/filter additions are additive; the sequence-mock db ignores WHERE, so results are unchanged).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

```bash
git add server/src/services/memory-access-sql.ts server/src/services/memory.ts server/src/__tests__/memory-access-conditions.test.ts
git commit -m "feat(memory): RBAC WHERE conditions inside searchMultiPath (P1-T2)"
```

---

### Task 3: Wire ORG (heartbeat `fetchMemoryContext`)

Give the ORG path the agent's actor + department + current-goal scope, and apply the safety-net filter. Extract the scope derivation as a pure, unit-tested helper (shared with T4).

**Files:**
- Create: `server/src/services/memory-run-scope.ts`
- Modify: `server/src/services/heartbeat.ts` (`fetchMemoryContext` ~1390–1472; it already receives `auditContext.agentId`)
- Test: `server/src/__tests__/memory-run-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-run-scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveRunMemoryScope } from "../services/memory-run-scope.js";

describe("resolveRunMemoryScope", () => {
  it("scopes to the department when the issue's project is a department", () => {
    expect(
      resolveRunMemoryScope({ projectId: "p1", projectType: "department", goalId: "g1" }),
    ).toEqual({ departmentId: "p1", goalId: "g1" });
  });

  it("does not set departmentId for a project-type issue (dept-only scoping)", () => {
    expect(
      resolveRunMemoryScope({ projectId: "p1", projectType: "project", goalId: null }),
    ).toEqual({});
  });

  it("carries the goal even with no project", () => {
    expect(resolveRunMemoryScope({ projectId: null, projectType: null, goalId: "g1" })).toEqual({
      goalId: "g1",
    });
  });

  it("returns an empty scope for a null issue", () => {
    expect(resolveRunMemoryScope(null)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-run-scope.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-run-scope.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-run-scope.ts` (mirrors the crew-context-bundle `projectScope` logic at lines 385–390 so ORG + CREW derive scope identically):

```ts
/**
 * Pure scope derivation for run-path memory retrieval (enterprise memory model, P1).
 * A task's department (only when its project is a 'department') + its goal become the
 * `searchMultiPath` scope filters — the fix for today's company-wide, goal-less dump.
 * Shared by the ORG (heartbeat) and CREW (crew-context-bundle) builders.
 */
export interface RunIssueScopeInput {
  projectId: string | null;
  projectType: string | null;
  goalId: string | null;
}

export function resolveRunMemoryScope(
  issue: RunIssueScopeInput | null,
): { departmentId?: string; goalId?: string } {
  const scope: { departmentId?: string; goalId?: string } = {};
  if (!issue) return scope;
  if (issue.projectId && issue.projectType === "department") scope.departmentId = issue.projectId;
  if (issue.goalId) scope.goalId = issue.goalId;
  return scope;
}
```

Then wire `fetchMemoryContext` in `server/src/services/heartbeat.ts`. (a) When loading the issue, also select `projectId`, `goalId`, and the project `type` (join `projects` on `issues.projectId`). (b) Build the actor and access conditions when `auditContext.agentId` is present. (c) Pass the derived scope + conditions to `searchMultiPath`. (d) Apply the safety-net filter to the results before mapping:

```ts
    // (imports at top of heartbeat.ts)
    // import { actorForAgentRun, memoryAccessConditions } from "./memory-access-sql.js";
    // import { filterMemoryForActor } from "./memory-access.js";
    // import { resolveRunMemoryScope } from "./memory-run-scope.js";
    // import { projects } from "@armyofagents/db";

    // Resolve task scope (department + goal + project type) alongside the existing title/description.
    let issueScope: { projectId: string | null; projectType: string | null; goalId: string | null } | null = null;
    if (issueId) {
      const issueRow = await db
        .select({
          title: issues.title,
          description: issues.description,
          projectId: issues.projectId,
          goalId: issues.goalId,
          projectType: projects.type,
        })
        .from(issues)
        .leftJoin(projects, eq(projects.id, issues.projectId))
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (issueRow) {
        issueText = [issueRow.title, issueRow.description].filter(Boolean).join("\n");
        issueScope = {
          projectId: issueRow.projectId,
          projectType: issueRow.projectType ?? null,
          goalId: issueRow.goalId,
        };
      }
    }

    const actor = auditContext?.agentId
      ? await actorForAgentRun(db, companyId, auditContext.agentId)
      : null;
    const scope = resolveRunMemoryScope(issueScope);

    const memorySvc = memoryService(db);
    const rawItems: MultiPathSearchResult[] = await memorySvc
      .searchMultiPath(companyId, issueText ?? "", {
        limit: itemLimit,
        ...scope,
        ...(actor ? { accessConditions: memoryAccessConditions(actor) } : {}),
      })
      .catch((err) => {
        logger.warn({ companyId, issueId, err }, "searchMultiPath failed in fetchMemoryContext; returning empty memory");
        return [] as MultiPathSearchResult[];
      });
    // Safety net: even with in-SQL conditions, never hand an actor a row it can't see.
    const items = actor ? filterMemoryForActor(rawItems, actor) : rawItems;
```

(The existing `recordMemoryRetrievals`, `accessedAt` touch, and return-mapping below keep operating on `items`.)

- [ ] **Step 4: Run the helper test + typecheck**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-run-scope.test.ts`
Expected: PASS (4 passed).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0). (The real ORG-path wiring is proven end-to-end in T7's integration test and T8's real run — heartbeat is not unit-mockable in isolation, consistent with the repo's integration-first precedent for this file.)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-run-scope.ts server/src/services/heartbeat.ts server/src/__tests__/memory-run-scope.test.ts
git commit -m "feat(memory): scope + RBAC the ORG heartbeat memory context (P1-T3)"
```

---

### Task 4: Wire CREW (`crew-context-bundle`) + add retrieval audit

Same actor gating for the CREW path, plus `recordMemoryRetrievals` (CREW is currently unaudited — scenario O4). Extract the search+filter+audit seam so it is unit-testable.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts` (`loadMemoryLines` ~406; `BuildCrewContextBundleArgs` ~58; `buildCrewContextBundle` ~448)
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (call site ~484 — pass `runId`)
- Test: `server/src/__tests__/crew-memory-scoped.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/crew-memory-scoped.test.ts`. It drives the exported seam `loadScopedMemoryLines`, asserting (a) out-of-scope rows are dropped by the safety-net filter and (b) the retrieval is audited with correct `shownToAgent` flags:

```ts
import { describe, expect, it, vi } from "vitest";

const searchMultiPath = vi.fn();
const recordMemoryRetrievals = vi.fn(async () => {});

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ searchMultiPath }),
}));
vi.mock("../services/memory-retrieval-audit.js", () => ({ recordMemoryRetrievals }));
// Real filterMemoryForActor (pure P0) — not mocked, so the drop is genuine.

import { loadScopedMemoryLines } from "../services/internal-agent/aoa-agents/crew-context-bundle.js";
import type { MemoryActor } from "../services/memory-access.js";

const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };

function memRow(over: Record<string, unknown>) {
  return {
    id: "m", title: "T", content: "C", layer: "domain", visibility: "scoped",
    departmentId: null, projectId: null, ownerType: null, ownerId: null,
    agentId: null, invalidatedAt: null, similarity: null, ...over,
  };
}

describe("loadScopedMemoryLines", () => {
  it("drops out-of-scope rows and audits every candidate", async () => {
    searchMultiPath.mockResolvedValueOnce([
      memRow({ id: "in", departmentId: "deptA" }),
      memRow({ id: "out", departmentId: "deptB" }),
    ]);
    const db = {} as never;
    const lines = await loadScopedMemoryLines(db, "co-1", "query", {}, agentA, [], {
      agentId: "ag1", runId: "run-1",
    });
    expect(lines.some((l) => l.includes("in") || l.includes("T"))).toBe(true);
    // "out" (deptB) never rendered
    expect(lines.join("\n")).not.toContain("deptB");
    // Audit: both candidates recorded; only the in-scope one shownToAgent=true.
    expect(recordMemoryRetrievals).toHaveBeenCalledTimes(1);
    const arg = recordMemoryRetrievals.mock.calls[0][1];
    expect(arg.items).toHaveLength(2);
    expect(arg.items.find((i: { id: string }) => i.id === "in").shownToAgent).toBe(true);
    expect(arg.items.find((i: { id: string }) => i.id === "out").shownToAgent).toBe(false);
  });

  it("is a no-op returning [] for an empty query", async () => {
    const lines = await loadScopedMemoryLines({} as never, "co-1", "  ", {}, agentA, [], {});
    expect(lines).toEqual([]);
    expect(searchMultiPath).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/crew-memory-scoped.test.ts`
Expected: FAIL — `loadScopedMemoryLines is not a function` (not yet exported).

- [ ] **Step 3: Write the implementation**

In `crew-context-bundle.ts`: import the seam deps and replace `loadMemoryLines` with an exported `loadScopedMemoryLines` that adds actor + audit:

```ts
import { memoryService } from "../../memory.js";
import { filterMemoryForActor, type MemoryActor } from "../../memory-access.js";
import { recordMemoryRetrievals } from "../../memory-retrieval-audit.js";
import type { SQL } from "drizzle-orm";

/**
 * MEMORY (both branches) — relevant items via multi-path search, RBAC-filtered and
 * AUDITED. accessConditions gate the fetch; filterMemoryForActor is the safety net;
 * every candidate is written to memory_retrievals (CREW was unaudited before P1-T4).
 * BEST-EFFORT: returns [] (never throws) on any search failure.
 */
export async function loadScopedMemoryLines(
  db: Db,
  companyId: string,
  queryText: string,
  filters: MemoryScopeFilters,
  actor: MemoryActor | null,
  accessConditions: SQL[],
  audit: { agentId?: string | null; runId?: string | null; taskId?: string | null },
): Promise<string[]> {
  const q = queryText.trim();
  if (q.length === 0) return [];
  try {
    const raw = await memoryService(db).searchMultiPath(companyId, q, {
      limit: MEMORY_LIMIT,
      ...filters,
      ...(accessConditions.length > 0 ? { accessConditions } : {}),
    });
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const allowed = actor ? filterMemoryForActor(raw as never[], actor) : raw;
    const allowedIds = new Set((allowed as Array<{ id: string }>).map((m) => m.id));
    // Audit every candidate (shownToAgent reflects the filter) — O4.
    void recordMemoryRetrievals(db, {
      companyId,
      agentId: audit.agentId ?? null,
      runId: audit.runId ?? null,
      taskId: audit.taskId ?? null,
      triggeredBy: "auto",
      query: q,
      items: (raw as Array<{ id: string; similarity?: number | null }>).map((m, i) => ({
        id: m.id,
        rank: i + 1,
        similarityScore: m.similarity ?? null,
        shownToAgent: allowedIds.has(m.id),
      })),
    });
    return (allowed as Array<{ title?: unknown; content?: unknown }>).map((m) => {
      const t = typeof m.title === "string" && m.title.length > 0 ? m.title : "Memory";
      const c = typeof m.content === "string" ? m.content : "";
      return `- ${t}: ${truncate(c.trim(), 400)}`;
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "crew-context-bundle: memory search failed; omitting memory section (best-effort)",
    );
    return [];
  }
}
```

Add `runId?: string` and `taskId` sourcing to `BuildCrewContextBundleArgs`, and in `buildCrewContextBundle` build the actor + conditions and call the new seam:

```ts
  // in BuildCrewContextBundleArgs:
  /** Run id for retrieval auditing (O4). */
  runId?: string;

  // in buildCrewContextBundle, replacing the loadMemoryLines call:
  const actor = args.agentId
    ? await actorForAgentRun(db, args.companyId, args.agentId).catch(() => null)
    : null;
  const accessConditions = actor ? memoryAccessConditions(actor) : [];
  const memoryLines = await loadScopedMemoryLines(
    db, args.companyId, queryText, memoryFilters, actor, accessConditions,
    { agentId: args.agentId, runId: args.runId, taskId: args.issueId ?? null },
  );
```

(Import `actorForAgentRun, memoryAccessConditions` from `"../../memory-access-sql.js"`.) Finally, in `runner.ts` at the `buildCrewContextBundle` call (~484) pass the run id the runner already holds for its loopback/summary comments:

```ts
        contextBundle = await buildCrewContextBundle(db, {
          companyId: payload.companyId,
          threadId: bundleThreadId,
          issueId: bundleIssueId,
          agentId,
          runId: run.id,
        });
```

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm --filter ./server exec vitest run src/__tests__/crew-memory-scoped.test.ts`
Expected: PASS (2 passed).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/crew-memory-scoped.test.ts
git commit -m "feat(memory): scope + RBAC + audit the CREW memory context (P1-T4)"
```

---

### Task 5: One filter (route MCP read tools through `filterMemoryForActor`; delete `filterMemoryForScope`)

Two RBAC gates that can drift is the exact leak we are closing. Route the MCP memory read tools through the single P0 filter and remove `filterMemoryForScope`.

**Files:**
- Modify: `server/src/mcp/tools/read-tools.ts` (imports at 10; call sites at 208, 237, 266)
- Modify: `server/src/mcp/server.ts` (import at 36; call sites at 510, 519)
- Modify: `server/src/mcp/tools/scope.ts` (delete `filterMemoryForScope` at ~203; keep `memoryTaskProjectMap`/`goalProjectMap` only if still referenced — grep first)
- Test: `server/src/__tests__/mcp-memory-actor-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/mcp-memory-actor-filter.test.ts` — proves `handleMemorySearch` filters by the resolved actor (cross-dept row dropped) and still audits:

```ts
import { describe, expect, it, vi } from "vitest";

const searchMultiPath = vi.fn();
const actorForMcp = vi.fn();
vi.mock("../services/memory-access-sql.js", () => ({
  actorForMcp,
  memoryAccessConditions: () => [],
}));
vi.mock("../services/memory-retrieval-audit.js", () => ({ recordMemoryRetrievals: vi.fn() }));
vi.mock("../services/company-brain-graph.js", () => ({
  companyBrainGraphService: () => ({ getMemoryItemNeighbors: vi.fn(async () => []) }),
}));
vi.mock("../services/company-brain/retrieval-expansion.js", () => ({
  expandRetrievalWithCompanyGraph: async ({ seeds }: { seeds: unknown[] }) => ({
    items: seeds,
    graphContext: null,
  }),
}));

import { readToolHandlers } from "../mcp/tools/read-tools.js";
import type { MemoryActor } from "../services/memory-access.js";

function memRow(over: Record<string, unknown>) {
  return {
    id: "m", title: "T", content: "C", layer: "domain", visibility: "scoped",
    departmentId: null, projectId: null, ownerType: null, ownerId: null,
    agentId: null, invalidatedAt: null, similarity: null, ...over,
  };
}

describe("memory.search routes through filterMemoryForActor", () => {
  it("drops another department's row for a scoped agent", async () => {
    const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };
    actorForMcp.mockResolvedValueOnce(agentA);
    searchMultiPath.mockResolvedValueOnce([
      memRow({ id: "in", departmentId: "deptA" }),
      memRow({ id: "out", departmentId: "deptB" }),
    ]);
    const ctx = {
      db: {} as never,
      companyId: "co-1",
      actor: { source: "agent", userId: "ag1", agentId: "ag1", runId: "r1" },
      scope: { kind: "scoped", userId: "ag1", projectIds: new Set(["deptA"]) },
      services: { memorySvc: { searchMultiPath, getById: vi.fn() } },
    } as never;
    const res = await readToolHandlers["memory.search"](ctx, { query: "q" });
    const ids = (res.content as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain("in");
    expect(ids).not.toContain("out");
  });
});
```

(Adapt the `ctx`/result shape to the real `ToolContext`/`ToolResult` — the assertion that matters is the cross-dept drop.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/mcp-memory-actor-filter.test.ts`
Expected: FAIL — the handler still calls `filterMemoryForScope` (mock of `memory-access-sql.js` is unused) and returns both rows.

- [ ] **Step 3: Write the implementation**

In `read-tools.ts`: drop `filterMemoryForScope` from the scope import; import `filterMemoryForActor` from `../../services/memory-access.js` and `actorForMcp` from `../../services/memory-access-sql.js`. In `handleMemorySearch` and `handleMemoryGet`, resolve the actor once and filter:

```ts
  const actor = await actorForMcp(ctx.db, ctx.companyId, {
    source: ctx.actor.source,
    userId: ctx.actor.userId,
    agentId: ctx.actor.agentId ?? null,
  });
  const allowed = filterMemoryForActor(results as never[], actor) as typeof results;
```

Replace the two `filterMemoryForScope(ctx.db, ctx.scope, …)` calls (search results + graph-expansion `filterMemoryItems`) and the one in `handleMemoryGet` with `filterMemoryForActor(…, actor)`. In `mcp/server.ts` (lines 510, 519) do the same: build the actor via `actorForMcp` and swap `filterMemoryForScope` → `filterMemoryForActor`. Then delete `filterMemoryForScope` from `scope.ts` and remove its now-dead imports (grep `memoryTaskProjectMap` / `goalProjectMap` first; keep any still used by `filterGoalsForScope`/`assertScopedGoalAccess`).

- [ ] **Step 4: Run test to verify it passes + prove the existing MCP suites still pass**

Run: `pnpm --filter ./server exec vitest run src/__tests__/mcp-memory-actor-filter.test.ts`
Expected: PASS (1 passed).

Run: `pnpm --filter ./server exec vitest run src/__tests__/mcp-memory-tools.test.ts src/__tests__/mcp-read-tools.test.ts`
Expected: PASS (any assertions referencing `filterMemoryForScope` updated to the actor filter).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0) — no remaining importer of `filterMemoryForScope`.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/tools/read-tools.ts server/src/mcp/server.ts server/src/mcp/tools/scope.ts server/src/__tests__/mcp-memory-actor-filter.test.ts
git commit -m "feat(memory): single RBAC filter — route MCP reads through filterMemoryForActor, delete filterMemoryForScope (P1-T5)"
```

---

### Task 6: Always-on core block

A small deterministic block present every run — agent role + current goal title + "identity/policies exist — use `memory.search`" — independent of ranking (scenario O5).

**Files:**
- Create: `server/src/services/memory-core-block.ts`
- Modify: `server/src/services/heartbeat.ts` (add to the returned context) + `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts` (add to `fixedBlocks`)
- Test: `server/src/__tests__/memory-core-block.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-core-block.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAlwaysOnCore } from "../services/memory-core-block.js";

describe("buildAlwaysOnCore", () => {
  it("names the role, the current goal, and the memory.search hint", () => {
    const s = buildAlwaysOnCore({ agentRole: "Engineer", goalTitle: "Ship auth" });
    expect(s).toContain("Engineer");
    expect(s).toContain("Ship auth");
    expect(s).toMatch(/memory\.search/);
    expect(s).toMatch(/identity|polic/i);
  });

  it("stays small and omits the goal line gracefully when absent", () => {
    const s = buildAlwaysOnCore({ agentRole: "Engineer", goalTitle: null });
    expect(s).not.toMatch(/current goal/i);
    expect(s.length).toBeLessThan(400); // deterministic core, not a dump
  });

  it("falls back to a generic role label when none is given", () => {
    expect(buildAlwaysOnCore({ agentRole: null, goalTitle: null })).toContain("agent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-core-block.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-core-block.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-core-block.ts`:

```ts
/**
 * Always-on core (enterprise memory model, P1). A tiny deterministic block injected on
 * EVERY run regardless of retrieval ranking, so an agent always knows its role, its
 * current goal, and that a searchable company brain exists. Small by contract — this is
 * a signpost, not a memory dump (scenario O5).
 */
export function buildAlwaysOnCore(input: {
  agentRole: string | null;
  goalTitle: string | null;
}): string {
  const role = input.agentRole && input.agentRole.trim().length > 0 ? input.agentRole.trim() : "agent";
  const lines = [`You are the ${role} for this company.`];
  if (input.goalTitle && input.goalTitle.trim().length > 0) {
    lines.push(`Current goal: ${input.goalTitle.trim()}.`);
  }
  lines.push(
    "Company identity and policies exist in memory — call memory.search before assuming or inventing context.",
  );
  return lines.join("\n");
}
```

Wire it into both builders. In heartbeat's context assembly (near the memory-injection site ~3557), after `context.memory` is set, add `context.memory_core = buildAlwaysOnCore({ agentRole: agent.role ?? agent.name ?? null, goalTitle })` (source `goalTitle` from the issue's goal loaded in T3). In `crew-context-bundle.ts` `buildCrewContextBundle`, push `buildAlwaysOnCore({ agentRole, goalTitle })` as the FIRST entry of `fixedBlocks` (never dropped by the token budget).

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-core-block.test.ts`
Expected: PASS (3 passed).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-core-block.ts server/src/services/heartbeat.ts server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts server/src/__tests__/memory-core-block.test.ts
git commit -m "feat(memory): always-on core block on every run (P1-T6)"
```

---

### Task 7: Cross-scope leakage test (release gate)

The hard gate. Seed two departments + a private agent item on embedded-Postgres, retrieve as an agent in dept A, and assert dept B's scoped rows and other agents' private rows never appear (scenario O3). Must be green to close P1.

**Files:**
- Create: `server/src/__tests__/memory-cross-scope-leakage.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-cross-scope-leakage.integration.test.ts` (embedded-pg pattern from `crew-org-scope.integration.test.ts`; Windows `initdbFlags: ["--encoding=UTF8","--locale=C"]`; `skipIf(win32)` for CI parity, but Windows contributors can run it locally by removing the skip — see the memory notes):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { memoryService } from "../services/memory.js";
import { actorForAgentRun, memoryAccessConditions } from "../services/memory-access-sql.js";
import { filterMemoryForActor } from "../services/memory-access.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
const PORT = 59000 + Math.floor(Math.random() * 1000);
function firstId(r: unknown): string {
  if (Array.isArray(r)) return (r[0] as { id: string })?.id;
  return (r as { rows?: { id: string }[] }).rows?.[0]?.id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mem-leak-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const cs = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(cs);
    db = createDb(cs);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[mem-leak-integration] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")("cross-scope leakage — the release gate", () => {
  let companyId = "", deptA = "", deptB = "", agentA = "", agentB = "";

  it("setup: two departments, two agents, and scoped + private + identity memory", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    companyId = firstId(await db.execute<{ id: string }>(sql`
      INSERT INTO companies (id, name) VALUES (gen_random_uuid(), 'Leak Co') RETURNING id`));
    deptA = firstId(await db.execute<{ id: string }>(sql`
      INSERT INTO projects (id, company_id, name, type) VALUES (gen_random_uuid(), ${companyId}, 'Alpha', 'department') RETURNING id`));
    deptB = firstId(await db.execute<{ id: string }>(sql`
      INSERT INTO projects (id, company_id, name, type) VALUES (gen_random_uuid(), ${companyId}, 'Beta', 'department') RETURNING id`));
    agentA = firstId(await db.execute<{ id: string }>(sql`
      INSERT INTO agents (id, company_id, name, kind, status) VALUES (gen_random_uuid(), ${companyId}, 'A', 'org', 'idle') RETURNING id`));
    agentB = firstId(await db.execute<{ id: string }>(sql`
      INSERT INTO agents (id, company_id, name, kind, status) VALUES (gen_random_uuid(), ${companyId}, 'B', 'org', 'idle') RETURNING id`));
    await db.execute(sql`INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agentA}, ${deptA}, ${companyId})`);
    await db.execute(sql`INSERT INTO agent_projects (agent_id, project_id, company_id) VALUES (${agentB}, ${deptB}, ${companyId})`);

    // scoped-to-Alpha, scoped-to-Beta, company identity, and agentB-private.
    const ins = (title: string, cols: string, vals: ReturnType<typeof sql>) => db.execute(sql`
      INSERT INTO memory_items (id, company_id, title, content, category, source, status, layer, visibility, created_by ${sql.raw(cols)})
      VALUES (gen_random_uuid(), ${companyId}, ${title}, ${"body of " + title}, 'reference', 'founder', 'approved', ${vals})`);
    await ins("Alpha secret", ", department_id", sql`'domain', 'scoped', 'founder', ${deptA}`);
    await ins("Beta secret", ", department_id", sql`'domain', 'scoped', 'founder', ${deptB}`);
    await ins("Company vision", "", sql`'identity', 'company', 'founder'`);
    await ins("B private note", ", agent_id, owner_type, owner_id", sql`'working', 'scoped', 'founder', ${agentB}, 'agent', ${agentB}`);
    expect(companyId && deptA && deptB && agentA && agentB).toBeTruthy();
  });

  it("agent A sees Alpha + identity, never Beta's scoped row nor B's private row", async () => {
    if (setupError) throw new Error(String(setupError));
    const actor = await actorForAgentRun(db, companyId, agentA);
    const raw = await memoryService(db).searchMultiPath(companyId, "secret note vision", {
      limit: 50, accessConditions: memoryAccessConditions(actor),
    });
    const titles = new Set(filterMemoryForActor(raw as never[], actor).map((r: { title: string }) => r.title));
    expect(titles.has("Alpha secret")).toBe(true);
    expect(titles.has("Company vision")).toBe(true);
    expect(titles.has("Beta secret")).toBe(false); // cross-department leak = FAIL
    expect(titles.has("B private note")).toBe(false); // cross-owner private leak = FAIL
  });

  it("agent B symmetrically sees Beta + identity, never Alpha's scoped row", async () => {
    if (setupError) throw new Error(String(setupError));
    const actor = await actorForAgentRun(db, companyId, agentB);
    const raw = await memoryService(db).searchMultiPath(companyId, "secret note vision", {
      limit: 50, accessConditions: memoryAccessConditions(actor),
    });
    const titles = new Set(filterMemoryForActor(raw as never[], actor).map((r: { title: string }) => r.title));
    expect(titles.has("Beta secret")).toBe(true);
    expect(titles.has("B private note")).toBe(true); // its own private row IS visible
    expect(titles.has("Alpha secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (pre-impl only)**

If P1-T1/T2 are not yet merged, run: `pnpm --filter ./server exec vitest run src/__tests__/memory-cross-scope-leakage.integration.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-access-sql.js'` (or, if the modules exist but conditions are wrong, the leak assertions fail). This test is the *acceptance* of T1–T4; it is expected to already pass once those land.

- [ ] **Step 3: (No new impl — this task is the gate.)**

If any leak assertion fails, the bug is in `memoryAccessConditions` (T2) or `filterMemoryForActor` (P0) — fix there, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-cross-scope-leakage.integration.test.ts`
Expected (Linux CI, or Windows local): PASS (3 passed). On Windows CI it is `skipped` — Linux `push` is the authoritative gate.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/memory-cross-scope-leakage.integration.test.ts
git commit -m "test(memory): cross-scope leakage release gate (P1-T7)"
```

---

### Task 8: Real-run acceptance (live CLI)

The human-run gate on top of the automated tests. Seed a company, run a **real** ORG + CREW agent, and confirm RBAC holds and the always-on core is present and small. References `2026-07-30-memory-enterprise-real-run-acceptance.md` scenarios **I1, I2, I3, I5a, I5b, O1, O2, O3, O4, O5** (P1's phase-gate set; O3 is the hard release blocker).

**Files:**
- Create: `docs/aoa/plans/2026-07-30-memory-enterprise-p1-realrun-runbook.md` (the executed checklist + observed results; no code)

- [ ] **Step 1: Preconditions**

Boot a local `local_trusted` instance with a real CLI logged in (claude_local or codex_local); on Windows use the detached-worktree + embedded-pg setup (short path, `AOA_HOME` / `PORT` / `AOA_EMBEDDED_POSTGRES_PORT`). Set the `llm:openai` key in Settings → Memory so embeddings run (otherwise retrieval degrades to keyword — note it in the runbook). Seed the acceptance fixture from the runbook doc: company `Acme`, departments **Alpha**/**Beta**, org agent **`org-alpha`** on Alpha, crew (Memory Keeper, Librarian), Commander enabled, and the five memory fixtures (identity, Alpha-domain, Beta-domain, other-agent-private, working).

- [ ] **Step 2: Execute INPUT scenarios and record results**

Run and record PASS/FAIL for **I1** (founder Quick Add lands `approved`, scoped Alpha), **I2** (discussion extraction → memory item with `source_ref` tracing the thread), **I3** (braindump → Librarian `status='pending'` items), **I5a** (Commander "remember for this task" → `working`, `approved`), **I5b** (Commander "make it policy" → `status='pending'`, not silently applied). Verify each via the Memory UI + a `memory_items` row query.

- [ ] **Step 3: Execute OUTPUT scenarios (the RBAC gate)**

Assign an Alpha task to `org-alpha`, let the real CLI run, and capture the context dump + `memory_retrievals` rows. Record: **O1** (Commander answer cites the Alpha item; recall audited `commander_context`), **O2** (org run context = identity core + current goal + Alpha domain + dependency outputs; retrieval audited), **O3 — hard gate** (Beta's scoped item and the other agent's private item are ABSENT from context AND from any `memory.search` the agent makes — any appearance = FAIL and P1 is not done), **O4** (spawn a crew agent from an Alpha thread → `memory_retrievals` rows exist for the crew run — the audit that did not exist before P1-T4), **O5** (a small deterministic core block — role + current goal + "identity/policies exist — use memory.search" — is present every run and is small, not a dump).

- [ ] **Step 4: Verdict**

All of I1, I2, I3, I5a, I5b, O1, O2, **O3**, O4, O5 must be PASS. Paste the `memory_retrievals` query output (proving O4) and the context dump excerpt (proving O5 + O3) into the runbook doc. If O3 fails, stop — fix `memoryAccessConditions`/wiring and re-run T7 + T8.

- [ ] **Step 5: Commit the executed runbook**

```bash
git add docs/aoa/plans/2026-07-30-memory-enterprise-p1-realrun-runbook.md
git commit -m "docs(memory): P1 real-run acceptance runbook + results (P1-T8)"
```

---

### Task 9: Vision/mission → identity migration

Copy `companies` vision/mission/values into `layer='identity'` memory items (idempotent backfill), keep the `companies` fields as a temporary mirror. Identity reads already include `layer='identity'` memory via `searchMultiPath`'s layer path, so no retrieval rewrite is needed here.

**Files:**
- Create: `server/src/services/identity-backfill.ts`
- Modify: wire invocation into company create/settings-save (`server/src/routes/companies.ts`) — best-effort, non-fatal
- Test: `server/src/__tests__/identity-backfill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/identity-backfill.test.ts` — the pure planner decides what to insert (idempotent: never re-inserts a field already present as an identity item with the marker `sourceContext`):

```ts
import { describe, expect, it } from "vitest";
import { planIdentityBackfill } from "../services/identity-backfill.js";

const MARK = "company:identity";

describe("planIdentityBackfill", () => {
  it("plans one identity item per non-empty company field", () => {
    const plan = planIdentityBackfill(
      { vision: "Be the best", mission: "Ship value", values: "Trust" },
      [],
    );
    expect(plan.map((p) => p.title).sort()).toEqual(["Company Mission", "Company Values", "Company Vision"]);
    expect(plan.every((p) => p.layer === "identity" && p.sourceContext === MARK)).toBe(true);
  });

  it("skips empty/whitespace fields", () => {
    const plan = planIdentityBackfill({ vision: "V", mission: "  ", values: null }, []);
    expect(plan).toHaveLength(1);
    expect(plan[0].title).toBe("Company Vision");
  });

  it("is idempotent — skips fields already backfilled", () => {
    const plan = planIdentityBackfill(
      { vision: "V", mission: "M", values: null },
      [{ title: "Company Vision", sourceContext: MARK }],
    );
    expect(plan.map((p) => p.title)).toEqual(["Company Mission"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/identity-backfill.test.ts`
Expected: FAIL — `Cannot find module '../services/identity-backfill.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/identity-backfill.ts`:

```ts
/**
 * Idempotent backfill of company identity (vision/mission/values) into layer='identity'
 * memory items (enterprise memory model, P1). The `companies` fields remain the temporary
 * mirror; identity reads already include these items via searchMultiPath's layer path.
 */
import { and, eq } from "drizzle-orm";
import { companies, memoryItems, type Db } from "@armyofagents/db";

const MARK = "company:identity";

interface CompanyIdentityFields {
  vision: string | null;
  mission: string | null;
  values: string | null;
}
interface IdentityPlanItem {
  title: string;
  content: string;
  layer: "identity";
  sourceContext: string;
}

export function planIdentityBackfill(
  fields: CompanyIdentityFields,
  existing: Array<{ title: string; sourceContext: string | null }>,
): IdentityPlanItem[] {
  const already = new Set(existing.filter((e) => e.sourceContext === MARK).map((e) => e.title));
  const rows: Array<[string, string | null]> = [
    ["Company Vision", fields.vision],
    ["Company Mission", fields.mission],
    ["Company Values", fields.values],
  ];
  return rows
    .filter(([title, val]) => typeof val === "string" && val.trim().length > 0 && !already.has(title))
    .map(([title, val]) => ({ title, content: (val as string).trim(), layer: "identity", sourceContext: MARK }));
}

export async function backfillIdentityMemory(db: Db, companyId: string): Promise<number> {
  const company = await db
    .select({ vision: companies.vision, mission: companies.mission, values: companies.values })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((r) => r[0] ?? null);
  if (!company) return 0;
  const existing = await db
    .select({ title: memoryItems.title, sourceContext: memoryItems.sourceContext })
    .from(memoryItems)
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.layer, "identity")));
  const plan = planIdentityBackfill(company, existing);
  if (plan.length === 0) return 0;
  await db.insert(memoryItems).values(
    plan.map((p) => ({
      companyId, title: p.title, content: p.content, category: "context",
      source: "founder", status: "approved", layer: p.layer, visibility: "company",
      createdBy: "system", sourceContext: p.sourceContext,
    })),
  );
  return plan.length;
}
```

Invoke `backfillIdentityMemory(db, companyId)` best-effort (try/catch, never fatal) in the company create handler and the general-settings save handler in `server/src/routes/companies.ts`.

- [ ] **Step 4: Run test to verify it passes + typecheck**

Run: `pnpm --filter ./server exec vitest run src/__tests__/identity-backfill.test.ts`
Expected: PASS (3 passed).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/identity-backfill.ts server/src/routes/companies.ts server/src/__tests__/identity-backfill.test.ts
git commit -m "feat(memory): idempotent vision/mission/values → identity backfill (P1-T9)"
```

---

### Task 10: Settings → Memory (`memory_settings` table + first dials)

Create the `memory_settings` governance table, a service + founder-gated route, and the Settings → Memory panel with the **Autonomy** and **active_context tier** dials (company default + department override). The dials feed `resolveWriteDisposition` (fully wired into write paths in P5).

> **Notes.** (1) The Memory tab currently renders `LLMProvidersSectionWrapper` (the embeddings/OpenAI-key UI — CLAUDE.md Rule #11). `MemorySettingsSection` must **compose** it (render the dials, then embed `<LLMProvidersSectionWrapper />`), never replace it. (2) `memory_settings.autonomyLevel` is the **AutonomyLevel text enum** (`manual|supervised|trusted|policy`) — independent of `internal_agent_config.crew_autonomy_level` (integer 0–2). Do not conflate the two dials. (3) The spec'd `unique (companyId, departmentId)` does NOT prevent duplicate company-default rows (Postgres treats NULLs as distinct); the schema adds a partial unique index for `department_id IS NULL` and the service upserts guarded on it.

**Files:**
- Create: `packages/db/src/schema/memory_settings.ts`
- Modify: `packages/db/src/schema/index.ts` (barrel export)
- Generated: `packages/db/src/migrations/0188_*.sql` (name auto-assigned; verify it is next after P0's)
- Create: `server/src/services/memory-settings.ts` + Test: `server/src/__tests__/memory-settings.test.ts`
- Create: `server/src/routes/memory-settings.ts` + Modify: `server/src/app.ts` (mount)
- Create: `ui/src/api/memorySettings.ts`
- Create: `ui/src/components/settings/sections/MemorySettingsSection.tsx` + Modify: `ui/src/pages/SettingsPage.tsx` (`case "memory"`)
- Test: `ui/src/components/settings/sections/__tests__/MemorySettingsSection.test.tsx`

- [ ] **Step 1: Create the schema + generate the migration**

Create `packages/db/src/schema/memory_settings.ts`:

```ts
import { pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Per-company (and per-department override) memory governance. departmentId null = the
 * company default. autonomyLevel is the AutonomyLevel enum (manual|supervised|trusted|
 * policy), independent of internal_agent_config.crew_autonomy_level. P1 wires only the
 * autonomy + active_context-tier dials; the retention/legal-hold/run-miner/screening/
 * private-memory columns are the governance surface consumed by P3/P4.
 */
export const memorySettings = pgTable(
  "memory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => projects.id, { onDelete: "set null" }),
    autonomyLevel: text("autonomy_level").notNull().default("supervised"),
    activeContextTier: text("active_context_tier").notNull().default("durable"),
    retentionDays: integer("retention_days").notNull().default(90),
    legalHold: boolean("legal_hold").notNull().default(false),
    runMinerEnabled: boolean("run_miner_enabled").notNull().default(true),
    runMinerBudgetCents: integer("run_miner_budget_cents"), // null = uncapped
    externalScreeningEnabled: boolean("external_screening_enabled").notNull().default(true),
    privateMemoryEnabled: boolean("private_memory_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Spec'd composite unique (dept-override rows).
    companyDeptUq: uniqueIndex("memory_settings_company_dept_uq").on(table.companyId, table.departmentId),
    // One company-default row per company (Postgres NULLs are distinct, so the composite
    // unique above does not cover the department_id IS NULL case).
    companyDefaultUq: uniqueIndex("memory_settings_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.departmentId} IS NULL`),
    companyIdx: index("memory_settings_company_idx").on(table.companyId),
  }),
);
```

Add to `packages/db/src/schema/index.ts` (next to `memoryItems` at line 59): `export { memorySettings } from "./memory_settings.js";`

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/0188_*.sql` with `CREATE TABLE "memory_settings"` + the two unique indexes + the FK constraints (verify the number is the next free one after P0's `0187`).

- [ ] **Step 2: Verify migration + db typecheck**

Run: `git diff --stat packages/db/src/migrations`
Expected: one new `.sql` migration + updated `meta/` snapshot. Open the `.sql` and confirm the `CREATE TABLE` + the partial unique `WHERE department_id IS NULL`.

Run: `pnpm --filter ./db typecheck`
Expected: PASS (exit 0).

- [ ] **Step 3: Write the failing service test**

Create `server/src/__tests__/memory-settings.test.ts` (pure resolver — dept override > company default > `'supervised'` fallback; invalid coerced):

```ts
import { describe, expect, it } from "vitest";
import { pickAutonomyLevel } from "../services/memory-settings.js";

const rows = [
  { departmentId: null, autonomyLevel: "trusted" },
  { departmentId: "deptA", autonomyLevel: "manual" },
];

describe("pickAutonomyLevel", () => {
  it("a department override wins over the company default", () => {
    expect(pickAutonomyLevel(rows, "deptA")).toBe("manual");
  });
  it("falls back to the company default when no dept override exists", () => {
    expect(pickAutonomyLevel(rows, "deptB")).toBe("trusted");
  });
  it("falls back to 'supervised' when nothing is set", () => {
    expect(pickAutonomyLevel([], null)).toBe("supervised");
  });
  it("coerces an invalid stored value to 'supervised'", () => {
    expect(pickAutonomyLevel([{ departmentId: null, autonomyLevel: "bogus" }], null)).toBe("supervised");
  });
});
```

- [ ] **Step 4: Run the service test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-settings.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-settings.js'`.

- [ ] **Step 5: Write the service + route**

Create `server/src/services/memory-settings.ts` (follows the `goals.ts` service shape; `AutonomyLevel` from P0's `memory-tier-policy.ts`):

```ts
import { and, eq, isNull } from "drizzle-orm";
import { memorySettings, type Db } from "@armyofagents/db";
import type { AutonomyLevel } from "./memory-tier-policy.js";

const VALID_AUTONOMY: readonly AutonomyLevel[] = ["manual", "supervised", "trusted", "policy"];

export function pickAutonomyLevel(
  rows: Array<{ departmentId: string | null; autonomyLevel: string }>,
  departmentId: string | null,
): AutonomyLevel {
  const dept = departmentId ? rows.find((r) => r.departmentId === departmentId) : undefined;
  const company = rows.find((r) => r.departmentId === null);
  const val = dept?.autonomyLevel ?? company?.autonomyLevel ?? "supervised";
  return (VALID_AUTONOMY as readonly string[]).includes(val) ? (val as AutonomyLevel) : "supervised";
}

export function memorySettingsService(db: Db) {
  return {
    list: (companyId: string) =>
      db.select().from(memorySettings).where(eq(memorySettings.companyId, companyId)),

    /** Upsert the company-default (departmentId null) or a department override. */
    upsert: async (
      companyId: string,
      departmentId: string | null,
      patch: Partial<{ autonomyLevel: string; activeContextTier: string }>,
    ) => {
      const where = departmentId
        ? and(eq(memorySettings.companyId, companyId), eq(memorySettings.departmentId, departmentId))
        : and(eq(memorySettings.companyId, companyId), isNull(memorySettings.departmentId));
      const existing = await db.select().from(memorySettings).where(where).then((r) => r[0] ?? null);
      if (existing) {
        return db.update(memorySettings).set({ ...patch, updatedAt: new Date() })
          .where(eq(memorySettings.id, existing.id)).returning().then((r) => r[0]);
      }
      return db.insert(memorySettings).values({ companyId, departmentId, ...patch })
        .returning().then((r) => r[0]);
    },
  };
}
```

Create `server/src/routes/memory-settings.ts` (mirrors `memoryRoutes`; founder-gated via `assertRole`):

```ts
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { memorySettingsService } from "../services/memory-settings.js";

const upsertSchema = z.object({
  departmentId: z.string().uuid().nullable().default(null),
  autonomyLevel: z.enum(["manual", "supervised", "trusted", "policy"]).optional(),
  activeContextTier: z.enum(["ephemeral", "durable", "protected"]).optional(),
});

export function memorySettingsRoutes(db: Db) {
  const router = Router();
  const svc = memorySettingsService(db);

  router.get("/companies/:companyId/memory-settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.put("/companies/:companyId/memory-settings", validate(upsertSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertRole(db, req, companyId, "founder");
    const { departmentId, ...patch } = req.body as z.infer<typeof upsertSchema>;
    res.json(await svc.upsert(companyId, departmentId, patch));
  });

  return router;
}
```

Mount in `server/src/app.ts` next to `memoryRoutes`: `api.use(memorySettingsRoutes(db));` (import at top).

- [ ] **Step 6: Run the service test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-settings.test.ts`
Expected: PASS (4 passed).

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

- [ ] **Step 7: Write the failing UI test**

Create `ui/src/components/settings/sections/__tests__/MemorySettingsSection.test.tsx` (mirrors `MarketplacePrefsSection.test.tsx` harness):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MemorySettingsSection } from "../MemorySettingsSection";

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../LLMProvidersSectionWrapper", () => ({ LLMProvidersSectionWrapper: () => <div>Embeddings config</div> }));

const update = vi.fn().mockResolvedValue({});
vi.mock("@/api/memorySettings", () => ({
  memorySettingsApi: {
    list: vi.fn().mockResolvedValue([{ departmentId: null, autonomyLevel: "supervised", activeContextTier: "durable" }]),
    update: (...a: unknown[]) => update(...a),
  },
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/C1/settings?tab=memory"]}>
        <TooltipProvider><MemorySettingsSection /></TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemorySettingsSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the autonomy dial and the embedded embeddings config", async () => {
    renderSection();
    expect(await screen.findByLabelText(/autonomy/i)).toBeInTheDocument();
    expect(screen.getByText("Embeddings config")).toBeInTheDocument();
  });

  it("saves when the autonomy dial changes", async () => {
    renderSection();
    const dial = await screen.findByLabelText(/autonomy/i);
    fireEvent.change(dial, { target: { value: "trusted" } });
    expect(update).toHaveBeenCalledWith("company-1", expect.objectContaining({ autonomyLevel: "trusted" }));
  });
});
```

- [ ] **Step 8: Run the UI test to verify it fails**

Run: `pnpm --filter ./ui exec vitest run src/components/settings/sections/__tests__/MemorySettingsSection.test.tsx`
Expected: FAIL — `Cannot find module '../MemorySettingsSection'` (and `@/api/memorySettings`).

- [ ] **Step 9: Write the UI api client + section, and repoint the tab**

Create `ui/src/api/memorySettings.ts`:

```ts
import { apiClient } from "./client";

export interface MemorySettingsRow {
  departmentId: string | null;
  autonomyLevel: "manual" | "supervised" | "trusted" | "policy";
  activeContextTier: "ephemeral" | "durable" | "protected";
}

export const memorySettingsApi = {
  list: (companyId: string) =>
    apiClient.get<MemorySettingsRow[]>(`/companies/${companyId}/memory-settings`),
  update: (
    companyId: string,
    patch: { departmentId?: string | null; autonomyLevel?: string; activeContextTier?: string },
  ) => apiClient.put<MemorySettingsRow>(`/companies/${companyId}/memory-settings`, { departmentId: null, ...patch }),
};
```

Create `ui/src/components/settings/sections/MemorySettingsSection.tsx` — the dials (a labeled `<select>` for autonomy is enough for P1) plus the embedded embeddings config:

```tsx
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { memorySettingsApi } from "@/api/memorySettings";
import { LLMProvidersSectionWrapper } from "./LLMProvidersSectionWrapper";

const AUTONOMY = ["manual", "supervised", "trusted", "policy"] as const;

export function MemorySettingsSection() {
  const { selectedCompanyId } = useCompany();
  const qc = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const { data } = useQuery({
    queryKey: ["memory-settings", companyId],
    queryFn: () => memorySettingsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const mutation = useMutation({
    mutationFn: (patch: { autonomyLevel?: string; activeContextTier?: string }) =>
      memorySettingsApi.update(companyId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memory-settings", companyId] }),
  });
  const companyDefault = data?.find((r) => r.departmentId === null);

  return (
    <section className="flex flex-col gap-6 p-4 md:p-6" data-testid="memory-settings-section">
      <header>
        <h2 className="text-lg font-semibold">Memory</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Company memory governance and embeddings. The autonomy dial sets how memory writes
          are handled — auto, proposed for review, or founder-only.
        </p>
      </header>

      <div className="flex flex-col gap-2 max-w-sm">
        <label htmlFor="memory-autonomy" className="text-sm font-medium">Autonomy</label>
        <select
          id="memory-autonomy"
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
          value={companyDefault?.autonomyLevel ?? "supervised"}
          onChange={(e) => mutation.mutate({ autonomyLevel: e.target.value })}
        >
          {AUTONOMY.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {/* Embeddings/OpenAI-key config keeps living under Settings → Memory (CLAUDE.md Rule #11). */}
      <div className="border-t border-border pt-6">
        <LLMProvidersSectionWrapper />
      </div>
    </section>
  );
}
```

In `ui/src/pages/SettingsPage.tsx`, change `case "memory": return <LLMProvidersSectionWrapper />;` to `case "memory": return <MemorySettingsSection />;` (add the import; the wrapper is now rendered *inside* the section).

- [ ] **Step 10: Run the UI test to verify it passes**

Run: `pnpm --filter ./ui exec vitest run src/components/settings/sections/__tests__/MemorySettingsSection.test.tsx`
Expected: PASS (2 passed).

- [ ] **Step 11: Commit**

```bash
git add packages/db/src/schema/memory_settings.ts packages/db/src/schema/index.ts packages/db/src/migrations \
  server/src/services/memory-settings.ts server/src/routes/memory-settings.ts server/src/app.ts \
  server/src/__tests__/memory-settings.test.ts \
  ui/src/api/memorySettings.ts ui/src/components/settings/sections/MemorySettingsSection.tsx \
  ui/src/pages/SettingsPage.tsx ui/src/components/settings/sections/__tests__/MemorySettingsSection.test.tsx
git commit -m "feat(memory): memory_settings table + Settings → Memory dials (P1-T10)"
```

---

## P1 exit criteria

- [ ] **T7 green — zero cross-scope leakage** (`memory-cross-scope-leakage.integration.test.ts` passes on Linux CI / local; the release blocker).
- [ ] ORG (`heartbeat.fetchMemoryContext`) and CREW (`crew-context-bundle`) both build an actor, pass `accessConditions`, apply the `filterMemoryForActor` safety net, and scope by department + current goal.
- [ ] CREW retrieval is **audited** — `recordMemoryRetrievals` rows exist for a crew run (scenario O4).
- [ ] A single RBAC filter: `filterMemoryForScope` is deleted; no importer remains (`pnpm --filter ./server typecheck` green).
- [ ] The always-on core is injected on every run and is small (T6 test green; O5 observed in T8).
- [ ] Identity backfill is idempotent (T9 test green); `companies` fields kept as a temporary mirror.
- [ ] `memory_settings` migration is additive (new `CREATE TABLE`), `pnpm --filter ./db typecheck` green; the Settings → Memory dials persist and the embeddings config is preserved.
- [ ] T8 real-run: I1, I2, I3, I5a, I5b, O1, O2, **O3**, O4, O5 all PASS on a live instance with a real CLI.
- [ ] `pnpm --filter ./server typecheck` and `pnpm --filter ./ui exec vitest run` (touched files) green.

## Self-review (run before executing)

- **Spec coverage:** overview P1 T1–T10 map 1:1 to Tasks 1–10; real-run scenarios I1/I2/I3/I5a/I5b/O1–O5 land in T8; the four test layers are present — UNIT (T1 resolver, T2 conditions, T3 scope, T6 core, T9 planner, T10 `pickAutonomyLevel`), INTEGRATION (T7 embedded-pg leakage + RBAC-in-SQL), UI (T10 render + dial toggle), REAL-RUN (T8).
- **No placeholders:** every task shows real code and every command shows expected output (FAIL then PASS).
- **Type consistency:** `MemoryActor`/`AccessibleMemoryRow` (P0), `AutonomyLevel`/`WriteDisposition`/`MemoryTier`/`tierForItem`/`resolveWriteDisposition` (P0 `memory-tier-policy.ts`) are imported, never redefined; `confidence` is untouched here.
- **Divergence guards:** no hosted-key call added (Rule #11 — the embeddings config is preserved, not replaced); Paperclip wire protocol untouched; `issues`/`projects`/`goals` table+route names unchanged.
- **Flagged for the executor:** P0 is a hard prerequisite (its modules/columns don't exist yet); migration numbers are branch-relative (expect 0187/0188, not the P0 doc's 0188); `memory-access-sql.ts` deliberately splits the db-backed code out of the pure `memory-access.ts`; `memoryAccessConditions` is structurally unit-tested (stubs collapse operators) and semantically proven in T7; project-scoped memory is intentionally out of the department-keyed filter (tracked recall follow-up, not a leak); the `commander` `MemoryActor` kind is not minted in P1 (MCP commander source resolves via `actorForUser`).

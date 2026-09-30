# P2 · Memory Map + Standard Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `2026-07-30-memory-enterprise-overview.md` for the full suite and shared conventions, and `2026-07-30-memory-enterprise-real-run-acceptance.md` for the live acceptance scenarios (this phase gates **O6**).

**Goal:** Give every agent run a permission-scoped **map** of the company brain. Seed a standard folder taxonomy per department (Decisions / Playbooks / Standards / Risks), compute an RBAC-filtered **manifest** of memory spaces (folders + item counts + freshness), expose it over REST + MCP, and materialize a per-agent `MEMORY_MAP` markdown through the existing skill-sync pipeline — regenerated each run so an agent only ever sees the spaces it may read.

**Architecture:** Extend the live `memory-folders` seeder with the enterprise taxonomy. Add one pure-ish service (`memory-manifest.ts`) that reads `memory_folders` + a per-folder aggregate from `memory_items`, then filters spaces through P0's `filterMemoryForActor`. Surface it as `GET …/memory/manifest` + the `list_memory_spaces` MCP read tool. Extend `memory-skill-sync.ts` with `buildMemoryMapSkillEntry` and inject it in the heartbeat exactly where `buildPinnedMemorySkillEntries` is injected today (try/catch, append-only). No schema changes in P2 — folders and the P0 additive columns already exist.

**Tech Stack:** Drizzle ORM (`packages/db`), Express 5 services/routes (`server/src`), MCP tools (`server/src/mcp`), Vitest (unit + embedded-Postgres integration), TypeScript.

---

## Dependencies (consumed from earlier phases — must be merged first)

P2 **depends on P0 + P1** (see the overview scope table). It imports, and does not redefine:

- **P0 · `server/src/services/memory-access.ts`** — `filterMemoryForActor(items, actor)`, types `MemoryActor` + `AccessibleMemoryRow`. The **single** RBAC gate; the manifest reuses it for space visibility.
- **P0 · additive columns on `memory_items`** — `invalidatedAt`, `ownerType`, `ownerId`, `agentId` are read by the manifest's count query to keep counts private-item-free and correction-aware.
- **P1-T1 · actor resolvers (in `memory-access.ts`)** — `actorForAgentRun(db, agentId)` and `actorForUser(db, companyId, userId)` build a `MemoryActor` (departmentIds from `agent_projects` / `user_roles`). The manifest route + MCP tool + MEMORY_MAP builder call these.

> **Flagged (confirm at execution):** P1-T1's exact `actorForUser` arity. The overview shorthand is `actorForUser(db, userId)`, but company-scoped roles almost certainly require the company id — this plan calls `actorForUser(db, companyId, userId)`. If P1 shipped the 2-arg form, drop the `companyId` argument at the four call sites (route, MCP handler). Likewise the overview writes the manifest signature as `buildMemoryManifest(actor)`; this plan threads `db` + `companyId` explicitly — `buildMemoryManifest(db, companyId, actor)` — since the actor encodes identity, not the query root.

---

### Task 1: Standard folder taxonomy seeder (Decisions / Playbooks / Standards / Risks per department)

The enterprise taxonomy must exist in **every** department's memory tree. `UNIVERSAL_DEPARTMENT_FOLDER_NAMES` (in `memory-folder-seeds.ts`) already seeds **Decisions** and **Playbooks** for every function type; the net-new folders are **Standards** and **Risks**. Extending the universal list is the minimal, idempotent change — `seedForDepartment` already dedups by `seedKey` + normalized path, so re-seeding an existing department adds only the two missing folders and never duplicates.

> **Note (discrepancy):** the phase brief writes the slot as "Playbook" (singular); the repo's canonical folder is **"Playbooks"** (plural) with seedKey `<prefix>.playbooks`. This plan keeps "Playbooks" — renaming would churn existing `seedKey`s and orphan already-seeded folders. The four taxonomy concepts are satisfied by Decisions / Playbooks / Standards / Risks.

**Files:**
- Modify: `server/src/services/memory-folder-seeds.ts` (extend `UNIVERSAL_DEPARTMENT_FOLDER_NAMES`)
- Test: `server/src/__tests__/memory-folder-enterprise-taxonomy.test.ts` (new; pure — `getSeedFoldersForFunctionType` has no drizzle import)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-folder-enterprise-taxonomy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getSeedFoldersForFunctionType } from "../services/memory-folder-seeds.js";

// The enterprise memory taxonomy every department must expose (P2-T1).
const ENTERPRISE_TAXONOMY = ["Decisions", "Playbooks", "Standards", "Risks"] as const;

describe("enterprise standard folder taxonomy (P2-T1)", () => {
  it("every function type (and the generic fallback) seeds the full taxonomy", () => {
    const functionTypes = [
      "software_development",
      "marketing",
      "finance",
      "legal",
      "operations",
      "customer_support",
      "custom",
      null, // generic fallback
      "totally-unknown-type", // also generic fallback
    ];
    for (const ft of functionTypes) {
      const names = getSeedFoldersForFunctionType(ft).map((s) => s.displayName);
      for (const folder of ENTERPRISE_TAXONOMY) {
        expect(names, `functionType=${ft} must seed ${folder}`).toContain(folder);
      }
    }
  });

  it("assigns stable, unique, function-prefixed seedKeys for the net-new folders", () => {
    const seeds = getSeedFoldersForFunctionType("software_development");
    const keys = seeds.map((s) => s.seedKey);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate seedKeys
    expect(keys).toContain("software_development.standards");
    expect(keys).toContain("software_development.risks");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-folder-enterprise-taxonomy.test.ts`
Expected: FAIL — the first `it` fails on `Standards` / `Risks` (`expected [ … ] to contain 'Standards'`).

- [ ] **Step 3: Extend the universal seed list**

In `server/src/services/memory-folder-seeds.ts`, add `"Standards"` and `"Risks"` to `UNIVERSAL_DEPARTMENT_FOLDER_NAMES` (Decisions + Playbooks are already present). The enterprise taxonomy — Decisions / Playbooks / Standards / Risks — is grouped near the top:

```ts
const UNIVERSAL_DEPARTMENT_FOLDER_NAMES = [
  "Overview",
  "Plans & Priorities",
  // --- Enterprise standard taxonomy (P2-T1): every department gets these four ---
  "Decisions",
  "Playbooks",
  "Standards",
  "Risks",
  // --- end enterprise taxonomy ---
  "Processes",
  "Policies",
  "References",
  "Metrics",
  "People & Responsibilities",
  "Tools & Systems",
  "Files",
];
```

(No other change: `folderSeed()` derives `seedKey` = `<prefix>.<slug>` for each name, so the new folders get `<functionType>.standards` / `<functionType>.risks` automatically, and `seedForDepartment` stays idempotent by `seedKey` + path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-folder-enterprise-taxonomy.test.ts`
Expected: PASS (both cases green).

- [ ] **Step 5: Guard the existing seeder tests still pass**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-folder-seeds.test.ts`
Expected: PASS — `seedFoldersOnDepartmentCreate` is unaffected (it seeds whatever the list contains; the list just grew). If a fixture hard-codes an exact folder **count**, update it to include the two new folders.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/memory-folder-seeds.ts server/src/__tests__/memory-folder-enterprise-taxonomy.test.ts
git commit -m "feat(memory): seed enterprise standard folder taxonomy per department (P2-T1)"
```

> **Backfill (existing departments):** the extended list only reaches departments whose `seedForDepartment` runs *after* this ships (new departments; any explicit re-seed). Existing departments gain Standards / Risks the next time `seedForDepartment` runs for them (it is idempotent — see the Task 5 integration test's re-seed case). A one-shot backfill helper already exists at `server/src/migrations/backfill-memory-folder-seeds.ts`; wiring a full sweep across existing departments is optional and **out of scope for P2** (folders auto-appear for new departments, and O6 seeds fresh departments).

---

### Task 2: `buildMemoryManifest(db, companyId, actor)` service

A **manifest** = the list of memory **spaces** (folders) the actor may read, each annotated with an approximate item count and freshness. Space visibility runs through P0's `filterMemoryForActor` by mapping each folder to a synthetic `AccessibleMemoryRow` (company-root folder → `visibility: "company"` → visible to all; department folder → `visibility: "scoped"` + its `departmentId` → dept-match). Counts come from a single per-folder aggregate over **approved, shared, live** items (`invalidated_at IS NULL`, `owner_type IS NULL`, `agent_id IS NULL`) so counts never leak private-item existence and never include forgotten rows.

**Files:**
- Create: `server/src/services/memory-manifest.ts`
- Test: `server/src/__tests__/memory-manifest.test.ts` (new; `makeTableProxy` mock pattern from `memory-multipath.test.ts`)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-manifest.test.ts`. It reuses the `makeTableProxy` / `drizzleOperatorStubs` module mocks and a local sequence-based mock db (extended with `groupBy`). `filterMemoryForActor` is imported **real** (P0, pure — no drizzle):

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryFolders: makeTableProxy("memory_folders"),
  memoryItems: makeTableProxy("memory_items"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { buildMemoryManifest } from "../services/memory-manifest.js";
import type { MemoryActor } from "../services/memory-access.js";

type Row = Record<string, unknown>;

/** Sequence-based mock db — each db.select() consumes the next result array.
 *  Chain extended with groupBy (the manifest aggregate uses it). */
function makeMockDb(selects: Row[][]) {
  let i = 0;
  const buildChain = (get: () => Row[]) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "groupBy", "innerJoin", "leftJoin"]) {
      (chain as Record<string, (...a: unknown[]) => unknown>)[m] = () => chain;
    }
    (chain as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (resolve) =>
      Promise.resolve(resolve(get()));
    return chain;
  };
  return { select: () => buildChain(() => selects[i++] ?? []) } as unknown as Parameters<
    typeof buildMemoryManifest
  >[0];
}

const companyFolder = { companyId: "co-1", departmentId: null, path: "Company/Decisions", displayName: "Decisions" };
const alphaFolder = { companyId: "co-1", departmentId: "deptA", path: "alpha/Risks", displayName: "Risks" };
const betaFolder = { companyId: "co-1", departmentId: "deptB", path: "beta/Standards", displayName: "Standards" };

const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };
const founder: MemoryActor = { kind: "founder" };

describe("buildMemoryManifest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only spaces the actor can read, joins counts + freshness", async () => {
    const db = makeMockDb([
      [companyFolder, alphaFolder, betaFolder], // folders query
      [
        { folderPath: "Company/Decisions", itemCount: 3, lastUpdatedAt: new Date("2026-07-20T00:00:00Z") },
        { folderPath: "alpha/Risks", itemCount: 1, lastUpdatedAt: new Date("2026-07-25T00:00:00Z") },
        { folderPath: "beta/Standards", itemCount: 9, lastUpdatedAt: new Date("2026-07-26T00:00:00Z") },
      ], // aggregate query
    ]);

    const manifest = await buildMemoryManifest(db, "co-1", agentA);
    const paths = manifest.spaces.map((s) => s.path);

    expect(paths).toContain("Company/Decisions"); // company-wide → visible
    expect(paths).toContain("alpha/Risks"); // own department → visible
    expect(paths).not.toContain("beta/Standards"); // other department → HIDDEN
    const alpha = manifest.spaces.find((s) => s.path === "alpha/Risks")!;
    expect(alpha.itemCount).toBe(1);
    expect(alpha.scope).toBe("department");
    expect(alpha.lastUpdatedAt).toBe("2026-07-25T00:00:00.000Z");
    const company = manifest.spaces.find((s) => s.path === "Company/Decisions")!;
    expect(company.scope).toBe("company");
  });

  it("a folder with no items reports itemCount 0 and null freshness", async () => {
    const db = makeMockDb([[alphaFolder], []]); // no aggregate rows
    const manifest = await buildMemoryManifest(db, "co-1", agentA);
    expect(manifest.spaces).toHaveLength(1);
    expect(manifest.spaces[0].itemCount).toBe(0);
    expect(manifest.spaces[0].lastUpdatedAt).toBeNull();
  });

  it("founder sees every space regardless of department", async () => {
    const db = makeMockDb([[companyFolder, alphaFolder, betaFolder], []]);
    const manifest = await buildMemoryManifest(db, "co-1", founder);
    expect(manifest.spaces).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-manifest.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-manifest.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-manifest.ts`:

```ts
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryFolders, memoryItems } from "@armyofagents/db";
import {
  filterMemoryForActor,
  type AccessibleMemoryRow,
  type MemoryActor,
} from "./memory-access.js";

export interface MemorySpace {
  path: string;
  displayName: string;
  departmentId: string | null;
  scope: "company" | "department";
  itemCount: number;
  /** ISO timestamp of the most recent approved item in the space, or null when empty. */
  lastUpdatedAt: string | null;
}

export interface MemoryManifest {
  companyId: string;
  generatedAt: string;
  spaces: MemorySpace[];
}

/**
 * Build the RBAC-scoped memory manifest for `actor` (enterprise memory model, P2).
 *
 * Spaces = rows in `memory_folders`. Each folder is mapped to a synthetic
 * AccessibleMemoryRow and filtered through the single P0 RBAC gate
 * (filterMemoryForActor): a company-root folder (departmentId NULL) is
 * company-wide; a department folder is scoped to its department. Counts +
 * freshness come from one per-folder aggregate over approved, shared, live
 * items — private (owner_type/agent_id) and invalidated rows are excluded so a
 * count never reveals memory the actor could not otherwise see.
 *
 * The overview's shorthand is buildMemoryManifest(actor); db + companyId are
 * threaded explicitly (the actor carries identity, companyId scopes the query).
 */
export async function buildMemoryManifest(
  db: Db,
  companyId: string,
  actor: MemoryActor,
): Promise<MemoryManifest> {
  // 1. All folders for the company (the candidate spaces).
  const folders = await db
    .select({
      departmentId: memoryFolders.departmentId,
      path: memoryFolders.path,
      displayName: memoryFolders.displayName,
    })
    .from(memoryFolders)
    .where(eq(memoryFolders.companyId, companyId));

  // 2. Per-folder aggregate — approved, shared, live items only.
  const aggregates = await db
    .select({
      folderPath: memoryItems.folderPath,
      itemCount: sql<number>`count(*)::int`,
      lastUpdatedAt: sql<Date | null>`max(${memoryItems.updatedAt})`,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.status, "approved"),
        isNull(memoryItems.invalidatedAt), // P0 column: correction/forgetting
        isNull(memoryItems.ownerType), // exclude private (user/agent) items
        isNull(memoryItems.agentId), // exclude agent-scoped items
      ),
    )
    .groupBy(memoryItems.folderPath);

  const aggByPath = new Map(aggregates.map((a) => [a.folderPath, a]));

  // 3. Map each folder to a synthetic AccessibleMemoryRow, preserving the
  //    folder fields (filterMemoryForActor is generic and keeps extra props).
  type FolderAccessRow = AccessibleMemoryRow & {
    path: string;
    displayName: string;
  };
  const rows: FolderAccessRow[] = folders.map((f) => ({
    layer: null,
    visibility: f.departmentId == null ? "company" : "scoped",
    departmentId: f.departmentId,
    projectId: null,
    ownerType: null,
    ownerId: null,
    agentId: null,
    invalidatedAt: null,
    path: f.path,
    displayName: f.displayName,
  }));

  const visible = filterMemoryForActor(rows, actor);

  // 4. Build the spaces, joining counts + freshness.
  const spaces: MemorySpace[] = visible.map((r) => {
    const agg = aggByPath.get(r.path);
    const last = agg?.lastUpdatedAt ?? null;
    return {
      path: r.path,
      displayName: r.displayName,
      departmentId: r.departmentId,
      scope: r.departmentId == null ? "company" : "department",
      itemCount: agg ? Number(agg.itemCount) : 0,
      lastUpdatedAt: last ? new Date(last).toISOString() : null,
    };
  });

  // Company spaces first, then departments; stable path order within each.
  spaces.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "company" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { companyId, generatedAt: new Date().toISOString(), spaces };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-manifest.test.ts`
Expected: PASS (all three cases green).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS.

```bash
git add server/src/services/memory-manifest.ts server/src/__tests__/memory-manifest.test.ts
git commit -m "feat(memory): RBAC-scoped memory manifest service (P2-T2)"
```

> **Counting simplification (noted, not a blocker):** counts key on **exact** `folder_path == folder.path`. Items filed at descendant paths (`alpha/Risks/Q3`) roll up to their own folder, not the parent. This is honest for a map (each space reports its own direct contents) and matches how `memory_folders` stores discrete folder rows. Descendant roll-up (`folder_path LIKE path || '/%'`) is a later enhancement if the map should show subtree totals. Counts also depend on items having a populated `folder_path`; unfiled items (default `""`) do not inflate any named space.

---

### Task 3: `GET /api/companies/:cid/memory/manifest` route + `list_memory_spaces` MCP tool

Two thin surfaces over `buildMemoryManifest`: a board/REST route (founders + team leads read the map from the UI) and an MCP read tool (agents + Commander + external MCP clients read it programmatically). Both build the `MemoryActor` from the caller — agent callers via `actorForAgentRun`, everyone else via `actorForUser` — so the manifest is scoped to whoever asks.

**Files:**
- Modify: `server/src/routes/memory.ts` (add the manifest route; import the service + actor resolvers)
- Modify: `server/src/mcp/tools/read-tools.ts` (add `handleListMemorySpaces`; register in `readToolHandlers`)
- Modify: `server/src/mcp/tools/index.ts` (add the `TOOL_DEFINITIONS` entry + `toolAllowedActors` gate)
- Test: `server/src/__tests__/list-memory-spaces-tool.test.ts` (new; registration + gate + actor-selection contract)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/list-memory-spaces-tool.test.ts`. It mocks the manifest service + actor resolvers (shallow, no drizzle), and mocks `@armyofagents/db` + `drizzle-orm` so importing the tool graph does not trip the ESM cycle:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

// Neutralize the drizzle import graph pulled transitively by mcp/tools/index.js.
vi.mock("@armyofagents/db", () => ({
  memoryFolders: makeTableProxy("memory_folders"),
  memoryItems: makeTableProxy("memory_items"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Stub the manifest + actor resolvers the handler calls.
const buildMemoryManifest = vi.fn(async () => ({ companyId: "co-1", generatedAt: "t", spaces: [] }));
const actorForAgentRun = vi.fn(async () => ({ kind: "agent", agentId: "ag1", departmentIds: ["deptA"] }));
const actorForUser = vi.fn(async () => ({ kind: "founder" }));
vi.mock("../services/memory-manifest.js", () => ({ buildMemoryManifest }));
vi.mock("../services/memory-access.js", () => ({ actorForAgentRun, actorForUser }));

import { TOOL_DEFINITIONS, toolAllowedActors, toolHandlers } from "../mcp/tools/index.js";

function ctx(actor: Record<string, unknown>) {
  return { db: {}, companyId: "co-1", actor } as never;
}

describe("list_memory_spaces MCP tool (P2-T3)", () => {
  it("is registered with an empty-object input schema", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "list_memory_spaces");
    expect(def).toBeTruthy();
    expect(def!.inputSchema).toMatchObject({ type: "object" });
  });

  it("is a read tool open to all authenticated actor sources", () => {
    expect(toolAllowedActors["list_memory_spaces"]).toEqual(["board", "agent", "commander", "mcp"]);
  });

  it("agent callers resolve via actorForAgentRun", async () => {
    const res = await toolHandlers["list_memory_spaces"](ctx({ source: "agent", agentId: "ag1", userId: "u1" }), {});
    expect(actorForAgentRun).toHaveBeenCalledWith({}, "ag1");
    expect(res).toEqual({ ok: true, data: { companyId: "co-1", generatedAt: "t", spaces: [] } });
  });

  it("board callers resolve via actorForUser", async () => {
    await toolHandlers["list_memory_spaces"](ctx({ source: "board", userId: "u1" }), {});
    expect(actorForUser).toHaveBeenCalledWith({}, "co-1", "u1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/list-memory-spaces-tool.test.ts`
Expected: FAIL — `list_memory_spaces` is absent from `TOOL_DEFINITIONS` / `toolAllowedActors` / `toolHandlers`.

> **If the import errors** with an undefined table (a transitively-imported handler references a table not in the mock), add that table to the `@armyofagents/db` mock with `makeTableProxy("<name>")`. The handlers reference tables only at call time, so the map only needs the tables the *loaded* modules touch at import.

- [ ] **Step 3a: Add the MCP handler** (`server/src/mcp/tools/read-tools.ts`)

Add imports at the top:

```ts
import { buildMemoryManifest } from "../../services/memory-manifest.js";
import { actorForAgentRun, actorForUser } from "../../services/memory-access.js";
```

Add the handler (next to `handleMemoryGet`):

```ts
/**
 * Worker/board-facing memory map. Returns the RBAC-scoped manifest of memory
 * spaces (folders + counts + freshness) the caller can read. A MAP, not
 * contents — callers read items with memory.search / memory.get. (P2-T3)
 */
async function handleListMemorySpaces(ctx: ToolContext): Promise<ToolResult> {
  const actor =
    ctx.actor.source === "agent" && ctx.actor.agentId
      ? await actorForAgentRun(ctx.db, ctx.actor.agentId)
      : await actorForUser(ctx.db, ctx.companyId, ctx.actor.userId);
  const manifest = await buildMemoryManifest(ctx.db, ctx.companyId, actor);
  return ok(manifest);
}
```

Register it in the `readToolHandlers` map:

```ts
  "memory.get": handleMemoryGet,
  "list_memory_spaces": handleListMemorySpaces,
```

- [ ] **Step 3b: Register the tool definition + actor gate** (`server/src/mcp/tools/index.ts`)

Add to `toolAllowedActors` (read tool → all actors, mirrors `memory.search`):

```ts
  "memory.get": ALL_ACTORS,
  "list_memory_spaces": ALL_ACTORS,
```

Add to `TOOL_DEFINITIONS` (near the `memory.*` entries):

```ts
  {
    name: "list_memory_spaces",
    description:
      "List the company-memory spaces (folders) the caller can read, each with an " +
      "approximate item count and last-updated time. Returns a MAP, not contents — " +
      "use memory.search / memory.get to read items inside a space. RBAC-scoped: " +
      "spaces outside the caller's departments are omitted.",
    inputSchema: { type: "object", properties: {} },
  },
```

- [ ] **Step 3c: Add the REST route** (`server/src/routes/memory.ts`)

Add imports:

```ts
import { buildMemoryManifest } from "../services/memory-manifest.js";
import { actorForAgentRun, actorForUser } from "../services/memory-access.js";
```

Inside `memoryRoutes`, add the route **before** the parameterized `/:id` route (alongside `search` / `find-similar`, which carry the same "must be before /:id" constraint):

```ts
  // Memory manifest — RBAC-scoped map of spaces (folders + counts + freshness).
  // Must precede the /:id route. (P2-T3)
  router.get("/companies/:companyId/memory/manifest", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor =
        req.actor.type === "agent" && req.actor.agentId
          ? await actorForAgentRun(db, req.actor.agentId)
          : await actorForUser(db, companyId, req.actor.userId as string);
      const manifest = await buildMemoryManifest(db, companyId, actor);
      res.json(manifest);
    } catch (err) {
      next(err);
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/list-memory-spaces-tool.test.ts`
Expected: PASS (all four cases green).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS.

```bash
git add server/src/routes/memory.ts server/src/mcp/tools/read-tools.ts server/src/mcp/tools/index.ts server/src/__tests__/list-memory-spaces-tool.test.ts
git commit -m "feat(memory): memory manifest route + list_memory_spaces MCP tool (P2-T3)"
```

> **Generated-tools drift:** if `pnpm gen:tools:check` / `pnpm gen:tools:md:check` are wired for MCP tool changes, regenerate (`pnpm gen:tools` / `pnpm gen:tools:md`) and commit `packages/shared/src/generated/tools.json` + `server/src/onboarding-assets/commander/TOOLS.md`. Run the checks; if they pass without changes, no action needed. The route is thin glue over the Task-2 service and is exercised end-to-end by the Task 5 integration boot; there is no separate mocked route test.

---

### Task 4: MEMORY_MAP projection materialized per-agent via the skill-sync pipeline

Extend `memory-skill-sync.ts` (the DB→file precedent) with a `MEMORY_MAP` skill entry, and inject it in the heartbeat exactly where `buildPinnedMemorySkillEntries` is injected today. The map is rebuilt from the manifest **every run**, so permission changes take effect immediately and a run only ever mounts the spaces its agent may read (scenario **O6**).

**Files:**
- Modify: `server/src/services/memory-skill-sync.ts` (add `renderMemoryMapMarkdown` + `buildMemoryMapSkillEntry`)
- Modify: `server/src/services/heartbeat.ts` (extend the `memory-skill-sync` import; inject the map entry after the pinned-memory block)
- Test: `server/src/__tests__/memory-map-skill.test.ts` (new; pure renderer)

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-map-skill.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMemoryMapMarkdown } from "../services/memory-skill-sync.js";
import type { MemoryManifest } from "../services/memory-manifest.js";

const manifest: MemoryManifest = {
  companyId: "co-1",
  generatedAt: "2026-07-30T00:00:00.000Z",
  spaces: [
    { path: "Company/Decisions", displayName: "Decisions", departmentId: null, scope: "company", itemCount: 3, lastUpdatedAt: "2026-07-20T10:00:00.000Z" },
    { path: "alpha/Risks", displayName: "Risks", departmentId: "deptA", scope: "department", itemCount: 0, lastUpdatedAt: null },
  ],
};

describe("renderMemoryMapMarkdown (P2-T4)", () => {
  it("emits skill frontmatter and groups spaces by scope", () => {
    const md = renderMemoryMapMarkdown(manifest);
    expect(md).toContain("name: memory-map"); // CLI skill-discovery frontmatter
    expect(md).toContain("## Company");
    expect(md).toContain("## Departments");
    expect(md).toContain("- **Company/Decisions** — 3 item(s), updated 2026-07-20");
    expect(md).toContain("- **alpha/Risks** — 0 item(s), empty");
  });

  it("lists only the given spaces — nothing from another department leaks in", () => {
    const md = renderMemoryMapMarkdown(manifest);
    expect(md).not.toContain("beta/");
  });

  it("renders a stable empty-state when there are no readable spaces", () => {
    const md = renderMemoryMapMarkdown({ ...manifest, spaces: [] });
    expect(md).toContain("name: memory-map");
    expect(md).toContain("(no readable memory spaces)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-map-skill.test.ts`
Expected: FAIL — `renderMemoryMapMarkdown` is not exported from `memory-skill-sync.js`.

- [ ] **Step 3: Add the renderer + builder** (`server/src/services/memory-skill-sync.ts`)

Add the import (top of file, next to the existing `RuntimeSkillEntry` type import):

```ts
import { buildMemoryManifest, type MemoryManifest, type MemorySpace } from "./memory-manifest.js";
import { actorForAgentRun } from "./memory-access.js";
```

Append to the file:

```ts
// ── MEMORY_MAP projection (P2-T4) ────────────────────────────────────────

const MEMORY_MAP_FRONTMATTER = [
  "---",
  "name: memory-map",
  "description: >",
  "  A map of the company-memory spaces you can read — each a folder (space)",
  "  with an approximate item count and when it last changed. This is a MAP,",
  "  not the contents: use the memory.search / memory.get MCP tools (or",
  "  list_memory_spaces) to read items inside a space. Spaces you cannot see",
  "  are not listed.",
  "---",
  "",
].join("\n");

function renderSpaceLine(s: MemorySpace): string {
  const freshness = s.lastUpdatedAt ? `updated ${s.lastUpdatedAt.slice(0, 10)}` : "empty";
  return `- **${s.path}** — ${s.itemCount} item(s), ${freshness}`;
}

/** Render a manifest as the MEMORY_MAP skill body (frontmatter + grouped list). */
export function renderMemoryMapMarkdown(manifest: MemoryManifest): string {
  const parts: string[] = [MEMORY_MAP_FRONTMATTER, "# Memory Map", ""];
  if (manifest.spaces.length === 0) {
    parts.push("(no readable memory spaces)", "");
    return parts.join("\n");
  }
  const company = manifest.spaces.filter((s) => s.scope === "company");
  const dept = manifest.spaces.filter((s) => s.scope === "department");
  if (company.length > 0) {
    parts.push("## Company", "");
    for (const s of company) parts.push(renderSpaceLine(s));
    parts.push("");
  }
  if (dept.length > 0) {
    parts.push("## Departments", "");
    for (const s of dept) parts.push(renderSpaceLine(s));
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Build a per-agent MEMORY_MAP skill entry: resolve the agent's actor, build
 * the RBAC-scoped manifest, render it. Returns [] when the agent can read no
 * spaces (nothing to mount). Regenerated every run by the heartbeat injection.
 *
 * Failure mode: like buildPinnedMemorySkillEntries, the heartbeat call site
 * wraps this in try/catch, so a failure never breaks the run.
 */
export async function buildMemoryMapSkillEntry(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<RuntimeSkillEntry[]> {
  const actor = await actorForAgentRun(db, agentId);
  const manifest = await buildMemoryManifest(db, companyId, actor);
  if (manifest.spaces.length === 0) return [];
  return [
    {
      key: "memory-map",
      name: "Memory Map",
      markdown: renderMemoryMapMarkdown(manifest),
      trustLevel: "trusted",
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-map-skill.test.ts`
Expected: PASS (all three cases green).

- [ ] **Step 5: Inject the map into the heartbeat run** (`server/src/services/heartbeat.ts`)

Extend the existing import (line ~58):

```ts
import { buildPinnedMemorySkillEntries, buildMemoryMapSkillEntry } from "./memory-skill-sync.js";
```

Immediately **after** the pinned-memory injection block (the `try { const pinnedMemoryEntries = … } catch { … }` block ending ~line 3967), add the map injection — same shape (try/catch isolation, append-only merge, sanitized logging):

```ts
      // Materialize a per-agent MEMORY_MAP: a permission-scoped list of the
      // memory spaces this agent can read, regenerated every run. Mirrors the
      // pinned-memory + team-coordination blocks. (P2-T4 / scenario O6)
      try {
        const memoryMapEntries = await buildMemoryMapSkillEntry(
          db,
          agent.companyId,
          agent.id,
        );
        if (memoryMapEntries.length > 0) {
          const prior = context.skills;
          const existing: RuntimeSkillEntry[] = Array.isArray(prior) ? (prior as RuntimeSkillEntry[]) : [];
          context.skills = [...existing, ...memoryMapEntries];
          logger.info(
            { companyId: agent.companyId, agentId: agent.id, runId: run.id },
            "Injected MEMORY_MAP skill for agent run",
          );
        }
      } catch (err) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
          },
          "Failed to build MEMORY_MAP for agent run; continuing without",
        );
      }
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS.

```bash
git add server/src/services/memory-skill-sync.ts server/src/services/heartbeat.ts server/src/__tests__/memory-map-skill.test.ts
git commit -m "feat(memory): per-agent MEMORY_MAP skill projection + heartbeat injection (P2-T4)"
```

> **Scope (ORG vs CREW):** this wires the **ORG heartbeat** path, which is where `buildPinnedMemorySkillEntries` already injects — the clean mirror. The CREW runner (`internal-agent/aoa-agents/runner.ts` ~813) mounts skills via `companySkillService.listRuntimeSkillEntries`, a different mechanism that does **not** carry the pinned-memory skill today either, so crew is already at parity (neither map nor pinned skill). O6 is satisfied by the ORG path (`org-alpha`). **Flagged:** if crew agents must also receive the MEMORY_MAP, add an equivalent `buildMemoryMapSkillEntry` call in the runner's skill-assembly block — tracked as a follow-up, not required to close P2's O6 gate. (Consistent with the pinned-skill precedent being ORG-only.)

---

### Task 5: Integration test — manifest RBAC on embedded-Postgres (release gate for P2)

The real RBAC proof for this phase: seed two departments, seed both taxonomies, and assert an actor in **Alpha** gets only Alpha + Company spaces — **never Beta** — while the founder sees all. Runs on embedded-Postgres (collect-and-skip on Windows, per the repo convention). Also proves the seeder is idempotent (re-seed adds only the missing enterprise folders).

**Files:**
- Test: `server/src/__tests__/memory-manifest-rbac.integration.test.ts` (new; embedded-pg pattern from `memory-version-race.integration.test.ts`)

- [ ] **Step 1: Write the integration test**

Create `server/src/__tests__/memory-manifest-rbac.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { memoryFoldersService } from "../services/memory-folders.js";
import { buildMemoryManifest } from "../services/memory-manifest.js";
import type { MemoryActor } from "../services/memory-access.js";

// Manifest RBAC: an actor in dept Alpha may enumerate only Alpha + Company
// spaces, never Beta. Needs real folder rows + RBAC, so it runs on embedded
// Postgres; collect-and-skip on Windows (embedded-pg can't start on the CI
// Windows runner — same convention as memory-version-race.integration.test.ts).

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

const PORT = 59000 + Math.floor(Math.random() * 1000);
const companyId = "44444444-4444-4444-8444-444444444444";
const deptA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deptB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  if (process.platform === "win32") return;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-mem-manifest-rbac-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port: PORT, persistent: false });
    await pg.initialise();
    await pg.start();

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.execute(sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Manifest RBAC Co', 'MRC')`);
    // Department rows (FK target for memory_folders.department_id).
    await db.execute(sql`INSERT INTO projects (id, company_id, name, type, function_type) VALUES (${deptA}, ${companyId}, 'Alpha', 'department', 'software_development')`);
    await db.execute(sql`INSERT INTO projects (id, company_id, name, type, function_type) VALUES (${deptB}, ${companyId}, 'Beta', 'department', 'marketing')`);

    const svc = memoryFoldersService(db);
    await svc.seedForDepartment({ companyId, departmentId: deptA, departmentSlug: "alpha", functionType: "software_development" });
    await svc.seedForDepartment({ companyId, departmentId: deptB, departmentSlug: "beta", functionType: "marketing" });

    // A couple of approved items filed into Alpha's Decisions space (freshness/count).
    await db.execute(sql`
      INSERT INTO memory_items (id, company_id, title, content, category, source, status, created_by, layer, department_id, folder_path)
      VALUES (gen_random_uuid(), ${companyId}, 'Alpha decision', 'body', 'decision', 'founder', 'approved', 'founder-1', 'domain', ${deptA}, 'alpha/Decisions')
    `);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform === "win32")("memory manifest RBAC", () => {
  const agentA: MemoryActor = { kind: "agent", agentId: "ag-alpha", departmentIds: [deptA] };
  const agentB: MemoryActor = { kind: "agent", agentId: "ag-beta", departmentIds: [deptB] };
  const founder: MemoryActor = { kind: "founder" };

  it("an Alpha agent enumerates only Alpha (+ company) spaces, never Beta", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const manifest = await buildMemoryManifest(db, companyId, agentA);
    const paths = manifest.spaces.map((s) => s.path);

    expect(paths.some((p) => p.startsWith("alpha/"))).toBe(true);
    expect(paths).toContain("alpha/Decisions");
    expect(paths).toContain("alpha/Standards");
    expect(paths).toContain("alpha/Risks");
    // HARD GATE: no Beta space appears for an Alpha actor.
    expect(paths.some((p) => p.startsWith("beta/"))).toBe(false);

    const decisions = manifest.spaces.find((s) => s.path === "alpha/Decisions")!;
    expect(decisions.itemCount).toBe(1);
    expect(decisions.lastUpdatedAt).not.toBeNull();
  });

  it("a Beta agent sees Beta but never Alpha", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const paths = (await buildMemoryManifest(db, companyId, agentB)).spaces.map((s) => s.path);
    expect(paths.some((p) => p.startsWith("beta/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("alpha/"))).toBe(false);
  });

  it("the founder sees both departments' spaces", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const paths = (await buildMemoryManifest(db, companyId, founder)).spaces.map((s) => s.path);
    expect(paths.some((p) => p.startsWith("alpha/"))).toBe(true);
    expect(paths.some((p) => p.startsWith("beta/"))).toBe(true);
  });

  it("re-seeding a department is idempotent (adds no duplicate folders)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    const svc = memoryFoldersService(db);
    const before = (await buildMemoryManifest(db, companyId, { kind: "founder" })).spaces.length;
    await svc.seedForDepartment({ companyId, departmentId: deptA, departmentSlug: "alpha", functionType: "software_development" });
    const after = (await buildMemoryManifest(db, companyId, { kind: "founder" })).spaces.length;
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run the integration test (Linux / macOS)**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-manifest-rbac.integration.test.ts`
Expected (Linux/macOS): PASS — all four cases green.
Expected (Windows local): the suite is **skipped** (`describe.skipIf(process.platform === "win32")`) — 0 failures, 0 run. Validate the behavior on Linux (push to CI) or via a short-path detached worktree with embedded-pg as in the memory-version-race precedent.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/memory-manifest-rbac.integration.test.ts
git commit -m "test(memory): manifest RBAC integration — Alpha never sees Beta spaces (P2-T5)"
```

---

### Task 6: Real-run acceptance — scenario O6 (agent run receives a permission-scoped MEMORY_MAP)

The live-CLI gate for P2, from `2026-07-30-memory-enterprise-real-run-acceptance.md` (scenario **O6**). This is a **runbook**, executed manually on a local instance with a real CLI agent; it confirms the automated coverage holds against a real run.

**Files:**
- No code. Execution notes captured in the PR description / session log.

**Preconditions** (from the acceptance runbook §Preconditions): local `local_trusted` instance booted with a real CLI logged in (claude_local or codex_local); on Windows use the detached-worktree + embedded-pg setup (short path, `AOA_HOME` / `PORT` / `AOA_EMBEDDED_POSTGRES_PORT`). Seed fixture: company **Acme**, departments **Alpha** + **Beta**, org agent **`org-alpha`** assigned to Alpha (adapter = real CLI). (P0 + P1 + P2-T1..T4 merged.)

- [ ] **Step 1: Confirm the taxonomy seeded**
  Create/verify departments Alpha and Beta. In the Memory UI (or `SELECT path FROM memory_folders WHERE company_id = <acme>`), confirm both departments show **Decisions / Playbooks / Standards / Risks** under their slug (`alpha/…`, `beta/…`) plus the Company-root spaces. **Expected:** all four taxonomy folders present per department.

- [ ] **Step 2: Run `org-alpha` on an Alpha task**
  Assign a task scoped to Alpha to `org-alpha` and let the heartbeat dispatch a **real CLI** run to completion.

- [ ] **Step 3: Inspect the mounted MEMORY_MAP** (the O6 assertion)
  Inspect the agent's `skillsDir` for the run (the `memory-map` skill materialized from `context.skills`, alongside `company-knowledge`), or the run's context dump / run log.
  **Expected (PASS):**
  - a `memory-map` skill is present, with the `name: memory-map` frontmatter and a `# Memory Map` body;
  - it lists **Alpha** spaces (`alpha/Decisions`, `alpha/Playbooks`, `alpha/Standards`, `alpha/Risks`) and Company spaces;
  - it lists **no `beta/` space**.
  **FAIL (release blocker):** any `beta/` space appears in `org-alpha`'s map — that is cross-scope leakage (the O3/O6 hard rule).

- [ ] **Step 4: Cross-check the surfaces agree**
  - As founder, `GET /api/companies/<acme>/memory/manifest` → returns **both** Alpha and Beta spaces.
  - During the run (or via an agent-context MCP call) `list_memory_spaces` for `org-alpha` → returns **Alpha + Company only**, no Beta. The map file, the MCP tool, and the REST route (founder) must tell a consistent, RBAC-correct story.

- [ ] **Step 5: Record the result**
  Note PASS/FAIL for O6 in the PR description with the observed map contents (Alpha spaces present, Beta absent). O6 must PASS to close P2.

---

## P2 exit criteria

- [ ] **T1** — every department (all function types + generic fallback) seeds Decisions / Playbooks / Standards / Risks; seeder idempotent; `memory-folder-enterprise-taxonomy.test.ts` + existing seeder tests green.
- [ ] **T2** — `buildMemoryManifest` filters spaces through P0's `filterMemoryForActor` and joins counts + freshness; `memory-manifest.test.ts` green; `pnpm --filter ./server typecheck` green.
- [ ] **T3** — `GET …/memory/manifest` + `list_memory_spaces` MCP tool registered, gated `ALL_ACTORS`, and actor-resolved (agent → `actorForAgentRun`, else `actorForUser`); `list-memory-spaces-tool.test.ts` green; generated-tools checks clean (or regenerated).
- [ ] **T4** — per-agent `MEMORY_MAP` skill built from the manifest and injected in the heartbeat (try/catch, append-only, regenerated each run); `memory-map-skill.test.ts` green.
- [ ] **T5** — `memory-manifest-rbac.integration.test.ts` green on Linux: an Alpha actor enumerates only Alpha + Company spaces, **never Beta** (the phase's RBAC gate).
- [ ] **T6** — real-run **O6** passes: a real `org-alpha` run mounts a MEMORY_MAP listing only its readable spaces (Alpha, not Beta).

## Self-review (done)

- **Spec coverage:** overview P2 = T1 taxonomy seeder, T2 `buildMemoryManifest`, T3 route + `list_memory_spaces`, T4 MEMORY_MAP projection → Tasks 1–4. Test-stack requirement (unit `buildMemoryManifest`, integration manifest-RBAC, real-run O6) → the unit test lives in T2, the integration in T5, the real-run in T6. Exit line "an agent run receives a map listing only its readable spaces; manifest API RBAC-tested" → T5 (RBAC) + T6 (O6).
- **Placeholders:** none — every code step shows real code grounded in the current files (`memory-folder-seeds.ts` universal list, `memory-folders.ts` `seedForDepartment`, `memory_folders` schema, `memory-skill-sync.ts` render/inject precedent, heartbeat injection block ~3938–3967, `read-tools.ts` handler shape, `index.ts` `TOOL_DEFINITIONS`/`toolAllowedActors`, `memory.ts` route shape, the `makeTableProxy` + embedded-pg test patterns).
- **Type consistency:** `MemoryActor` / `AccessibleMemoryRow` / `filterMemoryForActor` consumed unchanged from P0; `actorForAgentRun` / `actorForUser` from P1-T1; new `MemoryManifest` / `MemorySpace` are additive and shared between `memory-manifest.ts` (source) and `memory-skill-sync.ts` (consumer).
- **RBAC:** space visibility runs through the **single** P0 gate (no second filter); counts exclude private + invalidated rows in SQL so a count cannot reveal hidden memory. The cross-scope test (T5) and real-run O6 (T6) both assert Alpha-never-sees-Beta — the phase's release gate.
- **Grounded discrepancies flagged:** "Playbook" (brief) vs "Playbooks" (repo canonical, kept); `getActorInfo` returns `actorId`/`agentId` (not a plain `userId`), so the route reads `req.actor` directly; `actorForUser` arity + `buildMemoryManifest(actor)` shorthand reconciled at the top; exact-path counting (no descendant roll-up) noted; ORG-only injection parity with the pinned-skill precedent noted with a crew follow-up.

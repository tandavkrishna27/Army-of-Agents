# Cross-tenant + founder-replay authz hardening (agent-budget write + global search)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close two confirmed, adversarially-verified authz holes found by the merge-readiness audit of PR #194 — both **pre-existing on `feat/v1-combined`** (NOT introduced by the commander bundle), so they ship as an independent sibling PR (like PR #195 for discussions):
1. **HIGH — `PATCH /agents/:agentId/budgets` (`server/src/routes/costs.ts`)** has neither `assertBoard` nor `assertCompanyAccess`. An mcp bearer token (`agentId` undefined) skips the only check (the agent self-scope branch), so any mcp/agent token can **write an arbitrary agent's budget in any company** → cross-tenant write + hardStop DoS (set budget 0 with `hardStopEnabled` → halts that agent's heartbeat).
2. **MEDIUM — `resolveScope` (`server/src/services/search.ts`)** resolves mcp **and** agent tokens to `role:"founder"`, and `isVisibleToScope` short-circuits ALL per-entity filtering for founder. A founder-created MCP key replays the founder userId → **read-anyone** cross-department/cross-user disclosure via global search (`GET /companies/:cid/search`, which is `assertCompanyAccess`-only).

**Architecture:** Mirror the board-gate pattern already shipped in `conversation-authz.ts` (PR #194) and `discussions.ts` buildActor (PR #195): non-board (mcp/agent) bearer tokens are never founder/elevated; they are demoted to team_member / owner-scoped, and privileged writes require `assertBoard` + same-company. Both fixes are authenticated-multi-user-only (in `local_trusted` the single synthetic board actor makes them moot, but the gates are still correct).

**Tech Stack:** Express 5, Drizzle, Vitest + supertest, the `getActorInfo`/`assertBoard`/`assertCompanyAccess` authz layer.

**Branch / base:** `fix/authz-cross-tenant-budget-search` off `feat/v1-combined`. Worktree: `C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-authz`.

---

## Background (audited, high confidence — both adversarially verified, both stillReal=true)

### Finding 1 — costs agent-budget (HIGH, missing-authorization)
`server/src/routes/costs.ts:126-169` `PATCH /agents/:agentId/budgets`:
```ts
router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
  const agentId = req.params.agentId as string;
  const agent = await agents.getById(agentId);
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

  if (req.actor.type === "agent") {                       // <-- ONLY gate
    if (req.actor.agentId !== agentId) { res.status(403)...; return; }
  }                                                       // <-- mcp/board fall straight through

  const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
  ...
  await budgets.upsertPolicy(updated.companyId, { scopeType:"agent", scopeId:agentId, amountCents:..., warnPercent:80, hardStopEnabled:true });
  ...
});
```
- Reachability: `costRoutes` mounted bare at `app.ts:319` (`api.use(costRoutes(db))`); `boardMutationGuard` (app.ts:247) skips non-board actors (`board-mutation-guard.ts:47`). So an mcp actor (`{type:"mcp", userId, companyId, source:"mcp_key"}` from `auth.ts:160-176`) reaches the handler. `req.actor.type === "agent"` is false for mcp (its `agentId` is undefined per `express.d.ts`) → the self-scope branch is skipped → unconditional write.
- `agentService.update` (`services/agents.ts:323-328`) writes `.where(eq(agents.id, id))` — **no company scoping**; `budgetService.upsertPolicy` (`services/budgets.ts:153`) takes companyId from the caller (the victim agent's own company) — no authz.
- The sibling route `PATCH /companies/:companyId/budgets` (costs.ts:92-93) is correctly `assertBoard` + `assertCompanyAccess` gated. The agent route was missed (cross-tenant security pass `#146` covered only the company route; `costs-routes-cross-tenant.test.ts` tests only the company route).

### Finding 2 — search resolveScope (MEDIUM, founder-replay)
`server/src/services/search.ts:143-179`:
```ts
async function resolveScope(db, companyId, actor): Promise<SearchScope> {
  if (actor.type === "agent") {
    return { role: "founder", userId: null, scopedProjectIds: new Set() };          // BUG: agent → founder
  }
  if ((actor.type !== "board" && actor.type !== "mcp") || actor.source === "local_implicit" || !actor.userId) {
    return { role: "founder", userId: actor.userId ?? null, scopedProjectIds: new Set() };  // admits mcp (the `!== mcp` negation lets mcp fall through to the userRoles lookup below)
  }
  const assignments = await db.select(...).from(userRoles).where(and(eq(companyId), eq(actor.userId)));
  if (assignments.length === 0) return { role: "founder", userId: actor.userId, scopedProjectIds: new Set() };
  const roles = new Set(...); const role = roles.has("founder") ? "founder" : roles.has("team_lead") ? "team_lead" : "team_member";
  return { role, userId: actor.userId, scopedProjectIds: new Set(...projectIds) };
}
```
`isVisibleToScope` (185-242): `if (scope.role === "founder") return true;` short-circuits everything. For an mcp_key actor (`source:"mcp_key"`, `userId` = replayed founder) every clause of the line-147 guard is false → it runs the userRoles lookup for the founder userId → returns `role:"founder"` (or via the empty-assignments fallback) → full cross-company read.
- Reachability: `GET /companies/:companyId/search` (`routes/search.ts:10-12`) calls ONLY `assertCompanyAccess` — no `assertBoard`/`assertRole`. `assertCompanyAccess` admits an mcp/agent actor whose companyId matches.

**Note on the agent null-userId edge (must be handled):** demoting non-board to `team_member` with `userId: actor.userId ?? null` leaves agents with `scope.userId = null`. The team_member ownership checks in `isVisibleToScope` use `result.<assignee> === scope.userId`; with both sides null (`null === null`) an agent would still see null-assignee *scoped* entities (e.g. fixture `memory-2`). The fix therefore also makes those 4 ownership comparisons null-safe so a null-identity scope matches only unscoped/shared entities. Board team_member/team_lead always have a non-null `userId` (a board session with `!actor.userId` returns founder earlier), so this guard changes ONLY agent behavior. mcp keeps its replayed `userId` (acts as that user, demoted to team_member).

**Precedent (citation accuracy):** the board-gate pattern (non-board → demoted, never founder) is the same one being shipped by the two sibling authz-hardening PRs off this same base — **PR #194** (`conversation-authz.ts` `resolveActorRole`) and **PR #195** (`discussions.ts` `buildActor`). Neither of those files' *fixed* form exists on `feat/v1-combined` yet (they land separately), so this PR's code comments describe the rationale inline rather than claiming an in-tree precedent. Note this search fix is intentionally **stricter** than `discussions.ts buildActor`: that helper runs a permission lookup for mcp (can still resolve elevated), whereas search demotes ALL non-board hard to `team_member` — which is exactly what closes the read-anyone hole.

---

## Task 1: Board-gate `PATCH /agents/:agentId/budgets` (HIGH)

**Files:**
- Modify: `server/src/routes/costs.ts` (handler at ~126-145)
- Test: `server/src/__tests__/costs-agent-budget-cross-tenant.test.ts` (new)

- [ ] **Step 1: Write the failing test** (mirrors `costs-routes-cross-tenant.test.ts`; create new file)

```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companies: makeTableProxy("companies"),
  costEvents: makeTableProxy("cost_events"),
  budgetPolicies: makeTableProxy("budget_policies"),
  agents: makeTableProxy("agents"),
}));

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(), summary: vi.fn(), byAgent: vi.fn(), byProject: vi.fn(),
  byModel: vi.fn(), byBiller: vi.fn(), listForAgent: vi.fn(),
}));
const mockCompanyService = vi.hoisted(() => ({
  update: vi.fn(), getById: vi.fn(), list: vi.fn(), create: vi.fn(), archive: vi.fn(), remove: vi.fn(), stats: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(), listPolicies: vi.fn(), getPolicyByScope: vi.fn(), listIncidents: vi.fn(), resolveIncident: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn(), update: vi.fn() }));

vi.mock("../services/index.js", () => ({
  costService: () => mockCostService,
  companyService: () => mockCompanyService,
  agentService: () => mockAgentService,
  logActivity: vi.fn(),
}));
vi.mock("../services/budgets.js", () => ({ budgetService: () => mockBudgetService }));

import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/index.js";

// An agent in company-B (the victim agent's company).
const AGENT_B = { id: "agent-B", companyId: "company-B", budgetMonthlyCents: 500000 };

// A founder-created MCP key scoped to company-A (the attacker's company).
const mcpActorCompanyA = { type: "mcp" as const, source: "mcp_key" as const, userId: "founder-A", companyId: "company-A" };
// A board founder for company-B (legitimate path — regression guard).
const boardActorCompanyB = { type: "board" as const, source: "session" as const, userId: "user-B", companyIds: ["company-B"], isInstanceAdmin: false };
// The agent itself (legitimate self-budget path — regression guard).
const agentSelfB = { type: "agent" as const, agentId: "agent-B", companyId: "company-B" };
// A different agent (existing self-scope 403 — regression guard).
const agentOtherB = { type: "agent" as const, agentId: "agent-OTHER", companyId: "company-B" };

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", costRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /agents/:agentId/budgets authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(AGENT_B);
    mockAgentService.update.mockResolvedValue({ ...AGENT_B, budgetMonthlyCents: 0 });
    mockBudgetService.upsertPolicy.mockResolvedValue({});
  });

  it("403 for an MCP token (cross-tenant + non-board governance write) and writes nothing", async () => {
    const res = await request(makeApp(mcpActorCompanyA))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
  });

  it("200 for the board founder of the agent's own company (regression guard)", async () => {
    const res = await request(makeApp(boardActorCompanyB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-B", { budgetMonthlyCents: 0 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalled();
  });

  it("403 for a board actor of a DIFFERENT company (cross-tenant)", async () => {
    const boardActorCompanyA = { type: "board" as const, source: "session" as const, userId: "user-A", companyIds: ["company-A"], isInstanceAdmin: false };
    const res = await request(makeApp(boardActorCompanyA))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("200 for the agent setting its OWN budget (regression guard)", async () => {
    const res = await request(makeApp(agentSelfB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("403 for an agent token targeting a DIFFERENT agent (existing self-scope)", async () => {
    const res = await request(makeApp(agentOtherB))
      .patch("/api/agents/agent-B/budgets")
      .send({ budgetMonthlyCents: 0 });
    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd server && pnpm vitest run src/__tests__/costs-agent-budget-cross-tenant.test.ts`
Expected: the MCP and cross-company-board cases return **200** (today there is no gate) → those `expect(403)` assertions FAIL.

- [ ] **Step 3: Apply the fix** — replace the self-scope-only block (`costs.ts:134-139`) with a full gate:

```ts
    if (req.actor.type === "agent") {
      // An agent may set only its own budget (self-reporting).
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
    } else {
      // Human / MCP governance write: must be an interactive board session in the
      // agent's own company. A founder-created MCP key replays the founder userId
      // (auth.ts) and would otherwise reach this privileged cross-tenant write;
      // assertBoard rejects non-board bearer tokens, assertCompanyAccess rejects
      // foreign companies. Mirrors the sibling PATCH /companies/:cid/budgets gate.
      assertBoard(req);
      assertCompanyAccess(req, agent.companyId);
    }
```
(`assertBoard`, `assertCompanyAccess`, `getActorInfo` are already imported in `costs.ts`. The `agent` row is already fetched at line 128 with its `companyId`. No other change.)

- [ ] **Step 4: Run it — expect PASS**

Run: `cd server && pnpm vitest run src/__tests__/costs-agent-budget-cross-tenant.test.ts` → 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/costs.ts server/src/__tests__/costs-agent-budget-cross-tenant.test.ts
git commit -m "fix(costs): board-gate PATCH /agents/:id/budgets (HIGH cross-tenant agent-budget write)"
```

---

## Task 2: Board-gate `resolveScope` + null-safe ownership (MEDIUM)

**Files:**
- Modify: `server/src/services/search.ts` (`resolveScope` ~143-149; `isVisibleToScope` ~194-238)
- Test: `server/src/__tests__/search-founder-mcp-authz.test.ts` (new — mirrors `search.test.ts`)

- [ ] **Step 1: Write the failing test** (mirrors `search.test.ts`'s `makeDb`/`executeFixtures` harness; reuse identical fixtures so visibility is grounded)

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  sql: Object.assign(vi.fn((strings: unknown, ...values: unknown[]) => ({ strings, values })), {
    join: vi.fn((values: unknown[]) => values),
  }),
}));
vi.mock("@armyofagents/db", () => ({
  userRoles: { role: "role", projectId: "project_id", companyId: "company_id", userId: "user_id" },
}));

import { searchService } from "../services/search.js";

// userRoleRows: result of resolveScope's userRoles query (ONLY reached for board sessions).
// executeRows: per-entity-type execute() result arrays.
function makeDb(userRoleRows: Array<{ role: string; projectId: string | null }>, executeRows: unknown[]) {
  let userRolesQueried = false;
  let executeIndex = 0;
  const db = {
    select: () => ({ from: () => ({ where: () => { userRolesQueried = true; return Promise.resolve(userRoleRows); } }) }),
    execute: async () => ({ rows: executeRows[executeIndex++] ?? [] }),
  } as any;
  return { db, wasUserRolesQueried: () => userRolesQueried };
}

// Same fixtures as search.test.ts: task-1 (dept-1, assignee user-1) + task-2 (unscoped);
// brief-1 (dept-1) + brief-2 (unscoped); memory-1 (shared) + memory-2 (scoped dept-1, no assignee) + memory-archived.
function executeFixtures() {
  return [
    [
      { id: "task-1", identifier: "TASK-1", title: "Searchable task", subtitle: "d", status: "todo", score: 0.9, projectId: "dept-1", projectName: "Engineering", assigneeUserId: "user-1" },
      { id: "task-2", identifier: "TASK-2", title: "Unscoped task", subtitle: "p", status: "todo", score: 0.7, projectId: null, projectName: null, assigneeUserId: null },
    ],
    [{ id: "goal-1", title: "Search goal", subtitle: "d", status: "active", score: 0.8, projectIds: ["dept-1"], projectNames: ["Engineering"] }],
    [{ id: "agent-1", name: "Atlas", title: "Staff Engineer", role: "engineer", status: "active", score: 0.75 }],
    [
      { id: "brief-1", title: "Search brief", subtitle: "e", status: "ready", score: 0.72, departmentId: "dept-1", projectId: null, departmentName: "Engineering" },
      { id: "brief-2", title: "Public brief", subtitle: "e", status: "ready", score: 0.55, departmentId: null, projectId: null, departmentName: null },
    ],
    [
      { id: "memory-1", title: "Shared memory", subtitle: "c", status: "approved", score: 0.85, departmentId: "dept-2", projectId: null, departmentName: "Sales", category: "reference", layer: "domain", visibility: "shared", taskAssigneeUserId: null },
      { id: "memory-2", title: "Scoped memory", subtitle: "c", status: "approved", score: 0.65, departmentId: "dept-1", projectId: null, departmentName: "Engineering", category: "context", layer: "domain", visibility: "scoped", taskAssigneeUserId: null },
    ],
    [
      { id: "artifact-1", title: "Spec artifact", subtitle: "c", status: "active", score: 0.78, artifactType: "document", currentVersionNumber: 3, linkedIssueId: "task-1", linkedIssueIdentifier: "TASK-1", linkedIssueProjectId: "dept-1", linkedIssueAssigneeUserId: "user-1" },
    ],
    [
      { id: "suggestion-1", title: "Pending suggestion", subtitle: "e", status: "pending", score: 0.73, category: "memory_gap", relatedMemoryItemId: "memory-1", relatedMemoryDepartmentId: "dept-2", relatedMemoryProjectId: null, relatedMemoryVisibility: "shared", relatedMemoryTaskAssigneeUserId: null },
    ],
  ];
}

describe("search resolveScope founder-MCP/agent bypass", () => {
  it("MCP token (replayed founder userId) is demoted to team_member, NOT founder — excludes scoped/other-user entities", async () => {
    const { db, wasUserRolesQueried } = makeDb([{ role: "founder", projectId: null }], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "mcp", source: "mcp_key", userId: "founder-1", companyId: "company-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    // Pre-fix: mcp → founder → sees ALL (task-1, memory-2, brief-1). Post-fix: team_member (no scoped projects, userId founder-1 owns none of these).
    expect(ids("task")).toEqual(["task-2"]);          // task-1 (dept-1, assignee user-1) excluded
    expect(ids("memory")).toEqual(["memory-1"]);      // memory-2 (scoped) excluded
    expect(ids("brief")).toEqual(["brief-2"]);        // brief-1 (dept-1) excluded
    expect(ids("goal")).toEqual([]);                  // goal-1 (dept-1 scoped) excluded for team_member without that project
    expect(ids("suggestion")).toEqual(["suggestion-1"]); // shared-memory-linked suggestion still visible
    // Even though the mocked userRoles row says "founder", the board-gate must NOT consult it for an mcp actor.
    expect(wasUserRolesQueried()).toBe(false);
  });

  it("agent token is demoted to team_member with no owner identity — sees only unscoped/shared (null-safe)", async () => {
    const { db, wasUserRolesQueried } = makeDb([{ role: "founder", projectId: null }], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "agent", agentId: "agent-x", companyId: "company-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    expect(ids("task")).toEqual(["task-2"]);          // unscoped only; task-1 excluded
    expect(ids("memory")).toEqual(["memory-1"]);      // shared only; memory-2 (null-assignee scoped) must NOT leak via null===null
    expect(ids("brief")).toEqual(["brief-2"]);        // unscoped only
    expect(ids("goal")).toEqual([]);                  // dept-scoped goal excluded
    expect(ids("suggestion")).toEqual(["suggestion-1"]); // shared-linked suggestion visible
    expect(wasUserRolesQueried()).toBe(false);
  });

  it("board local_implicit founder still sees everything (regression guard)", async () => {
    const { db } = makeDb([], executeFixtures());
    const result = await searchService(db).search("company-1", {
      query: "search",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" } as any,
    });
    const ids = (t: string) => result.groups.find((g) => g.type === t)?.items.map((i) => i.id) ?? [];
    expect(ids("task")).toEqual(["task-1", "task-2"]);
    expect(ids("memory")).toEqual(["memory-1", "memory-2"]);
    expect(ids("brief")).toEqual(["brief-1", "brief-2"]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd server && pnpm vitest run src/__tests__/search-founder-mcp-authz.test.ts`
Expected: the mcp + agent cases FAIL — today both resolve to `role:"founder"` so they see `task-1`, `memory-2`, `brief-1` (and `wasUserRolesQueried()` is true for the mcp case). The board regression case passes.

- [ ] **Step 3a: Fix `resolveScope`** — replace lines 144-149 (the agent-founder return + the mcp-admitting guard) with a single board gate:

```ts
async function resolveScope(db: Db, companyId: string, actor: Actor): Promise<SearchScope> {
  // Non-board bearer tokens (mcp / agent) are NEVER founder-equivalent for search.
  // A founder-created MCP key replays the founder's userId, which would otherwise
  // resolve to "founder" via the userRoles lookup and bypass ALL per-entity
  // visibility filtering (read-anyone). Confine them to team_member, owner-scoped
  // by the (possibly null) replayed userId; agents carry no userId and so see only
  // unscoped/shared entities (the null-safe checks in isVisibleToScope). Interactive
  // founder/role reach is via board sessions only. (Same board-gate pattern as the
  // sibling PR #194 / #195 authz fixes; intentionally stricter for mcp.)
  if (actor.type !== "board") {
    return { role: "team_member", userId: actor.userId ?? null, scopedProjectIds: new Set() };
  }
  if (actor.source === "local_implicit" || !actor.userId) {
    return { role: "founder", userId: actor.userId ?? null, scopedProjectIds: new Set() };
  }

  const assignments = await db
    .select({ role: userRoles.role, projectId: userRoles.projectId })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, actor.userId)));
  // ...rest unchanged (empty-assignments → founder; roles → role; return)...
}
```
(Leave lines 151-179 exactly as-is. The only deletions are the old 144-145 agent branch and the old 147-149 mixed guard, replaced by the two branches above.)

- [ ] **Step 3b: Make the 4 team_member ownership comparisons null-safe** in `isVisibleToScope` so a null-identity scope (agent) matches only unscoped/shared, never null-assignee scoped entities:

`task` case (line ~198):
```ts
        : ((scope.userId != null && (result.assigneeUserId as string | null) === scope.userId)
          || isUnscoped(result.projectId as string | null | undefined));
```
`memory` case (line ~224):
```ts
      return scope.userId != null && (result.taskAssigneeUserId as string | null) === scope.userId;
```
`artifact` case (line ~229):
```ts
        : ((scope.userId != null && (result.linkedIssueAssigneeUserId as string | null) === scope.userId)
          || isUnscoped(result.linkedIssueProjectId as string | null | undefined));
```
`suggestion` case (line ~238):
```ts
      return scope.userId != null && (result.relatedMemoryTaskAssigneeUserId as string | null) === scope.userId;
```
(These guards are no-ops for board team_member/team_lead — those always have a non-null `userId` because a board session with `!actor.userId` returned founder earlier. They change ONLY the agent path.)

- [ ] **Step 4: Run it — expect PASS** + run the existing search suite (board roles must be unchanged)

Run: `cd server && pnpm vitest run src/__tests__/search-founder-mcp-authz.test.ts src/__tests__/search.test.ts`
Expected: both green (new 3/3 + existing 5/5; the board founder / team_member / team_lead cases in `search.test.ts` are unaffected).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/search.ts server/src/__tests__/search-founder-mcp-authz.test.ts
git commit -m "fix(search): board-gate resolveScope; null-safe ownership (MEDIUM founder-MCP read-anyone via global search)"
```

---

## Task 3: Verify + PR into `feat/v1-combined`

- [ ] **Step 1: Full server suite + typecheck**

Run: `cd server && pnpm vitest run` (report totals; note any pre-existing unrelated/flaky failures — e.g. `*.live.test.ts` needing a real CLI/DB, and the `@modelcontextprotocol/sdk`-missing tsc/test failures that exist on the `feat/v1-combined` base independent of this change). Then `cd server && pnpm tsc --noEmit` (note any base-level pre-existing errors; the changed files must be clean).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin fix/authz-cross-tenant-budget-search
```

- [ ] **Step 3: Open PR into `feat/v1-combined`**

`gh pr create --base feat/v1-combined --head fix/authz-cross-tenant-budget-search` with a body describing both findings (HIGH cross-tenant agent-budget write; MEDIUM founder-replay search disclosure), the board-gate fixes (mirrors PR #194 `conversation-authz` + PR #195 `discussions`), the authenticated-multi-user-only impact, that both are pre-existing on the base (found by the PR #194 merge-readiness audit), and the test coverage. Trigger `@codex review` (bot may be rate-limited until the Codex quota resets; a substitute review covers the interim).

---

## Self-Review

**Spec coverage:** Finding 1 board-gate → Task 1 Step 3; Finding 2 board-gate + null-safe → Task 2 Steps 3a/3b; failing-first tests for both (cross-tenant + mcp/agent demotion) → Tasks 1/2 Step 1; board-path regression guards (own-company board 200, board founder still sees all) → included; full suite + PR → Task 3. ✓

**Placeholder scan:** all code is full; tests reuse the real `search.test.ts` / `costs-routes-cross-tenant.test.ts` harnesses (flagged, mirrored, not hand-waved). ✓

**Type consistency:** `SearchScope` shape `{ role, userId, scopedProjectIds }` preserved; `actor.type !== "board"` matches the `Actor` union; `assertBoard`/`assertCompanyAccess` already imported in `costs.ts`; `role:"team_member"` is a valid `UserRole`. ✓

**Risks:**
- A legitimate flow that sets agent budgets via an MCP integration would now 403. Audit found none (budget-setting is governance, done via board UI); the company-budget sibling is already board-gated, so this is parity, not a new restriction. If such a flow exists it should be an explicit opt-in on the mcp key, not implicit founder-replay.
- An agent setting its OWN budget is preserved (Task 1 keeps the self-scope branch).
- Search board team_member/team_lead/founder behavior is unchanged (null-safe guards only affect null-userId = agent scopes; `search.test.ts` re-run proves it).
- `local_implicit`/single-user `local_trusted` unaffected (board branch first/unchanged).
- Both fixes are isolated to one handler + one service function; no schema change, no migration.

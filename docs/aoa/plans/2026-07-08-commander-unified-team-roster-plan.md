# Commander Unified Team Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Commander a read-only, hierarchy-aware team roster tool so broad team questions return humans and agents together, with readable reporting lines.

**Architecture:** Reuse the existing company-scoped unified org tree instead of creating a second hierarchy model. Add a thin Commander query tool, `query_team_roster`, over `agentService.orgForCompany()`, derive a compact flat roster from the same tree, and update Commander guidance so broad team/org/hierarchy questions use the unified tool while narrow human or agent lookups keep using existing tools.

**Tech Stack:** Express 5 services, Drizzle-backed company data, internal-agent tool registry, Commander onboarding assets, Vitest, Playwright E2E with fake Codex tool events.

---

## Source Of Truth Audit

- `CLAUDE.md` says UI "Team" covers the company operating surface and the product is a Hybrid Workforce OS where humans and agents work together.
- `docs/architecture/decisions.md` Decision #4 says Actor/Org was renamed to Team because Team naturally covers humans and agents.
- `docs/roadmap.md` is explicitly planned behavior only, not current truth.
- No schema change is needed. Current tables already model hierarchy:
  - `company_memberships.parentType` / `parentId` model human reporting chains.
  - `agents.parentType` / `parentId` model agent-to-human and agent-to-agent reporting.
  - legacy `agents.reportsTo` remains and is used as a fallback for agent-to-agent hierarchy.
- `server/src/services/org-hierarchy.ts` already validates parents, prevents cycles, reparents children, and walks mixed agent/user chains.
- `server/src/services/agents.ts` already exposes `orgForCompany(companyId): Promise<UnifiedOrgNode[]>`.
- `orgForCompany()`:
  - queries active users and non-terminated `kind = "org"` agents,
  - dedupes users by strongest role,
  - prefers `parentType` / `parentId`,
  - falls back to `reportsTo`,
  - promotes orphaned nodes to root.
- `server/src/routes/agents.ts` already exposes this data to the board UI at `GET /companies/:companyId/org`.
- `packages/shared/src/types/team.ts` already defines `UnifiedOrgNode` for both `nodeType: "agent"` and `nodeType: "user"`.
- Current Commander docs already say "Who is on the team?" should use `query_humans + query_agents + query_departments`, but that requires the model to stitch incompatible shapes.
- Independent subagent review agreed with this reduction: add a read-only `query_team_roster` over existing hierarchy support; do not add schema, UI, or REST routes.

## Product Decisions Locked

- Broad team/org/hierarchy questions should include both humans and agents by default.
- The Commander answer should not force the model to infer reporting lines from disconnected IDs.
- `query_humans` remains for human-only roster questions.
- `find_humans` remains for human skill/capability/person search.
- `query_human_context` remains for one human's full operational context.
- `query_agents` remains for agent-only lists.
- `query_team_roster` becomes the preferred tool for "who is on the team?", "show the hierarchy", "who reports to whom?", and mixed workforce questions.
- AoA crew/internal agents are not included in this phase unless they are `kind = "org"`; this follows the existing org chart behavior.

## Not In Scope

- No database schema or migration.
- No new REST endpoint; `/companies/:companyId/org` already exists for board UI.
- No Team UI redesign.
- No RBAC/auth redesign.
- No automatic task context injection.
- No MCP public tool exposure for external clients.
- No semantic skill matching for agents beyond whatever `query_agents` already provides.
- No department enrichment rewrite for agents. If agent department names are missing from the existing tree, keep them null in this phase and capture a follow-up if needed.

## Target Tool Contract

Tool name: `query_team_roster`

Purpose: read the company's mixed human + org-agent hierarchy in a model-friendly form.

Parameters:

```ts
{
  includeTree?: boolean; // default true
  limit?: number;        // default 100, max 200
}
```

Returned data:

```ts
{
  companyId: string;
  counts: {
    humans: number;
    agents: number;
    total: number;
  };
  roster: Array<{
    id: string;
    kind: "human" | "agent";
    name: string;
    role: string;
    title: string | null;
    status: string;
    email?: string | null;
    userRole?: "founder" | "team_lead" | "team_member";
    departmentName?: string | null;
    adapterType?: string | null;
    parent: null | {
      id: string;
      kind: "human" | "agent";
      name: string;
    };
    childCount: number;
    depth: number;
    path: string[];
  }>;
  tree?: UnifiedOrgNode[];
}
```

Output rules:

- `kind: "human"` maps from `UnifiedOrgNode.nodeType === "user"`.
- `kind: "agent"` maps from `UnifiedOrgNode.nodeType === "agent"`.
- `parent.name` is resolved while walking the existing tree, not guessed.
- Department filtering is intentionally not part of this phase because `UnifiedOrgNode` exposes `departmentName` for users but not a stable department id for agents.
- `limit` applies to flat `roster`, not the source tree.
- If the tree is empty, return success with zero counts and a clear summary.

Data flow:

```text
Commander message
  |
  v
getToolsForMessage()
  |
  v
query_team_roster tool
  |
  v
ctx.services.agents.orgForCompany(ctx.companyId)
  |
  +--> existing UnifiedOrgNode tree
          |
          +--> flatten for LLM-readable roster
          |
          +--> return original tree when includeTree !== false
```

---

### Task 1: Add Failing Unit Tests For The Roster Tool

**Files:**
- Modify: `server/src/__tests__/query-tools.test.ts`

- [ ] **Step 1: Extend the service mock with `agents.orgForCompany`**

Add this to `mockServices()`:

```ts
agents: {
  list: vi.fn().mockResolvedValue([{ id: "a1", name: "Agent 1" }]),
  orgForCompany: vi.fn().mockResolvedValue([]),
} as any,
```

- [ ] **Step 2: Update the query tool count test**

Change:

```ts
expect(tools).toHaveLength(10);
```

to:

```ts
expect(tools).toHaveLength(11);
expect(tools.map((tool) => tool.name)).toContain("query_team_roster");
```

- [ ] **Step 3: Add a mixed hierarchy behavior test**

Add:

```ts
it("query_team_roster returns humans and agents with readable parents", async () => {
  const services = mockServices();
  services.agents.orgForCompany = vi.fn().mockResolvedValue([
    {
      id: "user-founder",
      name: "Maya Founder",
      role: "founder",
      status: "active",
      nodeType: "user",
      email: "maya@example.com",
      userRole: "founder",
      departmentName: "Executive",
      children: [
        {
          id: "agent-chief",
          name: "Chief of Staff",
          role: "cxo",
          status: "idle",
          nodeType: "agent",
          adapterType: "codex_local",
          parentType: "user",
          children: [
            {
              id: "agent-research",
              name: "Research Lead",
              role: "lead",
              status: "idle",
              nodeType: "agent",
              adapterType: "claude_local",
              parentType: "agent",
              children: [],
            },
          ],
        },
      ],
    },
  ]);
  const ctx = makeCtx(services);
  const queryTeamRoster = createQueryTools().find((tool) => tool.name === "query_team_roster")!;

  const result = await queryTeamRoster.execute({}, ctx);

  expect(result.success).toBe(true);
  expect(services.agents.orgForCompany).toHaveBeenCalledWith("comp-1");
  expect((result.data as any).counts).toEqual({ humans: 1, agents: 2, total: 3 });
  expect((result.data as any).roster).toEqual([
    expect.objectContaining({
      id: "user-founder",
      kind: "human",
      name: "Maya Founder",
      parent: null,
      childCount: 1,
      depth: 0,
      path: ["Maya Founder"],
    }),
    expect.objectContaining({
      id: "agent-chief",
      kind: "agent",
      name: "Chief of Staff",
      parent: { id: "user-founder", kind: "human", name: "Maya Founder" },
      childCount: 1,
      depth: 1,
      path: ["Maya Founder", "Chief of Staff"],
    }),
    expect.objectContaining({
      id: "agent-research",
      kind: "agent",
      name: "Research Lead",
      parent: { id: "agent-chief", kind: "agent", name: "Chief of Staff" },
      childCount: 0,
      depth: 2,
      path: ["Maya Founder", "Chief of Staff", "Research Lead"],
    }),
  ]);
  expect(result.summary).toBe("Found 3 team member(s): 1 human(s), 2 agent(s)");
});
```

- [ ] **Step 4: Add limit/includeTree test**

Add:

```ts
it("query_team_roster respects limit and can omit the nested tree", async () => {
  const services = mockServices();
  services.agents.orgForCompany = vi.fn().mockResolvedValue([
    {
      id: "user-1",
      name: "Founder",
      role: "founder",
      status: "active",
      nodeType: "user",
      children: [
        { id: "agent-1", name: "Agent One", role: "general", status: "idle", nodeType: "agent", children: [] },
      ],
    },
  ]);
  const ctx = makeCtx(services);
  const queryTeamRoster = createQueryTools().find((tool) => tool.name === "query_team_roster")!;

  const result = await queryTeamRoster.execute({ limit: 1, includeTree: false }, ctx);

  expect(result.success).toBe(true);
  expect((result.data as any).roster).toHaveLength(1);
  expect((result.data as any).tree).toBeUndefined();
  expect((result.data as any).counts).toEqual({ humans: 1, agents: 1, total: 2 });
});
```

- [ ] **Step 5: Run the failing test**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts
```

Expected: FAIL because `query_team_roster` does not exist yet.

---

### Task 2: Implement `query_team_roster`

**Files:**
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`

- [ ] **Step 1: Import `UnifiedOrgNode` and add local helper types near the top of the file**

Change the shared import to include `UnifiedOrgNode`:

```ts
import type { HumanContextBundle, HumanContextResolutionResult, UnifiedOrgNode } from "@armyofagents/shared";
```

Then add:

```ts
type TeamRosterKind = "human" | "agent";

interface TeamRosterParent {
  id: string;
  kind: TeamRosterKind;
  name: string;
}

interface TeamRosterEntry {
  id: string;
  kind: TeamRosterKind;
  name: string;
  role: string;
  title: string | null;
  status: string;
  email?: string | null;
  userRole?: "founder" | "team_lead" | "team_member";
  departmentName?: string | null;
  adapterType?: string | null;
  parent: TeamRosterParent | null;
  childCount: number;
  depth: number;
  path: string[];
}
```

- [ ] **Step 2: Add a `flattenTeamTree` helper**

Add:

```ts
function nodeKind(nodeType: "agent" | "user"): TeamRosterKind {
  return nodeType === "user" ? "human" : "agent";
}

function flattenTeamTree(
  nodes: UnifiedOrgNode[],
  parent: TeamRosterParent | null = null,
  depth = 0,
  path: string[] = [],
): TeamRosterEntry[] {
  const entries: TeamRosterEntry[] = [];
  for (const node of nodes) {
    const name = typeof node.name === "string" && node.name.trim() ? node.name : node.id;
    const kind = nodeKind(node.nodeType);
    const nextPath = [...path, name];
    const children = Array.isArray(node.children) ? node.children : [];
    const entry: TeamRosterEntry = {
      id: node.id,
      kind,
      name,
      role: typeof node.role === "string" ? node.role : "",
      title: typeof node.title === "string" ? node.title : null,
      status: typeof node.status === "string" ? node.status : "",
      parent,
      childCount: children.length,
      depth,
      path: nextPath,
    };
    if (kind === "human") {
      entry.email = typeof node.email === "string" ? node.email : null;
      entry.userRole = node.userRole;
      entry.departmentName = typeof node.departmentName === "string" ? node.departmentName : null;
    } else {
      entry.adapterType = typeof node.adapterType === "string" ? node.adapterType : null;
    }
    entries.push(entry);
    entries.push(
      ...flattenTeamTree(
        children,
        { id: node.id, kind, name },
        depth + 1,
        nextPath,
      ),
    );
  }
  return entries;
}
```

- [ ] **Step 3: Insert the tool near `query_humans`**

Add this tool before `query_humans` so broad query selection hits it early:

```ts
{
  name: "query_team_roster",
  description:
    "Read the unified company team roster and hierarchy across humans and org agents. Use for broad questions like who is on the team, who reports to whom, org chart, or humans and agents together.",
  parameters: {
    type: "object",
    properties: {
      includeTree: { type: "boolean", description: "Include the nested org tree. Defaults to true." },
      limit: { type: "number", description: "Max flat roster entries to return, default 100, max 200" },
    },
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  execute: async (params: unknown, ctx) => {
    const raw = (params ?? {}) as Record<string, unknown>;
    const includeTree = raw.includeTree !== false;
    const rawLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 100;
    const limit = Math.min(Math.max(rawLimit, 1), 200);

    const tree = await ctx.services.agents.orgForCompany(ctx.companyId);
    const rosterAll = flattenTeamTree(tree);
    const roster = rosterAll.slice(0, limit);
    const counts = {
      humans: rosterAll.filter((entry) => entry.kind === "human").length,
      agents: rosterAll.filter((entry) => entry.kind === "agent").length,
      total: rosterAll.length,
    };
    return {
      success: true,
      data: {
        companyId: ctx.companyId,
        counts,
        roster,
        ...(includeTree ? { tree } : {}),
      },
      summary: `Found ${counts.total} team member(s): ${counts.humans} human(s), ${counts.agents} agent(s)`,
    };
  },
}
```

Implementation note: `ServiceContainer.agents` is already typed as `ReturnType<typeof agentService>`, so `orgForCompany` should be available without a service-container change.

- [ ] **Step 4: Run the unit tests**

Run:

```bash
pnpm --filter @armyofagents/server test -- query-tools.test.ts
```

Expected: PASS.

---

### Task 3: Wire Commander Tool Availability And Selection

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/ensure-commander.ts`
- Modify: `server/src/services/internal-agent/tool-registry.ts`
- Modify: `server/src/__tests__/tool-registry.test.ts`

- [ ] **Step 1: Add `query_team_roster` to Commander allowlist**

In `COMMANDER_TOOL_ALLOWLIST`, add it before `query_humans`:

```ts
"query_team_roster",
"query_humans",
```

- [ ] **Step 2: Add `team` and hierarchy keywords to intent matching**

In `INTENT_KEYWORDS`, add a query category:

```ts
query: ["team", "org", "organization", "hierarchy", "reports to", "roster", "humans", "people", "agents"],
```

This keeps broad team questions from depending on the "no matched category" fallback.

- [ ] **Step 3: Update the registry count test**

In `server/src/__tests__/tool-registry.test.ts`, change:

```ts
it("returns all 78 tools", () => {
...
expect(tools).toHaveLength(78);
```

to:

```ts
it("returns all 79 tools", () => {
...
// Unified team roster added 1 query tool:
// query_team_roster (humans + org agents + readable hierarchy).
expect(tools).toHaveLength(79);
```

- [ ] **Step 4: Add selection behavior test**

Add:

```ts
it("includes query_team_roster for broad team hierarchy questions", () => {
  const tools = getToolsForMessage("who is on the team and who reports to whom?", allTools);
  const names = tools.map((tool) => tool.name);
  expect(names).toContain("query_team_roster");
});
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @armyofagents/server test -- tool-registry.test.ts query-tools.test.ts
```

Expected: PASS.

---

### Task 4: Update Commander Guidance

**Files:**
- Modify: `server/src/onboarding-assets/commander/AGENTS.md`
- Modify: `server/src/onboarding-assets/commander/TOOLS.md`
- Modify: `server/src/onboarding-assets/commander/SOUL.md`
- Modify: `server/src/__tests__/commander-tools-md.test.ts`

- [ ] **Step 1: Update tool count and query list**

In `TOOLS.md`, change "36 tools" to "37 tools" for Commander-visible tools and add:

```md
| `query_team_roster` | Unified human + org-agent team roster with readable reporting hierarchy |
```

- [ ] **Step 2: Update behavioral guide**

In `AGENTS.md`, replace the current "Who is on the team?" row:

```md
| Who is on the team? | `query_humans` + `query_agents` + `query_departments` |
```

with:

```md
| Who is on the team? Who reports to whom? | `query_team_roster` |
```

Add a short rule:

```md
For broad team, org chart, roster, or reporting-line questions, call `query_team_roster` first. Use `query_humans` only for humans-only lists and `query_agents` only for agents-only lists.
```

- [ ] **Step 3: Update SOUL tool count**

Change "The 36 tools in TOOLS.md" to "The 37 tools in TOOLS.md".

- [ ] **Step 4: Update docs test expectations**

Update `server/src/__tests__/commander-tools-md.test.ts` so it expects `query_team_roster` and the new visible count.

- [ ] **Step 5: Run focused docs tests**

Run:

```bash
pnpm --filter @armyofagents/server test -- commander-tools-md.test.ts
```

Expected: PASS.

---

### Task 5: Add Codex-Mode E2E For Unified Team Awareness

**Files:**
- Add: `tests/e2e/commander-codex-team-roster.spec.ts`
- Modify only if needed: `tests/e2e/fixtures/fake-codex/fake-codex.mjs`
- Modify only if needed: `tests/e2e/helpers/fake-codex.ts`

- [ ] **Step 1: Add fake Codex script fixture**

Use the existing fake Codex support for multiple tool calls. The script should emit a `query_team_roster` call and result:

```ts
toolCalls: [
  {
    name: "query_team_roster",
    arguments: {},
    result: {
      companyId: "e2e-company",
      counts: { humans: 1, agents: 1, total: 2 },
      roster: [
        { id: "local-board", kind: "human", name: "Live Codex Human", role: "founder", status: "active", parent: null, childCount: 1, depth: 0, path: ["Live Codex Human"] },
        { id: "agent-codex", kind: "agent", name: "Codex Agent", role: "general", status: "idle", parent: { id: "local-board", kind: "human", name: "Live Codex Human" }, childCount: 0, depth: 1, path: ["Live Codex Human", "Codex Agent"] },
      ],
    },
  },
]
```

- [ ] **Step 2: Add browser E2E**

The test should:

1. Start isolated E2E app.
2. Configure Commander to Codex.
3. Open `/:companyPrefix/commander`.
4. Ask: `Who is on the team and who reports to whom?`
5. Verify the visible transcript includes a tool-use chip or text for `query_team_roster`.
6. Verify the assistant answer mentions both the human and agent.
7. Fetch `/api/companies/:companyId/internal-agent/runs`.
8. Assert latest `toolsCalled` includes `query_team_roster`.

- [ ] **Step 3: Run the focused E2E**

Run:

```bash
AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e commander-codex-team-roster.spec.ts
```

Expected: PASS.

---

### Task 6: Full Verification

**Files:** no production files unless failures reveal a real bug.

- [ ] **Step 1: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 2: Unit/integration suite**

Run:

```bash
pnpm test:run
```

Expected: PASS.

- [ ] **Step 3: Focused E2E**

Run:

```bash
AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e commander-codex-team-roster.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Build**

Run:

```bash
pnpm build
```

Expected: PASS.

## Test Coverage Diagram

```text
CODE PATHS                                           TESTS
[+] createQueryTools()
  |-- query_team_roster registered                   query-tools.test.ts
  |-- all query tools read-only                      query-tools.test.ts

[+] query_team_roster.execute()
  |-- valid empty org tree                           query-tools.test.ts (add if not covered by count test)
  |-- mixed human -> agent -> agent tree             query-tools.test.ts
  |-- includeTree false                              query-tools.test.ts
  |-- limit clamps flat roster                       query-tools.test.ts
  |-- no stable agent department id invented         source-truth review

[+] getToolsForMessage()
  |-- broad team/hierarchy question includes tool    tool-registry.test.ts
  |-- max 15 tool cap still respected                existing tool-registry.test.ts

[+] Commander prompt/tool docs
  |-- tool exists in TOOLS.md                         commander-tools-md.test.ts
  |-- count updated                                  commander-tools-md.test.ts

[+] Codex Commander UI flow
  |-- fake Codex emits query_team_roster             commander-codex-team-roster.spec.ts
  |-- UI shows tool use                              commander-codex-team-roster.spec.ts
  |-- run persists toolsCalled                       commander-codex-team-roster.spec.ts
```

## Failure Modes

- `orgForCompany()` returns an orphaned node promoted to root. The tool should not invent a parent; parent stays null.
- `orgForCompany()` returns duplicate users from multiple role rows. Existing service dedupes by role priority; the tool should not rededupe differently.
- Large orgs exceed prompt budget. `limit` defaults to 100 and caps at 200; `includeTree: false` allows compact retrieval.
- Broad team questions miss the tool because intent matching excludes "team". Add query keywords and an explicit registry test.
- Codex fake output proves UI trace only, not model reasoning quality. The E2E must also verify persisted `toolsCalled`.

## Review Notes

- Scope challenge: accepted reduced scope. Reuse `orgForCompany()` and `/companies/:companyId/org` behavior instead of building another org service.
- Architecture review: no schema or route needed; one thin internal-agent tool is the smallest correct surface.
- Code quality review: keep flattening local to `query-tools.ts` unless another caller appears. Do not introduce a new shared abstraction prematurely.
- Test review: unit tests cover output shape and selection; docs tests cover prompt/tool drift; E2E covers Codex-mode tool trace and UI behavior.
- Performance review: `orgForCompany()` already does two parallel queries. This phase adds an in-memory tree walk only.
- Outside voice: subagent Rawls reviewed source and agreed with the scope reduction and tool approach.

## Implementation Order

1. Unit tests for `query_team_roster`.
2. Tool implementation.
3. Commander allowlist and tool-selection routing.
4. Commander docs/tests.
5. Codex E2E.
6. Full verification.

Sequential implementation is recommended. The touched files are small, but most tasks share `query-tools.ts`, Commander docs, and test expectations, so parallel worktrees would create unnecessary merge friction.

# Task Responsible Human Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit task-level Responsible Human so AoA can distinguish who executes work from which human is accountable for the outcome.

**Architecture:** Add `issues.responsible_user_id` as a nullable company-validated human accountability field, separate from `assignee_agent_id`, `assignee_user_id`, and `reviewer_user_id`. Default it conservatively from direct human assignment or the assigned agent's nearest human manager, but allow board users with task-assignment permission to override it. Surface it in task APIs, task detail UI, Commander tools, and activity/audit output without changing heartbeat execution semantics.

**Tech Stack:** Drizzle ORM migrations, Express 5 routes/services, shared zod validators/types, React/Vite task UI, TanStack Query, Vitest, Playwright E2E.

---

## Source Of Truth Audit

- `CLAUDE.md` says tasks are the unit of work and "Tasks don't care who does them", but current execution fields still distinguish `assigneeAgentId` and `assigneeUserId`.
- `packages/db/src/schema/issues.ts` currently has:
  - `assigneeAgentId`: agent executor.
  - `assigneeUserId`: human executor / human handoff target.
  - `reviewerUserId`: review-specific human, present but not used as general accountability.
- `server/src/services/issues.ts` enforces that a task can have only one executor: `assigneeAgentId` XOR `assigneeUserId`.
- `server/src/routes/issues.ts` wakes agents only from `assigneeAgentId`; changing a responsible human must not wake an agent.
- `ui/src/components/IssueProperties.tsx` shows one `Assignee` row that mixes agent assignment and limited human assignment.
- Human profile pages already compute direct agent trees and human responsibility summaries from `company_memberships.parentType/parentId` and agent org fields.
- Commander now has `query_team_roster`, `find_humans`, and `query_human_context`, which become useful inputs for a later assignment intelligence phase.

## Product Decisions Locked For This Scope

- `assigneeAgentId` and `assigneeUserId` remain executor fields.
- `responsibleUserId` is the new accountable human field.
- `responsibleUserId` is nullable for backwards compatibility and import safety.
- `responsibleUserId` is service-validated against active company membership instead of DB-FK constrained, matching the existing `assigneeUserId` task field and avoiding brittle local/import principal edge cases.
- When a human is directly assigned via `assigneeUserId`, the default responsible human is that same human.
- When an agent is assigned via `assigneeAgentId`, the default responsible human is the nearest human manager in the agent's `parentType/parentId` chain.
- When no human manager is found, default to the company founder if available; otherwise leave null.
- Users with `tasks:assign` permission can override `responsibleUserId`.
- `reviewerUserId` stays review-specific and must not be repurposed.
- UI label is **Responsible** or **Responsible human**, not just **Human**.
- The Task slide-over must show the executor and responsible human as separate rows.

## Not In Scope

- No automatic "best owner" recommendation engine.
- No workload balancing or capacity scoring.
- No required owner enforcement for all historical tasks.
- No RBAC redesign.
- No auth-provider signup/invite redesign.
- No HR module.
- No automatic task context injection.
- No change to heartbeat assignment, checkout, or single-assignee invariants.

## Data Model

New field:

```ts
responsibleUserId: text("responsible_user_id")
```

Index:

```ts
responsibleUserStatusIdx: index("issues_company_responsible_user_status_idx").on(
  table.companyId,
  table.responsibleUserId,
  table.status,
)
```

Why `responsibleUserId`, not `ownerUserId`:
- "Responsible" is task-specific and reads well beside Assignee and Reviewer.
- "Owner" already appears in Hub, thread ownership, plugin/package metadata, and workspace ownership.
- "Responsible human" makes the human accountability meaning explicit in UI and Commander responses.

## Defaulting Rules

Central helper:

```ts
resolveResponsibleUserIdForTask(companyId, {
  assigneeUserId,
  assigneeAgentId,
  explicitResponsibleUserId,
})
```

Rules:

1. If `explicitResponsibleUserId` is provided, validate active company membership and use it.
2. If `explicitResponsibleUserId === null`, preserve null. Explicit clear means clear.
3. If `assigneeUserId` is set and `responsibleUserId` is omitted, use `assigneeUserId`.
4. If `assigneeAgentId` is set and `responsibleUserId` is omitted, walk the agent parent chain:
   - `parentType === "user"` -> use `parentId`.
   - `parentType === "agent"` -> continue to that agent.
   - fallback from legacy `reportsTo` for agent parents.
   - stop at 50 hops and return null if cyclic/broken.
5. If no human manager is found, use founder user id if exactly one active founder exists.
6. Otherwise return null.

On reassignment:

- If caller explicitly includes `responsibleUserId`, use it.
- If executor changes and caller omits `responsibleUserId`, recompute from the new executor.
- If executor does not change and caller omits `responsibleUserId`, preserve the existing value.
- If caller sends `responsibleUserId: null`, clear it.

## File Map

### Database

- Modify `packages/db/src/schema/issues.ts`
  - Add `responsibleUserId`.
  - Add `issues_company_responsible_user_status_idx`.
- Generate migration with `pnpm db:generate`.

### Shared Contracts

- Modify `packages/shared/src/types/issue.ts`
  - Add `responsibleUserId: string | null` to `Issue` and `IssueAncestor` if ancestor selection includes it.
- Modify `packages/shared/src/validators/issue.ts`
  - Add `responsibleUserId` to create/update schemas.
- Modify task list filter types if a shared filter contract exists in the touched API layer.
- Modify `docs/api/issues.md`
  - Document create/update/list field.
- Modify `docs/api/mcp.md`
  - Document MCP task create/update/list field if MCP tools expose task schemas from shared contracts.

### Server

- Modify `server/src/services/issues.ts`
  - Add active company-member validation for responsible user.
  - Add resolver for default responsible human.
  - Use resolver in create/update.
  - Add `responsibleUserId` list filter support.
- Modify `server/src/routes/issues.ts`
  - Gate `responsibleUserId` changes behind `tasks:assign`.
  - Parse `?responsibleUserId=` list filters, including `me` for board actors.
  - Log `responsibleUserId` changes in `issue.updated` activity details.
  - Do not trigger agent wakeups from responsible-user-only changes.
- Modify `server/src/services/internal-agent/tools/*task*`
  - Add `responsibleUserId` to Commander create/update task tools.
  - Add readable task output field where query tools return task details.

### UI

- Modify `ui/src/components/IssueProperties.tsx`
  - Keep `Assignee` as executor.
  - Add `Responsible` row under Assignee.
  - Responsible picker lists active humans, not agents.
  - Show fallback labels via real team member display names, not `local-board -> Board`.
- Modify `ui/src/components/TaskDetail.tsx` and `ui/src/pages/IssueDetail.tsx` only if they duplicate issue property handling.
- Modify `ui/src/components/NewIssueDialog.tsx`
  - Show responsible human control near assignee, defaulted after selecting an assignee.
  - Allow explicit override/clear.
- Modify `ui/src/api/issues.ts`
  - Ensure create/update payloads carry `responsibleUserId`.
- Modify `ui/src/lib/queryKeys.ts` only if a new humans lookup query is needed.

### Tests

- Add/modify server unit and integration tests under `server/src/__tests__/`.
- Add shared schema tests under `packages/shared/src/__tests__/` or existing issue validator tests.
- Add UI unit tests under `ui/src/__tests__/` and/or component-local tests.
- Add Playwright E2E under `tests/e2e/task-responsible-human.spec.ts`.

---

## Task 1: Shared Contract TDD

**Files:**
- Modify: `packages/shared/src/validators/issue.ts`
- Modify: `packages/shared/src/types/issue.ts`
- Modify: `packages/plugins/sdk/src/testing.ts` (typed Issue fixture compatibility)
- Create: `packages/shared/src/__tests__/issue-responsible-user-schema.test.ts`

- [ ] **Step 1: Add failing shared validator tests**

Create or extend a shared test with:

```ts
import { describe, expect, it } from "vitest";
import { createIssueSchema, updateIssueSchema } from "../validators/issue.js";

describe("issue responsible user schema", () => {
  it("accepts responsibleUserId on task creation", () => {
    const parsed = createIssueSchema.parse({
      title: "Prepare investor update",
      responsibleUserId: "user-1",
    });
    expect(parsed.responsibleUserId).toBe("user-1");
  });

  it("accepts clearing responsibleUserId on task update", () => {
    const parsed = updateIssueSchema.parse({ responsibleUserId: null });
    expect(parsed.responsibleUserId).toBeNull();
  });
});
```

- [ ] **Step 2: Run failing shared tests**

Run:

```bash
pnpm test:run packages/shared/src/__tests__/issue-responsible-user-schema.test.ts
```

Expected: FAIL because `responsibleUserId` is stripped or absent.

- [ ] **Step 3: Add contract fields**

In `packages/shared/src/validators/issue.ts`, add to `createIssueSchema`:

```ts
responsibleUserId: z.string().optional().nullable(),
```

In `packages/shared/src/types/issue.ts`, add to `Issue`:

```ts
responsibleUserId: string | null;
```

If `IssueAncestor` rows select task assignment fields for parent display, add:

```ts
responsibleUserId: string | null;
```

- [ ] **Step 4: Run shared tests**

Run:

```bash
pnpm test:run packages/shared/src/__tests__/issue-responsible-user-schema.test.ts
pnpm -r typecheck
```

Expected: shared test passes; typecheck may still fail until DB/server layers are updated.

## Task 2: Database Schema And Migration

**Files:**
- Modify: `packages/db/src/schema/issues.ts`
- Generated: `packages/db/src/migrations/*.sql`
- Generated: `packages/db/src/migrations/meta/*.json`
- Modify: `packages/db/src/migrations/meta/_journal.json`

- [ ] **Step 1: Add schema field and index**

In `packages/db/src/schema/issues.ts`, add near `assigneeUserId`:

```ts
responsibleUserId: text("responsible_user_id"),
```

Add the index:

```ts
responsibleUserStatusIdx: index("issues_company_responsible_user_status_idx").on(
  table.companyId,
  table.responsibleUserId,
  table.status,
),
```

- [ ] **Step 2: Generate migration**

Run:

```bash
pnpm db:generate
```

Expected: new migration adds `responsible_user_id` and index.

- [ ] **Step 3: Inspect migration**

Run:

```bash
git diff -- packages/db/src/schema/issues.ts packages/db/src/migrations packages/db/src/migrations/meta
```

Expected:
- No hand-written raw migration.
- `responsible_user_id` is nullable.
- No DB foreign key is added for `responsible_user_id`; service logic validates active company membership.
- Index includes `company_id`, `responsible_user_id`, `status`.

## Task 3: Server Responsibility Resolver TDD

**Files:**
- Modify: `server/src/services/issues.ts`
- Test: `server/src/__tests__/issues-responsible-user.test.ts`

- [ ] **Step 1: Add failing resolver tests**

Add tests for:

1. Human assignee defaults responsible user to same human.
2. Agent assignee defaults responsible user to nearest human manager.
3. Explicit responsible user overrides default.
4. Explicit null clears responsible user.
5. Out-of-company or inactive responsible user rejects.
6. Broken/cyclic agent hierarchy does not hang.

Representative assertions:

```ts
expect(created.assigneeUserId).toBe("user-1");
expect(created.responsibleUserId).toBe("user-1");

expect(created.assigneeAgentId).toBe("agent-1");
expect(created.responsibleUserId).toBe("manager-user");

await expect(
  svc.create(companyId, { title: "Bad owner", responsibleUserId: "other-company-user" }),
).rejects.toMatchObject({ status: 404 });
```

- [ ] **Step 2: Run failing server tests**

Run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user.test.ts
```

Expected: FAIL because service has no `responsibleUserId` behavior.

- [ ] **Step 3: Implement validation and resolver**

In `server/src/services/issues.ts`, add:

```ts
async function assertResponsibleUser(companyId: string, userId: string) {
  await assertAssignableUser(companyId, userId);
}
```

Add a private helper that walks agent parents:

```ts
async function findNearestHumanManagerForAgent(companyId: string, agentId: string): Promise<string | null> {
  const seen = new Set<string>();
  let currentAgentId: string | null = agentId;
  for (let depth = 0; currentAgentId && depth < 50; depth += 1) {
    if (seen.has(currentAgentId)) return null;
    seen.add(currentAgentId);

    const row = await db
      .select({
        parentType: agents.parentType,
        parentId: agents.parentId,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(and(eq(agents.id, currentAgentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!row) return null;
    if (row.parentType === "user" && row.parentId) return row.parentId;
    if (row.parentType === "agent" && row.parentId) {
      currentAgentId = row.parentId;
      continue;
    }
    currentAgentId = row.reportsTo ?? null;
  }
  return null;
}
```

Add founder fallback:

```ts
async function findSingleFounderUserId(companyId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")));
  const unique = [...new Set(rows.map((row) => row.userId))];
  return unique.length === 1 ? unique[0] : null;
}
```

Add resolver:

```ts
async function resolveResponsibleUserId(input: {
  companyId: string;
  explicitResponsibleUserId?: string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
  existingResponsibleUserId?: string | null;
  executorChanged?: boolean;
}): Promise<string | null | undefined> {
  if (input.explicitResponsibleUserId !== undefined) {
    if (input.explicitResponsibleUserId) await assertResponsibleUser(input.companyId, input.explicitResponsibleUserId);
    return input.explicitResponsibleUserId;
  }

  if (!input.executorChanged && input.existingResponsibleUserId !== undefined) {
    return undefined;
  }

  if (input.assigneeUserId) return input.assigneeUserId;
  if (input.assigneeAgentId) {
    const manager = await findNearestHumanManagerForAgent(input.companyId, input.assigneeAgentId);
    return manager ?? await findSingleFounderUserId(input.companyId);
  }
  return null;
}
```

- [ ] **Step 4: Wire create/update**

Create:

```ts
const resolvedResponsibleUserId = await resolveResponsibleUserId({
  companyId,
  explicitResponsibleUserId: (issueData as { responsibleUserId?: string | null }).responsibleUserId,
  assigneeUserId: (issueData as { assigneeUserId?: string | null }).assigneeUserId ?? null,
  assigneeAgentId: (issueData as { assigneeAgentId?: string | null }).assigneeAgentId ?? null,
  executorChanged: true,
});
if (resolvedResponsibleUserId !== undefined) {
  (issueData as Record<string, unknown>).responsibleUserId = resolvedResponsibleUserId;
}
```

Update:

```ts
const executorChanged =
  issueData.assigneeAgentId !== undefined ||
  issueData.assigneeUserId !== undefined;
const resolvedResponsibleUserId = await resolveResponsibleUserId({
  companyId: existing.companyId,
  explicitResponsibleUserId: (issueData as { responsibleUserId?: string | null }).responsibleUserId,
  assigneeUserId: nextAssigneeUserId,
  assigneeAgentId: nextAssigneeAgentId,
  existingResponsibleUserId: existing.responsibleUserId,
  executorChanged,
});
if (resolvedResponsibleUserId !== undefined) {
  (issueData as Record<string, unknown>).responsibleUserId = resolvedResponsibleUserId;
}
```

- [ ] **Step 5: Run server tests**

Run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user.test.ts
```

Expected: PASS.

## Task 4: Route Permissions And Activity Logging

**Files:**
- Modify: `server/src/routes/issues.ts`
- Test: `server/src/__tests__/issues-responsible-user-routes.test.ts`

- [ ] **Step 1: Add failing route tests**

Cover:

1. Board user with task assignment permission can set `responsibleUserId`.
2. Non-assigning user cannot change `responsibleUserId`.
3. Responsible-only change does not wake assigned agent.
4. Activity log contains previous and next responsible user.
5. `GET /companies/:companyId/issues?responsibleUserId=user-1` filters accountable work.
6. `GET /companies/:companyId/issues?responsibleUserId=me` resolves to the current board user and rejects non-board actors.

- [ ] **Step 2: Gate responsible changes**

In create route:

```ts
if (req.body.responsibleUserId !== undefined || req.body.assigneeUserId || (req.body.assigneeAgentId && req.actor.type !== "agent")) {
  await assertCanAssignTasks(req, companyId);
}
```

In update route:

```ts
const responsibleWillChange =
  req.body.responsibleUserId !== undefined &&
  req.body.responsibleUserId !== existing.responsibleUserId;

if (assigneeWillChange || responsibleWillChange) {
  if (!isAgentReturningIssueToCreator) {
    await assertCanAssignTasks(req, existing.companyId);
  }
}
```

- [ ] **Step 3: Ensure wakeup remains executor-only**

Keep:

```ts
const assigneeChanged = assigneeWillChange;
```

Do not include `responsibleWillChange` in wakeup logic.

- [ ] **Step 4: Add activity details**

When logging `issue.updated`, include:

```ts
responsibleUserId:
  req.body.responsibleUserId === undefined ? "__omitted__" : req.body.responsibleUserId,
previousResponsibleUserId: existing.responsibleUserId,
```

Use the existing activity style in the file.

- [ ] **Step 5: Add list filter parsing**

Mirror the existing `assigneeUserId=me` behavior:

```ts
const responsibleUserFilterRaw = req.query.responsibleUserId as string | undefined;
const responsibleUserId =
  responsibleUserFilterRaw === "me" && req.actor.type === "board"
    ? req.actor.userId
    : responsibleUserFilterRaw;

if (responsibleUserFilterRaw === "me" && (!responsibleUserId || req.actor.type !== "board")) {
  res.status(403).json({ error: "responsibleUserId=me requires board authentication" });
  return;
}
```

Pass it into `svc.list`:

```ts
responsibleUserId,
```

- [ ] **Step 6: Add service list predicate**

In `IssueFilters`, add:

```ts
responsibleUserId?: string;
```

In list condition building, add:

```ts
if (filters?.responsibleUserId) {
  conditions.push(eq(issues.responsibleUserId, filters.responsibleUserId));
}
```

- [ ] **Step 7: Run route tests**

Run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user-routes.test.ts
```

Expected: PASS.

## Task 5: UI Task Detail Responsible Picker

**Files:**
- Modify: `ui/src/components/IssueProperties.tsx`
- Modify: `ui/src/api/issues.ts`
- Test: `ui/src/__tests__/IssueProperties.test.tsx`
- Test: `ui/src/__tests__/TaskSlideOver.test.tsx`

- [ ] **Step 1: Add failing UI tests**

Tests:

1. Agent assigned task shows Assignee as agent and Responsible as the human manager.
2. Human assigned task shows Responsible as the same human by default.
3. Changing Responsible sends only `{ responsibleUserId }`.
4. Clearing Responsible sends `{ responsibleUserId: null }`.
5. The UI never displays `Human: Board`.

- [ ] **Step 2: Load human options**

Use `teamApi.listTeam(companyId)` from the human page work and map:

```ts
const humanOptions = (teamSummary?.members ?? []).map((member) => ({
  id: member.userId,
  label: member.displayName ?? member.email ?? member.userId.slice(0, 8),
  title: member.title,
  role: member.role,
}));
```

- [ ] **Step 3: Add display helper**

```ts
const responsibleUserLabel = (userId: string | null | undefined) => {
  if (!userId) return null;
  const member = humanOptions.find((option) => option.id === userId);
  return member?.label ?? userId.slice(0, 8);
};
```

Do not special-case `local-board` as `Board` in the Responsible row.

- [ ] **Step 4: Add Responsible picker row**

Render immediately under Assignee:

```tsx
<PropertyPicker
  inline={inline}
  label="Responsible"
  open={responsibleOpen}
  onOpenChange={(open) => { setResponsibleOpen(open); if (!open) setResponsibleSearch(""); }}
  triggerContent={responsibleTrigger}
  popoverClassName="w-56"
>
  {responsibleContent}
</PropertyPicker>
```

Picker content:

```tsx
<button
  className={cn("flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50", !issue.responsibleUserId && "bg-accent")}
  onClick={() => { onUpdate({ responsibleUserId: null }); setResponsibleOpen(false); }}
>
  No responsible human
</button>
{humanOptions.filter(...).map((human) => (
  <button
    key={human.id}
    className={cn("flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50", human.id === issue.responsibleUserId && "bg-accent")}
    onClick={() => { onUpdate({ responsibleUserId: human.id }); setResponsibleOpen(false); }}
  >
    <User className="h-3 w-3 shrink-0 text-muted-foreground" />
    <span className="truncate">{human.label}</span>
  </button>
))}
```

- [ ] **Step 5: Run UI tests**

Run:

```bash
pnpm test:run ui/src/__tests__/IssueProperties.test.tsx ui/src/__tests__/TaskSlideOver.test.tsx
```

Expected: PASS.

## Task 6: New Task Dialog Responsible Human

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx`
- Test: `ui/src/__tests__/NewIssueDialog.test.tsx`

- [ ] **Step 1: Add failing tests**

Cover:

1. Selecting a human assignee sets `assigneeUserId` and responsible human defaults to that human.
2. Selecting an agent leaves `assigneeAgentId` as executor and allows selecting a responsible human.
3. Creating task sends `responsibleUserId`.

- [ ] **Step 2: Add responsible state**

```ts
const [responsibleUserId, setResponsibleUserId] = useState("");
```

When assignee changes:

```ts
if (selectedHumanId && !responsibleUserId) {
  setResponsibleUserId(selectedHumanId);
}
```

When submitting:

```ts
responsibleUserId: responsibleUserId || undefined,
```

- [ ] **Step 3: Keep server as source of default truth**

The UI may suggest a default, but server defaulting remains authoritative. If the UI cannot infer the manager for an agent, omit `responsibleUserId` and let the server resolve it.

- [ ] **Step 4: Run dialog tests**

Run:

```bash
pnpm test:run ui/src/__tests__/NewIssueDialog.test.tsx
```

Expected: PASS.

## Task 7: Commander Task Tools Contract

**Files:**
- Modify: `server/src/services/internal-agent/tools/action-tools.ts`
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Modify: `server/src/onboarding-assets/commander/AGENTS.md`
- Modify: `server/src/onboarding-assets/commander/TOOLS.md`
- Test: `server/src/__tests__/action-tools.test.ts`
- Test: `server/src/__tests__/query-tools.test.ts`
- Test: `server/src/__tests__/commander-tools-md.test.ts`

- [ ] **Step 1: Add failing Commander tool tests**

Tests:

1. `create_task` accepts `responsibleUserId`.
2. `update_task` accepts `responsibleUserId`.
3. `query_tasks` returns `responsibleUserId`.
4. Commander docs mention assignee vs responsible human.

- [ ] **Step 2: Update tool schemas**

For create/update task parameters:

```ts
responsibleUserId: {
  type: "string",
  description: "Human accountable for the task outcome. Separate from the executor assignee. Send null in update_task to clear.",
},
```

The current Commander tool schemas are JSON-schema-like but execution receives raw params. Keep the schema field simple for discoverability, and in `execute` preserve an explicit `responsibleUserId: null` update so Commander can clear the field.

- [ ] **Step 3: Update Commander guidance**

Add:

```md
Task ownership has three distinct concepts:
- Assignee: the executor, either an agent or a human.
- Responsible human: the accountable human for outcome/escalation.
- Reviewer: the human expected to review output.

When assigning an agent to execute work, set or preserve a responsible human when the user names one. If unsure, ask or let the server default to the agent's nearest human manager.
```

- [ ] **Step 4: Run Commander tests**

Run:

```bash
pnpm test:run server/src/__tests__/action-tools.test.ts server/src/__tests__/query-tools.test.ts server/src/__tests__/commander-tools-md.test.ts
```

Expected: PASS.

## Task 8: Documentation Updates

**Files:**
- Modify: `docs/guides/board-operator/managing-tasks.md`
- Modify: `docs/api/issues.md`
- Modify: `docs/api/mcp.md`
- Optional: `CLAUDE.md` if source-of-truth schema table needs the field.

- [ ] **Step 1: Update board guide**

Document:

```md
- **Assignee** - the executor doing the work, either an agent or a human.
- **Responsible human** - the human accountable for the task outcome and escalation.
- **Reviewer** - the human expected to review the output, when review is needed.
```

- [ ] **Step 2: Update API docs**

Add `responsibleUserId` to create/update/list field tables.

- [ ] **Step 3: Run docs-adjacent tests**

Run:

```bash
pnpm test:run server/src/__tests__/commander-tools-md.test.ts
```

Expected: PASS.

## Task 9: End-To-End Verification

**Files:**
- Add: `tests/e2e/task-responsible-human.spec.ts`

- [ ] **Step 1: Add Playwright E2E**

Scenario:

1. Start isolated app.
2. Seed/create company with at least one real human membership and one org agent reporting to that human.
3. Create a task assigned to the agent.
4. Open task slide-over.
5. Verify Assignee shows the agent.
6. Verify Responsible shows the human manager, not `Board`.
7. Change Responsible to another active human.
8. Reload task.
9. Verify Responsible persisted.
10. Verify latest task JSON has `responsibleUserId`.

- [ ] **Step 2: Add API-level E2E assertion**

Fetch:

```ts
const task = await request.get(`/api/issues/${taskId}`).then((res) => res.json());
expect(task.responsibleUserId).toBe(otherHumanId);
```

- [ ] **Step 3: Run E2E**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

Expected: PASS.

## Task 10: Full Verification

**Files:** no code changes unless failures reveal a real issue.

- [ ] **Step 1: Focused tests**

Run:

```bash
pnpm test:run packages/shared/src/__tests__/issue-responsible-user-schema.test.ts server/src/__tests__/issues-responsible-user.test.ts server/src/__tests__/issues-responsible-user-routes.test.ts ui/src/__tests__/IssueProperties.test.tsx ui/src/__tests__/NewIssueDialog.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Typecheck**

Run:

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 3: Full unit/integration suite**

Run:

```bash
pnpm test:run
```

Expected: PASS.

- [ ] **Step 4: Focused E2E**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Build**

Run:

```bash
pnpm build
```

Expected: PASS.

## Test Coverage Matrix

```text
CODE PATH                                           TEST
packages/shared validators                          issue-responsible-user-schema.test.ts
packages/db schema/migration                        db:generate + typecheck
issueService.create default human assignee           issues-responsible-user.test.ts
issueService.create default agent manager            issues-responsible-user.test.ts
issueService.update executor change recompute        issues-responsible-user.test.ts
issueService.update explicit override/clear          issues-responsible-user.test.ts
route permission gate                                issues-responsible-user-routes.test.ts
responsible-only update does not wake agent          issues-responsible-user-routes.test.ts
Task slide-over displays separate fields             IssueProperties/TaskSlideOver tests
New Task dialog sends responsibleUserId              NewIssueDialog.test.tsx
Commander create/update tool contract                action-tools.test.ts
Commander query returns field                        query-tools.test.ts
Commander docs drift                                 commander-tools-md.test.ts
Browser persistence                                  task-responsible-human.spec.ts
```

## Failure Modes

- **Responsible user gets mistaken for executor:** UI must keep separate rows and server must keep single executor invariant unchanged.
- **Responsible-only changes wake agents:** route tests must assert no wakeup.
- **`local-board` leaks into human accountability UI:** UI tests must assert no `Human: Board` or `Responsible: Board` fallback.
- **Agent hierarchy is broken or cyclic:** resolver caps at 50 hops and returns founder/null fallback.
- **Out-of-company responsible user leaks tenant data:** service validation returns not found / unprocessable without revealing cross-company existence.
- **Historical tasks lack responsible user:** nullable field keeps old data safe; UI shows `No responsible human`.
- **Commander over-mutates ownership:** prompt guidance says set responsible user only when user names one or when creating/assigning and server can default.

## Review Notes

### Scope Challenge

Accepted reduced foundation scope: implement the task ownership data model and UI clarity first. Defer assignment intelligence, capacity scoring, and automatic context injection.

### Architecture Review

- `responsibleUserId` is the correct new field because the existing executor fields are mutually exclusive and already feed heartbeat/task permissions.
- `reviewerUserId` is not a substitute because review is a workflow stage, not outcome accountability.
- Defaulting belongs server-side so Commander, UI, MCP, and import paths behave consistently.
- Responsible-user updates must share the `tasks:assign` permission gate because assigning accountability is operational authority.

### Code Quality Review

- Keep hierarchy walking private to `issueService` unless a second caller needs it.
- Do not duplicate the org tree flattener from `query_team_roster`; this resolver needs a single nearest human, not a display tree.
- Keep UI display helpers local unless multiple task surfaces duplicate them after implementation.

### Test Review

Coverage includes schema, service, route authorization, UI unit tests, Commander contract tests, E2E persistence, typecheck, full tests, and build.

### Performance Review

The resolver runs on task create/update only. Agent parent walking is bounded at 50 rows and only happens when assigning an agent without an explicit responsible user. No list-page N+1 should be introduced; task list simply reads the stored field.

### Follow-Up After This Scope

Once this lands, the next product scope can be Commander Assignment Intelligence:

- Ask "who should own this?"
- Query roster + human context + agent list.
- Recommend executor and responsible human separately.
- Create/update tasks with explicit evidence.

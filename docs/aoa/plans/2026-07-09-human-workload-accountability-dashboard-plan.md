# Human Workload Accountability Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the specific Human Detail Overview tab into a workload and accountability dashboard without moving task-editing actions out of the task slide-over.

**Architecture:** Add a company-scoped Human workload service contract under the existing Team API, then make `HumanDetail` consume that single contract for Overview workload sections. Keep task mutation actions in existing task detail surfaces; this dashboard only summarizes and navigates.

**Tech Stack:** Express 5 routes, Drizzle ORM, shared TypeScript contracts, React + Vite + TanStack Query, Vitest, Playwright E2E.

---

## Source Of Truth

- `CLAUDE.md` says UI calls these records "Tasks", while DB/API stay `issues` and `/issues`.
- `packages/db/src/schema/issues.ts` already has `assigneeAgentId`, `assigneeUserId`, `responsibleUserId`, `priority`, `status`, `dueDate`, and indexes for responsible and human assignee filters.
- `packages/shared/src/types/issue.ts` exposes all fields needed for dashboard cards.
- `server/src/services/issues.ts` already supports filters for `assigneeAgentId`, `assigneeUserId`, `responsibleUserId`, and `createdByUserId`.
- `server/src/services/team.ts` already has `getReportsFor(companyId, userId)` and `getDependencies(companyId, userId)`, but dependencies only count assigned/created tasks.
- `ui/src/pages/HumanDetail.tsx` currently fetches responsible, assigned, created, and agent-tree tasks separately and renders simple `TaskListSection` cards.
- `tests/e2e/task-responsible-human.spec.ts` already verifies responsible human defaulting, slide-over editing, human task assignment, and Human Overview visibility.
- Product decision: Human Overview is a visibility/accountability surface. Task editing remains in the task slide-over.

## Final Product Scope

In scope:

- Existing Human Detail `Overview` tab only.
- New backend workload response for one human in one company.
- Dashboard sections:
  - Workload Summary
  - Accountability
  - Direct Work
  - Managed Agent Work
  - Attention Queue
  - Org Responsibility
  - Recent Activity
- Navigation from task rows to the existing task detail/slide-over route.
- No inline task status, assignee, responsible human, priority, or due-date editing in this dashboard.

Out of scope:

- Team-wide humans workload dashboard.
- Bulk task actions.
- Capacity planning / HR analytics.
- Commander automatic workload injection.
- Agent page accountability dashboard.
- New task data model fields.

## Data Contract

Add these shared types to `packages/shared/src/types/team.ts`:

```ts
export type HumanWorkloadTaskRelation = "responsible" | "assigned" | "managed_agent" | "created";

export type HumanWorkloadAttentionReason =
  | "blocked"
  | "overdue"
  | "high_priority"
  | "critical_priority"
  | "missing_assignee"
  | "missing_responsible_human";

export interface HumanWorkloadTaskSummary {
  id: string;
  identifier: string | null;
  issueNumber: number | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  dueDate: Date | null;
  updatedAt: Date;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  assigneeUserId: string | null;
  assigneeUserName: string | null;
  responsibleUserId: string | null;
  relation: HumanWorkloadTaskRelation;
  attentionReasons: HumanWorkloadAttentionReason[];
}

export interface HumanWorkloadSummary {
  responsibleActiveTaskCount: number;
  directlyAssignedActiveTaskCount: number;
  managedAgentActiveTaskCount: number;
  blockedTaskCount: number;
  overdueTaskCount: number;
  dueSoonTaskCount: number;
}

export interface HumanWorkloadResponse {
  companyId: string;
  userId: string;
  generatedAt: Date;
  summary: HumanWorkloadSummary;
  responsibleTasks: HumanWorkloadTaskSummary[];
  directWorkTasks: HumanWorkloadTaskSummary[];
  managedAgentTasks: HumanWorkloadTaskSummary[];
  attentionTasks: HumanWorkloadTaskSummary[];
  createdTasks: HumanWorkloadTaskSummary[];
  orgResponsibility: {
    directHumanReports: MemberDependencies["teamMembers"];
    directAgentTrees: MemberDependencies["agentTrees"];
  };
}
```

Notes:

- `dueSoon` means `dueDate` is today through 7 days from now.
- Active task counts exclude `done` and `cancelled`.
- `attentionTasks` is a deduped union of responsible, direct-work, and managed-agent tasks matching attention reasons.
- A task with no `assigneeAgentId` and no `assigneeUserId` gets `missing_assignee`.
- A task with no `responsibleUserId` gets `missing_responsible_human`.
- Agent and user display names are denormalized for UI rendering so the React page does not need extra joins.

## File Structure

- Modify `packages/shared/src/types/team.ts`
  - Add workload response/task/summary types.
- Modify `ui/src/api/team.ts`
  - Add `getWorkload(companyId, userId)`.
- Modify `server/src/services/team.ts`
  - Add `getWorkload(companyId, userId)`.
  - Reuse `getReportsFor`.
  - Keep existing `getDependencies` for delete/reassign flows and compatibility.
- Modify `server/src/routes/team.ts`
  - Add `GET /companies/:companyId/team/users/:userId/workload`.
- Modify `ui/src/pages/HumanDetail.tsx`
  - Replace Overview task-list composition with workload query.
  - Keep activity query separate.
  - Replace `TaskListSection` with workload-aware sections.
- Modify `ui/src/__tests__/HumanDetail.test.tsx`
  - Mock `teamApi.getWorkload` and assert dashboard sections/labels/navigation.
- Add or modify server test:
  - Preferred: `server/src/__tests__/team-workload-service.test.ts`
  - If the local test utilities make that too duplicative, extend `server/src/__tests__/team-profile-service.test.ts`.
- Modify `tests/e2e/task-responsible-human.spec.ts`
  - Extend existing human overview test to verify dashboard sections and slide-over navigation.
- Optionally update `docs/aoa/plans/2026-07-07-human-operating-profiles-scope.md`
  - Mark workload dashboard as implemented once code lands.

---

## Task 1: Shared Workload Contract

**Files:**
- Modify: `packages/shared/src/types/team.ts`

- [ ] **Step 1: Add failing type usage in UI/API plan branch**

Add `HumanWorkloadResponse` import usage in `ui/src/api/team.ts` before defining it. Typecheck should fail.

Run:

```bash
pnpm --filter @armyofagents/ui typecheck
```

Expected: TypeScript cannot find `HumanWorkloadResponse`.

- [ ] **Step 2: Add shared workload types**

Add the contract from the "Data Contract" section to `packages/shared/src/types/team.ts`. Import `IssuePriority` and `IssueStatus` from the existing shared constants/types location used by the issue type file if not already in scope.

- [ ] **Step 3: Verify shared package typecheck**

Run:

```bash
pnpm --filter @armyofagents/shared typecheck
```

Expected: pass.

Commit:

```bash
git add packages/shared/src/types/team.ts
git commit -m "feat(humans): define workload dashboard contract"
```

## Task 2: Backend Workload Service

**Files:**
- Modify: `server/src/services/team.ts`
- Test: `server/src/__tests__/team-workload-service.test.ts`

- [ ] **Step 1: Write service tests first**

Create `server/src/__tests__/team-workload-service.test.ts` with cases:

```ts
import { describe, expect, it } from "vitest";
import { teamService } from "../services/team.js";
import { createSequenceDb } from "./helpers/create-sequence-db.js";

describe("teamService.getWorkload", () => {
  it("groups responsible, direct, managed-agent, created, and attention tasks", async () => {
    const db = createSequenceDb({
      selects: [
        [{ userId: "report-1", displayName: "Report One", email: "report@example.com", role: "team_member" }],
        [{ id: "agent-1", name: "Ops Agent" }],
        [],
        [
          { id: "task-owned", identifier: "AOA-1", issueNumber: 1, title: "Owned task", status: "in_progress", priority: "high", dueDate: null, updatedAt: new Date("2026-07-09T00:00:00.000Z"), assigneeAgentId: "agent-1", assigneeAgentName: "Ops Agent", assigneeUserId: null, assigneeUserName: null, responsibleUserId: "user-1" },
          { id: "task-blocked", identifier: "AOA-2", issueNumber: 2, title: "Blocked task", status: "blocked", priority: "medium", dueDate: new Date("2026-07-01T00:00:00.000Z"), updatedAt: new Date("2026-07-08T00:00:00.000Z"), assigneeAgentId: null, assigneeAgentName: null, assigneeUserId: "user-1", assigneeUserName: "Ada", responsibleUserId: "user-1" },
        ],
        [
          { id: "task-direct", identifier: "AOA-3", issueNumber: 3, title: "Direct task", status: "todo", priority: "medium", dueDate: null, updatedAt: new Date("2026-07-08T00:00:00.000Z"), assigneeAgentId: null, assigneeAgentName: null, assigneeUserId: "user-1", assigneeUserName: "Ada", responsibleUserId: "user-1" },
        ],
        [
          { id: "task-agent", identifier: "AOA-4", issueNumber: 4, title: "Managed agent task", status: "todo", priority: "critical", dueDate: null, updatedAt: new Date("2026-07-08T00:00:00.000Z"), assigneeAgentId: "agent-1", assigneeAgentName: "Ops Agent", assigneeUserId: null, assigneeUserName: null, responsibleUserId: "user-1" },
        ],
        [
          { id: "task-created", identifier: "AOA-5", issueNumber: 5, title: "Created task", status: "todo", priority: "low", dueDate: null, updatedAt: new Date("2026-07-08T00:00:00.000Z"), assigneeAgentId: null, assigneeAgentName: null, assigneeUserId: null, assigneeUserName: null, responsibleUserId: null },
        ],
      ],
    });

    const result = await teamService(db as any).getWorkload("company-1", "user-1");

    expect(result.summary.responsibleActiveTaskCount).toBe(2);
    expect(result.summary.directlyAssignedActiveTaskCount).toBe(1);
    expect(result.summary.managedAgentActiveTaskCount).toBe(1);
    expect(result.summary.blockedTaskCount).toBe(1);
    expect(result.summary.overdueTaskCount).toBe(1);
    expect(result.summary.dueSoonTaskCount).toBe(0);
    expect(result.responsibleTasks.map((task) => task.id)).toEqual(["task-owned", "task-blocked"]);
    expect(result.directWorkTasks[0].relation).toBe("assigned");
    expect(result.managedAgentTasks[0].assigneeAgentName).toBe("Ops Agent");
    expect(result.attentionTasks.map((task) => task.id)).toContain("task-blocked");
    expect(result.attentionTasks.map((task) => task.id)).toContain("task-agent");
    expect(result.createdTasks[0].attentionReasons).toContain("missing_assignee");
    expect(result.orgResponsibility.directHumanReports).toHaveLength(1);
  });
});
```

If `createSequenceDb` is not exported in this repo, copy the existing sequence DB helper pattern from `team-profile-service.test.ts` into the test file.

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm test:run server/src/__tests__/team-workload-service.test.ts
```

Expected: fail because `getWorkload` does not exist.

- [ ] **Step 3: Implement service helper logic**

In `server/src/services/team.ts`, add:

```ts
const ACTIVE_TASK_STATUSES = ["backlog", "todo", "in_progress", "blocked"] as const;

function isActiveTaskStatus(status: string) {
  return status !== "done" && status !== "cancelled";
}

function attentionReasonsForTask(task: {
  status: string;
  priority: string;
  dueDate: Date | string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  responsibleUserId: string | null;
}, now = new Date()): HumanWorkloadAttentionReason[] {
  const reasons: HumanWorkloadAttentionReason[] = [];
  if (task.status === "blocked") reasons.push("blocked");
  if (task.priority === "critical") reasons.push("critical_priority");
  if (task.priority === "high") reasons.push("high_priority");
  if (!task.assigneeAgentId && !task.assigneeUserId) reasons.push("missing_assignee");
  if (!task.responsibleUserId) reasons.push("missing_responsible_human");
  if (task.dueDate) {
    const due = new Date(task.dueDate);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (due < today) reasons.push("overdue");
  }
  return reasons;
}
```

Import `HumanWorkloadAttentionReason`, `HumanWorkloadResponse`, and `HumanWorkloadTaskSummary` from shared.

- [ ] **Step 4: Implement `getWorkload`**

Add `getWorkload(companyId, userId): Promise<HumanWorkloadResponse>` to `teamService`.

Implementation requirements:

- Call `getReportsFor(companyId, userId)`.
- Query responsible tasks where `issues.responsibleUserId = userId`.
- Query direct work tasks where `issues.assigneeUserId = userId`.
- Query managed agent tasks where `issues.assigneeAgentId` is in all report-tree agent IDs.
- Query created tasks where `issues.createdByUserId = userId`.
- Exclude `done` and `cancelled` from active summary counts.
- Sort each list by active attention first, then updated date descending.
- Limit each list to 10 rows in the service for dashboard response size.
- Build `attentionTasks` as a deduped union of responsible/direct/managed tasks with at least one attention reason, limit 10.
- Join agent names from `agents.name` and user names from `authUsers.displayName` where feasible.
- Return direct reports and agent trees in `orgResponsibility`.

- [ ] **Step 5: Run backend service tests**

Run:

```bash
pnpm test:run server/src/__tests__/team-workload-service.test.ts server/src/__tests__/team-profile-service.test.ts server/src/__tests__/team-direct-add.test.ts
```

Expected: pass.

Commit:

```bash
git add server/src/services/team.ts server/src/__tests__/team-workload-service.test.ts
git commit -m "feat(humans): compute human workload dashboard"
```

## Task 3: Backend Route And UI API Client

**Files:**
- Modify: `server/src/routes/team.ts`
- Modify: `ui/src/api/team.ts`
- Test: `server/src/__tests__/team-profile-routes.test.ts`
- Test: `ui/src/api/__tests__/team-api.test.ts` if present, otherwise add route assertion to existing API client test style.

- [ ] **Step 1: Add route test**

Extend the team route test to assert:

- `GET /api/companies/:companyId/team/users/:userId/workload` requires company access.
- Existing company members can view the workload.
- Unknown user returns `404`.

Expected initially: fail because route does not exist.

- [ ] **Step 2: Add route**

In `server/src/routes/team.ts`, add before `/dependencies`:

```ts
router.get("/companies/:companyId/team/users/:userId/workload", async (req, res) => {
  const companyId = req.params.companyId as string;
  const userId = req.params.userId as string;
  assertCompanyAccess(req, companyId);
  const summary = await team.listTeam(companyId, req.actor.type === "board" ? req.actor.userId ?? null : null);
  const member = summary.members.find((m) => m.userId === userId);
  if (!member) {
    res.status(404).json({ error: "Team member not found" });
    return;
  }
  const workload = await team.getWorkload(companyId, userId);
  res.json(workload);
});
```

- [ ] **Step 3: Add UI API client**

In `ui/src/api/team.ts`, import `HumanWorkloadResponse` and add:

```ts
getWorkload: (companyId: string, userId: string) =>
  api.get<HumanWorkloadResponse>(`/companies/${companyId}/team/users/${userId}/workload`),
```

- [ ] **Step 4: Verify route and API client tests**

Run:

```bash
pnpm test:run server/src/__tests__/team-profile-routes.test.ts
pnpm --filter @armyofagents/ui test:run src/api/__tests__/team-api.test.ts
```

If `src/api/__tests__/team-api.test.ts` does not exist, run:

```bash
pnpm --filter @armyofagents/ui typecheck
```

Commit:

```bash
git add server/src/routes/team.ts ui/src/api/team.ts server/src/__tests__/team-profile-routes.test.ts ui/src/api/__tests__/team-api.test.ts
git commit -m "feat(humans): expose human workload endpoint"
```

## Task 4: Human Overview Dashboard UI

**Files:**
- Modify: `ui/src/pages/HumanDetail.tsx`
- Test: `ui/src/__tests__/HumanDetail.test.tsx`

- [ ] **Step 1: Write UI test first**

Update `HumanDetail.test.tsx` mocks:

```ts
vi.mock("../api/team", () => ({
  teamApi: {
    get: vi.fn(),
    getMember: vi.fn(),
    getWorkload: vi.fn(),
    updateRole: vi.fn(),
    updateProfile: vi.fn(),
    listCapabilities: vi.fn(),
    createCapabilityDocument: vi.fn(),
    updateCapabilityDocument: vi.fn(),
    deleteCapabilityDocument: vi.fn(),
  },
}));
```

Add default workload mock with:

- summary counts
- one responsible task
- one direct work task
- one managed agent task
- one attention task
- direct report
- direct agent tree

Add assertions:

```ts
expect(await screen.findByText("Workload Summary")).toBeInTheDocument();
expect(screen.getByText("Accountability")).toBeInTheDocument();
expect(screen.getByText("Direct Work")).toBeInTheDocument();
expect(screen.getByText("Managed Agent Work")).toBeInTheDocument();
expect(screen.getByText("Attention Queue")).toBeInTheDocument();
expect(screen.getByText("Org Responsibility")).toBeInTheDocument();
expect(screen.getByText("Owned by Ada")).toBeInTheDocument();
expect(screen.getByText("Ops Agent")).toBeInTheDocument();
expect(screen.getByRole("link", { name: /AOA-1 Owned by Ada/ })).toHaveAttribute("href", "/issues/owned-1");
expect(screen.queryByRole("button", { name: /change status/i })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: /assign/i })).not.toBeInTheDocument();
```

Expected initially: fail because `HumanDetail` still uses separate issue queries and old headings.

- [ ] **Step 2: Add workload query**

In `HumanDetail.tsx`, replace overview-only task queries with:

```ts
const workloadQuery = useQuery({
  queryKey: selectedCompanyId && userId
    ? ["team", selectedCompanyId, "human", userId, "workload"]
    : ["team", "none", "human", "workload"],
  queryFn: () => teamApi.getWorkload(selectedCompanyId!, userId!),
  enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
});
```

Keep `activityQuery`.

- [ ] **Step 3: Replace task list sections**

Replace `TaskListSection` with workload-specific reusable components:

- `WorkloadSummaryGrid`
- `WorkloadTaskSection`
- `AttentionQueueSection`
- `OrgResponsibilitySection`

Requirements:

- Section cards use the existing visual style: `rounded-xl border border-border bg-card p-4`.
- Do not nest cards inside cards.
- Each section has a stable header height and no layout shift when loading.
- Rows are links to `/issues/${task.id}`.
- Rows show identifier/title/status/priority/due date/executor.
- Empty states are concise and operational.
- No task mutation buttons.

- [ ] **Step 4: Keep compatibility while loading**

When `deps` exists but `workloadQuery` is loading:

- Show metric skeletons or "Loading..." within the overview sections.
- Do not fall back to old separate `issuesApi.list` queries.

- [ ] **Step 5: Run UI tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/HumanDetail.test.tsx
```

Expected: pass.

Commit:

```bash
git add ui/src/pages/HumanDetail.tsx ui/src/__tests__/HumanDetail.test.tsx
git commit -m "feat(humans): render workload accountability overview"
```

## Task 5: E2E Browser Coverage

**Files:**
- Modify: `tests/e2e/task-responsible-human.spec.ts`

- [ ] **Step 1: Extend existing E2E**

In `creates a human-assigned task and shows it on the human overview`, after visiting the human page, assert:

```ts
await expect(page.getByText("Workload Summary")).toBeVisible();
await expect(page.getByText("Accountability")).toBeVisible();
await expect(page.getByText("Direct Work")).toBeVisible();
await expect(page.getByText("Attention Queue")).toBeVisible();
await expect(page.getByText("Human assigned E2E task")).toBeVisible();
```

Then click the task row and assert the task slide-over opens:

```ts
await page.getByRole("link", { name: /Human assigned E2E task/ }).first().click();
await expect(page.getByRole("dialog")).toContainText("Human assigned E2E task");
```

- [ ] **Step 2: Add managed-agent dashboard coverage**

In the same file or a new test in the same describe block:

- seed company
- create managed agent under founder
- create task assigned to that agent
- verify responsible human defaults to founder
- visit founder human overview
- assert `Managed Agent Work` contains the task and agent name
- assert row opens the task slide-over

- [ ] **Step 3: Run E2E**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

Expected: pass.

Commit:

```bash
git add tests/e2e/task-responsible-human.spec.ts
git commit -m "test(humans): cover workload dashboard end to end"
```

## Task 6: Documentation And Final Verification

**Files:**
- Modify: `docs/aoa/plans/2026-07-07-human-operating-profiles-scope.md`
- Optional: `CLAUDE.md` only if source-of-truth behavior changes need to be recorded.

- [ ] **Step 1: Update docs**

Add a short note that the Human Overview now surfaces workload/accountability via:

- responsible tasks
- direct human work
- managed agent work
- attention queue
- org responsibility

Also record that task mutations remain in the task slide-over.

- [ ] **Step 2: Run focused verification**

Run:

```bash
pnpm test:run server/src/__tests__/team-workload-service.test.ts server/src/__tests__/team-profile-routes.test.ts
pnpm --filter @armyofagents/ui test:run src/__tests__/HumanDetail.test.tsx
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

- [ ] **Step 3: Run full handoff verification**

Run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

- [ ] **Step 4: Manual browser verification**

Use the running isolated app and verify:

- Human Overview loads without console errors.
- Workload Summary counts match seeded task data.
- Accountability, Direct Work, Managed Agent Work, Attention Queue, Org Responsibility, and Recent Activity appear.
- Clicking task rows opens the existing task detail/slide-over.
- No inline task mutation controls appear in the Human Overview dashboard.
- Layout works at desktop and narrow widths.

Commit:

```bash
git add docs/aoa/plans/2026-07-07-human-operating-profiles-scope.md CLAUDE.md
git commit -m "docs(humans): document workload accountability overview"
```

## Edge Cases To Verify

- Human with no tasks, no reports, and no agents.
- Human with only directly assigned tasks.
- Human responsible for agent-assigned tasks.
- Human managing nested agent tree tasks.
- Task appears in multiple buckets but attention queue dedupes it.
- Task has no assignee.
- Task has no responsible human.
- Done/cancelled tasks do not inflate active summary counts.
- Due date before today is overdue.
- Due date within 7 days is due soon.
- Due date far in the future is not due soon.
- Company isolation: workload endpoint never returns tasks from another company.

## Engineering Review

### Findings

1. Backend aggregation is required.
   - Current UI performs multiple independent `issuesApi.list` calls and computes agent-tree work in React.
   - This creates duplicated semantics and makes future Commander reuse harder.
   - Plan addresses this with `team.getWorkload` and a dedicated route.

2. Do not remove `getDependencies`.
   - Existing routes and remove/reassign flows still depend on `MemberDependencies`.
   - Plan keeps it for compatibility and adds workload as a separate read model.

3. Task editing must remain outside this dashboard.
   - User explicitly rejected inline status/responsible/assignee editing here.
   - UI tests must assert mutation controls are absent.

4. Service tests should not depend on full UI behavior.
   - Backend tests verify bucketing/counting/attention semantics.
   - UI tests verify rendering/navigation.
   - E2E verifies the integrated browser path.

5. Due soon needs a fixed definition.
   - Plan defines due soon as today through 7 days from now.
   - This avoids vague UI copy and test ambiguity.

### Test Coverage

- Unit/service:
  - `teamService.getWorkload` bucketing, counts, attention reasons, org responsibility.
- Route/integration:
  - Workload endpoint access, missing user, company scope.
- UI unit:
  - `HumanDetail` dashboard sections, no inline mutation controls, task navigation links.
- E2E:
  - Human-assigned task appears in accountability/direct work and opens slide-over.
  - Managed-agent task appears under the responsible human and opens slide-over.
- Full regression:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `plan-eng-review` | Architecture and tests | 1 | CLEAR | 5 findings folded into plan |
| Design Review | manual design scope | UI/UX surface | 1 | CLEAR_WITH_SCOPE | Overview dashboard only; no inline editing |
| CEO Review | prior discussion | Scope and strategy | 1 | CLEAR_WITH_SCOPE | Human Detail first; team-wide dashboard deferred |

- **UNRESOLVED:** None.
- **VERDICT:** ENG CLEARED - ready to implement after user approval.

# Human Accountability & Human Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make human task assignment and human accountability first-class across task creation, task detail, Human overview, and Commander context.

**Architecture:** Keep the existing single-assignee task model: a task has either `assigneeAgentId` or `assigneeUserId`, never both. Keep `responsibleUserId` as the single accountable human owner for the task; default it from the assignee or operator, but never overwrite a manually selected responsible human unless the user explicitly changes or clears it.

**Tech Stack:** Express 5 REST routes, Drizzle services/schema already in place, shared Zod validators/types, React/Vite UI, TanStack Query, Vitest, Playwright E2E.

---

## Locked Product Decisions

- `responsibleUserId` is a task field, not an agent field.
- Task assignee can be an agent or a human.
- A task can have only one assignee: agent or human.
- Responsible human stays single; collaborators, reviewers, watchers, and multi-human accountability are outside this scope.
- Defaulting rules:
  - Explicit `responsibleUserId` wins, including explicit `null`.
  - Human assignee defaults responsible human to the same human.
  - Agent assignee defaults responsible human to the nearest active human in the agent reporting chain, then the single founder fallback.
  - No assignee defaults responsible human to the creator/current operator when that operator is an active company user.
  - Existing manually selected responsible human is sticky when the assignee changes later unless the update explicitly includes `responsibleUserId`.
- Human page must distinguish:
  - Responsible Tasks: accountable owner.
  - Assigned Tasks: direct human assignee.
  - Managed Agents: direct reports.
  - Indirect Agents: agents under the direct managed agents.

## Existing Source of Truth

- `packages/db/src/schema/issues.ts` already has `assigneeAgentId`, `assigneeUserId`, and `responsibleUserId`.
- `server/src/services/issues.ts` already enforces one assignee and resolves responsible human for human/agent assignees.
- `server/src/routes/issues.ts` already supports `assigneeUserId=me` and now supports `responsibleUserId=me` server-side.
- `ui/src/components/IssueProperties.tsx` already shows assignee and responsible human, but arbitrary human assignee selection is incomplete.
- `ui/src/components/NewIssueDialog.tsx` currently treats assignee as an agent id string.
- `ui/src/pages/HumanDetail.tsx` currently queries assigned, created, and agent-tree tasks, but not first-class responsible tasks.
- `ui/src/api/issues.ts` does not yet type or forward `responsibleUserId` filters.

## File Structure

- Backend task semantics:
  - Modify `server/src/services/issues.ts`
  - Modify `server/src/routes/issues.ts`
  - Modify `server/src/mcp/tools/write-tools.ts`
  - Test `server/src/__tests__/issues-responsible-user.test.ts`
  - Test `server/src/__tests__/issues-responsible-user-routes.test.ts`
  - Test `server/src/__tests__/mcp-write-tools.test.ts`
- Shared/UI task contracts:
  - Modify `packages/shared/src/types/issue.ts`
  - Inspect `packages/shared/src/validators/issue.ts`; modify it only if the existing create/update/list schemas reject `assigneeUserId` or `responsibleUserId` combinations required by this scope
  - Modify `ui/src/api/issues.ts`
  - Create `ui/src/lib/task-assignee.ts`
  - Modify `ui/src/pages/IssueDetail.tsx`
  - Modify `ui/src/components/CommentThread.tsx`
  - Test `ui/src/__tests__/task-assignee.test.ts`
- New Task dialog:
  - Modify `ui/src/components/NewIssueDialog.tsx`
  - Test `ui/src/__tests__/NewIssueDialog.responsible-human.test.tsx`
- Task slide-over/detail assignee:
  - Modify `ui/src/components/IssueProperties.tsx`
  - Test `ui/src/__tests__/IssueProperties.test.tsx`
- Human overview:
  - Modify `ui/src/pages/HumanDetail.tsx`
  - Test `ui/src/__tests__/HumanDetail.test.tsx`
- Commander/tool context:
  - Modify `server/src/services/internal-agent/tools/action-tools.ts`
  - Modify `server/src/services/internal-agent/tools/query-tools.ts`
  - Modify `server/src/services/internal-agent/tools/get-task-tool.ts`
  - Test `server/src/__tests__/action-tools.test.ts`
  - Test `server/src/__tests__/query-tools.test.ts`
  - Test `server/src/__tests__/get-task-tool.test.ts`
- E2E:
  - Modify `tests/e2e/task-responsible-human.spec.ts`
  - Keep human overview assertions in `tests/e2e/task-responsible-human.spec.ts`; do not expand `tests/e2e/human-profile.spec.ts` for this scope
- Docs:
  - Modify `docs/api/issues.md`
  - Modify `docs/guides/board-operator/managing-tasks.md`
  - Modify `docs/start/core-concepts.md`

---

### Task 1: Backend Responsible-Human Defaults for Unassigned Tasks

**Files:**
- Modify: `server/src/services/issues.ts`
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/mcp/tools/write-tools.ts`
- Test: `server/src/__tests__/issues-responsible-user.test.ts`
- Test: `server/src/__tests__/issues-responsible-user-routes.test.ts`
- Test: `server/src/__tests__/mcp-write-tools.test.ts`

- [ ] **Step 1: Write failing service tests for no-assignee fallback**

Add tests in `server/src/__tests__/issues-responsible-user.test.ts` using the existing `makeDb(...)` helper and `issueService(db)` harness:

```ts
it("defaults responsibleUserId to fallback user when a task has no assignee", async () => {
  const db = makeDb({ activeUsers: ["founder-user"] });
  const created = await issueService(db).create(COMPANY_ID, {
    title: "Unassigned operator-owned task",
    status: "todo",
    responsibleFallbackUserId: "founder-user",
  } as any);
  expect(created?.responsibleUserId).toBe("founder-user");
  expect(created?.assigneeAgentId).toBeNull();
  expect(created?.assigneeUserId).toBeNull();
  expect(db.getCapturedInsert()).toMatchObject({ responsibleUserId: "founder-user" });
});

it("keeps an existing manual responsible human when only the assignee changes", async () => {
  const db = makeDb({
    activeUsers: ["owner-user", "manager-user"],
    agents: [{ id: "agent-1", parentType: "user", parentId: "manager-user" }],
    existing: {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
      responsibleUserId: "owner-user",
    },
  });
  const updated = await issueService(db).update(ISSUE_ID, { assigneeAgentId: "agent-1", assigneeUserId: null } as any);
  expect(updated?.responsibleUserId).toBe("owner-user");
  expect(db.getCapturedPatch()).not.toHaveProperty("responsibleUserId");
});
```

Expected first run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user.test.ts
```

Expected: fails because `responsibleFallbackUserId` is not accepted or ignored.

- [ ] **Step 2: Implement fallback without changing single-assignee semantics**

In `server/src/services/issues.ts`, extend the create input and resolver:

```ts
type IssueCreateExtra = {
  responsibleFallbackUserId?: string | null;
};

async function resolveResponsibleUserId(input: {
  companyId: string;
  explicitResponsibleUserId?: string | null;
  assigneeUserId?: string | null;
  assigneeAgentId?: string | null;
  responsibleFallbackUserId?: string | null;
  existingResponsibleUserId?: string | null;
  executorChanged?: boolean;
}): Promise<string | null | undefined> {
  if (input.explicitResponsibleUserId !== undefined) {
    if (input.explicitResponsibleUserId !== null) {
      await assertResponsibleUser(input.companyId, input.explicitResponsibleUserId);
    }
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
  if (input.responsibleFallbackUserId) {
    return await findActiveCompanyUser(input.companyId, input.responsibleFallbackUserId);
  }

  return null;
}
```

Before inserting, remove the service-only field from `issueData` so it is not written to `issues`.

- [ ] **Step 3: Pass board/current operator fallback from REST create**

In `server/src/routes/issues.ts`, pass a fallback for board actors:

```ts
const responsibleFallbackUserId =
  req.actor.type === "board" ? (req.actor.userId ?? null) : null;

const issue = await svc.create(companyId, {
  ...req.body,
  createdByAgentId: actor.agentId,
  createdByUserId: actor.actorType === "user" ? actor.actorId : null,
  responsibleFallbackUserId,
});
```

Keep existing `createdByUserId` behavior unchanged.

- [ ] **Step 4: Pass MCP fallback for board/founder callers**

In `server/src/mcp/tools/write-tools.ts`, when create-task calls `issues.create`, include:

```ts
responsibleFallbackUserId: ctx.actor.type === "board" ? ctx.actor.userId : null,
```

Do not use agent ids as human fallback.

- [ ] **Step 5: Verify backend tests pass**

Run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user.test.ts server/src/__tests__/issues-responsible-user-routes.test.ts server/src/__tests__/mcp-write-tools.test.ts
```

Expected: all tests pass.

---

### Task 2: Shared UI Assignee Model

**Files:**
- Create: `ui/src/lib/task-assignee.ts`
- Modify: `ui/src/api/issues.ts`
- Modify: `ui/src/pages/IssueDetail.tsx`
- Modify: `ui/src/components/CommentThread.tsx`
- Test: `ui/src/__tests__/task-assignee.test.ts`
- Test: `ui/src/api/__tests__/issues-api.test.ts`

- [ ] **Step 1: Write failing helper tests**

Create `ui/src/__tests__/task-assignee.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseTaskAssigneeValue, taskAssigneePayload } from "../lib/task-assignee";

describe("task assignee helpers", () => {
  it("maps an agent option to assigneeAgentId only", () => {
    expect(taskAssigneePayload("agent:agent-1")).toEqual({
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    });
  });

  it("maps a human option to assigneeUserId only", () => {
    expect(taskAssigneePayload("user:user-1")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: "user-1",
    });
  });

  it("maps empty option to unassigned", () => {
    expect(taskAssigneePayload("")).toEqual({
      assigneeAgentId: null,
      assigneeUserId: null,
    });
  });

  it("rejects malformed values", () => {
    expect(parseTaskAssigneeValue("user:")).toEqual({ kind: "none", id: null });
    expect(parseTaskAssigneeValue("agent:agent-1")).toEqual({ kind: "agent", id: "agent-1" });
  });
});
```

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/task-assignee.test.ts
```

Expected: fails because helper does not exist.

- [ ] **Step 2: Implement helper**

Create `ui/src/lib/task-assignee.ts`:

```ts
export type TaskAssigneeKind = "agent" | "user" | "none";

export type TaskAssigneeValue =
  | { kind: "agent"; id: string }
  | { kind: "user"; id: string }
  | { kind: "none"; id: null };

export function formatTaskAssigneeValue(kind: TaskAssigneeKind, id?: string | null): string {
  if (!id || kind === "none") return "";
  return `${kind}:${id}`;
}

export function parseTaskAssigneeValue(value: string): TaskAssigneeValue {
  if (!value) return { kind: "none", id: null };
  const [kind, id] = value.split(":", 2);
  if ((kind === "agent" || kind === "user") && id) return { kind, id };
  return { kind: "none", id: null };
}

export function taskAssigneePayload(value: string): { assigneeAgentId: string | null; assigneeUserId: string | null } {
  const parsed = parseTaskAssigneeValue(value);
  if (parsed.kind === "agent") return { assigneeAgentId: parsed.id, assigneeUserId: null };
  if (parsed.kind === "user") return { assigneeAgentId: null, assigneeUserId: parsed.id };
  return { assigneeAgentId: null, assigneeUserId: null };
}
```

- [ ] **Step 3: Sync issue API responsible filter**

In `ui/src/api/issues.ts`, add:

```ts
responsibleUserId?: string;
```

and forward:

```ts
if (filters?.responsibleUserId) params.set("responsibleUserId", filters.responsibleUserId);
```

Add a test in `ui/src/api/__tests__/issues-api.test.ts` beside the existing list-filter serialization test asserting:

```ts
expect(fetchMock).toHaveBeenCalledWith(
  "/companies/company-1/issues?responsibleUserId=user-1&taskScope=all",
  expect.anything(),
);
```

- [ ] **Step 4: Verify helper and API tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/task-assignee.test.ts src/api/__tests__/issues-api.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Migrate existing namespaced assignee parsing to the shared helper**

Replace local `agent:${id}` / `user:${id}` parsing in:

- `ui/src/pages/IssueDetail.tsx`
- `ui/src/components/CommentThread.tsx`

Use `formatTaskAssigneeValue(...)`, `parseTaskAssigneeValue(...)`, and `taskAssigneePayload(...)` so the app has one assignee serialization contract.

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/IssueDetail.test.tsx src/__tests__/CommentThread.test.tsx src/__tests__/task-assignee.test.ts
```

Expected: all tests pass. If one of the named test files does not exist, run the closest existing test covering the edited component and note the exact command in the implementation checklist.

---

### Task 3: New Task Dialog Supports Human Assignees

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx`
- Test: `ui/src/__tests__/NewIssueDialog.responsible-human.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Extend `NewIssueDialog.responsible-human.test.tsx` using the existing `renderDialog()`, `teamAccess.summary.members`, and mocked `InlineEntitySelector`. First update the selector mock in this test file so it renders a small button for each option:

```tsx
{options.map((option) => (
  <button key={option.id} type="button" onClick={() => onChange(option.id)}>
    Choose {option.label}
  </button>
))}
```

Then add:

```tsx
it("creates a human-assigned task and lets backend default responsible human", async () => {
  renderDialog();

  await waitFor(() => expect(screen.getByTestId("selector-Assignee-options")).toHaveTextContent("2"));
  fireEvent.click(screen.getByRole("button", { name: "Choose Mia Manager" }));
  await waitFor(() => expect(screen.getByTestId("selector-Assignee-value")).toHaveTextContent("Mia Manager"));
  fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

  expect(issuesApi.create).toHaveBeenCalledWith(
    "comp-1",
    expect.objectContaining({
      assigneeAgentId: null,
      assigneeUserId: "human-1",
    }),
  );
  expect(issuesApi.create).toHaveBeenCalledWith(
    "comp-1",
    expect.not.objectContaining({ responsibleUserId: expect.anything() }),
  );
});
```

Expected: fails because the dialog only emits `assigneeAgentId`.

- [ ] **Step 2: Replace agent-only assignee state with typed value**

In `NewIssueDialog.tsx`, replace:

```ts
const [assigneeId, setAssigneeId] = useState("");
```

with:

```ts
const [assigneeValue, setAssigneeValue] = useState("");
const parsedAssignee = parseTaskAssigneeValue(assigneeValue);
```

Use `taskAssigneePayload(assigneeValue)` inside `handleSubmit`.

- [ ] **Step 3: Build combined assignee options**

Create options with namespaced ids:

```ts
const assigneeOptions = useMemo<InlineEntityOption[]>(() => {
  const agentOptions = sortAgentsByRecency(
    (agents ?? []).filter((agent) => agent.status !== "terminated"),
    recentAssigneeIds,
  ).map((agent) => ({
    id: formatTaskAssigneeValue("agent", agent.id),
    label: agent.name,
    searchText: `${agent.name} ${agent.role} ${agent.title ?? ""} agent`,
  }));

  const humanOptions = (teamSummary?.members ?? []).map((member) => ({
    id: formatTaskAssigneeValue("user", member.userId),
    label: member.displayName ?? member.email ?? member.userId.slice(0, 8),
    searchText: `${member.displayName ?? ""} ${member.email ?? ""} ${member.title ?? ""} ${member.role} human`,
  }));

  return [...agentOptions, ...humanOptions];
}, [agents, recentAssigneeIds, teamSummary?.members]);
```

- [ ] **Step 4: Keep agent-only advanced options guarded**

Show model/thinking/chrome/project-workspace assignee options only when:

```ts
parsedAssignee.kind === "agent" && supportsAssigneeOverrides
```

When assignee changes away from agent, clear agent override draft fields.

- [ ] **Step 5: Verify dialog tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/NewIssueDialog.responsible-human.test.tsx src/__tests__/NewIssueDialog.planning-chip.test.tsx src/__tests__/NewIssueDialog-workspacePolicy.test.tsx
```

Expected: all tests pass.

---

### Task 4: Task Slide-Over Assignee Picker Supports All Humans

**Files:**
- Modify: `ui/src/components/IssueProperties.tsx`
- Test: `ui/src/__tests__/IssueProperties.test.tsx`

- [ ] **Step 1: Write failing tests**

Extend `IssueProperties.test.tsx`:

```tsx
it("selecting a human assignee clears agent assignee and does not change responsible human", async () => {
  canAssignTasks = true;
  agents = [{ id: "agent-1", name: "Agent One", status: "idle" }];
  members = [{ userId: "user-1", displayName: "Priya Owner", email: "priya@example.com", title: "Ops", role: "team_member" }];
  const onUpdate = vi.fn();
  const user = userEvent.setup();

  renderWithProviders(
    <IssueProperties
      issue={{ ...issue, assigneeAgentId: "agent-1", responsibleUserId: "manager-1" }}
      onUpdate={onUpdate}
    />,
  );

  await user.click(screen.getByRole("button", { name: /Agent One/ }));
  await user.click(screen.getByRole("button", { name: /Priya Owner/ }));

  expect(onUpdate).toHaveBeenCalledWith({
    assigneeAgentId: null,
    assigneeUserId: "user-1",
  });
  expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ responsibleUserId: expect.anything() }));
});
```

Expected: fails because arbitrary humans are not in the assignee picker.

- [ ] **Step 2: Add humans to assignee popover**

In `IssueProperties.tsx`, after the existing "Assign to requester" option and before agents or after agents with a small divider, render active humans:

```tsx
{humanOptions
  .filter((human) => {
    if (!assigneeSearch.trim()) return true;
    const q = assigneeSearch.toLowerCase();
    return [human.label, human.email, human.title, human.role]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(q));
  })
  .map((human) => (
    <button
      key={`human-${human.id}`}
      className={cn(
        "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
        human.id === issue.assigneeUserId && "bg-accent",
      )}
      onClick={() => {
        onUpdate({ assigneeAgentId: null, assigneeUserId: human.id });
        setAssigneeOpen(false);
      }}
    >
      <User className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{human.label}</span>
    </button>
  ))}
```

- [ ] **Step 3: Verify slide-over component tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/IssueProperties.test.tsx
```

Expected: all tests pass.

---

### Task 5: Human Overview Accountability Sections

**Files:**
- Modify: `ui/src/pages/HumanDetail.tsx`
- Test: `ui/src/__tests__/HumanDetail.test.tsx`

- [ ] **Step 1: Write failing overview tests**

Extend `HumanDetail.test.tsx`:

```tsx
it("shows responsible tasks separately from assigned tasks and managed agents", async () => {
  mockIssuesList.mockImplementation((_companyId, filters) => {
    if (filters?.responsibleUserId === "user-1") return Promise.resolve([makeIssue({ id: "r1", title: "Owned task" })]);
    if (filters?.assigneeUserId === "user-1") return Promise.resolve([makeIssue({ id: "a1", title: "Assigned task" })]);
    return Promise.resolve([]);
  });
  renderHumanDetail({ userId: "user-1", agentTrees: [{ rootAgentId: "agent-1", agentIds: ["agent-1", "agent-2"] }] });

  expect(await screen.findByText("Responsible Tasks")).toBeVisible();
  expect(await screen.findByText("Owned task")).toBeVisible();
  expect(await screen.findByText("Assigned task")).toBeVisible();
  expect(await screen.findByText("Managed Agents")).toBeVisible();
});
```

Expected: fails because responsible tasks are not queried/rendered.

- [ ] **Step 2: Add responsible tasks query**

In `HumanDetail.tsx`, add:

```ts
const responsibleTasksQuery = useQuery({
  queryKey: selectedCompanyId && userId
    ? ["team", selectedCompanyId, "human", userId, "responsible-tasks", "all"]
    : ["team", "none", "human", "responsible-tasks"],
  queryFn: () => issuesApi.list(selectedCompanyId!, { responsibleUserId: userId!, taskScope: "all" }),
  enabled: Boolean(selectedCompanyId && userId) && activeTab === "overview",
});
```

- [ ] **Step 3: Split direct and indirect managed agents**

Use existing `deps.agentTrees`, which already includes `rootAgentId`, `rootAgentName`, `subAgentCount`, and `agentIds` in the `teamApi.getMember` payload:

```ts
const directManagedAgentIds = useMemo(
  () => (deps?.agentTrees ?? []).map((tree) => tree.rootAgentId),
  [deps?.agentTrees],
);

const indirectManagedAgentIds = useMemo(
  () => Array.from(new Set((deps?.agentTrees ?? []).flatMap((tree) => (tree.agentIds ?? []).filter((id) => id !== tree.rootAgentId)))),
  [deps?.agentTrees],
);
```

Render direct managed agents by `rootAgentName`. Render indirect agents as counts from `subAgentCount`/`agentIds`; do not add a new org-tree query in this scope.

- [ ] **Step 4: Render overview sections**

Replace the overview grid with:

```tsx
<TaskListSection
  title="Responsible Tasks"
  icon={ShieldCheck}
  tasks={responsibleTasksQuery.data ?? []}
  isLoading={responsibleTasksQuery.isLoading}
  empty="No tasks owned by this person."
/>
<TaskListSection
  title="Assigned Tasks"
  icon={ClipboardList}
  tasks={assignedTasksQuery.data ?? []}
  isLoading={assignedTasksQuery.isLoading}
  empty="No tasks assigned directly to this person."
/>
```

Keep Created Tasks and Activity. Rename "Responsible Agent Tasks" to "Agent Tree Tasks" because responsibility now means `responsibleUserId`.

- [ ] **Step 5: Verify Human page tests**

Run:

```bash
pnpm --filter @armyofagents/ui test:run src/__tests__/HumanDetail.test.tsx
```

Expected: all tests pass.

---

### Task 6: Commander and Tool Semantics

**Files:**
- Modify: `server/src/services/internal-agent/tools/action-tools.ts`
- Modify: `server/src/services/internal-agent/tools/query-tools.ts`
- Modify: `server/src/services/internal-agent/tools/get-task-tool.ts`
- Test: `server/src/__tests__/action-tools.test.ts`
- Test: `server/src/__tests__/query-tools.test.ts`
- Test: `server/src/__tests__/get-task-tool.test.ts`

- [ ] **Step 1: Write failing tool tests**

Add tests proving tool output distinguishes doing, owning, and managing:

```ts
it("get_task exposes assignee and responsible human separately", async () => {
  const { ctx } = makeCtx(makeIssueRow({
    id: "task-1",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    responsibleUserId: "user-1",
  }));
  const result = await getTaskTool.execute({ taskId: "task-1" }, ctx);
  const data = result.data as Record<string, unknown>;
  expect(data.assigneeAgentId).toBe("agent-1");
  expect(data.assigneeUserId).toBeNull();
  expect(data.responsibleUserId).toBe("user-1");
});
```

Add query-tool tests that "what is this human accountable for" returns responsible tasks and managed agents.

- [ ] **Step 2: Update Commander action tools for human assignment**

In `server/src/services/internal-agent/tools/action-tools.ts`, update:

- `create_task`: replace ambiguous `assigneeId` agent-only behavior with `assigneeType` (`"agent"` or `"user"`) plus `assigneeId`; do not send both ids.
- `assign_task`: support assigning to an agent or a human. Agent assignment sends `{ assigneeAgentId, assigneeUserId: null }`; human assignment sends `{ assigneeAgentId: null, assigneeUserId }`.
- Keep `responsibleUserId` separate from assignee fields.
- Update descriptions to say: assignee is who does the task; responsible human is who owns the outcome.

Add `server/src/__tests__/action-tools.test.ts` coverage:

```ts
it("assign_task can assign a task to a human and clears agent assignee", async () => {
  const issuesUpdate = vi.fn().mockResolvedValue({ id: "task-1", assigneeAgentId: null, assigneeUserId: "user-1" });
  const tool = createActionTools().find((candidate) => candidate.name === "assign_task")!;
  await tool.execute({ taskId: "task-1", assigneeType: "user", assigneeId: "user-1" }, makeActionToolCtx({ issuesUpdate }));
  expect(issuesUpdate).toHaveBeenCalledWith("task-1", { assigneeAgentId: null, assigneeUserId: "user-1" });
});
```

- [ ] **Step 3: Update query tool descriptions and payloads**

In tool descriptions, use:

```text
Assignee means who is doing the task. Responsible human means who owns/accountable for the task. Reporting hierarchy means who manages an agent or human.
```

Ensure `query_humans`, `query_team_roster`, and `query_human_context` include enough ids and labels for Commander to answer:

- Who owns this task?
- Who is doing this task?
- Who is responsible for this agent's work?
- What is this human accountable for?

- [ ] **Step 4: Verify tool tests**

Run:

```bash
pnpm test:run server/src/__tests__/action-tools.test.ts server/src/__tests__/query-tools.test.ts server/src/__tests__/get-task-tool.test.ts server/src/__tests__/commander-tools-md.test.ts
```

Expected: all tests pass.

---

### Task 7: E2E Coverage

**Files:**
- Modify: `tests/e2e/task-responsible-human.spec.ts`

- [ ] **Step 1: Extend task E2E for human assignee**

In `task-responsible-human.spec.ts`, add a browser flow:

```ts
test("creates a human-assigned task and shows it on the human overview", async ({ page, request }) => {
  const company = await seedCompany(request, `E2E-HumanAssign-${Date.now()}`);
  const human = await jsonOrThrow<{ userId: string }>(
    await request.post(`/api/companies/${company.id}/team/members`, {
      data: {
        name: "E2E Human Assignee",
        email: `human-assignee-${Date.now()}@example.com`,
        role: "team_member",
      },
    }),
    "create human assignee",
  );

  await page.goto(`/${company.issuePrefix}/issues`);
  await page.getByRole("button", { name: /new task/i }).click();
  await page.getByPlaceholder("Task title").fill("Human assigned E2E task");
  await page.getByText("Assignee").click();
  await page.getByRole("option", { name: /E2E Human Assignee/ }).click();
  await page.getByRole("button", { name: /create task/i }).click();

  const issues = await jsonOrThrow<Issue[]>(
    await request.get(`/api/companies/${company.id}/issues`, { params: { q: "Human assigned E2E task", taskScope: "all" } }),
    "find created human-assigned task",
  );
  const created = issues.find((issue) => issue.title === "Human assigned E2E task");
  expect(created).toBeTruthy();
  expect(created!.assigneeUserId).toBe(human.userId);
  expect(created!.assigneeAgentId).toBeNull();
  expect(created!.responsibleUserId).toBe(human.userId);

  await page.goto(`/${company.issuePrefix}/team/${human.userId}`);
  await expect(page.getByText("Responsible Tasks")).toBeVisible();
  await expect(page.getByText("Human assigned E2E task")).toBeVisible();
});
```

Use existing helper patterns in `tests/e2e/task-responsible-human.spec.ts` and `tests/e2e/helpers/seed-company.ts`; do not create a new testing-only API.

- [ ] **Step 2: Verify focused E2E**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

Expected: all tests pass.

---

### Task 8: Documentation and Full Verification

**Files:**
- Modify: `docs/api/issues.md`
- Modify: `docs/guides/board-operator/managing-tasks.md`
- Modify: `docs/start/core-concepts.md`

- [ ] **Step 1: Document assignee vs responsible human**

Update docs with:

```md
Tasks have one assignee, either an agent (`assigneeAgentId`) or a human (`assigneeUserId`). Tasks also have one responsible human (`responsibleUserId`) who owns accountability for the work. If no responsible human is explicitly chosen, AoA defaults it from the human assignee, the assigned agent's nearest human manager, or the current operator for unassigned tasks.
```

- [ ] **Step 2: Run focused checks**

Run:

```bash
pnpm test:run server/src/__tests__/issues-responsible-user.test.ts server/src/__tests__/issues-responsible-user-routes.test.ts server/src/__tests__/mcp-write-tools.test.ts server/src/__tests__/query-tools.test.ts server/src/__tests__/get-task-tool.test.ts
pnpm --filter @armyofagents/ui test:run src/__tests__/task-assignee.test.ts src/__tests__/NewIssueDialog.responsible-human.test.tsx src/__tests__/IssueProperties.test.tsx src/__tests__/HumanDetail.test.tsx src/api/__tests__/issues-api.test.ts
$env:AOA_E2E_FORCE_WINDOWS='1'; pnpm test:e2e task-responsible-human.spec.ts
```

Expected: all focused checks pass.

- [ ] **Step 3: Run full required gates**

Run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected:

```text
typecheck: exit 0
test:run: exit 0
build: exit 0
```

---

## Out of Scope

- Multiple responsible humans.
- Watchers/collaborators/reviewers.
- Agent page ownership surfaces.
- Deep RBAC redesign.
- Auth-aware per-tenant profile identity beyond existing company-scoped users.
- New database columns beyond already-existing `responsibleUserId`.

## Review Checklist

- [ ] No task ever sends both `assigneeAgentId` and `assigneeUserId`.
- [ ] Manual `responsibleUserId` remains sticky when assignee changes.
- [ ] No-assignee create defaults responsible human to active operator when possible.
- [ ] Agent assignment still wakes only agents, never humans.
- [ ] Human assignment does not show agent runtime override controls.
- [ ] Human page labels do not reuse "responsible" for agent-tree work.
- [ ] Commander text distinguishes doing, owning, and managing.
- [ ] E2E proves API defaults and UI persistence.

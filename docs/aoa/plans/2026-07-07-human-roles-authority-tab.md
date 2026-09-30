# Human Roles Authority Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Roles` tab to the human detail page that separates company authority, reporting structure, explicit grants, and role/department editing from the profile and general settings surfaces.

**Architecture:** Reuse the existing team contracts and role update API. This scope does not add schema, migrations, or new backend routes because `TeamMemberSummary` already exposes role, department, reports-to, system-admin state, and explicit permission grants, while `MemberDependencies` already exposes reports and agent ownership counts. The UI change should promote the existing Authority card and Role & Department editor into a new `Roles` tab, leaving `Settings` for operational danger/admin notices.

**Tech Stack:** React + Vite UI, TanStack Query, existing `teamApi`, Vitest + Testing Library, Playwright E2E.

---

## Investigation Summary

- `ui/src/pages/HumanDetail.tsx` currently has two tabs: `Overview` and `Settings`.
- The `Overview` tab already renders an `Authority` card with role, department, reports-to, access, and explicit permission badges.
- The `Settings` tab already renders the editable `Role & Department` form using `teamApi.updateRole`.
- `server/src/services/team.ts` already enforces founder-only role management, protects last-founder demotion, validates user-only reporting, prevents hierarchy cycles, updates `companyMemberships.parentId`, rewrites `userRoles`, and refreshes role-derived grants.
- `packages/shared/src/types/team.ts` already contains all data needed for a read-only authority dashboard.
- `packages/shared/src/validators/team.ts` already validates role update input.
- No backend or database change is required for Scope 1.

## Product Shape

The human page will have three tabs:

- `Overview`: work dashboard only: metrics, assigned/created/responsible-agent tasks, activity, reports, and agents.
- `Roles`: authority and responsibility: company role, department, reports-to, system/admin state, explicit grants, direct reports, agent responsibility, and editable role controls for founders.
- `Settings`: operational controls only: remove member and read-only notices. No profile form and no role editor.

The key product distinction stays explicit:

- `Title` is profile metadata, edited from the profile modal.
- `Role` is company authority, edited from the Roles tab.
- `Explicit grants` are shown as authority evidence but not deeply editable in this scope.

## Locked Product Decisions

- The tab label is `Roles`, not `Roles & Responsibilities`, to keep the tab bar short.
- The section label inside the tab can use `Responsibilities` because that is where work ownership belongs.
- The `Overview` tab should stop showing the full authority card after the `Roles` tab ships. Overview can still show role badges in the header.
- `Settings` should not contain role, department, reports-to, or profile identity controls.
- This scope does not add explicit-grant editing. Explicit grants are read-only evidence because deeper RBAC editing belongs with the later auth/RBAC scope.
- Founder-only role mutation stays enforced by the existing API. The UI should hide/disable mutation for non-managers, but security still lives server-side.
- Last-founder demotion stays blocked by the existing service and represented in UI through the existing `selfFounderLock`.

## Test Matrix

- Unit/UI tests:
  - `Roles` tab renders authority, responsibilities, explicit grants, and the moved editor.
  - Role, Department, and Reports-to selects have stable accessible names so both keyboard users and tests can target them.
  - Role save from `Roles` calls `teamApi.updateRole` with role, department, `parentType: "user"`, and `parentId`.
  - Successful role save toast says `Role saved`, not `Settings saved`.
  - Settings no longer renders `Role & Department`.
  - Founder selection clears department and manager drafts.
  - Non-role-managers see authority but cannot edit role controls.
- Route/service integration tests:
  - Existing service tests cover `updateUserRole` parent persistence, parent validation skipping, founder protections, and add-member parent assignment.
  - Add route-level coverage for `PATCH /companies/:companyId/team/users/:userId/role` to assert board/founder gate, service call shape, and activity logging.
- E2E tests:
  - Visit `/team/:userId/roles` from a seeded company and assert all authority/responsibility sections render.
  - Drive a real role update through the UI and verify the page reflects the new role/department/reporting state after save/refetch.
  - Visit `/team/:userId/settings` and assert role controls are absent.
- Live smoke:
  - Against `http://127.0.0.1:3207`, verify the Roles tab loads, role controls are visible for the current founder/admin user, Settings is clean, and no page errors are emitted.

## Files

- Modify: `ui/src/pages/HumanDetail.tsx`
  - Add `Roles` to `TAB_ITEMS`.
  - Move the existing `Authority` section from Overview to Roles.
  - Move the existing `Role & Department` editor from Settings to Roles.
  - Add accessible names to the Role, Department, and Reports-to select triggers.
  - Rename the role mutation success toast from `Settings saved` to `Role saved`.
  - Add compact responsibility context in Roles using `deps.teamMembers`, `deps.agentTrees`, `member.permissions`, and current manager.
  - Keep Settings focused on danger/removal and non-admin notice.
- Modify: `ui/src/__tests__/HumanDetail.test.tsx`
  - Add unit coverage for Roles tab rendering and saving role controls.
  - Add edge coverage for founder draft clearing and non-manager disabled controls.
  - Update Settings expectations so role controls are absent from Settings.
- Create: `server/src/__tests__/team-role-routes.test.ts`
  - Add route-level integration coverage for the existing role update endpoint.
- Modify: `tests/e2e/human-profile.spec.ts`
  - Update navigation assertions to visit `/team/:userId/roles`.
  - Assert role/department/reporting authority renders there.
  - Drive a real role/department/reports-to update through the UI.
  - Assert Settings no longer owns `Role & Department`.

## Task 1: Unit Test The New Roles Tab Contract

**Files:**
- Modify: `ui/src/__tests__/HumanDetail.test.tsx`

- [ ] **Step 1: Write the failing Roles tab rendering test**

Add a test near the current Settings test:

```tsx
it("renders authority and editable role controls in the roles tab", async () => {
  const user = userEvent.setup();
  renderHumanDetail("/team/user-1/roles");

  expect(await screen.findByText("Authority")).toBeInTheDocument();
  expect(screen.getByText("Role & Department")).toBeInTheDocument();
  expect(screen.getByText("Team Lead")).toBeInTheDocument();
  expect(screen.getByText("Product")).toBeInTheDocument();
  expect(screen.getByText("Grace Founder")).toBeInTheDocument();
  expect(screen.getByText("tasks.assign")).toBeInTheDocument();
  expect(screen.getByText("Reports")).toBeInTheDocument();
  expect(screen.getByText("Agents")).toBeInTheDocument();

  await user.click(screen.getByRole("combobox", { name: "Role" }));
  await user.click(screen.getByRole("option", { name: "Team Member" }));
  await user.click(screen.getByRole("combobox", { name: "Department" }));
  await user.click(screen.getByRole("option", { name: "No department" }));
  await user.click(screen.getByRole("combobox", { name: "Reports to" }));
  await user.click(screen.getByRole("option", { name: /Grace Founder/ }));
  await user.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => {
    expect(teamApi.updateRole).toHaveBeenCalledWith("company-1", "user-1", {
      role: "team_member",
      projectId: null,
      parentType: "user",
      parentId: "founder-1",
    });
  });
});
```

Implementation note: if Radix portals make select interaction repetitive, add a tiny test helper that opens a named combobox and clicks the desired option. Do not fall back to brittle text-only selectors.

- [ ] **Step 2: Update the Settings test to fail until the editor moves**

Change the existing Settings test to:

```tsx
it("keeps settings focused on operational controls", async () => {
  renderHumanDetail("/team/user-1/settings");

  expect(await screen.findByRole("button", { name: "Edit profile" })).toBeInTheDocument();
  expect(screen.queryByText("Role & Department")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Profile" })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Add founder-clears-scope edge test**

Add:

```tsx
it("clears department and manager drafts when founder is selected", async () => {
  const user = userEvent.setup();
  renderHumanDetail("/team/user-1/roles");

  await screen.findByText("Role & Department");
  await user.click(screen.getByRole("combobox", { name: "Role" }));
  await user.click(screen.getByRole("option", { name: "Founder" }));
  await user.click(screen.getByRole("button", { name: "Save Changes" }));

  await waitFor(() => {
    expect(teamApi.updateRole).toHaveBeenCalledWith("company-1", "user-1", {
      role: "founder",
      projectId: null,
      parentType: "user",
      parentId: null,
    });
  });
});
```

- [ ] **Step 4: Add non-manager read-only edge test**

Override `teamApi.get` in this test so `currentUser.permissions.canManageRoles` is false, then assert all role controls are disabled:

```tsx
it("shows roles authority but disables editing for non-role-managers", async () => {
  vi.mocked(teamApi.get).mockResolvedValueOnce({
    ...teamSummary,
    currentUser: {
      ...teamSummary.currentUser,
      role: "team_member",
      permissions: {
        canAssignTasks: false,
        canInviteUsers: false,
        canManageRoles: false,
        canEditIdentityMemory: false,
      },
    },
  });

  renderHumanDetail("/team/user-1/roles");

  expect(await screen.findByText("Authority")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Role" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Department" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "Reports to" })).toBeDisabled();
});
```

- [ ] **Step 5: Run the focused test and confirm failure**

Run:

```bash
pnpm exec vitest run ui/src/__tests__/HumanDetail.test.tsx
```

Expected: FAIL because `/roles` is not a valid tab and the editor still exists in Settings.

## Task 2: Add The Roles Tab And Move Authority UI

**Files:**
- Modify: `ui/src/pages/HumanDetail.tsx`

- [ ] **Step 1: Add the tab item**

Change:

```tsx
const TAB_ITEMS = [
  { value: "overview", label: "Overview" },
  { value: "settings", label: "Settings" },
];
```

to:

```tsx
const TAB_ITEMS = [
  { value: "overview", label: "Overview" },
  { value: "roles", label: "Roles" },
  { value: "settings", label: "Settings" },
];
```

- [ ] **Step 2: Remove the Authority card from Overview**

Delete the existing `Authority` section from the Overview tab. Keep metrics, tasks, activity, team reports, and agent trees in Overview.

- [ ] **Step 3: Add a Roles tab section after Overview and before Settings**

Add:

```tsx
{activeTab === "roles" && deps && (
  <div className="space-y-4 mt-4">
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
        <Shield className="h-4 w-4" />
        Authority
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Role</p>
          <p className="mt-1 text-sm">{ROLE_LABELS[member.role]}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Department</p>
          <p className="mt-1 text-sm">{member.departmentName ?? "No department"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Reports to</p>
          <p className="mt-1 text-sm">{manager?.displayName ?? manager?.email ?? "No manager"}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Access</p>
          <p className="mt-1 text-sm">{member.isSystemAdmin ? "System admin" : "Company member"}</p>
        </div>
      </div>
      {member.permissions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {member.permissions.slice(0, 6).map((permission) => (
            <Badge key={permission} variant="outline" className="max-w-full truncate text-[10px]">
              {permission}
            </Badge>
          ))}
        </div>
      )}
    </section>

    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold mb-3">Responsibilities</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Reports</p>
          <p className="mt-1 text-sm">{deps.teamMembers.length}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Agent trees</p>
          <p className="mt-1 text-sm">{deps.agentTrees.length}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Responsible tasks</p>
          <p className="mt-1 text-sm">{deps.assignedTaskCount + (agentTasksQuery.data?.length ?? 0)}</p>
        </div>
      </div>
    </section>

    {/* Move the existing Role & Department editor here unchanged. */}
  </div>
)}
```

- [ ] **Step 4: Move the existing Role & Department editor into Roles**

Move the existing `Role & Department` card from Settings into the Roles tab after `Responsibilities`. Do not change its mutation logic in this task.

- [ ] **Step 5: Simplify Settings**

Settings should keep:

- `Danger Zone` when `canRemove` is true.
- The non-admin notice when `!canManageRoles`.

Settings should not contain `Role & Department`.

- [ ] **Step 6: Run the focused unit test**

Run:

```bash
pnpm exec vitest run ui/src/__tests__/HumanDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/pages/HumanDetail.tsx ui/src/__tests__/HumanDetail.test.tsx
git commit -m "feat(team): add human roles authority tab"
```

## Task 3: Add Route Integration Coverage For Role Updates

**Files:**
- Create: `server/src/__tests__/team-role-routes.test.ts`

- [ ] **Step 1: Write the route integration test**

Create `server/src/__tests__/team-role-routes.test.ts`:

```ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockTeamService = vi.hoisted(() => ({
  assertFounder: vi.fn(),
  updateUserRole: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  logActivity: mockLogActivity,
  teamService: () => mockTeamService,
}));

import { teamRoutes } from "../routes/team.js";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyId = "11111111-1111-4111-8111-111111111111";

describe("team role routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamService.assertFounder.mockResolvedValue(undefined);
    mockTeamService.updateUserRole.mockResolvedValue({ role: "team_lead", projectId: "22222222-2222-4222-8222-222222222222" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets a board founder update role, department, reports-to, and logs activity", async () => {
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-2/role`)
      .send({
        role: "team_lead",
        projectId: "22222222-2222-4222-8222-222222222222",
        parentType: "user",
        parentId: "founder-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamService.assertFounder).toHaveBeenCalledWith(companyId, "founder-1");
    expect(mockTeamService.updateUserRole).toHaveBeenCalledWith(
      companyId,
      "user-2",
      {
        role: "team_lead",
        projectId: "22222222-2222-4222-8222-222222222222",
        parentType: "user",
        parentId: "founder-1",
      },
      "founder-1",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "founder-1",
        action: "team.role_updated",
        entityType: "user_role",
        entityId: "user-2",
      }),
    );
  });

  it("rejects non-board actors before role mutation", async () => {
    const app = createApp({ type: "agent", companyId, agentId: "agent-1" });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-2/role`)
      .send({ role: "team_member" });

    expect(res.status).toBe(403);
    expect(mockTeamService.updateUserRole).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the route integration test and confirm failure if imports/mocks need adjustment**

Run:

```bash
pnpm exec vitest run server/src/__tests__/team-role-routes.test.ts
```

Expected: PASS after minor import/mock adjustments if needed. If it fails because the test harness shape differs, fix only the test harness, not production route code.

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/team-role-routes.test.ts
git commit -m "test(team): cover human role update route"
```

## Task 4: Update E2E Coverage For Roles Tab

**Files:**
- Modify: `tests/e2e/human-profile.spec.ts`

- [ ] **Step 1: Update the E2E flow**

After the Overview assertions, add:

```ts
await page.goto(`/${company.issuePrefix}/team/${userId}/roles`);
await expect(main.getByText("Authority")).toBeVisible({ timeout: 10_000 });
await expect(main.getByText("Role & Department")).toBeVisible();
await expect(main.getByText("Responsibilities")).toBeVisible();
await expect(main.getByText("Founder")).toBeVisible();
```

Then create a second human and department through the API, drive role mutation through the UI, and assert the refreshed UI reflects it:

```ts
const departmentRes = await request.post(`/api/companies/${company.id}/projects`, {
  data: {
    name: `E2E Roles Dept ${Date.now()}`,
    type: "department",
    description: "Human roles E2E department",
  },
});
expect(departmentRes.ok()).toBe(true);
const department = (await departmentRes.json()) as { id: string; name: string };

const memberRes = await request.post(`/api/companies/${company.id}/team/members`, {
  data: {
    name: "E2E Reports Human",
    email: `reports-${Date.now()}@example.com`,
    role: "team_member",
    projectId: department.id,
    parentType: "user",
    parentId: userId,
  },
});
expect(memberRes.ok()).toBe(true);
const added = (await memberRes.json()) as { userId: string };

await page.goto(`/${company.issuePrefix}/team/${added.userId}/roles`);
await expect(main.getByText("Role & Department")).toBeVisible({ timeout: 10_000 });
await main.getByRole("combobox", { name: "Role" }).click();
await page.getByRole("option", { name: "Team Lead" }).click();
await main.getByRole("combobox", { name: "Department" }).click();
await page.getByRole("option", { name: department.name }).click();
await main.getByRole("combobox", { name: "Reports to" }).click();
await page.getByRole("option", { name: /E2E Human Updated/ }).click();
await main.getByRole("button", { name: "Save Changes" }).click();

await expect(main.getByText("Role saved")).toBeVisible({ timeout: 10_000 });
await page.reload();
await expect(main.getByText("Team Lead")).toBeVisible();
await expect(main.getByText(department.name)).toBeVisible();
await expect(main.getByText("E2E Human Updated")).toBeVisible();
```

Then update the Settings assertion:

```ts
await page.goto(`/${company.issuePrefix}/team/${userId}/settings`);
await expect(main.getByText("Role & Department")).toHaveCount(0);
await expect(main.getByRole("region", { name: "Profile" })).toHaveCount(0);
```

- [ ] **Step 2: Run E2E for this spec**

Run:

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; $env:AOA_E2E_PORT='3249'; $env:AOA_E2E_DB_PORT='55479'; pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/human-profile.spec.ts
```

Expected: `1 passed`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/human-profile.spec.ts
git commit -m "test(e2e): cover human roles tab"
```

## Task 5: Final Verification

**Files:**
- No code changes unless verification exposes a regression.

- [ ] **Step 1: Run focused unit test**

```bash
pnpm exec vitest run ui/src/__tests__/HumanDetail.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run UI typecheck**

```bash
pnpm --filter @armyofagents/ui typecheck
```

Expected: PASS.

- [ ] **Step 3: Run backend integration tests**

```bash
pnpm exec vitest run server/src/__tests__/team-role-routes.test.ts server/src/__tests__/team-service.test.ts server/src/__tests__/team-direct-add.test.ts
```

Expected: PASS. These cover the route gate/logging plus existing service-level hierarchy, founder, and parent-assignment behavior.

- [ ] **Step 4: Run E2E profile spec**

```bash
$env:AOA_E2E_FORCE_WINDOWS='1'; $env:AOA_E2E_PORT='3249'; $env:AOA_E2E_DB_PORT='55479'; pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/human-profile.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Live smoke against the isolated app**

Use Playwright against `http://127.0.0.1:3207` to verify:

- `/MANA/team/local-board/roles` loads.
- `Authority`, `Responsibilities`, and `Role & Department` are visible.
- `/MANA/team/local-board/settings` does not show `Role & Department`.
- Role save works for a non-founder test member in the live instance, or the script creates a temporary member and updates role/department/reporting through the UI.
- No page errors are emitted.

- [ ] **Step 6: Run full pre-handoff checks if the branch is otherwise ready**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: PASS. If any cannot run due time/environment, report exactly what was skipped and why.

- [ ] **Step 7: Report next scope**

After Scope 1 ships, recommend Scope 2:

- Either `Responsibilities Profile` with skills/resume/ownership markdown.
- Or `Auth/RBAC preparation` if the user wants to start permission enforcement next.

## Self-Review

- Spec coverage: The plan covers the approved read-first Roles tab and includes immediate role/department/reports-to controls.
- Placeholder scan: clean.
- Type consistency: Existing `role`, `departmentId`, `parentId`, `permissions`, and `MemberDependencies` names match the current code.
- Scope discipline: No backend/schema changes because the current API already supports the product shape.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
| --- | --- | --- | --- | --- | --- |
| Eng Review | `/plan-eng-review` | Lock architecture, API coverage, and verification before implementation | 1 | CLEAR | Added missing route integration coverage, true UI E2E role mutation, accessible select targets, and role-specific save toast. |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED - ready to implement Scope 1.

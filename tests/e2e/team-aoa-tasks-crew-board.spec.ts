import { expect, test } from "@playwright/test";
import { jsonOrThrow } from "./helpers/real-crew";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type ScopeVersionDetail = {
  id: string;
  items: Array<{
    id: string;
    kind: string;
    payload?: Record<string, unknown>;
  }>;
};

test.describe("Team AoA Tasks crew board", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-AOA-Tasks-/);
  });

  test("shows discussion-created AoA-assigned tasks and reflects persisted status changes", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-AOA-Tasks-${Date.now()}`);
    const agents = await jsonOrThrow<Array<{ id: string; name: string }>>(
      await request.get(`/api/companies/${company.id}/agents?kind=aoa`),
      "list AoA agents",
    );
    const planner = agents.find((agent) => /planner/i.test(agent.name)) ?? agents[0];
    expect(planner, "seeded AoA planner").toBeTruthy();

    const discussion = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/discussions`, {
        data: {
          title: "Crew board handoff source",
          entry: {
            inputType: "write",
            rawContent: "Create an implementation task for the AoA crew board E2E.",
          },
        },
      }),
      "create source discussion",
    );

    const draft = await jsonOrThrow<{ version?: { id: string } }>(
      await request.post(`/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/draft`, {
        data: { mode: "generate", summary: "Create an AoA crew-board verification task from this discussion." },
      }),
      "create scope draft",
    );
    expect(draft.version?.id, "scope draft version").toBeTruthy();

    const scope = await jsonOrThrow<ScopeVersionDetail>(
      await request.get(`/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${draft.version!.id}`),
      "get scope draft",
    );
    const taskItem = scope.items.find((item) => item.kind === "task_proposal");
    expect(taskItem, "scope draft task proposal").toBeTruthy();

    const taskTitle = "Verify discussion task appears on AoA Tasks";
    const patchResponse = await request.patch(
      `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${scope.id}/items/${taskItem!.id}`,
      {
        data: {
          title: taskTitle,
          description: "Created from a discussion handoff and assigned to an AoA crew member.",
          payload: {
            ...(taskItem!.payload ?? {}),
            priority: "medium",
            assigneeAgentId: planner.id,
          },
        },
      },
    );
    expect(patchResponse.ok(), await patchResponse.text()).toBe(true);

    const created = await jsonOrThrow<{
      createdTask?: {
        id: string;
        assigneeAgentId?: string | null;
        sourceDiscussionId?: string | null;
        scopeVersionId?: string | null;
      };
    }>(
      await request.post(
        `/api/companies/${company.id}/discussions/${discussion.id}/scope-versions/${scope.id}/items/${taskItem!.id}/create`,
      ),
      "create task from scope item",
    );
    expect(created.createdTask?.sourceDiscussionId).toBe(discussion.id);
    expect(created.createdTask?.scopeVersionId).toBe(scope.id);
    expect(created.createdTask?.assigneeAgentId).toBe(planner.id);

    const task = await jsonOrThrow<{ id: string; title: string; identifier?: string; sourceDiscussionId?: string | null }>(
      await request.get(`/api/issues/${created.createdTask!.id}`),
      "get created crew task",
    );
    expect(task.sourceDiscussionId).toBe(discussion.id);
    expect(task.title).toBe(taskTitle);

    const crewIssues = await jsonOrThrow<Array<{ id: string; sourceDiscussionId?: string | null }>>(
      await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
      "list crew scoped issues",
    );
    expect(crewIssues.some((issue) => issue.id === task.id && issue.sourceDiscussionId === discussion.id)).toBe(true);

    await page.goto(`/${company.issuePrefix}/team?tab=aoa&aoaTab=tasks`);
    await expect(page.getByTestId("aoa-header-subtab-tasks")).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("crew-board")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(task.title)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/thread|discussion/i).first()).toBeVisible();

    await page.getByText(task.title).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("dialog")).toContainText(task.title);
    await page.keyboard.press("Escape");

    const updateResponse = await request.patch(`/api/issues/${task.id}`, { data: { status: "done" } });
    expect(updateResponse.ok(), await updateResponse.text()).toBe(true);

    await page.reload();
    await expect(page.getByTestId("crew-board")).toBeVisible({ timeout: 15_000 });
    const doneColumn = page.getByTestId("kanban-column-done");
    await expect(doneColumn).toBeVisible({ timeout: 15_000 });
    await expect(doneColumn.getByTestId(`kanban-card-${task.id}`)).toContainText(task.title, { timeout: 15_000 });
  });
});

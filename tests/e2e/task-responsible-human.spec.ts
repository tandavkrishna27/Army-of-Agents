import { expect, test } from "@playwright/test";
import { jsonOrThrow } from "./helpers/real-crew";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const PREFIX = /^E2E-TaskResponsible-/;

type TeamSummary = {
  currentUser: { userId: string };
};

type Agent = {
  id: string;
  name: string;
};

type Issue = {
  id: string;
  identifier?: string | null;
  title: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  responsibleUserId?: string | null;
};

test.describe("task responsible human ownership", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  test("defaults from the assigned agent's human manager and can be changed in the task slide-over", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-TaskResponsible-${Date.now()}`);

    const team = await jsonOrThrow<TeamSummary>(
      await request.get(`/api/companies/${company.id}/team`),
      "get seeded team",
    );
    const founderId = team.currentUser.userId;

    await jsonOrThrow(
      await request.patch(`/api/companies/${company.id}/team/users/${founderId}/profile`, {
        data: {
          displayName: "E2E Manager",
          title: "Founder Operator",
          timezone: "UTC",
        },
      }),
      "name founder profile",
    );

    const alternate = await jsonOrThrow<{ userId: string }>(
      await request.post(`/api/companies/${company.id}/team/members`, {
        data: {
          name: "E2E Responsible Alt",
          email: `responsible-alt-${Date.now()}@example.com`,
          role: "team_member",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create alternate responsible human",
    );

    const agent = await jsonOrThrow<Agent>(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "E2E Ownership Agent",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create managed agent",
    );

    const taskTitle = "E2E responsible human ownership task";
    const created = await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: taskTitle,
          description: "Verifies responsible human defaulting and UI persistence.",
          priority: "medium",
          assigneeAgentId: agent.id,
        },
      }),
      "create task assigned to managed agent",
    );
    expect(created.assigneeAgentId).toBe(agent.id);
    expect(created.assigneeUserId ?? null).toBeNull();
    expect(created.responsibleUserId).toBe(founderId);

    const getTask = async () =>
      jsonOrThrow<Issue>(await request.get(`/api/issues/${created.id}`), "get task");
    await expect.poll(async () => (await getTask()).responsibleUserId).toBe(founderId);

    await page.goto(`/${company.issuePrefix}/issues?selected=${created.identifier ?? created.id}`);
    const dialog = page.getByRole("dialog", { name: new RegExp(taskTitle) });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText(taskTitle);
    await expect(dialog).toContainText("E2E Ownership Agent");
    await expect(dialog).toContainText("E2E Manager");

    await dialog.getByRole("button", { name: /E2E Manager/ }).click();
    await page.getByPlaceholder("Search responsible humans...").fill("Alt");
    const updatePaths = new Set([
      `/api/issues/${created.id}`,
      ...(created.identifier ? [`/api/issues/${created.identifier}`] : []),
    ]);
    const updateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        updatePaths.has(new URL(response.url()).pathname),
    );
    await page.getByRole("button", { name: /E2E Responsible Alt/ }).click();
    expect((await updateResponse).ok()).toBe(true);

    await expect(dialog).toContainText("E2E Responsible Alt");
    await expect.poll(async () => (await getTask()).responsibleUserId).toBe(alternate.userId);

    await page.reload();
    const reloadedDialog = page.getByRole("dialog", { name: new RegExp(taskTitle) });
    await expect(reloadedDialog).toBeVisible({ timeout: 15_000 });
    await expect(reloadedDialog).toContainText(taskTitle);
    await expect(reloadedDialog).toContainText("E2E Responsible Alt");
    await expect(reloadedDialog).not.toContainText(/^Human:\s*Board$/);
  });

  test("creates a human-assigned task and shows it on the human overview", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-TaskResponsible-${Date.now()}`);
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
    await page.getByRole("button", { name: /^Assignee$/ }).click();
    await page.getByPlaceholder("Search assignees...").fill("Human Assignee");
    await page.getByRole("button", { name: /E2E Human Assignee/ }).click();
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/companies/${company.id}/issues`,
    );
    await page.getByRole("button", { name: /^create task$/i }).click();
    expect((await createResponse).ok()).toBe(true);

    let created: Issue | undefined;
    await expect
      .poll(async () => {
        const issues = await jsonOrThrow<Issue[]>(
          await request.get(`/api/companies/${company.id}/issues`, {
            params: { q: "Human assigned E2E task", taskScope: "all" },
          }),
          "find created human-assigned task",
        );
        created = issues.find((issue) => issue.title === "Human assigned E2E task");
        return created?.id ?? null;
      })
      .not.toBeNull();
    expect(created).toBeTruthy();
    expect(created!.assigneeUserId).toBe(human.userId);
    expect(created!.assigneeAgentId).toBeNull();
    expect(created!.responsibleUserId).toBe(human.userId);

    await page.goto(`/${company.issuePrefix}/team/${human.userId}`);
    await expect(page.getByRole("heading", { name: "Responsible Tasks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Assigned Tasks" })).toBeVisible();
    await expect(page.getByText("Human assigned E2E task")).toHaveCount(2);
  });
});

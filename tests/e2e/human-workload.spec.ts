import { expect, test } from "@playwright/test";
import { jsonOrThrow } from "./helpers/real-crew";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const PREFIX = /^E2E-HumanWorkload-/;

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
};

test.describe("Human workload dashboard", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  test("shows responsible work, assigned human work, managed-agent work, and opens tasks", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HumanWorkload-${Date.now()}`);

    const team = await jsonOrThrow<TeamSummary>(
      await request.get(`/api/companies/${company.id}/team`),
      "get seeded team",
    );
    const founderId = team.currentUser.userId;

    await jsonOrThrow(
      await request.patch(`/api/companies/${company.id}/team/users/${founderId}/profile`, {
        data: {
          displayName: "E2E Accountable Founder",
          title: "Founder Operator",
          timezone: "UTC",
        },
      }),
      "name workload founder",
    );

    const alternate = await jsonOrThrow<{ userId: string }>(
      await request.post(`/api/companies/${company.id}/team/members`, {
        data: {
          name: "E2E Alternate Owner",
          email: `workload-alt-${Date.now()}@example.com`,
          role: "team_member",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create alternate workload owner",
    );

    const agent = await jsonOrThrow<Agent>(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "E2E Workload Agent",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create workload managed agent",
    );

    const responsibleTask = await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E accountable founder task",
          description: "Visible in the responsible workload lane.",
          status: "todo",
          priority: "high",
          responsibleUserId: founderId,
        },
      }),
      "create responsible workload task",
    );

    await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E direct human execution task",
          description: "Visible in the directly assigned workload lane.",
          status: "in_progress",
          priority: "medium",
          assigneeUserId: founderId,
          responsibleUserId: alternate.userId,
        },
      }),
      "create assigned workload task",
    );

    await jsonOrThrow<Issue>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E managed agent blocked task",
          description: "Visible in managed-agent work and attention.",
          status: "blocked",
          priority: "critical",
          assigneeAgentId: agent.id,
          responsibleUserId: alternate.userId,
        },
      }),
      "create managed-agent workload task",
    );

    await page.goto(`/${company.issuePrefix}/team/${founderId}/workload`);
    const main = page.locator("#main-content");

    await expect(main.getByRole("heading", { name: "E2E Accountable Founder" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(main.getByRole("tab", { name: "Workload" })).toHaveAttribute("aria-selected", "true");
    await expect(main.getByRole("heading", { name: "Needs Attention" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Responsible Tasks" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Assigned Tasks" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Managed-Agent Tasks" })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Managed Agents" })).toBeVisible();

    await expect(main.getByText("E2E accountable founder task")).toBeVisible();
    await expect(main.getByText("E2E direct human execution task")).toBeVisible();
    await expect(main.getByText("E2E managed agent blocked task").first()).toBeVisible();
    await expect(main.getByRole("link", { name: /E2E Workload Agent/ })).toHaveAttribute(
      "href",
      `/${company.issuePrefix}/agents/${agent.id}`,
    );

    await main.getByRole("button", { name: /Open E2E accountable founder task/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/${company.issuePrefix}/team/${founderId}/workload\\?task=${responsibleTask.id}`),
    );
    const dialog = page.getByRole("dialog", { name: /E2E accountable founder task/ });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toContainText("E2E Accountable Founder");
  });
});

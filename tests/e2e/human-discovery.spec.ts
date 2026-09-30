import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("Human discovery", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Human-Discovery-/);
  });

  test("finds a human by capability document content from Team Humans search", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Human-Discovery-${Date.now()}`);
    const uniquePhrase = `enterprise routing alpha ${Date.now()}`;

    const teamRes = await request.get(`/api/companies/${company.id}/team`);
    expect(teamRes.ok()).toBe(true);
    const team = (await teamRes.json()) as {
      currentUser: { userId: string };
    };
    const userId = team.currentUser.userId;

    const profileRes = await request.patch(`/api/companies/${company.id}/team/users/${userId}/profile`, {
      data: {
        displayName: "Discovery Human",
        title: "Routing Specialist",
      },
    });
    expect(profileRes.ok()).toBe(true);

    const capabilitiesRes = await request.get(`/api/companies/${company.id}/team/users/${userId}/capabilities`);
    expect(capabilitiesRes.ok()).toBe(true);
    const capabilities = (await capabilitiesRes.json()) as {
      documents: Array<{ id: string; filename: string }>;
    };
    const skills = capabilities.documents.find((doc) => doc.filename === "skills.md");
    expect(skills).toBeTruthy();

    const updateRes = await request.patch(`/api/companies/${company.id}/team/users/${userId}/capabilities/${skills!.id}`, {
      data: {
        content: `# Skills\n\n## Core Skills\n\n- ${uniquePhrase}\n- Product strategy routing`,
      },
    });
    expect(updateRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/team?tab=humans`);
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "Humans" })).toBeVisible({ timeout: 10_000 });

    await main.getByPlaceholder("Search humans by skills, responsibilities, role, or docs...").fill(uniquePhrase);

    await expect(main.getByText("Discovery Human")).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText("Skills")).toBeVisible();
    await expect(main.getByText(new RegExp(uniquePhrase))).toBeVisible();

    await main.getByText("Discovery Human").click();
    await expect(page).toHaveURL(new RegExp(`/team/${userId}`));
    await expect(main.getByRole("heading", { name: "Discovery Human" })).toBeVisible({ timeout: 10_000 });
  });
});

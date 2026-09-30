import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("Human profile page", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Humans-/);
  });

  test("renders profile fields, overview dashboard, and profile edit modal", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Humans-${Date.now()}`);

    const teamRes = await request.get(`/api/companies/${company.id}/team`);
    expect(teamRes.ok()).toBe(true);
    const team = (await teamRes.json()) as {
      currentUser: { userId: string };
    };
    const userId = team.currentUser.userId;

    const profileRes = await request.patch(`/api/companies/${company.id}/team/users/${userId}/profile`, {
      data: {
        displayName: "E2E Human",
        title: "Founder Operator",
        bio: "Owns human-agent operating cadence.",
        location: "Remote",
        timezone: "UTC",
        socialLinks: [{ type: "website", label: "Website", url: "https://example.com" }],
      },
    });
    expect(profileRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/team/${userId}`);
    const main = page.locator("#main-content");

    await expect(main.getByRole("heading", { name: "E2E Human" })).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText("Founder Operator")).toBeVisible();
    await expect(main.getByText("Owns human-agent operating cadence.")).toBeVisible();
    await expect(main.getByText("Remote")).toBeVisible();
    await expect(main.getByText("UTC")).toBeVisible();
    await expect(main.getByRole("link", { name: "Website" })).toHaveAttribute("href", "https://example.com");
    await expect(main.getByText("Authority")).toHaveCount(0);
    await expect(main.getByText("Assigned Tasks").first()).toBeVisible();
    await expect(main.getByText("Created Tasks").first()).toBeVisible();
    await expect(main.getByText("Activity")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/team/${userId}/settings`);
    await expect(main.getByText("Role & Department")).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Profile" })).toHaveCount(0);

    await page.getByRole("button", { name: "Edit profile" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit Profile" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByLabel("Display name")).toHaveValue("E2E Human");
    await expect(dialog.getByLabel("Title")).toHaveValue("Founder Operator");
    await expect(dialog.getByLabel("Location")).toHaveValue("Remote");
    await expect(dialog.getByLabel("Timezone")).toHaveValue("UTC");

    await dialog.getByLabel("Display name").fill("E2E Human Updated");
    await dialog.getByLabel("Title").selectOption("Founder Partner");
    await dialog.getByLabel("Timezone").selectOption("Asia/Kolkata");
    await dialog.getByRole("button", { name: "Save Profile" }).click();

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    await expect(main.getByRole("heading", { name: "E2E Human Updated" })).toBeVisible();
    await expect(main.getByText("Founder Partner")).toBeVisible();
    await expect(main.getByText("Asia/Kolkata")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/team/${userId}/capabilities`);
    await expect(main.getByText("Documents")).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText("skills.md").first()).toBeVisible();
    await expect(main.getByText("background.md").first()).toBeVisible();
    const documentListPanel = main.getByTestId("capabilities-document-list");
    const documentDetailPanel = main.getByTestId("capabilities-document-detail");
    const initialListBox = await documentListPanel.boundingBox();
    const initialDetailBox = await documentDetailPanel.boundingBox();
    expect(initialListBox?.height).toBeGreaterThan(500);
    expect(Math.abs((initialListBox?.height ?? 0) - (initialDetailBox?.height ?? 0))).toBeLessThanOrEqual(2);
    const listHeaderHeight = await documentListPanel
      .getByTestId("capabilities-document-list-header")
      .evaluate((element) => element.getBoundingClientRect().height);
    const detailHeaderHeight = await documentDetailPanel
      .getByTestId("capabilities-document-detail-header")
      .evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(listHeaderHeight - 42)).toBeLessThanOrEqual(1);
    expect(Math.abs(detailHeaderHeight - 42)).toBeLessThanOrEqual(1);
    await main.getByRole("button", { name: "Background background.md" }).hover();
    const backgroundHover = await main.getByRole("button", { name: "Background background.md" }).evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
      };
    });
    expect(backgroundHover.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(backgroundHover.borderColor).not.toBe("rgba(0, 0, 0, 0)");
    await main.getByRole("button", { name: "Background background.md" }).click();
    await expect(main.getByText("## Professional Background")).toBeVisible();
    const backgroundListBox = await documentListPanel.boundingBox();
    const backgroundDetailBox = await documentDetailPanel.boundingBox();
    expect(Math.abs((initialListBox?.height ?? 0) - (backgroundListBox?.height ?? 0))).toBeLessThanOrEqual(2);
    expect(Math.abs((initialDetailBox?.height ?? 0) - (backgroundDetailBox?.height ?? 0))).toBeLessThanOrEqual(2);
    await main.getByRole("button", { name: "Skills skills.md" }).click();
    await expect(main.getByText("## Core Skills")).toBeVisible();
    await main.getByRole("button", { name: "Edit document" }).click();
    await main.getByLabel("Capability markdown").fill("# Skills\n\n## Core Skills\n\n- E2E product strategy\n- Human-agent operations");
    await main.getByRole("button", { name: "Save document" }).click();
    await expect(page.getByText("Document saved")).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await main.getByRole("button", { name: "Skills skills.md" }).click();
    await expect(main.getByText("E2E product strategy")).toBeVisible({ timeout: 10_000 });

    const capabilitiesRes = await request.get(`/api/companies/${company.id}/team/users/${userId}/capabilities`);
    expect(capabilitiesRes.ok()).toBe(true);
    const capabilities = (await capabilitiesRes.json()) as {
      documents: Array<{ filename: string; content: string }>;
    };
    expect(capabilities.documents.find((doc) => doc.filename === "skills.md")?.content).toContain("E2E product strategy");

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
    await expect(main.getByText("Authority")).toBeVisible({ timeout: 10_000 });
    await expect(main.getByText("Responsibilities")).toBeVisible();
    await expect(main.getByText("Role & Department")).toHaveCount(0);
    await expect(main.getByText("Explicit grants", { exact: true })).toBeVisible();

    await main.getByRole("button", { name: "Edit roles" }).click();
    const rolesDialog = page.getByRole("dialog", { name: "Edit Roles" });
    await expect(rolesDialog).toBeVisible({ timeout: 5_000 });
    await rolesDialog.getByRole("combobox", { name: "Role" }).click();
    await page.getByRole("option", { name: "Team Lead" }).click();
    await rolesDialog.getByRole("combobox", { name: "Department" }).click();
    await page.getByRole("option", { name: department.name }).click();
    await rolesDialog.getByRole("combobox", { name: "Reports to" }).click();
    await page.getByRole("option", { name: /E2E Human Updated/ }).click();
    await rolesDialog.getByRole("button", { name: "Save Changes" }).click();

    await expect(page.getByText("Role saved")).toBeVisible({ timeout: 10_000 });
    await expect(rolesDialog).toBeHidden({ timeout: 10_000 });
    await page.reload();
    await expect(main.getByText("Team Lead").first()).toBeVisible();
    await expect(main.getByText(department.name).first()).toBeVisible();
    await expect(main.getByText("E2E Human Updated").first()).toBeVisible();

    await page.goto(`/${company.issuePrefix}/team/${added.userId}/settings`);
    await expect(main.getByText("Role & Department")).toHaveCount(0);
    await expect(main.getByRole("region", { name: "Profile" })).toHaveCount(0);
  });
});

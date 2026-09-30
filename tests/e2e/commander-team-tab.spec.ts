import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E smoke test — Commander (AoA Team) tab sub-tab navigation.
 *
 * Validates that the AoA-team header sub-tabs (Roster/Tasks/Kanban/Governance,
 * rendered by TeamPage with data-testid="aoa-header-subtab-*") load and switch
 * correctly. The sub-tab bar lives on TeamPage (CommanderTeamTab is mounted with
 * showSubTabs={false}), so specs target the `aoa-header-subtab-*` testids.
 *
 * NOTE: a freshly-created company is auto-provisioned a Commander crew
 * (ensureCommanderAgent in routes/companies.ts), so the roster is never empty via
 * the API — the "No AoA agents yet" empty state is unreachable here and is covered
 * by the component test (CommanderTeamTab.test.tsx with agents=[]).
 */

async function seedAoaAgent(request: APIRequestContext, companyId: string) {
  const res = await request.post(`/api/companies/${companyId}/agents`, {
    data: {
      name: "E2E Commander Agent",
      role: "general",
      title: "E2E Commander Agent",
      kind: "aoa",
      adapterType: "process",
      runtimeConfig: { aoa: { role: "lead" } },
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedAoaAgent failed: ${res.status()} ${body}`);
  }
  return res.json();
}

test.describe("Commander Team tab", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Commander-/);
  });

  test("AoA Team renders the agent roster", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Commander-Roster-${Date.now()}`);
    await seedAoaAgent(request, company.id);
    await page.goto(`/${company.issuePrefix}/team?tab=commander`);

    // Header sub-tab bar renders, and the seeded agent appears in the roster
    // (the company is also auto-provisioned a Commander crew on create).
    await expect(page.getByTestId("aoa-header-subtab-roster")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("E2E Commander Agent")).toBeVisible({ timeout: 10_000 });
  });

  test("Roster/Kanban/Governance sub-tabs render without error", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Commander-Tabs-${Date.now()}`);
    await seedAoaAgent(request, company.id);

    await page.goto(`/${company.issuePrefix}/team?tab=commander`);

    // Sub-tab bar should be visible
    await expect(page.getByTestId("aoa-header-subtab-roster")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("aoa-header-subtab-kanban")).toBeVisible();
    await expect(page.getByTestId("aoa-header-subtab-governance")).toBeVisible();

    // Roster (default) — agent name should appear
    await expect(page.getByText("E2E Commander Agent")).toBeVisible({ timeout: 5_000 });

    // Switch to Kanban — column headers should appear (testid-scoped: the per-agent
    // status text also contains "Idle"/"Running", so target the column headers).
    await page.getByTestId("aoa-header-subtab-kanban").click();
    await expect(page.getByTestId("kanban-column-idle")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("kanban-column-running")).toBeVisible({ timeout: 5_000 });

    // Switch to Governance — Avg trust metric should appear
    await page.getByTestId("aoa-header-subtab-governance").click();
    await expect(page.getByText("Avg trust")).toBeVisible({ timeout: 5_000 });

    // Switch back to Roster
    await page.getByTestId("aoa-header-subtab-roster").click();
    await expect(page.getByText("E2E Commander Agent")).toBeVisible({ timeout: 5_000 });
  });

  test("Governance tab shows oversight table for AoA agents", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Commander-Gov-${Date.now()}`);
    await seedAoaAgent(request, company.id);

    await page.goto(`/${company.issuePrefix}/team?tab=commander`);

    await expect(page.getByTestId("aoa-header-subtab-governance")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("aoa-header-subtab-governance").click();

    // Oversight table columns
    await expect(page.getByText("Avg trust")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Monthly spend")).toBeVisible({ timeout: 5_000 });

    // Agent row appears in the oversight table
    await expect(page.getByText("E2E Commander Agent")).toBeVisible({ timeout: 5_000 });
  });
});

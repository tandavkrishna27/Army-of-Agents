import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const DEFAULT_CREW_ITEM_ID = "team:aoa-curated/default-crew";
const DEFAULT_CREW_NAMES = [
  "Adjutant",
  "Scout",
  "Engineer",
  "Navigator",
  "Planner",
  "Memory Keeper",
  "Chronicler",
  "Reviewer",
  "Librarian",
  "Steward",
];
const TEST_COMPANY_PREFIX = "E2E-DefaultCrewProvision-";

test.describe("default crew company provisioning", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, new RegExp(`^${TEST_COMPANY_PREFIX}`));
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, new RegExp(`^${TEST_COMPANY_PREFIX}`));
  });

  test("company creation installs the full default crew and shows it in the AoA roster", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `${TEST_COMPANY_PREFIX}${Date.now()}`
    );

    const teamsResponse = await request.get(
      `/api/companies/${company.id}/teams`
    );
    expect(teamsResponse.ok(), await teamsResponse.text()).toBe(true);
    const teams = (await teamsResponse.json()) as {
      items: Array<{
        id: string;
        name: string;
        templateOrigin?: string | null;
        memberAgentIds?: string[];
      }>;
    };
    const crewTeam = teams.items.find(
      (team) => team.templateOrigin === DEFAULT_CREW_ITEM_ID
    );
    expect(
      crewTeam,
      "company should have an installed default crew team"
    ).toBeTruthy();
    expect(crewTeam?.memberAgentIds).toHaveLength(DEFAULT_CREW_NAMES.length);

    const membersResponse = await request.get(
      `/api/teams/${crewTeam!.id}/members`
    );
    expect(membersResponse.ok(), await membersResponse.text()).toBe(true);
    const members = (await membersResponse.json()) as {
      items: Array<{ agentId: string }>;
    };
    expect(members.items).toHaveLength(DEFAULT_CREW_NAMES.length);

    const agentsResponse = await request.get(
      `/api/companies/${company.id}/agents?kind=aoa`
    );
    expect(agentsResponse.ok(), await agentsResponse.text()).toBe(true);
    const agents = (await agentsResponse.json()) as Array<{
      id: string;
      name: string;
    }>;
    const memberIds = new Set(members.items.map((member) => member.agentId));
    const crewNames = agents
      .filter((agent) => memberIds.has(agent.id))
      .map((agent) => agent.name);
    expect(crewNames.sort()).toEqual([...DEFAULT_CREW_NAMES].sort());

    await page.goto(`/${company.issuePrefix}/team?tab=aoa&aoaTab=roster`);
    await expect(
      page.getByText("AoA agents in this company", { exact: true })
    ).toBeVisible({ timeout: 20_000 });
    for (const name of DEFAULT_CREW_NAMES) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({
        timeout: 15_000,
      });
    }
  });
});

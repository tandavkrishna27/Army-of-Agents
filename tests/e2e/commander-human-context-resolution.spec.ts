import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { writeFakeClaudeControl } from "./helpers/fake-claude";

async function sendMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function waitForTurnEnd(page: Page) {
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 30_000 });
}

test.describe("Commander human context resolution", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdHumanContext-/);
  });

  test("Commander can answer a natural-language human routing question with human context", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-CmdHumanContext-${Date.now()}`);
    const uniquePhrase = `commander context alpha ${Date.now()}`;

    const teamRes = await request.get(`/api/companies/${company.id}/team`);
    expect(teamRes.ok()).toBe(true);
    const team = (await teamRes.json()) as { currentUser: { userId: string } };
    const userId = team.currentUser.userId;

    const profileRes = await request.patch(`/api/companies/${company.id}/team/users/${userId}/profile`, {
      data: {
        displayName: "Commander Context Human",
        title: "Enterprise Routing Specialist",
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
        content: `# Skills\n\n## Core Skills\n\n- ${uniquePhrase}\n- Enterprise routing and escalation design`,
      },
    });
    expect(updateRes.ok()).toBe(true);

    const searchRes = await request.get(
      `/api/companies/${company.id}/team/humans/search?q=${encodeURIComponent(uniquePhrase)}&limit=5`,
    );
    expect(searchRes.ok()).toBe(true);
    const discovery = await searchRes.json();
    expect(discovery.results).toHaveLength(1);

    const contextRes = await request.get(`/api/companies/${company.id}/team/users/${userId}/agent-context`);
    expect(contextRes.ok()).toBe(true);
    const { bundle } = await contextRes.json();

    writeFakeClaudeControl({
      toolCalls: [
        {
          name: "mcp__aoa__query_human_context",
          input: { q: uniquePhrase },
          envelope: {
            success: true,
            data: {
              mode: "resolved_context",
              query: uniquePhrase,
              selectedHuman: discovery.results[0],
              candidates: discovery.results,
              bundle,
            },
            summary: `Resolved "${uniquePhrase}" to Commander Context Human`,
          },
        },
      ],
      text: `Commander Context Human can handle ${uniquePhrase}. Their capability profile lists enterprise routing and escalation design.`,
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, `Which human can handle ${uniquePhrase}?`);

    await expect(page.getByText("Used mcp aoa query human context")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Commander Context Human")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`Commander Context Human can handle ${uniquePhrase}.`)).toBeVisible({
      timeout: 30_000,
    });
    await waitForTurnEnd(page);
  });
});

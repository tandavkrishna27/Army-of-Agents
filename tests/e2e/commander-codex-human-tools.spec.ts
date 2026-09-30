import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  clearFakeCodexInvocations,
  writeFakeCodexControl,
} from "./helpers/fake-codex";

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function waitForTurnEnd(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Stop generation" }),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible({ timeout: 30_000 });
}

async function setCodexCliTool(
  request: APIRequestContext,
  companyId: string,
): Promise<void> {
  const res = await request.patch(
    `/api/companies/${companyId}/internal-agent/config`,
    { data: { cliTool: "codex" } },
  );
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`setCodexCliTool failed: ${res.status()} ${body}`);
  }
}

test.describe("Commander codex human tools", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdCodexHumans-/);
  });

  test.afterEach(async ({ page }) => {
    await page.goto("about:blank");
  });

  test("renders and persists a Codex query_humans tool call from the Commander UI", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdCodexHumans-${Date.now()}`,
    );
    await setCodexCliTool(request, company.id);

    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: "codex-e2e-human-tools-1",
      toolCalls: [
        {
          name: "query_humans",
          input: { limit: 10 },
          envelope: {
            success: true,
            data: {
              companyId: company.id,
              results: [
                {
                  userId: "local-board",
                  displayName: "Local Board",
                  email: "founder@example.com",
                  role: "founder",
                  departmentName: null,
                },
              ],
            },
            summary: "Found 1 human(s)",
          },
        },
      ],
      text: "The team currently has Local Board as the founder human.",
      usage: { input: 100, output: 40 },
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, "Who is on the human team?");

    await expect(page.getByRole("button", { name: "Used query humans" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("The team currently has Local Board as the founder human."),
    ).toBeVisible({ timeout: 30_000 });
    await waitForTurnEnd(page);

    const runsRes = await request.get(
      `/api/companies/${company.id}/internal-agent/runs?limit=5`,
    );
    expect(runsRes.ok()).toBe(true);
    const runsBody = (await runsRes.json()) as {
      runs: Array<{ status: string; toolsCalled: unknown }>;
    };
    expect(runsBody.runs[0]?.status).toBe("completed");
    expect(runsBody.runs[0]?.toolsCalled).toContain("query_humans");
  });

  test("renders and persists Codex find_humans and query_human_context calls from the Commander UI", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdCodexHumans-${Date.now()}`,
    );
    await setCodexCliTool(request, company.id);

    const uniquePhrase = `codex human context ${Date.now()}`;

    const teamRes = await request.get(`/api/companies/${company.id}/team`);
    expect(teamRes.ok()).toBe(true);
    const team = (await teamRes.json()) as { currentUser: { userId: string } };
    const userId = team.currentUser.userId;

    const profileRes = await request.patch(
      `/api/companies/${company.id}/team/users/${userId}/profile`,
      {
        data: {
          displayName: "Codex Context Human",
          title: "Enterprise Capability Lead",
        },
      },
    );
    expect(profileRes.ok()).toBe(true);

    const capabilitiesRes = await request.get(
      `/api/companies/${company.id}/team/users/${userId}/capabilities`,
    );
    expect(capabilitiesRes.ok()).toBe(true);
    const capabilities = (await capabilitiesRes.json()) as {
      documents: Array<{ id: string; filename: string }>;
    };
    const skills = capabilities.documents.find((doc) => doc.filename === "skills.md");
    expect(skills).toBeTruthy();

    const updateRes = await request.patch(
      `/api/companies/${company.id}/team/users/${userId}/capabilities/${skills!.id}`,
      {
        data: {
          content: `# Skills\n\n## Core Skills\n\n- ${uniquePhrase}\n- Enterprise capability routing`,
        },
      },
    );
    expect(updateRes.ok()).toBe(true);

    const searchRes = await request.get(
      `/api/companies/${company.id}/team/humans/search?q=${encodeURIComponent(uniquePhrase)}&limit=5`,
    );
    expect(searchRes.ok()).toBe(true);
    const discovery = (await searchRes.json()) as {
      results: Array<{ userId: string; displayName: string }>;
    };
    expect(discovery.results).toHaveLength(1);
    expect(discovery.results[0]?.userId).toBe(userId);

    const contextRes = await request.get(
      `/api/companies/${company.id}/team/users/${userId}/agent-context`,
    );
    expect(contextRes.ok()).toBe(true);
    const { bundle } = (await contextRes.json()) as { bundle: unknown };

    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: "codex-e2e-human-context-1",
      toolCalls: [
        {
          name: "find_humans",
          input: { q: uniquePhrase, limit: 5 },
          envelope: {
            success: true,
            data: discovery,
            summary: `Found Codex Context Human for "${uniquePhrase}"`,
          },
        },
        {
          name: "query_human_context",
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
            summary: `Resolved "${uniquePhrase}" to Codex Context Human`,
          },
        },
      ],
      text: `Codex Context Human can handle ${uniquePhrase}.`,
      usage: { input: 140, output: 55 },
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, `Find the human who can handle ${uniquePhrase}.`);

    await expect(page.getByRole("button", { name: "Used find humans" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "Used query human context" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(`Codex Context Human can handle ${uniquePhrase}.`),
    ).toBeVisible({ timeout: 30_000 });
    await waitForTurnEnd(page);

    const runsRes = await request.get(
      `/api/companies/${company.id}/internal-agent/runs?limit=5`,
    );
    expect(runsRes.ok()).toBe(true);
    const runsBody = (await runsRes.json()) as {
      runs: Array<{ status: string; toolsCalled: unknown }>;
    };
    expect(runsBody.runs[0]?.status).toBe("completed");
    expect(runsBody.runs[0]?.toolsCalled).toContain("find_humans");
    expect(runsBody.runs[0]?.toolsCalled).toContain("query_human_context");
  });
});

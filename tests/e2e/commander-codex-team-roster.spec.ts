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

test.describe("Commander codex team roster", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdCodexRoster-/);
  });

  test("renders and persists a Codex query_team_roster tool call from the Commander UI", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdCodexRoster-${Date.now()}`,
    );
    await setCodexCliTool(request, company.id);

    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: "codex-e2e-team-roster-1",
      toolCalls: [
        {
          name: "query_team_roster",
          input: { includeTree: true },
          envelope: {
            success: true,
            data: {
              companyId: company.id,
              counts: { humans: 1, agents: 1, total: 2 },
              roster: [
                {
                  id: "local-board",
                  kind: "human",
                  name: "Local Board",
                  role: "founder",
                  status: "active",
                  parent: null,
                  childCount: 1,
                  depth: 0,
                  path: ["Local Board"],
                },
                {
                  id: "agent-codex",
                  kind: "agent",
                  name: "Codex Agent",
                  role: "general",
                  status: "idle",
                  parent: { id: "local-board", kind: "human", name: "Local Board" },
                  childCount: 0,
                  depth: 1,
                  path: ["Local Board", "Codex Agent"],
                },
              ],
            },
            summary: "Found 2 team member(s): 1 human(s), 1 agent(s)",
          },
        },
      ],
      text: "Local Board is the founder human, and Codex Agent reports to Local Board.",
      usage: { input: 120, output: 45 },
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, "Who is on the team and who reports to whom?");

    await expect(page.getByRole("button", { name: "Used query team roster" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("Local Board is the founder human, and Codex Agent reports to Local Board."),
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
    expect(runsBody.runs[0]?.toolsCalled).toContain("query_team_roster");
  });
});

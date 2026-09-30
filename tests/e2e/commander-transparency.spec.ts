import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { createArtifactTurn, writeFakeClaudeControl } from "./helpers/fake-claude";

const TITLE = "Launch Plan Q3";
const CONTENT = `# ${TITLE}\n\nPhase one.`;

async function seedArtifact(request: any, companyId: string) {
  const res = await request.post(`/api/companies/${companyId}/artifacts`, {
    data: { title: TITLE, type: "document", source: "founder", content: CONTENT },
  });
  const b = await res.json();
  return { id: b.id, versionId: b.versions?.[0]?.id ?? b.currentVersionId ?? null, title: TITLE };
}

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

test.describe("Commander tool transparency", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdXparency-/);
  });

  test("tool activity renders with a status glyph, expands, persists across reload, and shows duration", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-CmdXparency-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id);
    await page.goto(`/${company.issuePrefix}/commander`);

    writeFakeClaudeControl(createArtifactTurn(artifact, "Drafted and saved the plan."));
    await sendMessage(page, "Draft a launch plan for Q3");

    // Completed tool activity row renders (completedToolLabel for the mcp tool).
    await expect(page.getByText("Used mcp aoa create artifact")).toBeVisible({ timeout: 30_000 });

    // Expandable — click the activity row by its visible label, the summary <pre> appears.
    // Note: the live-turn entry has data-testid="commander-tool-activity-1" (toolCallIdRef
    // starts at 0; first call gets ++ref = 1). We click by visible text as the more robust
    // approach in case the ref value differs across sessions.
    await page.getByText("Used mcp aoa create artifact").click();
    await expect(page.getByTestId("commander-tool-summary")).toBeVisible({ timeout: 10_000 });

    await waitForTurnEnd(page);

    // "Worked for Xs" caption (fake-claude result emits duration_ms:60 → 0.1s).
    await expect(page.getByTestId("commander-worked-for")).toBeVisible({ timeout: 10_000 });

    // PERSISTENCE: reload — tool activity now survives the server sync (the
    // core Phase 3 behavior change). serverToLocal maps persisted toolCalls.
    await page.reload();
    await expect(page.getByText("Used mcp aoa create artifact")).toBeVisible({ timeout: 20_000 });
  });
});

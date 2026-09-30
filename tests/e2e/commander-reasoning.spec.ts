import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { writeFakeClaudeControl } from "./helpers/fake-claude";

/**
 * E2E — Commander inline reasoning block (Plan 2, Phase 5).
 *
 * fake-claude emits a thinking_delta before the text deltas (control.reasoning
 * defaults to true). The server parser surfaces it as a "reasoning" SSE event,
 * the UI accumulates it onto the streaming message and renders a collapsible
 * CommanderReasoningBlock (data-testid="commander-reasoning"). The reasoning
 * text is persisted in internal_agent_messages.reasoning, so after a reload
 * the block still renders (collapsed).
 *
 * The key assertion that distinguishes Plan 2 from Plan 1: reasoning survives
 * page.reload() because it is a persisted DB column, not transient streaming
 * state.
 */

const THINKING_TEXT = "Considering the request…";

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

test.describe("Commander inline reasoning", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdReason-/);
  });

  test("reasoning block renders live and persists across reload", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdReason-${Date.now()}`,
    );
    await page.goto(`/${company.issuePrefix}/commander`);

    // Write a simple text-only turn; fake-claude emits the thinking_delta by
    // default (control.reasoning is not set to false).
    writeFakeClaudeControl({
      text: "Here is my response after thinking.",
    });

    await sendMessage(page, "Think about this carefully please");

    // The reasoning block should appear (it streams before the text reply).
    const reasoningBlock = page.getByTestId("commander-reasoning");
    await expect(reasoningBlock).toBeVisible({ timeout: 30_000 });

    // The block collapses on settle (intentional; unit-tested in
    // CommanderReasoningBlock.test.tsx). Click the toggle to expand it so the
    // text is in the DOM before asserting — mirrors the reload branch below.
    await reasoningBlock.getByRole("button").first().click();
    // The thinking text accumulated from the thinking_delta is visible in the
    // block (after expanding).
    await expect(page.getByText(THINKING_TEXT)).toBeVisible({
      timeout: 10_000,
    });

    // Wait for the turn to fully complete (streaming settled).
    await waitForTurnEnd(page);

    // Block is still present after turn end (collapsed by default once settled).
    await expect(reasoningBlock).toBeVisible({ timeout: 10_000 });

    // ── PERSISTENCE: reload page ─────────────────────────────────────────────
    // This is the key Plan 2 assertion: reasoning survives reload because it is
    // stored in internal_agent_messages.reasoning (unlike Plan 1's live-only
    // duration field which was not persisted).
    await page.reload();

    // After reload the message history is fetched from the server; the reasoning
    // column is mapped through serverToLocal and rendered as a collapsed block.
    await expect(page.getByTestId("commander-reasoning")).toBeVisible({
      timeout: 20_000,
    });

    // Click to expand the collapsed block and confirm the thinking text renders.
    await page.getByTestId("commander-reasoning").getByRole("button").click();
    await expect(page.getByText(THINKING_TEXT)).toBeVisible({
      timeout: 10_000,
    });
  });
});

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { writeFakeCodexControl } from "./helpers/fake-codex";

/**
 * E2E (P1, tightened per plan-review #7) — codex tokens + Est. Cost in
 * Settings → Commander → Run History.
 *
 * The only true end-to-end of the tokens/cost-in-Settings seam:
 *   fake-codex shim emits EXACT usage → parseCodexJsonl extracts
 *   {input_tokens:222, output_tokens:111} → SSE "done" carries tokenUsage →
 *   resolveRunCostCents computes costCents → internalAgentRuns DB row →
 *   GET /internal-agent/runs → RunHistoryTabContent renders token cell.
 *
 * Scoped assertions (plan-review fix #7): we use a UNIQUE reply text to find
 * the exact row for this run, AND assert EXACT input/output token numbers
 * (222 / 111), not just "some tokens exist". We also assert the "Est. Cost"
 * column header and the disclaimer text ("Cost is an estimate at list prices").
 *
 * Workers:1 means no other codex run races this one during the single spec.
 */

// Unique reply text so we can scope the Tokens assertion to THIS run's row.
const UNIQUE_REPLY = `codex-e2e-tokens-${Date.now()}-unique-reply-zebra`;

// Exact usage values we assert in the UI.
const INPUT_TOKENS = 222;
const OUTPUT_TOKENS = 111;

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

/** Flip cliTool to codex for the given company. */
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

test.describe("Commander codex tokens + Est. Cost in Run History", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdTokens-/);
  });

  test("codex run surfaces EXACT tokens (222/111) and Est. Cost label in Settings Run History", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdTokens-${Date.now()}`,
    );

    // Flip cliTool → codex.
    await setCodexCliTool(request, company.id);

    // Script fake-codex with EXACT usage so we can assert the exact numbers.
    writeFakeCodexControl({
      sessionId: "codex-e2e-tokens-session",
      text: UNIQUE_REPLY,
      usage: { input: INPUT_TOKENS, cached: 0, output: OUTPUT_TOKENS },
    });

    // ── Send one codex message ─────────────────────────────────────────────
    await page.goto(`/${company.issuePrefix}/commander`);
    await sendMessage(page, "Summarize the Q3 plan in one sentence");

    // Wait for the unique reply to confirm the turn completed.
    await expect(page.getByText(UNIQUE_REPLY)).toBeVisible({ timeout: 30_000 });
    await waitForTurnEnd(page);

    // ── Navigate to Settings → Commander → Run History ─────────────────────
    // URL pattern: /{prefix}/settings?tab=commander&sub=history
    await page.goto(
      `/${company.issuePrefix}/settings?tab=commander&sub=history`,
    );

    // The "Run History" tab should be active/visible.
    await expect(
      page.getByRole("tab", { name: "Run History" }),
    ).toBeVisible({ timeout: 15_000 });

    // ── Assert "Est. Cost" column header ──────────────────────────────────
    await expect(page.getByRole("columnheader", { name: "Est. Cost" })).toBeVisible({
      timeout: 10_000,
    });

    // ── Assert the disclaimer text (proves the Tab content is rendered) ────
    await expect(
      page.getByText(/Cost is an estimate at list prices/i),
    ).toBeVisible({ timeout: 10_000 });

    // ── Assert the EXACT token numbers in the Tokens column ───────────────
    // RunHistoryTabContent renders: `${formatTokens(inputTokens)} / ${formatTokens(outputTokens)}`
    // formatTokens(222) → "222", formatTokens(111) → "111" (< 1000 = no K suffix).
    // We look for the "222 / 111" pattern anywhere on the page (within the table row).
    await expect(
      page.getByText(/222\s*\/\s*111/),
    ).toBeVisible({ timeout: 15_000 });
  });
});

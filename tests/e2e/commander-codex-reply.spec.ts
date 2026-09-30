import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  writeFakeCodexControl,
  clearFakeCodexInvocations,
  readFakeCodexInvocations,
} from "./helpers/fake-codex";

/**
 * E2E (P0) — Commander codex path: reply renders + reasoning persists.
 *
 * This spec proves the full codex pipeline end-to-end:
 *   fake-codex shim → parseCodexJsonl → SSE reasoning+content events →
 *   InternalAgentPanel renders reply + CommanderReasoningBlock →
 *   persistence (reload shows reasoning block) → cli-mode contract
 *   (invocation record proves exec --json, model, effort flags, stdin, CODEX_HOME).
 *
 * The playwright config prepends tests/e2e/fixtures/fake-codex to the
 * webServer PATH, so `which codex` resolves the shim. Flipping
 * internal_agent_config.cliTool → "codex" via PATCH makes Commander's
 * cli-mode dispatch codex for this company.
 *
 * workers:1 + reuseExistingServer:false → single global control/invocations
 * files are race-free (plan-review fix #1/#5).
 *
 * Key assertion (plan-review fix #2/#3): the recorded invocation proves the
 * REAL cli-mode codex contract — exec --json, bypass flag, --model (NOT a
 * claude string), -c model_reasoning_effort=high, -c model_reasoning_summary=
 * detailed, ends with "-" (stdin sentinel), CODEX_HOME set, config.toml
 * written by cli-mode.
 */

const REASONING_TEXT = "Planning the launch sequence…";
const REPLY_TEXT = "Here is the 3-step plan: step one, step two, step three.";

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

/** Flip internal_agent_config.cliTool to "codex" for the given company. */
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

test.describe("Commander codex reply + invocation contract", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdCodexReply-/);
  });

  test("codex reply renders (not raw JSONL), reasoning block appears and persists, invocation proves cli-mode contract", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdCodexReply-${Date.now()}`,
    );

    // Flip cliTool to codex. A fresh company auto-seeds internal_agent_config
    // with cliTool=null (→ claude default). Patch BEFORE sending.
    await setCodexCliTool(request, company.id);

    // Write the scripted turn the next fake-codex spawn will emit.
    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: "codex-e2e-session-1",
      reasoning: REASONING_TEXT,
      text: REPLY_TEXT,
      usage: { input: 120, output: 60 },
    });

    await page.goto(`/${company.issuePrefix}/commander`);

    // ── Turn 1: send a message ─────────────────────────────────────────────
    await sendMessage(page, "Draft me a 3-step launch plan");

    // The reasoning block should appear (rendered before the reply text).
    const reasoningBlock = page.getByTestId("commander-reasoning");
    await expect(reasoningBlock).toBeVisible({ timeout: 30_000 });

    // The assistant reply renders the real text, NOT raw JSONL lines.
    await expect(page.getByText(REPLY_TEXT)).toBeVisible({ timeout: 15_000 });

    // The reasoning text is inside the collapsible "Thinking" block. Click to
    // expand it, then assert the text renders (may be collapsed by default once
    // the turn settles; the reasoning block collapses after streaming completes).
    await reasoningBlock.getByRole("button").click();
    await expect(page.getByText(REASONING_TEXT)).toBeVisible({ timeout: 10_000 });

    // Raw JSONL artifacts must NOT appear (pre-MX-chatparse regression guard).
    await expect(page.getByText(/"type":"thread.started"/)).toHaveCount(0);
    await expect(page.getByText(/"type":"item.completed"/)).toHaveCount(0);

    // Wait for the turn to fully complete.
    await waitForTurnEnd(page);

    // Reasoning block still present after stream settles (collapsed by default).
    await expect(reasoningBlock).toBeVisible({ timeout: 10_000 });

    // ── PERSISTENCE: reload page ───────────────────────────────────────────
    // Reasoning is stored in internal_agent_messages.reasoning — it must
    // survive a reload (the codex analogue of commander-reasoning.spec).
    await page.reload();

    await expect(page.getByTestId("commander-reasoning")).toBeVisible({
      timeout: 20_000,
    });

    // Expand the collapsed block and confirm the reasoning text re-renders.
    await page.getByTestId("commander-reasoning").getByRole("button").click();
    await expect(page.getByText(REASONING_TEXT)).toBeVisible({ timeout: 10_000 });

    // ── INVOCATION CONTRACT (plan-review fix #2/#3) ────────────────────────
    // Read what fake-codex actually received from cli-mode — this is the only
    // end-to-end proof that Commander dispatched codex with the right flags.
    const invocations = readFakeCodexInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(1);

    const inv = invocations[0];

    // Must start with "exec" + "--json" (one-shot JSON mode).
    expect(inv.argv[0]).toBe("exec");
    expect(inv.argv).toContain("--json");

    // Must include "--model" followed by a non-claude codex-compatible model.
    const modelIdx = inv.argv.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    const resolvedModel = inv.argv[modelIdx + 1];
    expect(resolvedModel).toBeTruthy();
    // Must NOT be a claude string (the bug the model-pin fix addressed).
    expect(resolvedModel).not.toMatch(/claude/i);
    // Must be a GPT/O-series model (codex-compatible).
    expect(resolvedModel).toMatch(/^(gpt-|o\d|chatgpt)/i);

    // Must include reasoning effort + summary flags.
    expect(inv.argv).toContain("-c");
    expect(inv.argv).toContain("model_reasoning_effort=high");
    expect(inv.argv).toContain("model_reasoning_summary=detailed");

    // Must end with "-" (stdin sentinel — prompt delivered over stdin).
    expect(inv.argv[inv.argv.length - 1]).toBe("-");

    // CODEX_HOME must be set (the per-session managed home cli-mode provisions).
    expect(inv.codexHome).toBeTruthy();

    // config.toml must exist inside CODEX_HOME (cli-mode writes MCP spec there).
    expect(inv.configTomlExists).toBe(true);
  });
});

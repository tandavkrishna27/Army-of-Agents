import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  writeFakeCodexControl,
  clearFakeCodexInvocations,
  readFakeCodexInvocations,
} from "./helpers/fake-codex";

/**
 * E2E (P2) — Commander codex two-turn continuity (resume argv deferred).
 *
 * Two sequential codex turns in one conversation, sharing the same sessionId.
 * Asserts:
 *   • Each turn independently invokes codex with the correct argv contract
 *     (exec --json, model, effort flags, ends with "-").
 *   • The reasoning block renders on BOTH turns.
 *   • Turn 2's reply text is distinct from turn 1's.
 *
 * RESUME ARGV NOTE: the `resume <sessionId>` flag requires the codex sessionId
 * to persist from turn 1 to turn 2. In the current Commander implementation,
 * agentLoopService + cliModeService are instantiated PER HTTP REQUEST (see
 * cli-mode.ts:472 + routes/internal-agent.ts:199), so the in-memory sessionStore
 * is discarded between requests — the sessionId cannot carry over.
 * The codex sessionId has no DB persistence column in internal_agent_conversations.
 * Resume across HTTP requests requires either a DB column or a process-level
 * singleton. This is a known gap; the resume argv assertion is left as a TODO
 * below (commented out) rather than asserting something the architecture cannot
 * yet deliver. The important test value here is: two turns, both render
 * correctly, no hang, reasoning on both.
 *
 * `clearFakeCodexInvocations()` is called before turn 2 so we scope the argv
 * assertion to the second spawn only.
 */

const SESSION_ID = "codex-e2e-resume-session-42";

const TURN1_REASONING = "Turn 1: analyzing the brief…";
const TURN1_REPLY = "Turn 1 reply: here is my initial assessment.";

const TURN2_REASONING = "Turn 2: continuing from my earlier analysis…";
const TURN2_REPLY = "Turn 2 reply: here is the follow-up, building on turn 1.";

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

test.describe("Commander codex two-turn resume", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdResume-/);
  });

  test("two codex turns both render correctly with reasoning blocks (resume argv deferred — see spec comment)", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-CmdResume-${Date.now()}`,
    );

    // Flip cliTool → codex.
    await setCodexCliTool(request, company.id);

    // ── Turn 1 ────────────────────────────────────────────────────────────
    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: SESSION_ID,
      reasoning: TURN1_REASONING,
      text: TURN1_REPLY,
      usage: { input: 50, output: 25 },
    });

    await page.goto(`/${company.issuePrefix}/commander`);

    await sendMessage(page, "Tell me about the project");

    // Turn 1 reasoning block and reply must appear.
    await expect(page.getByTestId("commander-reasoning").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(TURN1_REPLY)).toBeVisible({ timeout: 15_000 });
    await waitForTurnEnd(page);

    // ── Turn 2 ────────────────────────────────────────────────────────────
    // Clear invocations BEFORE turn 2 so we scope the argv assertion to it.
    clearFakeCodexInvocations();
    writeFakeCodexControl({
      sessionId: SESSION_ID,  // same sessionId — shim echoes it back
      reasoning: TURN2_REASONING,
      text: TURN2_REPLY,
      usage: { input: 80, output: 40 },
    });

    await sendMessage(page, "Follow up on that please");

    // Turn 2 reasoning block and reply must appear (there should now be ≥2
    // reasoning blocks in the page — one per turn).
    await expect(
      page.getByTestId("commander-reasoning").nth(1),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TURN2_REPLY)).toBeVisible({ timeout: 15_000 });
    await waitForTurnEnd(page);

    // ── INVOCATION CONTRACT for turn 2 (standard codex flags) ────────────
    // Read the invocation for turn 2 only (clearFakeCodexInvocations was
    // called just before turn 2).
    const invocations = readFakeCodexInvocations();
    expect(invocations.length).toBeGreaterThanOrEqual(1);

    const inv2 = invocations[0];

    // Turn 2 must have the standard codex exec contract flags.
    expect(inv2.argv[0]).toBe("exec");
    expect(inv2.argv).toContain("--json");
    expect(inv2.argv).toContain("model_reasoning_effort=high");

    // Must end with "-" (stdin sentinel).
    expect(inv2.argv[inv2.argv.length - 1]).toBe("-");

    // CODEX_HOME is still set on turn 2 (same per-session home writes).
    expect(inv2.codexHome).toBeTruthy();

    // TODO: once codexSessionId is persisted to DB (internal_agent_conversations
    // or a dedicated column), add: expect(inv2.argv).toContain("resume");
    // and: expect(inv2.argv[inv2.argv.indexOf("resume") + 1]).toBe(SESSION_ID);
    // See spec comment above for the architectural gap that currently prevents this.
  });
});

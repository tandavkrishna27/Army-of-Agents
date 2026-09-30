import { test, expect, type Page } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";
import {
  writeFakeClaudeControl,
  readFakeClaudeInvocations,
  clearFakeClaudeInvocations,
} from "./helpers/fake-claude";

/**
 * Composer gap coverage (completion plan Phase 7 — flows with no prior e2e):
 *
 *  1. Commander composer: attach a text file through the REAL attach control,
 *     send, and prove the file's content reached the CLI runtime (runtime text
 *     delivery end-to-end via the UI — not just the API-level check).
 *  2. Discussion composer: the attachment tray renders INSIDE the shared
 *     composer frame (Quiet Operator §25 containment contract).
 *  3. Discussion composer: a rapid double-submit produces exactly ONE durable
 *     entry (UI in-flight guard + server idempotency, end to end).
 *
 * Uses the deterministic fake-claude CLI (playwright.config.ts PATH prepend),
 * so no real provider runs.
 */

const SENTINEL = "MANGO-SENTINEL-4483";

async function sendCommanderMessage(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

async function waitForCommanderTurnEnd(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 30_000,
  });
}

async function createThread(
  request: import("@playwright/test").APIRequestContext,
  companyId: string,
  title: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title },
  });
  if (!res.ok()) throw new Error(`create thread failed: ${res.status()}`);
  return (await res.json()) as { id: string };
}

test.describe("composer gaps", () => {
  test.beforeEach(async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await cleanupTestCompanies(request, /^E2E-ComposerGap-/);
  });

  test("Commander: attached text file's content reaches the CLI runtime (UI end-to-end)", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-ComposerGap-Cmd-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/commander`);

    // The unified composer promises: real attach + mention controls in Commander.
    const attachInput = page.getByLabel("Attach files");
    await expect(attachInput).toBeAttached({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Mention a teammate" })).toBeVisible();

    // Attach a text file through the REAL picker input.
    await attachInput.setInputFiles({
      name: "briefing.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`Project codename: ${SENTINEL}. Launch is Neptember 3rd.`),
    });
    // The uploaded file renders as a chip carrying its filename.
    await expect(page.getByText("briefing.txt").first()).toBeVisible({ timeout: 15_000 });

    // Send a turn against the deterministic fake CLI, then prove the file's
    // CONTENT (not just its name) was delivered into the runtime prompt.
    clearFakeClaudeInvocations();
    writeFakeClaudeControl({ text: "I read the briefing." });
    await sendCommanderMessage(page, "What is the codename in the attached briefing?");
    await waitForCommanderTurnEnd(page);

    await expect(page.getByText("I read the briefing.").first()).toBeVisible({
      timeout: 15_000,
    });

    const invocations = readFakeClaudeInvocations();
    expect(invocations.length).toBeGreaterThan(0);
    const last = invocations[invocations.length - 1];
    const promptPayload = `${last.argv.join(" ")}\n${last.stdin}`;
    expect(promptPayload).toContain(SENTINEL);
  });

  test("Discussion: attachment tray renders INSIDE the shared composer frame", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-ComposerGap-Frame-${Date.now()}`);
    const thread = await createThread(request, company.id, `Frame containment ${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);

    // Mock v2: 📎 plain attach is the composer's only upload entry (the
    // file-artifact control was removed).
    await expect(page.getByTestId("entry-composer-attach-button")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("entry-composer-file-input").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("containment check"),
    });

    // Quiet Operator §25: the attachment card must live INSIDE the composer
    // frame, never in a detached panel. Assert descendant containment.
    const trayInsideFrame = page.locator(
      '[data-composer-frame] [data-testid="entry-composer-attachments"]',
    );
    await expect(trayInsideFrame).toBeVisible({ timeout: 15_000 });
  });

  test("Discussion: rapid double-submit produces exactly one durable entry", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-ComposerGap-Dupe-${Date.now()}`);
    const thread = await createThread(request, company.id, `Dupe guard ${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);

    const marker = `no-dupe-${Date.now()}`;
    const textarea = page.getByTestId("entry-composer-textarea");
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await textarea.fill(marker);
    // Two immediate submits with no wait between them — the in-flight guard +
    // server idempotency must resolve this to ONE durable entry.
    await textarea.press("Control+Enter");
    await textarea.press("Control+Enter");

    // The entry appears in the thread…
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 15_000 });

    // …and the API confirms exactly one row carries the marker.
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/companies/${company.id}/discussions/${thread.id}/entries`,
          );
          if (!res.ok()) return -1;
          const body = (await res.json()) as { entries?: Array<{ rawContent: string }> };
          return (body.entries ?? []).filter((e) => e.rawContent === marker).length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
  });
});

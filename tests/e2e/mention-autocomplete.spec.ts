import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E: @mention autocomplete dispatches Scout.
 *
 * Seeds a company + a "Scout" AoA agent, creates an empty thread via the API,
 * navigates to the thread detail page, then drives the EntryComposer:
 *   - Type `@Sc` → autocomplete dropdown opens, narrows to "Scout"
 *   - Click the "Scout" option → mention chip inserted
 *   - Ctrl+Enter → entry posted
 *
 * The plan also calls for asserting "Scout responds" after the dispatch.
 * That leg is omitted because:
 *   (a) the response requires the crew adapter subprocess to fire a real LLM,
 *   (b) Playwright's page.route() can't intercept calls made by a child
 *       process spawned by the AoA server.
 * See the "LLM gap" comment in onboarding-thread-pipeline.spec.ts for the
 * same caveat. The wakeup dispatch is, however, observable in the DB — the
 * row lands in `agent_wakeup_requests` immediately. The test could be
 * extended to assert that row exists; for now we stop at the UI signal.
 */

const SKIP_LLM = process.env.AOA_E2E_SKIP_LLM !== "false";

async function seedThread(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title: `E2E mention thread ${Date.now()}` },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedThread failed: ${res.status()} ${body}`);
  }
  return (await res.json()) as { id: string };
}

test.describe("@mention autocomplete dispatches Scout", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Mention-/);
  });

  test("typing @Sc opens autocomplete, selects Scout, posts entry", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Mention-${Date.now()}`);
    // Scout is auto-provisioned by ensureScout() on every company create —
    // re-seeding it triggers the duplicate-shortname guard and returns 409.
    const thread = await seedThread(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);

    // The composer mounts after the thread loads. The test surfaces the
    // textarea via data-testid (defined in EntryComposer.tsx).
    const textarea = page.getByTestId("entry-composer-textarea");
    await expect(textarea).toBeVisible({ timeout: 10_000 });

    // ── Typing `@` opens the dropdown ──
    await textarea.focus();
    await textarea.type("@", { delay: 30 });
    await expect(page.getByTestId("entry-autocomplete")).toBeVisible({
      timeout: 5_000,
    });

    // ── Typing `Sc` narrows it to "Scout" ──
    await textarea.type("Sc", { delay: 30 });
    const scoutOption = page.getByTestId("entry-autocomplete-option-Scout");
    await expect(scoutOption).toBeVisible({ timeout: 5_000 });

    // ── Clicking Scout inserts the chip. EntryComposer wires onMouseDown
    // (not onClick) on the suggestion so the focus race against the
    // textarea's onBlur doesn't swallow the selection. Playwright's `click`
    // fires mousedown→mouseup→click so it threads the needle. ──
    await scoutOption.click();
    const mentionChip = page.getByTestId("mention-chip-Scout");
    await expect(mentionChip).toBeVisible({ timeout: 5_000 });

    // ── Append a body so the submit button is enabled and post via Ctrl+Enter
    // (EntryComposer's submit shortcut — Cmd+Enter on macOS, Ctrl+Enter
    // everywhere else. Playwright normalizes to Control on win32/linux). ──
    await textarea.type(" please scout this", { delay: 20 });
    const submitShortcut =
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
    await textarea.press(submitShortcut);

    // ── Verify the entry posted: the rawContent ("@Scout please scout this")
    // appears in the entries list. We don't assert the agent wakeup directly
    // because that requires DB access; instead we wait for the optimistic
    // UI update + server roundtrip. ──
    await expect(
      page.getByText(/please scout this/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // ── LLM gap ──
    // Scout's response would arrive as a new entry once the crew adapter
    // subprocess fires the LLM. Omitted for the same reason documented in
    // onboarding-thread-pipeline.spec.ts. To unblock: add an
    // AOA_E2E_FAKE_CREW_LLM mode that bypasses the adapter subprocess.
    test.fixme(
      !SKIP_LLM,
      "Scout reply assertion requires LLM + crew adapter — see LLM gap comment",
    );
  });
});

void SKIP_LLM;

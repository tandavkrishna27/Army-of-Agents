import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

/**
 * Composer B-states (approved mock §5) — cross-surface e2e.
 *
 * Discussion thread is the canonical surface (cases 1–4); one Comments-tab
 * cross-check (case 5) proves the silent-send-failure regression stays fixed
 * on the second wiring of the same shared components.
 *
 *  1. Send failed → banner (draft retained) → Retry succeeds → entry lands.
 *  2. Offline → strip renders + send gated; back online → strip clears after
 *     the LiveUpdates socket reconnects.
 *  3. Drag-over → in-frame overlay (with the 10 MB limit copy); drop →
 *     the file eager-uploads into the tray.
 *  4. Eager upload fails → failed card with per-file Retry → Retry flips the
 *     card to Ready.
 *  5. Comments tab: aborted POST arms the shared banner (draft retained),
 *     Retry posts the comment (idempotent replay via clientSubmissionId).
 *
 * Route interception is always scoped by METHOD + URL so reads (entry/comment
 * list refetches) are never severed — only the write under test.
 */

async function createThread(
  request: APIRequestContext,
  companyId: string,
  title: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title },
  });
  if (!res.ok()) throw new Error(`create thread failed: ${res.status()}`);
  return (await res.json()) as { id: string };
}

async function createIssue(
  request: APIRequestContext,
  companyId: string,
  title: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/issues`, {
    data: { title },
  });
  if (!res.ok()) throw new Error(`create issue failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

/** Open a thread and wait for the composer to be interactive. */
async function gotoThread(page: Page, prefix: string, threadId: string) {
  await page.goto(`/${prefix}/discussions/${threadId}`);
  const textarea = page.getByTestId("entry-composer-textarea");
  await expect(textarea).toBeVisible({ timeout: 15_000 });
  return textarea;
}

test.describe("composer B-states", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-BStates-/);
  });

  test("Discussion: send failed → banner keeps the draft → Retry posts the entry", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-BStates-SendFail-${Date.now()}`);
    const thread = await createThread(request, company.id, `Send fail ${Date.now()}`);
    const textarea = await gotoThread(page, company.issuePrefix, thread.id);

    const marker = `send-fail-${Date.now()}`;
    await textarea.fill(marker);

    // Sever ONLY the entry POST — list refetches (GET) must keep flowing.
    await page.route("**/discussions/*/entries", async (route) => {
      if (route.request().method() === "POST") return route.abort();
      return route.continue();
    });

    await textarea.press("Enter");

    // Mock §5: failure never eats your work — banner up, draft retained.
    const banner = page.getByTestId("composer-send-failed-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue(marker);

    // Restore the network, then Retry replays the SAME snapshotted payload
    // (same clientSubmissionId — safe even if the first request had landed).
    await page.unroute("**/discussions/*/entries");
    await banner.getByRole("button", { name: "Retry" }).click();

    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    // The entry bubble lands in the thread (the retry-success clearSignal
    // empties the textarea, so this match is the thread entry, not the draft).
    await expect(page.getByText(marker).first()).toBeVisible({ timeout: 15_000 });
    await expect(textarea).toHaveValue("");
  });

  test("Discussion: offline strip renders, gates send, and clears on reconnect", async ({
    page,
    request,
  }) => {
    // Chromium's setOffline emulation does NOT sever already-open WebSockets,
    // so the LiveUpdates socket would stay open and the provider's reconnect
    // path (the only transition back to "open") would never run. Record every
    // socket the page opens so the test can force a REAL close and exercise
    // the genuine reconnect → strip-clears flow.
    await page.addInitScript(() => {
      const recorded: WebSocket[] = [];
      (window as unknown as { __e2eSockets: WebSocket[] }).__e2eSockets = recorded;
      const RealWebSocket = window.WebSocket;
      window.WebSocket = class extends RealWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          recorded.push(this);
        }
      } as typeof WebSocket;
    });

    const company = await seedCompany(request, `E2E-BStates-Offline-${Date.now()}`);
    const thread = await createThread(request, company.id, `Offline ${Date.now()}`);
    const textarea = await gotoThread(page, company.issuePrefix, thread.id);

    const draft = `offline-draft-${Date.now()}`;
    await textarea.fill(draft);

    await page.context().setOffline(true);
    // Belt-and-braces: setOffline fires the window event in headed Chromium,
    // but headless propagation has been observed to lag — dispatching the same
    // event the provider listens for makes the trigger deterministic.
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    const strip = page.getByTestId("composer-offline-strip");
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText("You're offline");
    await expect(page.getByTestId("entry-composer-submit")).toBeDisabled();

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    // Force the (still-open, see above) socket closed so the provider runs its
    // real close → backoff → reconnect → "open" transition.
    await page.evaluate(() => {
      const sockets = (window as unknown as { __e2eSockets?: WebSocket[] }).__e2eSockets ?? [];
      for (const socket of sockets) socket.close();
    });

    // The reconnect rides the provider's backoff timer — allow generous time
    // for close + backoff + fresh handshake before the strip must be gone.
    await expect(strip).toHaveCount(0, { timeout: 25_000 });
    // The draft survived the whole offline round-trip.
    await expect(textarea).toHaveValue(draft);
  });

  test("Discussion: drag-over shows the in-frame overlay; drop attaches the file", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-BStates-Drag-${Date.now()}`);
    const thread = await createThread(request, company.id, `Drag drop ${Date.now()}`);
    await gotoThread(page, company.issuePrefix, thread.id);

    // Build the DataTransfer IN PAGE CONTEXT — Playwright has no cross-process
    // File/DataTransfer construction for drag events.
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["drag-me"], "dragged.txt", { type: "text/plain" }));
      return d;
    });

    await page.dispatchEvent('[data-testid="entry-composer"]', "dragenter", { dataTransfer: dt });

    const overlay = page.getByTestId("composer-drop-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("10 MB");

    await page.dispatchEvent('[data-testid="entry-composer"]', "drop", { dataTransfer: dt });

    await expect(overlay).toHaveCount(0);
    // The dropped file runs the SAME eager-upload path as the picker and
    // lands as a Ready card in the tray.
    const card = page.getByTestId("entry-composer-attachment-dragged.txt");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  });

  test("Discussion: failed eager upload offers per-file Retry that flips the card to Ready", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-BStates-Upload-${Date.now()}`);
    const thread = await createThread(request, company.id, `Upload retry ${Date.now()}`);
    await gotoThread(page, company.issuePrefix, thread.id);

    // Abort the FIRST upload POST only; the Retry's request goes through.
    let abortedOnce = false;
    await page.route("**/assets/files", async (route) => {
      if (route.request().method() === "POST" && !abortedOnce) {
        abortedOnce = true;
        return route.abort();
      }
      return route.continue();
    });

    await page.getByTestId("entry-composer-file-input").setInputFiles({
      name: "retry-me.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retry payload"),
    });

    // Mock §5: the failed upload is RETAINED as a card with its own Retry —
    // never silently dropped.
    const card = page.getByTestId("entry-composer-attachment-retry-me.txt");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toHaveAttribute("data-state", "failed");
    await expect(card).toContainText("Failed");

    // exact: true — the sibling "Remove retry-me.txt" button substring-matches
    // a bare { name: "Retry" } query.
    await card.getByRole("button", { name: "Retry", exact: true }).click();

    // The card cycles failed → uploading → ready (the transient uploading card
    // re-mounts, so poll the final attribute rather than a mid-state).
    await expect(card).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  });

  test("Comments tab: aborted POST arms the banner (draft kept); Retry posts the comment", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-BStates-Comment-${Date.now()}`);
    const task = await createIssue(request, company.id, "B-states comments regression task");

    await page.goto(`/${company.issuePrefix}/issues/${task.id}`);
    const slideOver = page.locator('[data-slot="sheet-content"]');
    await expect(slideOver).toBeVisible({ timeout: 15_000 });

    await slideOver.getByRole("tab", { name: /comments/i }).click();
    const composer = page.getByTestId("task-comments-composer");
    const editor = composer.locator('[contenteditable="true"]');
    await expect(editor).toBeVisible({ timeout: 15_000 });

    const marker = `comment-retry-${Date.now()}`;
    await editor.click();
    await page.keyboard.type(marker);
    await expect(editor).toContainText(marker);

    // Sever ONLY the comment POST — the comments GET keeps flowing.
    await page.route("**/issues/*/comments", async (route) => {
      if (route.request().method() === "POST") return route.abort();
      return route.continue();
    });

    await composer.getByRole("button", { name: "Comment", exact: true }).click();

    // The old regression: this failure was swallowed silently and the submit
    // looked successful. Now the shared banner arms and the draft is kept.
    const banner = page.getByTestId("composer-send-failed-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(editor).toContainText(marker);

    await page.unroute("**/issues/*/comments");
    await banner.getByRole("button", { name: "Retry" }).click();

    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    // The comment lands in the timeline (the success-clear empties the editor,
    // so scope the match to the timeline).
    await expect(
      page.getByTestId("task-comments-timeline").getByText(marker),
    ).toBeVisible({ timeout: 15_000 });
  });
});

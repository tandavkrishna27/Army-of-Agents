import {randomUUID} from "node:crypto";
import {expect, test} from "@playwright/test";
import {createDb, instanceUserRoles, issues} from "../../packages/db/src/index";

test("real entry recovery, geometry and company isolation", async ({browser}) => {
  test.setTimeout(180_000);
  const baseURL = process.env.AOA_AUTH_E2E_BASE_URL!;
  const context = await browser.newContext({baseURL, extraHTTPHeaders: {Origin: baseURL}});
  const db = createDb(process.env.AOA_AUTH_E2E_DATABASE_URL!);
  try {
    // Canonical loopback-only test seam mints a real Better Auth session; all
    // workspace calls below use normal session middleware and the real database.
    const signup = await context.request.post("/api/test-support/session", {
      headers: {Authorization: `Bearer ${process.env.AOA_E2E_TEST_SUPPORT_TOKEN}`}, data: {
      name: "Universe acceptance", email: `universe-${randomUUID()}@example.test`,
    }});
    expect(signup.ok(), await signup.text()).toBe(true);
    const minted = await signup.json();
    await context.addCookies([{name: minted.cookie.name, value: minted.cookie.value,
      url: baseURL, httpOnly: true, sameSite: "Lax"}]);
    const session = await (await context.request.get("/api/auth/get-session")).json();
    await db.insert(instanceUserRoles).values({userId: session.user.id, role: "instance_admin"}).onConflictDoNothing();
    const created = await context.request.post("/api/companies", {data: {name: `Universe ${randomUUID().slice(0,8)}`, budgetMonthlyCents: 0}});
    expect(created.ok(), await created.text()).toBe(true);
    const company = await created.json();
    const [task, otherTask] = await db.insert(issues).values([
      {companyId: company.id, title: "Persistence acceptance task", identifier: `${company.issuePrefix}-901`, status: "todo"},
      {companyId: company.id, title: "Independent panel task", identifier: `${company.issuePrefix}-902`, status: "todo"},
    ]).returning();
    const conversationResponse = await context.request.post(`/api/companies/${company.id}/internal-agent/conversations`, {data: {title: "Acceptance workspace"}});
    expect(conversationResponse.ok(), await conversationResponse.text()).toBe(true);
    const conversation = await conversationResponse.json();
    const layoutURL = `/api/companies/${company.id}/universe/conversations/${conversation.id}/layout`;
    const readLayout = async () => {
      const result = await context.request.get(layoutURL);
      expect(result.ok(), await result.text()).toBe(true);
      return result.json();
    };
    const otherResponse = await context.request.post("/api/companies", {data: {name: `Other ${randomUUID().slice(0,8)}`, budgetMonthlyCents: 0}});
    expect(otherResponse.ok(), await otherResponse.text()).toBe(true);
    const otherCompany = await otherResponse.json();
    const page = await context.newPage();
    await page.goto(`/${company.issuePrefix}/universe?conversation=${conversation.id}`);
    await expect(page.getByRole("status", {name: "Layout save status"})).toHaveText(/Ready|Saved/);
    await page.getByRole("button", {name: "Work", exact: true}).click();
    await page.getByRole("dialog", {name: "Work", exact: true}).getByRole("button", {name: task.title, exact: true}).click();
    const panel = page.locator(".universe-panel");
    const header = panel.locator("header");
    await expect(panel).toBeVisible();
    await expect.poll(async () => (await readLayout()).document.panels.length).toBe(1);
    const initial = (await readLayout()).document.panels[0].rect;
    await header.focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(async () => (await readLayout()).document.panels[0].rect.x).toBeGreaterThan(initial.x);
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(async () => (await readLayout()).document.panels[0].rect.width).toBeGreaterThan(initial.width);
    const h = (await header.boundingBox())!;
    await page.mouse.move(h.x + 60, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 100, h.y + h.height / 2 + 25, {steps: 10});
    await page.mouse.up();
    await expect.poll(async () => (await readLayout()).document.panels[0].rect.y).toBeGreaterThan(initial.y);
    const beforeResize = (await readLayout()).document.panels[0].rect;
    const corner = (await page.locator(".react-flow__resize-control.handle.bottom.right").boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 - 25, corner.y + corner.height / 2 - 20, {steps: 10});
    await page.mouse.up();
    await expect.poll(async () => (await readLayout()).document.panels[0].rect.width).toBeLessThan(beforeResize.width);
    await expect.poll(async () => (await readLayout()).document.panels[0].rect.height).toBeLessThan(beforeResize.height);
    const saved = await readLayout();
    await panel.getByRole("button", {name: "Maximize panel", exact: true}).click();
    await expect.poll(async () => (await readLayout()).document.maximized).not.toBeNull();
    await page.reload();
    await panel.getByRole("button", {name: "Restore panel", exact: true}).click();
    await expect.poll(async () => (await readLayout()).document.maximized).toBeNull();
    expect((await readLayout()).document.panels[0].rect).toEqual(saved.document.panels[0].rect);

    // Browser storage fault only: no simulated server or successful fake writes.
    const revision = (await readLayout()).revision;
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      (window as any).__restoreStorage = () => {Storage.prototype.setItem = original;};
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith("aoa:universe:layout:v1:")) throw new DOMException("Storage quota test", "QuotaExceededError");
        return original.call(this, key, value);
      };
    });
    await panel.getByRole("button", {name: "Pin panel", exact: true}).click();
    await expect(page.getByRole("status", {name: "Layout save status"})).toHaveText("Layout recovery needs attention");
    expect((await readLayout()).revision).toBe(revision);
    await page.evaluate(() => (window as any).__restoreStorage());
    await page.getByRole("button", {name: "Retry layout", exact: true}).click();
    await expect.poll(async () => (await readLayout()).document.panels[0].pinned).toBe(true);
    await expect(page.getByRole("status", {name: "Layout save status"})).toHaveText("Saved");

    const scope = JSON.stringify([JSON.stringify([session.user.id, session.session.id]), company.id, conversation.id]);
    const journal = "aoa:universe:layout:v1:" + scope;
    const beforeCorrupt = await readLayout();
    await page.evaluate(key => sessionStorage.setItem(key, "unreadable recovery"), journal);
    await page.reload();
    await expect(page.getByText("This tab’s recovery record cannot be read.", {exact: false})).toBeVisible();
    await expect(page.getByRole("button", {name: "Discard invalid recovery"})).toBeDisabled();
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", {name: "Export layout recovery"}).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("universe-layout-recovery.json");
    await page.getByLabel("Discard this unreadable local recovery record").check();
    await page.getByRole("button", {name: "Discard invalid recovery"}).click();
    await expect(page.getByText("This tab’s recovery record cannot be read.", {exact: false})).toHaveCount(0);
    expect((await readLayout()).revision).toBe(beforeCorrupt.revision);
    expect((await readLayout()).document).toEqual(beforeCorrupt.document);
    await page.setViewportSize({width: 390, height: 844});
    await page.emulateMedia({reducedMotion: "reduce"});
    await page.reload();
    await expect(panel).toBeVisible();
    const bounds = (await panel.boundingBox())!;
    expect(await page.locator(".universe-commander-blob").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.width).toBeLessThanOrEqual(390);
    await header.focus();
    await expect(header).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", {name: "Unpin panel", exact: true})).toBeFocused();
    await page.screenshot({path: "test-results/universe-production/narrow-acceptance.png"});

    await page.setViewportSize({width: 1280, height: 720});
    // SPA navigation through the actual lobby, not a replacement mocked owner.
    await page.getByRole("button", {name: "Settings", exact: true}).click();
    await page.getByRole("button", {name: "Return to lobby", exact: true}).click();
    await page.getByRole("button", {name: `Open ${otherCompany.name} Universe`, exact: true}).click();
    await expect(page.getByRole("navigation", {name: "Universe", exact: true})).toBeVisible();
    await expect(page.getByText(task.title, {exact: true})).toHaveCount(0);
    await expect(page.locator(".universe-panel")).toHaveCount(0);
    // A real inaccessible conversation cannot silently select another workspace.
    await page.goto(`/${otherCompany.issuePrefix}/universe?conversation=${conversation.id}`);
    await expect(page.getByText("This conversation is unavailable.", {exact: false})).toBeVisible();
    await expect(page.getByLabel("Universe workspace", {exact: true})).toHaveCount(0);
    expect((await readLayout()).document).toEqual(beforeCorrupt.document);
    await page.goto(`/${company.issuePrefix}/universe?conversation=${conversation.id}`);
    await expect(panel).toBeVisible();
    const replacement = await context.request.post("/api/test-support/session", {
      headers: {Authorization: `Bearer ${process.env.AOA_E2E_TEST_SUPPORT_TOKEN}`},
      data: {name: "Replacement owner", email: `replacement-${randomUUID()}@example.test`},
    });
    expect(replacement.ok(), await replacement.text()).toBe(true);
    const nextSession = await replacement.json();
    await context.addCookies([{name: nextSession.cookie.name, value: nextSession.cookie.value,
      url: baseURL, httpOnly: true, sameSite: "Lax"}]);
    const nextOwner = await (await context.request.get("/api/auth/get-session")).json();
    await db.insert(instanceUserRoles).values({userId: nextOwner.user.id, role: "instance_admin"}).onConflictDoNothing();
    await page.evaluate(key => sessionStorage.setItem(key, "old owner's private recovery"), journal);
    await page.reload();
    await expect(page.getByText("This conversation is unavailable.", {exact: false})).toBeVisible();
    await expect(page.locator(".universe-panel")).toHaveCount(0);
    expect((await context.request.get(layoutURL)).status()).toBe(404);
    expect(await page.evaluate(key => sessionStorage.getItem(key), journal)).toBeNull();

    await context.addCookies([{name: minted.cookie.name, value: minted.cookie.value,
      url: baseURL, httpOnly: true, sameSite: "Lax"}]);
    const removed = await context.request.delete(`/api/issues/${task.id}`);
    expect(removed.ok(), await removed.text()).toBe(true);
    await page.reload();
    await expect(page.getByText("Layout is unavailable. Your recovery data has been kept.", {exact: true})).toBeVisible({timeout: 15_000});
    await expect(page.locator(".universe-panel")).toHaveCount(0);
    await expect(page.getByText(task.title, {exact: true})).toHaveCount(0);

  } finally {
    await context.close();
    await (db as typeof db & {$client: {end: () => Promise<void>}}).$client.end();
  }
});

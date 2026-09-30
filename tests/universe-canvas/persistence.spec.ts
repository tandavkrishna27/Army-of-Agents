import {test, expect, type BrowserContext} from "@playwright/test";
import {emptyUniverseLayoutDocument, type LayoutPatch, type LayoutAck} from "../../packages/shared/src/validators/universe-layout";
import {applyLayoutWithOpenings} from "../../server/src/services/universe-layout-document";
const scope = {companyId: "fixture-company", userId: "fixture-user", conversationId: "fixture-conversation"};
const key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "task", "task", null]);
async function transport(context: BrowserContext) {
 let snapshot = {schemaVersion: 1, revision: 1, document: applyLayoutWithOpenings(emptyUniverseLayoutDocument(), [{type: "open", key, ref: {kind: "task", id: "task"}, title: "Fixture task", rect: {x: 100, y: 80, width: 420, height: 300}}], scope).document};
 const writes: LayoutPatch[] = []; const receipts = new Map<string, LayoutAck>(); let loseReply = false; let revoked = false;
 await context.route("**/api/auth/get-session", route => route.fulfill({json: {user: {id: scope.userId}, session: {id: "fixture-login", userId: scope.userId}}}));
 await context.route("**/api/companies/**/layout**", async route => {
  if (revoked) return route.fulfill({status: 404, json: {error: "not found"}});
  const request = route.request(); const operationId = request.url().split("/operations/")[1];
  if (operationId) return route.fulfill({status: receipts.has(operationId) ? 200 : 404, json: receipts.get(operationId) ?? {error: "missing"}});
  if (request.method() === "GET") return route.fulfill({json: snapshot});
  const patch = request.postDataJSON() as LayoutPatch; writes.push(patch);
  if (receipts.has(patch.operationId)) return route.fulfill({json: receipts.get(patch.operationId)});
  if (patch.expectedRevision !== snapshot.revision) return route.fulfill({status: 409, json: {error: "conflict"}});
  const applied = applyLayoutWithOpenings(snapshot.document, patch.operations, scope);
  snapshot = {...snapshot, revision: snapshot.revision + 1, document: applied.document};
  const ack = {schemaVersion: 1, operationId: patch.operationId, revision: snapshot.revision, nextOpenedOrdinal: snapshot.document.nextOpenedOrdinal, opened: applied.opened};
  receipts.set(patch.operationId, ack);
  if (loseReply) {loseReply = false; return route.abort("failed");}
  return route.fulfill({json: ack});
 });
 return {writes, snapshot: () => snapshot, loseNextReply: () => {loseReply = true;}, revoke: () => {revoked = true;}};
}
test("saved drag retains local content and Undo, camera survives reload with no hydration writes", async ({page, context}) => {
 const server = await transport(context); await page.goto("/universe-persistence-harness.html");
 const draft = page.getByRole("textbox", {name: "Local task draft"}); await draft.fill("unsaved input");
 expect(server.writes).toHaveLength(0);
 const header = page.getByLabel("Fixture task panel controls"); const box = (await header.boundingBox())!;
 const before = {...server.snapshot().document.panels[0].rect};
 await page.mouse.move(box.x + 80, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 140, box.y + box.height / 2, {steps: 5}); await page.mouse.up();
 await expect.poll(() => server.writes.length).toBeGreaterThan(0);
 await expect(page.getByRole("status", {name: "Layout save status"})).toHaveText("Saved");
 await expect(draft).toHaveValue("unsaved input");
 await page.getByRole("button", {name: "Undo gesture"}).click();
 await expect.poll(() => server.snapshot().document.panels[0].rect).toEqual(before);
 await page.getByRole("button", {name: "Set camera"}).click();
 await expect.poll(() => server.snapshot().document.viewport).toEqual({x: 40, y: 20, zoom: .75});
 const count = server.writes.length; await page.reload(); await expect(draft).toBeVisible();
 await expect.poll(() => page.locator(".react-flow__viewport").evaluate(el => {const m = new DOMMatrix(getComputedStyle(el).transform); return {x: m.e, y: m.f, zoom: m.a};})).toEqual({x: 40, y: 20, zoom: .75});
 expect(server.writes).toHaveLength(count);
});
test("two tabs retain same-property conflict until explicit choice", async ({page, context}) => {
 const server = await transport(context); const second = await context.newPage();
 await Promise.all([page.goto("/universe-persistence-harness.html"), second.goto("/universe-persistence-harness.html")]);
 await expect(second.getByRole("button", {name: "Pin panel", exact: true})).toBeVisible();
 await page.getByRole("button", {name: "Pin panel", exact: true}).click();
 await expect.poll(() => server.writes.length).toBe(1);
 await second.getByRole("button", {name: "Pin panel", exact: true}).click();
 await expect(second.getByText("Compare layout changes")).toBeVisible();
 expect(server.writes).toHaveLength(1);
 await second.getByRole("button", {name: "Use saved layout"}).click();
 await expect(second.getByText("Compare layout changes")).toHaveCount(0);
 await expect(second.getByRole("button", {name: "Unpin panel", exact: true})).toBeVisible();
});
test("lost acknowledgement recovers from receipt after reload without applying twice", async ({page, context}) => {
 const server = await transport(context); await page.goto("/universe-persistence-harness.html");
 await expect(page.getByRole("button", {name: "Pin panel", exact: true})).toBeVisible(); server.loseNextReply();
 await page.getByRole("button", {name: "Pin panel", exact: true}).click();
 await expect(page.getByRole("status", {name: "Layout save status"})).toContainText("Offline");
 await page.reload();
 await expect(page.getByRole("status", {name: "Layout save status"})).toHaveText("Saved");
 await expect(page.getByRole("button", {name: "Unpin panel", exact: true})).toBeVisible();
 expect(server.writes).toHaveLength(1);
});

test("independent tab edits rebase and revoked data disappears on refresh", async ({page, context}) => {
 const server = await transport(context); const second = await context.newPage();
 await Promise.all([page.goto("/universe-persistence-harness.html"), second.goto("/universe-persistence-harness.html")]);
 await expect(second.getByRole("button", {name: "Pin panel", exact: true})).toBeVisible();
 await page.getByRole("button", {name: "Pin panel", exact: true}).click();
 await expect.poll(() => server.writes.length).toBe(1);
 await second.getByRole("button", {name: "Set camera"}).click();
 await expect.poll(() => server.writes.length).toBe(2);
 expect(server.snapshot().document.panels[0].pinned).toBe(true);
 expect(server.snapshot().document.viewport.zoom).toBe(.75);
 server.revoke(); await second.getByRole("button", {name: "Refresh snapshot"}).click();
 await expect(second.getByText("Layout is unavailable. Your recovery data has been kept.")).toBeVisible();
 await expect(second.getByRole("textbox", {name: "Local task draft"})).toHaveCount(0);
 expect(server.writes).toHaveLength(2);
});
test("narrow reduced-motion reload keeps preferred geometry and supports keyboard controls", async ({page, context}) => {
 const server = await transport(context); await page.setViewportSize({width: 390, height: 720});
 await page.emulateMedia({reducedMotion: "reduce"});
 const preferred = {...server.snapshot().document.panels[0].rect};
 await page.goto("/universe-persistence-harness.html");
 const pin = page.getByRole("button", {name: "Pin panel", exact: true});
 await pin.focus(); await page.keyboard.press("Enter");
 await expect.poll(() => server.writes.length).toBe(1);
 expect(server.snapshot().document.panels[0].rect).toEqual(preferred);
 await page.reload(); await expect(page.getByRole("button", {name: "Unpin panel", exact: true})).toBeVisible();
 expect(server.writes).toHaveLength(1);
 expect(server.snapshot().document.panels[0].rect).toEqual(preferred);
});

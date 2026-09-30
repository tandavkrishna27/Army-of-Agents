import { test, expect, type Page, type Locator } from "@playwright/test";
import type { State, Rect } from "../../ui/src/components/universe/panel-state";
import path from "node:path";

const shotDir = path.resolve("test-results/universe-canvas");
const button = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });
const frame = (page: Page, kind = "task") =>
  page.getByRole("region", { name: `${kind} fixture`, exact: true });
async function expectCamera(
  page: Page,
  expected: { x: number; y: number; zoom: number }
) {
  await expect
    .poll(async () =>
      JSON.parse((await page.getByTestId("camera-state").textContent())!)
    )
    .toEqual(expected);
  await expect
    .poll(() =>
      page.locator(".react-flow__viewport").evaluate((e) => {
        const m = new DOMMatrix(getComputedStyle(e).transform);
        return { x: m.e, y: m.f, zoom: m.a };
      })
    )
    .toEqual(expected);
}
async function state(page: Page): Promise<State> {
  return JSON.parse(
    (await page.getByTestId("registry-state").textContent()) || "null"
  );
}
async function rect(page: Page, kind = "task") {
  return Object.values((await state(page)).panels).find(
    (p) => p.ref.id === kind
  )!.rect;
}
async function box(item: Locator) {
  const result = await item.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}
function near(actual: Rect, expected: Rect) {
  for (const key of ["x", "y", "width", "height"] as const)
    expect(actual[key], key).toBeCloseTo(expected[key], 1);
}
async function setup(page: Page, zoom = 1, kind = "task") {
  await page.goto("/universe-harness.html");
  await button(page, `Zoom ${zoom}`).click();
  await button(page, `Open ${kind}`).click();
  await expect(frame(page, kind)).toBeVisible();
  await expect(frame(page, kind).locator("header")).toBeFocused();
  await expect
    .poll(() =>
      page.locator(".react-flow__viewport").evaluate((e) => {
        const matrix = new DOMMatrix(getComputedStyle(e).transform);
        return { x: matrix.e, y: matrix.f, zoom: matrix.a };
      })
    )
    .toEqual({ x: 0, y: 0, zoom });
  // Wait for the measured controlled ReactFlow viewport to reach a painted frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}
async function drag(
  page: Page,
  item: Locator,
  dx: number,
  dy: number,
  header = false
) {
  const b = await box(item);
  const x = b.x + (header ? 100 : b.width / 2),
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 12 });
  await page.mouse.up();
}
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => {
    if (
      !test.info().title.includes("throwing renderer") ||
      !error.message.includes("Deliberately unavailable fixture")
    )
      throw error;
  });
});

for (const kind of ["task", "artifact", "iframe"])
  for (const zoom of [0.5, 1, 2]) {
    test(`${kind} at ${zoom}: header and all eight resize directions`, async ({
      page,
    }) => {
      await setup(page, zoom, kind);
      const initial = await box(frame(page, kind));
      expect(initial.width).toBe(520);
      expect(initial.height).toBe(360);
      let previous = await rect(page, kind);
      await drag(page, frame(page, kind).locator("header"), 40, 20, true);
      near(await rect(page, kind), {
        ...previous,
        x: previous.x + 40 / zoom,
        y: previous.y + 20 / zoom,
      });
      near(await box(frame(page, kind)), {
        ...initial,
        x: initial.x + 40,
        y: initial.y + 20,
      });
      for (const direction of [
        "top",
        "bottom",
        "left",
        "right",
        "top.left",
        "top.right",
        "bottom.left",
        "bottom.right",
      ]) {
        const selector = `.react-flow__resize-control.${
          direction.includes(".") ? "handle" : "line"
        }.${direction}`;
        const control = page.locator(selector);
        await expect(control).toHaveCount(1);
        const dx = direction.includes("left")
          ? -20
          : direction.includes("right")
          ? 20
          : 0;
        const dy = direction.includes("top")
          ? -20
          : direction.includes("bottom")
          ? 20
          : 0;
        previous = await rect(page, kind);
        const visible = await box(frame(page, kind));
        await drag(page, control, dx, dy);
        const expected = {
          x: previous.x + (dx < 0 ? dx / zoom : 0),
          y: previous.y + (dy < 0 ? dy / zoom : 0),
          width: previous.width + Math.abs(dx) / zoom,
          height: previous.height + Math.abs(dy) / zoom,
        };
        await test.step(`${direction} resize`, async () => {
          near(await rect(page, kind), expected);
        });
        near(await box(frame(page, kind)), {
          x: visible.x + (dx < 0 ? dx : 0),
          y: visible.y + (dy < 0 ? dy : 0),
          width: visible.width + Math.abs(dx),
          height: visible.height + Math.abs(dy),
        });
        await button(page, "Undo geometry").click();
        near(await rect(page, kind), previous);
        await expect
          .poll(() => frame(page, kind).boundingBox())
          .toEqual(visible);
      }
      await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
    });
    test(`${kind} at ${zoom}: maximize minimize restore preserves content and camera`, async ({
      page,
    }) => {
      await setup(page, zoom, kind);
      const normal = await rect(page, kind);
      const canvas = await box(page.getByTestId("universe-canvas"));
      await page.mouse.move(canvas.x + 30, canvas.y + 100);
      await page.mouse.down();
      await page.mouse.move(canvas.x + 70, canvas.y + 120, { steps: 8 });
      await page.mouse.up();
      const camera = { x: 40, y: 20, zoom };
      await expectCamera(page, camera);
      near(await rect(page, kind), normal);
      const visible = await box(frame(page, kind));
      const content = frame(page, kind).locator(".universe-panel-body");
      const marker = await content.elementHandle();
      if (kind === "task")
        await page
          .getByRole("textbox", { name: "Fixture draft" })
          .fill("persistent draft");
      if (kind === "iframe")
        await page
          .frameLocator("iframe")
          .getByPlaceholder("Embedded text input")
          .fill("persistent iframe");
      await frame(page, kind)
        .getByRole("button", { name: "Maximize panel", exact: true })
        .click();
      near(
        await box(frame(page, kind)),
        await box(page.getByTestId("universe-canvas"))
      );
      await expectCamera(page, camera);
      await button(page, "Zoom 2").click();
      expect(
        JSON.parse((await page.getByTestId("camera-state").textContent())!)
      ).toEqual(camera);
      await page.setViewportSize({ width: 1200, height: 800 });
      await expect
        .poll(async () => (await box(frame(page, kind))).width)
        .toBe(1200);
      near(
        await box(frame(page, kind)),
        await box(page.getByTestId("universe-canvas"))
      );
      near(await rect(page, kind), normal);
      await expectCamera(page, camera);
      await frame(page, kind)
        .getByRole("button", { name: "Minimize panel", exact: true })
        .click();
      await expect(page.locator("section[data-panel-key]")).toHaveAttribute(
        "inert",
        ""
      );
      await expect(frame(page, kind)).toHaveCount(0);
      expect(await marker!.evaluate((e) => e.isConnected)).toBe(true);
      await expectCamera(page, camera);
      await button(page, `Restore ${kind} fixture`).click();
      near(await rect(page, kind), normal);
      near(await box(frame(page, kind)), visible);
      await expectCamera(page, camera);
      await expect.soft(frame(page, kind).locator("header")).toBeFocused();
      await frame(page, kind)
        .getByRole("button", { name: "Maximize panel", exact: true })
        .click();
      await expectCamera(page, camera);
      await frame(page, kind)
        .getByRole("button", { name: "Restore panel", exact: true })
        .click();
      near(await rect(page, kind), normal);
      await expectCamera(page, camera);
      expect(await marker!.evaluate((e) => e.isConnected)).toBe(true);
      if (kind === "task")
        await expect(
          page.getByRole("textbox", { name: "Fixture draft" })
        ).toHaveValue("persistent draft");
      if (kind === "iframe")
        await expect(
          page.frameLocator("iframe").getByPlaceholder("Embedded text input")
        ).toHaveValue("persistent iframe");
    });
  }

test("body selection and scroll, overlap focus, pin and keyboard geometry", async ({
  page,
}) => {
  await setup(page);
  const task = frame(page);
  const original = await rect(page);
  const cameraBeforeControl = JSON.parse(
    (await page.getByTestId("camera-state").textContent())!
  );
  await drag(
    page,
    task.getByRole("button", { name: "Pin panel", exact: true }),
    70,
    30
  );
  near(await rect(page), original);
  await expectCamera(page, cameraBeforeControl);
  await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
  const draft = page.getByRole("textbox", { name: "Fixture draft" });
  await draft.fill("select these words");
  await draft.press("Control+A");
  await draft.press("Alt+ArrowRight");
  near(await rect(page), original);
  expect(
    await draft.evaluate(
      (e: HTMLTextAreaElement) => e.selectionEnd - e.selectionStart
    )
  ).toBe(18);
  await task.getByRole("button", { name: "Pin panel", exact: true }).click();
  near(await rect(page), original);
  await button(page, "Commander arrange fixture").click();
  near(await rect(page), original);
  await drag(page, task.locator("header"), -80, -30, true);
  const dragged = await rect(page);
  await task.locator("header").focus();
  await page.keyboard.press("Alt+ArrowRight");
  near(await rect(page), { ...dragged, x: dragged.x + 10 });
  await page.keyboard.press("Alt+Shift+ArrowRight");
  near(await rect(page), {
    ...dragged,
    x: dragged.x + 10,
    width: dragged.width + 10,
  });
  const retained = await rect(page);
  await button(page, "Open artifact").click();
  const artifact = frame(page, "artifact");
  const artifactRect = await rect(page, "artifact");
  const body = artifact.locator(".universe-panel-body");
  await body.hover();
  await page.mouse.wheel(0, 500);
  await expect.poll(() => body.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  near(await rect(page, "artifact"), artifactRect);
  const b = await box(task);
  await page.mouse.click(b.x + 30, b.y + 20);
  expect((await state(page)).selected).toBe(
    await task.getAttribute("data-panel-key")
  );
  near(await rect(page), retained);
  await page.screenshot({ path: path.join(shotDir, "canvas-overlap.png") });
  await task
    .getByRole("button", { name: "Maximize panel", exact: true })
    .click();
  await page.screenshot({ path: path.join(shotDir, "canvas-maximized.png") });
});

test("single click on an unfocused panel control acts without a prior focus click", async ({
  page,
}) => {
  await setup(page);
  const task = frame(page);
  const taskKey = (await task.getAttribute("data-panel-key"))!;
  await button(page, "Open artifact").click();
  const artifact = frame(page, "artifact");
  const artifactKey = (await artifact.getAttribute("data-panel-key"))!;
  // Park the front artifact well below the task header so the task controls stay exposed.
  await drag(page, artifact.locator("header"), 40, 280, true);
  expect((await state(page)).selected).toBe(artifactKey);
  // A SINGLE click on the unfocused task's Pin toggles it in one click, without a
  // prior focus click and without flashing the panel to the selected state.
  await task.getByRole("button", { name: "Pin panel", exact: true }).click();
  const snapshot = await state(page);
  expect(snapshot.panels[taskKey].pinned).toBe(true);
  expect(snapshot.selected).toBe(artifactKey);
  // Re-foreground the artifact, then a SINGLE click on the unfocused task's Close removes it.
  await button(page, "Open artifact").click();
  expect((await state(page)).selected).toBe(artifactKey);
  await task.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(task).toHaveCount(0);
  expect((await state(page)).panels[taskKey]).toBeUndefined();
  await expect(artifact).toBeVisible();
});

for (const zoom of [0.5, 1, 2])
  test(`keyboard movement and resize use ten CSS pixels at ${zoom}`, async ({
    page,
  }) => {
    await setup(page, zoom);
    const header = frame(page).locator("header");
    await header.focus();
    const initial = await rect(page);
    const visible = await box(frame(page));
    await page.keyboard.press("Alt+ArrowRight");
    near(await rect(page), { ...initial, x: initial.x + 10 / zoom });
    near(await box(frame(page)), { ...visible, x: visible.x + 10 });
    await page.keyboard.press("Alt+Shift+ArrowDown");
    near(await rect(page), {
      ...initial,
      x: initial.x + 10 / zoom,
      height: initial.height + 10 / zoom,
    });
  });

for (const zoom of [0.5, 1, 2])
  test(`pointer text selection and body scroll isolate canvas at ${zoom}`, async ({
    page,
  }) => {
    await setup(page, zoom, "artifact");
    const original = await rect(page, "artifact");
    const camera = await page.getByTestId("camera-state").textContent();
    const paragraph = frame(page, "artifact").locator("article p").first();
    const b = await box(paragraph);
    await page.mouse.dblclick(b.x + 20 * zoom, b.y + b.height / 2);
    expect(
      (await page.evaluate(() => window.getSelection()?.toString()))?.length
    ).toBeGreaterThan(0);
    const body = frame(page, "artifact").locator(".universe-panel-body");
    await body.hover();
    await page.mouse.wheel(0, 300);
    await expect
      .poll(() => body.evaluate((e) => e.scrollTop))
      .toBeGreaterThan(0);
    near(await rect(page, "artifact"), original);
    expect(await page.getByTestId("camera-state").textContent()).toBe(camera);
  });

for (const zoom of [0.5, 1, 2])
  test(`camera pans normally and freezes for maximized wheel and pointer at ${zoom}`, async ({
    page,
  }) => {
    await setup(page, zoom);
    const original = await rect(page);
    const canvas = await box(page.getByTestId("universe-canvas"));
    await page.mouse.move(canvas.x + 30, canvas.y + 100);
    await page.mouse.down();
    await page.mouse.move(canvas.x + 70, canvas.y + 120, { steps: 8 });
    await page.mouse.up();
    try {
      await expect
        .poll(async () =>
          JSON.parse((await page.getByTestId("camera-state").textContent())!)
        )
        .toEqual({ x: 40, y: 20, zoom });
    } finally {
      await test.info().attach("pan-final-state", {
        contentType: "application/json",
        body: JSON.stringify({
          camera: JSON.parse(
            (await page.getByTestId("camera-state").textContent())!
          ),
          matrix: await page.locator(".react-flow__viewport").evaluate((e) => {
            const m = new DOMMatrix(getComputedStyle(e).transform);
            return { x: m.e, y: m.f, zoom: m.a };
          }),
          normal: await rect(page),
          screen: await box(frame(page)),
          original,
        }),
      });
    }
    near(await rect(page), original);
    await button(page, `Zoom ${zoom}`).click();
    await frame(page)
      .getByRole("button", { name: "Maximize panel", exact: true })
      .click();
    const frozen = await page.getByTestId("camera-state").textContent();
    const transform = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    await frame(page).locator("header").hover();
    await page.mouse.wheel(0, -300);
    await drag(page, frame(page).locator("header"), 40, 20, true);
    expect(await page.getByTestId("camera-state").textContent()).toBe(frozen);
    expect(
      await page.locator(".react-flow__viewport").getAttribute("style")
    ).toBe(transform);
    near(await rect(page), original);
    near(
      await box(frame(page)),
      await box(page.getByTestId("universe-canvas"))
    );
  });

for (const zoom of [0.5, 1, 2])
  test(`pointer resize clamps explicit minimum and maximum at ${zoom}`, async ({
    page,
  }) => {
    await setup(page, zoom);
    await drag(page, page.locator(".handle.bottom.right"), -1000, -1000);
    const minimum = await rect(page);
    expect(minimum.width).toBeCloseTo(320 / zoom);
    expect(minimum.height).toBeCloseTo(240 / zoom);
    const canvas = await box(page.getByTestId("universe-canvas"));
    await drag(page, page.locator(".handle.bottom.right"), 2000, 2000);
    const maximum = await rect(page);
    expect(maximum.width).toBeCloseTo(canvas.width / zoom);
    expect(maximum.height).toBeCloseTo(canvas.height / zoom);
    expect(
      [maximum.x, maximum.y, maximum.width, maximum.height].every(
        Number.isFinite
      )
    ).toBe(true);
    await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
  });

test("zero measured bounds refuse opening and recover with finite visible geometry", async ({
  page,
}) => {
  await page.route("**/universe-harness.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (
        await response.text()
      ).replace(
        "<head>",
        '<head><style id="zero-layout-fixture">.universe-canvas { flex: none !important; width: 0 !important; height: 0 !important; }</style>'
      ),
    });
  });
  await page.goto("/universe-harness.html");
  // Test-only initial physical layout; no controller or gesture operation is injected.
  await expect(page.getByTestId("universe-canvas")).toHaveCSS("width", "0px");
  await expect(page.locator(".react-flow")).toHaveCount(0);
  await button(page, "Open task").click();
  await expect(page.locator("section[data-panel-key]")).toHaveCount(0);
  expect(await state(page)).toBeNull();
  await page.locator("#zero-layout-fixture").evaluate((e) => e.remove());
  await expect(page.locator(".react-flow")).toHaveCount(1);
  await button(page, "Open task").click();
  const visible = await box(frame(page)),
    canvas = await box(page.getByTestId("universe-canvas"));
  expect(Object.values(visible).every(Number.isFinite)).toBe(true);
  expect(visible.x).toBeGreaterThanOrEqual(canvas.x);
  expect(visible.y).toBeGreaterThanOrEqual(canvas.y);
  expect(visible.x + visible.width).toBeLessThanOrEqual(
    canvas.x + canvas.width
  );
  expect(visible.y + visible.height).toBeLessThanOrEqual(
    canvas.y + canvas.height
  );
});

test("history conflict fence and external edit during cancellation", async ({
  page,
}) => {
  await setup(page);
  await drag(page, frame(page).locator("header"), 40, 20, true);
  await button(page, "Commander arrange fixture").click();
  const external = await rect(page);
  await button(page, "Undo geometry").click();
  near(await rect(page), external);
  const b = await box(frame(page).locator("header"));
  await page.mouse.move(b.x + 100, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 150, b.y + b.height / 2 + 20);
  await button(page, "Commander arrange fixture").evaluate(
    (e: HTMLButtonElement) => e.click()
  );
  const concurrent = await rect(page);
  await page.evaluate(() =>
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }))
  );
  await page.mouse.move(b.x + 200, b.y + 60);
  await page.mouse.up();
  near(await rect(page), concurrent);
  await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
});

test("initial open focus and minimize recovery focus", async ({ page }) => {
  await setup(page);
  await expect.soft(frame(page).locator("header")).toBeFocused();
  await frame(page)
    .getByRole("button", { name: "Minimize panel", exact: true })
    .click();
  await expect(button(page, "Open task")).toBeFocused();
});

test("completed long drag is one undo; no-op and cancellation preserve history and release shields", async ({
  page,
}) => {
  await setup(page, 1, "iframe");
  const initial = await rect(page, "iframe");
  const header = frame(page, "iframe").locator("header");
  await drag(page, header, 60, 30, true);
  const completed = await rect(page, "iframe");
  await drag(page, header, 0, 0, true);
  for (const event of ["pointercancel", "blur"])
    for (const kind of ["drag", "resize"]) {
      const target =
        kind === "drag" ? header : page.locator(".handle.bottom.right");
      const b = await box(target);
      const x = b.x + (kind === "drag" ? 100 : b.width / 2),
        y = b.y + (kind === "drag" ? 20 : b.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 40, y + 20, { steps: 5 });
      await expect(page.getByTestId("iframe-shield")).toHaveCount(1);
      await page.evaluate(
        (event) =>
          window.dispatchEvent(
            event === "pointercancel"
              ? new PointerEvent(event, { bubbles: true })
              : new Event(event)
          ),
        event
      );
      near(await rect(page, "iframe"), completed);
      await page.mouse.move(x + 80, y + 40);
      await page.mouse.up();
      near(await rect(page, "iframe"), completed);
      await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
    }
  await button(page, "Undo geometry").click();
  near(await rect(page, "iframe"), initial);
  await button(page, "Undo geometry").click();
  near(await rect(page, "iframe"), initial);
  await button(page, "Redo geometry").click();
  near(await rect(page, "iframe"), completed);
  const b = await box(header);
  await page.mouse.move(b.x + 100, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(1400, 950, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
});

test("closing one panel preserves sibling generation geometry and content", async ({
  page,
}) => {
  await setup(page);
  await drag(page, frame(page).locator("header"), -120, -50, true);
  await button(page, "Open iframe").click();
  const sibling = frame(page, "iframe");
  const siblingElement = await sibling.elementHandle();
  const iframeElement = await sibling.locator("iframe").elementHandle();
  await page
    .frameLocator("iframe")
    .getByPlaceholder("Embedded text input")
    .fill("sibling draft survives close");
  const saved = Object.values((await state(page)).panels).find(
    (p) => p.ref.id === "iframe"
  )!;
  const visible = await box(sibling);
  // Focus existing task through its launcher so its close button is exposed.
  await button(page, "Open task").click();
  await frame(page)
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(frame(page)).toHaveCount(0);
  await expect(sibling).toBeVisible();
  await expect(page.locator("section[data-panel-key]")).toHaveCount(1);
  expect(Object.values((await state(page)).panels)).toEqual([saved]);
  near(await box(sibling), visible);
  expect(await siblingElement!.evaluate((e) => e.isConnected)).toBe(true);
  expect(await iframeElement!.evaluate((e) => e.isConnected)).toBe(true);
  await expect(
    page.frameLocator("iframe").getByPlaceholder("Embedded text input")
  ).toHaveValue("sibling draft survives close");
});

test("close/reopen generation and scope replacement reject stale callbacks and history", async ({
  page,
}) => {
  await setup(page, 0.5);
  const first = Object.values((await state(page)).panels)[0];
  const instance = await page.getByTestId("mount-count").textContent();
  await button(page, "Capture stale close").click();
  await frame(page)
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(button(page, "Open task")).toBeFocused();
  await button(page, "Open task").click();
  expect(
    Object.values((await state(page)).panels)[0].generation
  ).toBeGreaterThan(first.generation);
  expect(await page.getByTestId("mount-count").textContent()).not.toBe(
    instance
  );
  await button(page, "Replay stale close").click();
  await expect(frame(page)).toBeVisible();
  await drag(page, frame(page).locator("header"), 50, 20, true);
  await button(page, "Capture stale close").click();
  const b = await box(frame(page).locator("header"));
  await page.mouse.move(b.x + 100, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 140, b.y + 30);
  // Scope replacement is an intentional external lifecycle event, not the gesture under test.
  await button(page, "Switch scope").evaluate((e: HTMLButtonElement) =>
    e.click()
  );
  await page.mouse.up();
  await expect(page.locator("section[data-panel-key]")).toHaveCount(0);
  await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
  await expectCamera(page, { x: 0, y: 0, zoom: 1 });
  await button(page, "Open task").click();
  const fresh = await rect(page);
  await button(page, "Undo geometry").click();
  near(await rect(page), fresh);
  await button(page, "Replay stale close").click();
  await expect(frame(page)).toBeVisible();
});

test("background edge resize foregrounds its incarnation and emits only geometry fields", async ({
  page,
}) => {
  await setup(page);
  const task = frame(page);
  await drag(page, task.locator("header"), -120, -40, true);
  const before = await rect(page);
  await button(page, "Open artifact").click();
  const taskKey = (await task.getAttribute("data-panel-key"))!;
  const artifact = frame(page, "artifact");
  const activeColor = await artifact
    .locator("header")
    .evaluate((e) => getComputedStyle(e).color);
  const inactiveColor = await task
    .locator("header")
    .evaluate((e) => getComputedStyle(e).color);
  expect.soft(inactiveColor).not.toBe(activeColor);
  expect((await state(page)).selected).not.toBe(taskKey);
  const edge = task
    .locator("..")
    .locator(".react-flow__resize-control.line.left");
  const b = await box(edge);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2, {
    steps: 5,
  });
  const resizing = await state(page);
  near(resizing.panels[taskKey].rect, {
    ...before,
    x: before.x - 40,
    width: before.width + 40,
  });
  expect.soft(resizing.selected).toBe(taskKey);
  expect.soft(resizing.order.at(-1)).toBe(taskKey);
  expect
    .soft(Object.keys(resizing.panels[taskKey].rect).sort())
    .toEqual(["height", "width", "x", "y"]);
  await expect
    .soft(task)
    .toHaveAttribute(
      "data-generation",
      String(resizing.panels[taskKey].generation)
    );
  await page.mouse.up();
  const after = await state(page);
  expect(after.panels[taskKey].rect).toEqual(resizing.panels[taskKey].rect);
  await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
  await button(page, "Undo geometry").click();
  near(await rect(page), before);
});

for (const type of ["Close", "Minimize"])
  test(`sibling ${type.toLowerCase()} during a real drag publishes rollback and fences late callbacks`, async ({
    page,
  }) => {
    await setup(page);
    const initial = await rect(page);
    await drag(page, frame(page).locator("header"), -120, -40, true);
    const prior = await rect(page);
    await button(page, "Open iframe").click();
    const sibling = frame(page, "iframe");
    const siblingPanel = Object.values((await state(page)).panels).find(
      (p) => p.ref.id === "iframe"
    )!;
    const h = await box(frame(page).locator("header"));
    const visible = await box(frame(page));
    await page.mouse.move(h.x + 80, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + 130, h.y + h.height / 2 + 20, { steps: 5 });
    near(await rect(page), { ...prior, x: prior.x + 50, y: prior.y + 20 });
    await expect(page.getByTestId("iframe-shield")).toHaveCount(2);
    // External lifecycle command while the real D3 drag is still active.
    await sibling
      .getByRole("button", { name: `${type} panel`, exact: true })
      .evaluate((e: HTMLButtonElement) => e.click());
    const final = await state(page);
    near(await rect(page), prior);
    near(await box(frame(page)), visible);
    if (type === "Close") {
      expect(final.panels[siblingPanel.key]).toBeUndefined();
      await expect(sibling).toHaveCount(0);
    } else {
      expect(final.panels[siblingPanel.key]).toEqual({
        ...siblingPanel,
        minimized: true,
      });
      await expect(button(page, "Restore iframe fixture")).toBeVisible();
    }
    await expect(page.getByTestId("iframe-shield")).toHaveCount(0);
    await page.mouse.move(h.x + 180, h.y + h.height / 2 + 40);
    await page.mouse.up();
    expect(await state(page)).toEqual(final);
    near(await box(frame(page)), visible);
    await button(page, "Undo geometry").click();
    near(await rect(page), initial);
    await button(page, "Undo geometry").click();
    near(await rect(page), initial);
  });

test("missing and throwing renderer keep an operable shell", async ({
  page,
}) => {
  await setup(page, 1, "missing");
  await expect(frame(page, "missing")).toContainText("unavailable");
  await frame(page, "missing")
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await button(page, "Open throwing").click();
  await expect(frame(page, "throwing")).toContainText(
    "This view is unavailable"
  );
  await frame(page, "throwing")
    .getByRole("button", { name: "Minimize panel", exact: true })
    .click();
  await button(page, "Restore throwing fixture").click();
  await frame(page, "throwing")
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
});

for (const zoom of [0.5, 1, 2])
  test(`narrow reduced-motion coarse targets at ${zoom}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      page.on("pageerror", (e) => {
        throw e;
      });
      await page.goto("http://127.0.0.1:5183/universe-harness.html");
      await button(page, `Zoom ${zoom}`).click();
      await button(page, "Open task").click();
      const visible = await box(frame(page)),
        canvas = await box(page.getByTestId("universe-canvas"));
      expect(visible.x).toBeGreaterThanOrEqual(canvas.x);
      expect(visible.y).toBeGreaterThanOrEqual(canvas.y);
      expect(visible.width).toBeLessThanOrEqual(canvas.width);
      expect(visible.height).toBeLessThanOrEqual(canvas.height);
      const sizes = await page
        .locator(".react-flow__resize-control")
        .evaluateAll((es) =>
          es.map((e) => {
            const r = e.getBoundingClientRect();
            return e.classList.contains("handle")
              ? r.width
              : e.classList.contains("left") || e.classList.contains("right")
              ? r.width
              : r.height;
          })
        );
      expect(sizes).toEqual(Array(8).fill(24));
      await drag(page, page.locator(".handle.bottom.right"), -500, -500);
      const small = await rect(page);
      expect(small.width).toBeGreaterThan(0);
      expect(small.height).toBeGreaterThan(0);
      expect(Object.values(small).every(Number.isFinite)).toBe(true);
    } finally {
      await context.close();
    }
  });

for (const count of [1, 10, 50])
  test(`${count} mounted panels: timing sample, drag and zoom preserve instances`, async ({
    page,
    browser,
  }, info) => {
    await page.goto("/universe-harness.html");
    const start = performance.now();
    await button(
      page,
      count === 1 ? "Open task" : `Open ${count} fixtures`
    ).click();
    await expect(page.locator("section[data-panel-key]")).toHaveCount(count);
    const openMs = performance.now() - start;
    const ids = await page.getByTestId("mount-count").allTextContents();
    const s = await state(page);
    const id = s.panels[s.selected!].ref.id;
    const r = await rect(page, id);
    const started = performance.now();
    await drag(page, frame(page, id).locator("header"), 30, 15, true);
    near(await rect(page, id), { ...r, x: r.x + 30, y: r.y + 15 });
    const dragMs = performance.now() - started;
    await button(page, "Zoom 0.5").click();
    await expect(page.getByTestId("camera-state")).toContainText("0.5");
    expect(await page.getByTestId("mount-count").allTextContents()).toEqual(
      ids
    );
    await info.attach("timing-sample", {
      body: JSON.stringify({
        count,
        openMs,
        dragMs,
        browser: browser.version(),
        node: process.version,
        platform: process.platform,
        viewport: page.viewportSize(),
        scope:
          "single local sample including Playwright overhead; not performance certification",
      }),
      contentType: "application/json",
    });
  });

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test("auto-tile lays panels out, respects manual moves, explicit arrange, pin and toggle-off", async ({
  page,
}) => {
  await setup(page);
  const task = frame(page);
  const taskKey = (await task.getAttribute("data-panel-key"))!;
  await button(page, "Toggle auto-tile").click();
  await button(page, "Open artifact").click();
  const artifactKey = (await frame(page, "artifact").getAttribute(
    "data-panel-key"
  ))!;
  // Two auto panels tile without overlapping.
  let s = await state(page);
  expect(
    overlap(s.panels[taskKey].rect, s.panels[artifactKey].rect)
  ).toBe(false);
  expect(s.panels[taskKey].placement).toBe("auto");
  // A human drag opts the task out; opening another panel leaves it put.
  await drag(page, task.locator("header"), -60, 120, true);
  const moved = await rect(page, "task");
  expect((await state(page)).panels[taskKey].placement).toBe("manual");
  await button(page, "Open iframe").click();
  near(await rect(page, "task"), moved);
  // Explicit Arrange re-tiles everything, incl. the moved task.
  await button(page, "Arrange").click();
  expect((await state(page)).panels[taskKey].placement).toBe("auto");
  s = await state(page);
  const tiled = Object.values(s.panels).map((p) => p.rect);
  for (let i = 0; i < tiled.length; i++)
    for (let j = i + 1; j < tiled.length; j++)
      expect(overlap(tiled[i], tiled[j])).toBe(false);
  // A pinned panel is never moved by Arrange.
  await task.getByRole("button", { name: "Pin panel", exact: true }).click();
  const pinned = await rect(page, "task");
  await button(page, "Arrange").click();
  near(await rect(page, "task"), pinned);
  // Toggling auto-tile off stops re-tiling on open.
  await button(page, "Toggle auto-tile").click();
  const artifactBefore = await rect(page, "artifact");
  await button(page, "Open missing").click();
  near(await rect(page, "artifact"), artifactBefore);
});

test("fit frames all panels within the canvas", async ({ page }) => {
  await setup(page);
  await button(page, "Toggle auto-tile").click();
  await button(page, "Open artifact").click();
  await button(page, "Open iframe").click();
  // Spread the content out so framing it needs a zoom-out.
  await drag(page, frame(page, "iframe").locator("header"), 320, 320, true);
  await button(page, "Fit").click();
  const canvas = await box(page.getByTestId("universe-canvas"));
  for (const kind of ["task", "artifact", "iframe"]) {
    const b = await box(frame(page, kind));
    expect(b.x).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(b.y).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }
});

test("auto-tile reflows the remaining panels when one closes", async ({
  page,
}) => {
  await setup(page);
  await button(page, "Toggle auto-tile").click();
  await button(page, "Open artifact").click();
  await button(page, "Open iframe").click();
  const before = await rect(page, "task");
  await frame(page, "artifact")
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(frame(page, "artifact")).toHaveCount(0);
  const after = await rect(page, "task");
  // The 3 -> 2 reflow changed the surviving task's geometry (no leftover hole).
  expect(
    after.x !== before.x ||
      after.y !== before.y ||
      after.width !== before.width
  ).toBe(true);
});

test("panels carry a geometry transition with motion and none under reduced motion", async ({
  browser,
}) => {
  for (const [mode, animated] of [
    ["no-preference", true],
    ["reduce", false],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      reducedMotion: mode,
    });
    try {
      const page = await context.newPage();
      await page.goto("/universe-harness.html");
      await button(page, "Toggle motion").click();
      await button(page, "Open task").click();
      await expect(frame(page).locator("header")).toBeVisible();
      const duration = await page
        .locator(".react-flow__node")
        .first()
        .evaluate((e) => getComputedStyle(e).transitionDuration);
      expect(duration.includes("0.2s")).toBe(animated);
    } finally {
      await context.close();
    }
  }
});

test("selection is optional: empty-canvas click and closing clear it", async ({
  page,
}) => {
  await setup(page);
  const task = frame(page);
  const taskKey = (await task.getAttribute("data-panel-key"))!;
  expect((await state(page)).selected).toBe(taskKey);
  // Clicking empty canvas deselects.
  const canvas = await box(page.getByTestId("universe-canvas"));
  await page.mouse.click(canvas.x + 12, canvas.y + canvas.height / 2);
  expect((await state(page)).selected).toBeNull();
  // Clicking the panel body re-selects; closing it leaves nothing selected.
  const b = await box(task);
  await page.mouse.click(b.x + 40, b.y + 80);
  expect((await state(page)).selected).toBe(taskKey);
  await task
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
  await expect(task).toHaveCount(0);
  expect((await state(page)).selected).toBeNull();
});

test("arrange routes free panels around a pinned one", async ({ page }) => {
  await setup(page);
  const task = frame(page);
  const taskKey = (await task.getAttribute("data-panel-key"))!;
  await task.getByRole("button", { name: "Pin panel", exact: true }).click();
  const pinnedRect = await rect(page, "task");
  await button(page, "Open artifact").click();
  await button(page, "Open iframe").click();
  await button(page, "Arrange").click();
  // The pinned task does not move and the free panels avoid its area.
  near(await rect(page, "task"), pinnedRect);
  const s = await state(page);
  for (const [key, panel] of Object.entries(s.panels))
    if (key !== taskKey)
      expect(overlap(panel.rect, s.panels[taskKey].rect)).toBe(false);
});

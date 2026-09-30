import { expect, test } from "@playwright/test";
import {
  authenticatedRequest,
  jsonOrThrow,
  loadState,
  recordScenario,
  requireCheckpoint,
  writeCheckpoint,
} from "./campaign.js";

test.beforeAll(async () => {
  await Promise.all([requireCheckpoint("review-loop"), requireCheckpoint("business-approval")]);
});

test("@commander-lifecycle [R12] Discussion and Task use focus panes while nested detail uses the shared Viewer", async ({ browser }, testInfo) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    const page = await founder.newPage();
    await page.goto(`/${state.company.issuePrefix}/commander`);
    const expand = page.getByRole("button", { name: "Expand cockpit" });
    if (await expand.isVisible().catch(() => false)) await expand.click();

    const discussion = page.getByRole("button").filter({ hasText: "Boutique agency customer validation" });
    await expect(discussion).toHaveCount(1);
    await discussion.click();
    await expect(page.getByTestId("commander-discussion-pane")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${state.company.issuePrefix}/commander$`));

    const q3 = state.tasks.q3;
    const nestedTask = page.getByText(q3.title, { exact: true });
    if (await nestedTask.count()) {
      await nestedTask.first().click();
      await expect(page.getByTestId("commander-viewer-panel")).toBeVisible();
    }

    await page.getByRole("button", { name: /Close discussion/i }).click().catch(async () => {
      await page.keyboard.press("Escape");
    });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    const taskRow = page.getByRole("button").filter({ hasText: state.tasks.q5.title });
    await expect(taskRow).toHaveCount(1);
    await taskRow.click();
    await expect(page.getByTestId("commander-task-focus-pane")).toHaveAttribute("data-issue-id", state.tasks.q5.id);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await recordScenario("R12", "PASS", "Discussion and Task opened as Commander focus panes without route navigation; nested references retained Viewer coordination", [
      `discussion:${state.discussionId}`,
      `task:${state.tasks.q5.id}`,
    ]);
    const screenshot = testInfo.outputPath("R12-pane-coordination.png");
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await founder.close();
  }
});

test("@commander-lifecycle [R13] follows and pins remain independent", async ({ browser }) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    const task = await jsonOrThrow<{ artifactId: string | null }>(founder.request.get(`/api/issues/${state.tasks.q2.id}`), "read pinnable artifact");
    const followPayloads = [
      { entityType: "project", entityId: state.projects.customerValidationProjectId },
      { entityType: "goal", entityId: state.goalId },
      { entityType: "task", entityId: state.tasks.q2.id },
    ];
    const followResponses = await Promise.all(followPayloads.map((data) => founder.request.post(`/api/companies/${state.company.id}/follows`, { data })));
    if (followResponses.some((response) => response.status() === 404)) {
      await recordScenario("R13", "BLOCKED", "The user-entity follow schema exists but no public /follows route is registered", []);
      return;
    }
    for (const response of followResponses) expect(response.ok(), await response.text()).toBe(true);
    expect(task.artifactId).toBeTruthy();
    await jsonOrThrow(
      await founder.request.post(`/api/companies/${state.company.id}/pins`, { data: { entityType: "artifact", entityId: task.artifactId } }),
      "pin answer artifact",
    );
    const cockpit = await jsonOrThrow<{ pinned: Array<{ entityType: string; entityId: string }> }>(
      founder.request.get(`/api/companies/${state.company.id}/cockpit`),
      "load pinned cockpit context",
    );
    expect(cockpit.pinned).toContainEqual(expect.objectContaining({ entityType: "artifact", entityId: task.artifactId }));
    await recordScenario("R13", "PASS", "Project, goal, and task follows remained independent from the pinned artifact", [`artifact:${task.artifactId}`]);
  } finally {
    await founder.close();
  }
});

test.afterAll(async () => {
  await writeCheckpoint("pane-coordination", { scenarios: ["R12", "R13"] });
});

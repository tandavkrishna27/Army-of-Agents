import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  authenticatedRequest,
  campaignRoot,
  jsonOrThrow,
  loadState,
  poll,
  recordScenario,
  requireCheckpoint,
  updateState,
  writeCheckpoint,
  type CampaignState,
} from "./campaign.js";

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  artifactId: string | null;
}

async function bucket(request: APIRequestContext, state: CampaignState, name: "mine" | "managed" | "awaiting_review") {
  return jsonOrThrow<{ items: Array<{ id: string }>; total: number }>(
    await request.get(`/api/companies/${state.company.id}/cockpit/tasks?bucket=${name}&limit=100`),
    `load ${name} task bucket`,
  );
}

async function createHumanTask(request: APIRequestContext, state: CampaignState) {
  return jsonOrThrow<IssueRow>(
    await request.post(`/api/companies/${state.company.id}/issues`, {
      data: {
        projectId: state.projects.customerValidationProjectId,
        goalId: state.goalId,
        title: "Prepare founder interview briefing",
        description: "Prepare the opening script and participant checklist for the first founder interview.",
        status: "todo",
        priority: "high",
        assigneeUserId: state.actors.member.userId,
        responsibleUserId: state.actors.lead.userId,
        acceptanceCriteria: ["Opening script is ready", "Participant checklist is ready"],
      },
    }),
    "create member interview task",
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await Promise.all([requireCheckpoint("claude-questions"), requireCheckpoint("codex-questions")]);
});

test("@commander-lifecycle [R01] human work is personal for the member and managed for the lead", async ({ browser }) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  const lead = await authenticatedRequest(browser, state, "lead");
  const member = await authenticatedRequest(browser, state, "member");
  try {
    const issue = await createHumanTask(founder.request, state);
    const [memberMine, leadManaged, founderMine] = await Promise.all([
      bucket(member.request, state, "mine"),
      bucket(lead.request, state, "managed"),
      bucket(founder.request, state, "mine"),
    ]);
    expect(memberMine.items.map((item) => item.id)).toContain(issue.id);
    expect(leadManaged.items.map((item) => item.id)).toContain(issue.id);
    expect(founderMine.items.map((item) => item.id)).not.toContain(issue.id);

    const page = await member.newPage();
    await page.goto(`/${state.company.issuePrefix}/issues/${issue.id}`);
    await expect(page.getByText(issue.title, { exact: true })).toBeVisible();
    const statusTrigger = page.locator("span.cursor-pointer").first();
    await statusTrigger.click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await poll(
      () => jsonOrThrow<IssueRow>(member.request.get(`/api/issues/${issue.id}`), "read completed human task"),
      (row) => row.status === "done",
      "member task completion",
      30_000,
    );
    await updateState((latest) => {
      latest.tasks.r01 = { id: issue.id, identifier: issue.identifier, title: issue.title, agent: "human" };
    });
    await recordScenario("R01", "PASS", "Member completed personal task; lead managed it; founder personal work excluded it", [`task:${issue.id}`]);
  } finally {
    await Promise.all([founder.close(), lead.close(), member.close()]);
  }
});

test("@commander-lifecycle [R07-R09] review, request changes, resubmission, and approval stay one task lifecycle", async ({ browser }, testInfo) => {
  let state = await loadState();
  const task = state.tasks.q3;
  expect(task?.id).toBeTruthy();
  const lead = await authenticatedRequest(browser, state, "lead");
  try {
    const initialRuns = await jsonOrThrow<Array<{ id: string }>>(lead.request.get(`/api/issues/${task.id}/runs`), "list pre-review runs");
    const reviewBucket = await bucket(lead.request, state, "awaiting_review");
    expect(reviewBucket.items.map((item) => item.id)).toContain(task.id);

    const page = await lead.newPage();
    await page.goto(`/${state.company.issuePrefix}/commander`);
    const expand = page.getByRole("button", { name: "Expand cockpit" });
    if (await expand.isVisible().catch(() => false)) await expand.click();
    const row = page.getByRole("button").filter({ hasText: task.title });
    await expect(row).toHaveCount(1);
    await row.click();
    await expect(page.getByTestId("commander-task-focus-pane")).toHaveAttribute("data-issue-id", task.id);
    await expect(page).toHaveURL(new RegExp(`/${state.company.issuePrefix}/commander$`));
    await recordScenario("R07", "PASS", "Review-required task remained in Managing/Awaiting Review and opened Commander Task Workspace", [`task:${task.id}`]);

    await page.getByRole("button", { name: "Request Changes" }).click();
    const feedback = "Add a comparison table covering recruiting effort, evidence depth, and decision confidence.";
    await page.getByLabel("Review feedback").fill(feedback);
    await page.getByRole("button", { name: /Send feedback & resume/i }).click();
    await poll(
      () => jsonOrThrow<IssueRow>(lead.request.get(`/api/issues/${task.id}`), "read requested-changes task"),
      (value) => value.status === "in_progress",
      "request changes transition",
      30_000,
    );
    const comments = await jsonOrThrow<Array<{ body: string }>>(lead.request.get(`/api/issues/${task.id}/comments`), "load review feedback");
    expect(comments.some((comment) => comment.body.includes("comparison table"))).toBe(true);

    const resubmitted = await poll(
      () => jsonOrThrow<IssueRow>(lead.request.get(`/api/issues/${task.id}`), "read resubmitted task"),
      (value) => value.status === "in_review",
      "agent review resubmission",
      10 * 60_000,
      2_000,
    );
    const runsAfter = await jsonOrThrow<Array<{ id: string }>>(lead.request.get(`/api/issues/${task.id}/runs`), "list post-feedback runs");
    expect(runsAfter.length).toBe(initialRuns.length + 1);
    const output = await readFile(resolve(campaignRoot(), "workspace", task.outputFile!), "utf8");
    expect(output.toLowerCase()).toContain("comparison");
    await recordScenario("R08", "PASS", "Required feedback returned one task to progress and produced exactly one continuation", [`task:${task.id}`]);

    await page.reload();
    const expandAfterReload = page.getByRole("button", { name: "Expand cockpit" });
    if (await expandAfterReload.isVisible().catch(() => false)) await expandAfterReload.click();
    await page.getByRole("button").filter({ hasText: task.title }).click();
    await expect(page.getByTestId("commander-task-focus-pane")).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await poll(
      () => jsonOrThrow<IssueRow>(lead.request.get(`/api/issues/${task.id}`), "read approved task"),
      (value) => value.status === "done",
      "human review approval",
      30_000,
    );
    expect(resubmitted.artifactId).toBeTruthy();
    await recordScenario("R09", "PASS", "Agent resubmitted the same task and the lead approved it to done", [`task:${task.id}`, `artifact:${resubmitted.artifactId}`]);
    const screenshot = testInfo.outputPath("R09-approved-task.png");
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await lead.close();
  }
});

test("@commander-lifecycle [R11] agent-can-complete policy permits a bounded accepted task to reach done", async ({ browser }) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    const issue = await jsonOrThrow<IssueRow>(
      await founder.request.post(`/api/companies/${state.company.id}/issues`, {
        data: {
          projectId: state.projects.customerValidationProjectId,
          goalId: state.goalId,
          title: "Publish bounded interview checklist",
          description: [
            "Create r11-interview-checklist.md with exactly five numbered interview preparation checks.",
            "Attach it with mcp__aoa__attach_task_artifact, post a task comment, then call mcp__aoa__set_task_status with status done.",
          ].join("\n"),
          status: "backlog",
          priority: "normal",
          assigneeAgentId: state.agents.claude.id,
          responsibleUserId: state.actors.lead.userId,
          acceptanceCriteria: ["Exactly five numbered checks", "Deliverable attached"],
          agentCompletionPolicyOverride: "agent_can_complete",
          assigneeAdapterOverrides: { useProjectWorkspace: true },
        },
      }),
      "create agent-can-complete task",
    );
    await jsonOrThrow(
      await founder.request.post(`/api/agents/${state.agents.claude.id}/wakeup?companyId=${state.company.id}`, {
        data: { source: "on_demand", reason: "R11", payload: { issueId: issue.id } },
      }),
      "wake Claude for R11",
    );
    const done = await poll(
      () => jsonOrThrow<IssueRow>(founder.request.get(`/api/issues/${issue.id}`), "read R11 task"),
      (value) => value.status === "done",
      "agent completion",
      10 * 60_000,
      2_000,
    );
    const output = await readFile(resolve(campaignRoot(), "workspace", "r11-interview-checklist.md"), "utf8");
    expect((output.match(/^\d+\./gm) ?? []).length).toBe(5);
    expect(done.artifactId).toBeTruthy();
    await updateState((latest) => {
      latest.tasks.r11 = { id: issue.id, identifier: issue.identifier, title: issue.title, agent: "claude", outputFile: "r11-interview-checklist.md" };
    });
    await recordScenario("R11", "PASS", "Agent completed a bounded task under explicit agent-can-complete authority", [`task:${issue.id}`, `artifact:${done.artifactId}`]);
  } finally {
    await founder.close();
  }
});

test.afterAll(async () => {
  await writeCheckpoint("review-loop", { scenarios: ["R01", "R07", "R08", "R09", "R11"] });
});

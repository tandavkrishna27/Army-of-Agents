import { expect, test } from "@playwright/test";
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
} from "./campaign.js";

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  artifactId: string | null;
}

interface HubRow {
  id: string;
  title: string;
  sourceType: string;
  sourceId: string;
  relatedEntityId: string | null;
}

test.beforeAll(async () => {
  await Promise.all([requireCheckpoint("claude-questions"), requireCheckpoint("codex-questions")]);
});

test("@commander-lifecycle [R06] supervised Claude permission is distinct from task review", async ({ browser }, testInfo) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    await jsonOrThrow(
      await founder.request.patch(`/api/agents/${state.agents.claude.id}`, {
        data: {
          adapterConfig: {
            model: "claude-sonnet-4-5-20250929",
            dangerouslySkipPermissions: false,
          },
        },
      }),
      "enable supervised Claude permissions",
    );
    const issue = await jsonOrThrow<IssueRow>(
      await founder.request.post(`/api/companies/${state.company.id}/issues`, {
        data: {
          projectId: state.projects.customerValidationProjectId,
          goalId: state.goalId,
          title: "Write supervised segment recommendation",
          description: [
            "Create r06-supervised-recommendation.md in the current workspace with a recommendation for boutique agencies.",
            "Include three evidence bullets and one explicit risk.",
            "Attach the file with mcp__aoa__attach_task_artifact, post a task comment, then submit the task to in_review with mcp__aoa__set_task_status.",
          ].join("\n"),
          status: "backlog",
          priority: "high",
          assigneeAgentId: state.agents.claude.id,
          responsibleUserId: state.actors.lead.userId,
          reviewerUserId: state.actors.lead.userId,
          acceptanceCriteria: ["Three evidence bullets", "One risk", "Attached deliverable"],
          assigneeAdapterOverrides: { useProjectWorkspace: true },
        },
      }),
      "create supervised recommendation task",
    );
    await jsonOrThrow(
      await founder.request.post(`/api/agents/${state.agents.claude.id}/wakeup?companyId=${state.company.id}`, {
        data: { source: "on_demand", reason: "R06", payload: { issueId: issue.id } },
      }),
      "wake supervised Claude",
    );

    const hub = await poll(
      async () => jsonOrThrow<{ items: HubRow[] }>(
        founder.request.get(`/api/companies/${state.company.id}/hub-items?lane=waiting_on_you&limit=50`),
        "list permission hub items",
      ),
      (value) => value.items.some((item) => item.sourceType === "agent_runtime_decision" && item.relatedEntityId === issue.id),
      "real supervised runtime permission",
      5 * 60_000,
      1_000,
    );
    const item = hub.items.find((candidate) => candidate.sourceType === "agent_runtime_decision" && candidate.relatedEntityId === issue.id)!;
    const page = await founder.newPage();
    await page.goto(`/${state.company.issuePrefix}/inbox/waiting`);
    const row = page.locator("button[data-hub-row-id]").filter({ hasText: item.title });
    await expect(row).toHaveCount(1);
    await row.click();
    const allowRun = page.getByRole("button", { name: /Allow equivalent actions for this run/i });
    if (await allowRun.isVisible().catch(() => false)) await allowRun.click();
    else await page.getByRole("button", { name: /^Allow once$/i }).click();

    const completed = await poll(
      () => jsonOrThrow<IssueRow>(founder.request.get(`/api/issues/${issue.id}`), "read supervised task"),
      (value) => value.status === "in_review",
      "supervised task output and review submission",
      10 * 60_000,
      2_000,
    );
    const outputPath = resolve(campaignRoot(), "workspace", "r06-supervised-recommendation.md");
    const output = await readFile(outputPath, "utf8");
    expect(output.toLowerCase()).toContain("risk");
    expect(completed.artifactId).toBeTruthy();
    const detail = await jsonOrThrow<{ status: string; kind: string; decision: string | null }>(
      founder.request.get(`/api/companies/${state.company.id}/agent-runtime-decisions/${item.sourceId}`),
      "read answered permission",
    );
    expect(detail.kind).toBe("permission");
    expect(["answered", "relayed"]).toContain(detail.status);
    expect(detail.decision).not.toBe("deny");
    await updateState((latest) => {
      latest.tasks.r06 = { id: issue.id, identifier: issue.identifier, title: issue.title, agent: "claude", outputFile: "r06-supervised-recommendation.md" };
    });
    await recordScenario("R06", "PASS", "A real runtime permission was answered independently before Claude submitted task review", [
      `task:${issue.id}`,
      `runtime-decision:${item.sourceId}`,
      `artifact:${completed.artifactId}`,
    ]);
    const screenshot = testInfo.outputPath("R06-runtime-permission.png");
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await founder.request.patch(`/api/agents/${state.agents.claude.id}`, {
      data: { adapterConfig: { model: "claude-sonnet-4-5-20250929", dangerouslySkipPermissions: true } },
    }).catch(() => undefined);
    await founder.close();
  }
});

test.afterAll(async () => {
  await writeCheckpoint("business-approval", { scenarios: ["R06"] });
});

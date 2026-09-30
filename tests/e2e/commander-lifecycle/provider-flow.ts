import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type APIRequestContext, type Browser, type Page, type TestInfo } from "@playwright/test";
import {
  authenticatedRequest,
  campaignRoot,
  jsonOrThrow,
  listQuestions,
  poll,
  updateState,
  type CampaignState,
  type CampaignTask,
} from "./campaign.js";

interface QuestionRow {
  id: string;
  issueId: string;
  title: string;
  question: string;
  status: string;
  version: number;
  executionWorkspaceId: string | null;
  continuationStatus: string;
  answer?: { text?: string; selectedValues?: string[] } | null;
}

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  status: string;
  executionWorkspaceId?: string | null;
}

export interface RealQuestionCase {
  key: "q1" | "q2" | "q3" | "q4" | "q5";
  scenarioId: "Q1" | "Q2" | "Q3" | "Q4" | "Q5";
  agent: "claude" | "codex";
  title: string;
  question: string;
  options: [{ label: string; value: string }, { label: string; value: string }];
  selectedLabel: string;
  selectedValue: string;
  outputFile: string;
  surface: "commander" | "workspace" | "discussion" | "inbox" | "task_work";
  actor: "founder" | "lead";
  sourceDiscussion: boolean;
}

function taskDescription(input: RealQuestionCase): string {
  return [
    "This is a formal Commander lifecycle qualification task.",
    `Before doing any substantive work, call mcp__aoa__ask_human exactly once with this question: ${input.question}`,
    `Supply exactly these options: ${input.options[0].label} (value ${input.options[0].value}) and ${input.options[1].label} (value ${input.options[1].value}).`,
    "Wait for the durable human answer. Do not use provider-local request_user_input.",
    `After the answer arrives, create ${input.outputFile} in the current workspace.`,
    "The file must contain the chosen option label and value, the task identifier, and one sentence explaining how the answer changes the recommendation.",
    "Read the completed file and call mcp__aoa__attach_task_artifact exactly once with the file contents, a descriptive title, and type document.",
    "Post a task comment naming the file and chosen option.",
    "If review feedback arrives later, update the same file and attach a new corrected deliverable before resubmitting.",
    "Finally call mcp__aoa__set_task_status with status in_review. Do not mark the task done.",
  ].join("\n");
}

export async function createAndWakeQuestionTask(
  request: APIRequestContext,
  state: CampaignState,
  input: RealQuestionCase,
): Promise<CampaignTask> {
  const responsibleUserId = state.actors[input.actor].userId;
  const agentId = state.agents[input.agent].id;
  const existing = await jsonOrThrow<IssueRow[]>(
    await request.get(`/api/companies/${state.company.id}/issues?q=${encodeURIComponent(input.title)}&taskScope=all`),
    `find existing ${input.scenarioId} task`,
  );
  const issue = existing.find((candidate) => candidate.title === input.title) ?? await jsonOrThrow<IssueRow>(
    await request.post(`/api/companies/${state.company.id}/issues`, {
      data: {
        projectId: state.projects.customerValidationProjectId,
        goalId: state.goalId,
        sourceDiscussionId: input.sourceDiscussion ? state.discussionId : null,
        title: input.title,
        description: taskDescription(input),
        status: "backlog",
        priority: "high",
        workMode: "standard",
        assigneeAgentId: agentId,
        responsibleUserId,
        reviewerUserId: state.actors.lead.userId,
        acceptanceCriteria: [
          `${input.outputFile} contains the selected option`,
          "A task comment cites the human answer",
          "The task is submitted to review",
        ],
        assigneeAdapterOverrides: { useProjectWorkspace: true },
      },
    }),
    `create ${input.scenarioId} task`,
  );
  const task: CampaignTask = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    agent: input.agent,
    answerSurface: input.surface,
    expectedAnswer: input.selectedValue,
    outputFile: input.outputFile,
  };
  await updateState((latest) => {
    latest.tasks[input.key] = task;
  });
  await jsonOrThrow(
    await request.post(`/api/agents/${agentId}/wakeup?companyId=${state.company.id}`, {
      data: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: input.scenarioId,
        payload: { issueId: issue.id },
      },
    }),
    `wake ${input.agent} for ${input.scenarioId}`,
  );
  return task;
}

export async function waitForOpenQuestion(
  request: APIRequestContext,
  state: CampaignState,
  input: RealQuestionCase,
  task: CampaignTask,
): Promise<QuestionRow> {
  const question = await poll(
    async () => listQuestions(request, state.company.id, task.id) as Promise<QuestionRow[]>,
    (rows) => rows.some((row) => row.status === "open"),
    `${input.scenarioId} durable question`,
    10 * 60_000,
    2_000,
  ).then((rows) => rows.find((row) => row.status === "open")!);
  expect(question.question).toContain(input.question);
  expect(question.executionWorkspaceId).toBeTruthy();
  await updateState((latest) => {
    latest.tasks[input.key] = {
      ...latest.tasks[input.key],
      questionId: question.id,
      workspaceId: question.executionWorkspaceId ?? undefined,
    };
  });
  return question;
}

async function openQuestionSurface(
  page: Page,
  state: CampaignState,
  input: RealQuestionCase,
  task: CampaignTask,
  question: QuestionRow,
) {
  const prefix = state.company.issuePrefix;
  if (input.surface === "commander") {
    await page.goto(`/${prefix}/commander`);
  } else if (input.surface === "workspace") {
    await page.goto(`/${prefix}/workspaces/${question.executionWorkspaceId}`);
  } else if (input.surface === "discussion") {
    await page.goto(`/${prefix}/discussions/${state.discussionId}`);
  } else if (input.surface === "inbox") {
    await page.goto(`/${prefix}/inbox`);
  } else {
    await page.goto(`/${prefix}/issues/${task.id}`);
  }

  let panel = page.getByTestId("work-question-panel").filter({ hasText: input.question });
  if (await panel.count() === 0) {
    const titleTarget = page.getByText(question.title, { exact: true });
    const titleCount = await titleTarget.count();
    if (titleCount !== 1) {
      throw new Error(`${input.scenarioId} expected one visible question entry on ${input.surface}; found ${titleCount}`);
    }
    await titleTarget.click();
    panel = page.getByTestId("work-question-panel").filter({ hasText: input.question });
  }
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeVisible();
  return panel;
}

export async function answerQuestionFromSurface(
  browser: Browser,
  state: CampaignState,
  input: RealQuestionCase,
  task: CampaignTask,
  question: QuestionRow,
  testInfo: TestInfo,
) {
  const context = await authenticatedRequest(browser, state, input.actor);
  const page = await context.newPage();
  try {
    const panel = await openQuestionSurface(page, state, input, task, question);
    const option = panel.getByText(input.selectedLabel, { exact: true });
    expect(await option.count()).toBe(1);
    await option.click();
    const send = panel.getByRole("button", { name: "Send answer" });
    expect(await send.count()).toBe(1);
    await send.click();
    await expect(panel.getByText("Answered", { exact: true })).toBeVisible({ timeout: 30_000 });
    const screenshotPath = testInfo.outputPath(`${input.scenarioId}-${input.surface}-answered.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(`${input.scenarioId}-${input.surface}-answered`, { path: screenshotPath, contentType: "image/png" });
  } finally {
    await context.close();
  }
}

export async function waitForAnswerSpecificCompletion(
  request: APIRequestContext,
  state: CampaignState,
  input: RealQuestionCase,
  task: CampaignTask,
  questionId: string,
) {
  const question = await poll(
    async () => jsonOrThrow<{ question: QuestionRow }>(
      await request.get(`/api/companies/${state.company.id}/work-questions/${questionId}`),
      `read ${input.scenarioId} question detail`,
    ),
    (detail) => ["completed", "succeeded", "not_required"].includes(detail.question.continuationStatus),
    `${input.scenarioId} continuation success`,
    10 * 60_000,
    2_000,
  );
  expect(question.question.status).toBe("answered");
  expect(question.question.answer?.selectedValues).toContain(input.selectedValue);

  const issue = await poll(
    async () => jsonOrThrow<IssueRow>(await request.get(`/api/issues/${task.id}`), `read ${input.scenarioId} task`),
    (row) => row.status === "in_review",
    `${input.scenarioId} task review submission`,
    10 * 60_000,
    2_000,
  );
  const outputPath = resolve(campaignRoot(), "workspace", input.outputFile);
  const output = await poll(
    () => readFile(outputPath, "utf8").catch(() => ""),
    (text) => text.includes(input.selectedLabel) && text.includes(input.selectedValue),
    `${input.scenarioId} answer-specific artifact`,
    60_000,
    1_000,
  );
  const runs = await jsonOrThrow<Array<{ id: string; status: string }>>(
    await request.get(`/api/issues/${task.id}/runs`),
    `list ${input.scenarioId} runs`,
  );
  await updateState((latest) => {
    latest.tasks[input.key] = {
      ...latest.tasks[input.key],
      questionId,
      workspaceId: task.workspaceId,
      runId: runs[0]?.id,
    };
  });
  return { issue, question: question.question, output, outputPath, runs };
}

export async function runRealQuestionCase(
  browser: Browser,
  request: APIRequestContext,
  state: CampaignState,
  input: RealQuestionCase,
  testInfo: TestInfo,
) {
  const resumedTask = state.tasks[input.key];
  if (resumedTask?.questionId) {
    const detail = await jsonOrThrow<{ question: QuestionRow }>(
      await request.get(`/api/companies/${state.company.id}/work-questions/${resumedTask.questionId}`),
      `resume ${input.scenarioId} question detail`,
    );
    if (
      detail.question.status === "answered"
      && ["completed", "succeeded", "not_required"].includes(detail.question.continuationStatus)
    ) {
      return waitForAnswerSpecificCompletion(
        request,
        state,
        input,
        resumedTask,
        resumedTask.questionId,
      );
    }
  }

  const task = await createAndWakeQuestionTask(request, state, input);
  const question = await waitForOpenQuestion(request, state, input, task);
  task.questionId = question.id;
  task.workspaceId = question.executionWorkspaceId ?? undefined;
  await answerQuestionFromSurface(browser, state, input, task, question, testInfo);
  return waitForAnswerSpecificCompletion(request, state, input, task, question.id);
}

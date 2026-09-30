import { expect, test, type Page } from "@playwright/test";
import {
  authenticatedRequest,
  jsonOrThrow,
  listQuestions,
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

async function sendMessage(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.fill(text);
  await input.press("Enter");
}

async function approveCommanderActions(page: Page, done: () => Promise<boolean>, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await done()) return;
    const allow = page.getByRole("button", { name: /^Allow once$/i });
    const count = await allow.count();
    if (count > 0) {
      const candidate = allow.last();
      if (await candidate.isEnabled().catch(() => false)) await candidate.click();
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("Timed out waiting for Commander actions to produce their causal result");
}

test.beforeAll(async () => {
  await requireCheckpoint("pane-coordination");
});

test("@commander-lifecycle [R05] Commander launches a delegated Claude task whose question mirrors back", async ({ browser }, testInfo) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    await jsonOrThrow(
      await founder.request.patch(`/api/companies/${state.company.id}/internal-agent/config`, {
        data: { cliTool: "claude_cli", model: "claude-sonnet-4-5-20250929" },
      }),
      "configure real Claude Commander",
    );
    const page = await founder.newPage();
    await page.goto(`/${state.company.issuePrefix}/commander`);
    const title = "Commander delegated positioning choice";
    await sendMessage(page, [
      `Create one task titled \"${title}\" in the Customer Validation project.`,
      `Assign it to Claude Product Analyst (${state.agents.claude.id}), make Product Lead (${state.actors.lead.userId}) the responsible human and reviewer, and set acceptance criteria requiring an attached positioning brief.`,
      "Its description must tell the agent to call ask_human before work with exactly two options: Speed-first (speed-first) and Evidence-first (evidence-first).",
      "After the answer, it must create r05-commander-positioning.md, attach it, and submit in_review. Wake the agent after creating the task.",
      "Use your AoA tools now and ask for confirmations where required.",
    ].join("\n"));

    let delegated: IssueRow | undefined;
    await approveCommanderActions(page, async () => {
      const rows = await jsonOrThrow<IssueRow[]>(
        founder.request.get(`/api/companies/${state.company.id}/issues?q=${encodeURIComponent(title)}&taskScope=all`),
        "find Commander-delegated task",
      );
      delegated = rows.find((row) => row.title === title);
      if (!delegated) return false;
      const questions = await listQuestions(founder.request, state.company.id, delegated.id) as Array<{ id: string; status: string; question: string }>;
      return questions.some((question) => question.status === "open");
    }, 12 * 60_000);
    expect(delegated).toBeTruthy();
    const questions = await listQuestions(founder.request, state.company.id, delegated!.id) as Array<{ id: string; status: string; question: string }>;
    const question = questions.find((candidate) => candidate.status === "open")!;
    expect(question.question).toContain("position");
    const panel = page.getByTestId("work-question-panel").filter({ hasText: question.question });
    await expect(panel).toBeVisible();
    await panel.getByText("Evidence-first", { exact: true }).click();
    await panel.getByRole("button", { name: "Send answer" }).click();
    await expect(panel.getByText("Answered", { exact: true })).toBeVisible();
    const completed = await poll(
      () => jsonOrThrow<IssueRow>(founder.request.get(`/api/issues/${delegated!.id}`), "read Commander-delegated task"),
      (value) => value.status === "in_review" && Boolean(value.artifactId),
      "Commander-delegated answer-specific review output",
      10 * 60_000,
      2_000,
    );
    await updateState((latest) => {
      latest.tasks.r05 = {
        id: completed.id,
        identifier: completed.identifier,
        title: completed.title,
        agent: "claude",
        expectedAnswer: "evidence-first",
        outputFile: "r05-commander-positioning.md",
        questionId: question.id,
      };
    });
    await recordScenario("R05", "PASS", "Commander created and woke a Claude task; its durable question returned to the originating Commander conversation", [
      `task:${completed.id}`,
      `question:${question.id}`,
      `artifact:${completed.artifactId}`,
    ]);
    const screenshot = testInfo.outputPath("R05-commander-delegated-question.png");
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await founder.close();
  }
});

test("@commander-lifecycle [R14] Commander synthesizes the live lifecycle using grounded facts", async ({ browser }, testInfo) => {
  const state = await loadState();
  const founder = await authenticatedRequest(browser, state, "founder");
  try {
    const page = await founder.newPage();
    await page.goto(`/${state.company.issuePrefix}/commander`);
    await sendMessage(page, [
      "Explain the current customer-validation work as an executive handoff.",
      "Use live AoA tools. Identify the source Discussion, the reviewed interview-sample task, its selected human answer, the supervised permission task and decision, its attached output, and the final review status.",
      "Include navigable entity references and do not infer facts you cannot verify.",
    ].join(" "));
    await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, { timeout: 12 * 60_000 });
    const transcript = await page.locator("main").innerText().catch(() => page.locator("body").innerText());
    const requiredFacts = [
      "Boutique agency customer validation",
      state.tasks.q3.identifier,
      "Five deep interviews",
      state.tasks.r06.identifier,
    ];
    for (const fact of requiredFacts) expect(transcript.toLowerCase()).toContain(fact.toLowerCase());
    const refs = page.getByTestId("commander-input-ref-chip").or(page.locator('[data-entity-ref]'));
    expect(await refs.count()).toBeGreaterThan(0);
    await recordScenario("R14", "PASS", "Commander grounded its handoff in the live Discussion, tasks, selected answer, permission work, output, and review state", requiredFacts);
    const screenshot = testInfo.outputPath("R14-grounded-synthesis.png");
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await founder.close();
  }
});

test.afterAll(async () => {
  await writeCheckpoint("lifecycle-synthesis", { scenarios: ["R05", "R14"] });
});

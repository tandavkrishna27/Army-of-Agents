import { test } from "@playwright/test";
import { authenticatedRequest, loadState, recordScenario, requireCheckpoint, writeCheckpoint } from "./campaign.js";
import { runRealQuestionCase, type RealQuestionCase } from "./provider-flow.js";

const CASES: RealQuestionCase[] = [
  {
    key: "q1",
    scenarioId: "Q1",
    agent: "claude",
    title: "Select founder interview ownership",
    question: "Who should own the first founder interview sequence?",
    options: [
      { label: "Founder-led interviews", value: "founder-led" },
      { label: "Analyst-led interviews", value: "analyst-led" },
    ],
    selectedLabel: "Founder-led interviews",
    selectedValue: "founder-led",
    outputFile: "q1-interview-ownership.md",
    surface: "commander",
    actor: "founder",
    sourceDiscussion: false,
  },
  {
    key: "q3",
    scenarioId: "Q3",
    agent: "claude",
    title: "Set boutique-agency interview sample",
    question: "Which boutique-agency interview sample should the validation plan use?",
    options: [
      { label: "Five deep interviews", value: "five-deep" },
      { label: "Twelve short interviews", value: "twelve-short" },
    ],
    selectedLabel: "Five deep interviews",
    selectedValue: "five-deep",
    outputFile: "q3-interview-sample.md",
    surface: "discussion",
    actor: "lead",
    sourceDiscussion: true,
  },
  {
    key: "q5",
    scenarioId: "Q5",
    agent: "claude",
    title: "Set interview incentive cap",
    question: "What incentive cap should the participant plan enforce?",
    options: [
      { label: "$100 cap", value: "100-usd" },
      { label: "$250 cap", value: "250-usd" },
    ],
    selectedLabel: "$100 cap",
    selectedValue: "100-usd",
    outputFile: "q5-incentive-cap.md",
    surface: "task_work",
    actor: "lead",
    sourceDiscussion: false,
  },
];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await requireCheckpoint("provider-preflight");
});

for (const input of CASES) {
  test(`@commander-lifecycle [${input.scenarioId}] real Claude answer from ${input.surface}`, async ({ browser }, testInfo) => {
    const state = await loadState();
    if (state.scenarios[input.scenarioId]?.status === "PASS") return;
    const founderContext = await authenticatedRequest(browser, state, "founder");
    try {
      const result = await runRealQuestionCase(browser, founderContext.request, state, input, testInfo);
      await recordScenario(input.scenarioId, "PASS", `${input.selectedLabel} produced ${input.outputFile}`, [
        `task:${state.tasks[input.key]?.id ?? input.key}`,
        `artifact:${result.outputPath}`,
      ]);
      if (input.scenarioId === "Q3") {
        await recordScenario("R02", "PASS", "Claude Discussion-sourced task created a real Workspace", [`discussion:${state.discussionId}`]);
        await recordScenario("R03", "PASS", "Claude created one durable mirrored Ask Human question", [`question:${result.question.id}`]);
      }
    } finally {
      await founderContext.close();
    }
  });
}

test.afterAll(async () => {
  await writeCheckpoint("claude-questions", { scenarios: CASES.map((item) => item.scenarioId) });
});

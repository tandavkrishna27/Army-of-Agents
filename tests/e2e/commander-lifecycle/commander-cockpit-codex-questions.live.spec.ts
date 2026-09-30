import { test } from "@playwright/test";
import { authenticatedRequest, loadState, recordScenario, requireCheckpoint, writeCheckpoint } from "./campaign.js";
import { runRealQuestionCase, type RealQuestionCase } from "./provider-flow.js";

const CASES: RealQuestionCase[] = [
  {
    key: "q2",
    scenarioId: "Q2",
    agent: "codex",
    title: "Choose validation landing-page format",
    question: "Which landing-page evidence format should be implemented?",
    options: [
      { label: "Interactive prototype", value: "interactive-prototype" },
      { label: "Static evidence page", value: "static-evidence" },
    ],
    selectedLabel: "Static evidence page",
    selectedValue: "static-evidence",
    outputFile: "q2-landing-page-format.md",
    surface: "workspace",
    actor: "lead",
    sourceDiscussion: false,
  },
  {
    key: "q4",
    scenarioId: "Q4",
    agent: "codex",
    title: "Choose launch instrumentation depth",
    question: "Which launch instrumentation depth should be implemented?",
    options: [
      { label: "Minimal event set", value: "minimal-events" },
      { label: "Full funnel", value: "full-funnel" },
    ],
    selectedLabel: "Minimal event set",
    selectedValue: "minimal-events",
    outputFile: "q4-instrumentation-depth.md",
    surface: "inbox",
    actor: "founder",
    sourceDiscussion: false,
  },
];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await requireCheckpoint("provider-preflight");
});

for (const input of CASES) {
  test(`@commander-lifecycle [${input.scenarioId}] real Codex answer from ${input.surface}`, async ({ browser }, testInfo) => {
    const state = await loadState();
    if (state.scenarios[input.scenarioId]?.status === "PASS") return;
    const founderContext = await authenticatedRequest(browser, state, "founder");
    try {
      const result = await runRealQuestionCase(browser, founderContext.request, state, input, testInfo);
      await recordScenario(input.scenarioId, "PASS", `${input.selectedLabel} produced ${input.outputFile}`, [
        `question:${result.question.id}`,
        `artifact:${result.outputPath}`,
      ]);
      if (input.scenarioId === "Q2") {
        await recordScenario("R04", "PASS", "Workspace answer produced one successful answer-specific continuation", [
          `question:${result.question.id}`,
        ]);
        await recordScenario("R10", "PASS", "Codex completed a bounded real Workspace output and submitted it for review", [
          `artifact:${result.outputPath}`,
        ]);
      }
    } finally {
      await founderContext.close();
    }
  });
}

test.afterAll(async () => {
  await writeCheckpoint("codex-questions", { scenarios: CASES.map((item) => item.scenarioId) });
});

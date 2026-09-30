import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  attachCrewDiagnostics,
  cliAvailable,
  configureCompanyCrewProvider,
  ensureRealCrew,
  listRuns,
  realCrewConfigFromEnv,
  requiredCrewId,
} from "./helpers/real-crew";
import {
  assertNoAgentEntryFrom,
  assertNoAgentSelectionStartsRun,
  assertNoDuplicateAgentMessages,
  assertNoIssuesCreated,
  createThreadFromUi,
  getDiscussion,
  patchThreadAutonomy,
  sendThreadMessage,
  setCrewPaused,
  waitForVisibleAgentEntry,
} from "./helpers/thread-flow";
import {
  assertScopeHasArtifactEvidence,
  createScopeDraftFromUi,
  createTaskFromUi,
  linkArtifactFromUi,
  latestScopeVersionDetail,
  openDraftMemoryViewer,
  openDraftTaskWorkbench,
  rejectScopeItemFromUi,
  saveMemoryFromUi,
  waitForAcceptedScopeAfterDirectCreate,
} from "./helpers/scope-flow";

const RUN_REAL_CREW_FLOW = process.env.AOA_E2E_REAL_CREW_FLOW === "1";
const config = realCrewConfigFromEnv();

test.describe("real crew discussion flow", () => {
  test.setTimeout(config.timeoutMs + 180_000);

  test.skip(
    !RUN_REAL_CREW_FLOW,
    "Set AOA_E2E_REAL_CREW_FLOW=1 and run against a live/local real-provider server.",
  );

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Real-Discussion-/);
  });

  test("watches real crew discuss, create artifact, scope, direct-create work, and re-scope v2", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(!cliAvailable(config.binary), `${config.binary} CLI not found on PATH`);
    expect(process.env.AOA_E2E_FAKE_CREW_LLM, "real crew E2E must not run with fake crew LLM").not.toBe("1");

    const diagnostics: Record<string, unknown> = {
      provider: config.provider,
      adapterType: config.adapterType,
      model: config.model,
      startedAt: new Date().toISOString(),
    };

    const company = await seedCompany(request, `E2E-Real-Discussion-${config.provider}-${Date.now()}`);
    diagnostics.company = company;
    await configureCompanyCrewProvider(request, company.id, config, 0);
    const crew = await ensureRealCrew(request, company.id, config);
    diagnostics.crew = crew.map((agent) => ({
      id: agent.id,
      name: agent.name,
      adapterType: agent.adapterType,
      status: agent.status,
    }));

    const adjutantId = requiredCrewId(crew, "Adjutant");
    const scoutId = requiredCrewId(crew, "Scout");
    const plannerId = requiredCrewId(crew, "Planner");

    let threadId = "";
    try {
      await page.goto(`/${company.issuePrefix}/discussions`);
      await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({ timeout: 15_000 });

      threadId = await createThreadFromUi(
        page,
        `Real crew discussion flow ${Date.now()}`,
        [
          "We are designing the discussion-to-work flow for founders.",
          "The crew should discuss before tracked work exists.",
          "We need one markdown artifact, one task, one memory, and then a v2 follow-up.",
        ].join(" "),
      );
      diagnostics.threadUrl = `/${company.issuePrefix}/discussions/${threadId}`;

      await patchThreadAutonomy(request, company.id, threadId, 0);
      await sendThreadMessage(
        page,
        "Manual check: this normal user message should not cause proactive crew posts. Wait silently unless I mention you.",
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      await assertNoAgentEntryFrom(request, company.id, threadId, adjutantId);
      await assertNoIssuesCreated(request, company.id);

      await sendThreadMessage(
        page,
        "@Adjutant please reply as yourself with a short next-step recommendation. Do not create tasks or memory yet.",
      );
      await waitForVisibleAgentEntry(
        page,
        request,
        company.id,
        threadId,
        adjutantId,
        "Adjutant",
        "Adjutant direct mention entry",
        config.timeoutMs,
      );
      await assertNoIssuesCreated(request, company.id);

      await patchThreadAutonomy(request, company.id, threadId, 1);
      await sendThreadMessage(
        page,
        "@Scout validate the user need, risks, and evidence from the whole conversation. Reply in the thread.",
      );
      await waitForVisibleAgentEntry(
        page,
        request,
        company.id,
        threadId,
        scoutId,
        "Scout",
        "Scout assist entry",
        config.timeoutMs,
      );
      await assertNoIssuesCreated(request, company.id);

      await setCrewPaused(request, company.id, threadId, true);
      const pausedThread = await getDiscussion(request, company.id, threadId);
      const pausedAt = Date.parse(pausedThread.updatedAt ?? new Date().toISOString());
      const pausedSummaryUpdatedAt = pausedThread.summaryUpdatedAt
        ? Date.parse(pausedThread.summaryUpdatedAt)
        : null;
      await sendThreadMessage(page, "Pause check: no proactive crew work should start while crew is paused.");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const runsCreatedAfterPause = (await listRuns(request, company.id)).filter((run) => {
        const createdAt = typeof run.createdAt === "string" ? Date.parse(run.createdAt) : NaN;
        return Number.isFinite(createdAt) && createdAt > pausedAt && JSON.stringify(run).includes(threadId);
      });
      expect(runsCreatedAfterPause, "crew pause should block new thread runs").toEqual([]);
      const afterPausedThread = await getDiscussion(request, company.id, threadId);
      const afterSummaryUpdatedAt = afterPausedThread.summaryUpdatedAt
        ? Date.parse(afterPausedThread.summaryUpdatedAt)
        : null;
      if (pausedSummaryUpdatedAt === null) {
        expect(afterSummaryUpdatedAt, "paused thread summary should not be created").toBeNull();
      } else {
        expect(afterSummaryUpdatedAt, "paused thread summary should not advance").toBe(pausedSummaryUpdatedAt);
      }
      await assertNoDuplicateAgentMessages(request, company.id, threadId);
      await setCrewPaused(request, company.id, threadId, false);

      await sendThreadMessage(
        page,
        "@Planner create a concise markdown artifact named discussion-scope-notes.md with the decisions, risks, and proposed handoff. Reply in the thread after creating it.",
      );
      await waitForVisibleAgentEntry(
        page,
        request,
        company.id,
        threadId,
        plannerId,
        "Planner",
        "Planner artifact entry",
        config.timeoutMs,
      );
      const discussionAfterArtifact = await getDiscussion(request, company.id, threadId);
      const artifactText = JSON.stringify(discussionAfterArtifact).toLowerCase();
      expect(artifactText, "artifact should be visible in discussion state").toMatch(/artifact|discussion-scope-notes|markdown|handoff/);

      await createScopeDraftFromUi(page, { request, companyId: company.id, threadId });
      const v1 = await latestScopeVersionDetail(request, company.id, threadId);
      expect(v1).toMatchObject({ versionNumber: 1, status: "draft" });
      expect(v1.summary).toMatch(/artifact|handoff|memory|task|founder|discussion/i);
      await assertScopeHasArtifactEvidence(v1);
      const taskItem = v1.items.find((item) => item.kind === "task_proposal");
      const memoryItem = v1.items.find((item) => item.kind === "memory_candidate");
      const artifactItem = v1.items.find((item) => item.kind === "artifact_link");
      expect(taskItem, "scope v1 should include a task proposal").toBeTruthy();
      expect(memoryItem, "scope v1 should include a memory candidate").toBeTruthy();
      expect(artifactItem, "scope v1 should include the Planner artifact").toBeTruthy();
      expect(artifactItem!.artifactId, "artifact scope item should carry artifactId").toBeTruthy();
      expect(artifactItem!.artifactVersionId, "artifact scope item should carry artifactVersionId").toBeTruthy();
      expect(JSON.stringify(artifactItem!.payload ?? {}), "artifact scope item payload").toMatch(
        /discussion-scope-notes|handoff|markdown|document/i,
      );

      const artifactCard = page.getByTestId(`scope-version-card-${artifactItem!.id}`);
      await expect(artifactCard).toBeVisible({ timeout: 15_000 });
      await expect(artifactCard).toContainText(/discussion-scope-notes|artifact|handoff|decision/i);
      await artifactCard.click({ position: { x: 18, y: 18 } });
      await expect(page.getByTestId("thread-artifact-viewer")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId("thread-artifact-viewer")).toContainText(/discussion|decision|handoff|risk/i);
      await page.getByRole("tab", { name: /Open/i }).first().click();
      await expect(page.getByTestId("thread-open-viewer")).toContainText(/discussion-scope-notes|artifact|handoff/i);
      await page.getByTestId("center-tab-scope").click();

      await openDraftMemoryViewer(page, memoryItem!.id);
      await saveMemoryFromUi(page, v1.id, memoryItem!.id, "pending");
      const extraMemoryItems = v1.items.filter(
        (item) => item.kind === "memory_candidate" && item.id !== memoryItem!.id && item.status !== "rejected",
      );
      for (const extraMemoryItem of extraMemoryItems) {
        await rejectScopeItemFromUi(page, v1.id, extraMemoryItem.id);
      }
      await openDraftTaskWorkbench(page, taskItem!.id);
      await expect(page.getByTestId("thread-draft-task-workbench")).toContainText(/discussion-scope-notes|artifact|handoff/i);
      await expect(page.getByTestId("thread-draft-task-workbench")).toContainText(/Message \d+|Source message/i);
      await createTaskFromUi(page, v1.id, taskItem!.id);
      await linkArtifactFromUi(page, v1.id, artifactItem!.id);

      const acceptedV1 = await waitForAcceptedScopeAfterDirectCreate(request, company.id, threadId, v1.id);
      expect(acceptedV1.status).toBe("accepted");

      const discussionAfterV1 = await getDiscussion(request, company.id, threadId);
      expect(discussionAfterV1.derivedStage?.label).toMatch(/Assigned|Scoped|Complete|Scoping|Discussing/i);

      await page.getByTestId("center-tab-thread").click();
      await sendThreadMessage(
        page,
        "Follow-up after accepted v1: add viewer-resize polish and make sure task handoff action buttons do not hide when the viewer is wide.",
      );
      const discussionAfterFollowup = await getDiscussion(request, company.id, threadId);
      expect(discussionAfterFollowup.derivedStage?.label).toBe("Discussing v2");

      await createScopeDraftFromUi(page, { request, companyId: company.id, threadId });
      const v2 = await latestScopeVersionDetail(request, company.id, threadId);
      expect(v2).toMatchObject({ versionNumber: 2, status: "draft" });
      expect(v2.sourceStartSeq).toBe(acceptedV1.sourceEndSeq + 1);
      expect(v2.sourceEndSeq).toBe(discussionAfterFollowup.entrySeq);

      await page.setViewportSize({ width: 1440, height: 900 });
      await openDraftTaskWorkbench(page, v2.items.find((item) => item.kind === "task_proposal")?.id ?? taskItem!.id);
      await expect(page.getByTestId("thread-viewer-draft-task-actions")).toBeVisible({ timeout: 10_000 });

      await assertNoDuplicateAgentMessages(request, company.id, threadId);
      await assertNoAgentSelectionStartsRun(page, request, company.issuePrefix, company.id);

      const finalRuns = await listRuns(request, company.id);
      diagnostics.finalRunCount = finalRuns.length;
    } finally {
      if (threadId) {
        await attachCrewDiagnostics(testInfo, request, company.id, threadId, diagnostics);
        await page.screenshot({ path: testInfo.outputPath("real-crew-discussion-final.png"), fullPage: true }).catch(() => undefined);
      }
    }
  });
});

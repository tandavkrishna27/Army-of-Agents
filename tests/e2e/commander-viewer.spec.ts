import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import { jsonOrThrow } from "./helpers/real-crew";
import {
  createArtifactTurn,
  queryArtifactsTurn,
  writeFakeClaudeControl,
} from "./helpers/fake-claude";

/**
 * E2E — Commander viewer, driven through the REAL chat UI against a
 * deterministic fake `claude` CLI.
 *
 * The playwright config prepends tests/e2e/fixtures/fake-claude to the
 * webServer's PATH, so Commander's cli-mode (`which claude` + spawn) resolves
 * the fake binary. Each test writes the control file (helpers/fake-claude)
 * BEFORE sending a message; the fake emits that scripted turn as stream-json
 * (tool_use → tool_result-with-outputRefs-envelope → text deltas → result),
 * exercising the full pipeline: parser ref-lift → SSE `tool_result {name,
 * refs}` → chips → viewer panel → persistence on internal_agent_messages.
 *
 * Commander runs one fake-claude process per send (`--print` exits after the
 * turn and the session is reaped on exit), so each send re-reads the control
 * file — "write control, then send" fully scripts the next reply.
 *
 * A fresh company auto-seeds internal_agent_config (executionMode 'cli',
 * cliTool null → agent-loop defaults to 'claude_cli'), so no config seeding
 * is needed.
 *
 * ── Redesigned layout (Phases 1–8) ───────────────────────────────────────────
 * The viewer no longer has its own rail. Instead:
 *   • The viewer opens via the chat-header "Open preview" toggle
 *     (data-testid="commander-open-preview", aria-label="Open preview").
 *   • Opening the preview shows commander-viewer-panel (center split) AND
 *     collapses the Sessions sidebar + Cockpit sidebars to rails:
 *       - Sessions rail → aria-label="Expand chats sidebar"
 *       - Cockpit rail  → aria-label="Expand cockpit"
 *   • Created-ref auto-open still reveals the viewer (via openPreview("right-panel")).
 *   • The viewer's "Hide preview" button (aria-label="Hide preview") closes it
 *     and restores the sidebars.
 *   • The choreography unit test (openPreviewChoreography.test.ts) covers the
 *     pure collapse-state logic; these e2e tests cover the full-stack wiring.
 */

const ARTIFACT_TITLE = "Launch Plan Q3";
const ARTIFACT_MARKER = "Phase one: ship the fake-CLI demo";
const ARTIFACT_CONTENT = `# ${ARTIFACT_TITLE}\n\n${ARTIFACT_MARKER}.\n\nPhase two: profit.`;

const REPLY_CREATED = "I drafted the launch plan and saved it as an artifact.";
const REPLY_REFERENCED =
  "We already have the launch plan artifact. Reply marker: zebra-quokka.";

interface SeededArtifact {
  id: string;
  versionId: string | null;
  title: string;
}

/** Seed a REAL artifact (with an initial markdown version) via the API. */
async function seedArtifact(
  request: APIRequestContext,
  companyId: string,
  opts: { title: string; content: string },
): Promise<SeededArtifact> {
  const res = await request.post(`/api/companies/${companyId}/artifacts`, {
    data: {
      title: opts.title,
      type: "document",
      source: "founder",
      content: opts.content,
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedArtifact failed: ${res.status()} ${body}`);
  }
  const body = (await res.json()) as {
    id: string;
    currentVersionId?: string | null;
    versions?: Array<{ id: string }>;
  };
  return {
    id: body.id,
    versionId: body.versions?.[0]?.id ?? body.currentVersionId ?? null,
    title: opts.title,
  };
}

/**
 * Send a message through the REAL composer: the contenteditable rich input
 * (role=textbox, aria-label from placeholder "Ask the agent...") submits on
 * Enter (CommanderInput.handleKeyDown → submit → onSubmit → sendText).
 */
async function sendMessage(page: Page, text: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Ask the agent..." });
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/**
 * Wait for the streaming turn to finish: while streaming the Send button is
 * swapped for "Stop generation"; when the SSE stream ends it swaps back.
 */
async function waitForTurnEnd(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("Commander viewer", () => {
  test.beforeEach(async ({ page }) => {
    // Viewport changes are page-scoped but the page is reused across tests in
    // this worker. Reset the desktop baseline so the tablet/mobile cases cannot
    // make later cockpit assertions inspect the rail instead of the panel.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.addInitScript(() => {
      // Each test owns its cockpit layout. Do not inherit a collapsed rail
      // from another browser context when the test is asserting card content.
      localStorage.setItem("aoa:commander:cockpit-collapsed", "false");
      localStorage.setItem("aoa:commander:viewer-collapsed", "true");
    });
  });

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdViewer-/);
  });

  test("full interaction loop: created chip auto-opens via openPreview, history chips, referenced chip, home, reply pop-out", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Loop-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, {
      title: ARTIFACT_TITLE,
      content: ARTIFACT_CONTENT,
    });

    await page.goto(`/${company.issuePrefix}/commander`);

    // Desktop default state: viewer panel is NOT mounted; no viewer rail.
    // The viewer opens exclusively via the "Open preview" toggle.
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0, {
      timeout: 15_000,
    });
    // Confirm the chat header "Open preview" toggle is reachable.
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({
      timeout: 15_000,
    });

    // ── Turn 1: create_artifact (action: created) ──────────────────────────
    writeFakeClaudeControl(createArtifactTurn(artifact, REPLY_CREATED));
    await sendMessage(page, "Draft a launch plan for Q3");

    // Chip with the artifact title appears under the reply.
    const chipContainers = page.getByTestId("output-ref-chips");
    await expect(
      chipContainers.getByRole("button", { name: new RegExp(ARTIFACT_TITLE) }),
    ).toBeVisible({ timeout: 30_000 });

    // Created ref auto-opens the viewer panel via openPreview("right-panel").
    // The artifact's real markdown content renders inside it.
    const panel = page.getByTestId("commander-viewer-panel");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText(ARTIFACT_MARKER)).toBeVisible({ timeout: 15_000 });

    // Opening the preview collapses the Sessions sidebar to its rail.
    // (On the default desktop viewport ≥ 1024px but < 1536px, isWide=false so
    // BOTH sessions and cockpit collapse — mirrors the B6 rule in the choreography.)
    await expect(
      page.getByRole("button", { name: "Expand chats sidebar" }),
    ).toBeVisible({ timeout: 10_000 });

    // Cockpit also collapses to its rail on this viewport (isWide=false).
    await expect(
      page.getByRole("button", { name: "Expand cockpit" }),
    ).toBeVisible({ timeout: 10_000 });

    await waitForTurnEnd(page);

    // Close the viewer via the chat-header toggle (which now shows "Hide preview").
    // Use data-testid="commander-open-preview" to avoid strict-mode collision with
    // the ViewerTabs "Hide preview" button inside the viewer panel header.
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toHaveCount(0);
    // Sessions sidebar should be restored (it was expanded before open).
    await expect(
      page.getByRole("button", { name: "Expand chats sidebar" }),
    ).toHaveCount(0, { timeout: 5_000 });

    // ── Reload: chips re-render from persisted history (output_refs) ───────
    await page.reload();
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({
      timeout: 15_000,
    });
    const historyChip = page
      .getByTestId("output-ref-chips")
      .getByRole("button", { name: new RegExp(ARTIFACT_TITLE) });
    await expect(historyChip).toBeVisible({ timeout: 15_000 });

    // Clicking the history chip opens the viewer via openPreview("right-panel").
    await historyChip.click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(ARTIFACT_MARKER)).toBeVisible({ timeout: 15_000 });

    // Collapse again so the no-auto-open assertion below is meaningful.
    // Use data-testid to avoid strict-mode collision with the ViewerTabs button.
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toHaveCount(0);

    // ── Turn 2: query_company_artifacts (action: referenced) ───────────────
    writeFakeClaudeControl(queryArtifactsTurn([artifact], REPLY_REFERENCED));
    await sendMessage(page, "What artifacts do we have?");

    // Second chip row renders (one per refs-bearing assistant message)...
    await expect(page.getByTestId("output-ref-chips")).toHaveCount(2, {
      timeout: 30_000,
    });
    await waitForTurnEnd(page);

    // ...but referenced refs do NOT auto-open: panel stays closed.
    await expect(panel).toHaveCount(0);

    // ── Home tab: both groups ───────────────────────────────────────────────
    // Open preview manually first so we can navigate to home.
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Open viewer home" }).click();
    const home = page.getByTestId("commander-viewer-home");
    await expect(home).toBeVisible();
    await expect(home.getByText("Recent from this conversation")).toBeVisible();
    await expect(home.getByText("Recent in company")).toBeVisible({
      timeout: 15_000,
    });

    // ── Reply pop-out: hover the last reply, open it in the viewer ─────────
    // Close the preview first. Use data-testid to avoid strict-mode collision.
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toHaveCount(0);

    await page.getByText("zebra-quokka").last().hover();
    await page.getByRole("button", { name: "Open reply in viewer" }).last().click();
    await expect(panel.getByText(/zebra-quokka/)).toBeVisible({ timeout: 15_000 });
  });

  test("tool indicator settles to the completed label once the refs-bearing tool_result lands", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Spin-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, {
      title: ARTIFACT_TITLE,
      content: ARTIFACT_CONTENT,
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    // Default: viewer panel not mounted.
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0, {
      timeout: 15_000,
    });

    // Tool activity now PERSISTS (Phase 3): toolCalls/toolResults are written to
    // internal_agent_messages and re-hydrated by serverToLocal, so the settled
    // indicator survives the post-turn sync and a reload. holdMs is no longer
    // required to observe it, but is kept here as a stable observation window.
    writeFakeClaudeControl({
      ...createArtifactTurn(artifact, REPLY_CREATED),
      holdMs: 2500,
    });
    await sendMessage(page, "Create the launch plan artifact");

    // The chip renders once the refs-bearing tool_result is processed.
    await expect(
      page
        .getByTestId("output-ref-chips")
        .getByRole("button", { name: new RegExp(ARTIFACT_TITLE) }),
    ).toBeVisible({ timeout: 30_000 });

    // While the stream is still held open, the tool indicator has SETTLED to the
    // completed label — completedToolLabel("mcp__aoa__create_artifact") =
    // "Used mcp aoa create artifact" (InternalAgentPanel). This is the spinner
    // fix: tool_result.name now resolves to the real tool name, so it matches
    // and settles the running entry. With the pre-fix bug (name = tool_use_id)
    // the indicator would still read "Running mcp aoa create artifact..." here.
    await expect(page.getByText("Used mcp aoa create artifact")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText(/^Running mcp aoa create artifact/),
    ).toHaveCount(0);

    // The held stream then completes normally.
    await waitForTurnEnd(page);
  });

  test("cockpit task rows open the task focus pane without creating viewer tabs", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Task-${Date.now()}`);
    const taskTitle = "Review Commander task surface";
    const taskRes = await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: taskTitle,
        description: "This task should open in the shared Commander focus pane.",
        status: "in_review",
        priority: "high",
        reviewerUserId: (await jsonOrThrow<{ currentUser: { userId: string } }>(
          await request.get(`/api/companies/${company.id}/team`),
          "get Commander task reviewer",
        )).currentUser.userId,
      },
    });
    expect(taskRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/commander`);
    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    if ((await expandCockpit.count()) === 1) await expandCockpit.click();

    const reviewCard = page.getByTestId("cockpit-card-review");
    await expect(reviewCard.getByRole("button", { name: new RegExp(taskTitle) })).toBeVisible({
      timeout: 15_000,
    });
    await reviewCard.getByRole("button", { name: new RegExp(taskTitle) }).click();

    const taskFocus = page.getByTestId("commander-task-focus-pane");
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/commander$`));
    await expect(taskFocus).toBeVisible({ timeout: 15_000 });
    await expect(taskFocus.getByText(taskTitle, { exact: true })).toBeVisible();
    await expect(
      taskFocus.getByText("This task should open in the shared Commander focus pane.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
  });

  test("cockpit separates Mine, Managed, and Awaiting Review work", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Work-${Date.now()}`);
    const team = await jsonOrThrow<{ currentUser: { userId: string } }>(
      await request.get(`/api/companies/${company.id}/team`),
      "get Commander team",
    );
    const founderId = team.currentUser.userId;

    await jsonOrThrow(
      await request.patch(`/api/companies/${company.id}/team/users/${founderId}/profile`, {
        data: { displayName: "E2E Commander", title: "Founder", timezone: "UTC" },
      }),
      "name Commander",
    );
    const deliveryLead = await jsonOrThrow<{ userId: string }>(
      await request.post(`/api/companies/${company.id}/team/members`, {
        data: {
          name: "E2E Delivery Lead",
          email: `commander-lead-${Date.now()}@example.com`,
          role: "team_member",
          parentType: "user",
          parentId: founderId,
        },
      }),
      "create reporting human",
    );
    const managedAgent = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/agents`, {
        data: {
          name: "E2E Managed Agent",
          parentType: "user",
          parentId: deliveryLead.userId,
        },
      }),
      "create reporting agent",
    );

    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E Commander mine task",
          status: "todo",
          priority: "high",
          responsibleUserId: founderId,
        },
      }),
      "create Mine task",
    );
    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E managed human task",
          status: "in_progress",
          priority: "medium",
          assigneeUserId: deliveryLead.userId,
          responsibleUserId: deliveryLead.userId,
        },
      }),
      "create managed human task",
    );
    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E managed agent task",
          status: "blocked",
          priority: "critical",
          assigneeAgentId: managedAgent.id,
          responsibleUserId: deliveryLead.userId,
        },
      }),
      "create managed agent task",
    );
    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "E2E explicit review task",
          status: "in_review",
          priority: "high",
          responsibleUserId: deliveryLead.userId,
          reviewerUserId: founderId,
        },
      }),
      "create explicit review task",
    );

    await page.goto(`/${company.issuePrefix}/commander`);
    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    if ((await expandCockpit.count()) === 1) await expandCockpit.click();

    const activeWork = page.getByTestId("cockpit-card-my-tasks");
    await expect(activeWork.getByText("Mine", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(activeWork.getByText("E2E Commander mine task")).toBeVisible();
    await expect(activeWork.getByText("Managed", { exact: true })).toBeVisible();
    await expect(activeWork.getByText("E2E managed human task")).toBeVisible();
    await expect(activeWork.getByText("Managed: E2E Delivery Lead")).toBeVisible();
    await expect(activeWork.getByText("E2E managed agent task")).toBeVisible();
    await expect(activeWork.getByText("Managed: E2E Managed Agent")).toBeVisible();

    const awaitingReview = page.getByTestId("cockpit-card-review");
    await expect(awaitingReview.getByText("E2E explicit review task")).toBeVisible();
    await expect(awaitingReview.getByText("Your review")).toBeVisible();

    await activeWork.getByRole("button", { name: /E2E managed agent task/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/commander$`));
    await expect(
      page.getByTestId("commander-task-focus-pane").getByText("E2E managed agent task", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
  });

  test("cockpit discussion rows open a dedicated work pane without Commander viewer tabs", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Cockpit-${Date.now()}`);

    const discussionTitle = "Commander cockpit e2e thread";
    const discussionRes = await request.post(`/api/companies/${company.id}/discussions`, {
      data: {
        title: discussionTitle,
        entry: {
          inputType: "paste",
          rawContent: "This seeded discussion should open inside the Commander viewer.",
        },
      },
    });
    expect(discussionRes.ok()).toBe(true);
    const discussion = (await discussionRes.json()) as {
      id: string;
      entry?: { id: string } | null;
    };
    expect(discussion.entry?.id).toBeTruthy();
    const reprocessRes = await request.post(
      `/api/companies/${company.id}/discussions/${discussion.id}/entries/${discussion.entry!.id}/reprocess`,
    );
    expect(reprocessRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/commander`);
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({
      timeout: 15_000,
    });

    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    if ((await expandCockpit.count()) === 1) {
      await expandCockpit.click();
    }

    const discussionsCard = page.getByTestId("cockpit-card-discussions");
    await expect(discussionsCard.getByText(discussionTitle)).toBeVisible({
      timeout: 15_000,
    });

    const discussionRow = discussionsCard.getByText(discussionTitle).locator("xpath=ancestor::li[1]");
    await expect(discussionRow).toHaveAttribute("draggable", "true");
    await expect(discussionRow).toHaveClass(/cursor-grab/);

    await discussionsCard.getByRole("button", { name: discussionTitle }).click();

    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/commander$`));
    const discussionPane = page.getByTestId("commander-discussion-pane");
    await expect(discussionPane).toBeVisible({ timeout: 15_000 });
    await expect(discussionPane.getByTestId("thread-detail")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      discussionPane.getByRole("heading", { name: discussionTitle }).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(discussionPane.getByText("This seeded discussion should open inside the Commander viewer.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(discussionPane.getByRole("tab", { name: "Thread" })).toBeVisible();
    await expect(discussionPane.getByRole("tab", { name: "Scope" })).toBeVisible();
    await expect(discussionPane.getByRole("tab", { name: "Branches" })).toBeVisible();
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);

    await discussionPane.getByRole("button", { name: "Close discussion focus" }).click();
    await expect(discussionPane).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Collapse cockpit" })).toBeVisible();
  });

  test("tablet: cockpit rail opens the full cockpit as a sheet", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    const company = await seedCompany(request, `E2E-CmdViewer-Tablet-${Date.now()}`);
    const taskTitle = "E2E tablet Commander task";
    const taskRes = await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: taskTitle, status: "todo", priority: "high" },
    });
    expect(taskRes.ok()).toBe(true);

    await page.goto(`/${company.issuePrefix}/commander`);
    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    await expect(expandCockpit).toBeVisible({ timeout: 15_000 });
    await expandCockpit.click();

    const cockpitSheet = page.getByRole("dialog", { name: "Cockpit" });
    await expect(cockpitSheet).toBeVisible();
    await expect(cockpitSheet.getByRole("button", { name: /Active work/ })).toBeVisible({
      timeout: 15_000,
    });
    await expect(cockpitSheet.getByText(taskTitle)).toBeVisible();

    await cockpitSheet.getByRole("button", { name: "Collapse cockpit" }).click();
    await expect(cockpitSheet).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Expand cockpit" })).toBeVisible();
  });

  test("cockpit inbox rows open actionable Hub detail without navigating", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdViewer-Inbox-${Date.now()}`);
    const inboxTitle = "Commander run failed";
    const inboxSummary = "The launch validation run failed during launch validation.";
    await seedHubItem({
      companyId: company.id,
      // A successful heartbeat completion is history and is reconciled out of
      // Inbox. Use an actionable exception notification for this viewer test.
      semanticType: "agent_error",
      sourceType: "test_fixture",
      sourceId: crypto.randomUUID(),
      title: inboxTitle,
      summary: inboxSummary,
      priority: "normal",
    });

    await page.goto(`/${company.issuePrefix}/commander`);
    const expandCockpit = page.getByRole("button", { name: "Expand cockpit" });
    if ((await expandCockpit.count()) === 1) {
      await expandCockpit.click();
    }

    const inboxCard = page.getByTestId("cockpit-card-inbox");
    await expect(inboxCard.getByRole("button", { name: inboxTitle })).toBeVisible({
      timeout: 15_000,
    });
    await inboxCard.getByRole("button", { name: inboxTitle }).click();

    const panel = page.getByTestId("commander-viewer-panel");
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/commander$`));
    await expect(panel.getByTestId("commander-inbox-ref-body")).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel.getByText(inboxSummary)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Dismiss" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Snooze" })).toBeVisible();

    await panel.getByRole("button", { name: "Dismiss" }).click();
    await expect(panel.getByRole("button", { name: "Undo dismiss" })).toBeVisible();
  });

  test("mobile: pill badges on created ref without auto-opening the sheet; tap opens viewer tabs", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 480, height: 800 });

    const company = await seedCompany(request, `E2E-CmdViewer-Mob-${Date.now()}`);
    const artifact = await seedArtifact(request, company.id, {
      title: ARTIFACT_TITLE,
      content: ARTIFACT_CONTENT,
    });

    await page.goto(`/${company.issuePrefix}/commander`);

    // Mobile breakpoint (< 1024px): floating pill instead of inline sidebars.
    // The desktop viewer panel is not rendered on mobile.
    const pill = page.getByTestId("commander-viewer-pill");
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);

    writeFakeClaudeControl(createArtifactTurn(artifact, REPLY_CREATED));
    await sendMessage(page, "Draft a launch plan for Q3");

    // Chip renders under the reply...
    await expect(
      page
        .getByTestId("output-ref-chips")
        .getByRole("button", { name: new RegExp(ARTIFACT_TITLE) }),
    ).toBeVisible({ timeout: 30_000 });

    // ...but the sheet did NOT auto-open (no desktop panel on mobile either),
    // and the pill shows a pending badge instead.
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0);
    await expect(page.getByTestId("commander-viewer-tabs")).toHaveCount(0);
    await expect(pill.getByText("1")).toBeVisible({ timeout: 15_000 });

    await waitForTurnEnd(page);

    // Tapping the pill opens the sheet with the viewer tab bar.
    await pill.click();
    await expect(page.getByTestId("commander-viewer-tabs")).toBeVisible({
      timeout: 15_000,
    });
  });
});

/**
 * E2E (fake-crew harness Path B): Assist Inbox crew_dispatch approval round-trip
 * — CI-runnable sibling of team-aoa-crew-dispatch-approval.spec.ts.
 *
 * The gated real-crew spec proves the flow with a live CLI (AOA_E2E_REAL_CREW_FLOW=1,
 * skipped in CI). This spec proves the SAME server-side pipeline in normal CI by
 * scripting the fake Adjutant's controller-mode turn via the control file:
 *   mention wakeup → fake queues create_scope_draft (real thread action, real
 *   idempotency key, real freshness) → runner seals + commits → W1b Assist gate
 *   creates the task as planning + ONE crew_dispatch approval → approve →
 *   planning→standard flip.
 * Everything from proposeThreadAction onward is PRODUCTION code — only the LLM
 * turn is fake.
 *
 * UI verification (not just REST): the spec drives + asserts the founder-visible
 * surfaces — the Crew Board (`crew-board` / `kanban-card-*`) showing the
 * agent-titled task, and the Approvals page showing the "Dispatch Crew Tasks"
 * card, approved via a REAL Approve-button click → "Approval confirmed". Drive
 * asserts the Approvals page stays empty (no human gate). Screenshots land in
 * test-results/ui-proof/ as visual proof. (The crew Kanban card does not render
 * a Planning pill — that parked/dispatched state lives in the approval flow, not
 * on the board — so the flip is asserted via the approval UI + a REST backstop.)
 *
 * Scope note (challenger finding 6): this spec asserts the planning→standard FLIP
 * (Assist) and standard-at-creation (Drive) — NOT the crew RUN that follows. A
 * fake crew turn never calls set_task_status, so a dispatched task trips the
 * runner's silent-stuck guard (task released back to todo, run marked failed).
 * That failed-run noise is harmless to these workMode assertions but means the
 * agent-executes-the-task leg stays covered ONLY by the gated real-crew soak.
 */

import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { jsonOrThrow, poll } from "./helpers/real-crew";
import {
  resetFakeCrewControl,
  writeFakeCrewControl,
} from "./helpers/fake-crew-control";
import {
  createThreadFromUi,
  patchThreadAutonomy,
  sendThreadMessage,
  waitForVisibleAgentEntry,
} from "./helpers/thread-flow";

type CrewDispatchApproval = {
  id: string;
  type: string;
  status: string;
  payload: { taskIds?: string[] };
};

type CrewIssue = { id: string; workMode?: string | null; title?: string };

type AgentRow = { id: string; name: string; kind: string };

// Budget for the fake Adjutant turn to land (server warmup + wakeup + commit).
const AGENT_TURN_TIMEOUT_MS = 120_000;

// UI-proof screenshots land here so a human can eyeball the crew board + approval
// surfaces the founder actually sees (not just the REST state underneath).
const UI_PROOF_DIR = "test-results/ui-proof";

/** Navigate to the crew board (AoA Tasks tab) and wait for it to render. */
async function gotoCrewBoard(page: import("@playwright/test").Page, issuePrefix: string): Promise<void> {
  await page.goto(`/${issuePrefix}/team?tab=aoa&aoaTab=tasks`);
  await expect(page.getByTestId("crew-board")).toBeVisible({ timeout: 30_000 });
}

test.describe("Team AoA — fake-crew Assist crew_dispatch approval round-trip (CI)", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ request }) => {
    resetFakeCrewControl();
    await cleanupTestCompanies(request, /^E2E-FakeDispatch-/);
  });

  test.afterEach(() => {
    // The control file is global (workers:1) — ALWAYS reset so later specs get
    // the legacy fake behavior they were written against.
    resetFakeCrewControl();
  });

  test("Assist: fake Adjutant scope → planning task + Inbox approval → approve → dispatched", async ({
    page,
    request,
  }) => {
    // ── 1. Company (crew auto-seeded by companyService.create) at Assist ──────
    const company = await seedCompany(request, `E2E-FakeDispatch-${Date.now()}`);
    // Eng-review fix 1 (challenger finding 1): the /agents route defaults to
    // kind:"org" — the crew agents are ONLY returned with ?kind=aoa (real-crew.ts
    // does exactly this). Without it, this list is empty and the Adjutant lookup
    // below fails deterministically.
    const agents = await jsonOrThrow<AgentRow[]>(
      await request.get(`/api/companies/${company.id}/agents?kind=aoa`),
      "list crew agents",
    );
    const adjutant = agents.find((a) => a.name === "Adjutant");
    expect(adjutant, "auto-seeded Adjutant crew agent").toBeTruthy();

    // ── 2. Script the fake Adjutant's next turn BEFORE triggering it ──────────
    writeFakeCrewControl({
      adjutant: {
        mode: "controller_scope",
        summary: "Build the token endpoint for the auth rewrite",
        proposedTasks: [{ title: "Implement the token endpoint", assigneeRole: "engineer" }],
      },
    });

    // ── 3. Thread at Assist (autonomy 1) + @Adjutant mention trigger ──────────
    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    // Create the empty thread through the API so Assist is active before the
    // first human entry. The E2E server uses a 250 ms debounce; creating a
    // thread with an initial non-mention entry would let the proactive timer
    // fire while the UI navigates, producing a second run before the explicit
    // @Adjutant message. The actual trigger remains a real UI composer post.
    const thread = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/discussions`, {
        data: { title: `Fake dispatch approval ${Date.now()}` },
      }),
      "create empty discussion",
    );
    const threadId = thread.id;
    await patchThreadAutonomy(request, company.id, threadId, 1); // Assist (thread override)
    await page.goto(`/${company.issuePrefix}/discussions/${threadId}`);
    await expect(page.getByRole("heading", { name: /Fake dispatch approval/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await sendThreadMessage(
      page,
      "We need to build the token endpoint for the auth rewrite, including refresh rotation. @Adjutant please scope this into tracked tasks.",
    );

    // The fake turn posts a visible confirmation entry once it queued the action.
    await waitForVisibleAgentEntry(
      page,
      request,
      company.id,
      threadId,
      adjutant!.id,
      "Adjutant",
      "fake Adjutant queued-scope entry",
      AGENT_TURN_TIMEOUT_MS,
    );

    // ── 4. ONE pending crew_dispatch approval referencing the planning task ───
    const dispatchApproval = await poll<CrewDispatchApproval[]>(
      async () =>
        jsonOrThrow<CrewDispatchApproval[]>(
          await request.get(`/api/companies/${company.id}/approvals?status=pending`),
          "list pending approvals",
        ),
      (approvals) =>
        approvals.some((a) => a.type === "crew_dispatch" && (a.payload.taskIds?.length ?? 0) > 0),
      "pending crew_dispatch approval",
      AGENT_TURN_TIMEOUT_MS,
    ).then((approvals) => approvals.find((a) => a.type === "crew_dispatch")!);

    const taskIds = dispatchApproval.payload.taskIds ?? [];
    expect(taskIds.length, "crew_dispatch approval carries the created task ids").toBe(1);
    const dispatchedTaskId = taskIds[0];

    // Backstop (REST): the task is parked as planning with the agent-authored title.
    const before = await jsonOrThrow<CrewIssue[]>(
      await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
      "list crew issues (before)",
    );
    const parked = before.find((i) => i.id === dispatchedTaskId);
    expect(parked?.workMode).toBe("planning");
    expect(parked?.title).toBe("Implement the token endpoint");

    // ── 5. UI PROOF: the founder opens the Crew Board and SEES the task the
    //       discussion produced — on the board, titled by the agent, assigned
    //       to the Engineer. (The crew Kanban card does not surface a Planning
    //       pill — that parked/dispatched distinction is shown via the approval
    //       flow below, not on this board.) ──────────────────────────────────
    await gotoCrewBoard(page, company.issuePrefix);
    const parkedCard = page.getByTestId(`kanban-card-${dispatchedTaskId}`);
    await expect(parkedCard).toBeVisible({ timeout: 30_000 });
    await expect(parkedCard).toContainText("Implement the token endpoint");
    await expect(parkedCard, "the crew task is assigned to the Engineer").toContainText("Engineer");
    await page.screenshot({ path: `${UI_PROOF_DIR}/assist-1-crew-board.png`, fullPage: true });

    // ── 6. UI PROOF: the founder approves the dispatch on the Approvals page
    //       (a real button click, not a REST POST). ─────────────────────────────
    await page.goto(`/${company.issuePrefix}/approvals`);
    const dispatchLabel = page.getByText(/Dispatch Crew Tasks/i).first();
    await expect(dispatchLabel, "the crew_dispatch approval is visible to the founder").toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${UI_PROOF_DIR}/assist-2-approval-visible.png`, fullPage: true });
    // Open the approval (row/card), then click the real Approve button.
    await dispatchLabel.click();
    const approveButton = page.getByRole("button", { name: /^Approve$/i }).first();
    await expect(approveButton, "an Approve button is presented to the founder").toBeVisible({
      timeout: 15_000,
    });
    await approveButton.click();

    // ── 7. UI PROOF: the founder sees the approval CONFIRMED — the crew tasks
    //       were dispatched. ────────────────────────────────────────────────────
    await expect(
      page.getByText(/Approval confirmed/i),
      "the founder sees the dispatch approval confirmed",
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^approved$/i).first(), "the approval is badged approved").toBeVisible();
    await page.screenshot({ path: `${UI_PROOF_DIR}/assist-3-approval-confirmed.png`, fullPage: true });

    // The dispatched task remains on the crew board.
    await gotoCrewBoard(page, company.issuePrefix);
    const dispatchedCard = page.getByTestId(`kanban-card-${dispatchedTaskId}`);
    await expect(dispatchedCard, "the dispatched task remains on the crew board").toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: `${UI_PROOF_DIR}/assist-4-crew-board-dispatched.png`, fullPage: true });

    // Backstop (REST): confirm the workMode actually flipped standard.
    const after = await poll<CrewIssue[]>(
      async () =>
        jsonOrThrow<CrewIssue[]>(
          await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
          "list crew issues (after)",
        ),
      (issues) => issues.find((i) => i.id === dispatchedTaskId)?.workMode === "standard",
      "crew task flipped to standard after approve",
      30_000,
    );
    expect(after.find((i) => i.id === dispatchedTaskId)?.workMode).toBe("standard");
  });

  // Eng-review 2A: Drive (autonomy 2) — the no-human-gate mode. Highest blast
  // radius, so it gets full-pipeline CI coverage too: NO approval is created and
  // the task lands dispatchable (standard) directly.
  //
  // Eng-review fix 7 (challenger finding 7): the create_scope_draft commit gate
  // reads effectiveAutonomy = thread.autonomyLevel ?? company.crewAutonomyLevel
  // (thread-agent-actions.ts; D18 split the company dial — crew reads
  // `crew_autonomy_level`, Commander keeps `autonomy_level`).
  // patchThreadAutonomy sets discussions.autonomyLevel
  // (the thread override) for THIS thread, so the gate resolves to Drive from the
  // thread row regardless of company config — the assertion holds off the thread
  // level. (Reconciliation note: patchThreadAutonomy ALSO writes company config to
  // the same level, so it is not thread-ONLY; but the fake harness spawns no stray
  // sweep runs, and the thread override is what this thread's gate reads, so the
  // finding-7 outcome is preserved.)
  test("Drive: fake Adjutant scope → task standard immediately, NO crew_dispatch approval", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-FakeDispatch-Drive-${Date.now()}`);
    // ?kind=aoa is required — the /agents route defaults to kind:"org" and would
    // return an empty list (mirrors the Assist test's lookup).
    const agents = await jsonOrThrow<AgentRow[]>(
      await request.get(`/api/companies/${company.id}/agents?kind=aoa`),
      "list crew agents",
    );
    const adjutant = agents.find((a) => a.name === "Adjutant");
    expect(adjutant, "auto-seeded Adjutant crew agent").toBeTruthy();

    writeFakeCrewControl({
      adjutant: {
        mode: "controller_scope",
        summary: "Drive-mode scope",
        proposedTasks: [{ title: "Ship the drive-mode task", assigneeRole: "engineer" }],
      },
    });

    // Pin the COMPANY crew dial to Drive BEFORE the thread gets any content.
    // createThreadFromUi posts an initial message, and the thread-event debounce
    // (AOA_THREAD_EVENT_DEBOUNCE_MS) can fire a controller sweep off that message.
    // If that sweep commits before patchThreadAutonomy(2) below lands (a race the
    // slower CI runner loses but a local box wins), it commits at the default
    // Assist autonomy and raises a stray crew_dispatch approval. Setting the
    // company dial to Drive up front makes any such sweep dispatch-not-approve.
    await jsonOrThrow(
      await request.patch(`/api/companies/${company.id}/internal-agent/config`, {
        data: { crewAutonomyLevel: 2, crewPaused: false },
      }),
      "pin company crew autonomy to Drive before thread content",
    );

    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    const threadId = await createThreadFromUi(
      page,
      `Fake drive dispatch ${Date.now()}`,
      "We need to ship the drive-mode task end to end.",
    );
    await patchThreadAutonomy(request, company.id, threadId, 2); // Drive (thread override)
    await sendThreadMessage(page, "@Adjutant please scope this into tracked tasks.");

    // Wait for the fake turn to actually land BEFORE polling issues — this gives
    // the poll a fast, deterministic bucket (just the post-turn commit) instead
    // of absorbing server warmup + wakeup, and throws early on a failed run.
    await waitForVisibleAgentEntry(
      page,
      request,
      company.id,
      threadId,
      adjutant!.id,
      "Adjutant",
      "fake Adjutant queued-scope entry (drive)",
      AGENT_TURN_TIMEOUT_MS,
    );

    // The task appears ALREADY dispatchable — no planning parking, no approval.
    const issues = await poll<CrewIssue[]>(
      async () =>
        jsonOrThrow<CrewIssue[]>(
          await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
          "list crew issues (drive)",
        ),
      (rows) => rows.some((i) => i.title === "Ship the drive-mode task" && i.workMode === "standard"),
      "drive-mode task created as standard",
      AGENT_TURN_TIMEOUT_MS,
    );
    const driveTask = issues.find((i) => i.title === "Ship the drive-mode task")!;
    expect(driveTask.workMode).toBe("standard");

    const approvals = await jsonOrThrow<CrewDispatchApproval[]>(
      await request.get(`/api/companies/${company.id}/approvals?status=pending`),
      "list pending approvals (drive)",
    );
    expect(
      approvals.filter((a) => a.type === "crew_dispatch"),
      "Drive must NOT raise a crew_dispatch approval",
    ).toHaveLength(0);

    // ── UI PROOF: the founder opens the Crew Board and SEES the Drive task
    //     already on the board, correctly titled and assigned. ─────────────────
    await gotoCrewBoard(page, company.issuePrefix);
    const driveCard = page.getByTestId(`kanban-card-${driveTask.id}`);
    await expect(driveCard).toBeVisible({ timeout: 30_000 });
    await expect(driveCard).toContainText("Ship the drive-mode task");
    await expect(driveCard, "the Drive crew task is assigned to the Engineer").toContainText("Engineer");
    await page.screenshot({ path: `${UI_PROOF_DIR}/drive-crew-board.png`, fullPage: true });

    // ── UI PROOF: no human gate at Drive — the Approvals page shows NO
    //     crew_dispatch approval (the task dispatched without asking). ──────────
    await page.goto(`/${company.issuePrefix}/approvals`);
    await expect(page.getByRole("heading", { name: /Approvals/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(/Dispatch Crew Tasks/i),
      "Drive raises no crew_dispatch approval in the UI",
    ).toHaveCount(0);
    await page.screenshot({ path: `${UI_PROOF_DIR}/drive-approvals-empty.png`, fullPage: true });
  });
});

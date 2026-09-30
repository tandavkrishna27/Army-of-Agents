/**
 * E2E (W1c): Assist Inbox crew_dispatch approval round-trip → task dispatched.
 *
 * Proves the HTTP-level round-trip added by W1c:
 *   At Assist (autonomy 1), when a crew agent's `create_scope_draft` action is
 *   committed, the handler auto-creates the assigned crew tasks as `planning`
 *   AND enqueues ONE pending `crew_dispatch` approval (surfaced in the Inbox,
 *   deep-linking to `/approvals`). Approving it (POST /approvals/:id/approve)
 *   flips those tasks `planning → standard` and dispatches them.
 *
 * ── Why this needs the REAL crew (not the deterministic REST path) ────────────
 * The `crew_dispatch` approval is created ONLY inside `commitThreadAgentActions`
 * (server/src/services/thread-agent-actions.ts), reachable ONLY when a crew agent
 * invokes the `propose_crew_work` tool during a real controller-gated CLI run
 * (server/src/services/internal-agent/tools/propose-crew-work.ts → actionType
 * "create_scope_draft" → committed by runner/sweep/orchestration). The manual
 * `scope-versions/draft` + per-item `/create` REST path that the sibling
 * team-aoa-crew-assignment.spec.ts uses does NOT run the Assist auto-accept gate,
 * so it never produces the approval. The fake-crew harness now ALSO covers this
 * path in normal CI via its controller-mode turn (see
 * team-aoa-crew-dispatch-approval-ci.spec.ts) — this spec remains the
 * LIVE-fidelity soak (real CLI, real MCP bridge, real tool registry gating),
 * gated behind AOA_E2E_REAL_CREW_FLOW=1 exactly like
 * real-crew-discussion-flow.spec.ts, and is skipped in normal CI.
 *
 * Company/agent/thread REST seeding + `jsonOrThrow` are reused verbatim from the
 * real-crew helpers, matching the sibling spec's conventions.
 */

import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  cliAvailable,
  configureCompanyCrewProvider,
  ensureRealCrew,
  jsonOrThrow,
  poll,
  realCrewConfigFromEnv,
  requiredCrewId,
} from "./helpers/real-crew";
import {
  createThreadFromUi,
  patchThreadAutonomy,
  sendThreadMessage,
  waitForVisibleAgentEntry,
} from "./helpers/thread-flow";

const RUN_REAL_CREW_FLOW = process.env.AOA_E2E_REAL_CREW_FLOW === "1";
const config = realCrewConfigFromEnv();

type CrewDispatchApproval = {
  id: string;
  type: string;
  status: string;
  payload: { taskIds?: string[] };
};

type CrewIssue = { id: string; workMode?: string | null };

test.describe("Team AoA — Assist Inbox crew_dispatch approval round-trip", () => {
  test.setTimeout(config.timeoutMs + 180_000);

  test.skip(
    !RUN_REAL_CREW_FLOW,
    "Set AOA_E2E_REAL_CREW_FLOW=1 and run against a live/local real-provider server.",
  );

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-W1c-Dispatch-/);
  });

  test(
    "Assist scope draft parks the crew task as planning + Inbox approval; approving dispatches it",
    async ({ page, request }) => {
      test.skip(!cliAvailable(config.binary), `${config.binary} CLI not found on PATH`);
      expect(process.env.AOA_E2E_FAKE_CREW_LLM, "real crew E2E must not run with fake crew LLM").not.toBe("1");

      // ── 1. Create company + configure the real crew provider at Assist (1) ────
      const company = await seedCompany(request, `E2E-W1c-Dispatch-${config.provider}-${Date.now()}`);
      await configureCompanyCrewProvider(request, company.id, config, 1);
      const crew = await ensureRealCrew(request, company.id, config);
      const adjutantId = requiredCrewId(crew, "Adjutant");

      // ── 2. Create a discussion thread and pin it to Assist (autonomy 1) ───────
      await page.goto(`/${company.issuePrefix}/discussions`);
      await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({ timeout: 15_000 });

      const threadId = await createThreadFromUi(
        page,
        `W1c dispatch approval ${Date.now()}`,
        "We need to build the token endpoint for the auth rewrite, including refresh rotation.",
      );
      await patchThreadAutonomy(request, company.id, threadId, 1); // Assist

      // ── 3. Ask the crew to scope this into tracked tasks (triggers Adjutant's
      //       propose_crew_work → create_scope_draft → committed at Assist) ──────
      await sendThreadMessage(
        page,
        "@Adjutant please scope this into tracked tasks and create the tasks assigned to the right crew. Turn this into work.",
      );
      await waitForVisibleAgentEntry(
        page,
        request,
        company.id,
        threadId,
        adjutantId,
        "Adjutant",
        "Adjutant scope draft entry",
        config.timeoutMs,
      );

      // ── 4. A pending crew_dispatch approval was enqueued, referencing the
      //       auto-created crew task(s). Poll — the commit is async after the run.
      const dispatchApproval = await poll<CrewDispatchApproval[], CrewDispatchApproval[]>(
        async () =>
          jsonOrThrow<CrewDispatchApproval[]>(
            await request.get(`/api/companies/${company.id}/approvals?status=pending`),
            "list pending approvals",
          ),
        (approvals): approvals is CrewDispatchApproval[] =>
          approvals.some((a) => a.type === "crew_dispatch" && (a.payload.taskIds?.length ?? 0) > 0),
        "pending crew_dispatch approval",
        config.timeoutMs,
      ).then((approvals) => approvals.find((a) => a.type === "crew_dispatch")!);

      expect(dispatchApproval, "a crew_dispatch approval should be enqueued at Assist").toBeTruthy();
      const taskIds = dispatchApproval.payload.taskIds ?? [];
      expect(taskIds.length, "crew_dispatch approval carries the created task ids").toBeGreaterThan(0);
      const dispatchedTaskId = taskIds[0];

      // ── 5. The task is on the Crew Board but parked (planning) ────────────────
      const before = await jsonOrThrow<CrewIssue[]>(
        await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
        "list crew issues (before)",
      );
      expect(before.find((i) => i.id === dispatchedTaskId)?.workMode).toBe("planning");

      // ── 6. Approve the dispatch (the Inbox one-click == POST /approvals/:id/approve) ─
      await jsonOrThrow(
        await request.post(`/api/approvals/${dispatchApproval.id}/approve`, { data: { decisionNote: null } }),
        "approve crew_dispatch",
      );

      // ── 7. The task flipped to standard (dispatchable) ────────────────────────
      const after = await poll<CrewIssue[], CrewIssue[]>(
        async () =>
          jsonOrThrow<CrewIssue[]>(
            await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
            "list crew issues (after)",
          ),
        (issues): issues is CrewIssue[] => issues.find((i) => i.id === dispatchedTaskId)?.workMode === "standard",
        "crew task flipped to standard after approve",
        30_000,
      );
      expect(after.find((i) => i.id === dispatchedTaskId)?.workMode).toBe("standard");
    },
  );
});

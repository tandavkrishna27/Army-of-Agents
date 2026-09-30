// JOB-014 — task-output + run-summary + terminal-winner parity (embedded PG; Linux CI is
// the formal authority, SKIPPED locally on Windows unless AOA_RUN_WIN_INTEGRATION=1).
//
// The bridge projects an ACCEPTED output event into the EXISTING `task_outputs` contract
// (+ an `output_projection` receipt) and the TERMINAL WINNER into `completeAttempt` +
// (optional) a run-summary `issue_comments` row (+ a `task_terminal` receipt), each in ONE
// tenant transaction, EXACTLY ONCE. Two independent entrypoints, two receipt kinds:
//   * projectAcceptedOutput — attempt stays running; replay guarded by the output receipt.
//   * projectTerminalWinner — receipt fast-path BEFORE completeAttempt; a loser cannot
//     change terminal state; a null-issue/opt-out winner still replay-guards via a
//     job_attempts receipt. The bridge NEVER elects primary and NEVER fabricates task IDs.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SubmitJobSource } from "@armyofagents/shared";
import {
  setupJobControlFixture,
  COMPANY,
  ORG,
  type JobControlFixture,
} from "./helpers/job-control-fixture.js";
import { runInTenant } from "../db/tenant-context.js";
import {
  jobOutputBridge,
  JobOutputBridgeDisabledError,
  JobOutputBridgeRollbackPendingError,
  type BridgeActor,
  type BridgeOutputInput,
  type TerminalSummaryInput,
} from "../services/job-output-bridge.js";

const ENABLED_ENV = { AOA_DISTRIBUTED_EXECUTION_ENABLED: "true" } as const;
const AGENT = "a7000000-0000-4000-8000-0000000000e1";
const USER = "job014-user";
const ISSUE = "a7000000-0000-4000-8000-0000000000f1";
const DIGEST = "b".repeat(64);
const actor: BridgeActor = { kind: "user", id: USER, companyId: COMPANY };

let fixture: JobControlFixture | null = null;
let setupError: unknown = null;

function bridge(env: Record<string, string | undefined> = ENABLED_ENV) {
  return jobOutputBridge(fixture!.app.db, { env });
}
function guard(): void {
  if (setupError) throw new Error(`fixture setup failed: ${String(setupError)}`);
}
async function count(table: string, where: string): Promise<number> {
  const [row] = await fixture!.admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`);
  return (row as { n: number }).n;
}
async function attemptStatus(attemptId: string): Promise<string | null> {
  const [row] = await fixture!.admin.unsafe(`SELECT status FROM job_attempts WHERE id = '${attemptId}'`);
  return (row as { status: string } | undefined)?.status ?? null;
}

const TASK_SOURCE: SubmitJobSource = { kind: "task_run", runId: randomUUID(), issueId: ISSUE, assigneeAgentId: AGENT };
const CREW_SOURCE: SubmitJobSource = { kind: "crew_run", crewRunId: randomUUID() };
const COMMANDER_SOURCE: SubmitJobSource = { kind: "commander_turn", internalAgentRunId: randomUUID(), conversationId: randomUUID() };
const ONE_SHOT_SOURCE: SubmitJobSource = { kind: "one_shot", operationId: randomUUID(), operationKind: "extraction" };
const BROWSER_SOURCE: SubmitJobSource = { kind: "browser_request", browserRequestId: randomUUID(), parentJobId: null };
const SERVICE_SOURCE: SubmitJobSource = { kind: "service_reconcile", serviceId: randomUUID(), generation: 1, reconciliationId: randomUUID() };

function outputInput(overrides: Partial<BridgeOutputInput> = {}): BridgeOutputInput {
  return {
    type: "external_link",
    title: "J014 output",
    url: "https://example.test/out",
    createdByAgentId: AGENT,
    ...overrides,
  };
}
function summaryInput(overrides: Partial<TerminalSummaryInput> = {}): TerminalSummaryInput {
  return {
    agentName: "J014 Agent",
    runtimeConfig: {},
    durationMs: 12_000,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.02,
    errorMessage: null,
    detectedFiles: [],
    ...overrides,
  };
}

beforeAll(async () => {
  try {
    fixture = await setupJobControlFixture("job014-parity");
    await fixture.admin`INSERT INTO agents (id, company_id, name, kind, status, adapter_type, adapter_config)
      VALUES (${AGENT}, ${COMPANY}, 'J014 Agent', 'org', 'idle', 'claude_local', ${fixture.admin.json({})})`;
    await fixture.admin`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (${USER}, 'J014 User', 'j014@example.test', true, now(), now())`;
    await fixture.admin`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
      VALUES (${COMPANY}, 'user', ${USER}, 'active', 'owner')`;
    await fixture.admin`INSERT INTO issues (id, company_id, title) VALUES (${ISSUE}, ${COMPANY}, 'J014 Task')`;
  } catch (error) {
    setupError = error;
  }
}, 180_000);

afterAll(async () => {
  await fixture?.teardown().catch(() => {});
}, 60_000);

beforeEach(async () => {
  if (!fixture) return;
  await fixture.admin`DELETE FROM task_outputs`;
  await fixture.admin`DELETE FROM issue_comments`;
});

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "JOB-014 task-output + run-summary + terminal-winner parity",
  () => {
    // 1 --------------------------------------------------------------------
    it("[output accepted] writes one task_output (isPrimary false, review none) + an applied output_projection receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(1);
      const out = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput(),
      });
      expect(out.status).toBe("recorded");
      expect(out.outputId).toBeTruthy();
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(1);
      const [row] = await fixture!.admin`SELECT is_primary, review_state FROM task_outputs WHERE issue_id = ${ISSUE}`;
      expect((row as { is_primary: boolean }).is_primary).toBe(false);
      expect((row as { review_state: string }).review_state).toBe("none");
      expect(await count("job_projection_receipts", `projection_kind = 'output_projection' AND status = 'applied'`)).toBe(1);
      const [receipt] = await fixture!.admin`SELECT target_aggregate_id, aggregate_kind
        FROM job_projection_receipts WHERE projection_kind = 'output_projection'`;
      expect((receipt as { target_aggregate_id: string }).target_aggregate_id).toBe(out.outputId);
      expect((receipt as { aggregate_kind: string }).aggregate_kind).toBe("task_outputs");
    });

    // 2 --------------------------------------------------------------------
    it("[duplicate provider identity] same provider+externalId across distinct events UPDATES in place (one row)", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(2);
      const provider = "github";
      const externalId = "pr-42";
      const first = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "pull_request", provider, externalId, title: "PR v1" }),
      });
      const second = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "pull_request", provider, externalId, title: "PR v2" }),
      });
      expect(first.status).toBe("recorded");
      expect(second.status).toBe("recorded");
      // The task_outputs (company, issue, provider, externalId) partial unique folds the two.
      expect(await count("task_outputs", `issue_id = '${ISSUE}' AND provider = '${provider}'`)).toBe(1);
      const [row] = await fixture!.admin`SELECT title FROM task_outputs WHERE issue_id = ${ISSUE} AND provider = ${provider}`;
      expect((row as { title: string }).title).toBe("PR v2");
    });

    // 3 --------------------------------------------------------------------
    it("[output replay] same acceptedEventId twice → recorded then replayed, one row, one receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(3);
      const acceptedEventId = randomUUID();
      const open = {
        source: TASK_SOURCE, actor, fence, acceptedEventId, eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput(),
      };
      const first = await bridge().projectAcceptedOutput(open);
      const second = await bridge().projectAcceptedOutput(open);
      expect(first.status).toBe("recorded");
      expect(second.status).toBe("replayed");
      expect(second.outputId).toBe(first.outputId);
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'output_projection'`)).toBe(1);
    });

    // 4 --------------------------------------------------------------------
    it("[review/primary contract] needs_review output does NOT clear a pre-seeded sibling primary", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(4);
      // Pre-seed a sibling PRIMARY output (admin) on the same issue.
      const siblingId = randomUUID();
      await fixture!.admin`INSERT INTO task_outputs (id, company_id, issue_id, type, provider, title, is_primary)
        VALUES (${siblingId}, ${COMPANY}, ${ISSUE}, 'external_link', 'aoa', 'primary sibling', true)`;
      const out = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "detected_file", reviewState: "needs_review", title: "detected" }),
      });
      expect(out.status).toBe("recorded");
      const [row] = await fixture!.admin`SELECT review_state, is_primary FROM task_outputs WHERE id = ${out.outputId}`;
      expect((row as { review_state: string }).review_state).toBe("needs_review");
      expect((row as { is_primary: boolean }).is_primary).toBe(false);
      // The bridge never sets isPrimary, so clearSiblingPrimaries never runs — sibling stays primary.
      const [sib] = await fixture!.admin`SELECT is_primary FROM task_outputs WHERE id = ${siblingId}`;
      expect((sib as { is_primary: boolean }).is_primary).toBe(true);
    });

    // 5 --------------------------------------------------------------------
    it("[terminal winner — success] posts one run-summary comment + a task_terminal receipt; attempt terminal", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(5);
      const out = await bridge().projectTerminalWinner({
        source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
        attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: ISSUE, summary: summaryInput(),
      });
      expect(out.status).toBe("recorded");
      expect(out.attemptTerminated).toBe(true);
      expect(out.commentId).toBeTruthy();
      expect(await count("issue_comments", `issue_id = '${ISSUE}' AND author_type = 'system'`)).toBe(1);
      const [c] = await fixture!.admin`SELECT presentation FROM issue_comments WHERE issue_id = ${ISSUE}`;
      expect((c as { presentation: { tone: string } }).presentation.tone).toBe("success");
      expect(await count("job_projection_receipts", `projection_kind = 'task_terminal' AND status = 'applied'`)).toBe(1);
      const [receipt] = await fixture!.admin`SELECT target_aggregate_id, aggregate_kind
        FROM job_projection_receipts WHERE projection_kind = 'task_terminal'`;
      expect((receipt as { target_aggregate_id: string }).target_aggregate_id).toBe(out.commentId);
      expect((receipt as { aggregate_kind: string }).aggregate_kind).toBe("issue_comments");
      expect(await attemptStatus(fence.attemptId)).toBe("succeeded");
    });

    // 6 --------------------------------------------------------------------
    it("[every terminal] failed/cancelled/dead_letter→failed/expired→timed_out each post one comment with the right tone", async () => {
      guard();
      const cases: Array<{ ord: number; attempt: "failed" | "cancelled" | "expired"; outcome: "failed" | "cancelled" | "timed_out"; tone: string }> = [
        { ord: 60, attempt: "failed", outcome: "failed", tone: "danger" },
        { ord: 61, attempt: "cancelled", outcome: "cancelled", tone: "info" },
        { ord: 62, attempt: "failed", outcome: "failed", tone: "danger" },   // dead_letter → failed
        { ord: 63, attempt: "expired", outcome: "timed_out", tone: "danger" },
      ];
      for (const c of cases) {
        await fixture!.admin`DELETE FROM issue_comments`;
        const { identity: fence } = await fixture!.activateLease(c.ord);
        const out = await bridge().projectTerminalWinner({
          source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
          attemptTerminalStatus: c.attempt, summaryOutcome: c.outcome, issueId: ISSUE,
          summary: summaryInput({ errorMessage: c.outcome === "failed" ? "boom" : null }),
        });
        expect(out.status).toBe("recorded");
        expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(1);
        const [comment] = await fixture!.admin`SELECT presentation FROM issue_comments WHERE issue_id = ${ISSUE}`;
        expect((comment as { presentation: { tone: string } }).presentation.tone).toBe(c.tone);
        expect(await count("job_projection_receipts", `projection_kind = 'task_terminal' AND status = 'applied'`)).toBe(1);
        expect(await attemptStatus(fence.attemptId)).toBe(c.attempt);
      }
    });

    // 7 --------------------------------------------------------------------
    it("[terminal replay / winner-retry] same terminalEventId twice → recorded then replayed; one comment, one receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(7);
      const terminalEventId = randomUUID();
      const open = {
        source: TASK_SOURCE, actor, fence, terminalEventId, eventDigest: DIGEST,
        attemptTerminalStatus: "succeeded" as const, summaryOutcome: "succeeded" as const, issueId: ISSUE, summary: summaryInput(),
      };
      const first = await bridge().projectTerminalWinner(open);
      const second = await bridge().projectTerminalWinner(open);
      expect(first.status).toBe("recorded");
      expect(first.attemptTerminated).toBe(true);
      expect(second.status).toBe("replayed");
      expect(second.attemptTerminated).toBe(false);
      expect(second.commentId).toBe(first.commentId);
      expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'task_terminal'`)).toBe(1);
    });

    // 8 --------------------------------------------------------------------
    it("[losing winner] a DIFFERENT terminalEventId on an already-terminal attempt rejects and changes nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(8);
      const winner = await bridge().projectTerminalWinner({
        source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
        attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: ISSUE, summary: summaryInput(),
      });
      expect(winner.status).toBe("recorded");
      await expect(
        bridge().projectTerminalWinner({
          source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
          attemptTerminalStatus: "failed", summaryOutcome: "failed", issueId: ISSUE, summary: summaryInput(),
        }),
      ).rejects.toThrow();
      expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(1);
      expect(await count("job_projection_receipts", `projection_kind = 'task_terminal'`)).toBe(1);
      expect(await attemptStatus(fence.attemptId)).toBe("succeeded");
    });

    // 9 --------------------------------------------------------------------
    it("[quarantine output] writes metadata.quarantined, isPrimary false, no comment, no terminal receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(9);
      const out = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "detected_file", title: "stale" }),
        quarantine: { reason: "stale_fence" },
      });
      expect(out.status).toBe("recorded");
      const [row] = await fixture!.admin`SELECT is_primary, metadata FROM task_outputs WHERE id = ${out.outputId}`;
      expect((row as { is_primary: boolean }).is_primary).toBe(false);
      expect((row as { metadata: { quarantined?: boolean; quarantineReason?: string } }).metadata.quarantined).toBe(true);
      expect((row as { metadata: { quarantineReason?: string } }).metadata.quarantineReason).toBe("stale_fence");
      expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'task_terminal'`)).toBe(0);
      expect(await attemptStatus(fence.attemptId)).not.toBe("succeeded");
    });

    // 10 -------------------------------------------------------------------
    it("[six-source projections] task/crew resolve to an issue; commander/one_shot/browser/service pass issueId null and mint no task rows", async () => {
      guard();
      // task_run + crew_run: caller resolves the issue → output written.
      for (const source of [TASK_SOURCE, CREW_SOURCE]) {
        const { identity: fence } = await fixture!.activateLease(source === TASK_SOURCE ? 100 : 101);
        // activateLease resets receipts + task_outputs is cleared in beforeEach only, so clear here.
        await fixture!.admin`DELETE FROM task_outputs`;
        const out = await bridge().projectAcceptedOutput({
          source, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
          issueId: ISSUE, output: outputInput(),
        });
        expect(out.status).toBe("recorded");
        expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(1);
      }
      // null-issue sources: output SKIPPED (no fabricated task IDs); terminal winner writes a
      // job_attempts receipt but no comment.
      const nullIssueSources: SubmitJobSource[] = [COMMANDER_SOURCE, ONE_SHOT_SOURCE, BROWSER_SOURCE, SERVICE_SOURCE];
      let ord = 102;
      for (const source of nullIssueSources) {
        const { identity: fence } = await fixture!.activateLease(ord++);
        await fixture!.admin`DELETE FROM task_outputs`;
        await fixture!.admin`DELETE FROM issue_comments`;
        const skipped = await bridge().projectAcceptedOutput({
          source, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
          issueId: null, output: outputInput(),
        });
        expect(skipped.status).toBe("skipped");
        expect(skipped.outputId).toBeNull();
        expect(await count("task_outputs", `company_id = '${COMPANY}'`)).toBe(0);

        const term = await bridge().projectTerminalWinner({
          source, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
          attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: null,
        });
        expect(term.status).toBe("recorded");
        expect(term.commentId).toBeNull();
        expect(await count("issue_comments", `company_id = '${COMPANY}'`)).toBe(0);
        const [receipt] = await fixture!.admin`SELECT aggregate_kind, target_aggregate_id
          FROM job_projection_receipts WHERE projection_kind = 'task_terminal'`;
        expect((receipt as { aggregate_kind: string }).aggregate_kind).toBe("job_attempts");
        expect((receipt as { target_aggregate_id: string }).target_aggregate_id).toBe(fence.attemptId);
      }
    });

    // 11 -------------------------------------------------------------------
    it("[artifact commit ≠ output] a fenced artifact commit writes job_artifacts, never task_outputs", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(11);
      // Drive the ordinary fenced artifact commit directly via the leasing repo seam.
      await runInTenant(fixture!.app.db, ORG, async (repos) => {
        await repos.jobControl.authorizeArtifactCommit({ ...fence, identifier: "artifact-1" });
      });
      expect(await count("job_artifacts", `job_id = '${fence.jobId}'`)).toBe(1);
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(0);
    });

    // 12 -------------------------------------------------------------------
    it("[rollback publishes nothing] a mid-tx ref failure rolls back the output + its receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(12);
      await expect(
        bridge().projectAcceptedOutput({
          source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
          issueId: ISSUE, output: outputInput({ createdByAgentId: randomUUID() }), // no such agent → notFound mid-tx
        }),
      ).rejects.toThrow();
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(0);
      expect(await count("job_projection_receipts", `projection_kind = 'output_projection'`)).toBe(0);
    });

    // 13 -------------------------------------------------------------------
    it("[opt-out] autoRunSummary=false skips the comment but still terminates + writes a job_attempts receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(13);
      const out = await bridge().projectTerminalWinner({
        source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
        attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: ISSUE,
        summary: summaryInput({ runtimeConfig: { autoRunSummary: false } }),
      });
      expect(out.status).toBe("recorded");
      expect(out.attemptTerminated).toBe(true);
      expect(out.commentId).toBeNull();
      expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(0);
      expect(await attemptStatus(fence.attemptId)).toBe("succeeded");
      const [receipt] = await fixture!.admin`SELECT aggregate_kind FROM job_projection_receipts WHERE projection_kind = 'task_terminal'`;
      expect((receipt as { aggregate_kind: string }).aggregate_kind).toBe("job_attempts");
    });

    // 14 -------------------------------------------------------------------
    it("[rollback gate] a pending output/terminal receipt makes assertRollbackSafe fail closed; flipping to applied resolves", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(14);
      await fixture!.admin`INSERT INTO job_projection_receipts
        (organization_id, company_id, projection_kind, source_identity, source_digest, job_id, attempt_id, source_fence, status, target_aggregate_id, aggregate_kind, applied_at)
        VALUES (${ORG}, ${COMPANY}, 'output_projection', ${`output:${COMPANY}:${randomUUID()}`}, ${DIGEST}, ${fence.jobId}, ${fence.attemptId}, ${fence.fence}, 'pending', ${randomUUID()}, 'task_outputs', NULL)`;
      await expect(bridge().assertRollbackSafe(COMPANY)).rejects.toBeInstanceOf(JobOutputBridgeRollbackPendingError);
      await fixture!.admin`UPDATE job_projection_receipts SET status = 'applied', applied_at = now()
        WHERE projection_kind = 'output_projection' AND status = 'pending'`;
      await expect(bridge().assertRollbackSafe(COMPANY)).resolves.toBeUndefined();
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(0);
    });

    // 15 -------------------------------------------------------------------
    it("[flag off] every entrypoint refuses fail-closed and touches nothing", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(15);
      const disabled = bridge({});
      expect(disabled.isEnabled()).toBe(false);
      await expect(
        disabled.projectAcceptedOutput({
          source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
          issueId: ISSUE, output: outputInput(),
        }),
      ).rejects.toBeInstanceOf(JobOutputBridgeDisabledError);
      await expect(
        disabled.projectTerminalWinner({
          source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
          attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: ISSUE, summary: summaryInput(),
        }),
      ).rejects.toBeInstanceOf(JobOutputBridgeDisabledError);
      expect(await count("task_outputs", `issue_id = '${ISSUE}'`)).toBe(0);
      expect(await count("issue_comments", `issue_id = '${ISSUE}'`)).toBe(0);
      expect(await count("job_projection_receipts", `company_id = '${COMPANY}'`)).toBe(0);
    });

    // 16 -------------------------------------------------------------------
    it("[rollback before/after accepted artifact] the gate resolves with no pending receipt, rejects only on pending", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(16);
      // (a) no in-flight receipt → resolves.
      await expect(bridge().assertRollbackSafe(COMPANY)).resolves.toBeUndefined();
      // (b) an accepted (applied) output committed → still resolves (applied, not pending).
      await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput(),
      });
      await expect(bridge().assertRollbackSafe(COMPANY)).resolves.toBeUndefined();
      // (c) a forced PENDING task_terminal receipt → rejects.
      await fixture!.admin`INSERT INTO job_projection_receipts
        (organization_id, company_id, projection_kind, source_identity, source_digest, job_id, attempt_id, source_fence, status, target_aggregate_id, aggregate_kind, applied_at)
        VALUES (${ORG}, ${COMPANY}, 'task_terminal', ${`task_terminal:${COMPANY}:${randomUUID()}`}, ${DIGEST}, ${fence.jobId}, ${fence.attemptId}, ${fence.fence}, 'pending', ${fence.attemptId}, 'job_attempts', NULL)`;
      await expect(bridge().assertRollbackSafe(COMPANY)).rejects.toBeInstanceOf(JobOutputBridgeRollbackPendingError);
    });

    // 17 (post-review regression) ------------------------------------------
    it("[terminal summary failure] a bad issue does NOT roll back the mandatory completeAttempt; falls back to a job_attempts receipt", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(20);
      // An issueId that is NOT a real issue → insertRunSummaryComment's FK (issue_comments.issue_id
      // → issues) fails. The SAVEPOINT must isolate it so completeAttempt is NOT rolled back.
      const missingIssue = randomUUID();
      const out = await bridge().projectTerminalWinner({
        source: TASK_SOURCE, actor, fence, terminalEventId: randomUUID(), eventDigest: DIGEST,
        attemptTerminalStatus: "succeeded", summaryOutcome: "succeeded", issueId: missingIssue, summary: summaryInput(),
      });
      expect(out.status).toBe("recorded");
      expect(out.attemptTerminated).toBe(true);
      expect(out.commentId).toBeNull();
      expect(await count("issue_comments", `issue_id = '${missingIssue}'`)).toBe(0);
      // The MANDATORY completion survived the optional-comment failure.
      const [att] = await fixture!.admin`SELECT status FROM job_attempts WHERE id = ${fence.attemptId}`;
      expect((att as { status: string }).status).toBe("succeeded");
      // The winner is still replay-guarded via a job_attempts receipt (not issue_comments).
      const [rec] = await fixture!.admin`SELECT aggregate_kind, target_aggregate_id FROM job_projection_receipts WHERE projection_kind = 'task_terminal'`;
      expect((rec as { aggregate_kind: string }).aggregate_kind).toBe("job_attempts");
      expect((rec as { target_aggregate_id: string }).target_aggregate_id).toBe(fence.attemptId);
    });

    // 18 (post-review regression) ------------------------------------------
    it("[no primary demotion] a re-delivered/quarantine output does NOT demote a founder-elected primary", async () => {
      guard();
      const { identity: fence } = await fixture!.activateLease(21);
      const provider = "github";
      const externalId = "pr-primary";
      const first = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "pull_request", provider, externalId, title: "PR" }),
      });
      // A founder promotes the output to primary.
      await fixture!.admin`UPDATE task_outputs SET is_primary = true WHERE id = ${first.outputId}`;
      // A later same-identity re-delivery (quarantined) must NOT demote the primary.
      const second = await bridge().projectAcceptedOutput({
        source: TASK_SOURCE, actor, fence, acceptedEventId: randomUUID(), eventDigest: DIGEST,
        issueId: ISSUE, output: outputInput({ type: "pull_request", provider, externalId, title: "PR merged" }),
        quarantine: { reason: "stale_fence" },
      });
      expect(second.status).toBe("recorded");
      const [row] = await fixture!.admin`SELECT is_primary, title FROM task_outputs WHERE id = ${first.outputId}`;
      expect((row as { is_primary: boolean }).is_primary).toBe(true);
      expect((row as { title: string }).title).toBe("PR merged");
    });
  },
);

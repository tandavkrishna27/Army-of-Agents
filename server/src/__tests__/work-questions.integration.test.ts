import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { runningProcesses, spawnTrackedChild } from "@armyofagents/adapter-utils/server-utils";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  applyPendingMigrations,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  discussions,
  executionWorkspaces,
  heartbeatRuns,
  hubItems,
  internalAgentRuns,
  issues,
  projects,
  userRoles,
  workQuestionContinuationRequests,
  workQuestions,
  type Db,
} from "@armyofagents/db";
import { workQuestionContinuationService } from "../services/work-question-continuations.js";
import { workQuestionService } from "../services/work-questions.js";
import { workQuestionSlaService } from "../services/work-question-sla.js";
import { issueService } from "../services/issues.js";
import {
  bindHeartbeatWorkQuestionContinuation,
  bindInternalAgentWorkQuestionContinuation,
} from "../services/work-question-continuation-terminal.js";
import { recoverExpiredCrewWakeup } from "../services/internal-agent/aoa-agents/dispatcher.js";
import { askHumanForActiveRun } from "../mcp/tools/ask-founder-tool.js";

// Embedded-postgres harness (matches the other *.integration.test.ts files). The
// beforeAll below boots its own throwaway cluster, so these tests run in the
// required Linux `verify` gate with NO external DATABASE_URL. Previously the
// suite ran only when TEST_DATABASE_URL/DATABASE_URL was set and was skipped
// otherwise — and because CI's verify job provides neither, it SILENTLY SKIPPED
// all 22 tests and showed green (the fail-open blind spot the
// integration-test-hygiene guard now catches). The beforeAll is inside the win32-skipped
// describe, so on Windows the whole suite (boot included) skips per Issue #114,
// and on Linux a boot failure throws and reddens the suite (fail-closed).
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";

// To run locally on Windows, temporarily flip this to `describe.skipIf(false)`.
describe.skipIf(process.platform === "win32")("durable work questions (real PostgreSQL)", () => {
  let db: Db;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const issueId = randomUUID();
  const projectId = randomUUID();
  const discussionId = randomUUID();
  const workspaceId = randomUUID();
  const userId = `work-question-${randomUUID()}`;

  function continuationWorker() {
    return workQuestionContinuationService(db, {
      enqueueHeartbeat: async (input, executor = db) => {
        const existing = await executor.select({ runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, input.companyId),
            eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
          ))
          .then((rows) => rows.find((row) => row.runId) ?? null);
        if (existing?.runId) return { id: existing.runId };

        const wakeup = await executor.insert(agentWakeupRequests).values({
            companyId: input.companyId,
            agentId: input.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: "work_question_continuation",
            payload: input,
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: "work-question-continuation-test",
            idempotencyKey: input.idempotencyKey,
          }).returning().then((rows) => rows[0]);
        const run = await executor.insert(heartbeatRuns).values({
            companyId: input.companyId,
            agentId: input.agentId,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "queued",
            wakeupRequestId: wakeup.id,
            contextSnapshot: { issueId: input.issueId, questionId: input.questionId },
          }).returning().then((rows) => rows[0]);
        await executor.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wakeup.id));
        return run;
      },
    });
  }

  async function createCrewContinuationFixture(label: string) {
    const crewAgentId = randomUUID();
    const crewIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: `${label} Crew`,
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: originRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
    });
    await db.insert(issues).values({
      id: crewIssueId,
      companyId,
      projectId,
      title: `${label} continuation task`,
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: originRunId,
      executionRunId: originRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: crewIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId: originRunId,
      title: `${label} question`,
      question: `How should ${label} continue?`,
      blocking: true,
    });
    await db.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
      .where(eq(internalAgentRuns.id, originRunId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Continue with the verified choice." },
      expectedVersion: 0,
      idempotencyKey: `${label}-${randomUUID()}`,
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) })
      .where(eq(workQuestionContinuationRequests.questionId, question.id));
    await workQuestionContinuationService(db).processDue(new Date(), 10);
    const continuationKey = `work-question:${question.id}:answer:1`;
    const wakeup = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, continuationKey))
      .then((rows) => rows[0]);
    return { crewAgentId, crewIssueId, originRunId, question, continuationKey, wakeup };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-work-questions-integ-"));
    // Probe for a genuinely-free port (vitest runs these files in parallel and
    // sibling suites use overlapping fixed random ranges — see the helper).
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      // Force UTF-8 so migration SQL with non-Latin1 chars (e.g. '→' in a
      // comment) applies regardless of the host locale.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Work Question Integration",
      issuePrefix: `WQ${Math.floor(Math.random() * 9000 + 1000)}`,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Question Owner",
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(userRoles).values({ companyId, userId, role: "founder" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Agent",
      role: "research",
      kind: "org",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Product Research",
      type: "department",
      status: "in_progress",
    });
    await db.insert(discussions).values({
      id: discussionId,
      companyId,
      title: "Launch evidence strategy",
      scopeType: "department",
      scopeId: projectId,
      createdBy: userId,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: null,
      threadId: discussionId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "launch-evidence-thread",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Choose interview sample",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: userId,
      checkoutRunId: runId,
      sourceDiscussionId: discussionId,
      acceptanceCriteria: ["Document the selected sample"],
    });
  }, 180_000);

  afterAll(async () => {
    // Throwaway cluster — stop it and drop its data dir; no per-row cleanup needed.
    await pg?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("commits one answer and one continuation request, then relays idempotently", async () => {
    const service = workQuestionService(db);
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Which interview sample should we use?",
      question: "Choose five deep interviews or twelve short interviews.",
      options: [
        { label: "Five deep", value: "five" },
        { label: "Twelve short", value: "twelve" },
      ],
      blocking: true,
    });
    expect(question.issueTitleSnapshot).toBe("Choose interview sample");
    expect(question.askingAgentNameSnapshot).toBe("Research Agent");
    expect(question.currentRecipientUserId).toBe(userId);
    const openMirror = await db.select().from(hubItems).where(and(
      eq(hubItems.companyId, companyId),
      eq(hubItems.sourceType, "work_question"),
      eq(hubItems.sourceId, question.id),
    )).then((rows) => rows[0]);
    expect(openMirror).toMatchObject({
      semanticType: "work_question",
      status: "open",
      ownerUserId: userId,
      relatedEntityId: issueId,
    });

    const answered = await service.answer(companyId, question.id, { userId }, {
      answer: { selectedValues: ["five"] },
      expectedVersion: 0,
      idempotencyKey: "answer-once",
    });
    expect(answered).toMatchObject({ status: "answered", version: 1, continuationStatus: "pending" });
    const repeated = await service.answer(companyId, question.id, { userId }, {
      answer: { selectedValues: ["five"] },
      expectedVersion: 0,
      idempotencyKey: "answer-once",
    });
    expect(repeated.id).toBe(answered.id);

    const requests = await db.select().from(workQuestionContinuationRequests).where(eq(
      workQuestionContinuationRequests.questionId,
      question.id,
    ));
    expect(requests).toHaveLength(1);
    expect(requests[0].downstreamIdempotencyKey).toBe(`work-question:${question.id}:answer:1`);
    expect(requests[0].continuationEnvelope).toMatchObject({
      version: 1,
      task: {
        id: issueId,
        title: "Choose interview sample",
        acceptanceCriteria: ["Document the selected sample"],
      },
      question: { id: question.id, text: "Choose five deep interviews or twelve short interviews." },
      answer: { value: { selectedValues: ["five"] }, version: 1, responderUserId: userId },
      provenance: {
        originatingRunKind: "heartbeat",
        originatingRunId: runId,
        executionWorkspaceId: null,
        sourceDiscussionId: discussionId,
      },
    });

    const relayed = await service.markRelayed(companyId, question.id, 1);
    expect(relayed).toMatchObject({ continuationStatus: "dispatched", continuationRunId: runId, version: 2 });
    const cancelledRequest = await db.select().from(workQuestionContinuationRequests).where(eq(
      workQuestionContinuationRequests.id,
      requests[0].id,
    )).then((rows) => rows[0]);
    expect(cancelledRequest.status).toBe("cancelled");
    const closedMirror = await db.select().from(hubItems).where(eq(hubItems.id, openMirror.id)).then((rows) => rows[0]);
    expect(closedMirror.status).toBe("archived");
  });

  it("accepts the shared workspace owned by the task's source Discussion", async () => {
    const question = await workQuestionService(db).create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      executionWorkspaceId: workspaceId,
      sourceDiscussionId: discussionId,
      title: "Depth or breadth?",
      question: "Which evidence strategy should drive the launch?",
      blocking: true,
    });

    expect(question).toMatchObject({
      issueId,
      executionWorkspaceId: workspaceId,
      sourceDiscussionId: discussionId,
    });
  });

  it("deduplicates producer retries and rejects invocation-content conflicts", async () => {
    const service = workQuestionService(db);
    const baseInput = {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat" as const,
      originatingRunId: runId,
      producerInvocationId: "provider-tool-call-42",
      title: "Choose the evidence threshold",
      question: "Should the threshold be three or five interviews?",
      context: { constraints: { budget: "fixed", timeline: "two weeks" } },
      blocking: true,
    };

    const first = await service.create(companyId, baseInput);
    const transportRetry = await service.create(companyId, baseInput);
    const reconnectRetry = await service.create(companyId, {
      ...baseInput,
      producerInvocationId: "provider-tool-call-after-reconnect",
    });

    expect(transportRetry.id).toBe(first.id);
    expect(reconnectRetry.id).toBe(first.id);
    await expect(service.create(companyId, {
      ...baseInput,
      question: "Should the threshold be seven interviews?",
    })).rejects.toThrow(/reused with different question content/i);

    const persisted = await db.select().from(workQuestions).where(and(
      eq(workQuestions.companyId, companyId),
      eq(workQuestions.producerPayloadFingerprint, first.producerPayloadFingerprint!),
      eq(workQuestions.status, "open"),
    ));
    expect(persisted).toHaveLength(1);
  });

  it("dispatches a late answer through one idempotent wakeup", async () => {
    const service = workQuestionService(db);
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Choose incentive cap",
      question: "Should the cap be 100 or 250?",
      blocking: true,
    });
    await service.answer(companyId, question.id, { userId }, {
      answer: { text: "Use 100." },
      expectedVersion: 0,
      idempotencyKey: "late-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) }).where(eq(
      workQuestionContinuationRequests.questionId,
      question.id,
    ));

    const worker = continuationWorker();
    const first = await worker.processDue(new Date(), 10);
    const second = await worker.processDue(new Date(), 10);
    expect(first).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    expect(second.claimed).toBe(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `work-question:${question.id}:answer:1`),
    ));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ reason: "work_question_continuation", status: "queued" });
    expect((wakeups[0].payload as Record<string, unknown>).continuationEnvelope).toMatchObject({
      version: 1,
      question: { id: question.id, text: "Should the cap be 100 or 250?" },
      answer: { value: { text: "Use 100." }, version: 1 },
    });
    const updated = await db.select().from(workQuestions).where(eq(workQuestions.id, question.id)).then((rows) => rows[0]);
    expect(updated).toMatchObject({
      continuationStatus: "dispatched",
      continuationRunKind: "heartbeat",
      continuationRunId: wakeups[0].runId,
    });
    const continuationRuns = await db.select().from(heartbeatRuns).where(eq(
      heartbeatRuns.id,
      updated.continuationRunId!,
    ));
    expect(continuationRuns).toHaveLength(1);

    await db.update(heartbeatRuns).set({
      status: "succeeded",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, updated.continuationRunId!));
    expect(await worker.reconcileHeartbeatTerminals()).toBe(1);
    const completed = await db.select().from(workQuestions).where(eq(
      workQuestions.id,
      question.id,
    )).then((rows) => rows[0]);
    expect(completed).toMatchObject({
      continuationStatus: "completed",
      continuationRunId: updated.continuationRunId,
      continuationError: null,
    });
    expect(await worker.reconcileHeartbeatTerminals()).toBe(0);
  });

  it("reclaims a continuation claim left stale by a crashed worker", async () => {
    const service = workQuestionService(db);
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Choose the launch cohort",
      question: "Should the first cohort contain five or ten companies?",
      blocking: true,
    });
    await service.answer(companyId, question.id, { userId }, {
      answer: { text: "Start with five." },
      expectedVersion: 0,
      idempotencyKey: "stale-claim-answer",
    });
    await db.update(workQuestionContinuationRequests).set({
      status: "claimed",
      claimedAt: new Date(Date.now() - 10 * 60 * 1000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 8 * 60 * 1000),
      nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(workQuestionContinuationRequests.questionId, question.id));

    const result = await continuationWorker().processDue(new Date(), 10);
    expect(result).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    const request = await db.select().from(workQuestionContinuationRequests)
      .where(eq(workQuestionContinuationRequests.questionId, question.id))
      .then((rows) => rows[0]);
    expect(request).toMatchObject({ status: "dispatched", claimToken: null, leaseExpiresAt: null });
  });

  it("prevents a stale continuation owner from mutating a reclaimed request", async () => {
    const service = workQuestionService(db);
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Choose the launch channel",
      question: "Should the first launch use email or partner outreach?",
      blocking: true,
    });
    await service.answer(companyId, question.id, { userId }, {
      answer: { text: "Use partner outreach." },
      expectedVersion: 0,
      idempotencyKey: "reclaimed-owner-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) }).where(eq(
      workQuestionContinuationRequests.questionId,
      question.id,
    ));

    const staleWorker = continuationWorker();
    const [staleClaim] = await staleWorker.claimDue(new Date(), 1);
    expect(staleClaim.claimToken).toBeTruthy();
    await db.update(workQuestionContinuationRequests).set({
      leaseExpiresAt: new Date(0),
    }).where(eq(workQuestionContinuationRequests.id, staleClaim.id));

    const currentWorker = continuationWorker();
    const [currentClaim] = await currentWorker.claimDue(new Date(), 1);
    expect(currentClaim.claimToken).toBeTruthy();
    expect(currentClaim.claimToken).not.toBe(staleClaim.claimToken);

    expect(await staleWorker.dispatch(staleClaim)).toMatchObject({ status: "cancelled" });
    const stillOwned = await db.select().from(workQuestionContinuationRequests)
      .where(eq(workQuestionContinuationRequests.id, staleClaim.id))
      .then((rows) => rows[0]);
    expect(stillOwned).toMatchObject({ status: "claimed", claimToken: currentClaim.claimToken });

    expect(await currentWorker.dispatch(currentClaim)).toMatchObject({ status: "dispatched" });
    const finalized = await db.select().from(workQuestionContinuationRequests)
      .where(eq(workQuestionContinuationRequests.id, staleClaim.id))
      .then((rows) => rows[0]);
    expect(finalized).toMatchObject({ status: "dispatched", claimToken: null, leaseExpiresAt: null });
  });

  it("defers a late answer behind an active task run instead of coalescing it", async () => {
    const service = workQuestionService(db);
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Choose the evidence threshold",
      question: "Is three confirmed interviews enough to continue?",
      blocking: true,
    });
    await service.answer(companyId, question.id, { userId }, {
      answer: { text: "Require five confirmed interviews." },
      expectedVersion: 0,
      idempotencyKey: "active-run-late-answer",
    });
    await db.update(workQuestionContinuationRequests).set({
      nextAttemptAt: new Date(0),
    }).where(eq(workQuestionContinuationRequests.questionId, question.id));

    const result = await workQuestionContinuationService(db).processDue(new Date(), 10);

    expect(result).toMatchObject({ claimed: 1, dispatched: 1, failed: 0 });
    const deferred = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `work-question:${question.id}:answer:1`),
    )).then((rows) => rows[0]);
    expect(deferred).toMatchObject({
      reason: "work_question_continuation",
      status: "deferred_issue_execution",
      runId: null,
    });
    const updated = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(updated).toMatchObject({
      continuationStatus: "dispatched",
      continuationRunKind: "heartbeat",
      continuationRunId: null,
    });

    const promotedRun = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: deferred.id,
      contextSnapshot: { issueId, questionId: question.id },
    }).returning().then((rows) => rows[0]);
    expect(await bindHeartbeatWorkQuestionContinuation(db, {
      companyId,
      runId: promotedRun.id,
      idempotencyKey: `work-question:${question.id}:answer:1`,
    })).toBe(question.id);
    const bound = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(bound.continuationRunId).toBe(promotedRun.id);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, promotedRun.id));
    expect(await workQuestionContinuationService(db).reconcileHeartbeatTerminals()).toBe(1);
    const completed = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(completed.continuationStatus).toBe("completed");
  });

  it("cancels the old agent's question when a task is reassigned", async () => {
    const replacementAgentId = randomUUID();
    const reassignedIssueId = randomUUID();
    const reassignedRunId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId,
      name: "Replacement Research Agent",
      role: "research",
      kind: "org",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(heartbeatRuns).values({
      id: reassignedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId: reassignedIssueId },
    });
    await db.insert(issues).values({
      id: reassignedIssueId,
      companyId,
      projectId,
      title: "Reassign interview analysis",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: userId,
      checkoutRunId: reassignedRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: reassignedIssueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: reassignedRunId,
      title: "Confirm the old agent's approach",
      question: "Should the original analysis continue?",
      blocking: true,
    });

    await issueService(db).update(
      reassignedIssueId,
      { assigneeAgentId: replacementAgentId },
      { actorType: "system" },
    );

    const [updated, mirror] = await Promise.all([
      db.select().from(workQuestions)
        .where(eq(workQuestions.id, question.id))
        .then((rows) => rows[0]),
      db.select().from(hubItems)
        .where(and(
          eq(hubItems.sourceType, "work_question"),
          eq(hubItems.sourceId, question.id),
        ))
        .then((rows) => rows[0]),
    ]);
    expect(updated).toMatchObject({
      status: "cancelled",
      continuationStatus: "not_needed",
    });
    expect(mirror.status).toBe("archived");
  });

  it("parks unsupported runtimes immediately and persists visible waiting state", async () => {
    const parkedRunId = randomUUID();
    const parkedIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: parkedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId: parkedIssueId },
    });
    await db.insert(issues).values({
      id: parkedIssueId,
      companyId,
      projectId,
      title: "Choose the launch cohort",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: userId,
      checkoutRunId: parkedRunId,
    });

    const result = await askHumanForActiveRun({
      db,
      companyId,
      agentId,
      runId: parkedRunId,
    }, {
      question: "Which cohort should launch first?",
      context: "The runtime cannot pause safely, so this run must park.",
    });

    const persistedRun = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, parkedRunId))
      .then((rows) => rows[0]);
    expect(result).toMatchObject({ answered: false, status: "parked" });
    expect(persistedRun).toMatchObject({
      livenessState: "waiting_on_human",
      livenessReason: "work_question",
      nextAction: `work_question:${result.questionId}`,
    });
  });

  it("parks a task-bound Crew question and dispatches exactly one Crew continuation", async () => {
    const crewAgentId = randomUUID();
    const crewRunId = randomUUID();
    const crewIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Product Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: crewRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
    });
    await db.insert(issues).values({
      id: crewIssueId,
      companyId,
      projectId,
      title: "Select pricing evidence",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: crewRunId,
      executionRunId: crewRunId,
      sourceDiscussionId: discussionId,
    });

    const parked = await askHumanForActiveRun({
      db,
      companyId,
      agentId: crewAgentId,
      runId: crewRunId,
      originatingRunKind: "internal_agent",
      producerInvocationId: "crew-product-question",
    }, {
      question: "Which pricing evidence should lead the recommendation?",
      context: "The Crew task cannot finish the recommendation without this choice.",
    });
    expect(parked).toMatchObject({ answered: false, status: "parked" });
    const question = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, parked.questionId))
      .then((rows) => rows[0]);
    expect(question).toMatchObject({
      issueId: crewIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId: crewRunId,
      status: "open",
    });

    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Lead with willingness-to-pay interviews." },
      expectedVersion: 0,
      idempotencyKey: "crew-answer-once",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) }).where(eq(
      workQuestionContinuationRequests.questionId,
      question.id,
    ));
    const first = await continuationWorker().processDue(new Date(), 10);
    const second = await continuationWorker().processDue(new Date(), 10);
    expect(first).toMatchObject({ dispatched: 1, failed: 0 });
    expect(second).toMatchObject({ dispatched: 0, failed: 0 });

    const wakeups = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.idempotencyKey, `work-question:${question.id}:answer:1`),
    ));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: crewAgentId,
      source: "work_question_continuation",
      reason: "work_question_continuation",
      status: "queued",
    });
    expect(wakeups[0].payload).toMatchObject({
      issueId: crewIssueId,
      questionId: question.id,
      answer: { text: "Lead with willingness-to-pay interviews." },
      continuationIdempotencyKey: `work-question:${question.id}:answer:1`,
    });
    const dispatched = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(dispatched).toMatchObject({
      continuationStatus: "dispatched",
      continuationRunKind: "internal_agent",
      continuationRunId: null,
    });

    const continuationRunId = randomUUID();
    await db.insert(internalAgentRuns).values({
      id: continuationRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "completed",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
      continuationIdempotencyKey: `work-question:${question.id}:answer:1`,
      completedAt: new Date(),
    });
    await bindInternalAgentWorkQuestionContinuation(db, {
      companyId,
      runId: continuationRunId,
      idempotencyKey: `work-question:${question.id}:answer:1`,
    });
    expect(await continuationWorker().reconcileInternalAgentTerminals()).toBe(1);
    const completed = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(completed).toMatchObject({
      continuationStatus: "completed",
      continuationRunKind: "internal_agent",
      continuationRunId,
      continuationError: null,
    });
    expect(await continuationWorker().reconcileInternalAgentTerminals()).toBe(0);
  });

  it("does not let a Crew continuation escape when its task closes during dispatch", async () => {
    const crewAgentId = randomUUID();
    const crewRunId = randomUUID();
    const crewIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Race-safe Product Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: crewRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
    });
    await db.insert(issues).values({
      id: crewIssueId,
      companyId,
      projectId,
      title: "Choose the launch evidence",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: crewRunId,
      executionRunId: crewRunId,
      sourceDiscussionId: discussionId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: crewIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId: crewRunId,
      title: "Choose the strongest signal",
      question: "Should the recommendation lead with interviews or conversion data?",
      blocking: true,
    });
    await db.update(internalAgentRuns).set({
      status: "completed",
      completedAt: new Date(),
    }).where(eq(internalAgentRuns.id, crewRunId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Lead with conversion data." },
      expectedVersion: 0,
      idempotencyKey: "crew-close-race-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) }).where(eq(
      workQuestionContinuationRequests.questionId,
      question.id,
    ));

    let releaseEnqueue!: () => void;
    const enqueueReleased = new Promise<void>((resolve) => { releaseEnqueue = resolve; });
    let markEnqueueEntered!: () => void;
    const enqueueEntered = new Promise<void>((resolve) => { markEnqueueEntered = resolve; });
    let enqueueUsesTaskTransaction = false;
    const worker = workQuestionContinuationService(db, {
      enqueueCrew: async (input, transactionDb?: Db) => {
        enqueueUsesTaskTransaction = Boolean(transactionDb);
        markEnqueueEntered();
        await enqueueReleased;
        const executor = transactionDb ?? db;
        const wakeup = await executor.insert(agentWakeupRequests).values({
          companyId: input.companyId,
          agentId: input.agentId,
          source: "work_question_continuation",
          triggerDetail: "system",
          reason: "work_question_continuation",
          payload: input,
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: "work-question-continuation-race-test",
          idempotencyKey: input.idempotencyKey,
        }).onConflictDoNothing().returning().then((rows) => rows[0] ?? null);
        return wakeup ? { id: wakeup.runId, wakeupRequestId: wakeup.id } : null;
      },
    });

    const dispatchPromise = worker.processDue(new Date(), 10);
    await enqueueEntered;
    const closePromise = issueService(db).update(
      crewIssueId,
      { status: "done" },
      { actorType: "system" },
    );
    if (!enqueueUsesTaskTransaction) await closePromise;
    releaseEnqueue();
    await Promise.all([dispatchPromise, closePromise]);

    const [requestAfter, questionAfter, wakeupAfter] = await Promise.all([
      db.select().from(workQuestionContinuationRequests)
        .where(eq(workQuestionContinuationRequests.questionId, question.id))
        .then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, question.id))
        .then((rows) => rows[0]),
      db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `work-question:${question.id}:answer:1`))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(requestAfter.status).toBe("cancelled");
    expect(questionAfter).toMatchObject({ status: "answered", continuationStatus: "not_needed" });
    expect(wakeupAfter?.status).toBe("cancelled");
  });

  it("keeps active Crew task locks while allowing a completed Crew run continuation to adopt", async () => {
    const crewAgentId = randomUUID();
    const activeRunId = randomUUID();
    const nextRunId = randomUUID();
    const crewIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Checkout Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: activeRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
    });
    await db.insert(issues).values({
      id: crewIssueId,
      companyId,
      projectId,
      title: "Preserve the active Crew lock",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      checkoutRunId: activeRunId,
      executionRunId: activeRunId,
    });

    await expect(issueService(db).checkout(
      crewIssueId,
      crewAgentId,
      ["todo", "backlog", "in_progress"],
      nextRunId,
    )).rejects.toMatchObject({ status: 409 });

    await db.update(internalAgentRuns).set({
      status: "completed",
      completedAt: new Date(),
    }).where(eq(internalAgentRuns.id, activeRunId));
    const adopted = await issueService(db).checkout(
      crewIssueId,
      crewAgentId,
      ["todo", "backlog", "in_progress"],
      nextRunId,
    );
    expect(adopted).toMatchObject({
      checkoutRunId: nextRunId,
      executionRunId: nextRunId,
    });
  });

  it("cancels the target heartbeat run when a continuation was coalesced onto it", async () => {
    const askingRunId = randomUUID();
    const activeRunId = randomUUID();
    const originalWakeupId = randomUUID();
    const coalescedIssueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: askingRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { issueId: coalescedIssueId },
    });
    await db.insert(issues).values({
      id: coalescedIssueId,
      companyId,
      projectId,
      title: "Cancel a coalesced continuation",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: userId,
      checkoutRunId: askingRunId,
      executionRunId: askingRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: coalescedIssueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: askingRunId,
      title: "Choose the final evidence",
      question: "Which evidence should lead the report?",
      blocking: true,
    });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, askingRunId));
    await db.insert(agentWakeupRequests).values({
      id: originalWakeupId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "queued",
      wakeupRequestId: originalWakeupId,
      contextSnapshot: { issueId: coalescedIssueId },
    });
    await db.update(agentWakeupRequests).set({ runId: activeRunId })
      .where(eq(agentWakeupRequests.id, originalWakeupId));
    await db.update(issues).set({ executionRunId: activeRunId })
      .where(eq(issues.id, coalescedIssueId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Lead with conversion evidence." },
      expectedVersion: 0,
      idempotencyKey: "coalesced-heartbeat-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) })
      .where(eq(workQuestionContinuationRequests.questionId, question.id));

    await workQuestionContinuationService(db).processDue(new Date(), 10);
    const continuationKey = `work-question:${question.id}:answer:1`;
    const coalescedWakeup = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, continuationKey))
      .then((rows) => rows[0]);
    expect(coalescedWakeup).toMatchObject({ status: "coalesced", runId: activeRunId });

    await issueService(db).update(coalescedIssueId, { status: "done" }, { actorType: "system" });
    const [runAfter, issueAfter] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, activeRunId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, coalescedIssueId)).then((rows) => rows[0]),
    ]);
    expect(runAfter).toMatchObject({ status: "cancelled", errorCode: "task_no_longer_eligible" });
    expect(issueAfter.executionRunId).toBeNull();
  });

  it("observes a terminal Crew run that wins while recovery waits for its row lock", async () => {
    const fixture = await createCrewContinuationFixture("terminal-lock-race");
    const terminalRunId = randomUUID();
    await db.insert(internalAgentRuns).values({
      id: terminalRunId,
      companyId,
      agentId: fixture.crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: fixture.crewIssueId,
      continuationIdempotencyKey: `${fixture.continuationKey}:crew-attempt:1`,
    });
    await db.update(issues).set({ checkoutRunId: terminalRunId, executionRunId: terminalRunId })
      .where(eq(issues.id, fixture.crewIssueId));
    await db.update(workQuestions).set({ continuationRunId: terminalRunId })
      .where(eq(workQuestions.id, fixture.question.id));
    await db.update(agentWakeupRequests).set({
      status: "processing",
      attempts: 1,
      runId: terminalRunId,
      claimedAt: new Date(Date.now() - 20 * 60_000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, fixture.wakeup.id));

    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    let finishRun!: () => void;
    const finish = new Promise<void>((resolve) => { finishRun = resolve; });
    const terminalizer = db.transaction(async (tx) => {
      await tx.select({ id: internalAgentRuns.id }).from(internalAgentRuns)
        .where(eq(internalAgentRuns.id, terminalRunId)).for("update");
      markLocked();
      await finish;
      await tx.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
        .where(eq(internalAgentRuns.id, terminalRunId));
    });
    await locked;
    const recovery = recoverExpiredCrewWakeup(db, {
      id: fixture.wakeup.id,
      companyId,
      agentId: fixture.crewAgentId,
      runId: terminalRunId,
      idempotencyKey: fixture.continuationKey,
      payload: { issueId: fixture.crewIssueId, questionId: fixture.question.id },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    finishRun();
    await terminalizer;
    await expect(recovery).resolves.toBe("terminal");
    const [wakeupAfter, questionAfter] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.wakeup.id)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, fixture.question.id)).then((rows) => rows[0]),
    ]);
    expect(wakeupAfter).toMatchObject({ status: "succeeded", runId: terminalRunId });
    expect(questionAfter).toMatchObject({ continuationStatus: "completed", continuationRunId: terminalRunId });
  });

  it("does not reuse a legacy base-key run after the first Crew attempt", async () => {
    const fixture = await createCrewContinuationFixture("legacy-attempt-fence");
    const legacyRunId = randomUUID();
    await db.insert(internalAgentRuns).values({
      id: legacyRunId,
      companyId,
      agentId: fixture.crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "completed",
      relatedEntityType: "task",
      relatedEntityId: fixture.crewIssueId,
      continuationIdempotencyKey: fixture.continuationKey,
      completedAt: new Date(),
    });
    await db.update(agentWakeupRequests).set({
      status: "processing",
      attempts: 2,
      runId: null,
      claimedAt: new Date(Date.now() - 20 * 60_000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, fixture.wakeup.id));

    await expect(recoverExpiredCrewWakeup(db, {
      id: fixture.wakeup.id,
      companyId,
      agentId: fixture.crewAgentId,
      runId: null,
      idempotencyKey: fixture.continuationKey,
      payload: { issueId: fixture.crewIssueId, questionId: fixture.question.id },
    })).resolves.toBe("requeued");
    const [wakeupAfter, questionAfter, legacyAfter] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fixture.wakeup.id)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, fixture.question.id)).then((rows) => rows[0]),
      db.select().from(internalAgentRuns).where(eq(internalAgentRuns.id, legacyRunId)).then((rows) => rows[0]),
    ]);
    expect(wakeupAfter).toMatchObject({ status: "queued", runId: null });
    expect(questionAfter).toMatchObject({ continuationStatus: "dispatched", continuationRunId: null });
    expect(legacyAfter.status).toBe("completed");
  });

  it("repairs an unbound terminal Crew continuation from the authoritative wakeup run", async () => {
    const fixture = await createCrewContinuationFixture("unbound-terminal-repair");
    const failedRunId = randomUUID();
    await db.insert(internalAgentRuns).values({
      id: failedRunId,
      companyId,
      agentId: fixture.crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "failed",
      relatedEntityType: "task",
      relatedEntityId: fixture.crewIssueId,
      continuationIdempotencyKey: `${fixture.continuationKey}:crew-attempt:1`,
      errorMessage: "bind transaction disconnected",
      completedAt: new Date(),
    });
    await db.update(agentWakeupRequests).set({
      status: "failed",
      attempts: 1,
      runId: failedRunId,
      finishedAt: new Date(),
      error: "bind transaction disconnected",
    }).where(eq(agentWakeupRequests.id, fixture.wakeup.id));

    expect(await workQuestionContinuationService(db).reconcileInternalAgentTerminals()).toBe(1);
    const questionAfter = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, fixture.question.id)).then((rows) => rows[0]);
    expect(questionAfter).toMatchObject({
      continuationStatus: "failed",
      continuationRunId: failedRunId,
      continuationError: "bind transaction disconnected",
    });
  });

  it("recovers an expired Crew wakeup and lets its replacement own the task", async () => {
    const crewAgentId = randomUUID();
    const originatingRunId = randomUUID();
    const crashedRunId = randomUUID();
    const replacementRunId = randomUUID();
    const crewIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Recoverable Product Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: originatingRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
    });
    await db.insert(issues).values({
      id: crewIssueId,
      companyId,
      projectId,
      title: "Recover a crashed Crew continuation",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: originatingRunId,
      executionRunId: originatingRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: crewIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId,
      title: "Choose a recovery path",
      question: "Should the retry continue with the saved context?",
      blocking: true,
    });
    await db.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
      .where(eq(internalAgentRuns.id, originatingRunId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Continue from the saved context." },
      expectedVersion: 0,
      idempotencyKey: "crew-recovery-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) })
      .where(eq(workQuestionContinuationRequests.questionId, question.id));
    await workQuestionContinuationService(db).processDue(new Date(), 10);
    const continuationKey = `work-question:${question.id}:answer:1`;
    const wakeup = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, continuationKey))
      .then((rows) => rows[0]);
    await db.insert(internalAgentRuns).values({
      id: crashedRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
      continuationIdempotencyKey: `${continuationKey}:crew-attempt:1`,
    });
    await db.update(agentWakeupRequests).set({
      status: "processing",
      runId: null,
      attempts: 1,
      claimedAt: new Date(Date.now() - 20 * 60_000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, wakeup.id));
    await db.update(issues).set({ checkoutRunId: crashedRunId, executionRunId: crashedRunId })
      .where(eq(issues.id, crewIssueId));
    await db.update(workQuestions).set({ continuationRunId: crashedRunId })
      .where(eq(workQuestions.id, question.id));

    const crashedChild = spawnTrackedChild(
      crashedRunId,
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 60000)"],
      { cwd: process.cwd(), env: {}, graceSec: 1, shell: false },
    );
    expect(runningProcesses.has(crashedRunId)).toBe(true);

    expect(await recoverExpiredCrewWakeup(db, {
      id: wakeup.id,
      companyId,
      agentId: crewAgentId,
      runId: crashedRunId,
      idempotencyKey: continuationKey,
      payload: { issueId: crewIssueId, questionId: question.id },
    })).toBe("requeued");
    expect(runningProcesses.has(crashedRunId)).toBe(false);
    expect(crashedChild.child.exitCode !== null || crashedChild.child.signalCode !== null).toBe(true);
    const [recoveredWakeup, failedRun, recoveredIssue, recoveredQuestion] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup.id)).then((rows) => rows[0]),
      db.select().from(internalAgentRuns).where(eq(internalAgentRuns.id, crashedRunId)).then((rows) => rows[0]),
      db.select().from(issues).where(eq(issues.id, crewIssueId)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, question.id)).then((rows) => rows[0]),
    ]);
    expect(recoveredWakeup).toMatchObject({ status: "queued", runId: null, claimToken: null });
    expect(failedRun).toMatchObject({ status: "failed", errorMessage: "reclaimed: expired Crew wakeup lease" });
    expect(recoveredIssue).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect(recoveredQuestion).toMatchObject({ continuationStatus: "dispatched", continuationRunId: null });
    expect(await workQuestionContinuationService(db).reconcileInternalAgentTerminals()).toBe(0);
    const questionAfterOldAttemptReconciliation = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id)).then((rows) => rows[0]);
    expect(questionAfterOldAttemptReconciliation).toMatchObject({
      continuationStatus: "dispatched",
      continuationRunId: null,
    });

    await db.insert(internalAgentRuns).values({
      id: replacementRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: crewIssueId,
      continuationIdempotencyKey: `${continuationKey}:crew-attempt:2`,
    });
    await db.update(agentWakeupRequests).set({
      status: "processing",
      attempts: 2,
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(agentWakeupRequests.id, wakeup.id));
    await bindInternalAgentWorkQuestionContinuation(db, {
      companyId,
      runId: replacementRunId,
      idempotencyKey: continuationKey,
      agentId: crewAgentId,
      wakeupId: wakeup.id,
    });
    const adopted = await issueService(db).checkout(
      crewIssueId,
      crewAgentId,
      ["todo", "backlog", "in_progress"],
      replacementRunId,
    );
    expect(adopted).toMatchObject({ checkoutRunId: replacementRunId, executionRunId: replacementRunId });
    const reboundQuestion = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id)).then((rows) => rows[0]);
    expect(reboundQuestion.continuationRunId).toBe(replacementRunId);

    await db.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
      .where(eq(internalAgentRuns.id, replacementRunId));
    await db.update(agentWakeupRequests).set({
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, wakeup.id));
    expect(await recoverExpiredCrewWakeup(db, {
      id: wakeup.id,
      companyId,
      agentId: crewAgentId,
      runId: replacementRunId,
      idempotencyKey: continuationKey,
      payload: { issueId: crewIssueId, questionId: question.id },
    })).toBe("terminal");
    const [terminalWakeup, terminalQuestion] = await Promise.all([
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup.id)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, question.id)).then((rows) => rows[0]),
    ]);
    expect(terminalWakeup).toMatchObject({ status: "succeeded", runId: replacementRunId });
    expect(terminalQuestion).toMatchObject({
      continuationStatus: "completed",
      continuationRunId: replacementRunId,
    });
  });

  it("reconciles a terminal failed Crew attempt and releases its stranded task lock", async () => {
    const crewAgentId = randomUUID();
    const originRunId = randomUUID();
    const failedRunId = randomUUID();
    const failedIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Failed Recovery Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: originRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: failedIssueId,
    });
    await db.insert(issues).values({
      id: failedIssueId,
      companyId,
      projectId,
      title: "Release a terminal failed continuation",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: originRunId,
      executionRunId: originRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: failedIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId: originRunId,
      title: "Confirm the failed retry",
      question: "Should this continuation retry use the saved answer?",
      blocking: true,
    });
    await db.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
      .where(eq(internalAgentRuns.id, originRunId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Use the saved answer." },
      expectedVersion: 0,
      idempotencyKey: "terminal-failed-recovery-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) })
      .where(eq(workQuestionContinuationRequests.questionId, question.id));
    await workQuestionContinuationService(db).processDue(new Date(), 10);
    const continuationKey = `work-question:${question.id}:answer:1`;
    const wakeup = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, continuationKey))
      .then((rows) => rows[0]);
    await db.insert(internalAgentRuns).values({
      id: failedRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "failed",
      relatedEntityType: "task",
      relatedEntityId: failedIssueId,
      continuationIdempotencyKey: `${continuationKey}:crew-attempt:1`,
      errorMessage: "provider disconnected",
      completedAt: new Date(),
    });
    await db.update(issues).set({ checkoutRunId: failedRunId, executionRunId: failedRunId })
      .where(eq(issues.id, failedIssueId));
    await db.update(workQuestions).set({ continuationRunId: failedRunId })
      .where(eq(workQuestions.id, question.id));
    await db.update(agentWakeupRequests).set({
      status: "processing",
      attempts: 1,
      runId: failedRunId,
      claimedAt: new Date(Date.now() - 20 * 60_000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, wakeup.id));

    expect(await recoverExpiredCrewWakeup(db, {
      id: wakeup.id,
      companyId,
      agentId: crewAgentId,
      runId: failedRunId,
      idempotencyKey: continuationKey,
      payload: { issueId: failedIssueId, questionId: question.id },
    })).toBe("terminal");
    const [issueAfter, wakeupAfter, questionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, failedIssueId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup.id)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, question.id)).then((rows) => rows[0]),
    ]);
    expect(issueAfter).toMatchObject({ status: "todo", checkoutRunId: null, executionRunId: null });
    expect(wakeupAfter).toMatchObject({ status: "failed", runId: failedRunId, claimToken: null });
    expect(questionAfter).toMatchObject({
      continuationStatus: "failed",
      continuationRunId: failedRunId,
      continuationError: "provider disconnected",
    });
  });

  it("serializes expired Crew recovery behind task closure without deadlocking", async () => {
    const crewAgentId = randomUUID();
    const originRunId = randomUUID();
    const activeRunId = randomUUID();
    const closingIssueId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Closing Recovery Crew",
      role: "product",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: originRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "task",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: closingIssueId,
    });
    await db.insert(issues).values({
      id: closingIssueId,
      companyId,
      projectId,
      title: "Close while recovering a continuation",
      identifier: `WQ-${Math.floor(Math.random() * 1_000_000)}`,
      status: "in_progress",
      assigneeAgentId: crewAgentId,
      responsibleUserId: userId,
      checkoutRunId: originRunId,
      executionRunId: originRunId,
    });
    const question = await workQuestionService(db).create(companyId, {
      issueId: closingIssueId,
      askingAgentId: crewAgentId,
      originatingRunKind: "internal_agent",
      originatingRunId: originRunId,
      title: "Confirm closure ordering",
      question: "Can this task close while recovery starts?",
      blocking: true,
    });
    await db.update(internalAgentRuns).set({ status: "completed", completedAt: new Date() })
      .where(eq(internalAgentRuns.id, originRunId));
    await workQuestionService(db).answer(companyId, question.id, { userId }, {
      answer: { text: "Yes." },
      expectedVersion: 0,
      idempotencyKey: "close-recovery-order-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) })
      .where(eq(workQuestionContinuationRequests.questionId, question.id));
    await workQuestionContinuationService(db).processDue(new Date(), 10);
    const continuationKey = `work-question:${question.id}:answer:1`;
    const wakeup = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, continuationKey))
      .then((rows) => rows[0]);
    await db.insert(internalAgentRuns).values({
      id: activeRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: closingIssueId,
      continuationIdempotencyKey: `${continuationKey}:crew-attempt:1`,
    });
    await db.update(issues).set({ checkoutRunId: activeRunId, executionRunId: activeRunId })
      .where(eq(issues.id, closingIssueId));
    await db.update(workQuestions).set({ continuationRunId: activeRunId })
      .where(eq(workQuestions.id, question.id));
    await db.update(agentWakeupRequests).set({
      status: "processing",
      attempts: 1,
      runId: activeRunId,
      claimedAt: new Date(Date.now() - 20 * 60_000),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 10_000),
    }).where(eq(agentWakeupRequests.id, wakeup.id));

    let releaseTaskLock!: () => void;
    const taskLockReleased = new Promise<void>((resolve) => { releaseTaskLock = resolve; });
    let markTaskLocked!: () => void;
    const taskLocked = new Promise<void>((resolve) => { markTaskLocked = resolve; });
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, closingIssueId)).for("update");
      markTaskLocked();
      await taskLockReleased;
    });
    await taskLocked;
    const closePromise = issueService(db).update(closingIssueId, { status: "done" }, { actorType: "system" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recoveryPromise = recoverExpiredCrewWakeup(db, {
      id: wakeup.id,
      companyId,
      agentId: crewAgentId,
      runId: activeRunId,
      idempotencyKey: continuationKey,
      payload: { issueId: closingIssueId, questionId: question.id },
    });
    releaseTaskLock();
    await blocker;
    let deadlockTimer!: ReturnType<typeof setTimeout>;
    try {
      await expect(Promise.race([
        Promise.all([closePromise, recoveryPromise]),
        new Promise((_, reject) => {
          deadlockTimer = setTimeout(() => reject(new Error("task closure/recovery deadlocked")), 5_000);
        }),
      ])).resolves.toBeDefined();
    } finally {
      clearTimeout(deadlockTimer);
    }
    const [issueAfter, wakeupAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, closingIssueId)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeup.id)).then((rows) => rows[0]),
    ]);
    expect(issueAfter.status).toBe("done");
    expect(wakeupAfter.status).toBe("cancelled");
  });

  it("snapshots a project SLA override and breaches it exactly once without reassigning", async () => {
    await db.update(projects).set({ humanQuestionSlaHours: 3 }).where(eq(projects.id, projectId));
    const service = workQuestionService(db);
    const createdAt = Date.now();
    const question = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Confirm the overdue launch choice",
      question: "Which launch choice should the agent use?",
      blocking: true,
    });
    expect(question).toMatchObject({
      slaDurationHours: 3,
      slaSource: "project",
      slaSourceId: projectId,
      currentRecipientUserId: userId,
    });
    expect(question.dueAt.getTime()).toBeGreaterThanOrEqual(createdAt + 3 * 60 * 60 * 1000 - 2_000);

    await db.update(workQuestions).set({ dueAt: new Date(Date.now() - 1_000) })
      .where(eq(workQuestions.id, question.id));
    const first = await workQuestionSlaService(db, {
      createNotification: async () => {
        throw new Error("temporary notification outage");
      },
    }).processDue(new Date(), 10);
    const afterFailure = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(first).toMatchObject({ breached: 1, notificationFailures: 1 });
    expect(afterFailure.slaBreachedAt).toBeInstanceOf(Date);
    expect(afterFailure.slaNotificationsCompletedAt).toBeNull();

    const second = await workQuestionSlaService(db).processDue(new Date(), 10);
    const third = await workQuestionSlaService(db).processDue(new Date(), 10);
    expect(second).toMatchObject({ breached: 0, notificationFailures: 0 });
    expect(third.scanned).toBe(0);

    const breached = await db.select().from(workQuestions)
      .where(eq(workQuestions.id, question.id))
      .then((rows) => rows[0]);
    expect(breached.slaBreachedAt).toBeInstanceOf(Date);
    expect(breached.slaNotificationsCompletedAt).toBeInstanceOf(Date);
    expect(breached.currentRecipientUserId).toBe(userId);
    const mirror = await db.select().from(hubItems).where(and(
      eq(hubItems.companyId, companyId),
      eq(hubItems.sourceType, "work_question"),
      eq(hubItems.sourceId, question.id),
    )).then((rows) => rows[0]);
    expect(mirror).toMatchObject({ priority: "urgent", ownerUserId: userId });
    const breachNotifications = await db.select().from(hubItems).where(and(
      eq(hubItems.companyId, companyId),
      eq(hubItems.type, "work_question.sla_breached"),
      eq(hubItems.relatedEntityId, issueId),
    ));
    expect(breachNotifications.filter((row) => row.createdAt >= question.createdAt)).toHaveLength(1);

    await service.cancelByUser(companyId, question.id, { userId }, breached.version);
    await db.update(projects).set({ humanQuestionSlaHours: null }).where(eq(projects.id, projectId));
  });

  it("rejects an un-tasked Crew run before creating a durable question", async () => {
    const crewAgentId = randomUUID();
    const crewRunId = randomUUID();
    await db.insert(agents).values({
      id: crewAgentId,
      companyId,
      name: "Conversation Crew",
      role: "discussion",
      kind: "aoa",
      status: "idle",
      adapterType: "codex_local",
    });
    await db.insert(internalAgentRuns).values({
      id: crewRunId,
      companyId,
      agentId: crewAgentId,
      triggerType: "sub_agent",
      triggerSource: "discussion",
      status: "running",
      relatedEntityType: "discussion",
      relatedEntityId: discussionId,
    });

    await expect(askHumanForActiveRun({
      db,
      companyId,
      agentId: crewAgentId,
      runId: crewRunId,
      originatingRunKind: "internal_agent",
    }, {
      question: "Should this un-tasked conversation become durable?",
    })).rejects.toThrow(/not attached to a task/i);
  });

  it("cancels open questions and active continuations when their task closes", async () => {
    const service = workQuestionService(db);
    const openQuestion = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Confirm final wording",
      question: "Should the final report use the short title?",
      blocking: true,
    });
    const answeredQuestion = await service.create(companyId, {
      issueId,
      askingAgentId: agentId,
      originatingRunKind: "heartbeat",
      originatingRunId: runId,
      title: "Confirm the appendix",
      question: "Should the appendix include raw interview notes?",
      blocking: true,
    });
    await service.answer(companyId, answeredQuestion.id, { userId }, {
      answer: { text: "Include the redacted notes." },
      expectedVersion: 0,
      idempotencyKey: "terminal-task-answer",
    });
    await db.update(workQuestionContinuationRequests).set({ nextAttemptAt: new Date(0) }).where(eq(
      workQuestionContinuationRequests.questionId,
      answeredQuestion.id,
    ));
    await continuationWorker().processDue(new Date(), 10);
    const continuationKey = `work-question:${answeredQuestion.id}:answer:1`;
    const crewContinuationRunId = randomUUID();
    await db.insert(internalAgentRuns).values({
      id: crewContinuationRunId,
      companyId,
      agentId,
      triggerType: "sub_agent",
      triggerSource: "work_question_continuation",
      status: "running",
      relatedEntityType: "task",
      relatedEntityId: issueId,
      continuationIdempotencyKey: `${continuationKey}:crew-attempt:1`,
    });
    await db.update(agentWakeupRequests).set({
      status: "processing",
      claimedAt: new Date(),
      claimToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(agentWakeupRequests.idempotencyKey, continuationKey));

    await issueService(db).update(issueId, { status: "done" }, { actorType: "system" });

    // The process can register after the task transaction commits. The
    // cancellation tombstone must still terminate it before it can run work.
    const lateChild = spawnTrackedChild(
      crewContinuationRunId,
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 60000)"],
      { cwd: process.cwd(), env: {}, graceSec: 1, shell: false },
    );
    await new Promise<void>((resolve) => lateChild.child.on("close", () => resolve()));
    expect(runningProcesses.has(crewContinuationRunId)).toBe(false);

    const [openAfter, answeredAfter, wakeupAfter, crewRunAfter] = await Promise.all([
      db.select().from(workQuestions).where(eq(workQuestions.id, openQuestion.id)).then((rows) => rows[0]),
      db.select().from(workQuestions).where(eq(workQuestions.id, answeredQuestion.id)).then((rows) => rows[0]),
      db.select().from(agentWakeupRequests).where(eq(
        agentWakeupRequests.idempotencyKey,
        continuationKey,
      )).then((rows) => rows[0]),
      db.select().from(internalAgentRuns)
        .where(eq(internalAgentRuns.id, crewContinuationRunId))
        .then((rows) => rows[0]),
    ]);
    expect(openAfter).toMatchObject({ status: "cancelled", continuationStatus: "not_needed" });
    expect(answeredAfter).toMatchObject({ status: "answered", continuationStatus: "not_needed" });
    expect(wakeupAfter.status).toBe("cancelled");
    expect(wakeupAfter.claimToken).toBeNull();
    expect(wakeupAfter.leaseExpiresAt).toBeNull();
    expect(crewRunAfter).toMatchObject({
      status: "cancelled",
      errorMessage: "Task done",
    });
    const continuationRunAfter = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wakeupAfter.runId!))
      .then((rows) => rows[0]);
    expect(continuationRunAfter).toMatchObject({
      status: "cancelled",
      errorCode: "task_no_longer_eligible",
    });
    await expect(service.answer(companyId, openQuestion.id, { userId }, {
      answer: { text: "Too late." },
      expectedVersion: openAfter.version,
      idempotencyKey: "answer-after-close",
    })).rejects.toThrow(/not open|terminal|no longer active/i);
  });
});

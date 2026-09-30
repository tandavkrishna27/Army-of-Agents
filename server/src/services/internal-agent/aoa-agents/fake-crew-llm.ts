import { readFileSync } from "node:fs";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussionEntries } from "@armyofagents/db";
import type { AdapterExecutionResult } from "../../../adapters/types.js";
import { logger } from "../../../middleware/logger.js";
import { buildScopeDraftIdempotencyKey } from "../tools/thread-action-keys.js";

export interface FakeCrewAgent {
  id: string;
  name: string;
}

export interface FakeCrewPayload {
  companyId: string;
  source: string;
  threadId?: unknown;
  effectiveAutonomy?: unknown;
  role?: unknown;
}

interface LatestHumanEntry {
  id: string;
  rawContent: string;
  seq: number;
}

export interface FakeCrewDeps {
  loadLatestHumanEntry?: (threadId: string) => Promise<LatestHumanEntry | null>;
  addEntry?: (
    companyId: string,
    threadId: string,
    data: {
      inputType: string;
      rawContent: string;
      authorAgentId: string | null;
      sourceInfo: Record<string, unknown> | null;
    },
    actorId: string,
  ) => Promise<unknown>;
  updateSummary?: (
    companyId: string,
    threadId: string,
    summary: { text: string; next: string | null },
    actor: { userId: string; role: "founder" | "team_lead" | "team_member"; isHuman: boolean },
  ) => Promise<unknown>;
  proposeWork?: (args: {
    threadId: string;
    companyId: string;
    autonomy: number | null;
    summary: string;
    proposedTasks: Array<{ title: string; assigneeRole?: string }>;
    createdBy: { agentId: string };
  }) => Promise<unknown>;
  /** D5: the fake calls the SAME primitive the real tool does. Default binding
   *  below imports threadAgentActionService; tests inject a spy. */
  proposeThreadAction?: (input: FakeScopeDraftInput) => Promise<unknown>;
}

export interface FakeScopeDraftContext {
  companyId: string;
  threadId: string;
  runId: string;
  agentId: string | null;
  summary: string;
  proposedTasks: Array<{ title: string; assigneeRole?: string }>;
  threadFreshness: { latestHumanSeq?: number } | null;
}

export interface FakeScopeDraftInput {
  companyId: string;
  threadId: string;
  runId: string;
  agentId: string | null;
  actionType: "create_scope_draft";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  freshness: Record<string, unknown>;
}

/**
 * Build the EXACT `proposeThreadAction` input the real propose_crew_work tool
 * produces in controller mode (propose-crew-work.ts:118-144). The fake calls
 * proposeThreadAction with this — no production tool refactor (eng-review D5).
 *
 * Parity contract: the idempotency KEY must be byte-identical to the tool's, so
 * BOTH derive it from the RAW proposedTasks (NOT a mapped copy — mapping would
 * turn assigneeRole:"" into null and change the key; challenger finding 4) and
 * the same turnAnchor (latestHumanSeq → String, or null). The parity unit test
 * pins this; drift is caught there, not by a shared helper.
 */
export function buildFakeScopeDraftInput(ctx: FakeScopeDraftContext): FakeScopeDraftInput {
  const latestHumanSeq = ctx.threadFreshness?.latestHumanSeq;
  return {
    companyId: ctx.companyId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    actionType: "create_scope_draft",
    payload: {
      summary: ctx.summary,
      proposedTasks: ctx.proposedTasks.map((task) => ({
        title: task.title,
        ...(task.assigneeRole ? { assigneeRole: task.assigneeRole } : {}),
      })),
    },
    // RAW tasks to the key builder — mirrors propose-crew-work.ts:136 exactly.
    idempotencyKey: buildScopeDraftIdempotencyKey({
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      summary: ctx.summary,
      proposedTasks: ctx.proposedTasks,
      turnAnchor: latestHumanSeq != null ? String(latestHumanSeq) : null,
    }),
    freshness: ctx.threadFreshness ?? {},
  };
}

export interface FakeCrewAdjutantControl {
  mode?: string;
  summary?: string;
  proposedTasks?: Array<{ title: string; assigneeRole?: string }>;
}

export interface FakeCrewControl {
  adjutant?: FakeCrewAdjutantControl;
}

/**
 * Per-test scripting for the fake harness, mirroring the fake-claude control-file
 * contract (tests/e2e/helpers/fake-claude.ts): AOA_E2E_FAKE_CREW_CONTROL points at
 * a JSON file rewritten by specs before they trigger a crew turn; we read it FRESH
 * on every turn. Absent env var, missing file, or malformed JSON all mean "no
 * control" → the legacy fake branches run unchanged, so the pre-existing CI specs
 * (full-discussion-to-workspace-cycle, onboarding-thread-pipeline,
 * mention-autocomplete) are structurally unaffected.
 */
export function readFakeCrewControl(env: NodeJS.ProcessEnv = process.env): FakeCrewControl | null {
  const controlPath = env.AOA_E2E_FAKE_CREW_CONTROL;
  if (!controlPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(controlPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FakeCrewControl;
  } catch {
    return null;
  }
}

export function isFakeCrewLlmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Defense-in-depth (review fix (minor)): the fake-crew harness is an E2E-only
  // escape hatch that fabricates crew replies without calling a real LLM. Gate it
  // on NODE_ENV in addition to the opt-in env var so it can NEVER activate in
  // production even if AOA_E2E_FAKE_CREW_LLM leaks into a prod environment.
  return env.AOA_E2E_FAKE_CREW_LLM === "1" && env.NODE_ENV !== "production";
}

/** Shared by the legacy proposeWork branch and the controller-mode branch. */
const FAKE_DEFAULT_PROPOSED_TASKS: Array<{ title: string; assigneeRole?: string }> = [
  { title: "Clarify the accepted scope handoff", assigneeRole: "planner" },
  { title: "Implement the scoped thread cycle", assigneeRole: "engineer" },
];

function wantsScope(content: string): boolean {
  return /\b(scope|scoping|formalize|tracked tasks|turn.+tasks|create.+tasks)\b/i.test(content);
}

function buildFakeReply(agent: FakeCrewAgent, latest: LatestHumanEntry | null): string {
  const prompt = latest?.rawContent.trim() || "the thread";
  if (agent.name === "Adjutant") {
    return [
      "Adjutant:",
      "I can help move this forward.",
      "I would clarify the outcome, bring in the right crew, and only scope it once the handoff is concrete.",
    ].join(" ");
  }

  if (agent.name === "Scout") {
    return [
      "Scout:",
      "I checked the thread context.",
      "The useful next step is to validate the user need, constraints, and source evidence before this becomes tracked work.",
    ].join(" ");
  }

  return `${agent.name}: I reviewed the thread context and can contribute to this next step: ${prompt.slice(0, 160)}`;
}

function buildFakeSummary(latest: LatestHumanEntry | null): { text: string; next: string | null } {
  const prompt = latest?.rawContent.trim() || "No recent human message yet.";
  return {
    text: `Latest discussion focus: ${prompt.slice(0, 220)}`,
    next: "Keep the summary current until the thread is ready to scope.",
  };
}

async function defaultLoadLatestHumanEntry(db: Db, threadId: string): Promise<LatestHumanEntry | null> {
  const rows = await db
    .select({
      id: discussionEntries.id,
      rawContent: discussionEntries.rawContent,
      seq: discussionEntries.seq,
    })
    .from(discussionEntries)
    .where(
      and(
        eq(discussionEntries.discussionId, threadId),
        isNull(discussionEntries.authorAgentId),
        ne(discussionEntries.inputType, "agent"),
        ne(discussionEntries.inputType, "system"),
        ne(discussionEntries.inputType, "scope_proposal"),
      ),
    )
    .orderBy(desc(discussionEntries.seq))
    .limit(1);
  return rows[0] ?? null;
}

async function defaultAddEntry(
  db: Db,
  companyId: string,
  threadId: string,
  data: {
    inputType: string;
    rawContent: string;
    authorAgentId: string | null;
    sourceInfo: Record<string, unknown> | null;
  },
  actorId: string,
): Promise<unknown> {
  const { discussionService } = await import("../../discussions.js");
  // Mirror the real crew path (post-entry-tool): the server engaged this agent,
  // so register it as a participant before the authz-checked post.
  const { ensureAgentParticipant } = await import("../../threads.js");
  await ensureAgentParticipant(db, companyId, threadId, data.authorAgentId ?? actorId);
  return discussionService(db).addEntry(companyId, threadId, data, actorId, {
    userId: data.authorAgentId ?? actorId,
    role: "team_member",
    isHuman: false,
    principalType: "agent",
  });
}

async function defaultUpdateSummary(
  db: Db,
  companyId: string,
  threadId: string,
  summary: { text: string; next: string | null },
  actor: { userId: string; role: "founder" | "team_lead" | "team_member"; isHuman: boolean },
): Promise<unknown> {
  const { threadService } = await import("../../threads.js");
  return threadService(db).updateSummary(companyId, threadId, summary, actor);
}

async function defaultProposeWork(
  db: Db,
  args: {
    threadId: string;
    companyId: string;
    autonomy: number | null;
    summary: string;
    proposedTasks: Array<{ title: string; assigneeRole?: string }>;
    createdBy: { agentId: string };
  },
): Promise<unknown> {
  const { crewTaskService } = await import("../../crew-task-service.js");
  return crewTaskService(db).proposeWork(args);
}

async function defaultProposeThreadAction(db: Db, input: FakeScopeDraftInput): Promise<unknown> {
  const { threadAgentActionService } = await import("../../thread-agent-actions.js");
  return threadAgentActionService(db).proposeThreadAction(input);
}

export async function maybeExecuteFakeCrewTurn(args: {
  db: Db;
  agent: FakeCrewAgent;
  payload: FakeCrewPayload;
  /** From runner.ts:148-158 — required for the controller-mode branch (the queued
   *  action's key self-appends to internal_agent_runs.proposedActionKeys so the
   *  runner's seal/commit machinery works with zero extra bookkeeping). */
  runId?: string | null;
  /** From runner.ts:267-268 — the controller-mode branch only fires on action-gated runs. */
  discussionRunMode?: "controller_action_gate" | null;
  /** From runner.ts:269-284 — snapshot at run start; threads through to freshness + turn anchor. */
  threadFreshness?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  deps?: FakeCrewDeps;
}): Promise<AdapterExecutionResult | null> {
  const { db, agent, payload, deps } = args;
  if (!isFakeCrewLlmEnabled(args.env)) return null;
  if (typeof payload.threadId !== "string" || !payload.threadId) return null;

  const threadId = payload.threadId;
  const latest =
    (await (deps?.loadLatestHumanEntry ?? ((id: string) => defaultLoadLatestHumanEntry(db, id)))(threadId)) ??
    null;

  // ── Controller-mode Adjutant (fake-crew harness Path B) ──────────────────────
  // Replays EXACTLY what the real propose_crew_work tool does in controller mode:
  // queue a create_scope_draft thread action (Decision #99 outbox) that the
  // runner's post-turn seal + commit then drives through the FULL W1/W2 pipeline
  // (role resolution → compile → autonomy gate → crew_dispatch approval). Opt-in
  // per test via the control file so the legacy branches below keep serving the
  // pre-existing CI specs untouched. All three keys are required:
  //   control mode  — the spec explicitly asked for the gated path
  //   action-gated  — mirrors the real tool's ctx.discussionRunMode check
  //   runId present — proposeThreadAction needs it for the seal key-set
  const control = readFakeCrewControl(args.env);
  const adjutantControl = control?.adjutant;
  if (
    agent.name === "Adjutant" &&
    adjutantControl?.mode === "controller_scope" &&
    args.discussionRunMode === "controller_action_gate" &&
    typeof args.runId === "string" &&
    args.runId
  ) {
    const summary =
      adjutantControl.summary ??
      `E2E fake controller scope: ${latest?.rawContent.slice(0, 160) ?? "thread"}`;
    const proposedTasks =
      adjutantControl.proposedTasks && adjutantControl.proposedTasks.length > 0
        ? adjutantControl.proposedTasks
        : FAKE_DEFAULT_PROPOSED_TASKS;

    // D5: build the EXACT input the real tool produces, then call proposeThreadAction
    // directly — no production-tool refactor. buildFakeScopeDraftInput's parity is
    // pinned in Task 1's unit tests (byte-identical key to propose_crew_work).
    const scopeInput = buildFakeScopeDraftInput({
      companyId: payload.companyId,
      threadId,
      runId: args.runId,
      agentId: agent.id,
      summary,
      proposedTasks,
      // The arg is intentionally broad-typed (Record<string, unknown> | null) to mirror
      // the runner's untyped freshness snapshot; this cast narrows it to
      // buildFakeScopeDraftInput's input type at the seam.
      threadFreshness: (args.threadFreshness as { latestHumanSeq?: number } | null) ?? null,
    });
    await (deps?.proposeThreadAction ?? ((input) => defaultProposeThreadAction(db, input)))(scopeInput);

    // Visible confirmation entry — the e2e's waitForVisibleAgentEntry target.
    // Direct insert (not action-gated) matches the harness's existing precedent
    // for fake replies; an AGENT entry does not bump latestHumanSeq, so it cannot
    // stale-suppress the scope action queued above.
    //
    // Eng-review 1A: BEST-EFFORT. The entry is decoration; the queued action is
    // cargo. An un-guarded throw here would fail the run, and a failed run's
    // proposed rows are never sealed (runner.ts:596 — by design), permanently
    // stranding the action on a cosmetic insert failure. Log and continue.
    try {
      await (deps?.addEntry ?? ((companyId, id, data, actorId) => defaultAddEntry(db, companyId, id, data, actorId)))(
        payload.companyId,
        threadId,
        {
          inputType: "agent",
          rawContent: `Adjutant: I queued a scope draft with ${proposedTasks.length} task(s) for this thread.`,
          authorAgentId: agent.id,
          sourceInfo: { e2eFakeCrewLlm: true },
        },
        agent.id,
      );
    } catch (entryErr) {
      logger.warn(
        { err: entryErr, threadId },
        "fake-crew: confirmation entry failed (best-effort) — scope action stays queued",
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { fakeCrewLlm: true, action: "queue_scope_draft" },
    };
  }

  if (agent.name === "Adjutant" && latest && wantsScope(latest.rawContent)) {
    await (deps?.proposeWork ?? ((input) => defaultProposeWork(db, input)))({
      threadId,
      companyId: payload.companyId,
      autonomy: typeof payload.effectiveAutonomy === "number" ? payload.effectiveAutonomy : null,
      summary: `E2E fake scope from thread discussion: ${latest.rawContent.slice(0, 180)}`,
      proposedTasks: FAKE_DEFAULT_PROPOSED_TASKS,
      createdBy: { agentId: agent.id },
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { fakeCrewLlm: true, action: "propose_work" },
    };
  }

  if (agent.name === "Chronicler") {
    await (deps?.updateSummary ?? ((companyId, id, summary, actor) => defaultUpdateSummary(db, companyId, id, summary, actor)))(
      payload.companyId,
      threadId,
      buildFakeSummary(latest),
      { userId: agent.id, role: "team_member", isHuman: false },
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { fakeCrewLlm: true, action: "update_summary" },
    };
  }

  await (deps?.addEntry ?? ((companyId, id, data, actorId) => defaultAddEntry(db, companyId, id, data, actorId)))(
    payload.companyId,
    threadId,
    {
      inputType: "agent",
      rawContent: buildFakeReply(agent, latest),
      authorAgentId: agent.id,
      sourceInfo: { e2eFakeCrewLlm: true },
    },
    agent.id,
  );

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    resultJson: { fakeCrewLlm: true, action: "post_entry" },
  };
}

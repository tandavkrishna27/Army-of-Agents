import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  hubItems,
  issues,
  userRoles,
  workQuestions,
  type Db,
} from "@armyofagents/db";
import { handleAskFounder, handleAskHuman } from "../mcp/tools/ask-founder-tool.js";
import { workQuestionService } from "../services/work-questions.js";
import type { ProtocolActor, ToolContext } from "../mcp/tools/types.js";

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
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up.
 *
 * `setupError = err` alone is not a guard: embedded-postgres can reject with
 * `undefined`, which is falsy, so the old `if (setupError) throw` silently
 * no-oped and every case then ran against an unassigned `db` — a wall of
 * `Cannot read properties of undefined (reading 'insert')` pointing into
 * product code, which reads as a product bug rather than a setup failure.
 * A boolean cannot be falsy-by-accident, and the `db` check covers a throw
 * that happens to leave `setupError` null.
 */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}
const PORT = 59900 + Math.floor(Math.random() * 300);

interface Scenario {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  userId: string;
}

async function seedScenario(label: string, runStatus = "running"): Promise<Scenario> {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const runId = randomUUID();
  const issueId = randomUUID();
  const userId = `ask-human-${randomUUID()}`;
  const now = new Date();
  await db.insert(companies).values({
    id: companyId,
    name: `Ask Human ${label}`,
    issuePrefix: `AH${Math.floor(Math.random() * 9000 + 1000)}`,
  });
  await db.insert(authUsers).values({
    id: userId,
    name: `Owner ${label}`,
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
    name: `Research Agent ${label}`,
    role: "research",
    kind: "org",
    status: "idle",
    adapterType: "codex_local",
  });
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "on_demand",
    status: runStatus,
    contextSnapshot: { issueId },
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: `Choose launch approach ${label}`,
    identifier: `AH-${Math.floor(Math.random() * 1_000_000)}`,
    status: "in_progress",
    assigneeAgentId: agentId,
    responsibleUserId: userId,
    checkoutRunId: runId,
  });
  return { companyId, agentId, runId, issueId, userId };
}

function buildAgentContext(scenario: Scenario, actorOverride: Partial<ProtocolActor> = {}): ToolContext {
  const actor: ProtocolActor = {
    userId: scenario.agentId,
    companyId: scenario.companyId,
    keyId: null,
    source: "agent",
    agentId: scenario.agentId,
    runId: scenario.runId,
    ...actorOverride,
  };
  return {
    db,
    companyId: scenario.companyId,
    actor,
    scope: { kind: "founder", userId: scenario.userId },
    services: {} as ToolContext["services"],
    actorInfo: {} as ToolContext["actorInfo"],
    resolveRole: async () => "founder",
    resolveScopedAgentIds: async () => null,
  };
}

async function waitForQuestion(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const question = await db.select().from(workQuestions).where(
      eq(workQuestions.originatingRunId, runId),
    ).then((rows) => rows[0] ?? null);
    if (question) return question;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Work question did not appear for run ${runId}`);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-ask-human-dogfood-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (error) {
    setupError = error;
    setupFailed = true;
    console.error("[ask-human-dogfood] embedded-postgres setup failed:", error);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } finally {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }
}, 60_000);

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("ask_human dogfood (real PostgreSQL)", () => {
  it("round-trips one free-text answer through the durable question and Hub mirror", async () => {
    assertSetupOk();
    const scenario = await seedScenario("text");
    const pending = handleAskHuman(buildAgentContext(scenario), {
      question: "Should we launch to five design partners first?",
      context: "The broad waitlist has not been qualified.",
    });
    const question = await waitForQuestion(scenario.runId);
    expect(question).toMatchObject({
      issueId: scenario.issueId,
      askingAgentId: scenario.agentId,
      currentRecipientUserId: scenario.userId,
      status: "open",
    });
    const mirror = await db.select().from(hubItems).where(and(
      eq(hubItems.sourceType, "work_question"),
      eq(hubItems.sourceId, question.id),
    )).then((rows) => rows[0]);
    expect(mirror).toMatchObject({ semanticType: "work_question", status: "open" });

    await expect(pending).resolves.toEqual({
      ok: true,
      data: {
        answered: false,
        questionId: question.id,
        status: "parked",
        note: "waiting for human",
      },
    });

    await workQuestionService(db).answer(scenario.companyId, question.id, { userId: scenario.userId }, {
      answer: { text: "Yes, start with five design partners." },
      expectedVersion: 0,
      idempotencyKey: "dogfood-text-answer",
    });
    expect((await db.select().from(workQuestions).where(eq(workQuestions.id, question.id)))[0]).toMatchObject({
      status: "answered",
    });
  });

  it("round-trips a structured option and keeps ask_founder as the same path", async () => {
    assertSetupOk();
    const scenario = await seedScenario("option");
    const pending = handleAskFounder(buildAgentContext(scenario), {
      question: "Which interview sample should we use?",
      options: [
        { label: "Five deep interviews", value: "five" },
        { label: "Twelve short interviews", value: "twelve" },
      ],
    });
    const question = await waitForQuestion(scenario.runId);
    expect(question.options).toHaveLength(2);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { answered: false, questionId: question.id, status: "parked" },
    });
    await workQuestionService(db).answer(scenario.companyId, question.id, { userId: scenario.userId }, {
      answer: { selectedValues: ["five"] },
      expectedVersion: 0,
      idempotencyKey: "dogfood-option-answer",
    });
    expect((await db.select().from(workQuestions).where(eq(workQuestions.id, question.id)))[0]).toMatchObject({
      status: "answered",
    });
  });

  it("rejects a terminal run before creating a question", async () => {
    assertSetupOk();
    const scenario = await seedScenario("terminal", "succeeded");
    await expect(handleAskHuman(
      buildAgentContext(scenario),
      { question: "Can stale work ask a question?" },
    )).rejects.toThrow(/active run/i);
    expect(await db.select().from(workQuestions).where(
      eq(workQuestions.originatingRunId, scenario.runId),
    )).toHaveLength(0);
  });

  it("rejects board callers and agent callers without a run", async () => {
    assertSetupOk();
    const scenario = await seedScenario("actor");
    const board = await handleAskHuman(
      buildAgentContext(scenario, { source: "board", agentId: null, runId: null }),
      { question: "Board caller?" },
    );
    const noRun = await handleAskHuman(
      buildAgentContext(scenario, { runId: null }),
      { question: "No run?" },
    );
    expect(board).toMatchObject({ ok: false, status: 403 });
    expect(noRun).toMatchObject({ ok: false, status: 403 });
  });
});

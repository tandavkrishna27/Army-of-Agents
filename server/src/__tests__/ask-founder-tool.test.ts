import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeCancelledError extends Error {
    constructor() {
      super("cancelled");
      this.name = "WorkQuestionCancelledError";
    }
  }
  return {
    create: vi.fn(),
    waitForAnswer: vi.fn(),
    markRelayed: vi.fn(),
    FakeCancelledError,
  };
});

vi.mock("../services/work-questions.js", () => ({
  WorkQuestionCancelledError: mocks.FakeCancelledError,
  workQuestionService: () => ({
    create: mocks.create,
    waitForAnswer: mocks.waitForAnswer,
    markRelayed: mocks.markRelayed,
  }),
}));

import {
  askHumanForActiveRun,
  handleAskFounder,
  handleAskHuman,
} from "../mcp/tools/ask-founder-tool.js";

const ISSUE_ID = "3c1a31aa-4a3a-43ce-95b0-dbd8c5cc50c2";

function queryDb(contextSnapshot: Record<string, unknown> = { issueId: ISSUE_ID }) {
  const terminal = Promise.resolve([{ contextSnapshot }]);
  const chain = {
    from: vi.fn(),
    where: vi.fn(() => terminal),
  };
  chain.from.mockReturnValue(chain);
  const updateTerminal = Promise.resolve([]);
  const updateChain = {
    set: vi.fn(),
    where: vi.fn(() => updateTerminal),
  };
  updateChain.set.mockReturnValue(updateChain);
  return { select: vi.fn(() => chain), update: vi.fn(() => updateChain) };
}

const LIVE_RELAY_CAPABILITIES = {
  mode: "live_relay",
  preservesProducerInvocationId: true,
  pauseDeadline: true,
  resumeSession: true,
  cancelWait: true,
} as const;

function liveRelayInput(ctx: ReturnType<typeof makeCtx>) {
  return {
    db: ctx.db,
    companyId: ctx.companyId,
    agentId: "agent-1",
    runId: "run-1",
    humanQuestionCapabilities: LIVE_RELAY_CAPABILITIES,
  };
}

function makeCtx(actor: Record<string, unknown>, contextSnapshot?: Record<string, unknown>) {
  return {
    db: queryDb(contextSnapshot),
    companyId: "co-1",
    actor: { userId: "agent-1", companyId: "co-1", keyId: null, ...actor },
    scope: { kind: "founder", userId: "agent-1" },
    services: {},
    actorInfo: {},
    resolveRole: vi.fn(),
    resolveScopedAgentIds: vi.fn(),
  } as any;
}

const created = { id: "question-1", version: 0 };
const answered = { id: "question-1", version: 1, answer: { selectedValues: ["yes"] } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue(created);
  mocks.waitForAnswer.mockResolvedValue(answered);
  mocks.markRelayed.mockResolvedValue({ ...answered, version: 2, continuationStatus: "dispatched" });
});

describe("ask_human tool", () => {
  it("rejects callers without an active organization-agent run", async () => {
    const board = await handleAskHuman(
      makeCtx({ source: "board", agentId: null, runId: null }),
      { question: "Ship it?" },
    );
    const noRun = await handleAskHuman(
      makeCtx({ source: "agent", agentId: "agent-1", runId: null }),
      { question: "Ship it?" },
    );
    expect(board).toMatchObject({ ok: false, status: 403 });
    expect(noRun).toMatchObject({ ok: false, status: 403 });
  });

  it("derives the task from the run and creates a durable question", async () => {
    const result = await handleAskHuman(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }),
      {
        question: "Ship the release?",
        context: "The release candidate passed QA.",
        options: [
          { label: "Yes", value: "yes", description: "Publish now.", rationale: "QA is green." },
          { label: "No", value: "no" },
        ],
      },
    );

    expect(mocks.create).toHaveBeenCalledWith("co-1", expect.objectContaining({
      issueId: ISSUE_ID,
      askingAgentId: "agent-1",
      originatingRunKind: "heartbeat",
      originatingRunId: "run-1",
      context: { summary: "The release candidate passed QA." },
      blocking: true,
    }));
    expect(mocks.waitForAnswer).not.toHaveBeenCalled();
    expect(mocks.markRelayed).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: { answered: false, questionId: "question-1", status: "parked", note: "waiting for human" },
    });
  });

  it("stores whitespace-only context as null", async () => {
    await handleAskHuman(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }),
      { question: "Ship it?", context: "   " },
    );
    expect(mocks.create.mock.calls[0][1].context).toBeNull();
  });

  it("preserves valid source provenance from the active run", async () => {
    await handleAskHuman(
      makeCtx(
        { source: "agent", agentId: "agent-1", runId: "run-1" },
        {
          issueId: "3c1a31aa-4a3a-43ce-95b0-dbd8c5cc50c2",
          executionWorkspaceId: "7228d61a-58c9-4db6-a12e-0380064f188b",
          sourceDiscussionId: "c82d72ce-7243-4dde-b0ed-a299949fb5a4",
          sourceCommanderConversationId: "ff20d4f4-5024-46dd-b590-c006d3856c78",
        },
      ),
      { question: "Which route should we take?" },
    );

    expect(mocks.create).toHaveBeenCalledWith("co-1", expect.objectContaining({
      issueId: "3c1a31aa-4a3a-43ce-95b0-dbd8c5cc50c2",
      executionWorkspaceId: "7228d61a-58c9-4db6-a12e-0380064f188b",
      sourceDiscussionId: "c82d72ce-7243-4dde-b0ed-a299949fb5a4",
      sourceCommanderConversationId: "ff20d4f4-5024-46dd-b590-c006d3856c78",
    }));
  });

  it("returns the durable answer even when live relay loses a race", async () => {
    mocks.markRelayed.mockRejectedValue(new Error("already dispatched"));
    const ctx = makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" });
    const result = await askHumanForActiveRun(
      liveRelayInput(ctx),
      { question: "Ship it?" },
    );
    expect(result).toMatchObject({ answered: true, questionId: "question-1" });
  });

  it("parks cleanly when the wait is cancelled", async () => {
    mocks.waitForAnswer.mockRejectedValue(new mocks.FakeCancelledError());
    const ctx = makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" });
    const result = await askHumanForActiveRun(
      liveRelayInput(ctx),
      { question: "Ship it?" },
    );
    expect(mocks.markRelayed).not.toHaveBeenCalled();
    expect(result).toEqual({
      answered: false, questionId: "question-1", status: "parked", note: "question cancelled",
    });
  });

  it("parks cleanly after the bounded wait times out", async () => {
    mocks.waitForAnswer.mockRejectedValue(new Error("Timed out waiting for work question answer"));
    const ctx = makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" });
    const result = await askHumanForActiveRun(
      liveRelayInput(ctx),
      { question: "Ship it?" },
    );
    expect(result).toMatchObject({ status: "parked", note: "waiting for human" });
  });

  it("rejects duplicate option values before creating a question", async () => {
    await expect(handleAskHuman(
      makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }),
      { question: "Pick", options: [{ label: "A", value: "x" }, { label: "B", value: "x" }] },
    )).rejects.toThrow(/unique/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a conflict when the run has no task context", async () => {
    const ctx = makeCtx({ source: "agent", agentId: "agent-1", runId: "run-1" }, {});
    const runChain = { from: vi.fn(), where: vi.fn(() => Promise.resolve([{ contextSnapshot: {} }])) };
    const taskChain = { from: vi.fn(), where: vi.fn(() => Promise.resolve([])) };
    runChain.from.mockReturnValue(runChain);
    taskChain.from.mockReturnValue(taskChain);
    ctx.db.select = vi.fn().mockReturnValueOnce(runChain).mockReturnValueOnce(taskChain);
    const result = await handleAskHuman(ctx, { question: "Ship it?" });
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps ask_founder as an exact compatibility alias", () => {
    expect(handleAskFounder).toBe(handleAskHuman);
  });
});

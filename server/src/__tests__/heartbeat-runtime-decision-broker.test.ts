import { describe, expect, it, vi } from "vitest";
import { RuntimeDecisionCancelledError } from "../services/agent-runtime-decisions.js";
import { calculateRunAccounting, createHeartbeatRuntimeDecisionBroker } from "../services/heartbeat.js";
import { conflict } from "../errors.js";
import { RUNTIME_HOOK_BLOCK_TIMEOUT_SEC } from "@armyofagents/adapter-utils";

const run = {
  id: "33333333-3333-3333-3333-333333333333",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: "22222222-2222-2222-2222-222222222222",
};

const agent = {
  id: run.agentId,
  companyId: run.companyId,
  name: "Builder",
  adapterType: "codex_local",
  adapterConfig: {},
};

const runtime = {
  sessionId: "legacy-session",
  sessionDisplayId: "display-session",
  sessionParams: { session: "display-session" },
  taskKey: "issue:1",
};

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    companyId: run.companyId,
    agentId: run.agentId,
    runId: run.id,
    adapterType: "codex_local",
    adapterSessionId: "display-session",
    adapterSessionParams: { session: "display-session" },
    kind: "permission",
    status: "created",
    nonce: "nonce-1",
    sourceRevision: 0,
    promptHash: "hash",
    sourceUniqueKey: "runtime:key",
    title: "Allow command?",
    summary: "Needs shell",
    promptText: "Run pnpm test?",
    toolName: "shell",
    command: "pnpm test",
    cwd: null,
    path: null,
    networkTarget: null,
    riskClass: "medium",
    options: null,
    expiresAt: null,
    timeoutPolicy: "deny",
    decision: null,
    answerPayload: null,
    answeredByUserId: null,
    answeredAt: null,
    relayedAt: null,
    relayError: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("heartbeat runtime decision broker", () => {
  it("creates a permission prompt, marks the run waiting, relays the answer, and clears waiting state", async () => {
    const created = decisionRow();
    const answered = decisionRow({ status: "answered", sourceRevision: 1, decision: "allow_once" });
    const relayed = decisionRow({ status: "relayed", sourceRevision: 2, decision: "allow_once" });
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockResolvedValue(answered),
      markRelayed: vi.fn().mockResolvedValue(relayed),
      markRelayFailed: vi.fn(),
    };
    const appendRunEvent = vi.fn().mockResolvedValue(undefined);
    const markRunWaiting = vi.fn().mockResolvedValue(undefined);
    const clearRunWaiting = vi.fn().mockResolvedValue(undefined);
    const recordWait = vi.fn().mockResolvedValue(undefined);

    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent,
      markRunWaiting,
      clearRunWaiting,
      recordWait,
      pollIntervalMs: 0,
    });

    const result = await broker.requestPermission({
      nonce: "nonce-1",
      title: "Allow command?",
      summary: "Needs shell",
      promptText: "Run pnpm test?",
      toolName: "shell",
      command: "pnpm test",
      riskClass: "medium",
    });

    expect(result).toEqual({
      kind: "permission",
      decisionId: created.id,
      decision: "allow_once",
      sourceRevision: 2,
    });
    expect(runtimeDecisions.createPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: run.companyId,
        agentId: run.agentId,
        runId: run.id,
        adapterType: "codex_local",
        adapterSessionId: "display-session",
        adapterSessionParams: { session: "display-session" },
        kind: "permission",
        nonce: "nonce-1",
        timeoutPolicy: "deny",
      }),
    );
    expect(markRunWaiting).toHaveBeenCalledWith(created);
    expect(runtimeDecisions.waitForAnswer).toHaveBeenCalledWith({
      companyId: run.companyId,
      decisionId: created.id,
      pollIntervalMs: 0,
    });
    expect(runtimeDecisions.markRelayed).toHaveBeenCalledWith({ companyId: run.companyId, decisionId: created.id });
    expect(clearRunWaiting).toHaveBeenCalledWith(relayed);
    expect(recordWait).toHaveBeenCalledWith("permission", expect.any(Number));
    expect(appendRunEvent.mock.calls.map((call) => call[0].eventType)).toEqual([
      "runtime_decision.prompt_created",
      "runtime_decision.prompt_answered",
      "runtime_decision.relayed",
    ]);
  });

  it("marks relay_failed if the answered prompt cannot be relayed back to the adapter", async () => {
    const created = decisionRow();
    const answered = decisionRow({ status: "answered", sourceRevision: 1, decision: "deny" });
    const relayError = new Error("adapter channel closed");
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockResolvedValue(answered),
      markRelayed: vi.fn().mockRejectedValue(relayError),
      markRelayFailed: vi.fn().mockResolvedValue(decisionRow({ status: "relay_failed", relayError: "adapter channel closed" })),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    await expect(
      broker.requestPermission({
        nonce: "nonce-1",
        title: "Allow command?",
      }),
    ).rejects.toThrow("adapter channel closed");

    expect(runtimeDecisions.markRelayFailed).toHaveBeenCalledWith({
      companyId: run.companyId,
      decisionId: created.id,
      relayError: "adapter channel closed",
    });
  });

  it("defaults work-question prompts to park_run instead of the permission deny policy", async () => {
    const created = decisionRow({ kind: "work_question", timeoutPolicy: "park_run" });
    const answered = decisionRow({
      kind: "work_question",
      status: "answered",
      sourceRevision: 1,
      answerPayload: { choice: "ship it" },
    });
    const relayed = decisionRow({
      kind: "work_question",
      status: "relayed",
      sourceRevision: 2,
      answerPayload: { choice: "ship it" },
    });
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockResolvedValue(answered),
      markRelayed: vi.fn().mockResolvedValue(relayed),
      markRelayFailed: vi.fn(),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    await broker.askWorkQuestion({
      nonce: "question-1",
      title: "Pick a release path",
    });

    expect(runtimeDecisions.createPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "work_question",
        timeoutPolicy: "park_run",
      }),
    );
  });

  it("propagates runtime decision cancellation without marking relay failure", async () => {
    const created = decisionRow();
    const cancelled = decisionRow({ status: "cancelled", sourceRevision: 1, relayError: "run cancelled" });
    const cancelError = new RuntimeDecisionCancelledError(cancelled as never);
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockRejectedValue(cancelError),
      markRelayed: vi.fn(),
      markRelayFailed: vi.fn(),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    await expect(
      broker.requestPermission({
        nonce: "nonce-1",
        title: "Allow command?",
      }),
    ).rejects.toBe(cancelError);

    expect(runtimeDecisions.markRelayed).not.toHaveBeenCalled();
    expect(runtimeDecisions.markRelayFailed).not.toHaveBeenCalled();
  });

  it("preserves cancellation when markRelayed loses a race to run cancellation", async () => {
    const created = decisionRow();
    const answered = decisionRow({ status: "answered", sourceRevision: 1, decision: "allow_once" });
    const cancelled = decisionRow({ status: "cancelled", sourceRevision: 2, relayError: "run cancelled" });
    const cancelError = new RuntimeDecisionCancelledError(cancelled as never);
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockResolvedValue(answered),
      markRelayed: vi.fn().mockRejectedValue(cancelError),
      markRelayFailed: vi.fn(),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    await expect(
      broker.requestPermission({
        nonce: "nonce-1",
        title: "Allow command?",
      }),
    ).rejects.toBe(cancelError);

    expect(runtimeDecisions.markRelayed).toHaveBeenCalledWith({ companyId: run.companyId, decisionId: created.id });
    expect(runtimeDecisions.markRelayFailed).not.toHaveBeenCalled();
  });
});

describe("heartbeat runtime decision broker — requestPermissionBounded", () => {
  const TIMEOUT_MS = RUNTIME_HOOK_BLOCK_TIMEOUT_SEC * 1000;

  it("returns the answer and relays it when answered before timeout", async () => {
    const created = decisionRow();
    const answered = decisionRow({ status: "answered", sourceRevision: 1, decision: "allow_once" });
    const relayed = decisionRow({ status: "relayed", sourceRevision: 2, decision: "allow_once" });
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockResolvedValue(answered),
      markRelayed: vi.fn().mockResolvedValue(relayed),
      markRelayFailed: vi.fn(),
    };
    const clearRunWaiting = vi.fn().mockResolvedValue(undefined);
    const recordWait = vi.fn().mockResolvedValue(undefined);
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting,
      recordWait,
      pollIntervalMs: 0,
    });

    const result = await broker.requestPermissionBounded(
      { nonce: "nonce-1", title: "Allow command?" },
      TIMEOUT_MS,
    );

    expect(result).toEqual({
      kind: "permission",
      decisionId: created.id,
      decision: "allow_once",
      sourceRevision: 2,
    });
    // waitForAnswer must be called WITH a timeoutMs (bounded wait)
    expect(runtimeDecisions.waitForAnswer).toHaveBeenCalledWith({
      companyId: run.companyId,
      decisionId: created.id,
      timeoutMs: TIMEOUT_MS,
    });
    expect(runtimeDecisions.markRelayed).toHaveBeenCalledWith({ companyId: run.companyId, decisionId: created.id });
    expect(clearRunWaiting).toHaveBeenCalledWith(relayed);
    expect(recordWait).toHaveBeenCalledWith("permission", expect.any(Number));
  });

  it("returns { timedOut: true } and does NOT call markRelayed when waitForAnswer times out", async () => {
    const created = decisionRow();
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      // Mirrors agent-runtime-decisions.waitForAnswer's timeout throw
      waitForAnswer: vi.fn().mockRejectedValue(conflict("Timed out waiting for runtime decision answer")),
      markRelayed: vi.fn(),
      markRelayFailed: vi.fn(),
    };
    const clearRunWaiting = vi.fn().mockResolvedValue(undefined);
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting,
      pollIntervalMs: 0,
    });

    const result = await broker.requestPermissionBounded(
      { nonce: "nonce-1", title: "Allow command?" },
      TIMEOUT_MS,
    );

    expect(result).toEqual({ timedOut: true });
    // CRITICAL INVARIANT: never relay after timeout (no stale "relayed").
    expect(runtimeDecisions.markRelayed).not.toHaveBeenCalled();
    expect(runtimeDecisions.markRelayFailed).not.toHaveBeenCalled();
    // The row is intentionally left for the W5a sweep to reconcile — do not clear waiting.
    expect(clearRunWaiting).not.toHaveBeenCalled();
  });

  it("does not relay even if a late answer arrives after a timedOut return", async () => {
    // Simulate: first bounded call times out; the same broker instance is not
    // re-invoked, and a subsequent (late) resolution of waitForAnswer must not
    // reach markRelayed. Because waitForAnswer resolves/throws exactly once and
    // markRelayed is only called synchronously on the success branch, a late
    // answer can never trigger a relay. We assert markRelayed stays untouched.
    const created = decisionRow();
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockRejectedValue(conflict("Timed out waiting for runtime decision answer")),
      markRelayed: vi.fn(),
      markRelayFailed: vi.fn(),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    const result = await broker.requestPermissionBounded(
      { nonce: "nonce-1", title: "Allow command?" },
      TIMEOUT_MS,
    );
    expect(result).toEqual({ timedOut: true });

    // Let any pending microtasks flush — a late answer must still not relay.
    await Promise.resolve();
    expect(runtimeDecisions.markRelayed).not.toHaveBeenCalled();
  });

  it("rethrows RuntimeDecisionCancelledError (caller maps to deny)", async () => {
    const created = decisionRow();
    const cancelled = decisionRow({ status: "cancelled", sourceRevision: 1, relayError: "run cancelled" });
    const cancelError = new RuntimeDecisionCancelledError(cancelled as never);
    const runtimeDecisions = {
      createPrompt: vi.fn().mockResolvedValue({ decision: created, hubItem: { id: "hub-1" } }),
      waitForAnswer: vi.fn().mockRejectedValue(cancelError),
      markRelayed: vi.fn(),
      markRelayFailed: vi.fn(),
    };
    const broker = createHeartbeatRuntimeDecisionBroker({
      run,
      agent,
      runtime,
      runtimeDecisions,
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
      markRunWaiting: vi.fn().mockResolvedValue(undefined),
      clearRunWaiting: vi.fn().mockResolvedValue(undefined),
      pollIntervalMs: 0,
    });

    await expect(
      broker.requestPermissionBounded({ nonce: "nonce-1", title: "Allow command?" }, TIMEOUT_MS),
    ).rejects.toBe(cancelError);
    expect(runtimeDecisions.markRelayed).not.toHaveBeenCalled();
  });
});

describe("heartbeat run accounting", () => {
  it("keeps parked human wait out of provider-active time while adding it to total elapsed time", () => {
    expect(
      calculateRunAccounting({
        startedAt: "2026-07-13T12:00:00.000Z",
        finishedAt: "2026-07-13T12:01:00.000Z",
        humanQuestionWaitMs: 60 * 60 * 1000,
        runtimePermissionWaitMs: 0,
        humanWaitOccurredOutsideRun: true,
      }),
    ).toEqual({
      activeExecutionMs: 60 * 1000,
      humanQuestionWaitMs: 60 * 60 * 1000,
      runtimePermissionWaitMs: 0,
      totalWallClockMs: 61 * 60 * 1000,
    });
  });

  it("subtracts inline permission and human waits from provider-active time", () => {
    expect(
      calculateRunAccounting({
        startedAt: "2026-07-13T12:00:00.000Z",
        finishedAt: "2026-07-13T12:02:00.000Z",
        humanQuestionWaitMs: 20 * 1000,
        runtimePermissionWaitMs: 30 * 1000,
        humanWaitOccurredOutsideRun: false,
      }),
    ).toEqual({
      activeExecutionMs: 70 * 1000,
      humanQuestionWaitMs: 20 * 1000,
      runtimePermissionWaitMs: 30 * 1000,
      totalWallClockMs: 120 * 1000,
    });
  });
});

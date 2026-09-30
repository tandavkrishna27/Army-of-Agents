import { describe, expect, it, vi } from "vitest";
import type { SubmitJobResponse, SubmitJobSource } from "@armyofagents/shared";
import type { BridgeActor, JobAdmissionBridge } from "../services/job-admission-bridge.js";
import { createJobConvertOrchestrator } from "../services/job-convert-orchestrator.js";

const SOURCE: SubmitJobSource = {
  kind: "task_run",
  runId: "33333333-3333-4333-8333-333333333333",
  issueId: "44444444-4444-4444-8444-444444444444",
  assigneeAgentId: "55555555-5555-4555-8555-555555555555",
};

const ACTOR: BridgeActor = {
  kind: "agent",
  id: SOURCE.kind === "task_run" ? SOURCE.assigneeAgentId : "",
  companyId: "22222222-2222-4222-8222-222222222222",
};

const RESPONSE: SubmitJobResponse = {
  jobId: "66666666-6666-4666-8666-666666666666",
  attemptId: "77777777-7777-4777-8777-777777777777",
  status: "queued",
  replayed: false,
};

function makeBridge(overrides: Partial<JobAdmissionBridge>): JobAdmissionBridge {
  return {
    isEnabled: () => true,
    admitAndSubmit: vi.fn(async () => RESPONSE),
    releaseTaskClaim: vi.fn(async () => ({ released: false })),
    ...overrides,
  };
}

describe("CLI-005 active convert orchestrator (durable non-leasable job via the bridge)", () => {
  it("does nothing when the bridge is disabled (no admitAndSubmit call)", async () => {
    const admitAndSubmit = vi.fn(async () => RESPONSE);
    const bridge = makeBridge({ isEnabled: () => false, admitAndSubmit });
    const orchestrator = createJobConvertOrchestrator({ bridge });

    const result = await orchestrator.convertRunToJob({
      source: SOURCE,
      actor: ACTOR,
      idempotencyKey: "run-33333333",
    });

    expect(result).toEqual({ converted: false, reason: "disabled" });
    expect(admitAndSubmit).not.toHaveBeenCalled();
  });

  it("submits exactly one durable job via admitAndSubmit (bridge owns the ONE checkout)", async () => {
    const admitAndSubmit = vi.fn(async () => RESPONSE);
    const bridge = makeBridge({ admitAndSubmit });
    const orchestrator = createJobConvertOrchestrator({ bridge });

    const result = await orchestrator.convertRunToJob({
      source: SOURCE,
      actor: ACTOR,
      idempotencyKey: "run-33333333",
      input: { foo: "bar" },
    });

    expect(admitAndSubmit).toHaveBeenCalledTimes(1);
    expect(admitAndSubmit).toHaveBeenCalledWith(SOURCE, ACTOR, "run-33333333", { foo: "bar" });
    expect(result).toEqual({ converted: true, reason: "submitted", response: RESPONSE });
  });

  it("reports a replay (redelivery) distinctly and never re-checks-out", async () => {
    const bridge = makeBridge({ admitAndSubmit: vi.fn(async () => ({ ...RESPONSE, replayed: true })) });
    const orchestrator = createJobConvertOrchestrator({ bridge });
    const result = await orchestrator.convertRunToJob({
      source: SOURCE,
      actor: ACTOR,
      idempotencyKey: "run-33333333",
    });
    expect(result.converted).toBe(true);
    expect(result.reason).toBe("replayed");
  });

  it("on a submit throw: RETAINS the legacy claim (never releases) and never throws into the run", async () => {
    // CLI-005 inert model: the legacy adapter still owns + executes this issue
    // (executionRunId from the wakeup). A failed convert rolled the WHOLE submit tx back —
    // checkout undone, no job row — so the issue's legacy claim is already intact. The
    // orchestrator must NOT release it: issueService.release would reset the issue to
    // todo/unassigned out from under the legacy run (double-assignment window + board
    // flicker). A failed convert is a no-op on issue state; the run proceeds on legacy.
    const releaseTaskClaim = vi.fn(async () => ({ released: true }));
    const bridge = makeBridge({
      admitAndSubmit: vi.fn(async () => {
        throw new Error("stale status / ownership conflict / capacity 429");
      }),
      releaseTaskClaim,
    });
    const orchestrator = createJobConvertOrchestrator({ bridge });

    let result: Awaited<ReturnType<typeof orchestrator.convertRunToJob>> | undefined;
    await expect(
      (async () => {
        result = await orchestrator.convertRunToJob({
          source: SOURCE,
          actor: ACTOR,
          idempotencyKey: "run-33333333",
        });
      })(),
    ).resolves.not.toThrow();

    expect(result?.converted).toBe(false);
    expect(result?.reason).toBe("submit_failed");
    // The legacy claim is RETAINED — the orchestrator never releases on failure.
    expect(releaseTaskClaim).not.toHaveBeenCalled();
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildFakeScopeDraftInput,
  isFakeCrewLlmEnabled,
  maybeExecuteFakeCrewTurn,
  readFakeCrewControl,
} from "../services/internal-agent/aoa-agents/fake-crew-llm.js";
import { buildScopeDraftIdempotencyKey } from "../services/internal-agent/tools/thread-action-keys.js";

const db = {} as never;

describe("fake crew LLM e2e harness", () => {
  it("is disabled unless AOA_E2E_FAKE_CREW_LLM=1", async () => {
    expect(isFakeCrewLlmEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isFakeCrewLlmEnabled({ AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv)).toBe(true);

    const addEntry = vi.fn();
    const result = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-adj", name: "Adjutant" },
      payload: { companyId: "co-1", source: "thread.controller", threadId: "thr-1" },
      env: {},
      deps: { addEntry },
    });

    expect(result).toBeNull();
    expect(addEntry).not.toHaveBeenCalled();
  });

  it("review fix (minor): never enables in production even when the env flag is set", async () => {
    // Defense-in-depth: NODE_ENV=production must hard-disable the harness even if
    // AOA_E2E_FAKE_CREW_LLM leaked into the prod environment.
    expect(
      isFakeCrewLlmEnabled({
        AOA_E2E_FAKE_CREW_LLM: "1",
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toBe(false);

    const addEntry = vi.fn();
    const result = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-adj", name: "Adjutant" },
      payload: { companyId: "co-1", source: "thread.controller", threadId: "thr-1" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1", NODE_ENV: "production" } as NodeJS.ProcessEnv,
      deps: { addEntry },
    });

    expect(result).toBeNull();
    expect(addEntry).not.toHaveBeenCalled();
  });

  it("posts an Adjutant chat reply for a normal founder message", async () => {
    const addEntry = vi.fn().mockResolvedValue({});
    const result = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-adj", name: "Adjutant" },
      payload: { companyId: "co-1", source: "thread.controller", threadId: "thr-1" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: {
        loadLatestHumanEntry: async () => ({
          id: "entry-1",
          rawContent: "Can we discuss the central panel experience?",
          seq: 1,
        }),
        addEntry,
      },
    });

    expect(result?.resultJson).toMatchObject({ fakeCrewLlm: true, action: "post_entry" });
    expect(addEntry).toHaveBeenCalledWith(
      "co-1",
      "thr-1",
      expect.objectContaining({
        inputType: "agent",
        authorAgentId: "agent-adj",
        rawContent: expect.stringContaining("Adjutant:"),
      }),
      "agent-adj",
    );
  });

  it("posts a directly mentioned crew agent reply", async () => {
    const addEntry = vi.fn().mockResolvedValue({});
    await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-scout", name: "Scout" },
      payload: { companyId: "co-1", source: "thread.participation", threadId: "thr-1" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: {
        loadLatestHumanEntry: async () => ({
          id: "entry-2",
          rawContent: "@Scout please check this",
          seq: 2,
        }),
        addEntry,
      },
    });

    expect(addEntry).toHaveBeenCalledWith(
      "co-1",
      "thr-1",
      expect.objectContaining({
        inputType: "agent",
        authorAgentId: "agent-scout",
        rawContent: expect.stringContaining("Scout:"),
      }),
      "agent-scout",
    );
  });

  it("updates summary instead of posting chat for fake Chronicler sweeps", async () => {
    const addEntry = vi.fn();
    const updateSummary = vi.fn().mockResolvedValue({});

    const result = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-chronicler", name: "Chronicler" },
      payload: { companyId: "co-1", source: "sweep.chronicler", threadId: "thr-1" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: {
        loadLatestHumanEntry: async () => ({
          id: "entry-1",
          rawContent: "We need a scoped checkout handoff.",
          seq: 7,
        }),
        addEntry,
        updateSummary,
      } as any,
    });

    expect(result?.resultJson).toMatchObject({ fakeCrewLlm: true, action: "update_summary" });
    expect(addEntry).not.toHaveBeenCalled();
    expect(updateSummary).toHaveBeenCalledWith(
      "co-1",
      "thr-1",
      expect.objectContaining({
        text: expect.stringContaining("We need a scoped checkout handoff."),
      }),
      { userId: "agent-chronicler", role: "team_member", isHuman: false },
    );
  });

  it("routes Adjutant scope requests through proposeWork", async () => {
    const addEntry = vi.fn();
    const proposeWork = vi.fn().mockResolvedValue({ proposalId: "proposal-1" });
    const result = await maybeExecuteFakeCrewTurn({
      db,
      agent: { id: "agent-adj", name: "Adjutant" },
      payload: {
        companyId: "co-1",
        source: "thread.controller",
        threadId: "thr-1",
        effectiveAutonomy: 1,
      },
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: {
        loadLatestHumanEntry: async () => ({
          id: "entry-3",
          rawContent: "Please scope this into tracked tasks.",
          seq: 3,
        }),
        addEntry,
        proposeWork,
      },
    });

    expect(result?.resultJson).toMatchObject({ fakeCrewLlm: true, action: "propose_work" });
    expect(addEntry).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr-1",
        companyId: "co-1",
        autonomy: 1,
        createdBy: { agentId: "agent-adj" },
        proposedTasks: expect.arrayContaining([
          expect.objectContaining({ assigneeRole: "planner" }),
          expect.objectContaining({ assigneeRole: "engineer" }),
        ]),
      }),
    );
  });
});

describe("buildFakeScopeDraftInput — key/payload parity with propose_crew_work", () => {
  it("derives the BYTE-IDENTICAL turn-anchored key the real tool would", () => {
    const input = buildFakeScopeDraftInput({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      summary: "Auth scope",
      proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      threadFreshness: { latestHumanSeq: 7 },
    });

    expect(input).toMatchObject({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      actionType: "create_scope_draft",
      payload: {
        summary: "Auth scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
      freshness: { latestHumanSeq: 7 },
    });
    // The tool derives its key from the RAW proposedTasks + turnAnchor (propose-crew-work.ts:132-141).
    // The fake MUST match byte-for-byte, or the same-turn re-proposal dedupe silently breaks.
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({
        threadId: "thr-1",
        agentId: "agent-adj",
        summary: "Auth scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
        turnAnchor: "7",
      }),
    );
  });

  it("null freshness → noanchor key + empty freshness (snapshot_unavailable contract)", () => {
    const input = buildFakeScopeDraftInput({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: null,
      summary: "S",
      proposedTasks: [{ title: "T" }],
      threadFreshness: null,
    });
    expect(input.freshness).toEqual({});
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({
        threadId: "thr-1",
        agentId: null,
        summary: "S",
        proposedTasks: [{ title: "T" }],
        turnAnchor: null,
      }),
    );
  });

  it("eng-review-fix-4: passes RAW proposedTasks to the key builder (empty assigneeRole ≠ dropped)", () => {
    // The tool feeds the raw tasks to buildScopeDraftIdempotencyKey (propose-crew-work.ts:136);
    // an assigneeRole:"" must produce the tool's key, NOT a mapped-to-null variant. Regression
    // pin for the challenger's finding 4.
    const raw = [{ title: "T", assigneeRole: "" }];
    const input = buildFakeScopeDraftInput({
      companyId: "co-1", threadId: "thr-1", runId: "run-1", agentId: "a",
      summary: "S", proposedTasks: raw, threadFreshness: { latestHumanSeq: 2 },
    });
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({ threadId: "thr-1", agentId: "a", summary: "S", proposedTasks: raw, turnAnchor: "2" }),
    );
  });
});

describe("readFakeCrewControl", () => {
  it("returns null when the env var is unset (legacy behavior)", () => {
    expect(readFakeCrewControl({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null for a missing file or malformed JSON (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    expect(
      readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: join(dir, "missing.json") } as NodeJS.ProcessEnv),
    ).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: bad } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses a controller_scope control", () => {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    const file = join(dir, "control.json");
    writeFileSync(
      file,
      JSON.stringify({
        adjutant: {
          mode: "controller_scope",
          summary: "Token endpoint scope",
          proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
        },
      }),
    );
    expect(readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv)).toEqual({
      adjutant: {
        mode: "controller_scope",
        summary: "Token endpoint scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
    });
  });
});

describe("controller-mode Adjutant branch (fake-crew harness Path B)", () => {
  function controlFileWith(adjutant: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    const file = join(dir, "control.json");
    writeFileSync(file, JSON.stringify({ adjutant }));
    return file;
  }

  const gatedArgsBase = {
    db,
    agent: { id: "agent-adj", name: "Adjutant" },
    payload: {
      companyId: "co-1",
      source: "mention",
      threadId: "thr-1",
      effectiveAutonomy: 1,
    },
    runId: "run-1",
    discussionRunMode: "controller_action_gate" as const,
    threadFreshness: { latestHumanSeq: 3 },
  };

  it("queues create_scope_draft via proposeThreadAction + posts a visible confirmation entry", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const addEntry = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({
      mode: "controller_scope",
      summary: "Token endpoint scope",
      proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
    });

    const result = await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, proposeWork, loadLatestHumanEntry },
    });

    expect(result).toMatchObject({ exitCode: 0, resultJson: { fakeCrewLlm: true, action: "queue_scope_draft" } });
    expect(proposeThreadAction).toHaveBeenCalledTimes(1);
    // The fake calls proposeThreadAction with buildFakeScopeDraftInput's output —
    // the SAME shape the real tool produces (parity pinned in Task 1's tests).
    const arg = proposeThreadAction.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      actionType: "create_scope_draft",
      payload: {
        summary: "Token endpoint scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
      freshness: { latestHumanSeq: 3 },
    });
    expect(typeof arg.idempotencyKey).toBe("string");
    // The LEGACY path must not fire.
    expect(proposeWork).not.toHaveBeenCalled();
    // Visible confirmation entry for waitForVisibleAgentEntry in the e2e.
    expect(addEntry).toHaveBeenCalledTimes(1);
    const entry = addEntry.mock.calls[0][2] as { rawContent: string; authorAgentId: string };
    expect(entry.authorAgentId).toBe("agent-adj");
    expect(entry.rawContent).toMatch(/queued a scope draft/i);
  });

  it("falls back to LEGACY proposeWork when the run is NOT action-gated, even with control set", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      discussionRunMode: null,
      runId: null,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1); // legacy branch (wantsScope matches)
  });

  it("no control file → legacy behavior byte-for-byte (regression pin for existing CI specs)", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1);
  });

  it("eng-review: gated + control but runId MISSING → legacy fallback (never half-queues)", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      runId: null, // gated run whose run-row insert failed
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1);
  });

  it("eng-review: control omits proposedTasks → shared defaults are queued", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "scope it",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope", summary: "S" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    const arg = proposeThreadAction.mock.calls[0][0] as { payload: { proposedTasks: Array<{ title: string }> } };
    expect(arg.payload.proposedTasks).toEqual([
      { title: "Clarify the accepted scope handoff", assigneeRole: "planner" },
      { title: "Implement the scoped thread cycle", assigneeRole: "engineer" },
    ]);
  });

  it("eng-review 1A: a FAILING confirmation entry does not sink the queued action (best-effort)", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const addEntry = vi.fn(async () => {
      throw new Error("db blip");
    });
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "scope it",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    const result = await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, loadLatestHumanEntry },
    });

    // The action queued, the run result still reports success — the decoration
    // failure is logged, not propagated (a failed run would never seal the action).
    expect(proposeThreadAction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ exitCode: 0, resultJson: { action: "queue_scope_draft" } });
  });

  it("non-Adjutant agents ignore controller_scope control (plain fake reply)", async () => {
    const proposeThreadAction = vi.fn();
    const addEntry = vi.fn();
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      agent: { id: "agent-scout", name: "Scout" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, loadLatestHumanEntry: vi.fn(async () => null) },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(addEntry).toHaveBeenCalledTimes(1); // Scout's normal fake reply
  });
});

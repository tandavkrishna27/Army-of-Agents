// BRW-004 slice (d) / E8-F002 — the distributed (agent-less, run-less) runtime decision.
//
// ★★★ WHY THIS FILE IS MOSTLY POSITIVE CONTROLS. Relaxing `agent_id` / `run_id` to nullable is
// a two-line schema change with EIGHT downstream hazards, and the design named exactly one of
// them (the timeout sweeper's `runCanceller`). Six more were found by measuring, and two of
// those — the createPrompt zombie-run guard and the answerPrompt liveness gate — would have
// shipped an approval feature that REFUSES EVERY ONE OF ITS OWN PROMPTS at creation and
// REJECTS EVERY ANSWER, with a completely green typecheck, because `getRunStatus(null)` finds
// no row and both guards read "no row" as "the run is terminal".
//
// That is the shape this programme calls its worst: a guard that cannot pass looks exactly
// like a guard that works. So every case below comes in a pair — the distributed arm takes the
// new branch, and the LEGACY arm proves the guard it skips still fires for a heartbeat run. A
// test that only shows the null path succeeding cannot tell "correctly skipped" from
// "accidentally disabled for everyone".
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  agentRuntimeDecisionService,
  runtimeDecisionSourceUniqueKey,
  standingGrantBinding,
  DISTRIBUTED_RUN_SENTINEL,
  STANDING_GRANT_UNBOUND_REASON,
} from "../services/agent-runtime-decisions.js";

const now = () => new Date("2026-09-04T12:00:00.000Z");
const LEGACY_RUN = "11111111-1111-4111-8111-111111111111";

function baseDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    companyId: "company-1",
    agentId: "agent-1",
    runId: LEGACY_RUN,
    adapterType: "claude_local",
    adapterSessionId: null,
    adapterSessionParams: null,
    kind: "permission",
    status: "shown",
    nonce: "nonce-1",
    sourceRevision: 2,
    promptHash: "hash-1",
    sourceUniqueKey: "k",
    title: "Allow navigation?",
    summary: null,
    promptText: null,
    toolName: null,
    command: null,
    commandHash: null,
    cwd: null,
    path: null,
    networkTarget: "https://site.test",
    riskClass: "network_egress",
    options: null,
    expiresAt: new Date("2026-09-04T12:15:00.000Z"),
    timeoutPolicy: "deny",
    decision: null,
    answerPayload: null,
    answerIdempotencyKey: null,
    answeredByUserId: null,
    answeredAt: null,
    relayedAt: null,
    relayError: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function makeService(repoOverrides: Record<string, unknown> = {}, depOverrides: Record<string, unknown> = {}) {
  const repo = {
    createDecision: vi.fn(async (input) => baseDecision(input as Record<string, unknown>)),
    getDecision: vi.fn(async () => baseDecision()),
    listActiveForRun: vi.fn(async () => []),
    getRunStatus: vi.fn(async () => "running" as string | null),
    listTrustRules: vi.fn(async () => []),
    createTrustRule: vi.fn(async () => ({})),
    revokeTrustRule: vi.fn(async () => ({})),
    markTrustRuleUsed: vi.fn(async () => {}),
    updateDecision: vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>)),
    answerWithTrustRule: vi.fn(async (_id, patch) => ({ decision: baseDecision(patch as Record<string, unknown>), rule: {} })),
    listDueForExpiry: vi.fn(async () => []),
    listStrandedAnswers: vi.fn(async () => []),
    ...repoOverrides,
  };
  const hubItems = {
    emit: vi.fn(async () => ({ id: "hub-1", version: 0 })),
    reconcile: vi.fn(async () => ({ healed: 0, closed: 0, refreshed: 0 })),
  };
  const runCanceller = (depOverrides.runCanceller as unknown) ?? vi.fn(async () => {});
  const service = agentRuntimeDecisionService({} as never, {
    repo: repo as never,
    hubItems: hubItems as never,
    activityLogger: vi.fn(async () => {}),
    runCanceller: runCanceller as never,
    now,
  });
  return { service, repo, hubItems, runCanceller };
}

const distributedPrompt = {
  companyId: "company-1",
  agentId: null,
  runId: null,
  adapterType: "claude_local",
  kind: "permission" as const,
  nonce: "nonce-browser-1",
  title: "Allow navigation to https://site.test?",
  networkTarget: "https://site.test",
  riskClass: "network_egress",
  timeoutPolicy: "deny" as const,
};

describe("E8-F002 — the source identity is null-safe, and there is exactly ONE implementation of it", () => {
  it("a legacy run renders exactly as it always did", () => {
    // The format for a non-null run is UNCHANGED, or every existing row's dedupe key moves.
    expect(runtimeDecisionSourceUniqueKey({ companyId: "c", runId: LEGACY_RUN, nonce: "n" })).toBe(
      `runtime:c:${LEGACY_RUN}:n`,
    );
  });

  it("a distributed decision renders an explicit sentinel, never the string \"null\"", () => {
    // Template-interpolating a null would have produced "runtime:c:null:n" — an identity that
    // works by accident and breaks the moment anyone edits the template.
    expect(runtimeDecisionSourceUniqueKey({ companyId: "c", runId: null, nonce: "n" })).toBe(
      `runtime:c:${DISTRIBUTED_RUN_SENTINEL}:n`,
    );
    expect(runtimeDecisionSourceUniqueKey({ companyId: "c", runId: null, nonce: "n" })).not.toContain("null");
  });

  it("★★★ the bridge DELEGATES to this helper — there is no second implementation to diverge", () => {
    // `job-approval-bridge.ts` used to re-implement this key as its own template literal, bound
    // to the service's only by a comment saying they must be byte-identical. Making `runId`
    // nullable would have required two independent literals to render null identically, by
    // accident, forever — and a divergence in a dedupe key does NOT fail loudly: the receipt
    // fast-path simply never hits, so every replay mints a duplicate aggregate.
    //
    // The copy is gone. This test is the anti-regression: it reads the bridge's SOURCE and
    // asserts it calls the shared helper and contains no `runtime:${...}` literal of its own.
    // A source-text assertion, because the bridge's function is not exported and the property
    // being protected is "there is only one implementation", which a value test cannot see.
    const bridgeSrc = readFileSync(
      fileURLToPath(new URL("../services/job-approval-bridge.ts", import.meta.url)),
      "utf8",
    );
    expect(bridgeSrc).toContain("runtimeDecisionSourceUniqueKey({ companyId, runId, nonce })");
    expect(bridgeSrc).not.toMatch(/return `runtime:\$\{/);
  });

  it("the shared helper is the one both paths agree on, for a legacy run and for null", () => {
    for (const runId of [LEGACY_RUN, null]) {
      const expected = `runtime:company-1:${runId ?? DISTRIBUTED_RUN_SENTINEL}:n1`;
      expect(runtimeDecisionSourceUniqueKey({ companyId: "company-1", runId, nonce: "n1" })).toBe(expected);
    }
  });
});

describe("E8-F002 — createPrompt's zombie-run guard is SKIPPED without a run, and still fires with one", () => {
  it("a distributed prompt is created without consulting run status", async () => {
    const { service, repo } = makeService();
    const result = await service.createPrompt(distributedPrompt);
    expect(result.decision).toBeTruthy();
    // The load-bearing assertion: the guard was not merely satisfied, it was not RUN.
    expect(repo.getRunStatus).not.toHaveBeenCalled();
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: null,
        runId: null,
        sourceUniqueKey: `runtime:company-1:${DISTRIBUTED_RUN_SENTINEL}:nonce-browser-1`,
      }),
    );
  });

  // ★★ POSITIVE CONTROL. Without this, "the guard was skipped for a null run" and "the guard
  // was disabled for everyone" are the same green test — and the second is a real regression
  // that would let a zombie CLI mint decisions against a cancelled run.
  it("POSITIVE CONTROL — a LEGACY prompt against a terminal run is still refused", async () => {
    const { service, repo } = makeService({ getRunStatus: vi.fn(async () => "cancelled") });
    await expect(
      service.createPrompt({ ...distributedPrompt, agentId: "agent-1", runId: LEGACY_RUN }),
    ).rejects.toThrow(/run is terminal/);
    expect(repo.getRunStatus).toHaveBeenCalledWith(LEGACY_RUN);
  });

  it("POSITIVE CONTROL — a LEGACY prompt against a live run is created, and DOES consult run status", async () => {
    const { service, repo } = makeService();
    await service.createPrompt({ ...distributedPrompt, agentId: "agent-1", runId: LEGACY_RUN });
    expect(repo.getRunStatus).toHaveBeenCalledWith(LEGACY_RUN);
  });
});

describe("E8-F002 — the hub projection drops the type CLAIM with the referent", () => {
  it("a distributed decision projects no heartbeat_run relation and no agent actor", async () => {
    const { service, hubItems } = makeService();
    await service.createPrompt(distributedPrompt);
    const emitted = (hubItems.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    // A hub item declaring relatedEntityType "heartbeat_run" with a null id is a row that lies
    // quietly. `relatedEntityId` is a nullable column and the ancestry lookup is guarded, so
    // nothing would have crashed — which is exactly why this needs an assertion.
    expect(emitted.relatedEntityType).toBeUndefined();
    expect(emitted.relatedEntityId).toBeUndefined();
    expect(emitted.sourceActorType).toBeUndefined();
    expect(emitted.sourceActorId).toBeUndefined();
  });

  // ★ POSITIVE CONTROL — the legacy projection is unchanged. Otherwise the fix above could
  // have been "stop projecting the relation at all", which would silently break every
  // heartbeat-run hub item's deep link.
  it("POSITIVE CONTROL — a LEGACY decision still projects the heartbeat_run relation and agent actor", async () => {
    const { service, hubItems } = makeService();
    await service.createPrompt({ ...distributedPrompt, agentId: "agent-1", runId: LEGACY_RUN });
    const emitted = (hubItems.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(emitted.relatedEntityType).toBe("heartbeat_run");
    expect(emitted.relatedEntityId).toBe(LEGACY_RUN);
    expect(emitted.sourceActorType).toBe("agent");
    expect(emitted.sourceActorId).toBe("agent-1");
  });
});

describe("E8-F002 — the timeout sweeper never aims a heartbeat cancellation at a run that does not exist", () => {
  const dueDistributed = () =>
    baseDecision({
      agentId: null,
      runId: null,
      status: "shown",
      timeoutPolicy: "cancel_run",
      expiresAt: new Date("2026-09-04T11:00:00.000Z"),
    });

  it("a distributed decision expires WITHOUT calling the run canceller", async () => {
    const cancel = vi.fn(async () => {});
    const { service } = makeService(
      {
        listDueForExpiry: vi.fn(async () => [dueDistributed()]),
        updateDecision: vi.fn(async (_id, patch) => baseDecision({ ...(patch as Record<string, unknown>), agentId: null, runId: null })),
      },
      { runCanceller: cancel },
    );
    const { processed } = await service.expireDuePrompts({ limit: 10 });
    expect(processed).toBe(1);
    // A cancellation aimed at a null run would be swallowed by the surrounding catch and be
    // indistinguishable from a successful cancel — a dead lever with a green test.
    expect(cancel).not.toHaveBeenCalled();
  });

  // ★ POSITIVE CONTROL — the same policy on a LEGACY decision DOES cancel. Without it, the
  // fix above is indistinguishable from having disabled run cancellation entirely.
  it("POSITIVE CONTROL — a LEGACY cancel_run expiry still cancels its run", async () => {
    const cancel = vi.fn(async () => {});
    const due = baseDecision({
      status: "shown",
      timeoutPolicy: "cancel_run",
      expiresAt: new Date("2026-09-04T11:00:00.000Z"),
    });
    const { service } = makeService(
      {
        listDueForExpiry: vi.fn(async () => [due]),
        updateDecision: vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>)),
      },
      { runCanceller: cancel },
    );
    await service.expireDuePrompts({ limit: 10 });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ runId: LEGACY_RUN }));
  });
});

describe("E8-F002 — answerPrompt's liveness gate is SKIPPED without a run, and still fires with one", () => {
  const distributedRow = () => baseDecision({ agentId: null, runId: null, status: "shown" });

  it("a founder can answer a distributed decision", async () => {
    // With the gate unguarded this path called `getRunStatus(null)`, read "no row" as
    // "terminal", cancelled the decision and threw 409 — so a browser prompt could be raised
    // and never answered. The prompt would exist; the answer would be impossible.
    const { service, repo } = makeService({
      getDecision: vi.fn(async () => distributedRow()),
      updateDecision: vi.fn(async (_id, patch) => baseDecision({ ...(patch as Record<string, unknown>), agentId: null, runId: null })),
    });
    const result = await service.answerPrompt({
      companyId: "company-1",
      decisionId: "decision-1",
      actorUserId: "founder-1",
      expectedSourceRevision: 2,
      nonce: "nonce-1",
      kind: "permission",
      decision: "allow_once",
      idempotencyKey: "answer-d1",
    });
    expect(result).toBeTruthy();
    expect(repo.getRunStatus).not.toHaveBeenCalled();
  });

  // ★★ POSITIVE CONTROL — the gate still protects a LEGACY answer whose run went terminal.
  // Without it, "skipped for a null run" and "removed for everyone" are the same green test,
  // and the second reintroduces the forever-stalled ghost the gate was added to prevent.
  it("POSITIVE CONTROL — a LEGACY answer against a terminal run is still refused", async () => {
    const { service, repo } = makeService({
      getDecision: vi.fn(async () => baseDecision({ status: "shown" })),
      getRunStatus: vi.fn(async () => "cancelled"),
    });
    await expect(
      service.answerPrompt({
        companyId: "company-1",
        decisionId: "decision-1",
        actorUserId: "founder-1",
        expectedSourceRevision: 2,
        nonce: "nonce-1",
        kind: "permission",
        decision: "allow_once",
        idempotencyKey: "answer-l1",
      }),
    ).rejects.toThrow(/run ended before the answer could be delivered/);
    expect(repo.getRunStatus).toHaveBeenCalledWith(LEGACY_RUN);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────
// ★★★ THE TENTH NULL-HAZARD, and the only one of the ten that is a PRIVILEGE ESCALATION rather
// than a broken lever. Everything above closes a null that would have made the feature refuse
// its own prompts; this one closes a null that would have made it grant too much.
//
// Design §D5 predicted it by name — "the moment slice (c) populates `networkTarget` …
// `allow_always` becomes reachable for browser egress" — and slice (c) shipped without the
// refusal §D5 says to land alongside it. It was found by adversarial review of PR #356, after
// the result doc had already claimed closure of "all NINE".
//
// The chain, each link real: `hasConcreteTrustScope` is satisfied by `riskClass` OR
// `networkTarget` ALONE → slice (c) sets both on every navigation → `answerPrompt` therefore
// admits `allow_always` → `buildTrustRuleInsert` copied the now-nullable `row.agentId` into the
// trust rule → and `trustRuleMatchesPrompt` skipped its agent clause on a null, so that rule was
// a WILDCARD IN THE AGENT DIMENSION. One founder answering "always allow this browser session to
// reach example.com" would have authorised sessions they never saw.
//
// ★ Blast radius re-derived rather than asserted: a match also needs equal `riskClass` and an exact
// `networkScope`, and the browser seam emits `network_egress` + a URL ORIGIN while the CLI hook
// bridge emits `network` + a bare HOSTNAME — so heartbeat prompts are out of reach TODAY by
// coincidence, not by design. The tests below therefore hold `riskClass`/`networkScope` EQUAL on
// both sides and vary only the agent, which isolates the dimension the guard actually closes.
// ────────────────────────────────────────────────────────────────────────────────────────────
describe("E8-F002 hazard 10 — a standing grant is REFUSED when there is no agent to bind it to", () => {
  const distributedRow = () => baseDecision({ agentId: null, runId: null, status: "shown" });
  const answer = (decision: string) => ({
    companyId: "company-1",
    decisionId: "decision-1",
    actorUserId: "founder-1",
    expectedSourceRevision: 2,
    nonce: "nonce-1",
    kind: "permission" as const,
    decision: decision as "allow_always",
    idempotencyKey: `answer-${decision}`,
  });

  it("★★★ allow_always on a distributed decision is refused, and NO trust rule is written", async () => {
    const { service, repo } = makeService({ getDecision: vi.fn(async () => distributedRow()) });
    await expect(service.answerPrompt(answer("allow_always"))).rejects.toThrow(/no agent/i);
    // The load-bearing half. A guard that throws AFTER writing the rule would have left the
    // wildcard grant behind and only made the founder's UI show an error.
    expect(repo.answerWithTrustRule).not.toHaveBeenCalled();
    expect(repo.createTrustRule).not.toHaveBeenCalled();
  });

  it("the refusal is NOT the pre-existing scope guard — the browser row HAS a concrete scope", async () => {
    // `hasConcreteTrustScope` passes here (networkTarget + riskClass are both set by slice (c)),
    // so this proves the NEW guard fired rather than the old one. Without it, deleting the new
    // guard could stay green behind an error that happens to also be a refusal.
    const row = distributedRow();
    expect(row.networkTarget).toBe("https://site.test");
    expect(row.riskClass).toBe("network_egress");
    expect(standingGrantBinding(row)).toBeNull();
    const { service } = makeService({ getDecision: vi.fn(async () => row) });
    await expect(service.answerPrompt(answer("allow_always")))
      .rejects.toThrow(STANDING_GRANT_UNBOUND_REASON);
    await expect(service.answerPrompt(answer("allow_always")))
      .rejects.not.toThrow(/concrete command, path, network, or risk scope/);
  });

  it("allow_run on a distributed decision is refused too", async () => {
    // Reachable only through a different door today (`runtimeRunGrantEligibility` already
    // refuses a network_egress row), which is exactly why it needs its own case: the run-scoped
    // rule is the WORSE of the two, because `buildRunTrustRuleInsert` sets `expiresAt: null`.
    // An unbound, never-expiring wildcard must not depend on an unrelated clause staying put.
    const row = baseDecision({
      agentId: null,
      runId: null,
      status: "shown",
      riskClass: "filesystem",
      networkTarget: null,
      cwd: "/work/repo",
      path: "/work/repo/src",
    });
    const { service, repo } = makeService({ getDecision: vi.fn(async () => row) });
    await expect(service.answerPrompt(answer("allow_run"))).rejects.toThrow(/no agent/i);
    expect(repo.answerWithTrustRule).not.toHaveBeenCalled();
  });

  it("allow_once on the SAME distributed decision still succeeds — the refusal is scoped", async () => {
    // ★ The anti-overreach control. A guard that refused every answer to a distributed decision
    // would pass all three tests above and break the feature completely, which is hazard 2's
    // failure shape arriving through a different door.
    const { service, repo } = makeService({
      getDecision: vi.fn(async () => distributedRow()),
      updateDecision: vi.fn(async (_id, patch) =>
        baseDecision({ ...(patch as Record<string, unknown>), agentId: null, runId: null })),
    });
    const result = await service.answerPrompt(answer("allow_once"));
    expect(result).toBeTruthy();
    expect(repo.updateDecision).toHaveBeenCalled();
    expect(repo.answerWithTrustRule).not.toHaveBeenCalled();
  });

  // ★★ POSITIVE CONTROL — the whole feature still works for a LEGACY decision. Without it,
  // "refused because unbound" and "allow_always removed for everyone" are the same green test.
  it("POSITIVE CONTROL — allow_always on a LEGACY decision still mints an agent-bound rule", async () => {
    const { service, repo } = makeService();
    await service.answerPrompt(answer("allow_always"));
    expect(repo.answerWithTrustRule).toHaveBeenCalledOnce();
    const rule = (repo.answerWithTrustRule as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][3] as Record<string, unknown>;
    expect(rule.agentId).toBe("agent-1");
    expect(rule.grantScope).toBe("persistent");
    expect(rule.networkScope).toBe("https://site.test");
  });

  it("POSITIVE CONTROL — allow_run on an eligible LEGACY decision still mints a run-bound rule", async () => {
    const { service, repo } = makeService({
      getDecision: vi.fn(async () => baseDecision({
        status: "shown",
        riskClass: "filesystem",
        networkTarget: null,
        cwd: "/work/repo",
        path: "/work/repo/src",
      })),
    });
    await service.answerPrompt(answer("allow_run"));
    const rule = (repo.answerWithTrustRule as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][3] as Record<string, unknown>;
    expect(rule.agentId).toBe("agent-1");
    expect(rule.runId).toBe(LEGACY_RUN);
    expect(rule.grantScope).toBe("run");
  });

  it("the binding predicate refuses a HALF-bound row, not only a fully unbound one", async () => {
    // The DB CHECK on `agent_runtime_decisions` already makes the pair all-or-nothing. This
    // asserts the service does not DEPEND on that check surviving: if it were ever dropped, a
    // half-bound row must still not mint a standing grant.
    expect(standingGrantBinding({ agentId: "agent-1", runId: null })).toBeNull();
    expect(standingGrantBinding({ agentId: null, runId: LEGACY_RUN })).toBeNull();
    expect(standingGrantBinding({ agentId: "agent-1", runId: LEGACY_RUN }))
      .toEqual({ agentId: "agent-1", runId: LEGACY_RUN });
  });
});

describe("E8-F002 hazard 10 — the READ half: a standing rule never crosses the agent boundary", () => {
  const egressRule = (overrides: Record<string, unknown> = {}) => ({
    id: "rule-1",
    companyId: "company-1",
    agentId: "agent-1",
    runId: null,
    grantScope: "persistent",
    adapterType: "claude_local",
    toolName: null,
    commandHash: null,
    pathScope: null,
    networkScope: "https://site.test",
    riskClass: "network_egress",
    enabled: true,
    expiresAt: null,
    createdByUserId: "founder-1",
    lastUsedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  });

  it("a DISTRIBUTED prompt is not auto-allowed by an agent-bound standing rule", async () => {
    const { service, repo } = makeService({ listTrustRules: vi.fn(async () => [egressRule()]) });
    await service.createPrompt(distributedPrompt);
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
    expect(repo.markTrustRuleUsed).not.toHaveBeenCalled();
  });

  it("★★★ an UNBOUND rule is not a company-wide wildcard for a DIFFERENT agent", async () => {
    // The escalation itself. Before the fix `trustRuleMatchesPrompt` read
    // `rule.agentId && rule.agentId !== input.agentId`, so a null agent matched everyone — and
    // the browser answer path was the only producer of such a rule. The write guard means one
    // can no longer be created; this proves that even if one arrived (a restored backup, a
    // hand-inserted row), it grants nothing.
    const { service, repo } = makeService({
      listTrustRules: vi.fn(async () => [egressRule({ agentId: null })]),
    });
    await service.createPrompt({ ...distributedPrompt, agentId: "some-other-agent", runId: LEGACY_RUN });
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
  });

  // ★★ POSITIVE CONTROL — the matcher still auto-allows the agent the rule was made for.
  // Without it, "the wildcard is gone" and "trust rules stopped working" are the same green.
  it("POSITIVE CONTROL — the SAME agent is still auto-allowed by its own standing rule", async () => {
    const { service, repo } = makeService({ listTrustRules: vi.fn(async () => [egressRule()]) });
    await service.createPrompt({ ...distributedPrompt, agentId: "agent-1", runId: LEGACY_RUN });
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "answered", decision: "allow_always" }),
    );
    expect(repo.markTrustRuleUsed).toHaveBeenCalled();
  });
});

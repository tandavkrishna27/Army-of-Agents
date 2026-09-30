// realRepo `answerWithTrustRule` transaction/dedup coverage.
//
// The service-level tests in agent-runtime-decisions.test.ts are the binding
// contract for the answer→trust-rule flow (they inject a fake repo). These tests
// exercise the *realRepo* implementation (deps.repo left undefined) end-to-end
// through the public `answerPrompt` API against a hand-rolled mock `db`, so the
// real transaction/dedup branch runs. They assert:
//   (1) the insert path (no existing scope match → tx.insert the new rule), and
//   (2) the dedup path (existing enabled scope match → tx.update refreshes it,
//       no second insert), both inside a single db.transaction whose result the
//       service returns atomically.
// Mock db pattern follows the createSequenceDb proxy in aoa-runs-total.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => {
  const passthrough = (...args: unknown[]) => ({ __op: args });
  return {
    and: passthrough,
    eq: passthrough,
    inArray: passthrough,
    isNull: passthrough,
    asc: passthrough,
    lte: passthrough,
    sql: new Proxy(() => ({ sql: true }), {
      get: () => () => ({ sql: true }),
      apply: () => ({ sql: true }),
    }),
  };
});

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    agentRuntimeDecisions: makeTable("agent_runtime_decisions"),
    agentRuntimeTrustRules: makeTable("agent_runtime_trust_rules"),
    heartbeatRuns: makeTable("heartbeat_runs"),
  };
});

import { agentRuntimeDecisionService } from "../services/agent-runtime-decisions.js";

const now = () => new Date("2026-07-01T12:00:00.000Z");
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    companyId: "company-1",
    agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local",
    adapterSessionId: null,
    adapterSessionParams: null,
    kind: "permission",
    status: "shown",
    nonce: "nonce-1",
    sourceRevision: 2,
    promptHash: "hash-1",
    sourceUniqueKey: "runtime:company-1:run:nonce-1",
    title: "Allow command?",
    summary: "Run tests",
    promptText: "pnpm test:run",
    toolName: "shell",
    command: "pnpm test:run",
    commandHash: "command-hash-1",
    cwd: "C:/repo",
    path: null,
    networkTarget: null,
    riskClass: "medium",
    options: null,
    expiresAt: new Date("2026-07-01T12:15:00.000Z"),
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

function trustRuleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    companyId: "company-1",
    agentId: "agent-1",
    adapterType: "claude_local",
    toolName: "shell",
    commandHash: "command-hash-1",
    pathScope: null,
    networkScope: null,
    riskClass: "medium",
    enabled: true,
    expiresAt: new Date(now().getTime() + NINETY_DAYS_MS),
    createdByUserId: "founder-1",
    lastUsedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

// Chainable stub: .then() resolves the getDecision select; .returning()/.limit()
// pop the queued transaction results in call order.
function makeChain(queue: unknown[][], counter: { i: number }) {
  const next = () => Promise.resolve(queue[Math.min(counter.i++, queue.length - 1)]);
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "set", "values", "orderBy"]) {
    chain[m] = () => chain;
  }
  chain.limit = () => next();
  chain.returning = () => next();
  // getDecision uses `.then((rows) => rows[0] ?? null)` directly on the select
  // chain (no .limit terminal in its promise resolution path other than .limit()
  // which returns the chain here). Support both by making the chain thenable too.
  chain.then = (resolve: (v: unknown) => unknown) => next().then(resolve);
  return chain;
}

// Builds a mock db where the outer getDecision select resolves `getDecisionRows`
// and db.transaction runs the callback with a tx driven by `txQueue`. The tx
// records which methods were called so tests can assert the branch taken
// (insert path vs. dedup/update path).
function makeDb(getDecisionRows: unknown[], txQueue: unknown[][]) {
  const txCalls = { update: 0, insert: 0, select: 0 };
  return {
    txCalls,
    select: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["from", "where", "orderBy"]) c[m] = () => c;
      c.limit = () => Promise.resolve(getDecisionRows);
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(getDecisionRows).then(resolve);
      return c;
    },
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const counter = { i: 0 };
      const tx = {
        update: () => { txCalls.update++; return makeChain(txQueue, counter); },
        insert: () => { txCalls.insert++; return makeChain(txQueue, counter); },
        select: () => { txCalls.select++; return makeChain(txQueue, counter); },
      };
      return cb(tx);
    }),
  } as any;
}

function makeService(db: any) {
  const emit = vi.fn(async () => ({ id: "hub-1", version: 0 }));
  const activityLogger = vi.fn(async () => {});
  const service = agentRuntimeDecisionService(db, {
    hubItems: { emit } as never,
    activityLogger,
    now,
  });
  return { service, emit, activityLogger };
}

const answerInput = {
  companyId: "company-1",
  decisionId: "decision-1",
  actorUserId: "founder-1",
  expectedSourceRevision: 2,
  nonce: "nonce-1",
  kind: "permission" as const,
  decision: "allow_always" as const,
};

describe("realRepo.answerWithTrustRule (mock db transaction)", () => {
  it("inserts a new rule inside the transaction when no enabled scope match exists", async () => {
    const decision = decisionRow({ status: "answered", decision: "allow_always", sourceRevision: 3 });
    const inserted = trustRuleRow({ id: "rule-new" });
    // tx queue: [decision update returning], [scope select limit = none], [rule insert returning]
    const db = makeDb([decisionRow()], [[decision], [], [inserted]]);
    const { service, emit } = makeService(db);

    const result = await service.answerPrompt(answerInput);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("answered");
    // Insert path: decision update + scope select + rule INSERT (no second update).
    expect(db.txCalls).toEqual({ update: 1, select: 1, insert: 1 });
    // emit runs after the transaction commits (rollback-before-emit invariant).
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("dedups onto an existing enabled rule (update, no second insert) inside the transaction", async () => {
    const decision = decisionRow({ status: "answered", decision: "allow_always", sourceRevision: 3 });
    const existing = trustRuleRow({ id: "rule-existing", expiresAt: new Date("2026-07-15T12:00:00.000Z") });
    const refreshed = trustRuleRow({
      id: "rule-existing",
      expiresAt: new Date(now().getTime() + NINETY_DAYS_MS),
    });
    // tx queue: [decision update], [scope select = existing], [rule update returning]
    const db = makeDb([decisionRow()], [[decision], [existing], [refreshed]]);
    const { service, activityLogger } = makeService(db);

    const result = await service.answerPrompt(answerInput);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("answered");
    // Dedup path: decision update + scope select + rule UPDATE (2 updates, no insert).
    expect(db.txCalls).toEqual({ update: 2, select: 1, insert: 0 });
    // The trust-rule audit row carries the refreshed rule id (dedup, not a new row).
    expect(activityLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "runtime_decision_trust_rule.created",
        entityId: "rule-existing",
      }),
    );
  });
});

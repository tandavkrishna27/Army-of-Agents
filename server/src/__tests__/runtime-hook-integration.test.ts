/**
 * runtime-hook-integration.test.ts — W5b Task 10
 *
 * In-process integration loop: route → broker.requestPermissionBounded →
 * agentRuntimeDecisionService.createPrompt → (answer via service.answerPrompt)
 * → markRelayed → route returns allow/deny.
 *
 * Approach used: REAL createHeartbeatRuntimeDecisionBroker + REAL
 * agentRuntimeDecisionService, with a Map-backed in-memory DecisionRepo.
 * No Postgres, no Drizzle, no embedded DB.
 *
 * Concurrency trick: the route calls requestPermissionBounded which internally
 * calls waitForAnswer (poll loop with pollIntervalMs=10ms). Since Node.js is
 * single-threaded we cannot "race" the answer while the route awaits. Instead:
 *
 *   1. The broker's `createPrompt` is intercepted via a `wrappedService` shim
 *      that, after creating the decision row, schedules the `answerPrompt` call
 *      on the next event-loop tick (setImmediate). This lets the route's
 *      `requestPermissionBounded` → `waitForAnswer` poll loop start before the
 *      answer arrives, exercising the full poll-then-relay path.
 *
 * The timeout test is covered by the stub variant (structural test only, not
 * requiring 300s) and explicitly marked as such.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentRuntimeDecisionService,
  type AgentRuntimeDecisionRow,
  type AgentRuntimeTrustRuleRow,
} from "../services/agent-runtime-decisions.js";
import { createHeartbeatRuntimeDecisionBroker } from "../services/heartbeat.js";
import {
  registerRuntimeHook,
  deregisterRuntimeHook,
  mintRuntimeHookToken,
} from "../services/runtime-hook-registry.js";
import { runtimeHooksRoutes } from "../routes/runtime-hooks.js";
import { RUNTIME_HOOK_PATH } from "@armyofagents/adapter-utils";

// ---------------------------------------------------------------------------
// In-memory DecisionRepo
// ---------------------------------------------------------------------------

/** Minimal in-memory implementation of the DecisionRepo interface. */
function makeInMemoryRepo() {
  const decisions = new Map<string, AgentRuntimeDecisionRow>();
  const trustRules = new Map<string, AgentRuntimeTrustRuleRow>();

  return {
    async createDecision(
      input: typeof import("@armyofagents/db").agentRuntimeDecisions.$inferInsert,
    ): Promise<AgentRuntimeDecisionRow> {
      const row: AgentRuntimeDecisionRow = {
        id: (input.id as string | undefined) ?? randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        adapterType: input.adapterType,
        adapterSessionId: input.adapterSessionId ?? null,
        adapterSessionParams: input.adapterSessionParams ?? null,
        kind: input.kind,
        status: input.status ?? "created",
        nonce: input.nonce,
        sourceRevision: input.sourceRevision ?? 0,
        promptHash: input.promptHash,
        sourceUniqueKey: input.sourceUniqueKey ?? null,
        title: input.title,
        summary: input.summary ?? null,
        promptText: input.promptText ?? null,
        toolName: input.toolName ?? null,
        command: input.command ?? null,
        commandHash: input.commandHash ?? null,
        cwd: input.cwd ?? null,
        path: input.path ?? null,
        networkTarget: input.networkTarget ?? null,
        riskClass: input.riskClass ?? null,
        options: (input.options ?? null) as AgentRuntimeDecisionRow["options"],
        expiresAt: input.expiresAt ?? null,
        timeoutPolicy: input.timeoutPolicy,
        decision: input.decision ?? null,
        answerPayload: (input.answerPayload ?? null) as AgentRuntimeDecisionRow["answerPayload"],
        answerIdempotencyKey: input.answerIdempotencyKey ?? null,
        answeredByUserId: input.answeredByUserId ?? null,
        answeredAt: input.answeredAt ?? null,
        relayedAt: null,
        relayError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      decisions.set(row.id, row);
      return row;
    },

    async getDecision(
      _companyId: string,
      decisionId: string,
    ): Promise<AgentRuntimeDecisionRow | null> {
      return decisions.get(decisionId) ?? null;
    },

    async listActiveForRun(input: {
      companyId: string;
      runId: string;
    }): Promise<AgentRuntimeDecisionRow[]> {
      const active = new Set(["created", "shown", "answered", "relay_failed"]);
      return [...decisions.values()].filter(
        (r) =>
          r.companyId === input.companyId &&
          r.runId === input.runId &&
          active.has(r.status),
      );
    },

    // R1 zombie-decision guard: these integration tests exercise a LIVE run, so
    // report "running" — createPrompt only refuses on terminal/missing runs.
    async getRunStatus(_runId: string): Promise<string | null> {
      return "running";
    },

    async listTrustRules(input: {
      companyId: string;
      adapterType?: string;
      includeDisabled?: boolean;
    }): Promise<AgentRuntimeTrustRuleRow[]> {
      return [...trustRules.values()].filter((r) => {
        if (r.companyId !== input.companyId) return false;
        if (input.adapterType && r.adapterType !== input.adapterType) return false;
        if (!input.includeDisabled && !r.enabled) return false;
        return true;
      });
    },

    async createTrustRule(
      input: typeof import("@armyofagents/db").agentRuntimeTrustRules.$inferInsert,
    ): Promise<AgentRuntimeTrustRuleRow> {
      const row: AgentRuntimeTrustRuleRow = {
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        adapterType: input.adapterType,
        toolName: input.toolName ?? null,
        commandHash: input.commandHash ?? null,
        pathScope: input.pathScope ?? null,
        networkScope: input.networkScope ?? null,
        riskClass: input.riskClass ?? null,
        enabled: input.enabled ?? true,
        expiresAt: input.expiresAt ?? null,
        createdByUserId: input.createdByUserId,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      trustRules.set(row.id, row);
      return row;
    },

    async revokeTrustRule(input: {
      companyId: string;
      ruleId: string;
    }): Promise<AgentRuntimeTrustRuleRow | null> {
      const rule = trustRules.get(input.ruleId);
      if (!rule || rule.companyId !== input.companyId) return null;
      const updated = { ...rule, enabled: false, updatedAt: new Date() };
      trustRules.set(rule.id, updated);
      return updated;
    },

    async markTrustRuleUsed(input: {
      ruleId: string;
      usedAt: Date;
    }): Promise<void> {
      const rule = trustRules.get(input.ruleId);
      if (rule) trustRules.set(rule.id, { ...rule, lastUsedAt: input.usedAt });
    },

    async updateDecision(
      decisionId: string,
      patch: Partial<typeof import("@armyofagents/db").agentRuntimeDecisions.$inferInsert>,
      guard?: { sourceRevision?: number; statuses?: string[] },
    ): Promise<AgentRuntimeDecisionRow | null> {
      const row = decisions.get(decisionId);
      if (!row) return null;
      if (guard?.sourceRevision !== undefined && row.sourceRevision !== guard.sourceRevision)
        return null;
      if (guard?.statuses?.length && !guard.statuses.includes(row.status)) return null;
      const updated: AgentRuntimeDecisionRow = {
        ...row,
        ...(patch as Partial<AgentRuntimeDecisionRow>),
        updatedAt: new Date(),
      };
      decisions.set(decisionId, updated);
      return updated;
    },

    async answerWithTrustRule(
      decisionId: string,
      patch: Partial<typeof import("@armyofagents/db").agentRuntimeDecisions.$inferInsert>,
      guard: { sourceRevision: number; statuses: string[] },
      trustRule: typeof import("@armyofagents/db").agentRuntimeTrustRules.$inferInsert,
    ): Promise<{
      decision: AgentRuntimeDecisionRow | null;
      rule: AgentRuntimeTrustRuleRow | null;
    }> {
      const updated = await this.updateDecision(decisionId, patch, guard);
      if (!updated) return { decision: null, rule: null };
      const rule = await this.createTrustRule(trustRule);
      return { decision: updated, rule };
    },

    async listDueForExpiry(input: {
      companyId?: string;
      now: Date;
      limit: number;
    }): Promise<AgentRuntimeDecisionRow[]> {
      const expirable = new Set(["created", "shown"]);
      return [...decisions.values()]
        .filter((r) => {
          if (!expirable.has(r.status)) return false;
          if (r.expiresAt && r.expiresAt.getTime() > input.now.getTime()) return false;
          if (input.companyId && r.companyId !== input.companyId) return false;
          return true;
        })
        .slice(0, input.limit);
    },

    // Expose the raw map for test assertions
    _decisions: decisions,
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const ACTOR_USER_ID = "founder-user";

const RUN = { id: RUN_ID, companyId: COMPANY_ID, agentId: AGENT_ID };
const AGENT = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  name: "Builder",
  adapterType: "claude_local",
};
const RUNTIME = {
  sessionId: "sess-001",
  sessionDisplayId: "display-001",
  sessionParams: { session: "display-001" },
  taskKey: "issue:42",
};

const BASE_HOOK_BODY = {
  session_id: "sess-001",
  cwd: "/workspace",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "ls /workspace" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const registeredTokens: string[] = [];

afterEach(() => {
  for (const token of registeredTokens.splice(0)) {
    deregisterRuntimeHook(token);
  }
});

/**
 * Build a service + broker pair where createPrompt is wrapped: after the real
 * createPrompt creates the decision row, it schedules an answerPrompt call via
 * setImmediate so the broker's waitForAnswer poll loop sees the answer on the
 * next event-loop turn.
 *
 * This lets the full wired loop exercise the real poll-and-relay path without
 * needing threads.
 */
function makeWiredPair(
  repo: ReturnType<typeof makeInMemoryRepo>,
  decision: "allow_once" | "deny",
) {
  // Build the real service first (it wraps repo internally)
  const service = agentRuntimeDecisionService({} as never, {
    repo,
    hubItems: {
      emit: async () => ({ id: randomUUID(), version: 0 } as never),
    },
    activityLogger: async () => {},
  });

  // Wrap createPrompt to schedule an answer after the decision row is persisted
  const wrappedService: typeof service = {
    ...service,
    async createPrompt(input) {
      const result = await service.createPrompt(input);
      const row = result.decision;
      // Schedule the answer on the next event-loop tick so the broker's poll
      // loop (which starts after createPrompt returns) can see the created row.
      setImmediate(() => {
        service
          .answerPrompt({
            companyId: row.companyId,
            decisionId: row.id,
            actorUserId: ACTOR_USER_ID,
            expectedSourceRevision: row.sourceRevision,
            nonce: row.nonce,
            kind: "permission",
            decision,
          })
          .catch(() => {
            // Ignore — if the row is already terminal the answer is a no-op
          });
      });
      return result;
    },
  };

  const broker = createHeartbeatRuntimeDecisionBroker({
    run: RUN,
    agent: AGENT,
    runtime: RUNTIME,
    runtimeDecisions: wrappedService,
    appendRunEvent: async () => {},
    markRunWaiting: async () => {},
    clearRunWaiting: async () => {},
    pollIntervalMs: 10,
  });

  return { service, broker };
}

function makeApp(
  token: string,
  broker: ReturnType<typeof createHeartbeatRuntimeDecisionBroker>,
) {
  registerRuntimeHook(token, {
    broker,
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    expiresAt: new Date(Date.now() + 60_000),
  });

  const app = express();
  app.use(express.json());
  app.use(runtimeHooksRoutes({} as never));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runtime-hook integration loop — route → broker → service → relay", () => {
  it(
    "allow_once: fires route, answers via service, route returns permissionDecision:allow",
    async () => {
      const repo = makeInMemoryRepo();
      const { broker } = makeWiredPair(repo, "allow_once");

      const token = mintRuntimeHookToken();
      registeredTokens.push(token);
      const app = makeApp(token, broker);

      const res = await request(app)
        .post(RUNTIME_HOOK_PATH)
        .set("Authorization", `Bearer ${token}`)
        .send(BASE_HOOK_BODY);

      expect(res.status).toBe(200);
      expect(res.body.hookSpecificOutput.permissionDecision).toBe("allow");

      // The decision should have been fully relayed by the time the route responds
      const decisions = [...repo._decisions.values()];
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.status).toBe("relayed");
      expect(decisions[0]?.decision).toBe("allow_once");
    },
    15_000,
  );

  it(
    "deny: fires route, answers deny via service, route returns permissionDecision:deny",
    async () => {
      const repo = makeInMemoryRepo();
      const { broker } = makeWiredPair(repo, "deny");

      const token = mintRuntimeHookToken();
      registeredTokens.push(token);
      const app = makeApp(token, broker);

      const res = await request(app)
        .post(RUNTIME_HOOK_PATH)
        .set("Authorization", `Bearer ${token}`)
        .send(BASE_HOOK_BODY);

      expect(res.status).toBe(200);
      expect(res.body.hookSpecificOutput.permissionDecision).toBe("deny");

      // After deny the decision should still be relayed (the broker marks it relayed
      // regardless of allow/deny so the adapter knows the answer was delivered)
      const decisions = [...repo._decisions.values()];
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.status).toBe("relayed");
      expect(decisions[0]?.decision).toBe("deny");
    },
    15_000,
  );
});

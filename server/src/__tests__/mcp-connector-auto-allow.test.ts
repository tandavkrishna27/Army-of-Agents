/**
 * FU-25: auto-allow an ASSIGNED connector's OWN tools in the runtime permission
 * broker. Three levels of coverage:
 *
 *  1. `parseConnectorServerName` — the pure security parser (charset, reserved
 *     names, malformed shapes).
 *  2. `isConnectorToolAutoAllowed` — the DB-backed matcher enforcing the four
 *     scoping rules (status, per-agent assignment, Commander, adapter gate).
 *  3. `agentRuntimeDecisionService.createPrompt` — the wiring: an auto-allowed
 *     connector tool is minted as an answered `allow_once` (no human, no
 *     timeout); everything else falls through to the existing path unchanged.
 *
 * ABLATION: deleting the connector-auto-allow branch in `createPrompt` (so
 * `connectorAutoAllowed` can never flip the status) turns the "answered /
 * allow_once" assertions in the last describe block red while leaving the
 * fall-through tests green.
 */

import { describe, expect, it, vi } from "vitest";
import { companyMcpConnectorAgents, companyMcpConnectors, type Db } from "@armyofagents/db";
import { parseConnectorServerName } from "../services/mcp-connectors.js";
import { isConnectorToolAutoAllowed } from "../services/mcp-connectors-loader.js";
import { agentRuntimeDecisionService } from "../services/agent-runtime-decisions.js";

vi.mock("../config.js", () => ({
  loadConfig: () => ({ deploymentMode: "local_trusted" }),
}));

// ---------------------------------------------------------------------------
// 1. parseConnectorServerName — pure parser
// ---------------------------------------------------------------------------

describe("parseConnectorServerName", () => {
  it("extracts the serverName from a well-formed mcp tool name", () => {
    expect(parseConnectorServerName("mcp__notion__get_page")).toBe("notion");
    expect(parseConnectorServerName("mcp__linear-app__create_issue")).toBe("linear-app");
  });

  it("takes the serverName at index 1 even when the tool portion contains __", () => {
    expect(parseConnectorServerName("mcp__notion__get__page")).toBe("notion");
  });

  it("returns null for reserved/bridge server names", () => {
    expect(parseConnectorServerName("mcp__aoa__get_task")).toBeNull();
    expect(parseConnectorServerName("mcp__playwright__click")).toBeNull();
  });

  it("returns null for a serverName outside the connector charset", () => {
    // Underscores in the serverName segment are impossible by construction (the
    // split is on __), but an uppercase / dotted name must still be rejected.
    expect(parseConnectorServerName("mcp__Notion__x")).toBeNull();
    expect(parseConnectorServerName("mcp__no.tion__x")).toBeNull();
  });

  it("safely returns null for malformed / degenerate tool names — never throws", () => {
    expect(parseConnectorServerName("mcp__")).toBeNull();
    expect(parseConnectorServerName("mcp__x")).toBeNull();
    expect(parseConnectorServerName("mcp__srv__")).toBeNull(); // empty tool portion
    expect(parseConnectorServerName("notmcp")).toBeNull();
    expect(parseConnectorServerName("Bash")).toBeNull();
    expect(parseConnectorServerName("")).toBeNull();
    expect(parseConnectorServerName(null)).toBeNull();
    expect(parseConnectorServerName(undefined)).toBeNull();
  });

  // FINDING 8 — a blank / separator-only tool portion must NOT resolve. The old
  // join+length check let " " and "__" through (non-empty strings), grantng the
  // connector's WHOLE toolset off a name with no real tool.
  it("returns null for a blank or separator-only tool portion", () => {
    expect(parseConnectorServerName("mcp__notion__ ")).toBeNull(); // single space
    expect(parseConnectorServerName("mcp__notion__\t")).toBeNull(); // tab
    expect(parseConnectorServerName("mcp__notion____")).toBeNull(); // separators only
    expect(parseConnectorServerName("mcp__notion__ __ ")).toBeNull(); // all-blank segments
  });
});

// ---------------------------------------------------------------------------
// 2. isConnectorToolAutoAllowed — DB-backed matcher
// ---------------------------------------------------------------------------

interface FakeConnectorRow {
  id: string;
  companyId: string;
  serverName: string;
  status: string;
  transport: string;
  source: string;
  trustTier: string | null;
}

function fakeDb(opts: {
  connectors: FakeConnectorRow[];
  links: Array<{ connectorId: string }>;
}): Db {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === companyMcpConnectors ? opts.connectors : opts.links,
      }),
    }),
  } as unknown as Db;
}

function connectorRow(overrides: Partial<FakeConnectorRow> = {}): FakeConnectorRow {
  return {
    id: "conn-1",
    companyId: "company-1",
    serverName: "notion",
    status: "active",
    transport: "http",
    source: "byo",
    trustTier: null,
    ...overrides,
  };
}

describe("isConnectorToolAutoAllowed", () => {
  const base = {
    companyId: "company-1",
    adapterType: "claude_local" as string | null,
    toolName: "mcp__notion__get_page" as string | null,
  };

  it("auto-allows an active connector assigned to this agent", async () => {
    const db = fakeDb({
      connectors: [connectorRow({ id: "conn-1", serverName: "notion" })],
      links: [{ connectorId: "conn-1" }],
    });
    await expect(
      isConnectorToolAutoAllowed(db, { ...base, agentId: "agent-1" }),
    ).resolves.toBe(true);
  });

  it("does NOT auto-allow a connector assigned to a DIFFERENT agent", async () => {
    // The connector exists and is active, but this agent has no link row for it.
    const db = fakeDb({
      connectors: [connectorRow({ id: "conn-1", serverName: "notion" })],
      links: [], // no assignment for this agent
    });
    await expect(
      isConnectorToolAutoAllowed(db, { ...base, agentId: "agent-2" }),
    ).resolves.toBe(false);
  });

  it("does NOT auto-allow a non-active connector (needs_credentials / disabled)", async () => {
    for (const status of ["needs_credentials", "pending_approval", "disabled"]) {
      const db = fakeDb({
        connectors: [connectorRow({ id: "conn-1", serverName: "notion", status })],
        links: [{ connectorId: "conn-1" }],
      });
      await expect(
        isConnectorToolAutoAllowed(db, { ...base, agentId: "agent-1" }),
        `status=${status} must not auto-allow`,
      ).resolves.toBe(false);
    }
  });

  it("auto-allows for Commander (agentId null) when the connector is active", async () => {
    const db = fakeDb({
      connectors: [connectorRow({ id: "conn-1", serverName: "notion" })],
      links: [], // Commander has no link rows; the query is skipped
    });
    await expect(
      isConnectorToolAutoAllowed(db, { ...base, agentId: null }),
    ).resolves.toBe(true);
  });

  it("does NOT auto-allow Commander for a non-active connector", async () => {
    const db = fakeDb({
      connectors: [connectorRow({ status: "needs_credentials" })],
      links: [],
    });
    await expect(
      isConnectorToolAutoAllowed(db, { ...base, agentId: null }),
    ).resolves.toBe(false);
  });

  it("does NOT auto-allow when the tool's serverName matches no company connector", async () => {
    const db = fakeDb({
      connectors: [connectorRow({ serverName: "linear" })],
      links: [{ connectorId: "conn-1" }],
    });
    await expect(
      isConnectorToolAutoAllowed(db, {
        ...base,
        agentId: "agent-1",
        toolName: "mcp__notion__get_page",
      }),
    ).resolves.toBe(false);
  });

  it("returns false without querying for a reserved / malformed / non-connector tool", async () => {
    const select = vi.fn();
    const db = { select } as unknown as Db;
    for (const toolName of ["mcp__aoa__get_task", "Bash", "mcp__", "mcp__x", null]) {
      await expect(
        isConnectorToolAutoAllowed(db, { ...base, agentId: "agent-1", toolName }),
      ).resolves.toBe(false);
    }
    expect(select).not.toHaveBeenCalled();
  });

  it("returns false without querying when the adapter cannot host MCP connectors", async () => {
    const select = vi.fn();
    const db = { select } as unknown as Db;
    await expect(
      isConnectorToolAutoAllowed(db, {
        ...base,
        agentId: "agent-1",
        adapterType: "process",
      }),
    ).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. createPrompt wiring
// ---------------------------------------------------------------------------

const now = () => new Date("2026-07-25T12:00:00.000Z");

function baseDecisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    companyId: "company-1",
    agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local",
    adapterSessionId: null,
    adapterSessionParams: null,
    kind: "permission",
    status: "created",
    nonce: "nonce-1",
    sourceRevision: 0,
    promptHash: "hash-1",
    sourceUniqueKey: null,
    title: "Allow tool?",
    summary: null,
    promptText: null,
    toolName: null,
    command: null,
    commandHash: null,
    cwd: null,
    path: null,
    networkTarget: null,
    riskClass: null,
    options: null,
    expiresAt: new Date("2026-07-25T13:00:00.000Z"),
    timeoutPolicy: "escalate",
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
    runId: null,
    grantScope: "persistent",
    adapterType: "claude_local",
    // A connector-shaped tool name: a founder who previously chose "always allow"
    // for this connector's tool created this rule.
    toolName: "mcp__notion__get_page",
    commandHash: null,
    pathScope: null,
    networkScope: null,
    riskClass: null,
    enabled: true,
    expiresAt: null,
    createdByUserId: "founder-1",
    lastUsedAt: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function makeService(
  connectorAutoAllow: (i: unknown) => Promise<boolean>,
  trustRules: Array<Record<string, unknown>> = [],
) {
  const repo = {
    createDecision: vi.fn(async (input) => baseDecisionRow(input as Record<string, unknown>)),
    getDecision: vi.fn(async () => baseDecisionRow()),
    listActiveForRun: vi.fn(async () => []),
    getRunStatus: vi.fn(async () => "running" as string | null),
    listTrustRules: vi.fn(async () => trustRules),
    createTrustRule: vi.fn(),
    revokeTrustRule: vi.fn(),
    markTrustRuleUsed: vi.fn(async () => {}),
    updateDecision: vi.fn(),
    answerWithTrustRule: vi.fn(),
    listDueForExpiry: vi.fn(async () => []),
    listStrandedAnswers: vi.fn(async () => []),
  };
  const hubItems = {
    emit: vi.fn(async () => ({ id: "hub-1", version: 0 })),
    reconcile: vi.fn(async () => ({ healed: 0, closed: 0, refreshed: 0 })),
  };
  const activityLogger = vi.fn(async () => {});
  const service = agentRuntimeDecisionService({} as never, {
    repo: repo as never,
    hubItems: hubItems as never,
    activityLogger,
    now,
    connectorAutoAllow: connectorAutoAllow as never,
  });
  return { service, repo, activityLogger };
}

function connectorPrompt(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local",
    kind: "permission" as const,
    nonce: "nonce-1",
    title: "Allow mcp__notion__get_page?",
    toolName: "mcp__notion__get_page",
    timeoutPolicy: "escalate" as const,
    ...overrides,
  };
}

describe("createPrompt connector auto-allow", () => {
  it("mints an answered allow_once decision for an assigned connector tool (no human)", async () => {
    const probe = vi.fn(async () => true);
    const { service, repo, activityLogger } = makeService(probe);

    const { decision } = await service.createPrompt(connectorPrompt());

    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "claude_local",
        toolName: "mcp__notion__get_page",
      }),
    );
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "answered",
        sourceRevision: 1,
        decision: "allow_once",
        answeredAt: now(),
        answeredByUserId: null,
      }),
    );
    expect(decision.status).toBe("answered");
    expect(decision.decision).toBe("allow_once");
    // Human-less allow is audited.
    expect(activityLogger).toHaveBeenCalledWith(
      expect.objectContaining({ action: "runtime_decision.connector_auto_allowed" }),
    );
    // No trust rule is minted for a connector grant.
    expect(repo.markTrustRuleUsed).not.toHaveBeenCalled();
  });

  it("falls through to a normal created decision when the connector does not match this agent", async () => {
    const probe = vi.fn(async () => false); // e.g. assigned to a different agent
    const { service, repo, activityLogger } = makeService(probe);

    const { decision } = await service.createPrompt(connectorPrompt());

    expect(probe).toHaveBeenCalledOnce();
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", sourceRevision: 0, decision: null }),
    );
    expect(decision.status).toBe("created");
    expect(activityLogger).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "runtime_decision.connector_auto_allowed" }),
    );
  });

  it("does NOT probe connectors for a non-connector tool (Bash) — unchanged path", async () => {
    const probe = vi.fn(async () => true);
    const { service, repo } = makeService(probe);

    await service.createPrompt(
      connectorPrompt({ toolName: "Bash", nonce: "nonce-bash", command: "ls" }),
    );

    expect(probe).not.toHaveBeenCalled();
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
  });

  it("does NOT probe connectors for the AoA bridge tool (mcp__aoa__*)", async () => {
    const probe = vi.fn(async () => true);
    const { service, repo } = makeService(probe);

    await service.createPrompt(
      connectorPrompt({ toolName: "mcp__aoa__get_task", nonce: "nonce-aoa" }),
    );

    expect(probe).not.toHaveBeenCalled();
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
  });

  it("is fail-safe: a probe error falls through to the human path, never fail-open", async () => {
    const probe = vi.fn(async () => {
      throw new Error("db down");
    });
    const { service, repo } = makeService(probe);

    const { decision } = await service.createPrompt(connectorPrompt());

    expect(probe).toHaveBeenCalledOnce();
    expect(decision.status).toBe("created");
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3b. Codex-3: a matching trust rule must NOT override the live connector probe
//     for a connector-shaped tool. Disabling/unassigning a connector revokes
//     auto-allow of its tools even if a prior "always allow" trust rule exists.
//
// ABLATION: revert the Codex-3 gate (compute `trustRuleHonored` as
// `matchingTrustRule != null` without the `|| connectorProbePassed` precondition,
// and probe only when there is no trust rule) → the first test below goes RED
// (the stale trust rule would auto-allow a disabled/unassigned connector).
// ---------------------------------------------------------------------------

describe("createPrompt connector probe overrides a stale trust rule (Codex-3)", () => {
  it("does NOT auto-allow a connector tool when the connector is now disabled/unassigned, even with an always-allow trust rule", async () => {
    // The connector was later disabled or unassigned → the live probe MISSES.
    const probe = vi.fn(async () => false);
    const { service, repo, activityLogger } = makeService(probe, [trustRuleRow()]);

    const { decision } = await service.createPrompt(connectorPrompt());

    // The probe IS consulted for a connector-shaped tool even though a trust rule matches.
    expect(probe).toHaveBeenCalledOnce();
    // Falls through: no auto-allow, no trust-rule honor.
    expect(decision.status).toBe("created");
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", sourceRevision: 0, decision: null, answeredByUserId: null }),
    );
    // The stale trust rule is NOT marked used, and nothing is audited as auto-allowed.
    expect(repo.markTrustRuleUsed).not.toHaveBeenCalled();
    expect(activityLogger).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "runtime_decision.connector_auto_allowed" }),
    );
  });

  it("auto-allows the same connector tool while the connector is active+assigned (trust rule sets the scope)", async () => {
    const probe = vi.fn(async () => true);
    const { service, repo, activityLogger } = makeService(probe, [trustRuleRow()]);

    const { decision } = await service.createPrompt(connectorPrompt());

    expect(probe).toHaveBeenCalledOnce();
    // The trust rule is honored (probe passed) → its own scope, not allow_once.
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "answered",
        sourceRevision: 1,
        decision: "allow_always",
        answeredByUserId: "founder-1",
      }),
    );
    expect(decision.status).toBe("answered");
    // The honored trust rule is marked used; this is NOT a connector-only grant, so no auto-allow audit.
    expect(repo.markTrustRuleUsed).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "rule-1" }),
    );
    expect(activityLogger).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "runtime_decision.connector_auto_allowed" }),
    );
  });

  it("leaves a NON-connector trust rule (Bash) byte-identical — no probe, still honored", async () => {
    const probe = vi.fn(async () => true);
    const bashRule = trustRuleRow({ toolName: null, commandHash: null });
    const { service, repo } = makeService(probe, [bashRule]);

    const { decision } = await service.createPrompt(
      connectorPrompt({ toolName: "Bash", nonce: "nonce-bash", command: "ls" }),
    );

    // Non-connector tool → probe never runs, trust rule honored exactly as before.
    expect(probe).not.toHaveBeenCalled();
    expect(decision.status).toBe("answered");
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "answered", decision: "allow_always" }),
    );
    expect(repo.markTrustRuleUsed).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: "rule-1" }),
    );
  });

  it("a probe error on a connector tool with a matching trust rule fails CLOSED (falls through)", async () => {
    const probe = vi.fn(async () => {
      throw new Error("db down");
    });
    const { service, repo } = makeService(probe, [trustRuleRow()]);

    const { decision } = await service.createPrompt(connectorPrompt());

    expect(probe).toHaveBeenCalledOnce();
    // A probe error must never let the stale trust rule allow.
    expect(decision.status).toBe("created");
    expect(repo.createDecision).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created", decision: null }),
    );
    expect(repo.markTrustRuleUsed).not.toHaveBeenCalled();
  });
});

/**
 * U2b unit test — `resolveBrokerToolContext` (server/src/mcp/broker-tool-context.ts)
 * against a MOCKED db. Runs on every platform (no embedded-postgres), so this
 * is the local proof that the resolver's shape and the company-mismatch guard
 * actually work — the companion `.test.ts` integration file proves the same
 * contract against real Postgres but skips on Windows.
 *
 * `@armyofagents/db` / `drizzle-orm` are Proxy-mocked (see helpers/drizzle-mock.ts
 * header comment) to avoid the drizzle-orm ESM circular-dependency issue this
 * repo's test suite works around everywhere. `service-container.js` and
 * `tool-registry.js` are also module-mocked (same convention as
 * confirm-ownership.test.ts / aoa-dispatcher.test.ts) so the test doesn't pull
 * in the full ~90-tool registry or the full service container — only
 * `deriveEnabledCapabilities` (a pure function, real import) is exercised for
 * real, against a small fixture registry.
 */
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  issues: makeTableProxy("issues"),
  discussions: makeTableProxy("discussions"),
}));
const servicesMarker = { __marker: "services" };
vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => servicesMarker),
}));
// Minimal fixture registry — just enough for deriveEnabledCapabilities (the
// REAL, unmocked pure function) to map "query_memory" -> "memory" category ->
// "memory_management" capability, same as the production tool registry does.
vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: () => [
    { name: "query_memory", category: "memory" },
    { name: "query_tasks", category: "query" },
  ],
}));
// The real heartbeat-mcp.ts pulls in cli-mode.ts's heavy adapter/provider
// dependency chain — irrelevant to this resolver unit test and risky to load
// under the mocked "@armyofagents/db" above (deep imports elsewhere in that
// chain could reference exports this mock doesn't provide). Stub the three
// symbols broker-tool-context.ts actually imports. ORG_HEARTBEAT_TOOL_ALLOWLIST
// mirrors the real list (asserted verbatim in heartbeat-mcp.test.ts);
// resolveHeartbeatEffectiveAutonomy mirrors the real (pure, separately
// tested) formula so this file's org-path assertions stay meaningful.
// `vi.mock` factories are hoisted above top-level const declarations, so the
// fixture values live in `vi.hoisted` (vitest's documented escape hatch —
// see https://vitest.dev/api/vi.html#vi-hoisted) rather than a plain const.
const { MOCK_ORG_HEARTBEAT_TOOL_ALLOWLIST, MOCK_ORG_HEARTBEAT_ENABLED_CAPABILITIES } = vi.hoisted(() => ({
  MOCK_ORG_HEARTBEAT_TOOL_ALLOWLIST: [
    "get_task",
    "get_heartbeat_context",
    "post_task_comment",
    "attach_task_artifact",
    "set_task_status",
    "ask_human",
    "ask_founder",
    "query_memory",
  ],
  MOCK_ORG_HEARTBEAT_ENABLED_CAPABILITIES: [
    "discussion_processing",
    "system_actions",
    "memory_management",
  ],
}));
vi.mock("../services/heartbeat-mcp.js", () => ({
  ORG_HEARTBEAT_TOOL_ALLOWLIST: MOCK_ORG_HEARTBEAT_TOOL_ALLOWLIST,
  ORG_HEARTBEAT_ENABLED_CAPABILITIES: MOCK_ORG_HEARTBEAT_ENABLED_CAPABILITIES,
  resolveHeartbeatEffectiveAutonomy: (input: {
    companyAutonomyLevel: number | null | undefined;
    discussionAutonomyLevel: number | null | undefined;
  }) => {
    const resolved = input.discussionAutonomyLevel ?? input.companyAutonomyLevel ?? 0;
    return resolved === 1 || resolved === 2 ? resolved : 0;
  },
}));

import { resolveBrokerToolContext } from "../mcp/broker-tool-context.js";

/** Chainable `.from().where().limit()` stub resolving to `rows` however far the chain is called. */
function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  c.from = () => c;
  c.where = () => c;
  c.limit = () => Promise.resolve(rows);
  c.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

describe("resolveBrokerToolContext (unit, mocked db)", () => {
  it("resolves a ToolContext from the agent row + company config row, reusing the crew allowlist/capability derivation", async () => {
    const agentRow = {
      id: "agent-1",
      companyId: "co-1",
      kind: "aoa",
      runtimeConfig: { aoa: { toolAllowlist: ["query_memory", "query_tasks"] } },
    };
    const configRow = { crewAutonomyLevel: 1 };

    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        return selectCall === 1 ? chain([agentRow]) : chain([configRow]);
      },
    } as never;

    const ctx = await resolveBrokerToolContext({
      db,
      companyId: "co-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(ctx.actorType).toBe("agent");
    expect(ctx.agentKind).toBe("aoa");
    expect(ctx.agentId).toBe("agent-1");
    expect(ctx.runId).toBe("run-1");
    expect(ctx.companyId).toBe("co-1");
    expect(ctx.toolAllowlist).toEqual(["query_memory", "query_tasks"]);
    // deriveEnabledCapabilities: baseline ["discussion_processing"] + "memory_management"
    // (query_memory's category "memory" maps to it); "query_tasks" -> category
    // "query" is unmapped in CAPABILITY_TO_CATEGORY, so it grants nothing extra.
    expect(ctx.enabledCapabilities).toEqual(["discussion_processing", "memory_management"]);
    // D18: reads crewAutonomyLevel, never autonomyLevel.
    expect(ctx.effectiveAutonomy).toBe(1);
    // Commander-only fields must never be set for an agent actor.
    expect(ctx.commanderToolPermissions).toBeUndefined();
    expect(ctx.runtimeApprovalsEnabled).toBeUndefined();
    expect(ctx.db).toBe(db);
    expect(ctx.services).toBe(servicesMarker);
    expect(selectCall).toBe(2);
  });

  it("throws a 403-shaped error when the agent belongs to a different company", async () => {
    const agentRow = { id: "agent-1", companyId: "co-OTHER", kind: "aoa", runtimeConfig: {} };
    const db = { select: () => chain([agentRow]) } as never;

    await expect(
      resolveBrokerToolContext({ db, companyId: "co-1", agentId: "agent-1", runId: "run-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws a 403-shaped error when the agent does not exist (never distinguishes from cross-tenant)", async () => {
    const db = { select: () => chain([]) } as never;

    await expect(
      resolveBrokerToolContext({ db, companyId: "co-1", agentId: "missing", runId: "run-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("defaults effectiveAutonomy to 0 and toolAllowlist to [] when config/runtimeConfig are absent", async () => {
    const agentRow = { id: "agent-1", companyId: "co-1", kind: "aoa", runtimeConfig: {} };
    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        return selectCall === 1 ? chain([agentRow]) : chain([]);
      },
    } as never;

    const ctx = await resolveBrokerToolContext({
      db,
      companyId: "co-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(ctx.effectiveAutonomy).toBe(0);
    expect(ctx.toolAllowlist).toEqual([]);
    expect(ctx.enabledCapabilities).toEqual(["discussion_processing"]);
  });

  // Wave 1 review, FIX A: the resolver must reproduce ORG heartbeat authz
  // (never fall through to the crew/'aoa' derivation, which would read
  // agent.runtimeConfig.aoa.toolAllowlist — absent on an org agent — and
  // silently allowlist zero tools).
  it("org kind: userRole team_member, ORG_HEARTBEAT_TOOL_ALLOWLIST, ORG_HEARTBEAT_ENABLED_CAPABILITIES, and effectiveAutonomy from the company dial when there is no source-Discussion override", async () => {
    const agentRow = { id: "agent-org-1", companyId: "co-1", kind: "org", runtimeConfig: {} };
    const configRow = { crewAutonomyLevel: 2 };

    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        if (selectCall === 1) return chain([agentRow]);
        if (selectCall === 2) return chain([configRow]);
        // select #3: heartbeat_runs lookup for the discussion-override chain
        // finds no row (no context_snapshot.issueId) -> no further selects.
        return chain([]);
      },
    } as never;

    const ctx = await resolveBrokerToolContext({
      db,
      companyId: "co-1",
      agentId: "agent-org-1",
      runId: "run-org-1",
    });

    expect(ctx.actorType).toBe("agent");
    expect(ctx.agentKind).toBe("org");
    expect(ctx.userRole).toBe("team_member");
    expect(ctx.toolAllowlist).toEqual(MOCK_ORG_HEARTBEAT_TOOL_ALLOWLIST);
    expect(ctx.enabledCapabilities).toEqual(MOCK_ORG_HEARTBEAT_ENABLED_CAPABILITIES);
    // No source-Discussion override found -> falls back to the company dial.
    expect(ctx.effectiveAutonomy).toBe(2);
    expect(ctx.commanderToolPermissions).toBeUndefined();
    expect(ctx.runtimeApprovalsEnabled).toBeUndefined();
    expect(ctx.db).toBe(db);
    expect(ctx.services).toBe(servicesMarker);
    expect(selectCall).toBe(3);
  });

  it("org kind: a source-Discussion autonomy override beats the company dial (heartbeat_runs.context_snapshot.issueId -> issues.source_discussion_id -> discussions.autonomy_level)", async () => {
    const agentRow = { id: "agent-org-2", companyId: "co-1", kind: "org", runtimeConfig: {} };
    const configRow = { crewAutonomyLevel: 2 };
    const runRow = { contextSnapshot: { issueId: "issue-1" } };
    const issueRow = { sourceDiscussionId: "discussion-1" };
    const discussionRow = { autonomyLevel: 1 };

    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        if (selectCall === 1) return chain([agentRow]);
        if (selectCall === 2) return chain([configRow]);
        if (selectCall === 3) return chain([runRow]);
        if (selectCall === 4) return chain([issueRow]);
        return chain([discussionRow]);
      },
    } as never;

    const ctx = await resolveBrokerToolContext({
      db,
      companyId: "co-1",
      agentId: "agent-org-2",
      runId: "run-org-2",
    });

    // Company dial is 2 (Drive); the Discussion override (1, Assist) must win —
    // proves the chain actually threads through, not just falls back to ?? 0.
    expect(ctx.effectiveAutonomy).toBe(1);
    expect(selectCall).toBe(5);
  });

  it("org kind: a failed discussion-override lookup falls back to the company dial instead of throwing (best-effort)", async () => {
    const agentRow = { id: "agent-org-3", companyId: "co-1", kind: "org", runtimeConfig: {} };
    const configRow = { crewAutonomyLevel: 1 };

    let selectCall = 0;
    const db = {
      select: () => {
        selectCall += 1;
        if (selectCall === 1) return chain([agentRow]);
        if (selectCall === 2) return chain([configRow]);
        // select #3 (heartbeat_runs lookup) throws — e.g. a transient DB error.
        throw new Error("simulated DB error");
      },
    } as never;

    const ctx = await resolveBrokerToolContext({
      db,
      companyId: "co-1",
      agentId: "agent-org-3",
      runId: "run-org-3",
    });

    expect(ctx.effectiveAutonomy).toBe(1);
  });

  // Wave 1 review, FIX A: any kind other than 'aoa'/'org' must fail closed —
  // authorize-tool.ts's allowlist gate only activates for those two kinds, so
  // without this the resolver would hand back a ToolContext for a kind (e.g.
  // 'platform') that skips the allowlist check entirely at dispatch time.
  it("unsupported agent kind (e.g. 'platform'): throws a 403-shaped error instead of resolving a ToolContext", async () => {
    const agentRow = { id: "agent-platform-1", companyId: "co-1", kind: "platform", runtimeConfig: {} };
    const db = { select: () => chain([agentRow]) } as never;

    await expect(
      resolveBrokerToolContext({ db, companyId: "co-1", agentId: "agent-platform-1", runId: "run-1" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

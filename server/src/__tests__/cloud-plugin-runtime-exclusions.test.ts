/**
 * FND-008 (Decision #103 CP-003/CP-004) — cloud plugin RUNTIME + browser-surface
 * exclusion matrix, UNIT-LOCAL portion.
 *
 * This file holds the parts that RUN on every platform (no embedded Postgres, no
 * route/app import that would tip the graph into the drizzle-orm `require(esm)`
 * cycle — E0-F005): the MCP broker plugin-tool DISPATCH denial, the stable 503
 * envelope contract, and the six-sink cloud-gate re-affirmation. The real HTTP
 * route matrix (install/uninstall/upgrade/enable/disable/tools/jobs/webhooks/
 * bridge/stream/ui-contributions/config-test + the company + settings routers,
 * with install-I/O / dispatch / static-byte sentinels) imports `pluginRoutes`
 * and therefore lives in the companion `cloud-plugin-runtime-exclusions.integration.test.ts`
 * (Windows-collection-skip on the drizzle cycle, Linux-CI-authoritative), exactly
 * like `plugin-tenant-routes.test.ts`.
 *
 * The MCP broker denial is the intentional RED case here: on the PR #320 /
 * FND-007 baseline `dispatchPluginToolCall` has NO cloud gate, so it reaches the
 * dispatcher and calls `executeTool` even under `cloud_auth`. FND-008 adds the
 * typed denial BEFORE any dispatch effect. The envelope + sink-matrix + off-cloud
 * cases are passing characterization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

// Mock the drizzle surface so importing `plugin-broker-tools.ts` (which pulls
// `agentProjects`/`issues` + `and`/`eq`) never tips into the ESM cycle on
// Windows — the same convention as broker-tool-context.unit.test.ts.
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  agentProjects: makeTableProxy("agent_projects"),
  issues: makeTableProxy("issues"),
}));

import {
  dispatchPluginToolCall,
  readPluginToolDefinitions,
} from "../mcp/tools/plugin-broker-tools.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  cloudPluginExecutionBlockedEnvelope,
  isCloudPluginExecutionBlocked,
} from "../services/cloud-plugin-execution.js";

const COMPANY = "co-1";
const TOOL = "acme.linear:search";

/** Chainable `.from().where().limit()` db stub resolving to []. */
function stubDb() {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve([]);
  return { select: () => chain } as never;
}

function fakeDispatcher(executeTool = vi.fn(async () => ({ result: { ok: true } }))) {
  return {
    executeTool,
    getTool: (_name: string, companyId: string) => ({
      companyId,
      pluginDbId: "plugin-1",
    }),
    listToolsForAgent: (_filter: { companyId: string }) => [
      { name: TOOL, description: "Search", parametersSchema: { type: "object" } },
    ],
  };
}

function installDispatcher(dispatcher: unknown) {
  (globalThis as Record<string, unknown>).__paperclipPluginToolDispatcher =
    dispatcher;
}

beforeEach(() => {
  setDeploymentMode("local_trusted");
  delete (globalThis as Record<string, unknown>).__paperclipPluginToolDispatcher;
});

afterEach(() => {
  setDeploymentMode("local_trusted");
  delete (globalThis as Record<string, unknown>).__paperclipPluginToolDispatcher;
});

describe("FND-008 — MCP broker plugin-tool dispatch denial (cloud_auth)", () => {
  it("RED→GREEN: denies dispatch with the typed block message BEFORE reaching the dispatcher on cloud_auth", async () => {
    setDeploymentMode("cloud_auth");
    const executeTool = vi.fn(async () => ({ result: { ok: true } }));
    installDispatcher(fakeDispatcher(executeTool));

    const outcome = await dispatchPluginToolCall({
      db: stubDb(),
      companyId: COMPANY,
      actorSource: "agent",
      agentId: "agent-1",
      runId: "run-1",
      name: TOOL,
      args: { query: "x" },
    });

    // The non-HTTP MCP dispatcher fails closed with its typed equivalent BEFORE
    // any dispatch/effect — the worker is never reached (dispatch sentinel).
    expect(outcome.kind).toBe("forbidden");
    expect(outcome.kind === "forbidden" && outcome.message).toBe(
      CLOUD_PLUGIN_BLOCK_MESSAGE
    );
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("characterization: OFF cloud, a registered agent tool call still dispatches to the worker", async () => {
    setDeploymentMode("local_trusted");
    const executeTool = vi.fn(async () => ({ result: { ok: true } }));
    installDispatcher(fakeDispatcher(executeTool));

    const outcome = await dispatchPluginToolCall({
      db: stubDb(),
      companyId: COMPANY,
      actorSource: "agent",
      agentId: "agent-1",
      runId: "run-1",
      name: TOOL,
      args: { query: "x" },
    });

    expect(outcome.kind).toBe("ok");
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("cloud denial fires ahead of the actor gate: a board actor is refused before dispatch", async () => {
    setDeploymentMode("cloud_auth");
    const executeTool = vi.fn(async () => ({ result: { ok: true } }));
    installDispatcher(fakeDispatcher(executeTool));

    const outcome = await dispatchPluginToolCall({
      db: stubDb(),
      companyId: COMPANY,
      actorSource: "board",
      agentId: null,
      runId: null,
      name: TOOL,
      args: {},
    });

    expect(outcome.kind).toBe("forbidden");
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("FND-008 — plugin tool listing stays metadata-only", () => {
  it("characterization: off-cloud listing returns the dispatcher's tool metadata", () => {
    setDeploymentMode("local_trusted");
    installDispatcher(fakeDispatcher());
    const defs = readPluginToolDefinitions(COMPANY);
    expect(defs.map((t) => t.name)).toContain(TOOL);
  });

  it("returns [] when no dispatcher is configured (the real cloud parent never sets one)", () => {
    setDeploymentMode("cloud_auth");
    // No dispatcher installed — mirrors the hosted cloud parent, where the
    // effectful subsystem (incl. __paperclipPluginToolDispatcher) is never
    // composed (FND-006). Listing degrades to [] rather than throwing.
    const defs = readPluginToolDefinitions(COMPANY);
    expect(defs).toEqual([]);
  });
});

describe("FND-008 — stable Decision #103 denial envelope", () => {
  it("exposes the exact error/code/docs contract", () => {
    expect(cloudPluginExecutionBlockedEnvelope()).toEqual({
      error: CLOUD_PLUGIN_BLOCK_MESSAGE,
      code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
    });
    expect(CLOUD_PLUGIN_EXECUTION_DOC_PATH).toBe(
      "/docs/guides/cloud-plugin-execution"
    );
    expect(PLUGIN_WORKER_BLOCKED_IN_CLOUD).toBe("PLUGIN_WORKER_BLOCKED_IN_CLOUD");
  });
});

describe("FND-008 — cloud gate re-affirmation (every sink fails closed in cloud)", () => {
  const sinks = [
    "worker-manager",
    "worker-fork",
    "lifecycle",
    "loader",
    "loader-import",
    "ui-static",
  ] as const;

  it("blocks every sink and the bare form under cloud_auth", () => {
    setDeploymentMode("cloud_auth");
    expect(isCloudPluginExecutionBlocked()).toBe(true);
    for (const sink of sinks) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(true);
    }
  });

  it("blocks nothing off-cloud (self-hosted positive)", () => {
    setDeploymentMode("local_trusted");
    expect(isCloudPluginExecutionBlocked()).toBe(false);
    for (const sink of sinks) {
      expect(isCloudPluginExecutionBlocked(sink)).toBe(false);
    }
  });
});

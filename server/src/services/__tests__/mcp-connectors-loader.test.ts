/**
 * Unit tests for `loadEnabledConnectorRows` (Task 7).
 *
 * House pattern (see crew-budget.test.ts / thread-events.test.ts): mock
 * `@armyofagents/db` and `drizzle-orm` at module level with the shared
 * Proxy/operator helpers, then drive the loader with a sequence-based mock DB
 * that records which table each `.select()` read from — the Commander test
 * asserts on exactly that, since "did not query the join table" is otherwise
 * unobservable.
 *
 * `../secrets.js` is mocked rather than injected: it keeps the real secrets
 * module graph (providers, config-file access) out of the test, AND it leaves
 * the production call site `secretService(db)` on the tested path, which an
 * injected resolver would bypass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "../../__tests__/helpers/drizzle-mock.js";
import { OAuthRefreshError } from "../mcp-connector-token-refresh.js";

vi.mock("@armyofagents/db", () => ({
  companyMcpConnectors: makeTableProxy("company_mcp_connectors"),
  companyMcpConnectorAgents: makeTableProxy("company_mcp_connector_agents"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Declared before the factories that close over them. Safe despite vi.mock
// hoisting: the factory body runs at import time, after these initialize.
const resolveByName = vi.fn();
const warn = vi.fn();
const logActivityMock = vi.fn();
const updateIfStatus = vi.fn();

vi.mock("../secrets.js", () => ({
  secretService: () => ({ resolveByName }),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { warn: (...args: unknown[]) => warn(...args) },
}));

// The delivery-audit sink (Task 5.4 / Decision #116 clause 7). Mocked as a no-op
// so it never touches the sequence-mock db (which has no `.insert`) — that keeps
// the loader's best-effort try/catch from ever firing its warn and perturbing the
// `warn`-count assertions elsewhere in this file.
vi.mock("../activity-log.js", () => ({
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));

// The CRUD module's `updateIfStatus` is mocked as an observable spy (Task 13):
// otherwise the real `db.update` runs against the sequence-mock db (which has
// no `.update`), throws, and is swallowed by the loader's `.catch(() => {})`,
// making the "flipped to needs_credentials" assertion unobservable.
vi.mock("../mcp-connectors-crud.js", () => ({
  mcpConnectorService: () => ({ updateIfStatus }),
}));

import {
  isConnectorToolAutoAllowed,
  loadConnectorEgressHosts,
  loadEnabledConnectorRows,
  resolveAgentConnectors,
} from "../mcp-connectors-loader.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB. Each `.select()` consumes the next preset row set and
// records the table it read from.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      const name = (meta as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function createSequenceDb(selects: MockRow[][]) {
  let selectIdx = 0;
  const selectedTables: (string | undefined)[] = [];

  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = (table: unknown) => {
        selectedTables.push(tableNameOf(table));
        return chain;
      };
      for (const m of ["where", "orderBy", "limit"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(resolve(selects[selectIdx++] ?? []));
      return chain;
    },
  };

  // The loader takes `Db`; the mock implements only the surface it touches.
  return { db: db as never, selectedTables };
}

/** A connector row with sane defaults; override per test. */
function connectorRow(overrides: MockRow = {}): MockRow {
  return {
    id: "conn-1",
    companyId: "co-1",
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    command: null,
    args: [],
    headerTemplate: { Authorization: "Bearer ${TOKEN}" },
    envTemplate: {},
    secretRef: "mcp:notion",
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  resolveByName.mockReset();
  warn.mockReset();
  logActivityMock.mockReset();
  logActivityMock.mockResolvedValue(undefined);
  updateIfStatus.mockReset();
  updateIfStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadEnabledConnectorRows", () => {
  it("returns only the active connectors the agent opted into", async () => {
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-active-in", serverName: "notion" }),
        connectorRow({ id: "c-active-out", serverName: "linear" }),
        connectorRow({ id: "c-pending", serverName: "slack", status: "pending_approval" }),
      ],
      // join table: the agent opted into the active one AND the pending one
      [{ connectorId: "c-active-in" }, { connectorId: "c-pending" }],
    ]);
    resolveByName.mockResolvedValue("secret-abc");

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    // "linear" was active but not opted in; "slack" was opted in but not active.
    expect(rows.map((r) => r.serverName)).toEqual(["notion"]);
    expect(rows[0].secretValue).toBe("secret-abc");
  });

  it("gives Commander every active connector without querying the join table", async () => {
    const { db, selectedTables } = createSequenceDb([
      [
        connectorRow({ id: "c1", serverName: "notion" }),
        connectorRow({ id: "c2", serverName: "linear" }),
        connectorRow({ id: "c3", serverName: "slack", status: "disabled" }),
      ],
    ]);
    resolveByName.mockResolvedValue("secret-abc");

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: null });

    expect(rows.map((r) => r.serverName)).toEqual(["notion", "linear"]);
    // Exactly one read, and it was the connectors table — the opt-in join is
    // meaningless for Commander (D3) and must not be issued.
    expect(selectedTables).toEqual(["company_mcp_connectors"]);
  });

  it("drops a denylisted connector before resolving secrets and keeps healthy connectors", async () => {
    vi.stubEnv("AOA_MCP_CONNECTOR_DENYLIST", "notion");
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-denied", serverName: "notion" }),
        connectorRow({ id: "c-healthy", serverName: "healthy", secretRef: null }),
      ],
      [{ connectorId: "c-denied" }, { connectorId: "c-healthy" }],
    ]);

    const rows = await loadEnabledConnectorRows(db, {
      companyId: "co-1",
      agentId: "agent-1",
    });

    expect(rows.map((row) => row.serverName)).toEqual(["healthy"]);
    expect(resolveByName).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorId: "c-denied",
        serverName: "notion",
        policyEnabled: true,
      }),
      "MCP connector skipped at delivery by emergency policy",
    );
  });

  it("drops every connector when the global emergency switch is disabled", async () => {
    vi.stubEnv("AOA_MCP_CONNECTORS_ENABLED", "0");
    const { db } = createSequenceDb([
      [connectorRow({ id: "c1", serverName: "notion" })],
      [{ connectorId: "c1" }],
    ]);

    const rows = await loadEnabledConnectorRows(db, {
      companyId: "co-1",
      agentId: "agent-1",
    });

    expect(rows).toEqual([]);
    expect(resolveByName).not.toHaveBeenCalled();
  });

  it("validates OAuth identity and current status before decrypting its secret", async () => {
    const oauth = connectorRow({
      id: "c-oauth",
      source: "catalog",
      serverName: "notion",
      catalogEntryId: "notion-hosted",
      oauthPolicyVersion: 1,
      secretRef: "mcp:oauth:c-oauth",
    });
    const { db } = createSequenceDb([
      [oauth],
      [{ connectorId: "c-oauth" }],
      [], // current-row recheck: connector was disabled/removed after selection
    ]);

    await expect(loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" }))
      .resolves.toEqual([]);
    expect(resolveByName).not.toHaveBeenCalled();
  });

  it("resolves connectors concurrently with a bound worker limit", async () => {
    const connectors = Array.from({ length: 7 }, (_, index) => connectorRow({
      id: `c-${index}`,
      serverName: `server-${index}`,
      secretRef: `mcp:${index}`,
    }));
    const { db } = createSequenceDb([
      connectors,
      connectors.map((connector) => ({ connectorId: connector.id })),
    ]);
    let active = 0;
    let maxActive = 0;
    resolveByName.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "secret";
    });

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });
    expect(rows).toHaveLength(7);
    expect(maxActive).toBe(4);
  });

  it("skips a connector whose secret THROWS and still returns the healthy one (A19)", async () => {
    // Broken FIRST is the discriminating order: a `try` wrapping the whole loop
    // would abort at connector 0 and return [], so this case fails it — whereas
    // broken-last would swallow the late throw and still pass. This is the test
    // that distinguishes correct per-connector handling from a whole-loop try.
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-broken", serverName: "broken", secretRef: "mcp:deleted" }),
        connectorRow({ id: "c-healthy", serverName: "healthy", secretRef: "mcp:notion" }),
      ],
      [{ connectorId: "c-broken" }, { connectorId: "c-healthy" }],
    ]);

    // Exactly what a dangling secretRef produces: resolveByName throws notFound.
    resolveByName.mockImplementation(async (_companyId: string, name: string) => {
      if (name === "mcp:deleted") {
        throw Object.assign(new Error("Secret not found: mcp:deleted"), { status: 404 });
      }
      return "secret-abc";
    });

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    // The whole load did not abort: the healthy connector survives intact.
    expect(rows.map((r) => r.serverName)).toEqual(["healthy"]);
    expect(rows[0].secretValue).toBe("secret-abc");
    // The dropped connector is named in a warning, never swallowed silently.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      connectorId: "c-broken",
      serverName: "broken",
      secretRef: "mcp:deleted",
    });
  });

  it("still returns the healthy connector when the BROKEN one is resolved last", async () => {
    // Order-independence / defense-in-depth: this does NOT catch the whole-loop
    // `try` mutation (that swallows the late throw and passes — the broken-first
    // test above is what discriminates it). Its job is the complementary
    // guarantee: a failure on a LATE connector must not discard results already
    // accumulated from earlier healthy ones.
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-healthy", serverName: "healthy", secretRef: "mcp:notion" }),
        connectorRow({ id: "c-broken", serverName: "broken", secretRef: "mcp:deleted" }),
      ],
      [{ connectorId: "c-healthy" }, { connectorId: "c-broken" }],
    ]);
    resolveByName.mockImplementation(async (_companyId: string, name: string) => {
      if (name === "mcp:deleted") throw new Error("Secret not found: mcp:deleted");
      return "secret-abc";
    });

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    expect(rows.map((r) => r.serverName)).toEqual(["healthy"]);
  });

  it("returns secretValue null for a connector with no secretRef, without calling the resolver", async () => {
    const { db } = createSequenceDb([
      [connectorRow({ id: "c1", serverName: "public", secretRef: null })],
      [{ connectorId: "c1" }],
    ]);

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    expect(rows).toHaveLength(1);
    expect(rows[0].secretValue).toBeNull();
    // An unauthenticated server is a valid configuration, not a failure: no
    // secrets lookup, no warning.
    expect(resolveByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits an mcp_connector.delivered audit event per DELIVERED connector (Decision #116 clause 7)", async () => {
    // AoA cannot observe the CLI's actual MCP child spawn, so the honest audit
    // point is "delivered to the run" — a connector that passed the selector AND
    // whose secret resolved. Two delivered here: one http (secret resolves), one
    // stdio (no secret). command is recorded only for stdio; trustTier always.
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-http", serverName: "notion", transport: "http", secretRef: "mcp:notion" }),
        connectorRow({
          id: "c-stdio",
          serverName: "pg",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "dbhub@1.0.0"],
          secretRef: null,
          trustTier: "verified",
        }),
      ],
      [{ connectorId: "c-http" }, { connectorId: "c-stdio" }],
    ]);
    resolveByName.mockResolvedValue("secret-abc");

    // The audit is emitted by resolveAgentConnectors AFTER buildConnectorSpecs
    // (only spec survivors), not by loadEnabledConnectorRows.
    await resolveAgentConnectors(db, { companyId: "co-1", agentId: "agent-1", runId: "run-9" });

    expect(logActivityMock).toHaveBeenCalledTimes(2);
    expect(logActivityMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: "co-1",
        actorType: "system",
        actorId: "mcp-connectors",
        agentId: "agent-1",
        runId: "run-9",
        action: "mcp_connector.delivered",
        entityType: "mcp_connector",
        entityId: "c-http",
        details: expect.objectContaining({ serverName: "notion", transport: "http", trustTier: null }),
      }),
    );
    // http carries no command; stdio does.
    const httpCall = logActivityMock.mock.calls.find((c) => (c[1] as { entityId: string }).entityId === "c-http");
    expect((httpCall![1] as { details: Record<string, unknown> }).details.command).toBeUndefined();
    expect(logActivityMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        entityId: "c-stdio",
        details: expect.objectContaining({
          serverName: "pg",
          transport: "stdio",
          command: "npx",
          trustTier: "verified",
        }),
      }),
    );
  });

  it("does NOT emit a delivered audit event for a connector dropped on secret failure", async () => {
    // A connector the selector passed but whose secret THROWS is not delivered —
    // it must not be audited as delivered.
    const { db } = createSequenceDb([
      [connectorRow({ id: "c-broken", serverName: "broken", secretRef: "mcp:deleted" })],
      [{ connectorId: "c-broken" }],
    ]);
    resolveByName.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));

    await resolveAgentConnectors(db, { companyId: "co-1", agentId: "agent-1" });

    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("does NOT audit a connector that buildConnectorSpecs DROPS (missing_command) — Codex review", async () => {
    // A stdio row with no command passes the selector (the WS2 unsafe-command
    // gate only fires for a PRESENT command) and resolves (no secret), so the
    // loader returns it — but buildConnectorSpecs skips it as `missing_command`,
    // so it never reaches the CLI. It must NOT be audited as delivered.
    const { db } = createSequenceDb([
      [
        connectorRow({
          id: "c-nocmd",
          serverName: "broken-stdio",
          transport: "stdio",
          url: null,
          command: null,
          args: [],
          secretRef: null,
        }),
        connectorRow({ id: "c-http", serverName: "notion", transport: "http", secretRef: "mcp:notion" }),
      ],
      [{ connectorId: "c-nocmd" }, { connectorId: "c-http" }],
    ]);
    resolveByName.mockResolvedValue("secret-abc");

    await resolveAgentConnectors(db, { companyId: "co-1", agentId: "agent-1", runId: "run-9" });

    // Only the healthy http connector is audited; the dropped stdio row is not.
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    expect(logActivityMock.mock.calls[0][1]).toMatchObject({ entityId: "c-http" });
  });

  it("passes a system consumer context naming the connector", async () => {
    const { db } = createSequenceDb([
      [connectorRow({ id: "c1", serverName: "notion", secretRef: "mcp:notion" })],
      [{ connectorId: "c1" }],
    ]);
    resolveByName.mockResolvedValue("secret-abc");

    await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    // consumerType "system" is load-bearing: it exempts the read from the
    // binding requirement in secrets.ts (shouldEnforceSecretBinding).
    expect(resolveByName).toHaveBeenCalledWith("co-1", "mcp:notion", {
      consumerType: "system",
      consumerId: "mcp-connectors",
      actorType: "system",
      configPath: "mcp.connector.notion",
    });
  });

  it("does not grant the OAuth-owner capability to a static connector using an OAuth secret name", async () => {
    const { db } = createSequenceDb([
      [
        connectorRow({
          id: "attacker-connector",
          source: "byo",
          catalogEntryId: null,
          oauthPolicyVersion: null,
          secretRef: "mcp:oauth:owner-connector",
        }),
      ],
      [{ connectorId: "attacker-connector" }],
    ]);
    resolveByName.mockImplementation(async (_companyId, _name, context) => {
      if (!context.mcpOAuthOwner) {
        throw Object.assign(new Error("OAuth connector credentials cannot be used by generic secret consumers"), {
          status: 422,
        });
      }
      return "must-not-resolve";
    });

    await expect(
      loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" }),
    ).resolves.toEqual([]);
    expect(resolveByName).toHaveBeenCalledWith(
      "co-1",
      "mcp:oauth:owner-connector",
      expect.not.objectContaining({ mcpOAuthOwner: expect.anything() }),
    );
  });

  it("carries every spec-shaping column through to the returned row", async () => {
    const { db } = createSequenceDb([
      [
        connectorRow({
          id: "c1",
          serverName: "pg",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "dbhub@1.0.0"],
          headerTemplate: {},
          envTemplate: { DSN: "${TOKEN}" },
          secretRef: null,
        }),
      ],
      [{ connectorId: "c1" }],
    ]);

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    // A dropped column would silently downgrade a connector at spawn time
    // rather than fail loudly, so assert the whole shape.
    expect(rows[0]).toEqual({
      connectorId: "c1",
      serverName: "pg",
      transport: "stdio",
      url: null,
      command: "npx",
      args: ["-y", "dbhub@1.0.0"],
      headerTemplate: {},
      envTemplate: { DSN: "${TOKEN}" },
      trustTier: null,
      secretValue: null,
    });
  });

  it("flips a connector to needs_credentials and drops it when OAuth refresh fails (Task 13)", async () => {
    // An expired bundle with no refresh token makes doRefresh throw
    // OAuthRefreshError immediately — no network call, no `getByName` — so this
    // drives the failure path deterministically.
    const { db } = createSequenceDb([
      [connectorRow({ id: "c-oauth-dead", serverName: "notion", secretRef: "mcp:notion" })],
      [{ connectorId: "c-oauth-dead" }],
    ]);
    resolveByName.mockRejectedValue(
      new OAuthRefreshError(
        "OAuth credentials require reauthorization",
        "permanent",
        "oauth_refresh_token_missing",
      ),
    );

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    // The whole load did not abort, and the dead-refresh connector is dropped.
    expect(rows).toEqual([]);
    expect(updateIfStatus).toHaveBeenCalledWith("c-oauth-dead", "active", { status: "needs_credentials" });
  });

  it("returns an empty array when the company has no connectors", async () => {
    // Only one row set: the 0-connector early-return fires before the join
    // table would ever be queried, so a second (join) select never happens.
    const { db } = createSequenceDb([[]]);

    const rows = await loadEnabledConnectorRows(db, { companyId: "co-1", agentId: "agent-1" });

    expect(rows).toEqual([]);
    expect(resolveByName).not.toHaveBeenCalled();
  });

  // U11: sandboxTarget is forwarded to selectConnectorRowsForAgent's D7 re-gate.
  // Force the host's CURRENT deployment mode to cloud_auth (loadConfig() reads
  // AOA_DEPLOYMENT_MODE with no caching) so the axis is actually exercised.
  it("threads sandboxTarget into the D7 re-gate: stdio kept on cloud_auth+sandbox, dropped without it", async () => {
    vi.stubEnv("AOA_DEPLOYMENT_MODE", "cloud_auth");
    const stdioRow = () =>
      connectorRow({
        id: "c-stdio",
        serverName: "notion-stdio",
        transport: "stdio",
        command: "npx",
        args: ["@notionhq/notion-mcp-server@1.2.3"],
        source: "byo",
        secretRef: null,
      });

    const { db: dbUnsandboxed } = createSequenceDb([[stdioRow()], [{ connectorId: "c-stdio" }]]);
    const dropped = await loadEnabledConnectorRows(dbUnsandboxed, {
      companyId: "co-1",
      agentId: "agent-1",
      sandboxTarget: false,
    });
    expect(dropped).toEqual([]);

    const { db: dbSandboxed } = createSequenceDb([[stdioRow()], [{ connectorId: "c-stdio" }]]);
    const kept = await loadEnabledConnectorRows(dbSandboxed, {
      companyId: "co-1",
      agentId: "agent-1",
      sandboxTarget: true,
    });
    expect(kept.map((r) => r.serverName)).toEqual(["notion-stdio"]);
  });
});

describe("resolveAgentConnectors", () => {
  it("resolves an http connector with a resolvable secret into a placeholder spec + real env, no warn", async () => {
    const { db } = createSequenceDb([
      [connectorRow({ id: "c1", serverName: "notion", secretRef: "mcp:notion" })],
      [{ connectorId: "c1" }],
    ]);
    resolveByName.mockResolvedValue("secret-abc");
    const seamWarn = vi.fn();

    const result = await resolveAgentConnectors(db, {
      companyId: "co-1",
      agentId: "agent-1",
      runId: "run-1",
      logger: { warn: seamWarn },
    });

    expect(result.extraMcpServers.notion).toEqual({
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
      authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
    });
    expect(result.connectorEnv.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");
    expect(seamWarn).not.toHaveBeenCalled();
  });

  it("logs skipped connectors once through the passed-in logger and returns no spec for them", async () => {
    const { db } = createSequenceDb([
      [
        connectorRow({
          id: "c-bad",
          serverName: "broken-http",
          transport: "http",
          url: null,
          secretRef: null,
        }),
      ],
      [{ connectorId: "c-bad" }],
    ]);
    const seamWarn = vi.fn();

    const result = await resolveAgentConnectors(db, {
      companyId: "co-1",
      agentId: "agent-1",
      logger: { warn: seamWarn },
    });

    expect(result.extraMcpServers).toEqual({});
    expect(seamWarn).toHaveBeenCalledTimes(1);
    expect(seamWarn.mock.calls[0][0]).toMatchObject({
      companyId: "co-1",
      agentId: "agent-1",
      skipped: [{ serverName: "broken-http", reason: "missing_url" }],
    });
  });

  it("resolves every active connector without the join query when agentId is null (Commander)", async () => {
    const { db, selectedTables } = createSequenceDb([
      [
        connectorRow({ id: "c1", serverName: "notion", secretRef: "mcp:notion" }),
        connectorRow({ id: "c2", serverName: "linear", secretRef: "mcp:linear" }),
      ],
    ]);
    resolveByName.mockResolvedValue("secret-abc");
    const seamWarn = vi.fn();

    const result = await resolveAgentConnectors(db, {
      companyId: "co-1",
      agentId: null,
      logger: { warn: seamWarn },
    });

    expect(Object.keys(result.extraMcpServers).sort()).toEqual(["linear", "notion"]);
    expect(selectedTables).toEqual(["company_mcp_connectors"]);
    expect(seamWarn).not.toHaveBeenCalled();
  });
});

describe("isConnectorToolAutoAllowed emergency policy", () => {
  it("rejects a denylisted connector tool before querying connector state", async () => {
    vi.stubEnv("AOA_MCP_CONNECTOR_DENYLIST", "notion");
    const { db, selectedTables } = createSequenceDb([]);

    const allowed = await isConnectorToolAutoAllowed(db, {
      companyId: "co-1",
      agentId: "agent-1",
      adapterType: "claude_local",
      toolName: "mcp__notion__search",
    });

    expect(allowed).toBe(false);
    expect(selectedTables).toEqual([]);
  });
});

// U11: the PRE-acquire egress-host estimate that populates the sandbox
// provider's egressAllowlist. Deliberately optimistic (sandboxTarget: true)
// and deliberately skips secret resolution — only transport/url/command are
// read, so these tests never touch `resolveByName`.
describe("loadConnectorEgressHosts (U11 pre-acquire egress estimate)", () => {
  it("returns the http connector's host plus npm for a stdio connector, without resolving secrets", async () => {
    const { db } = createSequenceDb([
      [
        connectorRow({ id: "c-http", serverName: "notion", transport: "http", url: "https://mcp.notion.com/mcp" }),
        connectorRow({
          id: "c-stdio",
          serverName: "notion-stdio",
          transport: "stdio",
          command: "npx",
          args: ["@notionhq/notion-mcp-server@1.2.3"],
          source: "byo",
          secretRef: null,
        }),
      ],
      [{ connectorId: "c-http" }, { connectorId: "c-stdio" }],
    ]);

    const hosts = await loadConnectorEgressHosts(db, { companyId: "co-1", agentId: "agent-1" });

    expect(hosts).toEqual(expect.arrayContaining(["mcp.notion.com", "registry.npmjs.org"]));
    expect(resolveByName).not.toHaveBeenCalled();
  });

  it("is OPTIMISTIC: includes a stdio connector's npm host even under cloud_auth (no sandbox resolved yet)", async () => {
    vi.stubEnv("AOA_DEPLOYMENT_MODE", "cloud_auth");
    const { db } = createSequenceDb([
      [
        connectorRow({
          id: "c-stdio",
          serverName: "notion-stdio",
          transport: "stdio",
          command: "npx",
          args: ["@notionhq/notion-mcp-server@1.2.3"],
          source: "byo",
          secretRef: null,
        }),
      ],
      [{ connectorId: "c-stdio" }],
    ]);

    // Real delivery (loadEnabledConnectorRows, sandboxTarget: false) would DROP
    // this stdio row on cloud_auth — but the pre-acquire estimate assumes the
    // sandbox it is computing hosts FOR will actually be granted.
    const hosts = await loadConnectorEgressHosts(db, { companyId: "co-1", agentId: "agent-1" });
    expect(hosts).toContain("registry.npmjs.org");
  });

  it("returns [] for a company with no connectors, without querying the join table", async () => {
    const { db, selectedTables } = createSequenceDb([[]]);

    const hosts = await loadConnectorEgressHosts(db, { companyId: "co-1", agentId: "agent-1" });

    expect(hosts).toEqual([]);
    expect(selectedTables).toEqual(["company_mcp_connectors"]);
  });

  it("never throws: a DB failure degrades to an empty allowlist", async () => {
    const throwingDb = {
      select: () => {
        throw new Error("connection reset");
      },
    } as unknown as Parameters<typeof loadConnectorEgressHosts>[0];

    await expect(
      loadConnectorEgressHosts(throwingDb, { companyId: "co-1", agentId: "agent-1" }),
    ).resolves.toEqual([]);
  });

  it("Commander (agentId: null) skips the join-table query, same as loadEnabledConnectorRows", async () => {
    const { db, selectedTables } = createSequenceDb([
      [connectorRow({ id: "c1", serverName: "notion", transport: "http", url: "https://mcp.notion.com/mcp" })],
    ]);

    const hosts = await loadConnectorEgressHosts(db, { companyId: "co-1", agentId: null });

    expect(hosts).toContain("mcp.notion.com");
    expect(selectedTables).toEqual(["company_mcp_connectors"]);
  });
});

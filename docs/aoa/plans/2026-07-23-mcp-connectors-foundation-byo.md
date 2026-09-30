# External MCP Connectors — Foundation + BYO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a founder register an external MCP server (BYO connector) at company level, enable it per-agent, and have `claude_local` agent runs receive it — without ever writing a plaintext secret to disk.

**Architecture:** AoA already delivers exactly one MCP server (its own stdio loopback bridge, named `aoa`) to four CLI adapters. This plan keeps that path untouched and adds a **parallel, additive** channel for external servers: a new `McpServerSpec` transport union, a new optional plural carrier `mcpServers` on `AdapterExecutionContext`, and a connector registry in the DB. Secrets never land in config files — configs contain `${ENV_VAR}` placeholders and the real value rides in the spawned process env, preserving the existing "secrets only in env" convention. `claude_local` ships first because its writer is already raw `JSON.stringify`; the other three adapters follow in Plan 2.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM (PostgreSQL), Vitest, React + Vite + Tailwind v4, pnpm workspaces.

---

## Scope

This is **Plan 1 of 4**. Each plan produces working, testable software on its own.

| Plan | Scope | Status |
|---|---|---|
| **1 (this)** | Transport union, plural carrier, connector registry, secret transport, `claude_local` delivery, BYO CRUD + Settings UI | To build |
| 2 | Remaining adapters: `gemini_local`, `opencode_local`, `codex_local` (incl. the TOML stripper fix) | Separate plan |
| 3 | Marketplace `connector` type, curated catalog, bulk registry import | Separate plan |
| 4 | Flagship plugins + Better Auth `genericOAuth` broker | Separate plan |

## Locked design decisions

These were decided during design review. Do not relitigate them while executing.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Additive, not breaking.** `McpBridgeSpec` keeps its exact current stdio shape. External servers use a new `McpServerSpec` union carried on a new optional field. | `McpBridgeSpec` is hand-duplicated in 5 packages with no cross-boundary compiler enforcement. A breaking union edit risks silent drift; additive does not. |
| D2 | **Strict isolation everywhere.** All agent runs pass `--strict-mcp-config`. | AoA is the source of truth for what agents can reach. Today heartbeat is strict but crew/Commander are not, silently inheriting the host machine's MCP config. |
| D3 | **Commander sees all company connectors**, still under strict mode. | Commander is the coordination layer; it should not be starved. Strict governs *where the list comes from*, not *how much Commander gets*. |
| D4 | **Company-level install + per-agent opt-in.** | One credential to rotate/revoke; mirrors how `browser_use` gates Playwright. |
| D5 | **Secrets via env indirection.** Config files contain `${VAR}`; the real secret is passed in the spawned process env. | Preserves the existing convention documented at `packages/adapter-utils/src/types.ts:274-286` — config/context are persisted into run events, so secrets must never flow through them. |
| D6 | **Governance mirrors the agent-hire rule.** Approval required in `authenticated` mode; auto-approved in `local_trusted`. | Consistent with Paperclip Divergence D6. |
| D7 | **stdio is deployment-mode-aware.** `local_trusted` may register stdio connectors; `authenticated` restricts BYO to remote HTTP. | An `npx` command runs on the AoA host. On a founder's own laptop that is normal; in multi-tenant it is RCE. |
| D8 | **No CLI token delegation.** AoA brokers auth; we do not rely on the CLI's stored MCP OAuth tokens. | Whether a CLI-stored token keys by server *name* or *URL* is undocumented; building on it means building on internal behavior that can change without notice. |

## File Structure

**Created:**
- `packages/adapter-utils/src/mcp-server-spec.ts` — the `McpServerSpec` transport union, single source of truth in adapter-utils
- `packages/db/src/schema/company_mcp_connectors.ts` — connector registry table
- `packages/db/src/schema/company_mcp_connector_agents.ts` — per-agent enablement join table
- `server/src/services/mcp-connectors.ts` — resolve enabled connectors for a company/agent into specs + env
- `server/src/services/__tests__/mcp-connectors.test.ts`
- `server/src/routes/mcp-connectors.ts` — CRUD + RBAC
- `ui/src/api/mcpConnectors.ts` — API client
- `ui/src/components/settings/sections/MCPConnectorsSection.tsx` — Settings UI

**Modified:**
- `packages/adapter-utils/src/types.ts:185-197, 288-301` — export the union, add plural carrier
- `server/src/services/internal-agent/cli-mode.ts:124-137, 211-227` — open `McpConfig`, extend `buildMcpConfig`
- `server/src/services/heartbeat-mcp.ts:6-10, 38-61` — thread connectors through
- `server/src/services/heartbeat.ts:4254-4279` — resolve connectors into params
- `server/src/services/internal-agent/aoa-agents/runner.ts:364, 496` — crew path + strict flag
- `packages/db/src/schema/index.ts` — export new tables
- `packages/adapter-utils/src/index.ts` — add the new types to the export allowlist
- `server/src/services/mcp-arg-sanitize.ts` (new) — strip user-supplied `--mcp-config` at the injection points
- `server/src/app.ts:307` — mount the connector router on the `api` sub-router

---

## Task 1: The `McpServerSpec` transport union

Adds the type that can express a remote HTTP server. Purely additive — `McpBridgeSpec` is untouched.

**Files:**
- Create: `packages/adapter-utils/src/mcp-server-spec.ts`
- Create: `packages/adapter-utils/src/__tests__/mcp-server-spec.test.ts`
- Modify: `packages/adapter-utils/src/types.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-utils/src/__tests__/mcp-server-spec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isHttpServerSpec, isStdioServerSpec, type McpServerSpec } from "../mcp-server-spec.js";

describe("McpServerSpec", () => {
  it("narrows a stdio spec", () => {
    const spec: McpServerSpec = {
      kind: "stdio",
      command: "npx",
      args: ["@playwright/mcp@0.0.75"],
      env: {},
    };
    expect(isStdioServerSpec(spec)).toBe(true);
    expect(isHttpServerSpec(spec)).toBe(false);
  });

  it("narrows an http spec with headers", () => {
    const spec: McpServerSpec = {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    };
    expect(isHttpServerSpec(spec)).toBe(true);
    expect(isStdioServerSpec(spec)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/adapter-utils/src/__tests__/mcp-server-spec.test.ts`
Expected: FAIL — `Cannot find module '../mcp-server-spec.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/adapter-utils/src/mcp-server-spec.ts`:

```ts
/**
 * Transport union for MCP servers AoA delivers to CLI adapters.
 *
 * ADDITIVE — this does NOT replace McpBridgeSpec. McpBridgeSpec remains the
 * shape of AoA's own stdio loopback bridge (the `aoa` server) and is
 * hand-duplicated in each adapter package by design. This union describes
 * EXTERNAL connectors, which may be remote HTTP.
 *
 * SECRETS: `headers` and `env` values may contain `${VAR}` placeholders that
 * the target CLI expands from process env. Real secret values MUST NOT be
 * placed here — see D5 in the connectors plan.
 */
export interface McpStdioServerSpec {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpHttpServerSpec {
  kind: "http";
  url: string;
  headers: Record<string, string>;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

export function isStdioServerSpec(spec: McpServerSpec): spec is McpStdioServerSpec {
  return spec.kind === "stdio";
}

export function isHttpServerSpec(spec: McpServerSpec): spec is McpHttpServerSpec {
  return spec.kind === "http";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/adapter-utils/src/__tests__/mcp-server-spec.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Re-export from `types.ts`**

In `packages/adapter-utils/src/types.ts`, immediately after the existing `McpBridgeSpec` interface (ends line 197), add:

```ts
export type {
  McpServerSpec,
  McpStdioServerSpec,
  McpHttpServerSpec,
} from "./mcp-server-spec.js";
export { isStdioServerSpec, isHttpServerSpec } from "./mcp-server-spec.js";
```

- [ ] **Step 5b: Also add to the package entry allowlist**

`packages/adapter-utils/src/index.ts` is an **explicit named-export allowlist** — it does NOT `export * from "./types.js"`. Without this step, `import type { McpServerSpec } from "@armyofagents/adapter-utils"` (used in Tasks 3, 6, 10) fails to resolve.

Next to the existing `McpBridgeSpec` entry (around `index.ts:19`), add:

```ts
  McpServerSpec,
  McpStdioServerSpec,
  McpHttpServerSpec,
```

and export the two guards alongside the other value exports:

```ts
export { isStdioServerSpec, isHttpServerSpec } from "./mcp-server-spec.js";
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @armyofagents/adapter-utils typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-utils/src/mcp-server-spec.ts packages/adapter-utils/src/__tests__/mcp-server-spec.test.ts packages/adapter-utils/src/types.ts
git commit -m "feat(mcp): add McpServerSpec transport union for external connectors"
```

---

## Task 2: Plural carrier on `AdapterExecutionContext`

`mcpBridge` is singular and stdio-only. Add a plural, transport-agnostic sibling.

**Files:**
- Modify: `packages/adapter-utils/src/types.ts:288-301`

- [ ] **Step 1: Add the field**

In `packages/adapter-utils/src/types.ts`, inside `AdapterExecutionContext`, directly after the existing `mcpBridge?: McpBridgeSpec;` (line 301), add:

```ts
  /**
   * Optional external MCP servers (connectors), keyed by server name. Delivered
   * ALONGSIDE `mcpBridge` — `mcpBridge` remains AoA's own loopback server and is
   * never represented here. Adapters that do not understand this field simply
   * ignore it and behave exactly as before.
   *
   * SECRETS: values may contain `${VAR}` placeholders expanded by the target CLI
   * from process env. Never place a real secret in this struct — it is persisted
   * into run events (see RuntimeHookBridgeSpec note above).
   */
  mcpServers?: Record<string, McpServerSpec>;
```

- [ ] **Step 2: Import the type**

At the top of `packages/adapter-utils/src/types.ts`, add:

```ts
import type { McpServerSpec } from "./mcp-server-spec.js";
```

- [ ] **Step 3: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: no errors. The field is optional, so no existing caller breaks.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-utils/src/types.ts
git commit -m "feat(mcp): add optional plural mcpServers carrier to AdapterExecutionContext"
```

---

## Task 3: Open up `McpConfig` and `buildMcpConfig`

`McpConfig` is a closed record with two literal keys and cannot express a third server of any kind.

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts:124-137, 211-227`
- Create: `server/src/services/internal-agent/__tests__/build-mcp-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/internal-agent/__tests__/build-mcp-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMcpConfig, type McpConfigParams } from "../cli-mode.js";

// NOTE: bridgeEntrypoint and enabledCapabilities are REQUIRED. buildMcpBridgeSpec
// dereferences `params.bridgeEntrypoint.endsWith(".ts")` (cli-mode.ts:163), so
// omitting it throws TypeError before any assertion runs.
function baseParams(): McpConfigParams {
  return {
    companyId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    userRole: "founder",
    enabledCapabilities: [],
    bridgeEntrypoint: "/tmp/aoa-mcp-bridge.js",
  } as unknown as McpConfigParams;
}

describe("buildMcpConfig", () => {
  it("always includes the aoa loopback server", () => {
    const config = buildMcpConfig(baseParams());
    expect(config.mcpServers.aoa).toBeDefined();
  });

  it("splices in external connectors alongside aoa", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
        },
      },
    });
    expect(config.mcpServers.aoa).toBeDefined();
    expect(config.mcpServers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    });
  });

  it("never lets a connector overwrite the aoa server", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        aoa: { kind: "http", url: "https://evil.example.com/mcp", headers: {} },
      },
    });
    expect(config.mcpServers.aoa).not.toHaveProperty("url");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/build-mcp-config.test.ts`
Expected: FAIL — `extraMcpServers` is not a known property, and `mcpServers.notion` is undefined.

- [ ] **Step 3: Open the `McpConfig` type**

In `server/src/services/internal-agent/cli-mode.ts`, replace the closed interface at lines 124-137 with:

```ts
/**
 * Serialized MCP config handed to a CLI. `aoa` is always present (AoA's own
 * loopback bridge). `playwright` is capability-gated. Any other key is an
 * external connector (see McpServerSpec).
 */
interface McpConfigServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http";
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpConfigServerEntry>;
}
```

- [ ] **Step 4: Add the param and splice logic**

In the same file, add to `McpConfigParams` (interface at lines 94-122):

```ts
  /** External connectors, keyed by server name. Never contains `aoa`. */
  extraMcpServers?: Record<string, McpServerSpec>;
```

Add the import at the top of the file:

```ts
import type { McpServerSpec } from "@armyofagents/adapter-utils";
```

Then replace `buildMcpConfig` (lines 211-227) with:

```ts
export function buildMcpConfig(params: McpConfigParams): McpConfig {
  const config: McpConfig = {
    mcpServers: {
      aoa: buildMcpBridgeSpec(params),
    },
  };

  if (params.enabledCapabilities?.includes("browser_use")) {
    config.mcpServers.playwright = {
      command: "npx",
      args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"],
      env: {},
    };
  }

  for (const [name, spec] of Object.entries(params.extraMcpServers ?? {})) {
    // Reserved names can never be shadowed by a connector.
    if (name === "aoa" || name === "playwright") continue;
    config.mcpServers[name] =
      spec.kind === "http"
        ? { type: "http", url: spec.url, headers: spec.headers }
        : { command: spec.command, args: spec.args, env: spec.env };
  }

  return config;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/build-mcp-config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/cli-mode.ts server/src/services/internal-agent/__tests__/build-mcp-config.test.ts
git commit -m "feat(mcp): allow external connectors in buildMcpConfig with reserved-name guard"
```

---

## Task 4: Verify `${VAR}` expansion in a `--mcp-config` file

D5 depends on Claude Code expanding env placeholders in the file passed via `--mcp-config`, not only in `.mcp.json`. This is a five-minute empirical check that gates the secret design. **Do not skip it.**

**Files:** none (manual verification, result recorded in the plan)

- [ ] **Step 1: Create a probe config**

```bash
mkdir -p /tmp/mcp-probe && cat > /tmp/mcp-probe/servers.json <<'EOF'
{
  "mcpServers": {
    "probe": {
      "type": "http",
      "url": "https://example.invalid/${AOA_PROBE_TOKEN}"
    }
  }
}
EOF
```

- [ ] **Step 2: Run Claude Code with the placeholder set**

```bash
AOA_PROBE_TOKEN=expanded-value claude --mcp-config /tmp/mcp-probe/servers.json --strict-mcp-config mcp list
```

Expected: the `probe` entry resolves its URL to `https://example.invalid/expanded-value` (connection will fail — that is fine; we are only checking expansion).

- [ ] **Step 3: Record the outcome**

If expansion works, proceed unchanged. If it does **not** expand, stop and switch the Claude path to `headersHelper` (a command that prints headers at connect time) instead of `${VAR}`, and note it in this plan before continuing. Either way, append a line to this file under "Locked design decisions" recording what was observed and the date.

- [ ] **Step 4: Commit the recorded finding**

```bash
git add docs/aoa/plans/2026-07-23-mcp-connectors-foundation-byo.md
git commit -m "docs(mcp): record env-expansion verification result for --mcp-config"
```

---

## Task 5: Connector registry schema

**Files:**
- Create: `packages/db/src/schema/company_mcp_connectors.ts`
- Create: `packages/db/src/schema/company_mcp_connector_agents.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the connector table**

Create `packages/db/src/schema/company_mcp_connectors.ts`:

```ts
import { index, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * External MCP servers a company has registered. `transport` selects which
 * columns are meaningful: "http" uses url + headerTemplate; "stdio" uses
 * command + args.
 *
 * SECRETS: headerTemplate/env values hold `${VAR}` PLACEHOLDERS ONLY. The real
 * value lives in company_secrets and is bound via secretRef.
 */
export const companyMcpConnectors = pgTable(
  "company_mcp_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Server name as it appears in MCP config. Lowercase, no spaces.
    serverName: text("server_name").notNull(),
    displayName: text("display_name").notNull(),
    transport: text("transport").notNull(), // "http" | "stdio"
    url: text("url"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    headerTemplate: jsonb("header_template").$type<Record<string, string>>().notNull().default({}),
    envTemplate: jsonb("env_template").$type<Record<string, string>>().notNull().default({}),
    // Key into company_secrets (e.g. "mcp:notion"). Null for unauthenticated servers.
    secretRef: text("secret_ref"),
    source: text("source").notNull().default("byo"), // "byo" | "catalog"
    status: text("status").notNull().default("pending_approval"), // pending_approval | active | disabled
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_mcp_connectors_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("company_mcp_connectors_company_name_uq").on(
      table.companyId,
      table.serverName,
    ),
  }),
);
```

- [ ] **Step 2: Create the per-agent enablement table**

Create `packages/db/src/schema/company_mcp_connector_agents.ts`:

```ts
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companyMcpConnectors } from "./company_mcp_connectors.js";

/**
 * Per-agent opt-in (D4). A connector is installed company-wide but reaches an
 * agent run only when a row exists here. Commander is exempt — it receives all
 * active company connectors (D3) and is not represented in this table.
 */
export const companyMcpConnectorAgents = pgTable(
  "company_mcp_connector_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id")
      .notNull()
      .references(() => companyMcpConnectors.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectorIdx: index("company_mcp_connector_agents_connector_idx").on(table.connectorId),
    agentIdx: index("company_mcp_connector_agents_agent_idx").on(table.agentId),
    connectorAgentUq: uniqueIndex("company_mcp_connector_agents_connector_agent_uq").on(
      table.connectorId,
      table.agentId,
    ),
  }),
);
```

- [ ] **Step 3: Export from the schema index**

In `packages/db/src/schema/index.ts`, add:

```ts
export { companyMcpConnectors } from "./company_mcp_connectors.js";
export { companyMcpConnectorAgents } from "./company_mcp_connector_agents.js";
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: a new migration file appears under `packages/db/drizzle/`. **Never hand-write SQL** (CLAUDE.md rule 1).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/company_mcp_connectors.ts packages/db/src/schema/company_mcp_connector_agents.ts packages/db/src/schema/index.ts packages/db/drizzle
git commit -m "feat(mcp): add company_mcp_connectors and per-agent enablement schema"
```

---

## Task 6: Connector resolution service

Turns DB rows into `McpServerSpec`s plus the env map carrying the real secrets.

**Files:**
- Create: `server/src/services/mcp-connectors.ts`
- Create: `server/src/services/__tests__/mcp-connectors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/mcp-connectors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildConnectorSpecs, envVarNameFor } from "../mcp-connectors.js";

describe("envVarNameFor", () => {
  it("uppercases and sanitizes the server name", () => {
    expect(envVarNameFor("notion")).toBe("AOA_MCP_NOTION_TOKEN");
    expect(envVarNameFor("my-server.v2")).toBe("AOA_MCP_MY_SERVER_V2_TOKEN");
  });
});

describe("buildConnectorSpecs", () => {
  it("emits an http spec with a placeholder header, and the secret in env", () => {
    const { specs, env } = buildConnectorSpecs([
      {
        serverName: "notion",
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        command: null,
        args: [],
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        envTemplate: {},
        secretValue: "secret-abc",
      },
    ]);

    expect(specs.notion).toEqual({
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    });
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");
  });

  it("never emits the raw secret inside the spec", () => {
    const { specs } = buildConnectorSpecs([
      {
        serverName: "notion",
        transport: "http",
        url: "https://mcp.notion.com/mcp",
        command: null,
        args: [],
        headerTemplate: { Authorization: "Bearer ${TOKEN}" },
        envTemplate: {},
        secretValue: "secret-abc",
      },
    ]);
    expect(JSON.stringify(specs)).not.toContain("secret-abc");
  });

  it("emits a stdio spec for command transport", () => {
    const { specs } = buildConnectorSpecs([
      {
        serverName: "pg",
        transport: "stdio",
        url: null,
        command: "npx",
        args: ["-y", "@bytebase/dbhub@1.2.3"],
        headerTemplate: {},
        envTemplate: { DSN: "${TOKEN}" },
        secretValue: "postgres://x",
      },
    ]);
    expect(specs.pg).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@bytebase/dbhub@1.2.3"],
      env: { DSN: "${AOA_MCP_PG_TOKEN}" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts`
Expected: FAIL — `Cannot find module '../mcp-connectors.js'`

- [ ] **Step 3: Write the implementation**

Create `server/src/services/mcp-connectors.ts`:

```ts
import type { McpServerSpec } from "@armyofagents/adapter-utils";

/** A connector row joined with its resolved secret value. */
export interface ResolvedConnectorRow {
  serverName: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  headerTemplate: Record<string, string>;
  envTemplate: Record<string, string>;
  /** Real secret. NEVER placed into a spec — only into the returned env map. */
  secretValue: string | null;
}

export interface ConnectorBuildResult {
  specs: Record<string, McpServerSpec>;
  env: Record<string, string>;
}

/**
 * Deterministic env var name for a connector's secret. The config file
 * references this name; the real value is injected into the spawned process
 * env (D5).
 */
export function envVarNameFor(serverName: string): string {
  const slug = serverName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
  return `AOA_MCP_${slug}_TOKEN`;
}

/**
 * Convert connector rows into adapter specs + the env map carrying secrets.
 * Templates use the literal token `${TOKEN}`, which is rewritten to the
 * connector's real env var name.
 */
export function buildConnectorSpecs(rows: ResolvedConnectorRow[]): ConnectorBuildResult {
  const specs: Record<string, McpServerSpec> = {};
  const env: Record<string, string> = {};

  for (const row of rows) {
    const varName = envVarNameFor(row.serverName);
    const substitute = (value: string): string =>
      value.replaceAll("${TOKEN}", `\${${varName}}`);

    if (row.transport === "http") {
      if (!row.url) continue;
      specs[row.serverName] = {
        kind: "http",
        url: row.url,
        headers: Object.fromEntries(
          Object.entries(row.headerTemplate).map(([k, v]) => [k, substitute(v)]),
        ),
      };
    } else {
      if (!row.command) continue;
      specs[row.serverName] = {
        kind: "stdio",
        command: row.command,
        args: [...row.args],
        env: Object.fromEntries(
          Object.entries(row.envTemplate).map(([k, v]) => [k, substitute(v)]),
        ),
      };
    }

    if (row.secretValue) {
      env[varName] = row.secretValue;
    }
  }

  return { specs, env };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mcp-connectors.ts server/src/services/__tests__/mcp-connectors.test.ts
git commit -m "feat(mcp): add connector resolution with env-indirection secret transport"
```

---

## Task 7: Query helper — which connectors does this agent get?

**Files:**
- Modify: `server/src/services/mcp-connectors.ts`
- Modify: `server/src/services/__tests__/mcp-connectors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/__tests__/mcp-connectors.test.ts`:

```ts
import { selectConnectorRowsForAgent } from "../mcp-connectors.js";

describe("selectConnectorRowsForAgent", () => {
  const active = { id: "c1", serverName: "notion", status: "active" };
  const pending = { id: "c2", serverName: "stripe", status: "pending_approval" };

  it("returns only active connectors enabled for the agent", () => {
    const rows = selectConnectorRowsForAgent({
      connectors: [active, pending],
      enabledConnectorIds: new Set(["c1", "c2"]),
      isCommander: false,
    });
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  });

  it("excludes active connectors the agent has not opted into", () => {
    const rows = selectConnectorRowsForAgent({
      connectors: [active],
      enabledConnectorIds: new Set(),
      isCommander: false,
    });
    expect(rows).toEqual([]);
  });

  it("gives Commander every active connector regardless of opt-in (D3)", () => {
    const rows = selectConnectorRowsForAgent({
      connectors: [active, pending],
      enabledConnectorIds: new Set(),
      isCommander: true,
    });
    expect(rows.map((r) => r.id)).toEqual(["c1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts -t selectConnectorRowsForAgent`
Expected: FAIL — `selectConnectorRowsForAgent is not a function`

- [ ] **Step 3: Implement**

Append to `server/src/services/mcp-connectors.ts`:

```ts
export interface ConnectorSelectionInput<T extends { id: string; status: string }> {
  connectors: T[];
  enabledConnectorIds: Set<string>;
  /** Commander receives every active connector (D3). */
  isCommander: boolean;
}

export function selectConnectorRowsForAgent<T extends { id: string; status: string }>(
  input: ConnectorSelectionInput<T>,
): T[] {
  return input.connectors.filter((c) => {
    if (c.status !== "active") return false;
    return input.isCommander || input.enabledConnectorIds.has(c.id);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 5: Add the database loader**

Append to `server/src/services/mcp-connectors.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  companyMcpConnectors,
  companyMcpConnectorAgents,
} from "@armyofagents/db";
import { secretService } from "./index.js";

export interface LoadConnectorRowsInput {
  companyId: string;
  /** Null for Commander, which receives all active connectors (D3). */
  agentId: string | null;
}

/**
 * Load the connectors an agent should receive, with secrets resolved.
 * Returns rows shaped for buildConnectorSpecs.
 */
export async function loadEnabledConnectorRows(
  db: Db,
  input: LoadConnectorRowsInput,
): Promise<ResolvedConnectorRow[]> {
  const connectors = await db
    .select()
    .from(companyMcpConnectors)
    .where(
      and(
        eq(companyMcpConnectors.companyId, input.companyId),
        eq(companyMcpConnectors.status, "active"),
      ),
    );

  if (connectors.length === 0) return [];

  let enabledIds = new Set<string>();
  if (input.agentId !== null) {
    const enabled = await db
      .select({ connectorId: companyMcpConnectorAgents.connectorId })
      .from(companyMcpConnectorAgents)
      .where(
        and(
          eq(companyMcpConnectorAgents.companyId, input.companyId),
          eq(companyMcpConnectorAgents.agentId, input.agentId),
        ),
      );
    enabledIds = new Set(enabled.map((row) => row.connectorId));
  }

  // Single source of truth for the selection rule (tested in Step 1-4 above).
  const allowed = selectConnectorRowsForAgent({
    connectors,
    enabledConnectorIds: enabledIds,
    isCommander: input.agentId === null,
  });

  const svc = secretService(db);
  const rows: ResolvedConnectorRow[] = [];
  for (const c of allowed) {
    let secretValue: string | null = null;
    if (c.secretRef) {
      // resolveByName is the one-shot form; a SecretConsumerContext is MANDATORY
      // and is what makes the read auditable. Mirrors the github_pat read in
      // server/src/routes/workspace-git.ts:195-211.
      secretValue = await svc.resolveByName(input.companyId, c.secretRef, {
        consumerType: "system",
        consumerId: "mcp-connectors",
        actorType: "system",
        configPath: `mcp.connector.${c.serverName}`,
      });
    }
    rows.push({
      serverName: c.serverName,
      transport: c.transport,
      url: c.url,
      command: c.command,
      args: c.args ?? [],
      headerTemplate: c.headerTemplate ?? {},
      envTemplate: c.envTemplate ?? {},
      secretValue,
    });
  }
  return rows;
}
```

The secrets service is factory-style: `secretService(db)` from `server/src/services/secrets.ts` (re-exported via `services/index.js`). If `resolveByName` returns a wrapper rather than a bare string, unwrap it — do not add a new accessor.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @armyofagents/server typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add server/src/services/mcp-connectors.ts server/src/services/__tests__/mcp-connectors.test.ts
git commit -m "feat(mcp): add per-agent connector selection and database loader"
```

---

## Task 8: Env scrubbing — external servers must not inherit host secrets

`buildMcpBridgeSpec` injects `DATABASE_URL` into the bridge child env. That is correct for AoA's own loopback server and **catastrophic** for a third-party stdio connector.

**Files:**
- Modify: `server/src/services/mcp-connectors.ts`
- Modify: `server/src/services/__tests__/mcp-connectors.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/src/services/__tests__/mcp-connectors.test.ts`:

```ts
import { mergeConnectorEnv } from "../mcp-connectors.js";

// mergeConnectorEnv is the PURE half — it takes an already-scrubbed base so it
// can be tested with synthetic input. The real scrubbing is done by
// buildScrubbedCliEnv, which reads process.env internally and is not injectable.
describe("mergeConnectorEnv", () => {
  it("includes connector secrets", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, { AOA_MCP_NOTION_TOKEN: "secret-abc" });
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");
  });

  it("preserves PATH so npx-based stdio connectors can resolve", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, {});
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops undefined values from the scrubbed base", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin", EMPTY: undefined }, {});
    expect(env).not.toHaveProperty("EMPTY");
  });

  it("never lets a connector var overwrite PATH", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, { PATH: "/evil" });
    expect(env.PATH).toBe("/usr/bin");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts -t buildConnectorProcessEnv`
Expected: FAIL — `buildConnectorProcessEnv is not a function`

- [ ] **Step 3: Implement using the existing scrubbing primitive**

Append to `server/src/services/mcp-connectors.ts`:

```ts
import { buildScrubbedCliEnv } from "./cli-spawn-safety.js";

/**
 * PURE merge half, so it can be unit-tested with synthetic input.
 * PATH and other scrubbed-base entries win over connector vars — a connector
 * must never be able to redirect the executable lookup path.
 */
export function mergeConnectorEnv(
  scrubbedBase: NodeJS.ProcessEnv,
  connectorEnv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...connectorEnv };
  for (const [key, value] of Object.entries(scrubbedBase)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Env for a spawned CLI that will talk to EXTERNAL MCP servers.
 *
 * buildScrubbedCliEnv(keep) takes a KEEP-ALLOWLIST and reads process.env
 * internally (cli-spawn-safety.ts:67-85) — it does NOT take a base env. We pass
 * an empty allowlist so nothing secret-ish survives, then add back only the
 * connector token vars we generated. AoA's own DATABASE_URL and provider keys
 * must never reach a third-party server.
 */
export function buildConnectorProcessEnv(
  connectorEnv: Record<string, string>,
): Record<string, string> {
  return mergeConnectorEnv(buildScrubbedCliEnv([]), connectorEnv);
}
```

Before implementing, read `server/src/services/cli-spawn-safety.ts:67-85` and confirm that an empty `keep` still preserves `PATH`. If it does not, pass `["PATH"]` (plus `NODE_PATH` if stdio connectors need it) — stdio connectors cannot resolve `npx` without it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-connectors.test.ts`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mcp-connectors.ts server/src/services/__tests__/mcp-connectors.test.ts
git commit -m "fix(mcp): scrub host secrets from env handed to external MCP servers"
```

---

## Task 9: Enforce strict isolation on crew and Commander paths (D2)

Heartbeat passes `--strict-mcp-config`; crew and Commander do not, so they silently inherit the host machine's MCP config.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:496`
- Modify: `server/src/services/internal-agent/cli-mode.ts` (claude_cli branch, ~line 450)
- Create: `server/src/services/internal-agent/__tests__/strict-mcp-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/internal-agent/__tests__/strict-mcp-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

/**
 * Guard test: every Claude argv we construct that passes --mcp-config MUST also
 * pass --strict-mcp-config (D2). Without it the CLI additionally loads the host
 * machine's ~/.claude.json and project .mcp.json.
 */
function assertStrict(args: string[]) {
  if (args.includes("--mcp-config")) {
    expect(args).toContain("--strict-mcp-config");
  }
}

describe("strict mcp config invariant", () => {
  it("crew argv includes the strict flag", () => {
    const args = ["--mcp-config", "/tmp/x.json", "--strict-mcp-config", "--print"];
    assertStrict(args);
  });

  it("fails when the strict flag is missing", () => {
    expect(() => assertStrict(["--mcp-config", "/tmp/x.json"])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it passes as a guard**

Run: `pnpm vitest run server/src/services/internal-agent/__tests__/strict-mcp-config.test.ts`
Expected: PASS (2 tests) — this codifies the invariant before the fix.

- [ ] **Step 3: Add the flag to the crew path**

In `server/src/services/internal-agent/aoa-agents/runner.ts`, at the `isClaudeFamily` branch (~line 496), change:

```ts
args: ["--mcp-config", cfgPath, ...prevArgs],
```

to:

```ts
args: ["--mcp-config", cfgPath, "--strict-mcp-config", ...prevArgs],
```

- [ ] **Step 4: Add the flag to BOTH Commander argv sites**

`server/src/services/internal-agent/cli-mode.ts` builds Claude argv in **two** places, not one — `cli-mode.ts:453` (the `--system-prompt-file` path) and `cli-mode.ts:472` (the plain path). Insert `"--strict-mcp-config"` immediately after the `configPath` element in **both**, matching the crew change above. Fixing only one leaves half of Commander's runs inheriting host config.

- [ ] **Step 5: Verify no run regressions**

Run: `pnpm vitest run server/src/services/internal-agent`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/services/internal-agent/cli-mode.ts server/src/services/internal-agent/__tests__/strict-mcp-config.test.ts
git commit -m "fix(mcp): pass --strict-mcp-config on crew and Commander runs (D2)"
```

---

## Task 10: Deliver connectors on the `claude_local` heartbeat path

**Files:**
- Modify: `server/src/services/heartbeat-mcp.ts:31-61`
- Modify: `server/src/services/heartbeat.ts:4254-4272`

> **Naming:** the exported function is **`prepareHeartbeatMcpDelivery`** (`heartbeat-mcp.ts:31`). There is no `applyHeartbeatMcpDelivery`.
>
> **Shape:** `HeartbeatMcpDelivery` (lines 6-10) is the **output** type — `{ config, mcpBridge, cleanup }`, with **no `env` field**. The **input** is an inline anonymous object literal in the function signature at lines 31-37 (`{ adapterType, agentId, runId, config, params }`), so there is no named input interface to extend — widen the inline parameter type instead.

- [ ] **Step 1: Extend the inline input parameter**

In `server/src/services/heartbeat-mcp.ts`, add these two optional properties to the inline parameter object type at lines 31-37:

```ts
  /** External connectors resolved for this agent. Empty when none enabled. */
  extraMcpServers?: Record<string, McpServerSpec>;
  /** Real secret values for those connectors, injected into the spawn env. */
  connectorEnv?: Record<string, string>;
```

Add the import:

```ts
import type { McpServerSpec } from "@armyofagents/adapter-utils";
```

- [ ] **Step 2: Pass connectors into `buildMcpConfig`**

In the same file, change the config write (line ~51) from:

```ts
await fs.writeFile(configPath, JSON.stringify(buildMcpConfig(input.params), null, 2), "utf8");
```

to:

```ts
await fs.writeFile(
  configPath,
  JSON.stringify(
    buildMcpConfig({ ...input.params, extraMcpServers: input.extraMcpServers }),
    null,
    2,
  ),
  "utf8",
);
```

- [ ] **Step 3: Merge connector env into the returned config**

`HeartbeatMcpDelivery` has no `env` field — the only env the adapter sees is `config.env` inside the passed-through adapter config. In the `claude_local` return (the one that sets `[argKey]`), add alongside it:

```ts
env: {
  ...(input.config.env as Record<string, string> | undefined),
  ...(input.connectorEnv ?? {}),
},
```

**Critical:** `prepareHeartbeatMcpDelivery` has an **early return at lines 39-45** for every non-`claude_local` adapter, which returns `input.config` untouched. A merge placed only in the second return silently no-ops for codex/opencode/gemini. That is acceptable for Plan 1 (claude-only scope) but **must** be revisited in Plan 2 — add a comment at the early return recording this so it isn't missed:

```ts
// NOTE(Plan 2): connectorEnv is NOT merged on this path. Non-claude adapters
// receive connectors via ctx.mcpServers, wired in the per-adapter plan.
```

- [ ] **Step 4: Resolve connectors at the heartbeat call site**

In `server/src/services/heartbeat.ts`, before the `prepareHeartbeatMcpDelivery` call at **line 4272**, resolve the agent's connectors:

```ts
const connectorRows = await loadEnabledConnectorRows(db, {
  companyId: agent.companyId,
  agentId: agent.id,
});
const { specs: extraMcpServers, env: connectorEnv } = buildConnectorSpecs(connectorRows);
```

Then pass `extraMcpServers` and `connectorEnv` as additional properties on the object handed to `prepareHeartbeatMcpDelivery(...)` at line 4272.

**Do not mutate `heartbeatMcpParams`** (declared `as const` at lines 4254-4271) — pass the connector fields as siblings on the delivery call's argument object instead.

`loadEnabledConnectorRows` is implemented in Task 7, Step 5.

- [ ] **Step 5: Typecheck and run the server suite**

Run: `pnpm --filter @armyofagents/server typecheck && pnpm vitest run server/src`
Expected: no type errors, all tests pass

- [ ] **Step 6: Commit**

```bash
git add server/src/services/heartbeat-mcp.ts server/src/services/heartbeat.ts server/src/services/mcp-connectors.ts
git commit -m "feat(mcp): deliver company connectors to claude_local heartbeat runs"
```

---

## Task 11: CRUD routes with RBAC and approval gate (D6, D7)

**Files:**
- Create: `server/src/routes/mcp-connectors.ts`
- Modify: `server/src/app.ts` (mount the router)

Follow the structure of `server/src/routes/goals.ts` for router shape. (Note: there is **no** `server/src/routes/mcp.ts` — the inbound MCP key routes live in `server/src/mcp/server.ts:332-360`. Do not look for a file that doesn't exist.)

Auth helpers are real and live in `server/src/routes/authz.ts`:

```ts
import { assertBoard, assertCompanyAccess } from "./authz.js";
```

Deployment mode comes from `loadConfig()` (`server/src/config.ts:117`), field `deploymentMode`, defaulting to `"local_trusted"`:

```ts
import { loadConfig } from "../config.js";
```

- [ ] **Step 1: Write the failing test for the transport policy**

Create `server/src/routes/__tests__/mcp-connectors-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assertTransportAllowed } from "../mcp-connectors.js";

describe("assertTransportAllowed (D7)", () => {
  it("allows http BYO in authenticated mode", () => {
    expect(() => assertTransportAllowed("http", "authenticated", "byo")).not.toThrow();
  });

  it("rejects stdio BYO in authenticated mode", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "byo")).toThrow(
      /remote HTTP/i,
    );
  });

  it("allows stdio BYO in local_trusted mode", () => {
    expect(() => assertTransportAllowed("stdio", "local_trusted", "byo")).not.toThrow();
  });

  it("allows stdio from the verified catalog in authenticated mode", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/routes/__tests__/mcp-connectors-policy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the policy helper and router**

Create `server/src/routes/mcp-connectors.ts` starting with:

```ts
/**
 * D7 — stdio connectors execute a command on the AoA host. On a local_trusted
 * deployment that host is the founder's own machine, which is the same thing
 * they would do in Claude Code directly. In authenticated/cloud deployments it
 * is multi-tenant remote code execution, so BYO is restricted to remote HTTP
 * and stdio is permitted only from verified catalog entries.
 */
export function assertTransportAllowed(
  transport: string,
  deploymentMode: string,
  source: string,
): void {
  if (transport !== "stdio") return;
  if (deploymentMode === "local_trusted") return;
  if (source === "catalog") return;
  throw new Error(
    "Only remote HTTP connectors can be added in this deployment. stdio connectors are restricted to verified catalog entries.",
  );
}
```

Then add the router as a `(db: Db) => Router` factory, matching `goals.ts:18`. **Router paths carry no `/api` prefix** — the app mounts the whole api sub-router at `/api`. All endpoints sit behind `assertBoard` + `assertCompanyAccess`:

- `GET /companies/:companyId/mcp-connectors` — list
- `POST /companies/:companyId/mcp-connectors` — create. Calls `assertTransportAllowed`. Sets `status` to `"active"` when `loadConfig().deploymentMode === "local_trusted"`, otherwise `"pending_approval"` and raises an approval (D6).
- `PATCH /companies/:companyId/mcp-connectors/:id` — update display name / status
- `DELETE /companies/:companyId/mcp-connectors/:id` — remove
- `PUT /companies/:companyId/mcp-connectors/:id/agents` — replace the enabled-agent set

For the approval, mirror the **real** agent-hire path at `server/src/routes/agents.ts:1088-1120` (not line 784, which is an unrelated scheduler route):

```ts
import { approvalService } from "../services/index.js";
// ...
const approvalsSvc = approvalService(db);
const approval = await approvalsSvc.create(companyId, {
  type: "install_mcp_connector",
  requestedByUserId: req.user.id,
  status: "pending",
  payload: { connectorId: created.id, serverName: created.serverName },
});
```

Restrict create/update/delete to `founder` (team leads may not add external network access unilaterally).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/routes/__tests__/mcp-connectors-policy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Mount the router**

Company-scoped routers mount on the **`api` sub-router**, not on `app` directly (`app.use("/api", api)` happens at `app.ts:553`). Alongside `api.use(goalRoutes(db))` at **`app.ts:307`**, add:

```ts
api.use(mcpConnectorRoutes(db));
```

Mounting with `app.use(...)` or at line 417 (which is plugin-runtime composition) would put the routes at the wrong path.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcp-connectors.ts server/src/routes/__tests__/mcp-connectors-policy.test.ts server/src/app.ts
git commit -m "feat(mcp): add connector CRUD routes with deployment-aware stdio policy"
```

---

## Task 12: Close the `extraArgs` escape hatch

The agent config form lets a founder hand-type `--mcp-config,/path/servers.json`, bypassing every control in this plan.

> **Why this is NOT an adapter-side fix.** The adapter cannot tell AoA's injected
> args from the user's: `claude-local/src/server/execute.ts:258-262` reads a single
> `config.extraArgs` (falling back to `config.args`), and AoA injects its own
> `--mcp-config <path> --strict-mcp-config` into **that exact key**
> (`heartbeat-mcp.ts:52-60`, `runner.ts:496`). Stripping inside the adapter would
> delete AoA's own config and **break every `claude_local` MCP run**.
>
> The strip must happen **server-side, at the injection points**, where the user's
> args are still a separate array before AoA prepends its own.

**Files:**
- Create: `server/src/services/mcp-arg-sanitize.ts`
- Create: `server/src/services/__tests__/mcp-arg-sanitize.test.ts`
- Modify: `server/src/services/heartbeat-mcp.ts:52-60`
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:496`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/__tests__/mcp-arg-sanitize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stripUserMcpArgs } from "../mcp-arg-sanitize.js";

describe("stripUserMcpArgs", () => {
  it("removes a user-supplied --mcp-config and its value", () => {
    expect(stripUserMcpArgs(["--mcp-config", "/tmp/evil.json", "--foo"])).toEqual(["--foo"]);
  });

  it("removes --strict-mcp-config supplied by the user", () => {
    expect(stripUserMcpArgs(["--strict-mcp-config", "--foo"])).toEqual(["--foo"]);
  });

  it("leaves unrelated args untouched", () => {
    expect(stripUserMcpArgs(["--model", "opus"])).toEqual(["--model", "opus"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run server/src/services/__tests__/mcp-arg-sanitize.test.ts`
Expected: FAIL — `Cannot find module '../mcp-arg-sanitize.js'`

- [ ] **Step 3: Implement the sanitizer**

Create `server/src/services/mcp-arg-sanitize.ts`:

```ts
/**
 * MCP configuration is owned by AoA (D2). A user-typed --mcp-config in the
 * agent's "Extra args" box would bypass company approval, per-agent enablement,
 * env scrubbing, and audit.
 *
 * Apply this ONLY to user-supplied args, at the server-side injection points,
 * BEFORE AoA prepends its own flags. Never apply it to the combined array — the
 * adapter cannot distinguish the two and would strip AoA's own config.
 */
export function stripUserMcpArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--strict-mcp-config") continue;
    if (arg === "--mcp-config") {
      i += 1; // also drop its value
      continue;
    }
    out.push(arg);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run server/src/services/__tests__/mcp-arg-sanitize.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Apply at both injection points**

In `server/src/services/heartbeat-mcp.ts` (lines 52-60), wrap the user's args:

```ts
[argKey]: [
  "--mcp-config",
  configPath,
  "--strict-mcp-config",
  ...stripUserMcpArgs(existingArgs),
],
```

In `server/src/services/internal-agent/aoa-agents/runner.ts:496`, do the same to `prevArgs`:

```ts
args: ["--mcp-config", cfgPath, "--strict-mcp-config", ...stripUserMcpArgs(prevArgs)],
```

Import `stripUserMcpArgs` from `./mcp-arg-sanitize.js` (adjust the relative path in `runner.ts`).

- [ ] **Step 6: Verify MCP runs still work**

Run: `pnpm vitest run server/src`
Expected: PASS. Then confirm manually that a `claude_local` run still receives `--mcp-config` — this is the regression the audit caught, so do not skip it.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/mcp-arg-sanitize.ts server/src/services/__tests__/mcp-arg-sanitize.test.ts server/src/services/heartbeat-mcp.ts server/src/services/internal-agent/aoa-agents/runner.ts
git commit -m "fix(mcp): strip user-supplied --mcp-config at server-side injection points"
```

---

## Task 13: Settings → Connectors UI

A **sibling** of the existing MCP page, never an extension of it — that page is inbound (external clients calling AoA); this is outbound (AoA calling external servers). Conflating them will confuse users and reviewers.

**Files:**
- Create: `ui/src/api/mcpConnectors.ts`
- Create: `ui/src/components/settings/sections/MCPConnectorsSection.tsx`
- Modify: the settings section registry that lists `MCPApiKeysSection`

- [ ] **Step 1: Write the API client**

Create `ui/src/api/mcpConnectors.ts`, mirroring the shape of `ui/src/api/mcp.ts`:

```ts
// The client exports `api` (client.ts:72), NOT `apiFetch`.
// client.ts:1 sets `const BASE = "/api"` and prepends it, so paths here must
// NOT include /api — otherwise requests hit /api/api/...
// Bodies are passed as plain objects, never pre-stringified.
import { api } from "./client";

export interface McpConnector {
  id: string;
  serverName: string;
  displayName: string;
  transport: "http" | "stdio";
  url: string | null;
  status: "pending_approval" | "active" | "disabled";
  source: "byo" | "catalog";
}

export const mcpConnectorsApi = {
  list: (companyId: string) =>
    api.get<McpConnector[]>(`/companies/${companyId}/mcp-connectors`),
  create: (companyId: string, body: Partial<McpConnector> & { secretValue?: string }) =>
    api.post<McpConnector>(`/companies/${companyId}/mcp-connectors`, body),
  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/mcp-connectors/${id}`),
  setAgents: (companyId: string, id: string, agentIds: string[]) =>
    api.put<{ ok: true }>(`/companies/${companyId}/mcp-connectors/${id}/agents`, { agentIds }),
};
```

Confirm `api.put` exists in `ui/src/api/client.ts`; if it does not, use `api.post` and change the route verb to match. Mirror the call style in `ui/src/api/mcp.ts:8` exactly.

- [ ] **Step 2: Build the section component**

Create `ui/src/components/settings/sections/MCPConnectorsSection.tsx` following the layout and copy conventions of `MCPApiKeysSection.tsx`. It must render:

- A heading: **Connectors** with the subtitle "External tools and data sources your agents can use."
- A list of connectors: display name, transport badge, status badge, and a per-agent enablement control.
- An "Add connector" form with fields: display name, server name, transport (HTTP/stdio), URL or command, and an optional secret. In `authenticated` deployments the stdio option must be disabled with the reason shown inline (D7).
- An empty state explaining that connectors give agents access to external tools.

- [ ] **Step 3: Register the section**

Add `MCPConnectorsSection` to the settings registry immediately after the existing MCP API keys section so the two appear as distinct siblings.

- [ ] **Step 4: Verify in the browser**

Start the dev server and confirm the section renders, the form validates, and a created HTTP connector appears in the list with `pending_approval` (authenticated) or `active` (local_trusted).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/mcpConnectors.ts ui/src/components/settings/sections/MCPConnectorsSection.tsx
git commit -m "feat(mcp): add Settings Connectors section for BYO MCP servers"
```

---

## Task 14: End-to-end verification

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test:run`
Expected: all tests pass

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: no errors

- [ ] **Step 3: Apply migrations against a dev database**

Run: `pnpm db:migrate`
Expected: the two new tables are created

- [ ] **Step 4: Live-verify the full loop**

1. Start the app. In Settings → Connectors, add an HTTP connector pointing at a real MCP server you can authenticate to.
2. Approve it if the deployment mode requires approval.
3. Enable it for one agent.
4. Dispatch a task to that agent and inspect the generated MCP config in `tmpdir()` — confirm it contains the connector entry with a `${AOA_MCP_*_TOKEN}` placeholder and **no plaintext secret**.
5. Confirm the run's argv contains both `--mcp-config` and `--strict-mcp-config`.
6. Confirm an agent *without* the opt-in does **not** receive the connector.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "test(mcp): verify connector delivery end-to-end"
```

---

## Follow-ups (not in this plan)

- **Plan 2** — `gemini_local`, `opencode_local`, `codex_local` writers. Codex is the sharpest edge: `stripAoaMcpBlocks` hard-codes `[mcp_servers.X]` and `[mcp_servers.X.env]`, so a new `[mcp_servers.X.headers]` table would be **orphaned by the stripper and accumulate stale credentials across runs**. That fix must ship in the same change as codex header support. Also note `codex-local/src/server/execute.ts:348-353` skips MCP entirely for `sandbox-docker` targets.
- **Plan 3** — marketplace `connector` type (coordinated two-repo schema bump per Decision #96), curated seed set, bulk import from the MCP registry.
- **Plan 4** — flagship plugins + Better Auth `genericOAuth` broker, including company-scoping of the `account` table (a user in two companies would otherwise collide) and explicit token lifetimes so refresh actually fires.
- **Audit logging** — record connector tool invocations in `activity_log`. Deferred until Plan 2 lands so the event shape covers all adapters.
- **Tool budget** — a connector exposing many tools consumes context. Measure before capping.

---

## Amendments during execution

Recorded as they are decided, so later tasks are not built against a stale spec.

**A1 — Type guards take `unknown` (decided Task 1).** `isStdioServerSpec` / `isHttpServerSpec` accept `unknown` and perform a structural check (discriminant + required-field type), not a `McpServerSpec` narrowing. Rationale: TypeScript narrows `spec.kind === "http"` natively, so typed guards were dead indirection with tautological tests. The real need is validating untrusted input — Tasks 6 and 11 build specs from DB rows typed `transport: string`, `url: string | null`. **Tasks 6 and 11 should use these guards at the DB boundary** rather than trusting the row shape.

**A2 — SSE transport deliberately deferred (decided Task 1).** The union is `stdio | http` only. A code review argued for adding SSE now to avoid a later migration, but `company_mcp_connectors.transport` is a `text` column, not a pg enum, so adding `"sse"` later costs no migration and no backfill. Plan 1 is `claude_local`-only and Claude Code deprecates SSE in favour of HTTP. Revisit in Plan 2 if a target connector is SSE-only.

**A3 — Codex header handling (carry to Plan 2).** A review raised that codex might force reverse-parsing `"Bearer ${VAR}"` back into an env var name for `bearer_token_env_var`. Codex also supports a literal `[mcp_servers.<name>.http_headers]` table, so the regex round-trip is avoidable — prefer literal headers. **Verify against the installed codex version before implementing the codex writer.** If a var-name field turns out to be required, add an optional `authTokenEnvVar?: string` to the http member rather than parsing it out of a string.

**A4 — Plan bug found in execution.** Task 1 Step 7's `git add` line omits `packages/adapter-utils/src/index.ts`, which Step 5b modifies. The implementer caught and corrected it. Later tasks: treat the `git add` lists as indicative, and stage everything the task actually touched.

**A5 — Guards validate the discriminant + ONE field only (Tasks 6 and 11, read this).** `isStdioServerSpec` checks `kind` + `typeof command === "string"`; `isHttpServerSpec` checks `kind` + `typeof url === "string"`. They do NOT validate `args`, `env`, or `headers`, yet they narrow to interfaces that promise those are well-shaped. This is deliberate: the two nullable DB columns (`url`, `command`) are exactly the ones checked, and the jsonb columns are `notNull().default(...)`. **But `$type<string[]>()` on a jsonb column is a compile-time assertion with no runtime guarantee** — a hand-written or imported row could pass the guard and then throw on `spec.args.map(...)`. Do not treat a passing guard as proof those three fields are well-formed.

**A6 — `@packageDocumentation` does not bind module docs under `tsc` (Task 1 follow-up).** It is a TSDoc/API-Extractor convention; `tsc` ignores it for doc binding and strips the separating blank line on `.d.ts` emit, so the module block still attaches to whichever interface follows it. The fix is a one-line JSDoc on each interface so `tsc` binds the nearest comment. Folded into Task 2. The security-relevant field-level warnings were unaffected and bind correctly.

**A7 — Task 1 Step 5 is VOID. Do not re-add it.** Step 5 mandated a `export type {...} from "./mcp-server-spec.js"` re-export in `types.ts`. Step 5b then made it redundant (`index.ts` imports the types and guards directly from `./mcp-server-spec.js`), and Task 2 deleted it as verified-dead. If this plan is ever re-run or resumed, SKIP Task 1 Step 5. `types.ts` should contain only the `import type { McpServerSpec }` that `AdapterExecutionContext` needs.

**A8 — Prototype-pollution guard required in Tasks 3 and 6.** `buildMcpConfig` assigns `config.mcpServers[name] = ...` where `name` is a runtime string from a DB row. A connector named `__proto__` would set the object's prototype instead of adding a key, and the server would **silently vanish with no error** — the worst possible failure mode for a security-adjacent feature. Required in Task 3: build the servers map with `Object.create(null)` OR validate names against `/^[a-zA-Z0-9_-]+$/` before assignment. Required in Task 11: validate `serverName` against that charset at registration time so bad names never reach the DB. Note the plan sanitizes only the derived env-var slug (`envVarNameFor`), NOT the key itself.

**A9 — Reserved names belong in one shared export (do in Task 3).** Task 3's guard hand-types `if (name === "aoa" || name === "playwright") continue;`. Plan 2 would replicate those literals into three more adapter writers with nothing linking them. Instead add to `packages/adapter-utils/src/mcp-server-spec.ts`, next to the guards:

```ts
export const RESERVED_MCP_SERVER_NAMES = ["aoa", "playwright"] as const;
export function stripReservedMcpServerNames(
  servers: Record<string, McpServerSpec>,
): Record<string, McpServerSpec>;
```

Task 3 and all of Plan 2 then call one function. (Note: the reviewer referred to this as "Task 4" — the reserved-name guard is in **Task 3**; Task 4 is the `${VAR}` expansion gate.)

**A10 — `Record<string, McpServerSpec>` carrier shape is CORRECT; do not change it.** Questioned during review and affirmed: the Record makes duplicate server names structurally unrepresentable, which is exactly the per-run uniqueness invariant. An array of `{name, spec}` would permit duplicates and force every consumer to decide first-wins vs last-wins independently. Compile-time exclusion of reserved names is NOT achievable on the real path — the producer builds the map in a loop from DB rows with runtime-string keys, so a runtime guard at the serialization boundary is the only enforcement that works.

**A8-CORRECTION — charset validation does NOT prevent prototype pollution. Supersedes the "OR" in A8.** A8 offered `Object.create(null)` **or** a `/^[a-zA-Z0-9_-]+$/` charset check as equivalent fixes. They are not equivalent: `__proto__` is composed entirely of letters and underscores and therefore **passes that regex**. A charset check alone leaves the hole wide open.

Binding rule for Task 3: the `mcpServers` map MUST be built with `Object.create(null)` (or a `Map` converted at serialization). With a null-prototype object there is no inherited `__proto__` setter, so the assignment becomes an ordinary own property and `JSON.stringify` emits it correctly.

The charset check is still worth having in Task 11 at registration time, for name hygiene and to keep `envVarNameFor` collision-free — but it is defence in depth, NOT the prototype-pollution fix. Do not treat it as the fix.

**A11 — `config.mcpServers` is a NULL-PROTOTYPE object; never assert it with `toStrictEqual` (Task 10 onward).** `buildMcpConfig` builds the map with `Object.create(null)` (A8-CORRECTION). Vitest's `toEqual` ignores prototypes and passes; `toStrictEqual` compares them and will fail with a confusing "does not match expected prototype" error against a normal object literal. Use `toEqual`, or compare `JSON.parse(JSON.stringify(config))` — which is what actually reaches the CLI anyway. No current test uses `toStrictEqual`; this is a trap for new ones.

**A12 — `McpConfigServerEntry` is an all-optional bag; consider a discriminated union if Task 10 adds strict consumers.** Every field is optional (`command?`, `args?`, `env?`, `type?`, `url?`, `headers?`), so `config.mcpServers.aoa.env.X` is a possibly-undefined access. This surfaces no errors today only because `server/tsconfig.json` has `exclude: ["src/__tests__"]` — note `server/src/services/internal-agent/__tests__/` is NOT excluded and IS typechecked. If Task 10 introduces consumers in `src/` that read these fields, prefer a discriminated union on `type` over the optional bag. Not changed now: the shape is what the CLIs' own config formats accept, and no consumer reads it back today.

**A13 — TASK 6 HAS THE SAME PROTOTYPE HOLE. A8's body under-specified this.** A8's header says "required in Tasks 3 and 6" but its body only enumerates Tasks 3 and 11. Task 6's plan text specifies `const specs: Record<string, McpServerSpec> = {};` followed by `specs[row.serverName] = ...` — a **plain object literal with `[[Set]]` assignment**. A connector named `__proto__` therefore vanishes at the PRODUCER, before Task 3's guard is ever reached. Task 3's protection does not help, because the value never arrives.

Binding rule for Task 6: build the `specs` map with `Object.create(null)`, or construct it via the shared `mergeExternalMcpServers` helper added in Task 3. Same for any other place that assigns a DB-sourced name as an object key — including `buildConnectorSpecs`'s `env` map, whose keys come from `envVarNameFor` (currently safe because that slug is regex-sanitized and uppercased, but do not rely on it silently).

**A14 — Use `mergeExternalMcpServers`, never `stripReservedMcpServerNames` + your own merge (Plan 2, all three writers).** The strip helper returns a null-prototype object, but **that prototype is not transitive to your destination map**. Verified: merging its output via `Object.assign({aoa}, stripped)` or `for (…) target[name] = …` into a `{}` both silently drop a `__proto__`-named connector; only object-spread survives (spread uses `[[Define]]`). `mergeExternalMcpServers` couples reserved-name filtering and the null-prototype destination so neither can be obtained without the other. Reserved entries win on collision.

**A15 — Naming drift across the three hops (cosmetic, do not churn).** The same concept is called `mcpServers` on `AdapterExecutionContext`, `extraMcpServers` on `McpConfigParams`, and will be threaded as `input.extraMcpServers` in Task 10. These are the same thing. Not worth renaming mid-flight; recorded so Plan 2 authors don't assume they differ.

**A16 — A GREEN VITEST RUN IS NOT EVIDENCE OF A CLEAN TYPECHECK. Every task must run both.** Vitest transpiles without typechecking, so type errors in test files pass silently at runtime. Hit for real in Task 3: all 15 tests passed green while `pnpm --filter @armyofagents/adapter-utils typecheck` was RED — a `{...} as const` had produced `args: readonly []`, which is not assignable to `McpStdioServerSpec.args: string[]`. (Fix was to annotate `const ours: McpServerSpec = {...}` rather than use `as const`.) Note this bites hardest in test files that ARE typechecked: `server/tsconfig.json` excludes `src/__tests__` but NOT `src/services/**/__tests__`, so those are compiled. Always run the relevant `typecheck` alongside the test suite before reporting a task done.

---

## Task 4 GATE RESULT — PASSED (2026-07-23, Claude Code 2.1.126)

**`${VAR}` expansion in a `--mcp-config` file is CONFIRMED WORKING. D5 (env-indirection secret transport) is validated and stands. No fallback to `headersHelper` is required.**

Verified empirically, not from documentation, by observing what the server actually received:

| Path | Placeholder written to config | Value received | Result |
|---|---|---|---|
| stdio `args[]` | `${AOA_PROBE_TOKEN}` | `sentinel-12345` | expands |
| stdio `env{}` | `${AOA_PROBE_TOKEN}` | `sentinel-12345` | expands |
| **http `headers{}`** | `Bearer ${AOA_PROBE_TOKEN}` | `Bearer sentinel-12345` | expands |

Method: a stdio MCP server that wrote its own `process.argv[2]` / `process.env` to disk, and a local HTTP listener on `127.0.0.1:8899` that recorded the inbound `Authorization` header. Both were driven by a real `claude --mcp-config <file> --strict-mcp-config -p ... --max-turns 1` session. The http case is the important one — it is the primary connector path.

**Method notes for anyone re-running this:**

1. **The `claude mcp ...` management subcommands IGNORE `--mcp-config`.** `claude --mcp-config <f> --strict-mcp-config mcp get probe` reported `No MCP server found` and listed the machine's ambient servers instead. `--mcp-config` applies to a *session run*, not to `mcp get`/`mcp list`. Do not use those subcommands to verify config delivery.
2. **`--debug` emitted no MCP diagnostics to stderr on 2.1.126.** Grepping debug output is not a viable probe; observe the server side instead.
3. Pass `< /dev/null` or the run warns about waiting on stdin.

**A17 — claude.ai connector inheritance is CONFIRMED REAL on this machine, which is the premise of D2.** The ambient server list surfaced by `claude mcp get` was: `claude.ai Gmail`, `claude.ai Google Calendar`, `plugin:github:github`, `vibe_kanban`. So a Claude Code CLI logged into a claude.ai account genuinely does inherit that account's connectors, and any AoA run that omits `--strict-mcp-config` would expose them to the agent. This is exactly the leak D2 closes and is direct evidence for making crew/Commander strict (Task 9). NOT yet verified: that `--strict-mcp-config` actually suppresses them *inside a session* — Anthropic documents it, but Task 9 or Task 14 should confirm it empirically now that a working probe method exists.

**A18 — Migrations live in `packages/db/src/migrations/`, NOT `packages/db/drizzle/`.** The plan's Task 5 text named the wrong directory. `pnpm db:generate` writes the `.sql` file plus `meta/<n>_snapshot.json` and appends to `meta/_journal.json` under `src/migrations/`. Stage all three. Task 5 produced `0178_fantastic_killmonger.sql`. Correct any later task text that references the `drizzle/` path.

**A19 — TASK 7: one dangling `secretRef` must not kill the whole connector load.** `secretService(db).resolveByName(...)` **THROWS** `notFound` when the secret is missing or soft-deleted (`server/src/services/secrets.ts:464-468`). The plan's loader calls it inside a bare `for` loop with no error handling, so a single stale `secretRef` — trivially produced by deleting a secret while a connector still references it — aborts the entire load and the agent run silently gets NO connectors, including every healthy one. Required in Task 7: wrap per-connector secret resolution in `try`/`catch`, skip that connector, and log a warning naming it. A broken connector must degrade to "that one connector is unavailable", never "no connectors at all". Task 11 should additionally verify the secret exists at registration time so the dangling state is hard to create.

**A20 — TASK 11 MUST IMPLEMENT VALIDATION; the schema delegates every invariant to it and its plan text currently has none.** A review grep of Task 11's section found `zod` × 0, `validate` × 0, `url` × 0 — there is no request schema, and A8's required `serverName` charset check is missing from its body. The DB deliberately does NOT enforce these (a CHECK on `transport ⇒ url NOT NULL` would be an enum in disguise and would reintroduce exactly the migration cost A2 removed). Task 11 must therefore validate: `transport` is one of the supported values; `http` requires `url` and forbids `command`; `stdio` requires `command` and forbids `url`; `serverName` matches `/^[a-zA-Z0-9_-]+$/` (hygiene and env-var-slug collision-avoidance — NOT the prototype-pollution fix, see A8-CORRECTION); and the referenced secret exists (A19).

**Recommended:** define that discriminated union ONCE as a zod schema in `packages/shared` and consume it from both Task 11's route and Task 6's producer, so the invariant has a single definition rather than two that drift apart.

**A21 — `serverName` charset MUST be `/^[a-z0-9-]+$/` (lowercase, digits, hyphen ONLY). This supersedes the charset given in A20.** A20 proposed `/^[a-zA-Z0-9_-]+$/`. That is unsafe, because `envVarNameFor` maps every non-alphanumeric character to `_` and uppercases the result — so with underscores or uppercase permitted the mapping is **not injective**:

- `a-b` and `a_b` both → `AOA_MCP_A_B_TOKEN`
- `a-b` and `A-B` both → `AOA_MCP_A_B_TOKEN`

Two connectors sharing one env var name means one secret silently overwrites the other and **the wrong credential is sent to the wrong server** — a silent cross-tenant-ish leak between two of the company's own connectors, with no error anywhere.

Restricting to lowercase + digits + hyphen makes `-` the only character that maps to `_`, and removes case as a second collision source, so `envVarNameFor` becomes injective over the permitted set. This also matches the `company_mcp_connectors.serverName` column comment ("Lowercase, no spaces") and MCP-idiomatic names (`notion`, `linear`, `my-server`). Task 11 must enforce it at registration.

**A22 — `envVarNameFor` maps per-character; do NOT "optimise" the regex with `+`.** The replace is `/[^a-zA-Z0-9]/g`, one underscore per character, deliberately. Adding the `+` quantifier to collapse runs reintroduces a collision (`a-b` vs `a--b` → same name) that A21's charset restriction does NOT cover, since `--` is legal under `[a-z0-9-]+`. A plan-text/test contradiction on exactly this point was caught during Task 6; the test is authoritative.

**A23 — Task 10 must document the dynamic `AOA_MCP_*_TOKEN` env family.** The repo's brand-check guard requires every `process.env.AOA_*` read in `server/src` to be documented. Task 6 only *constructs* these names as strings and never reads them, so the guard does not fire yet. Once Task 10 spawns processes carrying them, add a line covering the `AOA_MCP_<CONNECTOR>_TOKEN` family to `docs/deploy/environment-variables.md` or the guard will fail CI.

**A24 — TASK 7: put the DB loader in a NEW file, not in `mcp-connectors.ts`.** The plan's Task 7 Step 5 appends `loadEnabledConnectorRows` to the same file as the pure transform. Verified empirically that adding `drizzle-orm` / `@armyofagents/db` imports there does NOT break the existing tests (CLAUDE.md's drizzle ESM-cycle workaround is not triggered), so this is not a correctness blocker — but it converts a zero-runtime-dependency pure module into one that transitively loads the DB package, and co-locates the I/O unit with the unit that must stay trivially testable.

Create `server/src/services/mcp-connectors-loader.ts` for `loadEnabledConnectorRows` + `selectConnectorRowsForAgent`, importing the pure helpers from `mcp-connectors.ts`. Cheap now; more expensive once Task 7 has landed and Task 10 imports from whichever file.

**A25 — `ResolvedConnectorRow` stays hand-declared; do NOT derive it from the drizzle table type.** Purity is not the reason (`import type` is fully erased). The reason is A5: `$type<string[]>()` on a jsonb column is an unsound compile-time assertion, so deriving would import that fiction and make it look authoritative at exactly the trust boundary where it is least true. Hand-declaring keeps the boundary explicit. Fields verified to match `company_mcp_connectors` exactly as of Task 6.

**A26 — `buildConnectorSpecs`'s runtime floor is "does not throw", NOT "is well-formed" (Task 11 must close the gap).** Task 6 wraps each row in `try`/`catch` so a malformed jsonb value cannot take down healthy connectors. But `Object.entries` does not throw on every wrong type: a `headerTemplate` stored as the string `"ab"` yields per-character entries `{0:"a",1:"b"}` — a nonsense-but-valid header map that is emitted rather than skipped; a number yields `{}`. Consequences are contained (no secret exposure, no other connector affected, and it surfaces in `skipped[]` only when it actually throws), but a wrong-typed column can still produce a malformed spec that reaches a CLI. Structural validation of `args` / `headerTemplate` / `envTemplate` belongs at WRITE time in Task 11 — deliberately not duplicated in the pure transform.

**A27 — `consumerType: "system"` in the connector secret-read context is LOAD-BEARING. Do not "tighten" it.** `resolveSecretValue` calls `assertBinding`, which throws `"Secret is not bound to this consumer path"` unless a matching `company_secret_bindings` row exists. `shouldEnforceSecretBinding` (`server/src/services/secrets.ts:112`) returns `false` for `consumerType === "system"`, which is why the connector loader resolves secrets without Task 11 having to create binding rows.

If anyone later changes this to `consumerType: "agent"` (or anything else) as a security "improvement", **every connector silently stops resolving** — and thanks to A19's per-connector `try`/`catch`, it fails quietly per connector rather than loudly, so it would present as "connectors mysteriously stopped working" with no obvious cause. If binding enforcement is ever wanted here, Task 11 must create `company_secret_bindings` rows at registration FIRST, and the two changes must land together.

Access remains audited either way — `auditAccess` runs on both success and failure paths, and `configPath: mcp.connector.<serverName>` distinguishes connectors in the trail.

**A28 — TASK 14 MUST verify the claude.ai ACCOUNT connectors are suppressed, not just file config.** `--strict-mcp-config` is documented to ignore file-based MCP config (`~/.claude.json`, project `.mcp.json`). But the ambient `claude.ai Gmail` / `claude.ai Google Calendar` servers on this machine come from the logged-in claude.ai ACCOUNT, a separate channel. It is plausible the flag scopes only file config and account connectors ride a different path — in which case D2's "AoA is the sole source of truth" guarantee has a hole for account-linked connectors specifically. Task 14 (or the empirical check below) must confirm the claude.ai-account servers disappear from a strict session, not merely the file-based `plugin:github`/`vibe_kanban` entries. If they do NOT disappear, that is a D2 finding to escalate to the founder, not a bug to silently work around.

## A28 RESOLVED — `--strict-mcp-config` DOES suppress claude.ai account connectors (verified 2026-07-23, Claude Code 2.1.126)

Empirically settled, so Task 14 need not re-open it (though a light re-confirm there is fine). Method: two identical one-shot sessions with an empty `--mcp-config` (so no AoA server), asking the model to list its available MCP tools.

| Session | Model-reported MCP tools |
|---|---|
| `--mcp-config empty.json` (non-strict) | `mcp__claude_ai_Gmail__authenticate`, `…__complete_authentication`, `mcp__claude_ai_Google_Calendar__authenticate`, `…__complete_authentication` |
| `--mcp-config empty.json --strict-mcp-config` | **NONE** |

So the flag scopes BOTH file config AND claude.ai account connectors — the account-channel concern in A28 does not materialize. D2's guarantee (AoA is the sole source of truth for what an agent can reach) holds completely for crew and Commander once Task 9's flag is in place. No D2 hole to escalate.

## Task 10 LIVE PROBE — full connector delivery verified end-to-end (2026-07-23, Claude Code 2.1.126)

The complete D5 chain works on a real CLI, not just in unit tests. Method: a local HTTP MCP listener that records its inbound `Authorization` header, plus a config file of the exact shape `buildMcpConfig` emits for a connector — `{"slack":{"type":"http","url":"...","headers":{"Authorization":"Bearer ${AOA_MCP_SLACK_TOKEN}"}}}` — driven by `claude --mcp-config <file> --strict-mcp-config` with `AOA_MCP_SLACK_TOKEN=live-connector-token-999` in the process env (mirroring how Task 10 delivers it via `config.env`).

Result: the connector received `Authorization: Bearer live-connector-token-999` — the real token, expanded by the CLI from the on-disk placeholder. Confirms placeholder-on-disk → token-in-env → CLI-expands → connector-gets-real-credential, with no plaintext secret in the config file, under strict isolation.

**A29 — Task 8's `buildConnectorProcessEnv` is deliberately NOT used on the claude_local heartbeat path; this is correct, not dead code.** The claude adapter spawns via `mergeChildEnv(process.env, opts.env)` (`packages/adapter-utils/src/server-utils.ts:508`) and NEEDS the full host env — PATH, HOME, and the CLI's own login/API auth. Scrubbing there would strip the credentials the `claude` binary itself requires and break auth. Task 10 therefore merges `connectorEnv` into `config.env` without scrubbing. `buildConnectorProcessEnv` (scrub-to-minimal) is for a DIFFERENT spawn model — a locally-spawned stdio connector process that should NOT inherit the host env — which is a Plan 2 / future concern, not this path. Do not "fix" Task 10 to call it, and do not delete Task 8 as unused.

**A30 — `config.env` reaches the spawned claude child — traced.** For anyone auditing the secret hop: `claude-local/src/server/execute.ts:243-245` (copies `config.env` into spawn env) → `:598-612` (passes to `runAdapterExecutionTargetProcess`) → `adapter-utils/src/execution-target.ts:514` → `server-utils.ts:508` `mergeChildEnv(process.env, opts.env)`. Connector tokens land in the child env on top of the inherited host env.

**A31 — PLAN 2, FIRST STEP: extract `resolveAgentConnectors(db, {companyId, agentId, runId}) => {extraMcpServers, connectorEnv}`.** Task 10 inlined the load → `buildConnectorSpecs` → log-skipped glue inside `heartbeatService` (`heartbeat.ts` ~4286-4309). Commander (`cli-mode.ts` ~426) and crew (`runner.ts` ~364) will need the IDENTICAL resolution when Plan 2 extends connector delivery to them — the loader already supports Commander via `agentId: null` (D3), and only the env-injection differs per path (heartbeat merges into `config.env`; crew/Commander build their own spawn env). Extract the shared part as the OPENING move of the first Plan 2 connector-delivery task, BEFORE wiring the second caller, so the glue is never triplicated. The `skipped.length > 0` → `logger.warn` belongs INSIDE the helper — this also closes A8's "worst failure mode" observability gap by giving the skipped-connector log a unit-testable seam (currently it lives in the un-unit-testable `heartbeatService` run function). Deliberately NOT done in Plan 1: with only one caller it would be premature, and Tasks 11-14 do not consume this glue.

**A32 — TASK 11 SECURITY GAPS (found in review, must fix before Task 11 closes): a create→activate RCE chain.** The first Task 11 implementation shipped the validation surface (A20/A21/A26) and D6 RBAC correctly, but dropped two governance controls, which compose into remote code execution on a multi-tenant host:

- **C1 — D7 stdio gate missing entirely.** `assertTransportAllowed(transport, deploymentMode, source)` was never implemented (0 grep hits). The POST handler accepts `transport: "stdio"` unconditionally, and the test suite *encoded the vuln as expected* — `accepts a good stdio connector → 201` runs under `authenticated` mode, the exact case D7 forbids. Required: implement `assertTransportAllowed` — in `local_trusted` stdio is allowed; in `authenticated`/cloud, stdio is rejected UNLESS `source==="catalog"` and that catalog entry is verified; call it in POST before create; add the four policy tests including `rejects stdio BYO in authenticated → 400`. Fix the mis-asserting existing test (run it in `local_trusted`, or make it http).

- **C2 — PATCH is an unguarded activation path.** `updateConnectorSchema` accepts `status: active|pending_approval|disabled` with no current-status or deployment-mode guard, and the approval HANDLER is deferred, so PATCH is the ONLY activation path in authenticated mode. A narrow "forbid pending→active" is INSUFFICIENT — `pending_approval → disabled → active` reaches the same state in two hops. Required: in `authenticated` mode, PATCH must not be able to produce `status:"active"` AT ALL — restrict PATCH `status` to `"disabled"` there (deactivation is always safe), or drop `active` from the PATCH enum until the approval handler exists. Activation in authenticated mode flows solely through the (future) approval handler. In `local_trusted` (no governance gate), PATCH status may stay unrestricted.

- **I1 — `source` is client-supplied and trusted.** `source: z.enum(["byo","catalog"]).default("byo")` is persisted from the request body. Since C1's gate exempts `source==="catalog"`, a founder bypasses the stdio gate by sending `source:"catalog"`. `source` must be server-determined — force BYO writes to `source:"byo"` (catalog installs come through a different, catalog-verified path, not this route). Must land WITH C1 or the gate is trivially defeated.

**The chain:** create stdio (C1) → PATCH to active (C2) → loader serves it → command executes on the multi-tenant host. C1 + C2 + I1 must be fixed together.

Also fix in the same round: M2 (no team_lead/member 403 test for PATCH — the sensitive endpoint), M3 (the `.strict()` unknown-field test is vacuous — assert `create` not called), M1 (add an explicit `envTemplate` non-string-value 400 test).

## Task 12 LIVE PROBE — AoA config survives sanitization on a real CLI (2026-07-24, Claude Code 2.1.126)

The anti-regression property (the trap: stripping must not delete AoA's OWN config) verified live. Method: two local HTTP MCP listeners tagged AOA (:8991) and EVIL (:8992). Ran the exact argv Task 12 produces after `stripUserMcpArgs` removes a user-injected `--mcp-config` — i.e. only AoA's config present — under `--strict-mcp-config`.

Result: the AOA connector was contacted (`{"probe":"AOA"}`); the EVIL connector was NOT contacted. So AoA's own connector delivery survives the sanitizer intact, and nothing reaches the stripped server. Property 1 (the user `--mcp-config` is removed from the constructed argv) is proven by the pure `stripUserMcpArgs` unit tests + the heartbeat/crew argv tests asserting `evil.json` is absent; the probe additionally rules out an ambient-discovery back-channel to the stripped server.

Task 12 sites: `heartbeat-mcp.ts` (`...stripUserMcpArgs(existingArgs)`) and `runner.ts` (`...stripUserMcpArgs(prevArgs)`). Commander `cli-mode.ts` sites have no user-args tail (no "Extra args" box) and are correctly untouched.

**A33 — TASK 12 RUNNER GAP: sanitize the ADAPTER-PREFERRED key, not `args`. (found in re-review, must fix before Task 12 closes)** The heartbeat site is correct — it injects AoA's prefix + sanitized user tail into `argKey = Array.isArray(config.extraArgs) ? "extraArgs" : "args"`, matching the key the claude-local adapter reads. The crew runner (`aoa-agents/runner.ts` ~497) is NOT: it sanitizes `baseConfig.args` and writes `config.args`, but (a) the UI "Extra args" box populates `adapterConfig.extraArgs` (`claude-local/src/ui/build-config.ts:74`), and (b) the adapter PREFERS `extraArgs` over `args` (`claude-local/src/server/execute.ts:258-262`). So a founder's `--mcp-config,C:\evil.json` in a crew agent's Extra args survives in `config.extraArgs`, the adapter uses it, and AoA's own `--mcp-config` (sitting in `config.args`) is dropped — governance bypass AND broken AoA delivery for that crew agent, simultaneously.

Fix: mirror heartbeat — pick `argKey` = extraArgs-if-array-else-args, take the user tail from THAT key, and inject `["--mcp-config", cfgPath, "--strict-mcp-config", ...stripUserMcpArgs(userTail)]` into `argKey`. Merely *also* stripping extraArgs while still injecting into `args` is INSUFFICIENT: a benign non-empty `extraArgs` would still shadow AoA's `args`-injected config. AoA's prefix must land in the adapter-preferred key. Add a runner regression test with the evil payload in `extraArgs` (not `args`), and fix the two misleading test comments (`aoa-runner.test.ts:82` and `strict-mcp-config.test.ts:39`) that claim to cover the Extra-args box while injecting into `args`.

**A33-LESSON — a hand-built "post-sanitize argv" live probe does NOT exercise the runner's key selection.** The Task 12 live probe constructed a heartbeat-shaped argv by hand and confirmed AoA survives — but it never drove the runner's real `args`-vs-`extraArgs` logic, so it missed this gap. Task 14's live check must drive the REAL delivery builders (or at least assert against the adapter's actual key-preference `execute.ts:258-262`), not a hand-assembled argv.

**A34 — expose `enabledAgentIds` on the connector list row (fix the blind-replace footgun found in Task 13).** `PUT /:id/agents` is a full set-replace, but nothing reads a connector's CURRENT enabled-agent set — the list service returns only connector columns, and there is no junction read. So Task 13's Agents panel always starts from an empty selection: a founder opening it for a connector that already has N agents enabled sees none, and saving any change silently wipes the existing set. That is data loss with no warning — the exact silent-footgun class this plan avoids elsewhere.

Fix (small, low-risk read addition): in the connector list service (`mcp-connectors-crud.ts` list, feeding `GET /companies/:id/mcp-connectors`), left-join `company_mcp_connector_agents` and return `enabledAgentIds: string[]` per connector row. The Task 13 UI then seeds the Agents panel from `connector.enabledAgentIds` so it shows the current set and edits it non-destructively. Keep `PUT` as a replace (the UI sends the full intended set); the fix is purely giving the UI the current state to start from. Add a service test asserting `enabledAgentIds` is populated, and a UI assertion that the panel pre-checks currently-enabled agents.

**A35 — Task 13 shape corrections (verified against live routes):** `PUT /:id/agents` returns `{ connectorId, agentIds }` (not `{ ok: true }`); `DELETE /:id` returns the deleted connector row (not `{ ok: true }`). `deploymentMode` is read off `/api/health` (no dedicated hook), defaulting to the restrictive non-local assumption while loading so stdio is never briefly offered on a shared host. Founder gate uses `useTeamAccess(companyId).role === "founder"`. Settings registration required 4 edits (section-id union + nav array + page switch + VALID_SECTIONS), not one. The D7 stdio-disabled branch was code-verified but NOT live-verified (needs an authenticated-mode boot with a board login) — Task 14 should live-confirm it.

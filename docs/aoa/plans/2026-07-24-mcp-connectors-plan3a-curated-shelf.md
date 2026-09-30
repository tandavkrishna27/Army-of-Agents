# Plan 3a — Curated Connector Shelf: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A founder can browse a curated shelf of external MCP connectors and install one in a click; it becomes usable once they supply credentials, and it can never reach an agent before then.

**Architecture:** Connectors ship in their **own** CDN artifact (`connectors.json`), never in `catalog.json` — a new item type in `catalog.json` fails its whole-array zod parse and permanently freezes catalog sync on every older instance (design §3.3, proven live). Because connectors are therefore not catalog items, they do **not** go through `marketplace-install/orchestrator.ts`; they get a dedicated founder-only install route that shares one `createConnector` service with the existing BYO route. Credential state is modelled as a distinct status plus a `requiresSecret` column, so approval can never activate an uncredentialed connector.

**Tech Stack:** TypeScript, Express 5 route factories, Drizzle ORM, zod, Vitest, React + Vite, Playwright.

**Design doc:** `docs/aoa/plans/2026-07-24-mcp-connectors-plan3-marketplace-design.md`
**Follow-ups:** `docs/aoa/plans/mcp-connectors-followups.md`
**Branch:** `integration/connectors-marketplace`

---

## Non-negotiable invariants

Every review round in Plans 1/2/2b found a real defect that passed first-pass green tests.
These are the specific traps in 3a:

1. **`catalog.json` is never modified.** No value is added to `MarketplaceItemTypeSchema`.
   A regression test pins this.
2. **`selectConnectorRowsForAgent` stays an allowlist** (`server/src/services/mcp-connectors.ts:110-117`,
   `if (c.status !== "active") return false;`). It is the sole delivery chokepoint, so any
   new status is excluded from agents for free. **Never** convert it to a denylist.
3. **`status` is never set to `active` while a connector requires a secret it does not have.**
   One helper owns this decision; nothing else writes `active`.
4. **D7 is an authorization gate; the consent token is a UX gate.** Neither substitutes for
   the other.
5. **`source` is `"catalog"`** — the vocabulary in `company_mcp_connectors.ts:32` and
   `assertTransportAllowed`. Never `"marketplace"`. Never accepted from a client.

---

## File structure

**Create**
- `packages/shared/src/mcp-connector-catalog.ts` — zod schema for `connectors.json` + entries
- `server/src/services/mcp-connector-catalog.ts` — fetch/cache/forward-compatible parse
- `server/src/services/mcp-connector-create.ts` — shared `createConnector` (extracted)
- `server/src/services/mcp-connector-status.ts` — the single status-resolution helper
- `server/src/services/mcp-connector-consent.ts` — consent token mint/verify
- `ui/src/components/marketplace/connectors/ConnectorCard.tsx`
- `ui/src/components/marketplace/connectors/ConnectorInstallDialog.tsx`

**Modify**
- `packages/db/src/schema/company_mcp_connectors.ts` — add `requiresSecret`
- `server/src/routes/mcp-connectors.ts` — extract create; tier-aware D7; install + credentials routes
- `server/src/services/approvals.ts` — credential-aware approve/reject
- `ui/src/api/mcpConnectors.ts` — status union + new calls
- `ui/src/components/settings/sections/MCPConnectorsSection.tsx` — `StatusBadge` fallback + Needs-setup

---

## Task 1: `connectors.json` schema

**Files:**
- Create: `packages/shared/src/mcp-connector-catalog.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/mcp-connector-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  McpConnectorCatalogEntrySchema,
  parseMcpConnectorCatalog,
} from "../mcp-connector-catalog.js";

describe("McpConnectorCatalogEntrySchema", () => {
  const httpEntry = {
    id: "notion",
    displayName: "Notion",
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headerTemplateKeys: ["Authorization"],
    requiresSecret: true,
    trust: { tier: "verified" },
  };

  it("accepts a verified http entry", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse(httpEntry);
    expect(r.success).toBe(true);
  });

  it("defaults trust tier to community when absent (fail-closed)", () => {
    const { trust: _t, ...noTrust } = httpEntry;
    const r = McpConnectorCatalogEntrySchema.parse(noTrust);
    expect(r.trust.tier).toBe("community");
  });

  it("rejects a serverName outside /^[a-z0-9-]+$/", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({ ...httpEntry, serverName: "Bad_Name" });
    expect(r.success).toBe(false);
  });

  it("rejects an entry carrying a secret VALUE rather than a key", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      headerTemplate: { Authorization: "Bearer sk-live-real" },
    });
    expect(r.success).toBe(false); // .strict() — headerTemplate is not a field
  });

  it("drops an unparseable entry but keeps the good ones (forward compatible)", () => {
    const file = {
      schemaVersion: "1.0.0",
      entries: [httpEntry, { id: "broken", transport: "carrier-pigeon" }],
    };
    const result = parseMcpConnectorCatalog(file);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("notion");
    expect(result.dropped).toEqual(["broken"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/shared test mcp-connector-catalog`
Expected: FAIL — `Cannot find module '../mcp-connector-catalog.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/mcp-connector-catalog.ts
import { z } from "zod";

/**
 * Schema for `connectors.json` — a SECOND CDN artifact, deliberately separate
 * from catalog.json.
 *
 * WHY SEPARATE: MarketplaceCatalogFileSchema.parse() rejects the WHOLE array on
 * one unknown `type` enum value, and the sync failure path preserves the previous
 * cache — so publishing a new item type silently freezes the catalog forever on
 * every older instance. Connectors therefore never touch catalog.json.
 * (Design §3.3; Decision #96's `.strip()` covers unknown FIELDS, not unknown
 * ENUM VALUES.)
 *
 * SECRETS: entries carry header/env template KEYS only — never a value, never a
 * placeholder. The founder binds a real secret after install (D5).
 */

const SERVER_NAME_RE = /^[a-z0-9-]+$/;

/** Fail-closed: an entry with no trust block is community, never verified. */
export const McpConnectorTrustSchema = z
  .object({
    tier: z.enum(["verified", "community", "unverified"]).default("community"),
  })
  .default({ tier: "community" });

export const McpConnectorCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    serverName: z.string().regex(SERVER_NAME_RE),
    transport: z.enum(["http", "stdio"]),
    url: z.string().url().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** Header NAMES this connector authenticates with. Values never appear here. */
    headerTemplateKeys: z.array(z.string().min(1)).default([]),
    /** Env var NAMES a stdio server expects. Values never appear here. */
    envTemplateKeys: z.array(z.string().min(1)).default([]),
    requiresSecret: z.boolean().default(false),
    secretLabel: z.string().max(200).optional(),
    docsUrl: z.string().url().optional(),
    trust: McpConnectorTrustSchema,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.transport === "http" && !val.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "http requires url" });
    }
    if (val.transport === "stdio" && !val.command) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["command"], message: "stdio requires command" });
    }
  });

export type McpConnectorCatalogEntry = z.infer<typeof McpConnectorCatalogEntrySchema>;

/**
 * Parse PER ENTRY, dropping bad ones. This is the forward-compat property
 * catalog.json lacks (FU-14): a future field or entry shape we do not understand
 * costs us that entry, never the whole file.
 */
export function parseMcpConnectorCatalog(input: unknown): {
  entries: McpConnectorCatalogEntry[];
  dropped: string[];
} {
  const entries: McpConnectorCatalogEntry[] = [];
  const dropped: string[] = [];
  const raw = (input as { entries?: unknown[] })?.entries;
  if (!Array.isArray(raw)) return { entries, dropped };
  for (const item of raw) {
    const parsed = McpConnectorCatalogEntrySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else {
      const id = (item as { id?: unknown })?.id;
      dropped.push(typeof id === "string" ? id : "<unidentified>");
    }
  }
  return { entries, dropped };
}
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./mcp-connector-catalog.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared test mcp-connector-catalog`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/mcp-connector-catalog.ts packages/shared/src/index.ts packages/shared/src/__tests__/mcp-connector-catalog.test.ts
git commit -m "feat(connectors): connectors.json schema with per-entry forward-compat parse"
```

---

## Task 2: Regression test — `catalog.json` is untouched

**Files:**
- Test: `server/src/__tests__/connector-catalog-isolation.test.ts`

This task exists because the failure it guards against is silent and fleet-wide.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { MarketplaceItemTypeSchema } from "@armyofagents/shared";

describe("connector catalog isolation (design §3.3 / FU-14)", () => {
  it("does NOT add 'connector' to MarketplaceItemTypeSchema", () => {
    // Adding it would make one connector item fail the WHOLE catalog.json parse.
    // aoa-marketplace.ts:116 then preserves the previous cache, so every older
    // instance serves a frozen catalog forever — silently, for skills/agents/
    // teams/plugins too. Connectors ship in connectors.json instead.
    expect(MarketplaceItemTypeSchema.options).toEqual(["skill", "plugin", "agent", "team"]);
  });

  it("rejects an unknown item type, proving why the separate file is required", () => {
    expect(MarketplaceItemTypeSchema.safeParse("connector").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @armyofagents/server test connector-catalog-isolation`
Expected: PASS immediately (it pins current behaviour)

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/connector-catalog-isolation.test.ts
git commit -m "test(connectors): pin catalog.json isolation (FU-14 guard)"
```

---

## Task 3: `requiresSecret` column

**Files:**
- Modify: `packages/db/src/schema/company_mcp_connectors.ts`
- Create: migration via `pnpm db:generate`

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/company_mcp_connectors.ts`, after the `secretRef` line:

```ts
    // Whether this connector CANNOT function without a bound secret. Set from the
    // catalog entry at install; false for BYO connectors, whose founder supplies
    // everything up front. Load-bearing: resolveConnectorStatus refuses to mark a
    // requiresSecret connector `active` while secretRef is null, so an approval can
    // never activate an uncredentialed connector.
    requiresSecret: boolean("requires_secret").notNull().default(false),
```

Add `boolean` to the drizzle import on line 1:

```ts
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
```

Also extend the status comment:

```ts
    status: text("status").notNull().default("pending_approval"), // pending_approval | needs_credentials | active | disabled
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file in `packages/db/drizzle/` adding `requires_secret boolean not null default false`.

⚠ Do **not** hand-write SQL (CLAUDE.md rule 1).

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add packages/db/
git commit -m "feat(connectors): add requires_secret column"
```

---

## Task 4: The single status-resolution helper

**Files:**
- Create: `server/src/services/mcp-connector-status.ts`
- Test: `server/src/__tests__/mcp-connector-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveConnectorStatus } from "../services/mcp-connector-status.js";

describe("resolveConnectorStatus", () => {
  it("local_trusted + no secret needed -> active", () => {
    expect(resolveConnectorStatus({
      deploymentMode: "local_trusted", approved: true, requiresSecret: false, hasSecret: false,
    })).toBe("active");
  });

  it("local_trusted + secret needed but unbound -> needs_credentials", () => {
    expect(resolveConnectorStatus({
      deploymentMode: "local_trusted", approved: true, requiresSecret: true, hasSecret: false,
    })).toBe("needs_credentials");
  });

  it("local_trusted + secret needed and bound -> active", () => {
    expect(resolveConnectorStatus({
      deploymentMode: "local_trusted", approved: true, requiresSecret: true, hasSecret: true,
    })).toBe("active");
  });

  it("authenticated + not yet approved -> pending_approval even with a secret", () => {
    expect(resolveConnectorStatus({
      deploymentMode: "authenticated", approved: false, requiresSecret: true, hasSecret: true,
    })).toBe("pending_approval");
  });

  it("authenticated + approved but unbound -> needs_credentials, NOT active", () => {
    // The C2 defect: approve() used to flip any non-active row straight to active.
    expect(resolveConnectorStatus({
      deploymentMode: "authenticated", approved: true, requiresSecret: true, hasSecret: false,
    })).toBe("needs_credentials");
  });

  it("authenticated + approved + bound -> active", () => {
    expect(resolveConnectorStatus({
      deploymentMode: "authenticated", approved: true, requiresSecret: true, hasSecret: true,
    })).toBe("active");
  });

  it("never returns active when a required secret is missing (exhaustive)", () => {
    for (const deploymentMode of ["local_trusted", "authenticated", "cloud_auth"]) {
      for (const approved of [true, false]) {
        const s = resolveConnectorStatus({
          deploymentMode, approved, requiresSecret: true, hasSecret: false,
        });
        expect(s).not.toBe("active");
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-status`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/mcp-connector-status.ts

/**
 * THE single place that decides whether a connector may be `active`.
 *
 * Credential state and approval state are ORTHOGONAL axes. Collapsing them into
 * one linear status is what produced the C2 defect: `approvals.ts` flipped ANY
 * non-active connector to `active` on approve, which would activate a connector
 * with no credentials — precisely what the design forbids.
 *
 * INVARIANT: this function never returns "active" while `requiresSecret &&
 * !hasSecret`. Nothing else in the codebase may write "active" to a connector.
 */
export type ConnectorStatus = "pending_approval" | "needs_credentials" | "active" | "disabled";

export function resolveConnectorStatus(input: {
  deploymentMode: string;
  approved: boolean;
  requiresSecret: boolean;
  hasSecret: boolean;
}): ConnectorStatus {
  const { deploymentMode, approved, requiresSecret, hasSecret } = input;

  // Governance axis first: a shared deployment gates on board approval (D6).
  // local_trusted is a loopback trust boundary, so it is implicitly approved.
  const governanceSatisfied = deploymentMode === "local_trusted" || approved;
  if (!governanceSatisfied) return "pending_approval";

  // Credential axis second.
  if (requiresSecret && !hasSecret) return "needs_credentials";

  return "active";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test mcp-connector-status`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mcp-connector-status.ts server/src/__tests__/mcp-connector-status.test.ts
git commit -m "feat(connectors): single status resolver; approval can never activate uncredentialed"
```

---

## Task 5: Tier-aware D7 gate

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts:69-80`
- Test: `server/src/__tests__/mcp-connectors-transport-gate.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { assertTransportAllowed } from "../routes/mcp-connectors.js";

describe("assertTransportAllowed — tier awareness (C4)", () => {
  it("allows a VERIFIED catalog stdio connector in authenticated mode", () => {
    expect(() =>
      assertTransportAllowed("stdio", "authenticated", "catalog", "verified"),
    ).not.toThrow();
  });

  it("REJECTS an unverified catalog stdio connector in authenticated mode", () => {
    // Before Plan 3 no route could construct source="catalog", so the exemption
    // was unreachable. 3a creates that route AND introduces unverified entries —
    // without the tier check this is a D7 bypass onto a shared host.
    expect(() =>
      assertTransportAllowed("stdio", "authenticated", "catalog", "community"),
    ).toThrow(/verified/i);
  });

  it("still allows any stdio in local_trusted", () => {
    expect(() =>
      assertTransportAllowed("stdio", "local_trusted", "catalog", "community"),
    ).not.toThrow();
  });

  it("still allows http regardless of tier", () => {
    expect(() =>
      assertTransportAllowed("http", "authenticated", "catalog", "community"),
    ).not.toThrow();
  });

  it("rejects byo stdio in authenticated mode (unchanged)", () => {
    expect(() => assertTransportAllowed("stdio", "authenticated", "byo", undefined)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connectors-transport-gate`
Expected: FAIL — the unverified case does not throw (4th arg ignored)

- [ ] **Step 3: Write minimal implementation**

Replace the function at `server/src/routes/mcp-connectors.ts:69-80`:

```ts
export function assertTransportAllowed(
  transport: string,
  deploymentMode: string,
  source: string,
  trustTier?: string,
): void {
  if (transport !== "stdio") return; // http is always fine
  if (deploymentMode === "local_trusted") return; // host is the founder's own machine
  // C4: the exemption is for VERIFIED catalog entries. Checking `source` alone was
  // safe only while no route could construct source="catalog"; Plan 3a creates that
  // route and introduces unverified entries, so the tier check is load-bearing.
  // NOTE: this is an AUTHORIZATION gate. The install-time consent token is a UX
  // gate proving the founder saw the command — it is NOT a substitute for this.
  if (source === "catalog" && trustTier === "verified") return;
  throw badRequest(
    "Only remote HTTP connectors can be added in this deployment. stdio connectors run a " +
      "command on the AoA host and are restricted to verified catalog entries.",
  );
}
```

Update the existing call site in the POST handler to pass `undefined` explicitly:

```ts
      assertTransportAllowed(body.transport, deploymentMode, source, undefined);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @armyofagents/server test mcp-connectors`
Expected: PASS — including the pre-existing truth-table tests

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-connectors.ts server/src/__tests__/mcp-connectors-transport-gate.test.ts
git commit -m "fix(connectors): D7 catalog exemption requires verified tier (C4)"
```

---

## Task 6: Extract the shared `createConnector` service

**Files:**
- Create: `server/src/services/mcp-connector-create.ts`
- Modify: `server/src/routes/mcp-connectors.ts` (POST handler)
- Test: `server/src/__tests__/mcp-connector-create.test.ts`

⚠ `mcpConnectorService.create()` is a **bare INSERT**. All governance (D7 gate, 409,
secretRef existence, status derivation, approval creation, activity log) lives in the route.
Letting the install route call `svc.create()` would fork ~80 lines of governance into an
untested copy.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createConnector } from "../services/mcp-connector-create.js";

function deps(overrides = {}) {
  return {
    svc: {
      getByName: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation((_c, input) => ({ id: "c1", serverName: input.serverName, ...input })),
    },
    secretsSvc: { getByName: vi.fn().mockResolvedValue({ id: "s1" }) },
    approvalsSvc: { create: vi.fn().mockResolvedValue({ id: "a1" }) },
    logActivity: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const base = {
  companyId: "co1",
  serverName: "notion",
  displayName: "Notion",
  transport: "http" as const,
  url: "https://mcp.notion.com/mcp",
  args: [], headerTemplate: {}, envTemplate: {},
  secretRef: null, requiresSecret: false,
  actor: { actorType: "user" as const, actorId: "11111111-1111-1111-1111-111111111111", agentId: null },
};

describe("createConnector", () => {
  it("409s when the serverName already exists", async () => {
    const d = deps({ svc: { getByName: vi.fn().mockResolvedValue({ id: "x" }), create: vi.fn() } });
    await expect(createConnector({ ...base, source: "byo", deploymentMode: "local_trusted" }, d as never))
      .rejects.toThrow(/already exists/);
  });

  it("400s when secretRef points at a missing secret", async () => {
    const d = deps({ secretsSvc: { getByName: vi.fn().mockResolvedValue(null) } });
    await expect(createConnector(
      { ...base, secretRef: "mcp:nope", source: "byo", deploymentMode: "local_trusted" }, d as never,
    )).rejects.toThrow(/does not reference an existing secret/);
  });

  it("creates a pending approval in authenticated mode", async () => {
    const d = deps();
    const r = await createConnector({ ...base, source: "byo", deploymentMode: "authenticated" }, d as never);
    expect(r.connector.status).toBe("pending_approval");
    expect(d.approvalsSvc.create).toHaveBeenCalled();
    expect(r.approvalId).toBe("a1");
  });

  it("marks a catalog connector needing an unbound secret as needs_credentials", async () => {
    const d = deps();
    const r = await createConnector(
      { ...base, source: "catalog", requiresSecret: true, deploymentMode: "local_trusted" }, d as never,
    );
    expect(r.connector.status).toBe("needs_credentials");
    expect(d.approvalsSvc.create).not.toHaveBeenCalled();
  });

  it("never writes a client-supplied source", async () => {
    const d = deps();
    const r = await createConnector({ ...base, source: "catalog", deploymentMode: "local_trusted" }, d as never);
    expect(r.connector.source).toBe("catalog");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-create`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/mcp-connector-create.ts
import { badRequest, conflict } from "../lib/errors.js";
import { resolveConnectorStatus } from "./mcp-connector-status.js";

/**
 * Shared creation path for BOTH the BYO route and the catalog install route.
 *
 * WHY THIS EXISTS: `mcpConnectorService.create()` is a bare INSERT — every
 * governance rule (D7 gate, (companyId, serverName) 409, secretRef existence,
 * status derivation, approval creation, activity log) previously lived only in
 * the POST handler. A second caller reaching for `svc.create()` would silently
 * fork ~80 lines of governance into a copy with no test coverage.
 *
 * NOTE: the D7 transport gate is deliberately NOT here — it needs the trust tier,
 * which only the caller knows, and it must run before any write. Callers assert it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateConnectorInput = {
  companyId: string;
  serverName: string;
  displayName: string;
  transport: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  args: string[];
  headerTemplate: Record<string, string>;
  envTemplate: Record<string, string>;
  secretRef: string | null;
  requiresSecret: boolean;
  /** Server-forced. "byo" from the founder route, "catalog" from install. */
  source: "byo" | "catalog";
  deploymentMode: string;
  actor: { actorType: string; actorId: string; agentId: string | null };
};

export async function createConnector(
  input: CreateConnectorInput,
  deps: {
    svc: { getByName: Function; create: Function };
    secretsSvc: { getByName: Function };
    approvalsSvc: { create: Function };
    logActivity: Function;
  },
) {
  const existing = await deps.svc.getByName(input.companyId, input.serverName);
  if (existing) throw conflict(`A connector named "${input.serverName}" already exists`);

  if (input.secretRef) {
    const secret = await deps.secretsSvc.getByName(input.companyId, input.secretRef);
    if (!secret) {
      throw badRequest(`secretRef "${input.secretRef}" does not reference an existing secret`);
    }
  }

  // Approval is required only in a shared deployment; resolveConnectorStatus owns
  // the decision so nothing else ever writes "active".
  const status = resolveConnectorStatus({
    deploymentMode: input.deploymentMode,
    approved: input.deploymentMode === "local_trusted",
    requiresSecret: input.requiresSecret,
    hasSecret: input.secretRef !== null,
  });

  const createdByUserId = UUID_RE.test(input.actor.actorId) ? input.actor.actorId : null;

  const connector = await deps.svc.create(input.companyId, {
    serverName: input.serverName,
    displayName: input.displayName,
    transport: input.transport,
    url: input.url ?? null,
    command: input.command ?? null,
    args: input.args,
    headerTemplate: input.headerTemplate,
    envTemplate: input.envTemplate,
    secretRef: input.secretRef,
    requiresSecret: input.requiresSecret,
    source: input.source,
    status,
    createdByUserId,
  });

  let approvalId: string | null = null;
  if (status === "pending_approval") {
    const approval = await deps.approvalsSvc.create(input.companyId, {
      type: "install_mcp_connector",
      requestedByUserId: input.actor.actorType === "user" ? input.actor.actorId : null,
      status: "pending",
      payload: { connectorId: connector.id, serverName: connector.serverName },
    });
    approvalId = approval?.id ?? null;
  }

  await deps.logActivity({
    companyId: input.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId,
    action: "mcp_connector.created",
    entityType: "mcp_connector",
    entityId: connector.id,
    details: { serverName: connector.serverName, transport: connector.transport, status },
  });

  return { connector, approvalId };
}
```

- [ ] **Step 4: Rewire the existing POST handler to call it**

In `server/src/routes/mcp-connectors.ts`, replace the body of the POST handler from
`// Uniqueness (companyId, serverName)` through the `res.status(201)` line with:

```ts
      const actor = getActorInfo(req);
      const { connector, approvalId } = await createConnector(
        {
          companyId,
          serverName: body.serverName,
          displayName: body.displayName,
          transport: body.transport,
          url: body.url ?? null,
          command: body.command ?? null,
          args: body.args,
          headerTemplate: body.headerTemplate,
          envTemplate: body.envTemplate,
          secretRef: body.secretRef ?? null,
          requiresSecret: false, // BYO: the founder supplies everything up front
          source,
          deploymentMode,
          actor,
        },
        { svc, secretsSvc, approvalsSvc, logActivity: (a: unknown) => logActivity(db, a as never) },
      );

      res.status(201).json({ ...connector, approvalId });
```

- [ ] **Step 5: Run the full connector suite to prove behaviour is unchanged**

Run: `pnpm --filter @armyofagents/server test mcp-connector`
Expected: PASS — every pre-existing route test still green

- [ ] **Step 6: Commit**

```bash
git add server/src/services/mcp-connector-create.ts server/src/routes/mcp-connectors.ts server/src/__tests__/mcp-connector-create.test.ts
git commit -m "refactor(connectors): extract shared createConnector so install cannot fork governance"
```

---

## Task 7: Credential-aware approve / reject

**Files:**
- Modify: `server/src/services/approvals.ts` (approve ≈`:252-264`, reject ≈`:316-326`)
- Test: `server/src/__tests__/approvals-connector-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { applyConnectorApproval, applyConnectorRejection } from "../services/approvals.js";

describe("connector approval is credential-aware (C2)", () => {
  it("approving an unbound connector yields needs_credentials, NOT active", async () => {
    const svc = {
      getById: vi.fn().mockResolvedValue({
        id: "c1", companyId: "co1", status: "pending_approval",
        requiresSecret: true, secretRef: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    await applyConnectorApproval(svc as never, "co1", "c1", "authenticated");
    expect(svc.update).toHaveBeenCalledWith("c1", { status: "needs_credentials" });
  });

  it("approving a bound connector activates it", async () => {
    const svc = {
      getById: vi.fn().mockResolvedValue({
        id: "c1", companyId: "co1", status: "pending_approval",
        requiresSecret: true, secretRef: "mcp:notion",
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    await applyConnectorApproval(svc as never, "co1", "c1", "authenticated");
    expect(svc.update).toHaveBeenCalledWith("c1", { status: "active" });
  });

  it("rejecting a needs_credentials connector disables it (was a silent no-op)", async () => {
    const svc = {
      getById: vi.fn().mockResolvedValue({
        id: "c1", companyId: "co1", status: "needs_credentials",
        requiresSecret: true, secretRef: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    };
    await applyConnectorRejection(svc as never, "co1", "c1");
    expect(svc.update).toHaveBeenCalledWith("c1", { status: "disabled" });
  });

  it("ignores a connector from another company", async () => {
    const svc = {
      getById: vi.fn().mockResolvedValue({ id: "c1", companyId: "OTHER", status: "pending_approval", requiresSecret: false, secretRef: null }),
      update: vi.fn(),
    };
    await applyConnectorApproval(svc as never, "co1", "c1", "authenticated");
    expect(svc.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test approvals-connector-credentials`
Expected: FAIL — `applyConnectorApproval` is not exported

- [ ] **Step 3: Write minimal implementation**

Add to `server/src/services/approvals.ts` (exported so the truth table is unit-tested
directly, matching the `assertTransportAllowed` precedent):

```ts
/**
 * C2: approval and credentials are ORTHOGONAL. The previous implementation flipped
 * ANY non-active connector to `active`, so approving an uncredentialed connector
 * activated it — exactly what the design forbids. Delegates to the single status
 * resolver so nothing else decides `active`.
 */
export async function applyConnectorApproval(
  svc: { getById: Function; update: Function },
  companyId: string,
  connectorId: string,
  deploymentMode: string,
): Promise<void> {
  const connector = await svc.getById(connectorId);
  if (!connector || connector.companyId !== companyId) return; // null-tolerant, company-scoped
  const next = resolveConnectorStatus({
    deploymentMode,
    approved: true,
    requiresSecret: connector.requiresSecret === true,
    hasSecret: connector.secretRef != null,
  });
  if (connector.status !== next) await svc.update(connectorId, { status: next });
}

/**
 * Rejection must also cover `needs_credentials`. The previous guard matched only
 * `pending_approval`, so rejecting a connector awaiting credentials was a silent
 * no-op and it stayed on a path that later reaches `active`.
 */
export async function applyConnectorRejection(
  svc: { getById: Function; update: Function },
  companyId: string,
  connectorId: string,
): Promise<void> {
  const connector = await svc.getById(connectorId);
  if (!connector || connector.companyId !== companyId) return;
  if (connector.status === "pending_approval" || connector.status === "needs_credentials") {
    await svc.update(connectorId, { status: "disabled" });
  }
}
```

Import the resolver at the top of `approvals.ts`:

```ts
import { resolveConnectorStatus } from "./mcp-connector-status.js";
```

Then replace the inline blocks. In `approve`:

```ts
      if (updated.type === "install_mcp_connector") {
        const payload = updated.payload as Record<string, unknown>;
        const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
        if (connectorId) {
          await applyConnectorApproval(
            mcpConnectorSvc, companyId, connectorId, loadConfig().deploymentMode,
          );
        }
      }
```

In `reject`:

```ts
      if (updated.type === "install_mcp_connector") {
        const payload = updated.payload as Record<string, unknown>;
        const connectorId = typeof payload.connectorId === "string" ? payload.connectorId : null;
        if (connectorId) {
          await applyConnectorRejection(mcpConnectorSvc, companyId, connectorId);
        }
      }
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @armyofagents/server test approvals`
Expected: PASS — including pre-existing approval tests

- [ ] **Step 5: Commit**

```bash
git add server/src/services/approvals.ts server/src/__tests__/approvals-connector-credentials.test.ts
git commit -m "fix(connectors): approval is credential-aware; reject covers needs_credentials (C2)"
```

---

## Task 8: Secret-binding endpoint

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts`, `server/src/services/mcp-connectors-crud.ts`
- Test: `server/src/__tests__/mcp-connector-credentials-route.test.ts`

⚠ Today `ConnectorPatch` is `{ displayName?, status? }` and `updateConnectorSchema` is
`.strict()` on those two — there is **no** way to set `secretRef` after create, so
`needs_credentials → active` is unimplementable without this task.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { bindCredentialsSchema } from "../routes/mcp-connectors.js";

describe("bindCredentialsSchema", () => {
  it("accepts a secretRef", () => {
    expect(bindCredentialsSchema.safeParse({ secretRef: "mcp:notion" }).success).toBe(true);
  });

  it("REJECTS a caller-supplied status (C2 bypass)", () => {
    // A naive PATCH {secretRef, status:"active"} would reopen the activation
    // bypass the PATCH handler works hard to close. Status is derived, never sent.
    expect(bindCredentialsSchema.safeParse({ secretRef: "mcp:notion", status: "active" }).success)
      .toBe(false);
  });

  it("rejects an empty secretRef", () => {
    expect(bindCredentialsSchema.safeParse({ secretRef: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-credentials-route`
Expected: FAIL — `bindCredentialsSchema` is not exported

- [ ] **Step 3: Write minimal implementation**

Add `secretRef` to `ConnectorPatch` in `server/src/services/mcp-connectors-crud.ts`:

```ts
export type ConnectorPatch = {
  displayName?: string;
  status?: string;
  secretRef?: string | null;
};
```

and inside `update`, after the `status` line:

```ts
      if (patch.secretRef !== undefined) set.secretRef = patch.secretRef;
```

Add the schema and route in `server/src/routes/mcp-connectors.ts`:

```ts
// Status is DERIVED here, never accepted. `.strict()` makes a caller-supplied
// `status` a 400 rather than silently ignoring it — an ignored field would look
// like it worked.
export const bindCredentialsSchema = z
  .object({ secretRef: z.string().min(1) })
  .strict();
```

```ts
  // Bind a secret to a connector, then re-derive status — founder only.
  router.post(
    "/companies/:companyId/mcp-connectors/:id/credentials",
    validate(bindCredentialsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      await assertRole(db, req, companyId, "founder");

      const existing = await svc.getById(id);
      if (!existing || existing.companyId !== companyId) {
        res.status(404).json({ error: "Connector not found" });
        return;
      }

      const { secretRef } = req.body as z.infer<typeof bindCredentialsSchema>;
      const secret = await secretsSvc.getByName(companyId, secretRef);
      if (!secret) {
        throw badRequest(`secretRef "${secretRef}" does not reference an existing secret`);
      }

      // A disabled connector must not be resurrected by binding a secret.
      const approved = existing.status !== "pending_approval" && existing.status !== "disabled";
      const nextStatus =
        existing.status === "disabled"
          ? "disabled"
          : resolveConnectorStatus({
              deploymentMode: loadConfig().deploymentMode,
              approved,
              requiresSecret: existing.requiresSecret === true,
              hasSecret: true,
            });

      const updated = await svc.update(id, { secretRef, status: nextStatus });
      await logActivity(db, {
        companyId,
        ...getActorInfo(req),
        action: "mcp_connector.credentials_bound",
        entityType: "mcp_connector",
        entityId: id,
        details: { secretRef, status: nextStatus },
      });
      res.json(updated);
    },
  );
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @armyofagents/server test mcp-connector`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-connectors.ts server/src/services/mcp-connectors-crud.ts server/src/__tests__/mcp-connector-credentials-route.test.ts
git commit -m "feat(connectors): secret-binding endpoint with derived status (C3)"
```

---

## Task 9: Consent token for unverified stdio

**Files:**
- Create: `server/src/services/mcp-connector-consent.ts`
- Test: `server/src/__tests__/mcp-connector-consent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mintConsentToken, verifyConsentToken } from "../services/mcp-connector-consent.js";

const SECRET = "test-signing-secret";
const cmd = { command: "npx", args: ["-y", "acme-db-tool"] };

describe("consent token", () => {
  it("round-trips for the exact command it was minted for", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000).ok).toBe(true);
  });

  it("REJECTS a token bound to a different command", () => {
    // The whole point: consent must bind to what will actually run, not be a flag.
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const evil = { command: "npx", args: ["-y", "evil-package"] };
    expect(verifyConsentToken(SECRET, "acme", evil, t, 1_000_000).ok).toBe(false);
  });

  it("rejects a token for a different connector id", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "other", cmd, t, 1_000_000).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000 + 16 * 60_000).ok).toBe(false);
  });

  it("rejects a forged token", () => {
    expect(verifyConsentToken(SECRET, "acme", cmd, "not.a.token", 1_000_000).ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const t = mintConsentToken("other-secret", "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-consent`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/mcp-connector-consent.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proof that a founder was shown the EXACT command an unverified stdio connector
 * will run on the AoA host, and accepted it.
 *
 * WHY IT BINDS TO THE COMMAND: a bare `confirmed: true` flag proves nothing — the
 * catalog can re-sync between the dialog and the install, so the founder could
 * approve one command and a different one could run (TOCTOU). The token is an HMAC
 * over (connectorEntryId, command, args), so it is only valid for what was shown.
 *
 * THIS IS A UX GATE, NOT AUTHORIZATION. D7 (assertTransportAllowed) decides whether
 * the deployment permits host exec at all, and runs independently.
 */
const TTL_MS = 15 * 60_000;

function payloadOf(entryId: string, spec: { command: string; args: string[] }): string {
  // JSON.stringify of a fixed-shape tuple: unambiguous, no delimiter injection.
  return JSON.stringify([entryId, spec.command, spec.args]);
}

export function mintConsentToken(
  signingSecret: string,
  entryId: string,
  spec: { command: string; args: string[] },
  nowMs: number,
): string {
  const exp = nowMs + TTL_MS;
  const mac = createHmac("sha256", signingSecret)
    .update(`${exp}.${payloadOf(entryId, spec)}`)
    .digest("hex");
  return `${exp}.${mac}`;
}

export function verifyConsentToken(
  signingSecret: string,
  entryId: string,
  spec: { command: string; args: string[] },
  token: string,
  nowMs: number,
): { ok: boolean; reason?: string } {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [expRaw, mac] = parts;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (nowMs > exp) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", signingSecret)
    .update(`${exp}.${payloadOf(entryId, spec)}`)
    .digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test mcp-connector-consent`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mcp-connector-consent.ts server/src/__tests__/mcp-connector-consent.test.ts
git commit -m "feat(connectors): command-bound consent token for unverified stdio"
```

---

## Task 10: Connector catalog service (fetch + cache)

**Files:**
- Create: `server/src/services/mcp-connector-catalog.ts`
- Test: `server/src/__tests__/mcp-connector-catalog-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { createConnectorCatalogService } from "../services/mcp-connector-catalog.js";

const good = {
  schemaVersion: "1.0.0",
  entries: [{
    id: "notion", displayName: "Notion", serverName: "notion",
    transport: "http", url: "https://mcp.notion.com/mcp",
    requiresSecret: true, trust: { tier: "verified" },
  }],
};

describe("connector catalog service", () => {
  it("fetches and parses entries", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => good });
    const svc = createConnectorCatalogService({ url: "https://cdn/connectors.json", fetchFn });
    const r = await svc.load(0);
    expect(r.entries).toHaveLength(1);
  });

  it("serves from cache within the TTL without refetching", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => good });
    const svc = createConnectorCatalogService({ url: "https://cdn/connectors.json", fetchFn });
    await svc.load(0);
    await svc.load(1000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns the last good entries when a later fetch fails", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => good })
      .mockRejectedValueOnce(new Error("network down"));
    const svc = createConnectorCatalogService({ url: "https://cdn/connectors.json", fetchFn });
    await svc.load(0);
    const r = await svc.load(7 * 3600_000);
    expect(r.entries).toHaveLength(1);
    expect(r.stale).toBe(true);
  });

  it("returns empty (not a throw) when the very first fetch fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const svc = createConnectorCatalogService({ url: "https://cdn/connectors.json", fetchFn });
    const r = await svc.load(0);
    expect(r.entries).toEqual([]);
    expect(r.stale).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-catalog-service`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/mcp-connector-catalog.ts
import { parseMcpConnectorCatalog, type McpConnectorCatalogEntry } from "@armyofagents/shared";
import { logger } from "../lib/logger.js";

/**
 * Loads the `connectors.json` CDN artifact. Deliberately in-memory: connectors are
 * a small file and this avoids a migration for a cache table. Offline instances get
 * an empty shelf, which is correct degradation — catalog.json is untouched either way.
 *
 * `nowMs` is injected so TTL behaviour is testable without fake timers.
 */
const TTL_MS = 6 * 3600_000;

export function createConnectorCatalogService(opts: {
  url: string;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = opts.fetchFn ?? fetch;
  let cached: McpConnectorCatalogEntry[] | null = null;
  let fetchedAt = -Infinity;

  return {
    async load(nowMs: number): Promise<{ entries: McpConnectorCatalogEntry[]; stale: boolean }> {
      if (cached && nowMs - fetchedAt < TTL_MS) return { entries: cached, stale: false };
      try {
        const res = await fetchFn(opts.url);
        if (!("ok" in res) || !res.ok) throw new Error(`HTTP ${(res as Response).status}`);
        const json = await (res as Response).json();
        const { entries, dropped } = parseMcpConnectorCatalog(json);
        if (dropped.length > 0) {
          // Forward compat: an entry we cannot parse costs us that entry, never the file.
          logger.warn({ dropped }, "connector catalog: dropped unparseable entries");
        }
        cached = entries;
        fetchedAt = nowMs;
        return { entries, stale: false };
      } catch (err) {
        logger.warn({ err }, "connector catalog: fetch failed; serving last known entries");
        return { entries: cached ?? [], stale: true };
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server test mcp-connector-catalog-service`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/mcp-connector-catalog.ts server/src/__tests__/mcp-connector-catalog-service.test.ts
git commit -m "feat(connectors): connectors.json fetch + cache with graceful degradation"
```

---

## Task 11: Catalog install route

**Files:**
- Modify: `server/src/routes/mcp-connectors.ts`
- Test: `server/src/__tests__/mcp-connector-install-route.test.ts`

⚠ Connectors are **not** catalog items, so this does **not** go through
`marketplace-install/orchestrator.ts` and `canInstallType` is not the RBAC path. This
route is founder-only, matching connector CRUD — a marketplace path that let team leads
install connectors would be a weaker door onto the same object (C5).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { installFromCatalogSchema, entryToCreateInput } from "../routes/mcp-connectors.js";

const verifiedHttp = {
  id: "notion", displayName: "Notion", serverName: "notion", transport: "http",
  url: "https://mcp.notion.com/mcp", args: [], headerTemplateKeys: ["Authorization"],
  envTemplateKeys: [], requiresSecret: true, trust: { tier: "verified" },
};

describe("installFromCatalogSchema", () => {
  it("accepts an entryId plus optional consent token", () => {
    expect(installFromCatalogSchema.safeParse({ entryId: "notion" }).success).toBe(true);
    expect(installFromCatalogSchema.safeParse({ entryId: "x", consentToken: "1.ab" }).success).toBe(true);
  });

  it("REJECTS an unknown key so a gate field can never be silently stripped", () => {
    // z.object() strips unknown keys by default; if consentToken were not declared
    // it would vanish and the gate would silently disappear.
    expect(installFromCatalogSchema.safeParse({ entryId: "x", sneaky: true }).success).toBe(false);
  });

  it("does not accept a client-supplied source or status", () => {
    expect(installFromCatalogSchema.safeParse({ entryId: "x", source: "catalog" }).success).toBe(false);
    expect(installFromCatalogSchema.safeParse({ entryId: "x", status: "active" }).success).toBe(false);
  });
});

describe("entryToCreateInput", () => {
  it("maps header KEYS to an empty-valued template, never a value", () => {
    const r = entryToCreateInput(verifiedHttp as never, "co1", "local_trusted", {
      actorType: "user", actorId: "u", agentId: null,
    });
    expect(r.headerTemplate).toEqual({ Authorization: "" });
    expect(r.secretRef).toBeNull();
    expect(r.requiresSecret).toBe(true);
    expect(r.source).toBe("catalog"); // NOT "marketplace"
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server test mcp-connector-install-route`
Expected: FAIL — exports missing

- [ ] **Step 3: Write minimal implementation**

```ts
// in server/src/routes/mcp-connectors.ts

export const installFromCatalogSchema = z
  .object({
    entryId: z.string().min(1),
    /** Required for unverified stdio entries. MUST be declared — an undeclared
     *  field is stripped by zod, which would delete the gate silently. */
    consentToken: z.string().min(1).optional(),
  })
  .strict();

/** Catalog entry -> createConnector input. Template KEYS become empty-valued
 *  entries; the real value is bound later via the credentials route (D5). */
export function entryToCreateInput(
  entry: McpConnectorCatalogEntry,
  companyId: string,
  deploymentMode: string,
  actor: { actorType: string; actorId: string; agentId: string | null },
) {
  const headerTemplate: Record<string, string> = {};
  for (const k of entry.headerTemplateKeys) headerTemplate[k] = "";
  const envTemplate: Record<string, string> = {};
  for (const k of entry.envTemplateKeys) envTemplate[k] = "";
  return {
    companyId,
    serverName: entry.serverName,
    displayName: entry.displayName,
    transport: entry.transport,
    url: entry.url ?? null,
    command: entry.command ?? null,
    args: entry.args,
    headerTemplate,
    envTemplate,
    secretRef: null,
    requiresSecret: entry.requiresSecret,
    source: "catalog" as const,
    deploymentMode,
    actor,
  };
}
```

```ts
  // Install from the connector catalog — founder only (C5: NOT canInstallType).
  router.post(
    "/companies/:companyId/mcp-connectors/install",
    validate(installFromCatalogSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      await assertRole(db, req, companyId, "founder");

      const { entryId, consentToken } = req.body as z.infer<typeof installFromCatalogSchema>;
      const { entries } = await connectorCatalog.load(Date.now());
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        res.status(404).json({ error: "Connector not found in catalog" });
        return;
      }

      const deploymentMode = loadConfig().deploymentMode;

      // D7 FIRST — an authorization gate, evaluated before any write and
      // independently of consent.
      assertTransportAllowed(entry.transport, deploymentMode, "catalog", entry.trust.tier);

      // Consent SECOND — a UX gate, only for unverified stdio, bound to the exact
      // command. Not a substitute for D7; D7 is not a substitute for it.
      if (entry.transport === "stdio" && entry.trust.tier !== "verified") {
        if (!consentToken) {
          throw badRequest(
            "This connector runs a command on the AoA host and is not verified. " +
              "Confirm the command to continue.",
          );
        }
        const spec = { command: entry.command ?? "", args: entry.args };
        const verdict = verifyConsentToken(
          getConsentSigningSecret(), entry.id, spec, consentToken, Date.now(),
        );
        if (!verdict.ok) throw badRequest(`Consent invalid (${verdict.reason}). Please confirm again.`);
      }

      const actor = getActorInfo(req);
      const { connector, approvalId } = await createConnector(
        entryToCreateInput(entry, companyId, deploymentMode, actor),
        { svc, secretsSvc, approvalsSvc, logActivity: (a: unknown) => logActivity(db, a as never) },
      );
      res.status(201).json({ ...connector, approvalId });
    },
  );
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @armyofagents/server test mcp-connector`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcp-connectors.ts server/src/__tests__/mcp-connector-install-route.test.ts
git commit -m "feat(connectors): founder-only catalog install route with D7 + consent gates"
```

---

## Task 12: Adversarial security suite

**Files:**
- Test: `server/src/__tests__/mcp-connector-install-adversarial.test.ts`

Three of the four defects found in Plans 1/2/2b were in this category and all passed
first-pass green tests. This task is not optional.

- [ ] **Step 1: Write the tests**

```ts
import { describe, it, expect } from "vitest";
import { assertTransportAllowed, entryToCreateInput, installFromCatalogSchema } from "../routes/mcp-connectors.js";
import { mintConsentToken, verifyConsentToken } from "../services/mcp-connector-consent.js";
import { resolveConnectorStatus } from "../services/mcp-connector-status.js";
import { McpConnectorCatalogEntrySchema } from "@armyofagents/shared";

describe("adversarial: connector install", () => {
  it("consent does NOT rescue an unverified stdio install from D7", () => {
    // Consent is a UX gate; D7 is authorization. Conflating them was the C4 defect.
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", "community")).toThrow();
  });

  it("a catalog entry cannot declare itself verified via an unknown field", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      id: "x", displayName: "X", serverName: "x", transport: "http",
      url: "https://x.test", verified: true,
    });
    expect(r.success).toBe(false); // .strict()
  });

  it("an entry with no trust block is community, never verified (fail-closed)", () => {
    const r = McpConnectorCatalogEntrySchema.parse({
      id: "x", displayName: "X", serverName: "x", transport: "http", url: "https://x.test",
    });
    expect(r.trust.tier).toBe("community");
    expect(() => assertTransportAllowed("stdio", "authenticated", "catalog", r.trust.tier)).toThrow();
  });

  it("a consent token cannot be replayed against a swapped command", () => {
    const shown = { command: "npx", args: ["-y", "safe-tool"] };
    const swapped = { command: "npx", args: ["-y", "evil-tool"] };
    const t = mintConsentToken("s", "e1", shown, 0);
    expect(verifyConsentToken("s", "e1", swapped, t, 0).ok).toBe(false);
  });

  it("a connector named __proto__ does not pollute the prototype", () => {
    const r = entryToCreateInput(
      { id: "p", displayName: "P", serverName: "p", transport: "stdio", command: "node",
        args: [], headerTemplateKeys: ["__proto__"], envTemplateKeys: [], requiresSecret: false,
        trust: { tier: "verified" } } as never,
      "co1", "local_trusted", { actorType: "user", actorId: "u", agentId: null },
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r.headerTemplate)).toContain("__proto__");
  });

  it("no combination yields active without a required secret", () => {
    for (const deploymentMode of ["local_trusted", "authenticated", "cloud_auth"]) {
      for (const approved of [true, false]) {
        expect(resolveConnectorStatus({ deploymentMode, approved, requiresSecret: true, hasSecret: false }))
          .not.toBe("active");
      }
    }
  });

  it("the install body rejects injected governance fields", () => {
    for (const body of [
      { entryId: "x", source: "catalog" },
      { entryId: "x", status: "active" },
      { entryId: "x", requiresSecret: false },
      { entryId: "x", trust: { tier: "verified" } },
    ]) {
      expect(installFromCatalogSchema.safeParse(body).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter @armyofagents/server test mcp-connector-install-adversarial`
Expected: PASS (7 tests)

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/mcp-connector-install-adversarial.test.ts
git commit -m "test(connectors): adversarial suite for install gates"
```

---

## Task 13: Integration test (embedded Postgres)

**Files:**
- Test: `server/src/__tests__/mcp-connector-install.integration.test.ts`

- [ ] **Step 1: Write the test**

Follow the existing embedded-Postgres harness used by other `*.integration.test.ts` files
in `server/src/__tests__/`. On Windows, pass
`initdbFlags: ["--encoding=UTF8", "--locale=C"]` (see the memory note on Windows
embedded-PG).

Cover the full journey end to end against a real DB:

```ts
it("install -> needs_credentials -> bind secret -> active -> delivered", async () => {
  // 1. install a verified http entry that requiresSecret
  //    expect: row created, status "needs_credentials", source "catalog"
  // 2. assert selectConnectorRowsForAgent returns [] for this connector
  //    (the allowlist chokepoint — must NOT be delivered while unbound)
  // 3. POST /credentials with a real company secret
  //    expect: status "active"
  // 4. enable the connector for an agent, then assert the loader delivers it
});

it("approving an unbound connector does NOT activate it (C2)", async () => {
  // authenticated mode: install -> pending_approval -> approve
  // expect: status "needs_credentials", and still not delivered
});

it("rejecting a needs_credentials connector disables it", async () => {
  // expect: status "disabled" (previously a silent no-op)
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @armyofagents/server test mcp-connector-install.integration`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/mcp-connector-install.integration.test.ts
git commit -m "test(connectors): integration coverage for install -> configure -> deliver"
```

---

## Task 14: UI — shelf, install dialog, Needs-setup badge

**Files:**
- Create: `ui/src/components/marketplace/connectors/ConnectorCard.tsx`, `ConnectorInstallDialog.tsx`
- Modify: `ui/src/api/mcpConnectors.ts`, `ui/src/components/settings/sections/MCPConnectorsSection.tsx`
- Test: `ui/src/components/marketplace/connectors/__tests__/ConnectorInstallDialog.test.tsx`

- [ ] **Step 1: Fix the StatusBadge fallback first**

`MCPConnectorsSection.tsx:32-34` has **no fallback return**, so an unknown status renders
no badge at all — `needs_credentials` would be invisible. Add the new status and a fallback:

```tsx
function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status === "pending_approval") return <Badge variant="warning">Pending approval</Badge>;
  if (status === "needs_credentials") return <Badge variant="warning">Needs setup</Badge>;
  if (status === "disabled") return <Badge variant="muted">Disabled</Badge>;
  // Fallback: never render nothing — an unknown status must still be visible.
  return <Badge variant="muted">{status}</Badge>;
}
```

Update the status union in `ui/src/api/mcpConnectors.ts:23`:

```ts
export type ConnectorStatus = "pending_approval" | "needs_credentials" | "active" | "disabled";
```

- [ ] **Step 2: Write the failing dialog test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectorInstallDialog } from "../ConnectorInstallDialog";

const unverifiedStdio = {
  id: "acme", displayName: "Acme DB", serverName: "acme", transport: "stdio" as const,
  command: "npx", args: ["-y", "acme-db-tool"], headerTemplateKeys: [], envTemplateKeys: [],
  requiresSecret: false, trust: { tier: "community" as const },
};

describe("ConnectorInstallDialog", () => {
  it("shows the exact command for an unverified stdio connector", () => {
    render(<ConnectorInstallDialog entry={unverifiedStdio} onInstall={vi.fn()} open />);
    expect(screen.getByText(/npx -y acme-db-tool/)).toBeInTheDocument();
    expect(screen.getByText(/unverified/i)).toBeInTheDocument();
  });

  it("disables Install until the founder confirms", async () => {
    render(<ConnectorInstallDialog entry={unverifiedStdio} onInstall={vi.fn()} open />);
    const install = screen.getByRole("button", { name: /install/i });
    expect(install).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: /run this command/i }));
    expect(install).toBeEnabled();
  });

  it("installs a verified http connector with no confirmation step", () => {
    render(<ConnectorInstallDialog
      entry={{ ...unverifiedStdio, transport: "http", url: "https://x.test", command: undefined,
               trust: { tier: "verified" } } as never}
      onInstall={vi.fn()} open />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /install/i })).toBeEnabled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @armyofagents/ui test ConnectorInstallDialog`
Expected: FAIL — component not found

- [ ] **Step 4: Implement the components**

`ConnectorInstallDialog` renders the entry, and **for unverified stdio only** shows the
literal `command + args` plus an unverified-publisher warning and a confirmation checkbox
that gates the Install button. Verified and http entries install directly.

Follow existing card chrome (design-system §9.13–9.18, `docs/architecture/design-system.md:738-829`).

⚠ Do not add `"connector"` to `pathToItemType` (`ui/src/lib/marketplace-constants.ts:92-103`)
— connectors are not catalog items and get their own route.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @armyofagents/ui test ConnectorInstallDialog`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/marketplace/connectors/ ui/src/api/mcpConnectors.ts ui/src/components/settings/sections/MCPConnectorsSection.tsx
git commit -m "feat(connectors): shelf UI, consent dialog, Needs-setup badge"
```

---

## Task 15: E2E + full verification

**Files:**
- Test: `tests/e2e/connector-install.spec.ts`

- [ ] **Step 1: Write the E2E spec**

Cover: open the connector shelf → install a verified http connector → see the
**Needs setup** badge → bind a secret in Settings → badge becomes **Active**.

- [ ] **Step 2: Run it locally**

⚠ Windows e2e is skipped in **CI only** (Issue #114). Locally it runs:

```bash
AOA_E2E_FORCE_WINDOWS=1 pnpm --filter @armyofagents/e2e test connector-install
```

Expected: PASS

- [ ] **Step 3: Run the full verification sweep**

```bash
pnpm -r typecheck
pnpm check:tokens
pnpm --filter @armyofagents/server test
pnpm --filter @armyofagents/ui test
```

Known-ignorable failures (confirm each on clean HEAD before dismissing anything else):
`github-integration` (env-host, FU-13) and load-dependent `*-routes-contract` perf flakes
(FU-12) — these hit whichever file loses the scheduling race.

- [ ] **Step 4: Run brand-check**

Extract and run the `brand-check` step from `.github/workflows/pr.yml` (there is no npm
script). ⚠ Guard 9 fails on any **literal** `process.env.AOA_…` in code that is not
documented in `docs/deploy/environment-variables.md` — if this plan introduces a new env
var (e.g. a consent signing secret), document it or compute the name.

Expected: `Brand check passed`

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/connector-install.spec.ts
git commit -m "test(connectors): e2e install -> configure journey"
```

---

## Self-review notes

- **Spec coverage.** Design §4.1 → Tasks 1, 10. §4.2 → Task 6. §4.3 → Tasks 3, 4, 7.
  §4.4 → Task 8. §4.5 → Task 5. §4.6 → Tasks 9, 11. §4.7 → Task 11 (founder-only).
  §4.8 → unchanged, no task. §4.9 → Task 14. §7 testing → Tasks 2, 12, 13, 15.
- **Deferred from 3a:** §4.8's FU-8 (codex Commander) and FU-1 (skip surface) remain
  follow-ups; the Needs-setup badge in Task 14 is the surface FU-1 should later join.
- **Not in this plan:** the `connectors.json` publishing side lives in the
  `aoa-marketplace-cdn` repo and is not in this worktree. Task 10 consumes the file; a
  fixture stands in for it until that repo can publish. This is the one external
  dependency — flag it before starting Task 14.

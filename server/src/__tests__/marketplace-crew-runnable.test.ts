/**
 * T2.3e — a marketplace-installed crew agent must arrive in a RUNNABLE state.
 *
 * Two defects, both invisible to every assertion that came before, because the
 * install *succeeds* in both:
 *
 * 1. **Inert.** The published crew bodies declare no `aoa.install`, so
 *    `normalizeStatus(undefined, false)` returned `"paused"` while the legacy
 *    seeder writes `"idle"` (`seed-crew-agent.ts:103`). Every crew execution
 *    path excludes paused — `dispatcher.ts:594`
 *    (`notInArray(agents.status, ["paused","terminated"])`), `triggers.ts:74`,
 *    and all four sweeps — so the crew installed, the UI showed it, and nothing
 *    ever ran.
 * 2. **Wrong adapter.** All the published crew bodies declare
 *    `aoa.adapterType: "process"` with no `adapterConfig`. The legacy seeder
 *    resolves the company's actual CLI via `resolveCrewAdapterForCompany`
 *    (`seed-crew-agent.ts:93`); no marketplace path did, and T2.2's gate
 *    suppresses the `ensure-*` seeders once a company is marketplace-managed,
 *    so nothing ever corrected it. `process` with no `command` throws
 *    "Process adapter missing command" at dispatch.
 *
 * **Discriminator.** The status half asserts the installed row is selected by
 * the REAL production selection function (`listEnabledOutboxAgents`, whose
 * filter IS `triggers.ts:74`), with a genuinely paused control row that must
 * NOT be selected. A bare `status !== "paused"` assertion would pass a fix that
 * still failed the real predicate, and a selection assertion with no control
 * would pass a predicate that had stopped filtering at all.
 *
 * The agent bodies are the **verbatim published fixtures** added by T2.3d
 * (`__fixtures__/published-catalog/`). Hand-written crew fixtures are what let
 * T2.3d ship — every one of them omitted the fields the real bodies carry.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { agents: tableProxy, aoaAgentTriggers: tableProxy, internalAgentConfig: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
}));
vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(async () => ""),
  fetchCatalogResourceUrl: vi.fn(async () => "# instructions"),
}));

import type { CatalogItem } from "@armyofagents/shared";
import {
  normalizeMarketplaceAgentTemplate,
  parseMarketplaceAgentTemplate,
} from "../services/marketplace-install/agent-runtime.js";
import { createMarketplaceAgent } from "../services/marketplace-install/agent-create.js";
import { listEnabledOutboxAgents } from "../services/internal-agent/aoa-agents/triggers.js";
import { resolveCrewAdapterFor } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";

function publishedBody(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/published-catalog/${name}.agent.json`, import.meta.url)),
    "utf8",
  );
}

const SCOUT_BODY = publishedBody("aoa-scout");
const ADJUTANT_BODY = publishedBody("aoa-adjutant");
const ENGINEER_BODY = publishedBody("aoa-engineer");
const REVIEWER_BODY = publishedBody("aoa-reviewer");
const ALL_PUBLISHED = [
  ["Scout", SCOUT_BODY],
  ["Adjutant", ADJUTANT_BODY],
  ["Engineer", ENGINEER_BODY],
  ["Reviewer", REVIEWER_BODY],
] as const;

function catalogItem(slug: string, name: string): CatalogItem {
  const sha = "ad575a0ae45d9bfd3c754ab4ee3af85e7f02dc68";
  return {
    id: `agent:aoa-curated/${slug}`,
    type: "agent",
    name,
    description: `${name} crew agent`,
    version: "1.0.0",
    source: {
      adapter: "aoa-curated",
      url: "https://github.com/MeteoriteLabs/aoa-marketplace",
      locator: `content/agents/${slug}`,
      commitSha: sha,
    },
    resourceUrl: `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${sha}/content/agents/${slug}/agent.json`,
    trust: { tier: "verified", source: "aoa-curated" },
    status: "active",
    addedAt: "2026-07-23T04:06:32.162Z",
    category: "workflows",
    tags: ["official"],
    requires: [],
  } as CatalogItem;
}

const SCOUT_ITEM = catalogItem("aoa-scout", "Scout");

function normalize(body: string, item: CatalogItem = SCOUT_ITEM) {
  return normalizeMarketplaceAgentTemplate({
    parsed: parseMarketplaceAgentTemplate(body, item),
    catalogItem: item,
    availableAdapterTypes: [],
  });
}

const INSTALLED_AGENT_ID = "agent-uuid-1";

/**
 * A db stub that records the row `createMarketplaceAgent` inserts.
 *
 * `select()` answers the `internal_agent_config` lookup
 * `resolveCrewAdapterForCompany` makes — `provider: null` models a company with
 * no config row at all (the openai/codex fallback).
 */
function makeInstallDb(provider: string | null) {
  const agentRows: Array<Record<string, unknown>> = [];
  const triggerRows: Array<Record<string, unknown>> = [];
  const configRows = provider === null ? [] : [{ provider, crewModel: null }];
  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(configRows) }) }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (agentRows.length === 0) {
          agentRows.push(row);
          return { returning: () => Promise.resolve([{ ...row, id: INSTALLED_AGENT_ID }]) };
        }
        triggerRows.push(row);
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return { db, triggerRows, row: () => agentRows[0] };
}

async function install(body: string, provider: string | null = "anthropic") {
  const { db, row, triggerRows } = makeInstallDb(provider);
  await createMarketplaceAgent({
    catalogItem: SCOUT_ITEM,
    companyId: "co-1",
    db: db as never,
    desiredName: "Scout",
    template: normalize(body),
  });
  return { row: row(), triggerRows };
}

/**
 * A db stub for `listEnabledOutboxAgents` — it returns the joined
 * `(agentId, status)` rows its query produces. The predicate under test is the
 * function's own filter (`triggers.ts:74`), which runs on whatever this yields.
 */
function outboxDb(rows: Array<{ agentId: string; status: string }>) {
  return {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: () => Promise.resolve(rows) }) }),
    }),
  };
}

// ─── Fixture fidelity: the bodies really do carry the broken shape ───────────

describe("the published crew bodies (verbatim)", () => {
  it("declare no `aoa.install` block and `adapterType: process`", () => {
    for (const [name, body] of ALL_PUBLISHED) {
      const aoa = (JSON.parse(body) as { aoa: Record<string, unknown> }).aoa;
      expect(aoa.kind, name).toBe("aoa");
      expect(aoa.install, name).toBeUndefined();
      expect(aoa.adapterType, name).toBe("process");
      expect(aoa.adapterConfig, name).toBeUndefined();
    }
  });
});

// ─── Step 1: the installed crew agent must be DISPATCHABLE ───────────────────

describe("a marketplace-installed crew agent is dispatchable", () => {
  it("is selected by the real outbox-trigger query (triggers.ts:74)", async () => {
    const { row } = await install(SCOUT_BODY);

    const selected = await listEnabledOutboxAgents(
      outboxDb([
        { agentId: INSTALLED_AGENT_ID, status: row.status as string },
        // The discriminator: a genuinely paused agent. If the predicate ever
        // stops filtering, this test must fail rather than pass for free.
        { agentId: "paused-control", status: "paused" },
      ]) as never,
      "co-1",
    );

    expect(selected).toContain(INSTALLED_AGENT_ID);
    expect(selected).not.toContain("paused-control");
  });

  it("holds for every published crew body, not just Scout", async () => {
    for (const [name, body] of ALL_PUBLISHED) {
      const { row } = await install(body);
      const selected = await listEnabledOutboxAgents(
        outboxDb([{ agentId: INSTALLED_AGENT_ID, status: row.status as string }]) as never,
        "co-1",
      );
      expect(selected, name).toContain(INSTALLED_AGENT_ID);
    }
  });

  it("matches the status the legacy seeder writes (seed-crew-agent.ts:103)", async () => {
    const { row } = await install(SCOUT_BODY);
    expect(row.status).toBe("idle");
  });
});

// ─── Step 2: the installed crew agent carries the COMPANY's crew adapter ─────

describe("a marketplace-installed crew agent carries the resolved crew adapter", () => {
  it.each(["anthropic", "openai", "google", "opencode", null] as const)(
    "provider %s → the same adapter resolveCrewAdapterForCompany produces",
    async (provider) => {
      const { row } = await install(SCOUT_BODY, provider);
      const expected = resolveCrewAdapterFor(provider);

      expect(row.adapterType).toBe(expected.adapterType);
      expect(row.adapterConfig).toMatchObject(expected.adapterConfig);
      // The catalog's value, which is unrunnable: the process adapter throws
      // "Process adapter missing command" (adapters/process/execute.ts:16).
      expect(row.adapterType).not.toBe("process");
    },
  );

  it("holds for every published crew body", async () => {
    const expected = resolveCrewAdapterFor("anthropic");
    for (const [name, body] of ALL_PUBLISHED) {
      const { row } = await install(body);
      expect(row.adapterType, name).toBe(expected.adapterType);
      expect(row.adapterConfig, name).toMatchObject(expected.adapterConfig);
    }
  });
});

// ─── The blast radius: non-crew installs must be untouched ───────────────────

describe("non-crew (kind: org) installs still honour the catalog", () => {
  const ORG_BODY = JSON.stringify({
    schemaVersion: "agent.v1",
    id: "org-agent",
    name: "Org Agent",
    description: "a non-crew marketplace agent",
    instructions: { type: "inline", content: "You are an org agent." },
    aoa: {
      adapterType: "http",
      adapterConfig: { url: "https://example.invalid/hook" },
      install: { defaultStatus: "active" },
    },
  });

  it("keeps the catalog's adapter and its `install.defaultStatus`", async () => {
    const { row } = await install(ORG_BODY);
    expect(row.kind).toBe("org");
    expect(row.adapterType).toBe("http");
    expect(row.adapterConfig).toEqual({ url: "https://example.invalid/hook" });
    expect(row.status).toBe("active");
  });

  it("still defaults to paused when the catalog says nothing (unchanged)", async () => {
    const body = JSON.stringify({
      schemaVersion: "agent.v1",
      id: "org-agent-2",
      name: "Org Agent 2",
      description: "no install block",
      instructions: { type: "inline", content: "hi" },
      aoa: { adapterType: "http" },
    });
    const { row } = await install(body);
    expect(row.status).toBe("paused");
  });
});

// ─── Fail-closed: a crew agent that provably cannot run stays paused ─────────

describe("a crew agent with an unmet required secret", () => {
  it("stays paused — the crew default must not install a provably broken agent", async () => {
    const body = JSON.stringify({
      schemaVersion: "agent.v1",
      id: "needs-secret",
      name: "Needs Secret",
      description: "requires a secret before it can run",
      instructions: { type: "inline", content: "hi" },
      aoa: {
        kind: "aoa",
        adapterType: "process",
        setup: {
          secrets: [
            { key: "SOME_TOKEN", label: "Some token", required: true, reason: "auth" },
          ],
        },
      },
    });
    const { row } = await install(body);
    expect(row.status).toBe("paused");
    // The adapter is still corrected — an unrunnable `process` row helps nobody,
    // and the founder supplying the secret must not also have to fix the CLI.
    expect(row.adapterType).toBe(resolveCrewAdapterFor("anthropic").adapterType);
  });
});

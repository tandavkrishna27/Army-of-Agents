/**
 * T2.3d — `aoa.triggers[].enabled` from the published catalog.
 *
 * Two separate defects, and a test that only proved the first would have
 * shipped the second:
 *
 * 1. **Schema.** `AgentRuntimeSchema`'s trigger object was `.strict()` with only
 *    `kind` + `config`, so every published crew `agent.json` failed pre-flight
 *    with `unrecognized_keys: ["enabled"]` — which aborted `installTeam`, which
 *    degraded every live company create to the `@legacy` seeders.
 * 2. **Semantics.** The normalizer dropped the field and both insert sites
 *    hardcoded `enabled: true`, so a bare schema relaxation would have installed
 *    a trigger the catalog marked DISABLED as ENABLED.
 *
 * The fixtures under `__fixtures__/published-catalog/` are **verbatim copies of
 * real published bodies** (`raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace`
 * @ `ad575a0ae45d9bfd3c754ab4ee3af85e7f02dc68`, fetched 2026-07-24), not
 * hand-written. Hand-written trigger fixtures are exactly why this shipped: every
 * one in the repo omitted `enabled`, and the bundled catalog *index* carries no
 * trigger data at all (triggers live in the separately-fetched `agent.json`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  // T2.3e: internalAgentConfig — `createMarketplaceAgent` resolves the
  // company's crew adapter for `kind: "aoa"` templates.
  return {
    agents: tableProxy,
    aoaAgentTriggers: tableProxy,
    marketplacePendingUpdates: tableProxy,
    internalAgentConfig: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { updateAvailable: vi.fn().mockResolvedValue(undefined) },
}));

/** The body `applyCrewAgentUpdate`'s fetch returns. Set per test. */
const updateBody = vi.hoisted(() => ({ value: "" }));
vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(async () => updateBody.value),
  fetchCatalogResourceUrl: vi.fn(async () => "# instructions"),
}));

import type { CatalogItem } from "@armyofagents/shared";
import {
  normalizeMarketplaceAgentTemplate,
  parseMarketplaceAgentTemplate,
} from "../services/marketplace-install/agent-runtime.js";
import { createMarketplaceAgent } from "../services/marketplace-install/agent-create.js";
import { applyCrewAgentUpdate } from "../services/marketplace-install/crew-updater.js";

function publishedBody(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/published-catalog/${name}.agent.json`, import.meta.url)),
    "utf8",
  );
}

const ADJUTANT_BODY = publishedBody("aoa-adjutant");
const ENGINEER_BODY = publishedBody("aoa-engineer");

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

const ADJUTANT_ITEM = catalogItem("aoa-adjutant", "Adjutant");
const ENGINEER_ITEM = catalogItem("aoa-engineer", "Engineer");

function normalize(body: string, item: CatalogItem) {
  return normalizeMarketplaceAgentTemplate({
    parsed: parseMarketplaceAgentTemplate(body, item),
    catalogItem: item,
    availableAdapterTypes: [],
  });
}

/** The published body with every trigger flipped to `enabled: false`. */
function withDisabledTriggers(body: string): string {
  const json = JSON.parse(body) as { aoa: { triggers: Array<Record<string, unknown>> } };
  json.aoa.triggers = json.aoa.triggers.map((t) => ({ ...t, enabled: false }));
  return JSON.stringify(json);
}

// ─── Step 1: the schema must accept what the catalog actually publishes ──────

describe("published crew agent.json bodies (verbatim from the live catalog)", () => {
  it("parses the published Adjutant body — its trigger carries `enabled`", () => {
    expect(() => parseMarketplaceAgentTemplate(ADJUTANT_BODY, ADJUTANT_ITEM)).not.toThrow();
  });

  it("parses the published Engineer body — two triggers, both carrying `enabled`", () => {
    expect(() => parseMarketplaceAgentTemplate(ENGINEER_BODY, ENGINEER_ITEM)).not.toThrow();
  });

  it("the fixtures really are the production shape (guards against a fixture rewrite)", () => {
    for (const body of [ADJUTANT_BODY, ENGINEER_BODY]) {
      const triggers = (JSON.parse(body) as { aoa: { triggers: unknown[] } }).aoa.triggers;
      expect(triggers.length).toBeGreaterThan(0);
      for (const trigger of triggers) {
        expect(trigger).toHaveProperty("enabled");
      }
    }
  });
});

// ─── Step 2: the discriminator — `enabled: false` must be HONOURED ───────────

describe("normalizeMarketplaceAgentTemplate — triggers[].enabled", () => {
  it("carries `enabled: true` through from the published body", () => {
    expect(normalize(ENGINEER_BODY, ENGINEER_ITEM).triggers).toEqual([
      { kind: "mention", enabled: true, config: { role: "engineer" } },
      { kind: "phase-advance", enabled: true, config: { role: "engineer" } },
    ]);
  });

  it("carries `enabled: false` through — a disabled catalog trigger stays disabled", () => {
    const normalized = normalize(withDisabledTriggers(ENGINEER_BODY), ENGINEER_ITEM);
    expect(normalized.triggers.map((t) => t.enabled)).toEqual([false, false]);
  });

  it("defaults to `enabled: true` when the field is absent (pre-`enabled` templates)", () => {
    const body = JSON.stringify({
      schemaVersion: "agent.v1",
      id: "legacy-shaped",
      name: "Legacy Shaped",
      description: "no enabled field",
      instructions: { type: "inline", content: "hi" },
      aoa: { kind: "aoa", triggers: [{ kind: "mention", config: { role: "scout" } }] },
    });
    expect(normalize(body, ADJUTANT_ITEM).triggers).toEqual([
      { kind: "mention", enabled: true, config: { role: "scout" } },
    ]);
  });
});

// ─── Step 4a: insert site #1 — createMarketplaceAgent ────────────────────────

function makeInsertCapturingDb() {
  const triggerRows: Array<Record<string, unknown>> = [];
  let sawAgentInsert = false;
  const db = {
    // T2.3e: the `internal_agent_config` read `resolveCrewAdapterForCompany`
    // makes for a crew install. Empty → the openai/codex fallback.
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        if (!sawAgentInsert) {
          sawAgentInsert = true;
          return { returning: () => Promise.resolve([{ ...row, id: "agent-uuid-1" }]) };
        }
        triggerRows.push(row);
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };
  return { db, triggerRows };
}

describe("createMarketplaceAgent — trigger rows", () => {
  it("writes enabled=false for a catalog trigger the catalog disabled", async () => {
    const { db, triggerRows } = makeInsertCapturingDb();
    await createMarketplaceAgent({
      catalogItem: ENGINEER_ITEM,
      companyId: "co-1",
      db: db as never,
      desiredName: "Engineer",
      template: normalize(withDisabledTriggers(ENGINEER_BODY), ENGINEER_ITEM),
    });

    expect(triggerRows).toHaveLength(2);
    expect(triggerRows.map((r) => r.enabled)).toEqual([false, false]);
  });

  it("writes enabled=true for the published (enabled) triggers", async () => {
    const { db, triggerRows } = makeInsertCapturingDb();
    await createMarketplaceAgent({
      catalogItem: ENGINEER_ITEM,
      companyId: "co-1",
      db: db as never,
      desiredName: "Engineer",
      template: normalize(ENGINEER_BODY, ENGINEER_ITEM),
    });

    expect(triggerRows.map((r) => r.enabled)).toEqual([true, true]);
  });
});

/**
 * D22: `applyCrewAgentUpdate`'s agent UPDATE is `.where(...).returning(...)` (the
 * `instructions_customized = false` optimistic lock), while the pending-update
 * UPDATE awaits `.where(...)` directly. Drizzle builders are both chainable and
 * thenable; the stub has to be too.
 */
function agentUpdateResult() {
  return {
    returning: () => Promise.resolve([{ id: "agent-1" }]),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(undefined).then(resolve, reject),
  };
}

// ─── Step 4b: insert site #2 — crew-updater's re-insert ──────────────────────
//
// Adoption/update must not silently re-enable a trigger the catalog disabled.

describe("applyCrewAgentUpdate — trigger re-insert", () => {
  beforeEach(() => {
    updateBody.value = "";
  });

  async function runUpdate(body: string): Promise<Array<Record<string, unknown>>> {
    updateBody.value = body;
    const triggerRows: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({ set: () => ({ where: () => agentUpdateResult() }) }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          triggerRows.push(row);
          return Promise.resolve(undefined);
        },
      }),
      delete: () => ({ where: () => Promise.resolve(undefined) }),
    };

    await applyCrewAgentUpdate({
      db: {
        // D22/F2: the indexed re-read before materialize.
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [{ instructionsCustomized: false }] }) }),
        }),
        transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      } as never,
      agentRow: {
        id: "agent-1",
        companyId: "co-1",
        name: "Engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        skillKeys: [],
        templateVersion: "0.0.1",
        // D22: provably untouched, so the customization gate lets the update run.
        // These suites are about triggers, not about the gate.
        instructionsCustomized: false,
      },
      catalogItem: ENGINEER_ITEM,
      instructionsService: {
        materializeManagedBundle: vi.fn().mockResolvedValue({ adapterConfig: {} }),
      } as never,
    });
    return triggerRows;
  }

  it("does NOT silently re-enable a trigger the catalog disabled", async () => {
    const rows = await runUpdate(withDisabledTriggers(ENGINEER_BODY));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.enabled)).toEqual([false, false]);
  });

  it("re-inserts the published triggers as enabled", async () => {
    const rows = await runUpdate(ENGINEER_BODY);
    expect(rows.map((r) => r.enabled)).toEqual([true, true]);
  });
});

// ─── D23: a catalog update must not functionally destroy a protected agent ───
//
// `applyCrewAgentUpdate` wipes ALL of an agent's `aoa_agent_triggers` rows and
// re-inserts only what the template carries. Unreachable for Steward today (its
// `templateOrigin` is NULL, so `checkCrewUpdates` never matches it) — but it
// becomes reachable the moment T2.4 publishes Steward, which is the same event
// relied on elsewhere to close the rename gap.
//
// A Steward that loses its `sweep`/`role:steward` trigger stops running
// permanently: `sweep-steward.ts` selects on kind='sweep' + enabled=true, and
// `seedCrewAgent` only seeds triggers for a NEWLY INSERTED row, so nothing ever
// restores it. The row survives; the agent is dead. That is verbatim the harm
// `PROTECTED_AGENT_ROLES[1].why` names.

describe("applyCrewAgentUpdate — protected agents keep their triggers (D23)", () => {
  beforeEach(() => {
    updateBody.value = "";
  });

  async function runUpdateFor(
    agentName: string,
    item: CatalogItem,
  ): Promise<{ inserted: Array<Record<string, unknown>>; deleteCount: number }> {
    updateBody.value = ENGINEER_BODY;
    const inserted: Array<Record<string, unknown>> = [];
    let deleteCount = 0;
    const tx = {
      update: () => ({ set: () => ({ where: () => agentUpdateResult() }) }),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return Promise.resolve(undefined);
        },
      }),
      delete: () => ({
        where: () => {
          deleteCount += 1;
          return Promise.resolve(undefined);
        },
      }),
    };

    await applyCrewAgentUpdate({
      db: {
        // D22/F2: the indexed re-read before materialize.
        select: () => ({
          from: () => ({ where: () => ({ limit: async () => [{ instructionsCustomized: false }] }) }),
        }),
        transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      } as never,
      agentRow: {
        id: "agent-1",
        companyId: "co-1",
        name: agentName,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        skillKeys: [],
        templateVersion: "0.0.1",
        // D22: provably untouched, so the customization gate lets the update run.
        // These suites are about triggers, not about the gate.
        instructionsCustomized: false,
      },
      catalogItem: item,
      instructionsService: {
        materializeManagedBundle: vi.fn().mockResolvedValue({ adapterConfig: {} }),
      } as never,
    });
    return { inserted, deleteCount };
  }

  // The id T2.4 will publish Steward under.
  const STEWARD_ITEM = catalogItem("aoa-steward", "Steward");

  it("never deletes a protected agent's triggers, matched on the catalog origin", async () => {
    const { inserted, deleteCount } = await runUpdateFor("Steward", STEWARD_ITEM);

    expect(deleteCount).toBe(0);
    expect(inserted).toEqual([]);
  });

  it("protects a RENAMED Steward too (origin slug carries the identity)", async () => {
    const { deleteCount } = await runUpdateFor("Hub Curator", STEWARD_ITEM);
    expect(deleteCount).toBe(0);
  });

  it("protects a Steward whose origin does NOT say steward (name falls through)", async () => {
    const { deleteCount } = await runUpdateFor("Steward", ENGINEER_ITEM);
    expect(deleteCount).toBe(0);
  });

  // THE DISCRIMINATOR: an unprotected crew agent is still fully replaced. A
  // blanket "never touch crew triggers" guard passes every test above and fails
  // this one — and would silently freeze the trigger config of all 9 crew roles.
  it("still wipes and re-inserts an unprotected crew agent's triggers", async () => {
    const { inserted, deleteCount } = await runUpdateFor("Engineer", ENGINEER_ITEM);

    expect(deleteCount).toBe(1);
    expect(inserted.map((r) => r.kind)).toEqual(["mention", "phase-advance"]);
  });
});

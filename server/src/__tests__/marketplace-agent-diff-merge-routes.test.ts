/**
 * T2.7 — `/updates/:id/{diff,merge,apply}` for `itemType: "agent"`.
 *
 * Before this task the three routes formed a closed loop: `/apply` answered
 * **501** "use merge", `/merge` answered **404** "not a skill", and `/diff`
 * answered **400** "skill updates only". The Review button led nowhere, so
 * every agent pending update — including the entire pre-`0182` backlog D22
 * routes to notify — accumulated with no way to land.
 *
 * The real merge service runs here (only the two catalog fetches are stubbed),
 * so these tests prove the wiring: pending row → agent row → diff → write.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

const upstreamState = vi.hoisted(() => ({
  files: {} as Record<string, string>,
  body: "",
}));

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn(async () => upstreamState.body),
  loadSkillContent: vi.fn(),
}));
vi.mock("../services/marketplace-install/agent-create.js", () => ({
  loadMarketplaceInstructionFiles: vi.fn(async () => ({
    files: { ...upstreamState.files },
    entryFile: "AGENTS.md",
  })),
}));
vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (_t, prop) => (prop === "__table" ? name : Symbol(String(prop))) },
    );
  return {
    agents: table("agents"),
    aoaAgentTriggers: table("aoaAgentTriggers"),
    marketplacePendingUpdates: table("marketplacePendingUpdates"),
    companySkills: table("companySkills"),
    plugins: table("plugins"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  ne: () => Symbol("op:ne"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { installRequested: vi.fn(), updateAvailable: vi.fn(), updateCompleted: vi.fn() },
}));
vi.mock("../services/marketplace-settings.js", () => ({
  marketplaceSettingsService: vi.fn(() => ({ get: vi.fn(), patch: vi.fn() })),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
}));

import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";

// ── fixtures ───────────────────────────────────────────────────────────────

const AGENT_BODY = JSON.stringify({
  schemaVersion: "agent.v1",
  id: "aoa-scout",
  name: "Scout",
  description: "Internal-only research and investigation for threads.",
  instructions: { type: "file", path: "AGENTS.md" },
  aoa: {
    adapterType: "process",
    kind: "aoa",
    runtimeConfig: { aoa: { toolAllowlist: ["query_threads"] } },
    skillKeys: ["research"],
    triggers: [{ kind: "mention", enabled: true, config: {} }],
  },
});

const MINE_MD = `You are Scout.

## Output
Post ONE synthesis entry, ALWAYS in Norwegian.
`;

const UPSTREAM_MD = `You are Scout.

## Output
Post ONE synthesis entry.

## Escalation
Hand back to Adjutant.
`;

const CATALOG_ITEM = {
  id: "agent:aoa-curated/aoa-scout",
  type: "agent" as const,
  name: "Scout",
  version: "0.3.0",
  description: "d",
  source: { adapter: "aoa-curated", url: "u", locator: "l", commitSha: "abc" },
  resourceUrl: "https://example.com/agent.json",
  trust: { tier: "verified" as const, source: "aoa-curated" },
  status: "active" as const,
  addedAt: "2026-01-01T00:00:00Z",
  category: "crew",
  tags: [],
};

const UPDATE_ROW = {
  id: "upd-1",
  companyId: "c1",
  catalogItemId: CATALOG_ITEM.id,
  catalogItemName: "Scout",
  itemType: "agent",
  currentVersion: "0.2.0",
  latestVersion: "0.3.0",
  status: "conflict",
};

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "c1",
    name: "Scout",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    skillKeys: ["old"],
    templateOrigin: CATALOG_ITEM.id,
    templateVersion: "0.2.0",
    instructionsCustomized: true as boolean | null,
    ...overrides,
  };
}

/** In-memory stand-in for `agentInstructionsService()`. */
function memoryInstructions(files: Record<string, string>) {
  const cfg = (agent: { adapterConfig?: unknown }) =>
    (agent.adapterConfig as Record<string, unknown>) ?? {};
  return {
    getBundle: async () => ({
      entryFile: "AGENTS.md",
      files: Object.keys(files).map((p) => ({ path: p, virtual: false })),
    }),
    readFile: async (_a: unknown, p: string) => ({ content: files[p]! }),
    writeFile: async (a: { adapterConfig?: unknown }, p: string, content: string) => {
      files[p] = content;
      return { adapterConfig: cfg(a) };
    },
    deleteFile: async (a: { adapterConfig?: unknown }, p: string) => {
      delete files[p];
      return { adapterConfig: cfg(a) };
    },
    updateBundle: async (a: { adapterConfig?: unknown }) => ({ adapterConfig: cfg(a) }),
    materializeManagedBundle: async (
      a: { adapterConfig?: unknown },
      next: Record<string, string>,
    ) => {
      for (const key of Object.keys(files)) delete files[key];
      Object.assign(files, next);
      return { adapterConfig: cfg(a) };
    },
  };
}

interface Harness {
  agentSets: Record<string, unknown>[];
  pendingSets: Record<string, unknown>[];
}

function buildApp(opts?: {
  update?: Record<string, unknown>;
  agents?: Record<string, unknown>[];
  files?: Record<string, string>;
  catalogItems?: unknown[];
}) {
  const update = opts?.update ?? UPDATE_ROW;
  const agentRows = opts?.agents ?? [agentRow()];
  const files = opts?.files ?? { "AGENTS.md": MINE_MD };
  const harness: Harness = { agentSets: [], pendingSets: [] };

  const record = (table: { __table: string }, values: Record<string, unknown>) => {
    if (table.__table === "marketplacePendingUpdates") harness.pendingSets.push(values);
    else harness.agentSets.push(values);
  };

  const rowsFor = (table: { __table: string }) =>
    table.__table === "marketplacePendingUpdates" ? [update] : agentRows;

  const tx = {
    update: (table: { __table: string }) => ({
      set: (values: Record<string, unknown>) => {
        record(table, values);
        return { where: () => ({ returning: async () => [{ id: "x" }] }) };
      },
    }),
    delete: () => ({ where: async () => undefined }),
    insert: () => ({ values: async () => undefined }),
  };

  const db = {
    select: () => ({
      from: (table: { __table: string }) => {
        const rows = rowsFor(table);
        return {
          where: () => ({
            limit: async () => rows,
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          }),
        };
      },
    }),
    update: (table: { __table: string }) => ({
      set: (values: Record<string, unknown>) => {
        record(table, values);
        return { where: async () => undefined };
      },
    }),
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };

  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { actor?: unknown }, _res, next) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
    next();
  });
  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceCompanyRouter({
      db: db as never,
      instructionsService: memoryInstructions(files) as never,
      catalogService: {
        readCache: async () =>
          ({
            schemaVersion: "1.0.0",
            generatedAt: "2026-07-24T00:00:00Z",
            itemCount: 1,
            items: (opts?.catalogItems ?? [CATALOG_ITEM]) as never,
          }) as never,
      },
    }),
  );

  return { app, files, harness };
}

beforeEach(() => {
  upstreamState.body = AGENT_BODY;
  upstreamState.files = { "AGENTS.md": UPSTREAM_MD };
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("GET /updates/:id/diff — agent", () => {
  it("returns a file-scoped section diff instead of the old 400", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/companies/c1/marketplace/updates/upd-1/diff");

    expect(res.status).toBe(200);
    const sections = res.body.diff as { header: string; file: string; section: string; state: string }[];
    expect(sections.every((s) => s.file === "AGENTS.md")).toBe(true);
    expect(sections.find((s) => s.section === "Output")?.state).toBe("changed");
    expect(sections.find((s) => s.section === "Escalation")?.state).toBe("added");
    expect(res.body.identical).toBe(false);
    expect(res.body.instructionsCustomized).toBe(true);
  });

  it("404s when no installed agent carries the update's template origin", async () => {
    const { app } = buildApp({ agents: [] });
    const res = await request(app).get("/api/companies/c1/marketplace/updates/upd-1/diff");
    expect(res.status).toBe(404);
  });

  it("409s rather than guessing when two agents share the template origin", async () => {
    const { app } = buildApp({ agents: [agentRow(), agentRow({ id: "agent-2", name: "Scout-2" })] });
    const res = await request(app).get("/api/companies/c1/marketplace/updates/upd-1/diff");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AMBIGUOUS_AGENT_ORIGIN");
  });
});

describe("POST /updates/:id/merge — agent", () => {
  it("lands a keep-mine decision and preserves the founder's bytes", async () => {
    const { app, files, harness } = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({ decisions: { "AGENTS.md::Output": "mine", "AGENTS.md::Escalation": "theirs" } });

    expect(res.status).toBe(200);
    expect(files["AGENTS.md"]).toContain("ALWAYS in Norwegian.");
    expect(files["AGENTS.md"]).toContain("Hand back to Adjutant.");
    expect(res.body.instructionsCustomized).toBe(true);
    expect(harness.pendingSets.some((s) => s.status === "applied")).toBe(true);
  });

  it("accepts an EMPTY decisions map for an agent (the skill path's 400 would block the backlog)", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({ decisions: {} });
    expect(res.status).toBe(200);
  });

  it("still rejects an empty decisions map for a SKILL update", async () => {
    const { app } = buildApp({ update: { ...UPDATE_ROW, itemType: "skill", status: "pending" } });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({ decisions: {} });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid decision value", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/merge")
      .send({ decisions: { "AGENTS.md::Output": "upstream" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /updates/:id/apply — agent", () => {
  it("applies in one click when the agent has NO local divergence", async () => {
    // The discriminator against over-gating: forcing a provably untouched agent
    // through a review it has nothing to review is the failure mode on the
    // other side of D22.
    const { app, files } = buildApp({ agents: [agentRow({ instructionsCustomized: false })] });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/apply")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true });
    expect(files["AGENTS.md"]).toBe(UPSTREAM_MD);
  });

  it("409s a customized agent to the merge path instead of the old 501", async () => {
    const { app } = buildApp({ agents: [agentRow({ instructionsCustomized: true })] });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/apply")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("AGENT_INSTRUCTIONS_CUSTOMIZED");
  });

  it("409s an unknown-provenance agent too (D22 fails closed on NULL)", async () => {
    const { app } = buildApp({ agents: [agentRow({ instructionsCustomized: null })] });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/apply")
      .send({});
    expect(res.status).toBe(409);
  });

  it("accepts a pending row in `conflict` state (the status T2.7 now writes)", async () => {
    const { app } = buildApp({
      update: { ...UPDATE_ROW, status: "conflict" },
      agents: [agentRow({ instructionsCustomized: false })],
    });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/apply")
      .send({});
    expect(res.status).toBe(200);
  });

  it("still refuses TEAM updates", async () => {
    const { app } = buildApp({ update: { ...UPDATE_ROW, itemType: "team", status: "pending" } });
    const res = await request(app)
      .post("/api/companies/c1/marketplace/updates/upd-1/apply")
      .send({});
    expect(res.status).toBe(501);
  });
});

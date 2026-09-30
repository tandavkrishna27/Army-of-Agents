/**
 * T2.3 — company creation installs the crew FROM THE MARKETPLACE (P8, P8c).
 *
 * The whole point of Phase 2: legacy-seeded crew rows are stamped `…@legacy`
 * by `backfill-template-origin.ts`, and `crew-updater.ts` skips `@legacy` rows
 * forever — so every company was permanently frozen out of the update pipeline
 * that is already built and running. This suite proves a freshly created
 * company is born *updateable*.
 *
 * Real PostgreSQL, because every assertion here is about rows the create path
 * actually wrote (origins, versions, skillKeys, the team row, the install
 * operation) and about a real transaction rolling back on failure. A mocked DB
 * could only prove that functions were called.
 *
 * ── What is stubbed, and what is deliberately NOT ────────────────────────────
 * `globalThis.fetch` is replaced with a fixture server. Nothing here touches
 * the network, and — importantly — nothing here reads
 * `ui/src/aoa-marketplace-snapshot.json`. That file is GITIGNORED
 * (`.gitignore:60`; it is fetched at build time by `pnpm fetch-catalog`), so a
 * test that depended on it would pass on a dev machine that happens to have
 * run the fetch and prove nothing in CI or a fresh clone, where
 * `bundledSnapshotProvider` catches the failed import and returns `null`. The
 * snapshot is INJECTED as a fixture instead.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 * Modeled on teams-null-parent-cascade.integration.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";

/**
 * T2.3c — the ONLY thing stubbed in the skill path is the git clone.
 *
 * `materializeSkillBundle` shells out to `git clone` against GitHub, and
 * `isMarketplaceGitHubRepo` rejects anything that is not a github.com repo, so a
 * bundle-carrying fixture cannot be served by the in-process fixture server.
 * Mocking the clone (and nothing else) keeps the field-parity assertion honest:
 * BOTH sides of the comparison run the real `installSkill` over the same mock,
 * so a hand-rolled insert still cannot match it.
 */
const materializerMock = vi.hoisted(() => vi.fn());
vi.mock("../services/marketplace-install/skill-bundle-materializer.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/marketplace-install/skill-bundle-materializer.js")
  >("../services/marketplace-install/skill-bundle-materializer.js");
  return { ...actual, materializeSkillBundle: materializerMock };
});
vi.mock(
  "../services/outbound-url-guard.js",
  () => import("./helpers/outbound-url-guard.mock.js"),
);

import {
  MarketplaceCatalogService,
  loadCachedCatalog,
  registerMarketplaceCatalogService,
} from "../services/aoa-marketplace.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { listEnabledOutboxAgents } from "../services/internal-agent/aoa-agents/triggers.js";
import { resolveCrewAdapterForCompany } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";
import { provisionCompanyCrew } from "../services/crew-provisioning.js";
import { installSkill } from "../services/marketplace-install/skill-installer.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up.
 *
 * `setupError = err` alone is not a guard: embedded-postgres can reject with
 * `undefined`, which is falsy, so the old `if (setupError) throw` silently
 * no-oped and every case then ran against an unassigned `db` — a wall of
 * `Cannot read properties of undefined (reading 'insert')` pointing into
 * product code, which reads as a product bug rather than a setup failure.
 * A boolean cannot be falsy-by-accident, and the `db` check covers a throw
 * that happens to leave `setupError` null.
 */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

const PORT = 57900 + Math.floor(Math.random() * 500);

/** A CDN URL that is never reachable — the fixture fetch always rejects it. */
const FIXTURE_CDN_URL = "https://cdn.fixture.invalid/catalog.json";
const FIXTURE_HOST =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;

const TEAM_ID = "team:aoa-curated/default-crew";
const SCOUT_ID = "agent:aoa-curated/aoa-scout";
const REVIEWER_ID = "agent:aoa-curated/aoa-reviewer";
const STEWARD_ID = "agent:aoa-curated/aoa-steward";
const SKILL_ID = "skill:aoa-curated/fixture-crew-skill";
/**
 * The shape every real crew skill has: a `skill.bundle`, a `provider`, a
 * `resourceUrl`, and NO inline content. All 17 skills
 * `team:aoa-curated/default-crew` requires look exactly like this in the live
 * catalog (verified 2026-07-24 against the published `catalog.json`).
 */
const BUNDLE_SKILL_ID = "skill:github-skills/fixture/repo/bundle-skill";

const BUNDLE_INVENTORY = [
  { path: "SKILL.md", kind: "skill" },
  { path: "references/guide.md", kind: "reference" },
  { path: "scripts/run.js", kind: "script" },
];
const BUNDLE_MARKDOWN = "---\nname: bundle-skill\n---\n\nFrom the materialized bundle.\n";

/** `companies.issue_prefix` is globally unique, so raw inserts need distinct values. */
let seedCounter = 0;
function nextIssuePrefix(): string {
  seedCounter += 1;
  return `CB${seedCounter}`;
}

function rowsOf<T>(result: unknown): T[] {
  const asObj = result as { rows?: T[] };
  return asObj?.rows ?? (result as T[]);
}

// ── Fixture catalog ──────────────────────────────────────────────────────────
// A miniature of the real `team:aoa-curated/default-crew`: a team item whose
// requires[] names three agents and two skills. Deliberately hand-built rather
// than loaded from the gitignored snapshot (see file docstring).

function catalogItemBase(id: string, type: string, name: string) {
  return {
    id,
    type,
    name,
    description: `${name} fixture`,
    version: "1.0.0",
    source: { adapter: "aoa-curated", url: "https://github.com/MeteoriteLabs/aoa-marketplace", locator: `content/${id}` },
    trust: { tier: "verified", source: "aoa-curated" },
    status: "active",
    addedAt: "2026-07-24T00:00:00.000Z",
    category: "workflows",
    tags: ["official"],
  };
}

const FIXTURE_CATALOG: MarketplaceCatalogFile = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-24T00:00:00.000Z",
  itemCount: 6,
  items: [
    {
      ...catalogItemBase(TEAM_ID, "team", "AoA Default Crew"),
      resourceUrl: `${FIXTURE_HOST}/teams/default-crew/team.json`,
      requires: [
        { type: "agent", id: SCOUT_ID },
        { type: "agent", id: REVIEWER_ID },
        { type: "agent", id: STEWARD_ID },
        { type: "skill", id: SKILL_ID },
        { type: "skill", id: BUNDLE_SKILL_ID },
      ],
    },
    {
      ...catalogItemBase(SCOUT_ID, "agent", "Scout"),
      resourceUrl: `${FIXTURE_HOST}/agents/aoa-scout/agent.json`,
    },
    {
      ...catalogItemBase(REVIEWER_ID, "agent", "Reviewer"),
      resourceUrl: `${FIXTURE_HOST}/agents/aoa-reviewer/agent.json`,
    },
    {
      ...catalogItemBase(STEWARD_ID, "agent", "Steward"),
      resourceUrl: `${FIXTURE_HOST}/agents/aoa-steward/agent.json`,
    },
    {
      ...catalogItemBase(SKILL_ID, "skill", "Fixture Crew Skill"),
      content: { inline: "---\nname: fixture-crew-skill\n---\n\nDo the thing.\n" },
    },
    {
      ...catalogItemBase(BUNDLE_SKILL_ID, "skill", "Fixture Bundle Skill"),
      // resourceUrl but no inline content — exactly the live crew skills. The
      // pre-T2.3c hand-rolled insert fetched THIS body; the real installer
      // never looks at it, because the bundle carries its own SKILL.md.
      resourceUrl: `${FIXTURE_HOST}/skills/bundle-skill/SKILL.md`,
      skill: {
        bundle: {
          type: "github-directory",
          repo: "fixture/repo",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          path: "skills/bundle-skill",
          treeUrl: "https://github.com/fixture/repo/tree/0123456789abcdef/skills/bundle-skill",
        },
        frontmatter: { name: "bundle-skill", raw: {} },
      },
      provider: {
        id: "fixture",
        name: "Fixture",
        logoUrl: "https://example.invalid/logo.png",
        fallbackInitials: "FX",
      },
    },
  ],
} as unknown as MarketplaceCatalogFile;

function agentTemplate(id: string, name: string, triggerRole: string) {
  return JSON.stringify({
    schemaVersion: "agent.v1",
    id,
    name,
    description: `${name} fixture agent`,
    instructions: { type: "inline", content: `You are ${name}.` },
    aoa: {
      kind: "aoa",
      adapterType: "claude_local",
      skillKeys: [SKILL_ID],
      // agent.v1 only allows active|paused|terminated here.
      //
      // ⚠️ KNOWN DIVERGENCES FROM THE PUBLISHED BODIES, kept deliberately so
      // this suite stays about T2.3: the real crew agents declare NO `install`
      // block (so they normalize to `status: "paused"`, `role: "general"`),
      // `adapterType: "process"`, and `instructions: {type:"file"}`. Those are
      // reported as open findings on T2.3d, not fixed here.
      install: { defaultStatus: "active", defaultRole: "general" },
      // `enabled` IS production-shaped: every published crew agent declares it,
      // and hand-writing it away is what let T2.3d ship a schema that rejected
      // every real body. See `marketplace-trigger-enabled.test.ts`, which parses
      // verbatim published bodies.
      triggers: [{ kind: "mention", enabled: true, config: { role: triggerRole } }],
    },
  });
}

const TEAM_TEMPLATE = JSON.stringify({
  slug: "aoa-default-crew",
  description: "Fixture crew",
  manifest: { installOrder: [SCOUT_ID, REVIEWER_ID, STEWARD_ID] },
  agents: [
    { templateOrigin: SCOUT_ID, name: "Scout" },
    { templateOrigin: REVIEWER_ID, name: "Reviewer" },
    { templateOrigin: STEWARD_ID, name: "Steward" },
  ],
});

const FIXTURE_BODIES: Record<string, string> = {
  [`${FIXTURE_HOST}/teams/default-crew/team.json`]: TEAM_TEMPLATE,
  [`${FIXTURE_HOST}/agents/aoa-scout/agent.json`]: agentTemplate("aoa-scout", "Scout", "scout"),
  [`${FIXTURE_HOST}/agents/aoa-reviewer/agent.json`]: agentTemplate("aoa-reviewer", "Reviewer", "reviewer"),
  [`${FIXTURE_HOST}/agents/aoa-steward/agent.json`]: agentTemplate("aoa-steward", "Steward", "steward"),
  // Deliberately DIFFERENT from BUNDLE_MARKDOWN: the pre-T2.3c installer stored
  // this body, the real installer stores the bundle's, so the two are
  // distinguishable in the parity assertion.
  [`${FIXTURE_HOST}/skills/bundle-skill/SKILL.md`]:
    "---\nname: bundle-skill\n---\n\nFrom the CDN body, NOT the bundle.\n",
};

/**
 * T2.3d — the REAL published bodies, byte-for-byte, from
 * `raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace` @
 * `ad575a0ae45d9bfd3c754ab4ee3af85e7f02dc68` (fetched 2026-07-24).
 *
 * `agentTemplate()` above is hand-written, and hand-written trigger fixtures are
 * precisely why T2.3 shipped a schema that rejected every real crew body
 * (`unrecognized_keys: ["enabled"]`) and degraded every live company create to
 * the `@legacy` seeders. Nothing derived from the bundled catalog *index* could
 * have caught it either: triggers live only in the separately-fetched
 * `agent.json`.
 */
const PUBLISHED_AGENT_BODIES: Record<string, string> = {
  [`${FIXTURE_HOST}/agents/aoa-scout/agent.json`]: readFileSync(
    fileURLToPath(new URL("./__fixtures__/published-catalog/aoa-scout.agent.json", import.meta.url)),
    "utf8",
  ),
  [`${FIXTURE_HOST}/agents/aoa-reviewer/agent.json`]: readFileSync(
    fileURLToPath(
      new URL("./__fixtures__/published-catalog/aoa-reviewer.agent.json", import.meta.url),
    ),
    "utf8",
  ),
};

let realFetch: typeof globalThis.fetch;
/** URLs the fixture server should 503 on — used to force a mid-install failure. */
const brokenUrls = new Set<string>();
/** URLs that never resolve — used to prove the aggregate deadline aborts them. */
const stalledUrls = new Set<string>();
/** Whether the fixture CDN answers. Default unreachable; one test flips it. */
let cdnReachable = false;
/** Serve a team.json whose `agents` array is empty (F4). */
let emptyTeamTemplate = false;
/**
 * T2.3d — serve the VERBATIM published `agent.json` bodies for Scout and
 * Reviewer instead of the hand-written ones. See {@link PUBLISHED_AGENT_BODIES}.
 */
let publishedAgentBodies = false;
/** Every URL the fixture server was asked for, in order. Deterministic — no wall clock. */
const fetchLog: string[] = [];

function installFixtureFetch() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    fetchLog.push(url);
    if (url === FIXTURE_CDN_URL) {
      if (!cdnReachable) throw new TypeError("fetch failed (simulated: CDN unreachable)");
      return new Response(JSON.stringify(FIXTURE_CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (brokenUrls.has(url)) {
      return new Response("upstream unavailable", { status: 503 });
    }
    if (stalledUrls.has(url)) {
      // Never resolves on its own. Rejects only when the caller's signal fires,
      // which is precisely the behaviour under test.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted.")),
        );
      });
    }
    if (emptyTeamTemplate && url === `${FIXTURE_HOST}/teams/default-crew/team.json`) {
      return new Response(JSON.stringify({ slug: "aoa-default-crew", agents: [] }), { status: 200 });
    }
    const body = (publishedAgentBodies ? PUBLISHED_AGENT_BODIES[url] : undefined)
      ?? FIXTURE_BODIES[url];
    if (body === undefined) {
      return new Response(`no fixture for ${url}`, { status: 404 });
    }
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

async function clearCatalogCache() {
  await db.execute(sql`DELETE FROM marketplace_catalog_cache`);
}

/** Every kind='aoa' agent for a company, with the fields T2.3 is about. */
async function crewRows(companyId: string) {
  return rowsOf<{
    id: string;
    name: string;
    status: string;
    adapter_type: string;
    adapter_config: Record<string, unknown> | null;
    template_origin: string | null;
    template_version: string | null;
    skill_keys: string[];
  }>(
    await db.execute(sql`
      SELECT id, name, status, adapter_type, adapter_config,
             template_origin, template_version, skill_keys
      FROM agents
      WHERE company_id = ${companyId} AND kind = 'aoa'
      ORDER BY name
    `),
  );
}

async function catalogCacheSource(): Promise<string | null> {
  const rows = rowsOf<{ source: string }>(
    await db.execute(sql`SELECT source FROM marketplace_catalog_cache WHERE id = 1`),
  );
  return rows[0]?.source ?? null;
}

beforeAll(async () => {
  try {
    materializerMock.mockImplementation(async (_bundle: unknown, options: { destination: string }) => ({
      destination: options.destination,
      markdown: BUNDLE_MARKDOWN,
      fileInventory: BUNDLE_INVENTORY,
      fileCount: BUNDLE_INVENTORY.length,
      byteCount: 128,
    }));
    dataDir = await mkdtemp(join(tmpdir(), "aoa-crew-bootstrap-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      // Force UTF-8 so migration SQL containing non-Latin1 characters applies.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    installFixtureFetch();
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[crew-marketplace-bootstrap] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterEach(() => {
  registerMarketplaceCatalogService(null);
  brokenUrls.clear();
  stalledUrls.clear();
  cdnReachable = false;
  emptyTeamTemplate = false;
  publishedAgentBodies = false;
  fetchLog.length = 0;
});

afterAll(async () => {
  registerMarketplaceCatalogService(null);
  if (realFetch) globalThis.fetch = realFetch;
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

function makeService(opts: { snapshot?: MarketplaceCatalogFile | null; snapshotDelayMs?: number } = {}) {
  return new MarketplaceCatalogService({
    db,
    cdnUrl: FIXTURE_CDN_URL,
    bundledSnapshotProvider: async () => {
      if (opts.snapshotDelayMs) await new Promise((r) => setTimeout(r, opts.snapshotDelayMs));
      return opts.snapshot ?? null;
    },
  });
}

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("company create installs the crew from the marketplace (real PostgreSQL)", () => {
  // ── The task itself ────────────────────────────────────────────────────────
  // Before T2.3 the crew came only from the legacy ensure-* seeders, which
  // write NO templateOrigin and NO templateVersion (seed-crew-agent.ts) — the
  // boot backfill later stamps them `…@legacy`. So every assertion below fails
  // against the pre-T2.3 create path: template_origin was NULL, there was no
  // teams row, and no install operation existed.
  it("a newly created company gets a marketplace-managed crew, not @legacy", async () => {
    assertSetupOk();
    await clearCatalogCache();

    // R9: this is the one test where the CDN genuinely ANSWERS — every other
    // path here is CDN-unreachable, so without it the happy path was untested.
    cdnReachable = true;
    const service = makeService({ snapshot: null });
    await service.sync();
    registerMarketplaceCatalogService(service);
    expect(await catalogCacheSource()).toBe("cdn");

    const company = await companyService(db).create({ name: "Marketplace Crew Co" } as never);
    const crew = await crewRows(company.id);

    const marketplaceCrew = crew.filter((row) => row.template_origin?.startsWith("agent:aoa-curated/"));
    expect(marketplaceCrew.map((r) => r.name).sort()).toEqual(["Reviewer", "Scout", "Steward"]);

    for (const row of marketplaceCrew) {
      // The single root cause Phase 2 fixes: `@legacy` origins are skipped by
      // crew-updater.ts forever.
      expect(row.template_origin).not.toMatch(/@legacy$/);
      expect(row.template_version).toBe("1.0.0");
      expect(row.skill_keys).toEqual([SKILL_ID]);
    }

    // The legacy seeders must NOT also have run — a duplicate legacy Scout
    // alongside the marketplace Scout is the failure mode of "install AND seed".
    expect(crew.some((r) => r.name === "Adjutant")).toBe(false);
    expect(crew.filter((r) => r.name === "Scout")).toHaveLength(1);

    // The company-wide team row (D21 — no parent department at create time).
    const teams = rowsOf<{ parent_project_id: string | null; template_origin: string | null }>(
      await db.execute(sql`
        SELECT parent_project_id, template_origin FROM teams WHERE company_id = ${company.id}
      `),
    );
    expect(teams).toHaveLength(1);
    expect(teams[0].parent_project_id).toBeNull();
    expect(teams[0].template_origin).toBe(TEAM_ID);

    // Went through the orchestrator, so T2.7/T2.8 have an operation to build on.
    const ops = rowsOf<{ status: string; idempotency_key: string; target_department_id: string | null }>(
      await db.execute(sql`
        SELECT status, idempotency_key, target_department_id
        FROM marketplace_install_operations WHERE company_id = ${company.id}
      `),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("success");
    expect(ops[0].idempotency_key).toBe(`bootstrap-crew:${company.id}`);
    expect(ops[0].target_department_id).toBeNull();

    // F9 — the load-bearing `kind` separation that makes bundle import (R8)
    // safe: the crew is kind='aoa' and every import/export agent path is
    // kind='org' (agentService.list() defaults to org), so the imported roster
    // and the crew can never see each other. Asserted here against a real DB
    // rather than in the mocked portability suite, which cannot reach it.
    const orgAgents = await agentService(db).list(company.id);
    expect(orgAgents.map((a) => a.name)).not.toContain("Scout");
    expect(orgAgents.map((a) => a.name)).not.toContain("Reviewer");
    expect(orgAgents).toHaveLength(0);

    // Commander remains application infrastructure; Steward now comes from the
    // protected marketplace crew relationship asserted above.
    expect(crew.some((r) => r.name === "Commander")).toBe(true);
    expect(crew.find((r) => r.name === "Steward")?.template_origin).toBe(STEWARD_ID);
  }, 120_000);

  it("a stale catalog without Steward degrades before dispatch and still seeds a legacy Steward", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const staleCatalog = structuredClone(FIXTURE_CATALOG);
    staleCatalog.items = staleCatalog.items.filter((item) => item.id !== STEWARD_ID);
    const teamItem = staleCatalog.items.find((item) => item.id === TEAM_ID)!;
    teamItem.requires = (teamItem.requires ?? []).filter((requirement) => requirement.id !== STEWARD_ID);
    staleCatalog.itemCount = staleCatalog.items.length;

    const service = makeService({ snapshot: staleCatalog });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const company = await companyService(db).create({ name: "Stale Crew Catalog Co" } as never);
    const crew = await crewRows(company.id);
    const steward = crew.find((row) => row.name === "Steward");

    expect(steward).toBeDefined();
    expect(steward?.template_origin).toBeNull();
    expect(crew.some((row) => row.name === "Adjutant")).toBe(true);
    expect(crew.some((row) => row.template_origin?.startsWith("agent:aoa-curated/"))).toBe(false);

    const operations = rowsOf<{ n: string }>(
      await db.execute(sql`
        SELECT count(*)::text AS n
        FROM marketplace_install_operations
        WHERE company_id = ${company.id}
      `),
    );
    expect(Number(operations[0].n)).toBe(0);
  }, 120_000);

  // ── T2.3d: the same create path, against the REAL published bodies ────────
  //
  // The phase's exit criterion, and the case no test covered: a bootstrap over
  // agent templates that are byte-for-byte what the catalog publishes must
  // produce a marketplace-managed crew rather than degrading to `@legacy`.
  //
  // It failed for every live company before this fix — the published triggers
  // carry `enabled`, the `.strict()` trigger schema rejected it, pre-flight
  // threw `unrecognized_keys: ["enabled"]`, `installTeam` aborted, and
  // `provisionCompanyCrew` fell through to the legacy seeders. The hand-written
  // fixture in the test above could not see it because it omitted `enabled`.
  //
  // Still fixture-served, not live network: only the agent BODIES are real. The
  // catalog index, the team.json roster (2 of the 9 published agents) and the
  // skill bundles remain fixtures, so this proves the contract, not the CDN.
  it("T2.3d: the published agent bodies install — `enabled` and all", async () => {
    assertSetupOk();
    await clearCatalogCache();

    publishedAgentBodies = true;
    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const company = await companyService(db).create({ name: "Published Bodies Co" } as never);

    const crew = await crewRows(company.id);
    const marketplaceCrew = crew.filter((r) => r.template_origin?.startsWith("agent:aoa-curated/"));
    expect(marketplaceCrew.map((r) => r.name).sort()).toEqual(["Reviewer", "Scout", "Steward"]);
    for (const row of marketplaceCrew) {
      expect(row.template_origin).not.toMatch(/@legacy$/);
    }
    // The legacy roster is the failure state this whole phase exists to remove.
    expect(crew.some((r) => r.name === "Adjutant")).toBe(false);

    // The published skillKeys, which the hand-written fixture replaced with a
    // single synthetic id — proof the bodies really are the published ones.
    const scout = marketplaceCrew.find((r) => r.name === "Scout");
    expect(scout?.skill_keys).toEqual([
      "skill:github-skills/garrytan/gstack/investigate",
      "skill:github-skills/obra/superpowers/brainstorming",
      "skill:github-skills/obra/superpowers/systematic-debugging",
    ]);

    // And the trigger rows the published bodies declare, with the `enabled`
    // value that used to be dropped on the floor.
    const triggers = rowsOf<{ name: string; kind: string; enabled: boolean; config: unknown }>(
      await db.execute(sql`
        SELECT a.name, t.kind, t.enabled, t.config
        FROM aoa_agent_triggers t
        JOIN agents a ON a.id = t.agent_id
        WHERE t.company_id = ${company.id}
          AND a.template_origin LIKE 'agent:aoa-curated/%'
        ORDER BY a.name
      `),
    );
    expect(triggers).toEqual([
      { name: "Reviewer", kind: "mention", enabled: true, config: { role: "reviewer" } },
      { name: "Scout", kind: "mention", enabled: true, config: { role: "scout" } },
      { name: "Steward", kind: "mention", enabled: true, config: { role: "steward" } },
    ]);

    // ── T2.3e: marketplace-managed AND dispatchable ─────────────────────────
    //
    // The phase's real exit criterion, and the conjunction nothing proved
    // before. Every assertion above passed while the installed crew was
    // `status='paused'` on `adapter_type='process'` — an install that succeeds
    // into a state where no execution path will ever select the agent and the
    // adapter would throw "Process adapter missing command" if one did.

    // F2 — the company's OWN resolved crew adapter, computed by the same
    // function the legacy seeder uses (`seed-crew-agent.ts:93`), against this
    // company's real `internal_agent_config` row. Not a literal: a provider
    // default change must move both sides together or neither.
    const expectedAdapter = await resolveCrewAdapterForCompany(db, company.id);
    expect(expectedAdapter.adapterType).not.toBe("process");
    for (const row of marketplaceCrew) {
      expect(row.adapter_type, row.name).toBe(expectedAdapter.adapterType);
      expect(row.adapter_config, row.name).toMatchObject(expectedAdapter.adapterConfig);
    }

    // F1 — selected by the REAL production selection function
    // (`listEnabledOutboxAgents`, whose filter is `triggers.ts:74`) running its
    // real query against real PostgreSQL. The outbox trigger rows are test
    // setup: the published crew declare `mention`/`sweep` triggers, and what is
    // under test is the AGENT ROW's status, not which trigger kind it carries.
    const scoutId = marketplaceCrew.find((r) => r.name === "Scout")!.id;
    const reviewerId = marketplaceCrew.find((r) => r.name === "Reviewer")!.id;
    for (const agentId of [scoutId, reviewerId]) {
      await db.execute(sql`
        INSERT INTO aoa_agent_triggers (company_id, agent_id, kind, enabled, config)
        VALUES (${company.id}, ${agentId}, 'outbox', true, '{}'::jsonb)
      `);
    }
    // The discriminator: a crew row that IS genuinely paused, carrying an
    // identical enabled outbox trigger. If the predicate ever stops filtering,
    // the assertion above must stop passing for free.
    const pausedControl = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO agents (company_id, name, kind, role, status, adapter_type)
        VALUES (${company.id}, 'Paused Control', 'aoa', 'general', 'paused', 'claude_local')
        RETURNING id
      `),
    )[0].id;
    await db.execute(sql`
      INSERT INTO aoa_agent_triggers (company_id, agent_id, kind, enabled, config)
      VALUES (${company.id}, ${pausedControl}, 'outbox', true, '{}'::jsonb)
    `);

    const dispatchable = await listEnabledOutboxAgents(db, company.id);
    expect(dispatchable).toContain(scoutId);
    expect(dispatchable).toContain(reviewerId);
    expect(dispatchable).not.toContain(pausedControl);
  }, 120_000);

  // ── T2.3c: the team's skills go through the REAL installer ────────────────
  // `installTeam` phase 3 used to hand-roll its own `company_skills` insert:
  // `trustLevel: "markdown_only"`, `fileInventory: []`, no `catalogProvider`, no
  // `catalogSkillBundle`/`catalogBundleInstallPath`, and the markdown taken from
  // the CDN body instead of the bundle's own SKILL.md. Every company created by
  // T2.3 therefore got bundle-less skill rows — and because that insert stamped
  // `sourceRef` to the current version, `installSkill`'s idempotency guard
  // answered `alreadyInstalled: true` for the key from then on, so the bundle
  // was never materialized for that company. All 17 skills the live crew team
  // requires carry a bundle (verified against the published catalog).
  //
  // FIELD PARITY against rows the real `installSkill` wrote is the assertion a
  // re-implementation cannot pass; T2.3b used the same approach for the repair
  // path, and this is the create path it left behind.
  it("writes skill rows identical to the real installer, bundle and all", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const company = await companyService(db).create({ name: "Skill Parity Co" } as never);

    // The reference: a company whose rows the real installer wrote directly.
    const referenceId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${referenceId}, 'Skill Reference Co', ${nextIssuePrefix()})
    `);
    for (const item of FIXTURE_CATALOG.items.filter((i) => i.type === "skill")) {
      await installSkill({ catalogItem: item as CatalogItem, companyId: referenceId, db });
    }

    // `installedAt` is a wall-clock stamp and is excluded on both sides; the
    // bundle install path is company-scoped, so the two install paths are
    // compared on a per-company-substituted basis below rather than raw.
    const shape = async (companyId: string) =>
      rowsOf<Record<string, unknown>>(
        await db.execute(sql`
          SELECT key, slug, name, description, markdown, source_type, source_locator,
                 source_ref, trust_level, compatibility, file_inventory,
                 (metadata - 'installedAt' - 'catalogBundleInstallPath') AS metadata
          FROM company_skills WHERE company_id = ${companyId} ORDER BY key
        `),
      );

    const installed = await shape(company.id);
    expect(installed).toEqual(await shape(referenceId));
    expect(installed).toHaveLength(2);

    // The specifics the hand-rolled insert could not produce, stated outright so
    // the parity assertion cannot pass by both sides being wrong together.
    const bundled = installed.find((r) => r.key === BUNDLE_SKILL_ID)!;
    expect(bundled.file_inventory).toEqual(BUNDLE_INVENTORY);
    // DERIVED from the inventory (a script is present), not the hardcoded default.
    expect(bundled.trust_level).toBe("scripts_executables");
    expect(bundled.markdown).toBe(BUNDLE_MARKDOWN);
    const bundledMeta = bundled.metadata as Record<string, unknown>;
    expect((bundledMeta.catalogSkillBundle as Record<string, unknown>).path).toBe(
      "skills/bundle-skill",
    );
    expect(bundledMeta.catalogProvider).toMatchObject({ id: "fixture" });

    // The install path IS written, and it is this company's own directory —
    // excluded from the parity SELECT above precisely because it must differ.
    const paths = rowsOf<{ install_path: string | null }>(
      await db.execute(sql`
        SELECT metadata ->> 'catalogBundleInstallPath' AS install_path
        FROM company_skills WHERE company_id = ${company.id} AND key = ${BUNDLE_SKILL_ID}
      `),
    );
    expect(paths[0].install_path).toContain(company.id);

    // The other half of the defect: the idempotency guard now short-circuits on
    // a row that genuinely carries the bundle, instead of sealing in a stub.
    const probe = await installSkill({
      catalogItem: FIXTURE_CATALOG.items.find((i) => i.id === BUNDLE_SKILL_ID) as CatalogItem,
      companyId: company.id,
      db,
    });
    expect(probe.alreadyInstalled).toBe(true);
  }, 120_000);

  // ── Hazard 3: offline bootstrap, snapshot INJECTED not read from disk ──────
  it("offline (CDN unreachable): the bundled snapshot supplies the same roster", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    // Proves the catalog really came from the snapshot fallback, not a CDN hit.
    expect(await catalogCacheSource()).toBe("bundled");

    const company = await companyService(db).create({ name: "Offline Crew Co" } as never);
    const crew = await crewRows(company.id);

    expect(
      crew.filter((r) => r.template_origin?.startsWith("agent:aoa-curated/")).map((r) => r.name).sort(),
    ).toEqual(["Reviewer", "Scout", "Steward"]);
  }, 120_000);

  // ── Hazard 4: the cold-cache race ─────────────────────────────────────────
  // The bundled snapshot only reaches the cache INSIDE syncCatalog's catch,
  // and the boot sync is fire-and-forget (`void this.sync()`), so a company
  // created in the first seconds after boot could find loadCachedCatalog still
  // null and be provisioned `@legacy` — non-deterministically, and invisibly
  // afterwards. Company create must not depend on winning that race.
  it("cold cache + a sync still in flight still produces the marketplace roster", async () => {
    assertSetupOk();
    await clearCatalogCache();

    // Snapshot resolution is deliberately slow so the sync is provably still
    // running when create() is called.
    const service = makeService({ snapshot: FIXTURE_CATALOG, snapshotDelayMs: 300 });
    registerMarketplaceCatalogService(service);
    service.startSyncLoop(); // fire-and-forget, exactly like boot
    try {
      // The discriminator: at this instant a cache-only reader sees NOTHING.
      // A create path that merely read the cache would degrade to @legacy here.
      expect(await loadCachedCatalog(db)).toBeNull();

      const company = await companyService(db).create({ name: "Cold Cache Co" } as never);
      const crew = await crewRows(company.id);

      expect(
        crew.filter((r) => r.template_origin?.startsWith("agent:aoa-curated/")).map((r) => r.name).sort(),
      ).toEqual(["Reviewer", "Scout", "Steward"]);
      expect(await catalogCacheSource()).toBe("bundled");
    } finally {
      service.stopSyncLoop();
    }
  }, 120_000);

  // ── The degrade path ──────────────────────────────────────────────────────
  it("install failure never blocks create — the company still gets a legacy crew", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);
    // Break the team template fetch mid-install: catalog resolves, dispatch
    // starts, phase 1 fails.
    brokenUrls.add(`${FIXTURE_HOST}/teams/default-crew/team.json`);

    const company = await companyService(db).create({ name: "Degraded Crew Co" } as never);
    expect(company.id).toBeTruthy();

    const crew = await crewRows(company.id);
    // Legacy roster present…
    expect(crew.some((r) => r.name === "Scout")).toBe(true);
    expect(crew.some((r) => r.name === "Adjutant")).toBe(true);
    expect(crew.some((r) => r.name === "Steward")).toBe(true);
    // …and it is legacy: the seeders write no templateOrigin at all.
    expect(crew.find((r) => r.name === "Scout")!.template_origin).toBeNull();
    // No marketplace rows exist: the break is at team-installer phase 1c (the
    // team.json fetch), before ANY write — so this asserts "failed before it
    // started", NOT phase-3 transactional rollback. Post-commit failure is a
    // different animal and is covered by its own test below.
    expect(crew.some((r) => r.template_origin?.startsWith("agent:aoa-curated/"))).toBe(false);
    // …and the legacy roster genuinely lacks Reviewer — the gap the degrade log
    // has to name, because nothing in the data reveals it.
    expect(crew.some((r) => r.name === "Reviewer")).toBe(false);

    const ops = rowsOf<{ status: string; error_message: string | null }>(
      await db.execute(sql`
        SELECT status, error_message FROM marketplace_install_operations WHERE company_id = ${company.id}
      `),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failure");
    expect(ops[0].error_message).toMatch(/503/);
  }, 120_000);

  // ── R1: a SUCCESSFUL install whose success FAILS TO RECORD ────────────────
  // `dispatchInstall` commits the team-body transaction, writes `success`, then
  // publishes `marketplace.install.completed`. `publishLiveEvent` is a bare
  // synchronous `EventEmitter.emit` with no guard, so a throwing subscriber
  // propagates INTO dispatchInstall's catch, which overwrites the terminal
  // patch with `failure`. The bootstrap then reports `failed` over a crew that
  // is committed on disk.
  //
  // Seeding on top of it is silent and permanent: `seedCrewAgent` hits
  // ON CONFLICT DO NOTHING on the name-overlapping roles, takes the `!inserted`
  // branch, and overwrites the MARKETPLACE rows' runtimeConfig.aoa.toolAllowlist
  // (and possibly the adapter) while leaving templateOrigin and
  // templateVersion intact — so `crew-updater` sees managed rows at the current
  // catalog version and never repairs them, and no duplicate row is minted to
  // reveal it.
  //
  // This test breaks AFTER the phase-3 commit, which the degrade test above
  // (phase 1c) cannot reach.
  it("a post-commit failure must NOT let the legacy seeders clobber the installed crew", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    // A bare company row — no crew — so provisionCompanyCrew runs on a clean
    // slate exactly as it does inside create().
    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Post Commit Co', ${nextIssuePrefix()})
    `);

    const outcome = await provisionCompanyCrew(db, companyId, {
      publishLiveEvent: (event) => {
        if (event.type === "marketplace.install.completed") {
          throw new Error("live-event subscriber threw after the install committed");
        }
      },
    });

    // The install DID commit.
    const crew = await crewRows(companyId);
    const marketplaceCrew = crew.filter((r) => r.template_origin?.startsWith("agent:aoa-curated/"));
    expect(marketplaceCrew.map((r) => r.name).sort()).toEqual(["Reviewer", "Scout", "Steward"]);

    // …and the legacy seeders did NOT run over it. The DAMAGE is asserted first
    // and the outcome mode last, deliberately: a mode string is a proxy, the
    // clobbered row is the bug.
    //
    // (a) the clobber itself — seedCrewAgent's !inserted branch writes the
    //     legacy tool allowlist onto the marketplace row it collided with.
    const scoutRuntime = rowsOf<{ allowlist: string | null }>(
      await db.execute(sql`
        SELECT runtime_config -> 'aoa' ->> 'toolAllowlist' AS allowlist
        FROM agents WHERE company_id = ${companyId} AND name = 'Scout'
      `),
    );
    expect(scoutRuntime).toHaveLength(1);
    expect(scoutRuntime[0].allowlist).toBeNull();
    // (b) the non-colliding legacy roles were never inserted alongside.
    expect(crew.some((r) => r.name === "Adjutant")).toBe(false);
    expect(crew.some((r) => r.name === "Librarian")).toBe(false);
    // (c) the marketplace rows keep the origin/version that make them
    //     updateable — the property the clobber leaves intact and therefore
    //     the reason the damage is unrepairable.
    for (const row of marketplaceCrew) {
      expect(row.template_version).toBe("1.0.0");
    }
    expect(outcome.mode).toBe("marketplace-clobber-averted");
  }, 120_000);

  // ── F1: the R1 state must not become a DUPLICATE roster on repair ─────
  // The R1 guard protects the LEGACY-seeder path. It does not protect the
  // marketplace RE-INSTALL path, which consumes the same lying row: a second
  // provisionCompanyCrew (i.e. T2.3b repair) hits the idempotency key, claims
  // the `failure` row, and re-runs installTeam over a company that already has
  // the roster — minting Scout-2 / Reviewer-2 / default-crew-2, all carrying
  // the SAME templateOrigin, which also breaks the single-row team lookups in
  // resolver.ts and team-reconcile.ts.
  //
  // Repairing the row to `success` (not claimable) is what closes it.
  it("a repair pass after an averted clobber does not re-install or mint duplicates", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Repair Co', ${nextIssuePrefix()})
    `);

    // Land in the R1 state: install commits, bookkeeping fails.
    const first = await provisionCompanyCrew(db, companyId, {
      publishLiveEvent: (event) => {
        if (event.type === "marketplace.install.completed") {
          throw new Error("live-event subscriber threw after the install committed");
        }
      },
    });
    expect(first.mode).toBe("marketplace-clobber-averted");

    // Now the repair pass that T2.3b will run. The DAMAGE is asserted first and
    // the audit-row state after, deliberately: the duplicate roster is the bug,
    // the row status is only the mechanism.
    const second = await provisionCompanyCrew(db, companyId, {});

    const crew = await crewRows(companyId);
    expect(crew.some((r) => /-2$/.test(r.name))).toBe(false);
    expect(crew.filter((r) => r.name === "Scout")).toHaveLength(1);
    expect(crew.filter((r) => r.name === "Reviewer")).toHaveLength(1);
    // Exactly one team row: two rows sharing a templateOrigin break the
    // single-row lookups downstream.
    const teamRows = rowsOf<{ n: string }>(
      await db.execute(sql`
        SELECT count(*)::text AS n FROM teams
        WHERE company_id = ${companyId} AND template_origin = ${TEAM_ID}
      `),
    );
    expect(teamRows[0].n).toBe("1");

    // …and the mechanism that achieves it: the audit row no longer lies, and
    // (load-bearing) is no longer CLAIMABLE.
    const repaired = rowsOf<{ status: string; error_message: string | null }>(
      await db.execute(sql`
        SELECT status, error_message
        FROM marketplace_install_operations WHERE company_id = ${companyId}
      `),
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0].status).toBe("success");
    expect(repaired[0].error_message).toBeNull();
    expect(second.mode).toBe("marketplace-already-dispatched");
  }, 120_000);

  // ── F2: a crash between claim and terminal patch must not strand forever ──
  // The owner dies mid-install: the row sits `running`. After 24h the
  // idempotency lookup misses, the INSERT trips the unbounded unique index,
  // onConflictDoNothing suppresses it, and the fallback SELECT (no createdAt
  // cutoff) hands back the SAME stale row — so without a staleness bound the
  // caller reports "already dispatched", skips the legacy seeders too, and the
  // company has NO crew and no repair path, ever.
  it("a stale `running` operation is reclaimable, so a crashed install is repairable", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Stranded Co', ${nextIssuePrefix()})
    `);
    // Exactly what a killed process leaves behind: claimed, never finished.
    await db.execute(sql`
      INSERT INTO marketplace_install_operations
        (company_id, catalog_item_id, item_type, status, idempotency_key, started_at, created_at)
      VALUES (${companyId}, ${TEAM_ID}, 'team', 'running', ${`bootstrap-crew:${companyId}`},
              now() - interval '30 minutes', now() - interval '30 minutes')
    `);

    const outcome = await provisionCompanyCrew(db, companyId, {});

    // The HARM first: without the staleness bound this company ends up with no
    // marketplace crew AND no legacy crew — the already-dispatched short-circuit
    // returns before the seeders, forever.
    const crew = await crewRows(companyId);
    expect(
      crew.filter((r) => r.template_origin?.startsWith("agent:aoa-curated/")).map((r) => r.name).sort(),
    ).toEqual(["Reviewer", "Scout", "Steward"]);
    expect(outcome.mode).toBe("marketplace");

    // Reclaimed in place — still one row, now terminal and error-free.
    const ops = rowsOf<{ status: string; error_message: string | null }>(
      await db.execute(sql`
        SELECT status, error_message
        FROM marketplace_install_operations WHERE company_id = ${companyId}
      `),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("success");
    expect(ops[0].error_message).toBeNull();
  }, 120_000);

  // Discriminator for the staleness bound: it must not steal a LIVE install.
  it("a fresh `running` operation is NOT stolen", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Live Install Co', ${nextIssuePrefix()})
    `);
    await db.execute(sql`
      INSERT INTO marketplace_install_operations
        (company_id, catalog_item_id, item_type, status, idempotency_key, started_at)
      VALUES (${companyId}, ${TEAM_ID}, 'team', 'running', ${`bootstrap-crew:${companyId}`}, now())
    `);

    const outcome = await provisionCompanyCrew(db, companyId, {});

    expect(outcome.mode).toBe("marketplace-already-dispatched");
    const crew = await crewRows(companyId);
    expect(crew.some((r) => r.template_origin?.startsWith("agent:aoa-curated/"))).toBe(false);
  }, 120_000);

  // ── F4: an empty team must not become a permanent false witness ───────
  // team.json is an unchecked JSON.parse cast. `"agents": []` would commit a
  // teams row with zero members, so the witness reads true forever: no crew
  // agents, legacy seeders permanently suppressed, repair short-circuited.
  it("a team.json declaring no agents is refused, and the company still gets a crew", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);
    emptyTeamTemplate = true;

    const company = await companyService(db).create({ name: "Empty Team Co" } as never);

    const teamRows = rowsOf<{ n: string }>(
      await db.execute(sql`SELECT count(*)::text AS n FROM teams WHERE company_id = ${company.id}`),
    );
    expect(teamRows[0].n).toBe("0");

    const crew = await crewRows(company.id);
    expect(crew.some((r) => r.name === "Adjutant")).toBe(true);
  }, 120_000);

  // ── R2: the install is bounded ────────────────────────────────────────────
  // 27 sequential fetches at FETCH_TIMEOUT_MS each is ~13.5 minutes inside an
  // interactive POST. The aggregate deadline aborts in-flight requests rather
  // than merely abandoning their results — which matters, because an install
  // that landed after we degraded would be exactly the R1 clobber again.
  it("an install that outruns its deadline is aborted, not left running", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);
    stalledUrls.add(`${FIXTURE_HOST}/teams/default-crew/team.json`);

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Deadline Co', ${nextIssuePrefix()})
    `);

    const startedAt = Date.now();
    const outcome = await provisionCompanyCrew(db, companyId, { installDeadlineMs: 250 });
    const elapsed = Date.now() - startedAt;

    expect(outcome.mode).toBe("legacy");
    // Bounded by the deadline, NOT by the 30s per-request FETCH_TIMEOUT_MS.
    // The margin is deliberately huge (250ms budget vs a 30s request) so this
    // is not a wall-clock coin flip on a loaded runner.
    expect(elapsed).toBeLessThan(15_000);

    // The company still got a crew, and nothing marketplace-shaped committed.
    const crew = await crewRows(companyId);
    expect(crew.some((r) => r.name === "Adjutant")).toBe(true);
    expect(crew.some((r) => r.template_origin?.startsWith("agent:aoa-curated/"))).toBe(false);
  }, 120_000);

  // ── Idempotency ───────────────────────────────────────────────────────────
  // `bootstrap-crew:<companyId>` makes startInstallOperation return the
  // EXISTING operation, so a retried or concurrent create cannot double-install.
  // Without it the team installer would run again and resolveAgentNameConflict
  // would mint "Scout 2" / "Reviewer 2".
  it("a repeated bootstrap for the same company cannot double-install the crew", async () => {
    assertSetupOk();
    await clearCatalogCache();

    const service = makeService({ snapshot: FIXTURE_CATALOG });
    await service.sync();
    registerMarketplaceCatalogService(service);

    const company = await companyService(db).create({ name: "Idempotent Crew Co" } as never);
    const before = await crewRows(company.id);

    // Call the provisioner directly — company create's own pre-gate would
    // short-circuit, and the guarantee under test is the idempotency KEY.
    const outcome = await provisionCompanyCrew(db, company.id, {});
    expect(outcome.mode).toBe("marketplace-already-dispatched");

    const after = await crewRows(company.id);
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name));
    expect(after.some((r) => /\b2$/.test(r.name))).toBe(false);

    const ops = rowsOf<{ n: string }>(
      await db.execute(sql`
        SELECT count(*)::text AS n FROM marketplace_install_operations WHERE company_id = ${company.id}
      `),
    );
    expect(ops[0].n).toBe("1");

    const teams = rowsOf<{ n: string }>(
      await db.execute(sql`SELECT count(*)::text AS n FROM teams WHERE company_id = ${company.id}`),
    );
    expect(teams[0].n).toBe("1");
  }, 120_000);

  // ── The seam that keeps every OTHER test off the network ──────────────────
  // With no service registered and a cold cache, create must degrade
  // immediately rather than reaching for the CDN.
  it("no registered catalog service + cold cache → immediate legacy degrade", async () => {
    assertSetupOk();
    await clearCatalogCache();
    registerMarketplaceCatalogService(null);

    const company = await companyService(db).create({ name: "No Service Co" } as never);

    const crew = await crewRows(company.id);
    expect(crew.some((r) => r.name === "Adjutant")).toBe(true);
    expect(crew.every((r) => r.template_origin === null)).toBe(true);
    // No operation row: it never even tried.
    const ops = rowsOf<{ n: string }>(
      await db.execute(sql`
        SELECT count(*)::text AS n FROM marketplace_install_operations WHERE company_id = ${company.id}
      `),
    );
    expect(ops[0].n).toBe("0");
    // No catalog wait was incurred — asserted by "the CDN was never contacted"
    // rather than by a wall clock, which on a loaded runner is a coin flip.
    expect(fetchLog).toEqual([]);
  }, 120_000);
});

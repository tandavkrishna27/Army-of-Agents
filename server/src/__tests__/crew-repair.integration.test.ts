/**
 * T2.3b — crew provisioning is REPAIRABLE after a degraded bootstrap.
 *
 * T2.3 made a company *born* updateable, but only at one instant: any degrade
 * during company create stamps the crew `…@legacy`, and `crew-updater.ts` skips
 * those rows forever. This suite proves the degraded states are recoverable,
 * that the obvious recovery (re-run `provisionCompanyCrew`) is the WRONG one for
 * the state that matters most, and that repair never destroys founder content.
 *
 * ── What is real here, deliberately ─────────────────────────────────────────
 * - Real PostgreSQL. Every assertion is about rows.
 * - The **real** `agentInstructionsService` against a temp `AOA_HOME`, so the
 *   founder-edited instruction files repair must not touch are observable on
 *   disk. A stubbed instructions service would stub out the only thing the
 *   rejected design destroyed, making the property untestable.
 * - The **real** `checkCrewUpdates`, so "the company is un-frozen" is proven by
 *   the pipeline itself rather than by a mode string.
 * - The **real** `reconcileTeamMembers`, so the duplicate-minting path is
 *   exercised end to end.
 *
 * `globalThis.fetch` is a fixture server; the gitignored
 * `ui/src/aoa-marketplace-snapshot.json` is never read (it is injected).
 *
 * Assertions are ordered DAMAGE FIRST throughout: a `result.action` string is a
 * proxy, the row/file is the thing.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import type { CatalogItem, MarketplaceCatalogFile } from "@armyofagents/shared";
import {
  MarketplaceCatalogService,
  registerMarketplaceCatalogService,
} from "../services/aoa-marketplace.js";
import { companyService } from "../services/companies.js";
import { provisionCompanyCrew } from "../services/crew-provisioning.js";
import {
  ADOPTED_TEMPLATE_VERSION,
  CREW_REPAIR_COOLDOWN_MS,
  CREW_REPAIR_FORCE_FLOOR_MS,
  diagnoseCrewProvisioning,
  repairCompanyCrew,
  resetCrewRepairCooldowns,
  runCrewRepairPass,
  setCrewRepairClock,
} from "../services/crew-repair.js";
import { checkCrewUpdates } from "../services/marketplace-install/crew-updater.js";
import { reconcileTeamMembers } from "../services/marketplace-install/team-reconcile.js";
import {
  runLegacyStewardReconcilePass,
  STEWARD_RECONCILE_ACTIVITY_ACTION,
  STEWARD_CATALOG_ITEM_ID,
  STEWARD_RECONCILE_ENV,
} from "../services/marketplace-install/legacy-steward-reconcile.js";
import {
  ensureCrewAgents,
  ensureInfrastructureAgents,
  isCrewMarketplaceManaged,
} from "../services/internal-agent/aoa-agents/crew-seeding.js";
import { backfillCrewTemplateOrigin } from "../services/internal-agent/aoa-agents/backfill-template-origin.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { listEnabledOutboxAgents } from "../services/internal-agent/aoa-agents/triggers.js";
import { resolveCrewAdapterForCompany } from "../services/internal-agent/aoa-agents/resolve-crew-adapter.js";
import { installSkill } from "../services/marketplace-install/skill-installer.js";
import { createMarketplaceAgent } from "../services/marketplace-install/agent-create.js";
import { installTeam } from "../services/marketplace-install/team-installer.js";
import { uninstallTeam } from "../services/marketplace-install/team-uninstaller.js";
import type { NormalizedMarketplaceAgentTemplate } from "../services/marketplace-install/types.js";
import { createMarketplaceCompanyRouter } from "../routes/marketplace-company.js";
import { errorHandler } from "../middleware/error-handler.js";

vi.mock("../services/outbound-url-guard.js", () => ({
  validateAndResolveFetchUrl: vi.fn(async (url: string) => ({
    parsedUrl: new URL(url),
    resolvedAddress: "93.184.216.34",
    hostHeader: new URL(url).host,
    tlsServername: new URL(url).hostname,
    useTls: true,
  })),
  executePinnedRequest: vi.fn(
    async (
      target: { parsedUrl: URL },
      init: RequestInit | undefined,
      signal: AbortSignal,
    ) => {
      const response = await fetch(target.parsedUrl, { ...init, signal });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    },
  ),
}));

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
let homeDir = "";
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

const PORT = 58500 + Math.floor(Math.random() * 400);

const FIXTURE_CDN_URL = "https://cdn.repairfixture.invalid/catalog.json";
const FIXTURE_HOST =
  `https://raw.githubusercontent.com/MeteoriteLabs/aoa-marketplace/${"f".repeat(40)}`;

const TEAM_ID = "team:aoa-curated/default-crew";
const SCOUT_ID = "agent:aoa-curated/aoa-scout";
const ADJUTANT_ID = "agent:aoa-curated/aoa-adjutant";
const REVIEWER_ID = "agent:aoa-curated/aoa-reviewer";
const STEWARD_ID = STEWARD_CATALOG_ITEM_ID;
const INLINE_SKILL_ID = "skill:aoa-curated/fixture-inline-skill";
const FETCHED_SKILL_ID = "skill:aoa-curated/fixture-fetched-skill";
const SLOW_INLINE_SKILL_URL = `${FIXTURE_HOST}/skills/fixture-inline-skill/SKILL.md`;

let seedCounter = 0;
function nextIssuePrefix(): string {
  seedCounter += 1;
  return `RP${seedCounter}`;
}

function rowsOf<T>(result: unknown): T[] {
  const asObj = result as { rows?: T[] };
  return asObj?.rows ?? (result as T[]);
}

// ── Fixture catalog ──────────────────────────────────────────────────────────
// The current roster carries the three repair fixtures plus protected Steward.
// Two non-Steward members (Scout, Adjutant) have legacy rows in a degraded
// company, while Reviewer has none. Two legacy-matched members is the minimum
// that can express a PARTIAL adoption — the state that mints a permanent
// duplicate — so a one-member fixture cannot see that bug at all.

function catalogItemBase(id: string, type: string, name: string, version = "1.0.0") {
  return {
    id,
    type,
    name,
    description: `${name} fixture`,
    version,
    source: {
      adapter: "aoa-curated",
      url: "https://github.com/MeteoriteLabs/aoa-marketplace",
      locator: `content/${id}`,
    },
    trust: { tier: "verified", source: "aoa-curated" },
    status: "active",
    addedAt: "2026-07-24T00:00:00.000Z",
    category: "workflows",
    tags: ["official"],
  };
}

function buildCatalog(version = "1.0.0"): MarketplaceCatalogFile {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-24T00:00:00.000Z",
    itemCount: 7,
    items: [
      {
        ...catalogItemBase(TEAM_ID, "team", "AoA Default Crew", version),
        resourceUrl: `${FIXTURE_HOST}/teams/default-crew/team.json`,
        requires: [
          { type: "agent", id: SCOUT_ID },
          { type: "agent", id: ADJUTANT_ID },
          { type: "agent", id: REVIEWER_ID },
          { type: "agent", id: STEWARD_ID },
          { type: "skill", id: INLINE_SKILL_ID },
          { type: "skill", id: FETCHED_SKILL_ID },
        ],
      },
      {
        ...catalogItemBase(SCOUT_ID, "agent", "Scout", version),
        resourceUrl: `${FIXTURE_HOST}/agents/aoa-scout/agent.json`,
      },
      {
        ...catalogItemBase(ADJUTANT_ID, "agent", "Adjutant", version),
        resourceUrl: `${FIXTURE_HOST}/agents/aoa-adjutant/agent.json`,
      },
      {
        ...catalogItemBase(REVIEWER_ID, "agent", "Reviewer", version),
        resourceUrl: `${FIXTURE_HOST}/agents/aoa-reviewer/agent.json`,
      },
      {
        ...catalogItemBase(STEWARD_ID, "agent", "Steward", version),
        resourceUrl: `${FIXTURE_HOST}/agents/aoa-steward/agent.json`,
      },
      {
        ...catalogItemBase(INLINE_SKILL_ID, "skill", "Fixture Inline Skill", version),
        content: { inline: "---\nname: fixture-inline-skill\n---\n\nInline body.\n" },
      },
      {
        // No inline content — the body must be FETCHED, exercising the path the
        // 17 real crew skills take (`content.inline === null` for all of them).
        ...catalogItemBase(FETCHED_SKILL_ID, "skill", "Fixture Fetched Skill", version),
        resourceUrl: `${FIXTURE_HOST}/skills/fixture-fetched-skill/SKILL.md`,
      },
    ],
  } as unknown as MarketplaceCatalogFile;
}

const FIXTURE_CATALOG = buildCatalog();
const CATALOG_ITEMS = FIXTURE_CATALOG.items as CatalogItem[];

function buildCatalogWithSteward(version = "1.0.0"): MarketplaceCatalogFile {
  return buildCatalog(version);
}

const STEWARD_CATALOG_ITEMS = buildCatalogWithSteward().items as CatalogItem[];
const STEWARD_CATALOG_ITEM = STEWARD_CATALOG_ITEMS.find((item) => item.id === STEWARD_ID)!;

const STEWARD_INSTALL_TEMPLATE: NormalizedMarketplaceAgentTemplate = {
  name: "Steward",
  role: "general",
  kind: "aoa",
  triggers: [{ kind: "sweep", enabled: true, config: {} }],
  status: "idle",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  permissions: {},
  budgetMonthlyCents: 0,
  skillKeys: [],
  instructions: {
    type: "inline",
    files: { "AGENTS.md": "You are Steward, from the catalog." },
    entryFile: "AGENTS.md",
  },
  setupRequirements: [],
  setupRequired: false,
  metadata: {},
  warnings: [],
};

function agentTemplate(
  id: string,
  name: string,
  triggerRole: string,
  triggerKind: "mention" | "sweep" = "mention",
) {
  return JSON.stringify({
    schemaVersion: "agent.v1",
    id,
    name,
    description: `${name} fixture agent`,
    instructions: { type: "inline", content: `You are ${name}, from the catalog.` },
    aoa: {
      kind: "aoa",
      adapterType: "claude_local",
      skillKeys: [INLINE_SKILL_ID, FETCHED_SKILL_ID],
      install: { defaultStatus: "active", defaultRole: "general" },
      // `enabled` is part of the published contract — every crew agent in
      // `aoa-curated` declares it. Omitting it here is what let T2.3d ship a
      // schema that rejected every real body (see
      // `marketplace-trigger-enabled.test.ts`, which uses verbatim published
      // bodies rather than hand-written ones).
      triggers: [{
        kind: triggerKind,
        enabled: true,
        config: triggerKind === "mention" ? { role: triggerRole } : {},
      }],
    },
  });
}

const TEAM_TEMPLATE = JSON.stringify({
  slug: "aoa-default-crew",
  description: "Fixture crew",
  manifest: { installOrder: [SCOUT_ID, ADJUTANT_ID, REVIEWER_ID, STEWARD_ID] },
  agents: [
    { templateOrigin: SCOUT_ID, name: "Scout" },
    { templateOrigin: ADJUTANT_ID, name: "Adjutant" },
    { templateOrigin: REVIEWER_ID, name: "Reviewer" },
    { templateOrigin: STEWARD_ID, name: "Steward" },
  ],
});

const TEAM_TEMPLATE_WITH_STEWARD = JSON.stringify({
  slug: "aoa-default-crew",
  description: "Fixture crew with Steward",
  manifest: { installOrder: [SCOUT_ID, ADJUTANT_ID, REVIEWER_ID, STEWARD_ID] },
  agents: [
    { templateOrigin: SCOUT_ID, name: "Scout" },
    { templateOrigin: ADJUTANT_ID, name: "Adjutant" },
    { templateOrigin: REVIEWER_ID, name: "Reviewer" },
    { templateOrigin: STEWARD_ID, name: "Steward" },
  ],
});

const FIXTURE_BODIES: Record<string, string> = {
  [`${FIXTURE_HOST}/teams/default-crew/team.json`]: TEAM_TEMPLATE,
  [`${FIXTURE_HOST}/agents/aoa-scout/agent.json`]: agentTemplate("aoa-scout", "Scout", "scout"),
  [`${FIXTURE_HOST}/agents/aoa-adjutant/agent.json`]: agentTemplate("aoa-adjutant", "Adjutant", "adjutant"),
  [`${FIXTURE_HOST}/agents/aoa-reviewer/agent.json`]: agentTemplate("aoa-reviewer", "Reviewer", "reviewer"),
  [`${FIXTURE_HOST}/agents/aoa-steward/agent.json`]: agentTemplate(
    "aoa-steward",
    "Steward",
    "steward",
    "sweep",
  ),
  [SLOW_INLINE_SKILL_URL]: "---\nname: fixture-inline-skill\n---\n\nInline body.\n",
  [`${FIXTURE_HOST}/skills/fixture-fetched-skill/SKILL.md`]:
    "---\nname: fixture-fetched-skill\n---\n\nFetched body.\n",
};

let realFetch: typeof globalThis.fetch;
let cdnReachable = false;
const brokenUrls = new Set<string>();
const delayedUrls = new Set<string>();
let fixtureFetchCallCount = 0;

function installFixtureFetch() {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fixtureFetchCallCount += 1;
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    if (url === FIXTURE_CDN_URL) {
      if (!cdnReachable) throw new TypeError("fetch failed (simulated: CDN unreachable)");
      return new Response(JSON.stringify(FIXTURE_CATALOG), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (delayedUrls.has(url)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (brokenUrls.has(url)) return new Response("upstream unavailable", { status: 503 });
    const body = FIXTURE_BODIES[url];
    if (body === undefined) return new Response(`no fixture for ${url}`, { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

async function clearCatalogCache() {
  await db.execute(sql`DELETE FROM marketplace_catalog_cache`);
}

function makeService(snapshot: MarketplaceCatalogFile | null = FIXTURE_CATALOG) {
  return new MarketplaceCatalogService({
    db,
    cdnUrl: FIXTURE_CDN_URL,
    bundledSnapshotProvider: async () => snapshot,
  });
}

/** Register a working catalog (via the bundled-snapshot fallback — no network). */
async function withCatalog(snapshot: MarketplaceCatalogFile = FIXTURE_CATALOG): Promise<void> {
  await clearCatalogCache();
  const service = makeService(snapshot);
  await service.sync();
  registerMarketplaceCatalogService(service);
}

interface CrewRow {
  id: string;
  name: string;
  status: string;
  template_origin: string | null;
  template_version: string | null;
  skill_keys: string[];
  runtime_config: Record<string, unknown> | null;
  adapter_config: Record<string, unknown> | null;
  adapter_type: string;
  title: string | null;
  role: string | null;
  instructions_customized: boolean | null;
}

async function crewRows(companyId: string): Promise<CrewRow[]> {
  return rowsOf<CrewRow>(
    await db.execute(sql`
      SELECT id, name, status, template_origin, template_version, skill_keys,
             runtime_config, adapter_config, adapter_type, title, role,
             instructions_customized
      FROM agents WHERE company_id = ${companyId} AND kind = 'aoa' ORDER BY name
    `),
  );
}

async function teamRowCount(companyId: string): Promise<number> {
  const rows = rowsOf<{ n: string }>(
    await db.execute(sql`
      SELECT count(*)::text AS n FROM teams
      WHERE company_id = ${companyId} AND template_origin = ${TEAM_ID}
    `),
  );
  return Number(rows[0].n);
}

async function operationRow(companyId: string) {
  return rowsOf<{ status: string; error_message: string | null; result_entity_id: string | null }>(
    await db.execute(sql`
      SELECT status, error_message, result_entity_id
      FROM marketplace_install_operations WHERE company_id = ${companyId}
    `),
  );
}

async function installedSkillKeys(companyId: string): Promise<string[]> {
  return rowsOf<{ key: string }>(
    await db.execute(
      sql`SELECT key FROM company_skills WHERE company_id = ${companyId} ORDER BY key`,
    ),
  ).map((r) => r.key);
}

async function triggerKinds(agentId: string): Promise<string[]> {
  return rowsOf<{ kind: string }>(
    await db.execute(
      sql`SELECT kind FROM aoa_agent_triggers WHERE agent_id = ${agentId} ORDER BY kind`,
    ),
  ).map((r) => r.kind);
}

async function teamMemberNames(companyId: string): Promise<string[]> {
  return rowsOf<{ name: string }>(
    await db.execute(sql`
      SELECT a.name FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      JOIN agents a ON a.id = tm.agent_id
      WHERE t.company_id = ${companyId} AND t.template_origin = ${TEAM_ID}
      ORDER BY a.name
    `),
  ).map((r) => r.name);
}

async function teamMemberLinkCount(companyId: string, agentId: string): Promise<number> {
  const rows = rowsOf<{ n: string }>(
    await db.execute(sql`
      SELECT count(*)::text AS n
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE t.company_id = ${companyId}
        AND t.template_origin = ${TEAM_ID}
        AND tm.agent_id = ${agentId}
    `),
  );
  return Number(rows[0].n);
}

/**
 * Recreate the pre-Phase-4A state after provisioning through today's valid
 * marketplace contract. Historical NULL-origin Steward rows can no longer be
 * produced through company creation now that the default crew owns Steward.
 */
async function createHistoricalNullOriginStewardCompany(name: string) {
  await withCatalog();
  const company = await companyService(db).create({ name } as never);
  const steward = (await crewRows(company.id)).find((row) => row.name === "Steward")!;

  await db.execute(sql`
    DELETE FROM team_members
    WHERE agent_id = ${steward.id}
      AND team_id IN (
        SELECT id FROM teams
        WHERE company_id = ${company.id}
          AND template_origin = ${TEAM_ID}
      )
  `);
  await db.execute(sql`
    UPDATE agents
    SET template_origin = NULL,
        template_version = NULL,
        instructions_customized = NULL
    WHERE id = ${steward.id}
  `);

  const historicalSteward = (await crewRows(company.id)).find(
    (row) => row.id === steward.id,
  )!;
  return { company, steward: historicalSteward };
}

async function crewRepairNotificationCount(companyId: string): Promise<number> {
  const rows = rowsOf<{ n: string }>(
    await db.execute(sql`
      SELECT count(*)::text AS n FROM notifications
      WHERE company_id = ${companyId} AND source_id LIKE ${`crew_repaired:${companyId}%`}
    `),
  );
  return Number(rows[0].n);
}

const NOTIFY_SETTINGS = {
  agentUpdatePolicy: "notify",
  updateWindow: "anytime",
} as unknown as Parameters<typeof checkCrewUpdates>[0]["settings"];

const AUTO_SETTINGS = {
  agentUpdatePolicy: "auto",
  updateWindow: "anytime",
} as unknown as Parameters<typeof checkCrewUpdates>[0]["settings"];

async function pendingUpdateItemIds(companyId: string): Promise<string[]> {
  return rowsOf<{ catalog_item_id: string }>(
    await db.execute(sql`
      SELECT catalog_item_id FROM marketplace_pending_updates WHERE company_id = ${companyId}
    `),
  ).map((r) => r.catalog_item_id);
}

/**
 * Does the real update pipeline WALK this company? The load-bearing question —
 * "repaired" means nothing if `crew-updater` still skips the rows.
 */
async function updatePipelineSeesCompany(companyId: string): Promise<boolean> {
  await db.execute(sql`DELETE FROM marketplace_pending_updates WHERE company_id = ${companyId}`);
  await checkCrewUpdates({
    db,
    companyId,
    catalogItems: buildCatalog("2.0.0").items as CatalogItem[],
    settings: NOTIFY_SETTINGS,
    instructionsService: agentInstructionsService(),
  });
  return (await pendingUpdateItemIds(companyId)).includes(SCOUT_ID);
}

/** A company whose crew came from the legacy seeders, stamped `…@legacy`. */
async function createLegacyCompany(name: string): Promise<string> {
  await clearCatalogCache();
  registerMarketplaceCatalogService(null);
  const company = await companyService(db).create({ name } as never);
  // Boot backfill: this is what turns NULL origins into `…@legacy` in the wild.
  await backfillCrewTemplateOrigin(db);
  return company.id;
}

const FOUNDER_EDIT_FILE = "FOUNDER-NOTES.md";
const FOUNDER_EDIT_BODY = "# My hand-written playbook\n\nDo not delete me.\n";

/**
 * Give an agent a real managed instruction bundle with a founder-authored file
 * in it, exactly as `routes/agents.ts`'s instructions editor would leave it.
 *
 * @returns the absolute path of the founder's file.
 */
async function seedFounderInstructionBundle(agent: CrewRow, companyId: string): Promise<string> {
  const svc = agentInstructionsService();
  const { adapterConfig } = await svc.materializeManagedBundle(
    {
      id: agent.id,
      companyId,
      name: agent.name,
      role: agent.role ?? "general",
      adapterType: agent.adapter_type,
      adapterConfig: agent.adapter_config,
    },
    { "AGENTS.md": "Legacy seeded instructions.\n" },
    { entryFile: "AGENTS.md", replaceExisting: true },
  );
  await db.execute(sql`
    UPDATE agents SET adapter_config = ${JSON.stringify(adapterConfig)}::jsonb WHERE id = ${agent.id}
  `);
  const root = join(
    homeDir, "instances", "default", "companies", companyId, "agents", agent.id, "instructions",
  );
  const filePath = join(root, FOUNDER_EDIT_FILE);
  await writeFile(filePath, FOUNDER_EDIT_BODY, "utf8");
  return filePath;
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// ── Route harness ────────────────────────────────────────────────────────────

type TestActor = Record<string, unknown>;
let currentActor: TestActor = {};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: TestActor }).actor = currentActor;
    next();
  });
  app.use(
    "/api/companies/:companyId/marketplace",
    createMarketplaceCompanyRouter({
      db,
      catalogService: { readCache: async () => (cdnReachable ? FIXTURE_CATALOG : null) },
    }),
  );
  app.use(errorHandler);
  return app;
}

function boardActor(userId: string, companyId: string): TestActor {
  return {
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

async function seedUserRole(companyId: string, userId: string, role: string) {
  // user_roles.user_id FKs to the auth "user" table, so the principal has to
  // exist before the grant does.
  await db.execute(sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES (${userId}, ${role}, ${`${userId}@example.test`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO user_roles (company_id, user_id, role) VALUES (${companyId}, ${userId}, ${role})
  `);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-crew-repair-integ-"));
    homeDir = await mkdtemp(join(tmpdir(), "aoa-crew-repair-home-"));
    // The real instructions service writes here; every bundle assertion below
    // depends on this being an isolated directory, not the developer's ~/.aoa.
    process.env.AOA_HOME = homeDir;
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
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
    console.error("[crew-repair] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterEach(() => {
  registerMarketplaceCatalogService(null);
  resetCrewRepairCooldowns();
  brokenUrls.clear();
  delayedUrls.clear();
  cdnReachable = false;
  fixtureFetchCallCount = 0;
  delete process.env[STEWARD_RECONCILE_ENV];
  currentActor = {};
});

afterAll(async () => {
  registerMarketplaceCatalogService(null);
  if (realFetch) globalThis.fetch = realFetch;
  delete process.env.AOA_HOME;
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  for (const dir of [dataDir, homeDir]) {
    try {
      if (dir) await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}, 60_000);

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("crew provisioning repair (real PostgreSQL)", () => {
  // ── The task itself ────────────────────────────────────────────────────────
  it("adopts a `@legacy` crew pointer-only, un-freezing it without touching content", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Legacy Crew Co");

    const before = await crewRows(companyId);
    const scoutBefore = before.find((r) => r.name === "Scout")!;
    const adjutantBefore = before.find((r) => r.name === "Adjutant")!;
    expect(scoutBefore.template_origin).toBe("aoa-curated/standard-crew/scout@legacy");
    // THE discriminator, "before" half: the real update pipeline does not walk
    // this company at all. A route returning 200 would not prove this.
    expect(await updatePipelineSeesCompany(companyId)).toBe(false);
    expect(await installedSkillKeys(companyId)).toEqual([]);

    // Real founder artefacts, on disk and in the row, that repair must preserve.
    const founderFile = await seedFounderInstructionBundle(scoutBefore, companyId);
    expect(await readIfPresent(founderFile)).toBe(FOUNDER_EDIT_BODY);
    const scoutTriggersBefore = await triggerKinds(scoutBefore.id);
    const scoutRowBefore = (await crewRows(companyId)).find((r) => r.name === "Scout")!;

    await withCatalog();
    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    // ── DAMAGE FIRST. `result.action` is asserted last, on purpose. ─────────
    const after = await crewRows(companyId);
    const scoutAfter = after.find((r) => r.name === "Scout")!;
    const adjutantAfter = after.find((r) => r.name === "Adjutant")!;

    // 1. The founder's instruction file is untouched, byte for byte. The
    //    rejected design (`applyCrewAgentUpdate`) begins with
    //    `fs.rm(root, { recursive: true })` and would have deleted it.
    expect(await readIfPresent(founderFile)).toBe(FOUNDER_EDIT_BODY);

    // 2. Pointer only: exactly two columns moved, nothing else.
    expect(scoutAfter.template_origin).toBe(SCOUT_ID);
    expect(scoutAfter.template_version).toBe(ADOPTED_TEMPLATE_VERSION);
    expect(adjutantAfter.template_origin).toBe(ADJUTANT_ID);
    expect(scoutAfter.id).toBe(scoutBefore.id); // in place — tasks/runs still resolve
    expect(adjutantAfter.id).toBe(adjutantBefore.id);
    expect({ ...scoutAfter, template_origin: null, template_version: null }).toEqual({
      ...scoutRowBefore,
      template_origin: null,
      template_version: null,
    });
    // …including the artefacts a catalog update WOULD have replaced.
    expect(scoutAfter.skill_keys).toEqual(scoutRowBefore.skill_keys);
    expect(scoutAfter.runtime_config).toEqual(scoutRowBefore.runtime_config);
    expect(scoutAfter.adapter_config).toEqual(scoutRowBefore.adapter_config);
    expect(await triggerKinds(scoutAfter.id)).toEqual(scoutTriggersBefore);

    // 3. The declared skills now have rows behind them, so `use_skill` can load
    //    them (and the Reviewer that reconcile installs next inherits them).
    expect(await installedSkillKeys(companyId)).toEqual(
      [FETCHED_SKILL_ID, INLINE_SKILL_ID].sort(),
    );

    // 4. No duplicate roster, and roles the catalog does not name stay legacy.
    expect(after.some((r) => /-\d$/.test(r.name))).toBe(false);
    expect(after.filter((r) => r.name === "Scout")).toHaveLength(1);
    expect(after.find((r) => r.name === "Librarian")!.template_origin).toMatch(/@legacy$/);

    // 5. The team row + membership an install would have written — what
    //    reconcileTeamMembers needs to add Reviewer later.
    expect(await teamRowCount(companyId)).toBe(1);
    expect(await teamMemberNames(companyId)).toEqual(["Adjutant", "Scout", "Steward"]);
    expect((await operationRow(companyId))[0].status).toBe("success");

    // 6. Founder-visible.
    expect(await crewRepairNotificationCount(companyId)).toBeGreaterThan(0);

    // 7. THE discriminator, "after" half: the pipeline now walks this company.
    expect(await updatePipelineSeesCompany(companyId)).toBe(true);

    // Only now the mode.
    expect(result.action).toBe("adopted");
    if (result.action !== "adopted") throw new Error("unreachable");
    expect([...result.adoptedItemIds].sort()).toEqual(
      [ADJUTANT_ID, SCOUT_ID, STEWARD_ID].sort(),
    );
    expect(result.unmatchedItemIds).toEqual([REVIEWER_ID]);
  }, 240_000);

  // ── The content change is the POLICY's decision, not repair's ─────────────
  it("leaves the follow-up content change to agentUpdatePolicy", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Policy Co");
    const scout = (await crewRows(companyId)).find((r) => r.name === "Scout")!;
    const founderFile = await seedFounderInstructionBundle(scout, companyId);

    await withCatalog();
    await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    // notify (the DEFAULT): the founder is told, and nothing is overwritten.
    await checkCrewUpdates({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      settings: NOTIFY_SETTINGS,
      instructionsService: agentInstructionsService(),
    });
    expect(await readIfPresent(founderFile)).toBe(FOUNDER_EDIT_BODY);
    expect(await pendingUpdateItemIds(companyId)).toContain(SCOUT_ID);
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_version).toBe(
      ADOPTED_TEMPLATE_VERSION,
    );

    // D22 (Decision #114): `auto` is NOT enough on its own any more. An adopted
    // row carries `instructions_customized IS NULL` — repair cannot know whether
    // the legacy bundle it adopted was edited — and unknown fails closed. This
    // assertion was inverted before D22 (it expected the founder's file to be
    // gone); that was the reversed design, and it is exactly the harm D22
    // exists to prevent.
    await checkCrewUpdates({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      settings: AUTO_SETTINGS,
      instructionsService: agentInstructionsService(),
    });
    expect(await readIfPresent(founderFile)).toBe(FOUNDER_EDIT_BODY);
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_version).toBe(
      ADOPTED_TEMPLATE_VERSION,
    );

    // THE DISCRIMINATOR. Same company, same catalog, same `auto` settings — the
    // ONLY change is that the row is now provably untouched. It applies, which
    // proves both refusals above are the D22 gate deciding, not the pipeline
    // being structurally unable to update an adopted row.
    await db.execute(sql`
      UPDATE agents SET instructions_customized = false WHERE id = ${scout.id}
    `);
    await checkCrewUpdates({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      settings: AUTO_SETTINGS,
      instructionsService: agentInstructionsService(),
    });
    expect(await readIfPresent(founderFile)).toBeNull();
    const scoutAfter = (await crewRows(companyId)).find((r) => r.name === "Scout")!;
    expect(scoutAfter.template_version).toBe("1.0.0");
    expect(scoutAfter.skill_keys).toEqual([INLINE_SKILL_ID, FETCHED_SKILL_ID]);
  }, 240_000);

  // ── All-or-nothing adoption ───────────────────────────────────────────────
  // A partial adoption plus a team row is the worst state available: reconcile
  // cannot tell "no local counterpart" from "adoption failed here", installs a
  // renamed duplicate, and the original row becomes unreachable forever.
  it("writes NOTHING when a name-matched roster member cannot be adopted", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Partial Adopt Co");
    await withCatalog();
    const before = await crewRows(companyId);

    // Adjutant has a legacy row AND a roster entry, but no usable catalog item.
    const brokenCatalog = CATALOG_ITEMS.filter((item) => item.id !== ADJUTANT_ID);
    const result = await repairCompanyCrew(db, companyId, { catalogItems: brokenCatalog });

    // Not "Scout adopted, Adjutant left behind" — nothing at all.
    expect(await crewRows(companyId)).toEqual(before);
    expect(await teamRowCount(companyId)).toBe(0);
    expect(await installedSkillKeys(companyId)).toEqual([]);
    expect(await operationRow(companyId)).toHaveLength(0);
    expect(result).toMatchObject({ action: "skipped", reason: "unadoptable-roster-member" });
  }, 240_000);

  it("writes NOTHING when a required skill cannot be installed", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Skill Fetch Co");
    await withCatalog();
    brokenUrls.add(`${FIXTURE_HOST}/skills/fixture-fetched-skill/SKILL.md`);
    // Make the successful sibling finish after the failed fetch. The repair
    // helper must drain started workers before returning; otherwise this row
    // appears nondeterministically after the assertions (and after cache cleanup).
    delayedUrls.add(SLOW_INLINE_SKILL_URL);
    const failureCatalog = buildCatalog();
    const inlineSkill = failureCatalog.items.find((item) => item.id === INLINE_SKILL_ID)!;
    delete inlineSkill.content;
    inlineSkill.resourceUrl = SLOW_INLINE_SKILL_URL;
    const before = await crewRows(companyId);

    let clock = Date.now();
    setCrewRepairClock(() => clock);
    const result = await repairCompanyCrew(db, companyId, {
      catalogItems: failureCatalog.items as CatalogItem[],
    });

    // The CREW is untouched — no adoption, no team row, nothing that could read
    // as a healthy install. A crew that advertises skill keys with no rows
    // behind them answers "Skill not found for this company" on every use_skill.
    expect(await crewRows(companyId)).toEqual(before);
    expect(await teamRowCount(companyId)).toBe(0);
    expect(await operationRow(companyId)).toHaveLength(0);
    // Skill rows that DID install are deliberately left behind: they are
    // additive, version-scoped, and `installSkill` answers `alreadyInstalled` on
    // the retry, so the next attempt re-uses them instead of re-cloning. Being
    // outside the transaction is what keeps 17 git clones out of it.
    expect(await installedSkillKeys(companyId)).toEqual([INLINE_SKILL_ID]);
    expect(result).toMatchObject({ action: "skipped", reason: "skill-install-failed" });

    // …and it is still repairable once the CDN comes back.
    brokenUrls.clear();
    clock += CREW_REPAIR_FORCE_FLOOR_MS + 1;
    const second = await repairCompanyCrew(db, companyId, {
      catalogItems: CATALOG_ITEMS,
      force: true,
    });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(second.action).toBe("adopted");
  }, 240_000);

  // ── T2.3e: adoption and a fresh install must land in the SAME state ───────
  //
  // Adoption is pointer-only, so an adopted row keeps the `idle` status and the
  // resolved CLI adapter `seedCrewAgent` gave it; T2.3e makes the marketplace
  // install path produce exactly those values too. If the two ever diverge, a
  // repaired company and a freshly created one are silently different products,
  // and only one of them runs. Proved inside ONE company: Reviewer has no
  // legacy seeder, so `reconcileTeamMembers` installs it through the real
  // marketplace path right beside the adopted legacy rows.
  it("a repaired crew and a freshly installed one converge on the same runnable state", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Convergence Co");
    await withCatalog();

    const repaired = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });
    expect(repaired.action).toBe("adopted");
    await reconcileTeamMembers({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      instructionsService: agentInstructionsService(),
    });

    const after = await crewRows(companyId);
    const adopted = after.find((r) => r.name === "Scout")!; // legacy row, adopted
    const installed = after.find((r) => r.name === "Reviewer")!; // fresh install
    expect(installed.template_origin).toBe(REVIEWER_ID);

    // The company's own resolved crew adapter — not a literal, so a provider
    // default change has to move every side together or none.
    const expected = await resolveCrewAdapterForCompany(db, companyId);
    expect(expected.adapterType).not.toBe("process");

    for (const row of [adopted, installed]) {
      expect(row.status, row.name).toBe("idle");
      expect(row.adapter_type, row.name).toBe(expected.adapterType);
      expect(row.adapter_config, row.name).toMatchObject(expected.adapterConfig);
    }
    expect(installed.status).toBe(adopted.status);
    expect(installed.adapter_type).toBe(adopted.adapter_type);

    // And both are actually selected by the real production predicate
    // (`triggers.ts:74`), with a genuinely paused control that must not be.
    const pausedControl = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO agents (company_id, name, kind, role, status, adapter_type)
        VALUES (${companyId}, 'Paused Control', 'aoa', 'general', 'paused', 'claude_local')
        RETURNING id
      `),
    )[0].id;
    for (const agentId of [adopted.id, installed.id, pausedControl]) {
      await db.execute(sql`
        INSERT INTO aoa_agent_triggers (company_id, agent_id, kind, enabled, config)
        VALUES (${companyId}, ${agentId}, 'outbox', true, '{}'::jsonb)
      `);
    }
    const dispatchable = await listEnabledOutboxAgents(db, companyId);
    expect(dispatchable).toContain(adopted.id);
    expect(dispatchable).toContain(installed.id);
    expect(dispatchable).not.toContain(pausedControl);
  }, 240_000);

  // ── The other side of the same hazard ─────────────────────────────────────
  // Mechanism-independent. Fails against team-reconcile.ts as it stood: `missing`
  // is computed from member origins alone, which cannot see an unmanaged row of
  // the same name.
  it("reconcileTeamMembers refuses to install over an unmanaged same-named agent", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Reconcile Guard Co");
    await withCatalog();

    // Adopt only Scout, by hand, and link only Scout — i.e. exactly the partial
    // state a half-finished adoption would leave. Adjutant stays `…@legacy`.
    const scout = (await crewRows(companyId)).find((r) => r.name === "Scout")!;
    await db.execute(sql`
      UPDATE agents SET template_origin = ${SCOUT_ID}, template_version = ${ADOPTED_TEMPLATE_VERSION}
      WHERE id = ${scout.id}
    `);
    const teamId = randomUUID();
    await db.execute(sql`
      INSERT INTO teams (id, company_id, name, slug, template_origin, template_version)
      VALUES (${teamId}, ${companyId}, 'AoA Default Crew', 'aoa-default-crew', ${TEAM_ID}, '1.0.0')
    `);
    await db.execute(sql`
      INSERT INTO team_members (team_id, agent_id, role) VALUES (${teamId}, ${scout.id}, 'lead')
    `);

    const reconciled = await reconcileTeamMembers({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      instructionsService: agentInstructionsService(),
    });

    const after = await crewRows(companyId);
    // No `Adjutant-2` beside the legacy Adjutant — which, if minted, would make
    // the ORIGINAL Adjutant permanently unadoptable (the next repair sees the
    // origin already present and skips it).
    expect(after.filter((r) => r.name.startsWith("Adjutant"))).toHaveLength(1);
    expect(after.find((r) => r.name === "Adjutant")!.template_origin).toMatch(/@legacy$/);
    // Reviewer has no local row at all, so it IS installed — the discriminator
    // that proves the guard is targeted, not a blanket "never install".
    expect(after.some((r) => r.name === "Reviewer")).toBe(true);
    expect(reconciled.membersAdded).toBe(1);
  }, 240_000);

  // Phase 4A/4B boundary: direct marketplace creation and legacy adoption.
  it("keeps new-company marketplace provisioning atomic when the crew publishes Steward", async () => {
    assertSetupOk();
    const teamUrl = `${FIXTURE_HOST}/teams/default-crew/team.json`;
    const originalTeamTemplate = FIXTURE_BODIES[teamUrl];
    FIXTURE_BODIES[teamUrl] = TEAM_TEMPLATE_WITH_STEWARD;
    try {
      await withCatalog(buildCatalogWithSteward());
      const company = await companyService(db).create({
        name: "Steward Marketplace Bootstrap Co",
      } as never);

      const stewardRows = (await crewRows(company.id)).filter((row) => row.name === "Steward");
      expect(stewardRows).toHaveLength(1);
      expect(stewardRows[0].template_origin).toBe(STEWARD_ID);
      expect(stewardRows[0].template_version).toBe("1.0.0");
      expect(stewardRows[0].instructions_customized).toBe(false);
      expect(await triggerKinds(stewardRows[0].id)).toEqual(["sweep"]);
      expect(await teamMemberLinkCount(company.id, stewardRows[0].id)).toBe(1);

      const installedTeams = rowsOf<{ n: string }>(
        await db.execute(sql`
          SELECT count(*)::text AS n
          FROM teams
          WHERE company_id = ${company.id}
            AND template_origin = ${TEAM_ID}
        `),
      );
      expect(Number(installedTeams[0].n)).toBe(1);

      const teamId = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT id
          FROM teams
          WHERE company_id = ${company.id}
            AND template_origin = ${TEAM_ID}
        `),
      )[0].id;
      const uninstalled = await uninstallTeam({ db, companyId: company.id, teamId });
      expect(uninstalled.retainedAgents.map((agent) => agent.id)).toContain(stewardRows[0].id);

      const reinstallCatalog = buildCatalogWithSteward();
      const reinstallTeamItem = reinstallCatalog.items.find((item) => item.id === TEAM_ID)!;
      const reinstalled = await installTeam({
        catalogItem: reinstallTeamItem,
        catalog: reinstallCatalog,
        companyId: company.id,
        targetDepartmentId: null,
        db,
        installPlugin: async () => {
          throw new Error("default crew fixture must not install plugins");
        },
      });
      expect(reinstalled.teamId).toBeDefined();
      const afterReinstall = (await crewRows(company.id)).filter((row) => row.name === "Steward");
      expect(afterReinstall).toHaveLength(1);
      expect(afterReinstall[0].id).toBe(stewardRows[0].id);
      expect(afterReinstall[0].template_origin).toBe(STEWARD_ID);
      expect(await teamMemberLinkCount(company.id, afterReinstall[0].id)).toBe(1);
    } finally {
      FIXTURE_BODIES[teamUrl] = originalTeamTemplate;
    }
  }, 240_000);

  it("adopts the same legacy Steward in place, links it once, and makes updates see it", async () => {
    assertSetupOk();
    const { company } = await createHistoricalNullOriginStewardCompany(
      "Steward Adoption Co",
    );
    const before = (await crewRows(company.id)).filter((row) => row.name === "Steward");
    expect(before).toHaveLength(1);
    expect(before[0].template_origin).toBeNull();
    expect(before[0].instructions_customized).toBeNull();
    expect(await triggerKinds(before[0].id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, before[0].id)).toBe(0);
    expect((await diagnoseCrewProvisioning(db, company.id)).verdict).toBe("healthy");

    const fetchesBefore = fixtureFetchCallCount;
    const raced = await Promise.all([
      runLegacyStewardReconcilePass({
        db,
        companyIds: [company.id],
        catalogItems: STEWARD_CATALOG_ITEMS,
      }),
      runLegacyStewardReconcilePass({
        db,
        companyIds: [company.id],
        catalogItems: STEWARD_CATALOG_ITEMS,
      }),
    ]);

    const after = (await crewRows(company.id)).filter((row) => row.name === "Steward");
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].template_origin).toBe(STEWARD_ID);
    expect(after[0].template_version).toBe(ADOPTED_TEMPLATE_VERSION);
    expect(after[0].instructions_customized).toBeNull();
    expect(await triggerKinds(after[0].id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after[0].id)).toBe(1);
    expect(raced.reduce((sum, result) => sum + result.adopted, 0)).toBe(1);
    expect(fixtureFetchCallCount).toBe(fetchesBefore);

    const auditRows = rowsOf<{
      actor_id: string;
      entity_id: string;
      agent_id: string;
      details: {
        teamId: string;
        memberInserted: boolean;
        previousTemplateVersion: string | null;
        templateOrigin: string;
      };
    }>(
      await db.execute(sql`
        SELECT actor_id, entity_id, agent_id, details
        FROM activity_log
        WHERE company_id = ${company.id}
          AND action = ${STEWARD_RECONCILE_ACTIVITY_ACTION}
      `),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_id: "legacy-steward-reconcile",
      entity_id: before[0].id,
      agent_id: before[0].id,
      details: {
        memberInserted: true,
        previousTemplateVersion: null,
        templateOrigin: STEWARD_ID,
      },
    });
    expect(auditRows[0].details.teamId).toBeTruthy();

    await checkCrewUpdates({
      db,
      companyId: company.id,
      catalogItems: STEWARD_CATALOG_ITEMS,
      settings: NOTIFY_SETTINGS,
      instructionsService: agentInstructionsService(),
    });
    expect(await pendingUpdateItemIds(company.id)).toContain(STEWARD_ID);
    expect(fixtureFetchCallCount).toBe(fetchesBefore);

    const secondPass = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: STEWARD_CATALOG_ITEMS,
    });
    expect(secondPass.adopted).toBe(0);
    expect((await diagnoseCrewProvisioning(db, company.id)).verdict).toBe("healthy");
    expect(fixtureFetchCallCount).toBe(fetchesBefore);

    // Phase 4B discriminator: run the real managed startup boundary after
    // planting a value the legacy Steward seeder would rewrite. Commander must
    // still refresh, while the full legacy crew half stays off.
    await db.execute(sql`
      UPDATE agents
      SET runtime_config = coalesce(runtime_config, '{}'::jsonb)
        || '{"aoa":{"toolAllowlist":["phase4b-managed-sentinel"]}}'::jsonb
      WHERE id = ${after[0].id}
    `);
    await ensureInfrastructureAgents(db, company.id);
    if (!(await isCrewMarketplaceManaged(db, company.id))) {
      await ensureCrewAgents(db, company.id);
    }
    const afterReseed = (await crewRows(company.id)).filter((row) => row.name === "Steward");
    expect(afterReseed).toHaveLength(1);
    expect(afterReseed[0].id).toBe(before[0].id);
    expect(afterReseed[0].template_origin).toBe(STEWARD_ID);
    expect(
      (afterReseed[0].runtime_config?.aoa as { toolAllowlist?: string[] } | undefined)
        ?.toolAllowlist,
    ).toEqual(["phase4b-managed-sentinel"]);
    expect(await triggerKinds(afterReseed[0].id)).toEqual(["sweep"]);
  }, 240_000);

  it("serializes adoption with direct Steward installation and refuses a duplicate", async () => {
    assertSetupOk();
    const { company } = await createHistoricalNullOriginStewardCompany(
      "Steward Install Race Co",
    );
    const before = (await crewRows(company.id)).find((row) => row.name === "Steward")!;
    const fetchesBefore = fixtureFetchCallCount;

    const [reconcileResult, installResult] = await Promise.allSettled([
      runLegacyStewardReconcilePass({
        db,
        companyIds: [company.id],
        catalogItems: STEWARD_CATALOG_ITEMS,
      }),
      createMarketplaceAgent({
        catalogItem: STEWARD_CATALOG_ITEM,
        companyId: company.id,
        db,
        desiredName: "Steward-2",
        template: STEWARD_INSTALL_TEMPLATE,
      }),
    ]);

    expect(reconcileResult.status).toBe("fulfilled");
    if (reconcileResult.status === "fulfilled") {
      expect(reconcileResult.value.adopted).toBe(1);
    }
    expect(installResult.status).toBe("rejected");
    if (installResult.status === "rejected") {
      expect(String(installResult.reason)).toContain("Steward already exists");
    }

    const after = (await crewRows(company.id)).filter((row) => row.name.startsWith("Steward"));
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].template_origin).toBe(STEWARD_ID);
    expect(await triggerKinds(after[0].id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after[0].id)).toBe(1);
    expect(fixtureFetchCallCount).toBe(fetchesBefore);
  }, 240_000);

  it("fails closed when the loaded catalog does not publish Steward in the crew", async () => {
    assertSetupOk();
    const { company } = await createHistoricalNullOriginStewardCompany(
      "Steward Catalog Miss Co",
    );
    const before = (await crewRows(company.id)).find((row) => row.name === "Steward")!;
    const fetchesBefore = fixtureFetchCallCount;

    const result = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: STEWARD_CATALOG_ITEMS.filter((item) => item.id !== STEWARD_ID),
    });

    const after = (await crewRows(company.id)).find((row) => row.name === "Steward")!;
    expect(after.id).toBe(before.id);
    expect(after.template_origin).toBeNull();
    expect(await triggerKinds(after.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after.id)).toBe(0);
    expect(result).toMatchObject({ catalogReady: false, inspected: 0, adopted: 0, failed: 0 });
    expect(fixtureFetchCallCount).toBe(fetchesBefore);
  }, 240_000);

  it("fails closed when Steward exists in the catalog but is absent from crew requirements", async () => {
    assertSetupOk();
    const { company } = await createHistoricalNullOriginStewardCompany(
      "Steward Requirement Miss Co",
    );
    const before = (await crewRows(company.id)).find((row) => row.name === "Steward")!;
    const catalogWithoutStewardRequirement = buildCatalogWithSteward().items as CatalogItem[];
    const teamItem = catalogWithoutStewardRequirement.find((item) => item.id === TEAM_ID)!;
    teamItem.requires = teamItem.requires?.filter((requirement) => requirement.id !== STEWARD_ID);
    const fetchesBefore = fixtureFetchCallCount;

    const result = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: catalogWithoutStewardRequirement,
    });

    const after = (await crewRows(company.id)).find((row) => row.id === before.id)!;
    expect(after.template_origin).toBeNull();
    expect(await triggerKinds(after.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after.id)).toBe(0);
    expect(result).toMatchObject({ catalogReady: false, inspected: 0, adopted: 0, failed: 0 });
    expect(fixtureFetchCallCount).toBe(fetchesBefore);
  }, 240_000);

  it("fails closed when either the crew team or Steward catalog item is inactive", async () => {
    assertSetupOk();
    const { company } = await createHistoricalNullOriginStewardCompany(
      "Steward Inactive Catalog Co",
    );
    const before = (await crewRows(company.id)).find((row) => row.name === "Steward")!;
    const fetchesBefore = fixtureFetchCallCount;

    const deprecatedTeamCatalog = buildCatalogWithSteward().items as CatalogItem[];
    deprecatedTeamCatalog.find((item) => item.id === TEAM_ID)!.status = "deprecated";
    const deprecatedTeamResult = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: deprecatedTeamCatalog,
    });

    const quarantinedStewardCatalog = buildCatalogWithSteward().items as CatalogItem[];
    quarantinedStewardCatalog.find((item) => item.id === STEWARD_ID)!.status = "quarantined";
    const quarantinedStewardResult = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: quarantinedStewardCatalog,
    });

    const after = (await crewRows(company.id)).find((row) => row.id === before.id)!;
    expect(after.template_origin).toBeNull();
    expect(await triggerKinds(after.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after.id)).toBe(0);
    expect(deprecatedTeamResult).toMatchObject({
      catalogReady: false,
      inspected: 0,
      adopted: 0,
      failed: 0,
    });
    expect(quarantinedStewardResult).toMatchObject({
      catalogReady: false,
      inspected: 0,
      adopted: 0,
      failed: 0,
    });
    expect(fixtureFetchCallCount).toBe(fetchesBefore);
  }, 240_000);

  it("refuses a stray default-team row when no crew agent proves marketplace management", async () => {
    assertSetupOk();
    const { company, steward } = await createHistoricalNullOriginStewardCompany(
      "Steward Partial Team Co",
    );
    await db.execute(sql`
      UPDATE agents
      SET template_origin = NULL,
          template_version = NULL
      WHERE company_id = ${company.id}
        AND kind = 'aoa'
        AND name <> 'Steward'
    `);

    const result = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: STEWARD_CATALOG_ITEMS,
    });

    const after = (await crewRows(company.id)).find((row) => row.id === steward.id)!;
    expect(after.template_origin).toBeNull();
    expect(await triggerKinds(after.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after.id)).toBe(0);
    expect(result).toMatchObject({ inspected: 1, adopted: 0, failed: 0 });
  }, 240_000);

  it("refuses adoption when any agent kind already carries Steward's published origin", async () => {
    assertSetupOk();
    const { company, steward } = await createHistoricalNullOriginStewardCompany(
      "Steward Origin Collision Co",
    );
    await db.execute(sql`
      INSERT INTO agents (
        company_id,
        name,
        kind,
        role,
        template_origin,
        template_version
      )
      VALUES (
        ${company.id},
        'Historical Steward Import',
        'org',
        'general',
        ${STEWARD_ID},
        '1.0.0'
      )
    `);

    const result = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: STEWARD_CATALOG_ITEMS,
    });

    const after = (await crewRows(company.id)).find((row) => row.id === steward.id)!;
    expect(after.template_origin).toBeNull();
    expect(await triggerKinds(after.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, after.id)).toBe(0);
    expect(result).toMatchObject({ inspected: 1, adopted: 0, failed: 0 });
  }, 240_000);

  it("the runtime switch disables only Steward reconciliation", async () => {
    assertSetupOk();
    const { company, steward } = await createHistoricalNullOriginStewardCompany(
      "Steward Switch Co",
    );
    process.env[STEWARD_RECONCILE_ENV] = "false";

    const result = await runLegacyStewardReconcilePass({
      db,
      companyIds: [company.id],
      catalogItems: STEWARD_CATALOG_ITEMS,
    });

    expect(result).toMatchObject({
      disabled: true,
      catalogReady: false,
      inspected: 0,
      adopted: 0,
      failed: 0,
    });
    expect((await crewRows(company.id)).find((row) => row.id === steward.id)!.template_origin).toBeNull();
    expect(await triggerKinds(steward.id)).toEqual(["sweep"]);
    expect(await teamMemberLinkCount(company.id, steward.id)).toBe(0);
  }, 240_000);

  // ── The ablation, kept permanently ────────────────────────────────────────
  it("ABLATION: repairing a legacy company via provisionCompanyCrew mints a duplicate roster", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Naive Repair Co");
    await withCatalog();

    const outcome = await provisionCompanyCrew(db, companyId, {});

    const after = await crewRows(companyId);
    expect(after.filter((r) => r.name.startsWith("Scout"))).toHaveLength(2);
    expect(after.some((r) => r.name === "Scout-2")).toBe(true);
    // …and the ORIGINAL Scout — the row every task points at — is still
    // `@legacy`, i.e. still excluded from crew updates. The duplicate repaired
    // nothing; it only made the company harder to reason about.
    expect(after.find((r) => r.name === "Scout")!.template_origin).toMatch(/@legacy$/);
    expect(outcome.mode).toBe("marketplace");
  }, 240_000);

  // ── Re-run safety ─────────────────────────────────────────────────────────
  it("repair is a no-op on an already-marketplace-managed company", async () => {
    assertSetupOk();
    await withCatalog();
    const company = await companyService(db).create({ name: "Managed Crew Co" } as never);
    const before = await crewRows(company.id);

    const results = [];
    for (let pass = 0; pass < 2; pass++) {
      results.push(
        await repairCompanyCrew(db, company.id, { catalogItems: CATALOG_ITEMS, force: true }),
      );
    }

    expect(await crewRows(company.id)).toEqual(before);
    expect(await teamRowCount(company.id)).toBe(1);
    expect(await operationRow(company.id)).toHaveLength(1);
    expect(results).toEqual([
      { action: "none", verdict: "healthy" },
      { action: "none", verdict: "healthy" },
    ]);
  }, 240_000);

  it("repair is a no-op when re-run on a company it just adopted", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Twice Repaired Co");
    await withCatalog();

    await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });
    const afterFirst = await crewRows(companyId);
    expect(afterFirst.find((r) => r.name === "Scout")!.template_origin).toBe(SCOUT_ID);

    const second = await repairCompanyCrew(db, companyId, {
      catalogItems: CATALOG_ITEMS,
      force: true,
    });

    // The OTHER entry point is where the harm shows: adoption must leave the
    // bootstrap operation row terminal, or the ordinary provisioning path claims
    // it (`failure`/absent are both claimable) and re-installs the whole roster.
    const outcome = await provisionCompanyCrew(db, companyId, {});
    const afterSecond = await crewRows(companyId);
    expect(afterSecond.some((r) => /-\d$/.test(r.name))).toBe(false);
    expect(afterSecond).toEqual(afterFirst);
    expect(await teamRowCount(companyId)).toBe(1);
    expect(await operationRow(companyId)).toHaveLength(1);
    expect(second).toEqual({ action: "none", verdict: "healthy" });
    expect(outcome.mode).toBe("marketplace-already-dispatched");
  }, 240_000);

  // ── The residual state the `unknown` witness leaves behind ────────────────
  it("re-provisions a company that has infrastructure agents but no crew at all", async () => {
    assertSetupOk();
    await withCatalog();

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Crewless Co', ${nextIssuePrefix()})
    `);
    await ensureInfrastructureAgents(db, companyId);
    // Production parity, and it is load-bearing: the boot backfill stamps
    // Commander `aoa-curated/standard-crew/commander@legacy` (it is in
    // CREW_NAMES). A fixture whose Commander carried a NULL origin instead
    // would hide any rule that keys off that stamp — which is exactly how the
    // earlier version of this suite missed the renamed-crew regression.
    await backfillCrewTemplateOrigin(db);
    const commander = (await crewRows(companyId)).find((r) => r.name === "Commander")!;
    expect(commander.template_origin).toBe("aoa-curated/standard-crew/commander@legacy");

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    const crew = await crewRows(companyId);
    expect(
      crew
        .filter((r) => r.template_origin?.startsWith("agent:aoa-curated/"))
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Adjutant", "Reviewer", "Scout", "Steward"]);
    expect(crew.filter((r) => r.name === "Commander")).toHaveLength(1);
    expect(crew.filter((r) => r.name === "Steward")).toHaveLength(1);
    expect(await teamRowCount(companyId)).toBe(1);
    expect(result.action).toBe("reprovisioned");
  }, 240_000);

  // ── The operation row T2.3's own repair could not fix ─────────────────────
  it("seals an install operation that still reports failure over a committed crew", async () => {
    assertSetupOk();
    await withCatalog();
    const company = await companyService(db).create({ name: "Lying Op Co" } as never);
    await db.execute(sql`
      UPDATE marketplace_install_operations
      SET status = 'failure', error_message = 'live-event subscriber threw', completed_at = NULL
      WHERE company_id = ${company.id}
    `);
    const before = await crewRows(company.id);

    const result = await repairCompanyCrew(db, company.id, { catalogItems: CATALOG_ITEMS });

    const ops = await operationRow(company.id);
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("success");
    expect(ops[0].error_message).toBeNull();
    expect(await crewRows(company.id)).toEqual(before);
    expect(await teamRowCount(company.id)).toBe(1);
    expect(result.action).toBe("operation-repaired");
  }, 240_000);

  it("does not touch a FRESH `running` operation row", async () => {
    assertSetupOk();
    await withCatalog();
    const company = await companyService(db).create({ name: "Live Op Co" } as never);
    await db.execute(sql`
      UPDATE marketplace_install_operations
      SET status = 'running', started_at = now(), completed_at = NULL WHERE company_id = ${company.id}
    `);

    const result = await repairCompanyCrew(db, company.id, {
      catalogItems: CATALOG_ITEMS,
      force: true,
    });
    expect((await operationRow(company.id))[0].status).toBe("running");
    expect((await diagnoseCrewProvisioning(db, company.id)).verdict).toBe("healthy");
    expect(result).toEqual({ action: "none", verdict: "healthy" });
  }, 240_000);

  it("seals a stale `running` operation row over an installed crew", async () => {
    assertSetupOk();
    await withCatalog();
    const company = await companyService(db).create({ name: "Dead Owner Op Co" } as never);
    await db.execute(sql`
      UPDATE marketplace_install_operations
      SET status = 'running', started_at = now() - interval '30 minutes', completed_at = NULL
      WHERE company_id = ${company.id}
    `);

    const result = await repairCompanyCrew(db, company.id, { catalogItems: CATALOG_ITEMS });
    expect((await operationRow(company.id))[0].status).toBe("success");
    expect(result.action).toBe("operation-repaired");
  }, 240_000);

  it("ABLATION: an unsealed `failure` row lets the next provisioning pass duplicate the roster", async () => {
    assertSetupOk();
    await withCatalog();
    const company = await companyService(db).create({ name: "Unsealed Op Co" } as never);
    await db.execute(sql`
      UPDATE marketplace_install_operations
      SET status = 'failure', error_message = 'bookkeeping failed', completed_at = NULL
      WHERE company_id = ${company.id}
    `);

    const outcome = await provisionCompanyCrew(db, company.id, {});

    expect((await crewRows(company.id)).some((r) => r.name === "Scout-2")).toBe(true);
    expect(await teamRowCount(company.id)).toBe(2);
    expect(outcome.mode).toBe("marketplace");
  }, 240_000);

  it("stands aside while a bootstrap install is genuinely in flight", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Racing Install Co");
    await withCatalog();
    // A bootstrap that has claimed the operation and is mid-install: its team
    // row is not committed yet, so the company still LOOKS degraded. Repairing
    // now would commit a second team row sharing one templateOrigin.
    await db.execute(sql`
      INSERT INTO marketplace_install_operations
        (company_id, catalog_item_id, item_type, status, idempotency_key, started_at)
      VALUES (${companyId}, ${TEAM_ID}, 'team', 'running', ${`bootstrap-crew:${companyId}`}, now())
    `);
    const before = await crewRows(companyId);
    let clock = Date.now();
    setCrewRepairClock(() => clock);

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    expect(await crewRows(companyId)).toEqual(before);
    expect(await teamRowCount(companyId)).toBe(0);
    expect(result).toMatchObject({ action: "skipped", reason: "install-in-flight" });

    // Discriminator: once that row is stale, the owner is presumed dead and
    // repair proceeds — the guard is about liveness, not about "any running row".
    await db.execute(sql`
      UPDATE marketplace_install_operations SET started_at = now() - interval '30 minutes'
      WHERE company_id = ${companyId}
    `);
    clock += CREW_REPAIR_FORCE_FLOOR_MS + 1;
    const second = await repairCompanyCrew(db, companyId, {
      catalogItems: CATALOG_ITEMS,
      force: true,
    });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(second.action).toBe("adopted");
  }, 240_000);

  // -- The roster's skills go through the REAL installer --------------------
  // A hand-rolled insert cannot produce a materialized bundle, a derived
  // `trustLevel`, a real `fileInventory` or the
  // `catalogSkillBundle`/`catalogBundleInstallPath` metadata — and because it
  // stamps `sourceRef` to the current version, `installSkill`'s idempotency
  // guard would answer `alreadyInstalled` for that key FOREVER, so the bundle
  // would never be materialized for that company. All 17 skills the live crew
  // team requires carry a bundle.
  //
  // Field parity against rows the real installer wrote is the check a
  // re-implementation cannot pass.
  it("writes skill rows byte-identical to the real installer, not a hand-rolled copy", async () => {
    assertSetupOk();
    const repaired = await createLegacyCompany("Skill Parity Co");
    const reference = await createLegacyCompany("Skill Reference Co");
    await withCatalog();

    await repairCompanyCrew(db, repaired, { catalogItems: CATALOG_ITEMS });
    for (const item of CATALOG_ITEMS.filter((i) => i.type === "skill")) {
      await installSkill({ catalogItem: item, companyId: reference, db });
    }

    const shape = async (companyId: string) =>
      rowsOf<Record<string, unknown>>(
        await db.execute(sql`
          SELECT key, slug, name, description, markdown, source_type, source_locator,
                 source_ref, trust_level, compatibility, file_inventory,
                 metadata - 'installedAt' AS metadata
          FROM company_skills WHERE company_id = ${companyId} ORDER BY key
        `),
      );
    const rows = await shape(repaired);
    expect(rows).toEqual(await shape(reference));
    expect(rows).toHaveLength(2);
    // Specifics the hand-rolled version got wrong: it omitted catalogProvider
    // entirely and hardcoded trust/inventory.
    expect(rows[0].metadata as Record<string, unknown>).toHaveProperty("catalogProvider");
    expect(rows.map((r) => r.source_ref)).toEqual(["1.0.0", "1.0.0"]);
  }, 240_000);

  // -- The rename hazard --------------------------------------------------
  // `PATCH /agents/:id` lets a founder rename a crew agent, and it does not
  // touch `templateOrigin`. Matching on name alone therefore mis-classifies a
  // renamed crew as "crewless" and installs a SECOND parallel crew beside rows
  // that own every task, run and assignment — permanently, because the company
  // then reads `healthy`. The boot backfill's `.../<slug>@legacy` stamp survives
  // the rename and is the join key that actually holds.
  it("adopts a fully RENAMED legacy crew via its legacy origin, not by name", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Renamed Crew Co");
    await db.execute(sql`
      UPDATE agents SET name = 'Recon ' || name
      WHERE company_id = ${companyId} AND kind = 'aoa' AND name NOT IN ('Commander', 'Steward')
    `);
    await withCatalog();

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    const after = await crewRows(companyId);
    // No parallel crew: no row named plain "Scout"/"Adjutant" was installed.
    expect(after.some((r) => r.name === "Scout" || r.name === "Adjutant")).toBe(false);
    // The founder's own rows were adopted in place, keeping their names.
    expect(after.find((r) => r.name === "Recon Scout")!.template_origin).toBe(SCOUT_ID);
    expect(after.find((r) => r.name === "Recon Adjutant")!.template_origin).toBe(ADJUTANT_ID);
    expect(await teamRowCount(companyId)).toBe(1);
    expect(await teamMemberNames(companyId)).toEqual([
      "Recon Adjutant",
      "Recon Scout",
      "Steward",
    ]);
    expect(result.action).toBe("adopted");
  }, 240_000);

  // The partial rename reaches the same end state through the same door.
  it("adopts a PARTIALLY renamed legacy crew without leaving a member behind", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Partly Renamed Co");
    await db.execute(sql`
      UPDATE agents SET name = 'Recon' WHERE company_id = ${companyId} AND name = 'Scout'
    `);
    await withCatalog();

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    const after = await crewRows(companyId);
    expect(after.find((r) => r.name === "Recon")!.template_origin).toBe(SCOUT_ID);
    expect(after.find((r) => r.name === "Adjutant")!.template_origin).toBe(ADJUTANT_ID);
    expect(after.some((r) => r.name === "Scout")).toBe(false);
    expect(result).toMatchObject({ action: "adopted", unmatchedItemIds: [REVIEWER_ID] });

    // ...and the follow-on reconcile adds ONLY the member with no local row.
    const reconciled = await reconcileTeamMembers({
      db,
      companyId,
      catalogItems: CATALOG_ITEMS,
      instructionsService: agentInstructionsService(),
    });
    const final = await crewRows(companyId);
    expect(final.some((r) => r.name === "Scout")).toBe(false);
    expect(final.some((r) => r.name === "Reviewer")).toBe(true);
    expect(reconciled.membersAdded).toBe(1);
  }, 240_000);

  // -- The refusal that guards the crewless branch -------------------------
  it("refuses to provision beside a crew row it cannot account for", async () => {
    assertSetupOk();
    await withCatalog();
    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Ambiguous Co', ${nextIssuePrefix()})
    `);
    await ensureInfrastructureAgents(db, companyId);
    await backfillCrewTemplateOrigin(db);
    // A crew row with NO origin and a non-roster name: it could be a custom
    // agent, or a roster member renamed before the backfill could stamp it.
    // Unknowable — so provisioning the roster beside it is not allowed.
    await db.execute(sql`
      INSERT INTO agents (company_id, name, kind, role, adapter_type)
      VALUES (${companyId}, 'Recon', 'aoa', 'general', 'claude_local')
    `);
    const before = await crewRows(companyId);

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    expect(await crewRows(companyId)).toEqual(before);
    expect(await teamRowCount(companyId)).toBe(0);
    expect(result).toMatchObject({ action: "skipped", reason: "unaccounted-crew-rows" });
  }, 240_000);

  // Discriminator for that refusal: a leftover row for a role the catalog does
  // NOT carry (a retired Dispatcher) is provably not a renamed roster member,
  // because the backfill stamped its slug from its name. Installing the roster
  // cannot duplicate it, so this must NOT block a legitimate crewless repair.
  it("still provisions a crewless company carrying a retired non-roster crew row", async () => {
    assertSetupOk();
    await withCatalog();
    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Retired Role Co', ${nextIssuePrefix()})
    `);
    await ensureInfrastructureAgents(db, companyId);
    await db.execute(sql`
      INSERT INTO agents (company_id, name, kind, role, adapter_type, template_origin)
      VALUES (${companyId}, 'Dispatcher', 'aoa', 'general', 'claude_local',
              'aoa-curated/standard-crew/dispatcher@legacy')
    `);
    await backfillCrewTemplateOrigin(db);

    const result = await repairCompanyCrew(db, companyId, { catalogItems: CATALOG_ITEMS });

    const after = await crewRows(companyId);
    expect(
      after
        .filter((r) => r.template_origin?.startsWith("agent:aoa-curated/"))
        .map((r) => r.name)
        .sort(),
    ).toEqual(["Adjutant", "Reviewer", "Scout", "Steward"]);
    expect(after.filter((r) => r.name === "Dispatcher")).toHaveLength(1);
    expect(result.action).toBe("reprovisioned");
  }, 240_000);

  it("skips when the catalog has no crew team item", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("No Team Item Co");
    await withCatalog();

    const result = await repairCompanyCrew(db, companyId, {
      catalogItems: CATALOG_ITEMS.filter((i) => i.id !== TEAM_ID),
    });
    expect(await teamRowCount(companyId)).toBe(0);
    expect(result).toMatchObject({ action: "skipped", reason: "team-item-not-in-catalog" });
  }, 240_000);

  // ── The boot pass ─────────────────────────────────────────────────────────
  it("repairs degraded companies, caps productive work, leaves healthy ones alone", async () => {
    assertSetupOk();
    const degradedA = await createLegacyCompany("Pass Co A");
    const degradedB = await createLegacyCompany("Pass Co B");
    await withCatalog();
    const healthy = await companyService(db).create({ name: "Pass Co Healthy" } as never);
    const healthyBefore = await crewRows(healthy.id);
    const companyIds = [degradedA, degradedB, healthy.id];

    let clock = Date.now();
    setCrewRepairClock(() => clock);

    const pass1 = await runCrewRepairPass({
      db, companyIds, catalogItems: CATALOG_ITEMS, maxPerPass: 1,
    });
    // The rows first: exactly ONE of the two degraded companies moved, and it
    // moved by adoption (no `-2` duplicate), not by a second install.
    const movedAfterPass1 = [];
    for (const id of [degradedA, degradedB]) {
      const rows = await crewRows(id);
      expect(rows.some((r) => /-\d$/.test(r.name))).toBe(false);
      if (rows.find((r) => r.name === "Scout")!.template_origin === SCOUT_ID) movedAfterPass1.push(id);
    }
    expect(movedAfterPass1).toHaveLength(1);
    // Every company is diagnosed; the cap limits only what is REPAIRED.
    expect(pass1).toMatchObject({
      inspected: 3,
      repaired: 1,
      skippedOverBudget: 1,
      skippedCooldown: 0,
      skippedFailClosed: 0,
      failed: 0,
    });
    expect(
      pass1.skips.filter((skip) => skip.category === "over_budget"),
    ).toHaveLength(pass1.skippedOverBudget);

    clock += CREW_REPAIR_COOLDOWN_MS + 1;
    const pass2 = await runCrewRepairPass({
      db, companyIds, catalogItems: CATALOG_ITEMS, maxPerPass: 1,
    });
    expect(pass2.repaired).toBe(1);

    for (const id of [degradedA, degradedB]) {
      // "healthy" is also reachable by installing a SECOND crew beside the
      // legacy one, so the verdict alone is not a discriminator — these are.
      const rows = await crewRows(id);
      expect(rows.some((r) => /-\d$/.test(r.name))).toBe(false);
      expect(rows.find((r) => r.name === "Scout")!.template_origin).toBe(SCOUT_ID);
      expect(await teamRowCount(id)).toBe(1);
      expect((await diagnoseCrewProvisioning(db, id)).verdict).toBe("healthy");
    }
    expect(await crewRows(healthy.id)).toEqual(healthyBefore);
  }, 300_000);

  it("a fail-closed company does not consume budget, so it cannot starve the queue", async () => {
    assertSetupOk();
    const stubborn = await createLegacyCompany("Starver Co");
    const repairable = await createLegacyCompany("Starved Co");
    await withCatalog();

    // `stubborn` is degraded and permanently unrepairable, for a reason local to
    // it: its Scout is already managed under a DIFFERENT origin, which repair
    // refuses to re-point. `repairable` is an ordinary legacy company.
    await db.execute(sql`
      UPDATE agents SET template_origin = 'agent:aoa-curated/some-other-agent',
                        template_version = '1.0.0'
      WHERE company_id = ${stubborn} AND name = 'Scout'
    `);

    // Budget 1, stubborn FIRST: if a fail-closed skip consumed the slot, the
    // company behind it would never be reached — on every pass, forever.
    const pass = await runCrewRepairPass({
      db,
      companyIds: [stubborn, repairable],
      catalogItems: CATALOG_ITEMS,
      maxPerPass: 1,
    });

    // `repairable` is behind `stubborn` in the list and still got repaired.
    expect((await crewRows(repairable)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(pass).toMatchObject({
      inspected: 2,
      repaired: 1,
      skippedFailClosed: 1,
      skippedOverBudget: 0,
    });
    expect(
      pass.skips.filter((skip) => skip.category === "fail_closed"),
    ).toHaveLength(pass.skippedFailClosed);
  }, 300_000);

  it("the cooldown, not luck, is what stops a degraded company being retried every pass", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Cooldown Co");
    await withCatalog();
    let clock = Date.now();
    setCrewRepairClock(() => clock);

    brokenUrls.add(`${FIXTURE_HOST}/teams/default-crew/team.json`);
    const pass1 = await runCrewRepairPass({ db, companyIds: [companyId], catalogItems: CATALOG_ITEMS });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(pass1).toMatchObject({ skippedFailClosed: 1, skippedCooldown: 0 });

    // The CDN is healthy again — the ONLY thing standing between pass 2 and a
    // successful repair is the clock.
    brokenUrls.clear();
    clock += CREW_REPAIR_COOLDOWN_MS - 1;
    const pass2 = await runCrewRepairPass({ db, companyIds: [companyId], catalogItems: CATALOG_ITEMS });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(pass2).toMatchObject({ skippedCooldown: 1, repaired: 0 });
    expect(
      pass2.skips.filter((skip) => skip.category === "cooldown"),
    ).toHaveLength(1);
    expect(pass2.skips[0]?.notBefore).toBeTruthy();

    clock += 2;
    const pass3 = await runCrewRepairPass({ db, companyIds: [companyId], catalogItems: CATALOG_ITEMS });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(pass3.repaired).toBe(1);
  }, 300_000);

  it("a forced full-fleet pass bypasses the long cooldown but keeps the retry floor", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Forced Pass Cooldown Co");
    await withCatalog();
    let clock = Date.now();
    setCrewRepairClock(() => clock);

    brokenUrls.add(`${FIXTURE_HOST}/teams/default-crew/team.json`);
    const failed = await runCrewRepairPass({
      db,
      companyIds: [companyId],
      catalogItems: CATALOG_ITEMS,
    });
    expect(failed).toMatchObject({
      repaired: 0,
      skippedFailClosed: 1,
      skippedCooldown: 0,
    });

    brokenUrls.clear();
    clock += CREW_REPAIR_FORCE_FLOOR_MS - 1;
    const tooSoon = await runCrewRepairPass({
      db,
      companyIds: [companyId],
      catalogItems: CATALOG_ITEMS,
      maxPerPass: 1,
      force: true,
    });
    expect(tooSoon).toMatchObject({ repaired: 0, skippedCooldown: 1 });

    clock += 2;
    const forced = await runCrewRepairPass({
      db,
      companyIds: [companyId],
      catalogItems: CATALOG_ITEMS,
      maxPerPass: 1,
      force: true,
    });
    expect(
      (await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin,
    ).toBe(SCOUT_ID);
    expect(forced).toMatchObject({ repaired: 1, skippedCooldown: 0 });
  }, 300_000);

  it("does no work at all when the catalog lacks the crew team item", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Stale Catalog Co");
    const before = await crewRows(companyId);

    // A cache row whose `items` is empty passes a "is there a catalog?" guard,
    // after which a crewless company would provision off a catalog that never
    // had the team and degrade straight back to legacy.
    const pass = await runCrewRepairPass({ db, companyIds: [companyId], catalogItems: [] });

    expect(await crewRows(companyId)).toEqual(before);
    expect(pass).toMatchObject({ inspected: 0, repaired: 0, skippedFailClosed: 0 });
  }, 240_000);

  // ── The route ─────────────────────────────────────────────────────────────
  it("POST /crew/repair: founder repairs, team_lead is refused, no catalog is 503", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Route Co");
    const app = makeApp();
    const founderId = randomUUID();
    const leadId = randomUUID();
    await seedUserRole(companyId, founderId, "founder");
    await seedUserRole(companyId, leadId, "team_lead");

    // A team_lead must not be able to rewrite the crew's governance.
    cdnReachable = true;
    currentActor = boardActor(leadId, companyId);
    const refused = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({});
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(refused.status).toBe(403);

    // No catalog: nothing to repair TOWARDS — distinct from "nothing to do".
    cdnReachable = false;
    currentActor = boardActor(founderId, companyId);
    const noCatalog = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({});
    expect(await teamRowCount(companyId)).toBe(0);
    expect(noCatalog.status).toBe(503);

    cdnReachable = true;
    const ok = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({});
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.result.action).toBe("adopted");
    expect(ok.body.diagnosis.verdict).toBe("degraded");
  }, 240_000);

  it("POST /crew/repair shares the pass cooldown unless the founder forces it", async () => {
    assertSetupOk();
    const companyId = await createLegacyCompany("Route Cooldown Co");
    const app = makeApp();
    const founderId = randomUUID();
    await seedUserRole(companyId, founderId, "founder");
    currentActor = boardActor(founderId, companyId);
    cdnReachable = true;
    let clock = Date.now();
    setCrewRepairClock(() => clock);

    // First call fails closed (team.json is down) and takes the cooldown.
    brokenUrls.add(`${FIXTURE_HOST}/teams/default-crew/team.json`);
    const first = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({});
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(first.body.result.reason).toBe("team-template-unavailable");

    // A founder in a retry loop must not drive unbounded fetches: the route
    // shares the gate rather than bypassing it.
    brokenUrls.clear();
    const looped = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({});
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(looped.body.result.reason).toBe("cooldown");

    // `force` clears the 6h cooldown but NOT the short floor — a founder holding
    // the button down must not become a fetch loop either.
    const tooSoon = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({ force: true });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toMatch(
      /@legacy$/,
    );
    expect(tooSoon.body.result.reason).toBe("cooldown");

    // …past the floor, the operator override is honoured without waiting 6h.
    clock += CREW_REPAIR_FORCE_FLOOR_MS + 1;
    const forced = await request(app)
      .post(`/api/companies/${companyId}/marketplace/crew/repair`)
      .send({ force: true });
    expect((await crewRows(companyId)).find((r) => r.name === "Scout")!.template_origin).toBe(
      SCOUT_ID,
    );
    expect(forced.body.result.action).toBe("adopted");
  }, 240_000);
});

// A9.1 — proves the Commander-Team seeds are wired into the SOLE
// per-company create path (companyService.create → createCompanyWithUniquePrefix).
//
// Decision #100 ("the Commander Team comes with the app"): every newly-created
// company must eagerly get (1) a default internal_agent_config row and (2) the
// Commander kind='aoa' agent linked into that config.
//
// Phase 1 (Task C1 + Phase D batch 2): the Discussion Extraction ("Scribe")
// agent is no longer seeded at company create. The autonomous extraction drain
// is gated OFF (AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED); extraction now runs as
// tool calls from Memory Keeper + Adjutant. `ensureExtractionAgent` stays in
// the codebase for rollback safety (and is unit-tested in
// aoa-ensure-extraction-agent.test.ts) but is no longer wired into bootstrap,
// so this test no longer asserts it.
//
// The two remaining seeds are mocked here (their own units are covered by
// aoa-ensure-commander.test.ts); this test pins ONLY the wiring contract:
// invoked, with (db, newCompanyId), in order config → commander, after the
// root-folder seed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureConfigMock, ensureCommanderMock, ensureStewardMock, seedCalls, callOrder } =
  vi.hoisted(() => {
    const callOrder: string[] = [];
    // Every ensure-* seeder that actually ran, infra + crew, in order. Used by
    // the P8d marketplace-gate assertions.
    const seedCalls: string[] = [];
    return {
      callOrder,
      seedCalls,
      ensureConfigMock: vi.fn(async () => {
        callOrder.push("config");
        seedCalls.push("config");
      }),
      ensureCommanderMock: vi.fn(async () => {
        callOrder.push("commander");
        seedCalls.push("commander");
        return "cmd-1";
      }),
      ensureStewardMock: vi.fn(async () => {
        seedCalls.push("steward");
        return "stw-1";
      }),
    };
  });

// No-op drizzle operators + Proxy table stubs — the standard AoA-seed test
// harness (mirrors aoa-ensure-commander.test.ts) so importing companies.ts
// doesn't trigger the drizzle-orm ESM cycle.
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  count: () => ({ op: "count" }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  // T3.5 gate uses sql`` template tag — provide a tagged-template stub.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ op: "sql", strings, vals }),
    {},
  ),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy(
      {},
      { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) },
    );
  return {
    companies: t("companies"),
    agents: t("agents"),
    agentApiKeys: t("agent_api_keys"),
    agentConfigRevisions: t("agent_config_revisions"),
    agentProjects: t("agent_projects"),
    agentRuntimeState: t("agent_runtime_state"),
    agentTaskSessions: t("agent_task_sessions"),
    agentWakeupRequests: t("agent_wakeup_requests"),
    issues: t("issues"),
    issueApprovals: t("issue_approvals"),
    issueAttachments: t("issue_attachments"),
    issueComments: t("issue_comments"),
    issueDocuments: t("issue_documents"),
    issueReadStates: t("issue_read_states"),
    assets: t("assets"),
    projects: t("projects"),
    projectGoals: t("project_goals"),
    projectWorkspaces: t("project_workspaces"),
    executionWorkspaces: t("execution_workspaces"),
    goals: t("goals"),
    heartbeatRuns: t("heartbeat_runs"),
    heartbeatRunEvents: t("heartbeat_run_events"),
    heartbeatRunWatchdogDecisions: t("heartbeat_run_watchdog_decisions"),
    costEvents: t("cost_events"),
    financeEvents: t("finance_events"),
    approvalComments: t("approval_comments"),
    approvals: t("approvals"),
    activityLog: t("activity_log"),
    companySecrets: t("company_secrets"),
    companySkills: t("company_skills"),
    documents: t("documents"),
    documentRevisions: t("document_revisions"),
    feedbackExports: t("feedback_exports"),
    feedbackVotes: t("feedback_votes"),
    joinRequests: t("join_requests"),
    invites: t("invites"),
    notifications: t("notifications"),
    principalPermissionGrants: t("principal_permission_grants"),
    companyMemberships: t("company_memberships"),
    mcpApiKeys: t("mcp_api_keys"),
    mcpClientConnections: t("mcp_client_connections"),
    workspaceOperations: t("workspace_operations"),
    workspaceRuntimeServices: t("workspace_runtime_services"),
    // T2.3: crewTeamIsInstalled queries `teams`. Omitting it here made the
    // guard's fail-closed catch fire on a TypeError and silently skip the crew
    // — a harness artifact that looked exactly like the real bug.
    teams: t("teams"),
  };
});
// memory-folders is invoked by createCompanyWithUniquePrefix (root-folder
// seed) — stub it so the seed is a no-op but still ordered before our seeds.
vi.mock("../services/memory-folders.js", () => ({
  memoryFoldersService: () => ({}),
  seedCompanyRootFolder: vi.fn(async () => {
    callOrder.push("rootFolder");
  }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-internal-agent-config.js", () => ({
  ensureInternalAgentConfig: ensureConfigMock,
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: ensureCommanderMock,
}));
// The additional crew seeders introduced in Phase D batch 1 (Command Staff,
// Adjutant, Scout, Engineer) are mocked as no-ops here. This test only pins
// the wiring contract for the Decision #100 minimum (config + commander); the
// crew seeders have their own unit tests and the marketplace gate test
// asserts their order.
vi.mock("../services/internal-agent/aoa-agents/ensure-steward.js", () => ({
  ensureSteward: ensureStewardMock,
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-command-staff.js", () => ({
  ensureCommandStaff: vi.fn(async () => { seedCalls.push("staff"); }),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-adjutant.js", () => ({
  ensureAdjutant: vi.fn(async () => { seedCalls.push("adjutant"); }),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-scout.js", () => ({
  ensureScout: vi.fn(async () => { seedCalls.push("scout"); }),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-engineer.js", () => ({
  ensureEngineer: vi.fn(async () => { seedCalls.push("engineer"); }),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-chronicler.js", () => ({
  ensureChronicler: vi.fn(async () => { seedCalls.push("chronicler"); }),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-librarian.js", () => ({
  ensureLibrarian: vi.fn(async () => { seedCalls.push("librarian"); }),
}));

import { companyService } from "../services/companies.js";

const NEW_COMPANY_ID = "co-new-9";

// Minimal mock DB: the only DB op createCompanyWithUniquePrefix performs on
// the happy path is `db.insert(companies).values(...).returning()` → returns
// the freshly-created company row (with id). All ensure-seeds are mocked,
// so no further DB ops are exercised by this test.
//
// T3.5 addition: createCompanyWithUniquePrefix calls isCrewMarketplaceManaged,
// which issues db.select().from(agents).where(...).limit(1) to check whether a
// marketplace-governed crew already exists. Returning [] simulates a fresh
// legacy company so the legacy ensure-*.ts path still runs and the wiring
// assertions hold.
//
// P8d: `managed` flips the marketplace gate — [{ id }] means a `kind='aoa'`
// row with a non-`@legacy` templateOrigin already exists, i.e. the marketplace
// governs this company's crew.
//
// `stampsOriginOnSeed` simulates the future regression the gate-read ordering
// defends against: a seeder that stamps a non-`@legacy` templateOrigin at
// insert time (the cleanup `backfill-template-origin.ts:29-37` practically
// invites). The gate query then starts matching as soon as Commander exists.
// Reading the gate BEFORE seeding makes that harmless; reading it after would
// make every newly-created company look marketplace-managed to itself.
function makeDb(opts: { managed?: boolean; stampsOriginOnSeed?: boolean } = {}) {
  return {
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: NEW_COMPANY_ID, name: "Acme" }]),
      }),
    }),
    select: () => ({
      // The table matters now: `isCrewMarketplaceManaged` queries `agents`,
      // while T2.3's `crewTeamIsInstalled` queries `teams`. A table-blind stub
      // would answer "a crew team exists" to the agents predicate and vice
      // versa, which is precisely the conflation the guard must not make.
      from: (table: unknown) => ({
        where: () => ({
          limit: () => {
            const isAgentsQuery = String(
              (table as Record<string, unknown> | undefined)?.__tableName ?? "",
            ).includes("agents");
            if (!isAgentsQuery) {
              // No crew team was ever installed in these mocked scenarios.
              return Promise.resolve([]);
            }
            const selfInflicted =
              opts.stampsOriginOnSeed === true && seedCalls.includes("commander");
            return Promise.resolve(
              opts.managed || selfInflicted ? [{ id: "mkt-agent-1" }] : [],
            );
          },
        }),
      }),
    }),
  } as any;
}

describe("A9.1 — Commander-Team seeds wired into createCompanyWithUniquePrefix", () => {
  beforeEach(() => {
    ensureConfigMock.mockClear();
    ensureCommanderMock.mockClear();
    ensureStewardMock.mockClear();
    callOrder.length = 0;
    seedCalls.length = 0;
  });

  it("calls config + commander seeds with (db, newCompanyId)", async () => {
    const db = makeDb();
    const svc = companyService(db);

    const company = await svc.create({ name: "Acme" } as any);
    expect(company.id).toBe(NEW_COMPANY_ID);

    expect(ensureConfigMock).toHaveBeenCalledWith(db, NEW_COMPANY_ID);
    expect(ensureCommanderMock).toHaveBeenCalledWith(db, NEW_COMPANY_ID);
  });

  it("seeds in order: root-folder → config → commander", async () => {
    const db = makeDb();
    await companyService(db).create({ name: "Acme" } as any);

    // ensureCommander's internal_agent_config UPDATE no-ops unless the config
    // row exists first, so config MUST precede commander. (Phase 1 / Phase D
    // batch 2: the Discussion Extraction seed was removed from this chain;
    // see file-level docstring.)
    expect(callOrder).toEqual(["rootFolder", "config", "commander"]);
  });

  // ── P8d — the marketplace gate covers the CREW half only ────────────────
  it("marketplace-managed company: config + Commander still seed, legacy crew does NOT", async () => {
    const db = makeDb({ managed: true });
    await companyService(db).create({ name: "Acme" } as any);

    // The casualty this task fixes: internal_agent_config used to live inside
    // the gated block, so a marketplace-managed company got NO config row —
    // no autonomy dial, no provider/model config.
    expect(ensureConfigMock).toHaveBeenCalledWith(db, NEW_COMPANY_ID);
    expect(ensureCommanderMock).toHaveBeenCalledWith(db, NEW_COMPANY_ID);
    expect(ensureStewardMock).not.toHaveBeenCalled();

    // Discriminator: Scout IS published in the catalog, so the marketplace owns
    // it and the legacy seeder must stay off.
    expect(seedCalls).not.toContain("scout");
    expect(seedCalls).toEqual(["config", "commander"]);
  });

  it("NOT marketplace-managed: the full legacy roster still seeds (regression)", async () => {
    const db = makeDb();
    await companyService(db).create({ name: "Acme" } as any);

    expect(seedCalls.slice().sort()).toEqual(
      ["adjutant", "chronicler", "commander", "config", "engineer", "librarian", "scout", "staff", "steward"],
    );
  });

  // ── F2 — the gate must be READ BEFORE anything is SEEDED ─────────────────
  // Fails if the gate read is moved back below the seeding writes. With a
  // seeder that stamps a non-`@legacy` origin, a read-after-write gate sees the
  // company's own fresh Commander, concludes "marketplace-managed", and skips
  // the entire crew — silently, on every newly created company.
  it("a seeder that stamps a non-@legacy origin cannot make a company skip its own crew", async () => {
    const db = makeDb({ stampsOriginOnSeed: true });
    await companyService(db).create({ name: "Acme" } as any);

    expect(seedCalls).toContain("commander");
    // The whole point: the crew still seeds despite the self-inflicted match.
    // T2.3 added a SECOND way to fail this — the degrade-path guard that stops
    // the legacy seeders clobbering a committed marketplace install. If that
    // guard asks "is any aoa agent marketplace-managed?" instead of "did the
    // crew TEAM install commit?", the stamped Commander answers yes and the
    // company skips its own crew. It must ask the narrow question.
    expect(seedCalls).toContain("scout");
    expect(seedCalls.slice().sort()).toEqual(
      ["adjutant", "chronicler", "commander", "config", "engineer", "librarian", "scout", "staff", "steward"],
    );
  });
});

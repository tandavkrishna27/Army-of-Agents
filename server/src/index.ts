/// <reference path="./types/express.d.ts" />
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@armyofagents/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  heartbeatService,
  agentRuntimeDecisionService,
  issueMonitorSchedulerService,
  productivityReviewService,
  routineService,
  processFileImportQueue,
  resetStuckJobs,
  WORKER_INTERVAL_MS,
  workQuestionContinuationService,
  workQuestionSlaService,
  organizationService,
} from "./services/index.js";
import { getDbCapabilities, probeDbCapabilities } from "./services/db-capabilities.js";
import { runExtractionSweep } from "./services/internal-agent/subagents/extraction-sweeper.js";
import { runAdjutantSweep } from "./services/internal-agent/aoa-agents/sweep-adjutant.js";
import { runControllerSweep } from "./services/internal-agent/aoa-agents/sweep-controller.js";
import { runMemoryKeeperSweep, MK_SWEEP_DEBOUNCE_MS } from "./services/internal-agent/aoa-agents/sweep-memory-keeper.js";
import { runInboxSweep } from "./services/internal-agent/aoa-agents/sweep-inbox.js";
import { runStewardSweep, STEWARD_SWEEP_INTERVAL_MS } from "./services/internal-agent/aoa-agents/sweep-steward.js";
import { operatorBreakGlassService, realBreakGlassDeps } from "./services/operator-break-glass.js";
import {
  reconcileLegacyAdapterRuntimeIdentitiesOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  restartDesiredRuntimeServicesOnStartup,
} from "./services/workspace-runtime.js";
import { handlePreviewProxyUpgrade } from "./services/preview-proxy.js";
import { scheduleTtlSweeper } from "./services/workspace-ttl-sweeper.js";
import { scheduleWarmSandboxReaper } from "./services/warm-sandbox-reaper.js";
import { scheduleCleanupRetrySweeper } from "./services/workspace-cleanup-retry-sweeper.js";
import { scheduleClaudeConfigDirSweeper } from "./services/claude-config-dir-sweeper.js";
import { registerHeartbeatWatchdogSweeper } from "./services/heartbeat-watchdog.js";
import { startEmbeddingWorker } from "./services/embeddings-worker.js";
import { startMentionOutboxWorker } from "./services/mention-outbox-worker.js";
import { startCommentWakeupOutboxWorker } from "./services/comment-wakeup-outbox-worker.js";
import { resetStaleProcessing } from "./services/embeddings.js";
import { backfillQueueCompanyIds, reconcileNullVectors } from "./services/embeddings-backfill.js";
import { getProviderApiKey } from "./services/internal-agent/providers/index.js";
import { scheduleNotificationRetryWorker } from "./services/notification-retry-worker.js";
import { buildCommanderLoginService } from "./services/commander-login-runtime.js";
import { initThreadEventListener } from "./services/thread-events.js";
import { onBudgetExhausted } from "./services/budget-hooks.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { tryRecoverOrphanPostgres } from "./postgres/embedded-orphan-recovery.js";
import { assertTestSupportFlagSafe } from "./services/test-support-safety.js";
import { createProcessShutdownHandler } from "./services/server-shutdown.js";
import { DEFAULT_BACKUP_RETENTION } from "@armyofagents/shared";
import { runChroniclerSweep, CHRONICLER_SWEEP_INTERVAL_MS } from "./services/internal-agent/aoa-agents/sweep-chronicler.js";
import { ensureCrewAgents, ensureInfrastructureAgents, isCrewMarketplaceManaged } from "./services/internal-agent/aoa-agents/crew-seeding.js";
import { backfillGoalParents } from "./migrations/backfill-goal-parents.js";
import { backfillMemoryFolderSeeds } from "./migrations/backfill-memory-folder-seeds.js";
import { backfillWorkQuestionSnapshots } from "./migrations/backfill-work-question-snapshots.js";
import { backfillFirstRunCompleted } from "./migrations/backfill-first-run-completed.js";
import { normalizeLegacyOnboardingState } from "./migrations/normalize-legacy-onboarding-state.js";
import { backfillCrewTemplateOrigin } from "./services/internal-agent/aoa-agents/backfill-template-origin.js";
import { backfillAllCompaniesIdentityMemory } from "./services/identity-backfill.js";
import { backfillFounderGrants } from "./services/founder-grants-backfill.js";
import { backfillCrewOriginKind } from "./services/internal-agent/aoa-agents/backfill-crew-origin-kind.js";
import { reconcileAutonomyScale } from "./services/internal-agent/aoa-agents/reconcile-autonomy-scale.js";
import { runProviderConnectionsBackfill } from "./services/provider-connections-backfill.js";
import {
  getMarketplaceCatalogService,
  loadCachedCatalog,
} from "./services/aoa-marketplace.js";
import { runMarketplaceCrewMaintenance } from "./services/marketplace-reconcile.js";
import { runStartupMarketplaceMaintenance } from "./services/marketplace-startup-maintenance.js";
import { serializeSafeError } from "./services/safe-error.js";
import { drainMcpConnectorOauthFlows } from "./services/mcp-connector-oauth-flow-sweeper.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

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
  /**
   * Flags forwarded to `initdb` when the cluster is first created. Used to
   * force UTF-8 encoding so non-Latin-1 characters (right-arrow `→`, em-dashes,
   * emoji, CJK) can be stored. On Windows, the default initdb takes the OS
   * locale (WIN1252), and INSERTs of UTF-8-only chars then fail with
   * `character with byte sequence … has no equivalent in encoding "WIN1252"`.
   */
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const config = loadConfig();

// Dev/sandbox affordance (opt-in via AOA_STRIP_CC_ENV=1): when AoA is launched
// from inside a Claude Code session — especially a staging session — the inherited
// CLAUDE_CODE_* / OAuth-routing vars + ANTHROPIC_BASE_URL point every spawned CLI
// (Commander, extraction, crew/org runs, the auth probe) at the HOST session's
// endpoint. A normal `claude login` (production) then reads as "revoked" there, so
// the CLI reports needs_auth even though the machine is signed in. Stripping these
// here — after loadConfig()'s .env load, before any adapter spawns — lets the child
// CLIs fall back to the machine's own login. No-op in a normal terminal (vars absent).
if (process.env.AOA_STRIP_CC_ENV === "1") {
  const stripped = Object.keys(process.env).filter((k) =>
    /^(CLAUDE_CODE_|CLAUDECODE$|USE_STAGING_OAUTH$|USE_LOCAL_OAUTH$|ANTHROPIC_BASE_URL$|AI_AGENT$)/i.test(k),
  );
  for (const k of stripped) delete process.env[k];
  console.log(
    `[aoa] AOA_STRIP_CC_ENV: removed ${stripped.length} Claude Code session var(s)` +
      (stripped.length ? `: ${stripped.join(", ")}` : ""),
  );
}

// The dedicated e2e session mint bypasses OAuth. Reject unsafe combinations
// before migrations, database bootstrap, or route initialization does work.
assertTestSupportFlagSafe({
  testSupportEnabled: process.env.AOA_E2E_TEST_SUPPORT === "1",
  testSupportToken: process.env.AOA_E2E_TEST_SUPPORT_TOKEN,
  deploymentExposure: config.deploymentExposure,
  bindHost: config.host,
  authPublicBaseUrl: config.authPublicBaseUrl ?? null,
  nodeEnv: process.env.NODE_ENV,
});
if (process.env.AOA_SECRETS_PROVIDER === undefined) {
  process.env.AOA_SECRETS_PROVIDER = config.secretsProvider;
}
if (process.env.AOA_SECRETS_STRICT_MODE === undefined) {
  process.env.AOA_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
}
if (process.env.AOA_SECRETS_MASTER_KEY_FILE === undefined) {
  process.env.AOA_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
}

type MigrationSummary =
  | "skipped"
  | "already applied"
  | "applied (empty database)"
  | "applied (pending migrations)"
  | "pending migrations skipped";

function formatPendingMigrationSummary(migrations: string[]): string {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
  if (process.env.AOA_MIGRATION_PROMPT === "never") return false;
  if (process.env.AOA_MIGRATION_AUTO_APPLY === "true") return true;
  if (!stdin.isTTY || !stdout.isTTY) return true;

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(
      `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

type EnsureMigrationsOptions = {
  autoApply?: boolean;
};

async function ensureMigrations(
  connectionString: string,
  label: string,
  opts?: EnsureMigrationsOptions,
): Promise<MigrationSummary> {
  const autoApply = opts?.autoApply === true;
  let state = await inspectMigrations(connectionString);
  if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
    const repair = await reconcilePendingMigrationHistory(connectionString);
    if (repair.repairedMigrations.length > 0) {
      logger.warn(
        { repairedMigrations: repair.repairedMigrations },
        `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
      );
      state = await inspectMigrations(connectionString);
      if (state.status === "upToDate") return "already applied";
    }
  }
  if (state.status === "upToDate") return "already applied";

  if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
    logger.warn(
      { tableCount: state.tableCount },
      `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
    );
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      logger.warn(
        { pendingMigrations: state.pendingMigrations },
        `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
      );
      return "pending migrations skipped";
    }

    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString, {
      deploymentMode: config.deploymentMode,
    });
    return "applied (pending migrations)";
  }

  const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
  if (!apply) {
    logger.warn(
      { pendingMigrations: state.pendingMigrations },
      `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
    );
    return "pending migrations skipped";
  }

  logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
  await applyPendingMigrations(connectionString, {
    deploymentMode: config.deploymentMode,
  });
  return "applied (pending migrations)";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

const LOCAL_BOARD_USER_ID = "local-board";
const LOCAL_BOARD_USER_EMAIL = "local@aoa.local";
const LOCAL_BOARD_USER_NAME = "Board";

async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
  const now = new Date();
  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  if (!existingUser) {
    await db.insert(authUsers).values({
      id: LOCAL_BOARD_USER_ID,
      name: LOCAL_BOARD_USER_NAME,
      email: LOCAL_BOARD_USER_EMAIL,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const role = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  if (!role) {
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_BOARD_USER_ID,
      role: "instance_admin",
    });
  }

  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
        ),
      )
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (membership) continue;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
  }
}

let db: ReturnType<typeof import("@armyofagents/db").createDb> | undefined;
let embeddedPostgres: EmbeddedPostgresInstance | null = null;
let embeddedPostgresStartedByThisProcess = false;
let migrationSummary: MigrationSummary = "skipped";
let activeDatabaseConnectionString: string;
let startupDbInfo:
  | { mode: "external-postgres"; connectionString: string }
  | { mode: "embedded-postgres"; dataDir: string; port: number };
if (config.databaseUrl) {
  migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");

  db = createDb(config.databaseUrl);
  logger.info("Using external PostgreSQL via DATABASE_URL/config");
  activeDatabaseConnectionString = config.databaseUrl;
  startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
} else {
  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
    );
  }

  const dataDir = resolve(config.embeddedPostgresDataDir);
  const configuredPort = config.embeddedPostgresPort;
  let port = configuredPort;
  const embeddedPostgresLogBuffer: string[] = [];
  const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
  const verboseEmbeddedPostgresLogs = process.env.AOA_EMBEDDED_POSTGRES_VERBOSE === "true";
  const appendEmbeddedPostgresLog = (message: unknown) => {
    const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line) continue;
      embeddedPostgresLogBuffer.push(line);
      if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
        embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
      }
      if (verboseEmbeddedPostgresLogs) {
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    }
  };
  const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
    if (embeddedPostgresLogBuffer.length > 0) {
      logger.error(
        {
          phase,
          recentLogs: embeddedPostgresLogBuffer,
          err,
        },
        "Embedded PostgreSQL failed; showing buffered startup logs",
      );
    }
  };

  if (config.databaseMode === "postgres") {
    logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
  }

  const clusterVersionFile = resolve(dataDir, "PG_VERSION");
  const clusterAlreadyInitialized = existsSync(clusterVersionFile);
  const postmasterPidFile = resolve(dataDir, "postmaster.pid");
  const isPidRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const getRunningPid = (): number | null => {
    if (!existsSync(postmasterPidFile)) return null;
    try {
      const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
      const pid = Number(pidLine);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!isPidRunning(pid)) return null;
      return pid;
    } catch {
      return null;
    }
  };

  const runningPid = getRunningPid();
  if (runningPid) {
    logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
  } else {
    const detectedPort = await detectPort(configuredPort);
    if (detectedPort !== configuredPort) {
      if (process.env.AOA_EMBEDDED_POSTGRES_STRICT_PORT === "1") {
        throw new Error(`Embedded PostgreSQL port ${configuredPort} is in use`);
      }
      logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
    }
    port = detectedPort;
    logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "aoa",
      password: "aoa",
      port,
      persistent: true,
      // Force UTF-8 encoding + locale=C at cluster creation. Without this,
      // initdb takes the OS locale (WIN1252 on Windows) and the cluster
      // physically rejects UTF-8-only characters in INSERTs/UPDATEs. Locale=C
      // gives byte-sort ORDER BY semantics; that's the safest default for an
      // application-layer database where collation rarely matters.
      // Only applied on first cluster creation; existing clusters keep their
      // initial encoding (an existing WIN1252 cluster needs to be re-init'd
      // or pg_dump/restore'd to switch to UTF-8).
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: appendEmbeddedPostgresLog,
      onError: appendEmbeddedPostgresLog,
    });

    if (!clusterAlreadyInitialized) {
      try {
        await embeddedPostgres.initialise();
      } catch (err) {
        logEmbeddedPostgresFailure("initialise", err);
        throw err;
      }
    } else {
      logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
    }

    if (existsSync(postmasterPidFile)) {
      logger.warn("Removing stale embedded PostgreSQL lock file");
      // On Windows, also kill any orphan postgres.exe still holding the
      // shared-memory block — otherwise embeddedPostgres.start() below will
      // fail with "pre-existing shared memory block is still in use".
      // No-op on non-Windows.
      await tryRecoverOrphanPostgres({ dataDir });
      rmSync(postmasterPidFile, { force: true });
    }
    try {
      await embeddedPostgres.start();
    } catch (err) {
      logEmbeddedPostgresFailure("start", err);
      throw err;
    }
    embeddedPostgresStartedByThisProcess = true;
  }

  const embeddedAdminConnectionString = `postgres://aoa:aoa@127.0.0.1:${port}/postgres`;
  const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "aoa");
  if (dbStatus === "created") {
    logger.info("Created embedded PostgreSQL database: aoa");
  }

  const embeddedConnectionString = `postgres://aoa:aoa@127.0.0.1:${port}/aoa`;
  const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
  if (shouldAutoApplyFirstRunMigrations) {
    logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
  }
  migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
    autoApply: shouldAutoApplyFirstRunMigrations,
  });

  db = createDb(embeddedConnectionString);
  logger.info("Embedded PostgreSQL ready");
  activeDatabaseConnectionString = embeddedConnectionString;
  startupDbInfo = { mode: "embedded-postgres", dataDir, port };
}

// Expose the active DB URL in process.env so MCP bridge child processes
// (Commander bridge spawned by claude/codex CLI) can inherit it.
// External-postgres sets process.env.DATABASE_URL before this point (it is
// read by loadConfig via process.env.DATABASE_URL), so the set here is a
// no-op for that path. Embedded-postgres builds the URL dynamically — this
// is the only place it reaches process.env, ensuring the bridge gets it.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = activeDatabaseConnectionString;
}

// Probe optional database capabilities (pgvector). Services read the result
// via getDbCapabilities() to gate semantic-search paths and embedding columns.
await probeDbCapabilities(db as any);

// Phase 1 (multi-tenant cloud): guarantee the sentinel default Organization
// exists before any company-scoped work runs. Idempotent (ON CONFLICT DO
// NOTHING) — safe on every boot. Must run after migrations (the organizations
// table only exists post-0188) and before any company create/list flow below.
await organizationService(db as any).ensureDefaultOrganization();

// OAuth browser flows are transient. Bound their retention independently of
// request traffic: one best-effort sweep at boot, then hourly. The service uses
// bounded, predicate-rechecked deletes and is safe across server instances.
const MCP_OAUTH_FLOW_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let mcpOauthFlowSweepInFlight = false;
const runMcpOauthFlowSweep = () => {
  if (mcpOauthFlowSweepInFlight) return;
  mcpOauthFlowSweepInFlight = true;
  void drainMcpConnectorOauthFlows(db as any)
    .then(({ deleted }) => {
      if (deleted > 0) logger.info({ deleted }, "expired MCP OAuth flows swept");
    })
    .catch((err: unknown) => logger.warn({ err }, "MCP OAuth flow sweep failed (non-fatal)"))
    .finally(() => { mcpOauthFlowSweepInFlight = false; });
};
runMcpOauthFlowSweep();
const mcpOauthFlowSweepTimer = setInterval(runMcpOauthFlowSweep, MCP_OAUTH_FLOW_SWEEP_INTERVAL_MS);
process.once("SIGTERM", () => clearInterval(mcpOauthFlowSweepTimer));
process.once("SIGINT", () => clearInterval(mcpOauthFlowSweepTimer));

if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
  throw new Error(
    `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
      "Use authenticated mode for non-loopback deployments.",
  );
}

if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
  throw new Error("local_trusted mode only supports private exposure");
}

if (config.deploymentMode === "authenticated") {
  if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
    throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
  }
  if (config.deploymentExposure === "public") {
    if (config.authBaseUrlMode !== "explicit") {
      throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
    }
    if (!config.authPublicBaseUrl) {
      throw new Error("authenticated public exposure requires auth.publicBaseUrl");
    }
  }
}

const requestedListenPort = config.port;
const listenPort = await detectPort(requestedListenPort);
if (listenPort !== requestedListenPort) {
  logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
}

let authReady = false;
let betterAuthHandler: RequestHandler | undefined;
let resolveSession:
  | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
  | undefined;
let resolveSessionFromHeaders:
  | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
  | undefined;
// Hoisted out of the auth-init block (mirrors resolveSessionFromHeaders/authReady)
// so the WebSocket upgrade wiring below can pass it into the CSWSH Origin check.
let effectiveTrustedOrigins: string[] = [];

// revA R6 — Google is the only sign-in provider. Refuse to boot a would-be
// locked-out deployment: `authenticated` without Google creds, or
// `local_trusted` without Google AND without the dev escape hatch.
{
  const { assertAuthProviderConfigured } = await import("./auth/better-auth.js");
  assertAuthProviderConfigured(config);
}

// Task 10 (Phase 2 lockout cluster, ATOMIC cutover) — boot-time invariant:
// cloud_auth must never have a runtime instance_admin promotion path
// enabled. Belt to the Task 7/8/10(a) code-level gates: if a future change
// somehow re-enables bootstrap for cloud_auth, refuse to boot rather than
// silently minting global admins in a hosted multi-tenant deployment.
{
  const { assertInstanceAdminBootstrapInvariant } = await import(
    "./services/first-user-bootstrap.js"
  );
  assertInstanceAdminBootstrapInvariant({ deploymentMode: config.deploymentMode });
}

// RB4/R5 — the synthetic `local-board` admin is created ONLY under the dev
// escape hatch, and refused on a populated instance unless explicitly forced.
// Without the hatch, the real admin is the first Google user (see A7/RB3).
if (config.devLocalIdentity) {
  const { assertEscapeHatchAllowed } = await import("./services/dev-escape-hatch.js");
  await assertEscapeHatchAllowed(db as any);
  await ensureLocalTrustedBoardPrincipal(db as any);
}

// better-auth (Google identity) is instantiated in BOTH deployment modes so a
// local-first install authenticates the same way it does in the cloud.
{
  const {
    createBetterAuthHandler,
    createBetterAuthInstance,
    deriveAuthTrustedOrigins,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  } = await import("./auth/better-auth.js");
  const derivedTrustedOrigins = deriveAuthTrustedOrigins(config, { listenPort });
  const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
  logger.info(
    {
      deploymentMode: config.deploymentMode,
      authBaseUrlMode: config.authBaseUrlMode,
      authPublicBaseUrl: config.authPublicBaseUrl ?? null,
      trustedOrigins: effectiveTrustedOrigins,
      trustedOriginsSource: {
        derived: derivedTrustedOrigins.length,
        env: envTrustedOrigins.length,
      },
    },
    "Auth origin configuration",
  );
  const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
  betterAuthHandler = createBetterAuthHandler(auth);
  resolveSession = (req) => resolveBetterAuthSession(auth, req);
  resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
  authReady = true;
}

// revA A10 — the board-claim CLI bootstrap is retired from the normal human
// flow (the first Google user becomes admin instead). It is only initialized
// for headless/self-hosted server setups via AOA_HEADLESS_BOOTSTRAP.
{
  const { shouldEnableHeadlessBootstrap } = await import("./services/first-user-bootstrap.js");
  if (shouldEnableHeadlessBootstrap(config)) {
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
  }
}

const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
const storageService = createStorageServiceFromConfig(config);
const workQuestionSnapshotBackfill = await backfillWorkQuestionSnapshots(db as any);
if (workQuestionSnapshotBackfill.updated > 0) {
  logger.info(workQuestionSnapshotBackfill, "work-question identity snapshot backfill complete");
}
const { ensureControlPlaneExecutionTarget } = await import("./services/execution-targets.js");
await ensureControlPlaneExecutionTarget(db as any);
const app = await createApp(db as any, {
  uiMode,
  storageService,
  deploymentMode: config.deploymentMode,
  deploymentExposure: config.deploymentExposure,
  companyWorkspaceBaseDir: config.companyWorkspaceBaseDir,
  allowedHostnames: config.allowedHostnames,
  bindHost: config.host,
  authReady,
  companyDeletionEnabled: config.companyDeletionEnabled,
  trustProxy: config.trustProxy,
  betterAuthHandler,
  resolveSession,
  devLocalIdentity: config.devLocalIdentity,
});
const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

const runtimeListenHost = config.host;
const runtimeApiHost =
  runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
    ? "localhost"
    : runtimeListenHost;
process.env.AOA_LISTEN_HOST = runtimeListenHost;
process.env.AOA_LISTEN_PORT = String(listenPort);
// AOA_API_URL is the control-plane base the runtime hook + the brokered sandbox
// MCP call back to. A brokered (E2B) run executes in a VM that CANNOT reach the
// host loopback, so on cloud_auth it MUST be the PUBLIC base URL. Prefer an
// explicit operator value; else, on cloud_auth, derive it from the required
// public auth base URL; else fall back to the loopback (self-hosted host-direct
// — byte-identical to before). Previously this unconditionally clobbered any
// operator value with the loopback, leaving cloud_auth sandboxes pointed at an
// unreachable localhost. (E2B cloud_auth broker-reachability fix.)
process.env.AOA_API_URL =
  process.env.AOA_API_URL?.trim() ||
  (config.deploymentMode === "cloud_auth" ? config.authPublicBaseUrl?.trim() || undefined : undefined) ||
  `http://${runtimeApiHost}:${listenPort}`;

server.on("upgrade", (req, socket, head) => {
  void handlePreviewProxyUpgrade(db as any, req, socket, head, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
    trustedOrigins: effectiveTrustedOrigins,
  }).catch((err) => {
    logger.warn({ err, path: req.url }, "preview websocket upgrade failed");
    socket.destroy();
  });
});

setupLiveEventsWebSocketServer(server, db as any, {
  deploymentMode: config.deploymentMode,
  resolveSessionFromHeaders,
  trustedOrigins: effectiveTrustedOrigins,
});

// Work-question continuation and SLA processing are durable workflow workers,
// not heartbeat workers. They must keep running when heartbeat execution is
// intentionally disabled (for example, during a controlled maintenance mode)
// so an answered question can still resume its task and overdue questions can
// still escalate.
const workQuestionContinuations = workQuestionContinuationService(db as any);
const workQuestionSla = workQuestionSlaService(db as any);
let workQuestionContinuationTickInFlight = false;
let workQuestionSlaTickInFlight = false;

const tickWorkQuestionWorkers = (now = new Date()) => {
  if (!workQuestionContinuationTickInFlight) {
    workQuestionContinuationTickInFlight = true;
    void workQuestionContinuations
      .processDue(now)
      .catch((err) => {
        logger.error({ err }, "work-question continuation tick failed");
      })
      .finally(() => {
        workQuestionContinuationTickInFlight = false;
      });
  }

  if (!workQuestionSlaTickInFlight) {
    workQuestionSlaTickInFlight = true;
    void workQuestionSla
      .processDue(now)
      .then((result) => {
        if (result.breached > 0 || result.notificationFailures > 0) {
          logger.info({ ...result }, "work-question SLA tick completed");
        }
      })
      .catch((err) => {
        logger.error({ err }, "work-question SLA tick failed");
      })
      .finally(() => {
        workQuestionSlaTickInFlight = false;
      });
  }
};

// This cutover guard is independent of heartbeat scheduling. A deployment that
// disables heartbeat must still reap (or refuse to forget) pre-upgrade detached
// tenant processes before it continues booting. It must also run before any
// durable worker can dispatch a continuation into heartbeat execution.
await reconcileLegacyAdapterRuntimeIdentitiesOnStartup(db as any);
const runtimeProcessReconciliation = await reconcilePersistedRuntimeServicesOnStartup(db as any);

// Run independently of the heartbeat scheduler flag. This is intentionally
// separate from the heartbeat interval below so HEARTBEAT_SCHEDULER_ENABLED
// cannot strand durable questions in `pending`. Start it only after the
// detached-process cutover gate above has completed.
tickWorkQuestionWorkers();
setInterval(() => tickWorkQuestionWorkers(), config.heartbeatSchedulerIntervalMs);

// Auto-resume is durable runtime state, not a heartbeat scheduling concern.
// Keep it outside HEARTBEAT_SCHEDULER_ENABLED, after the process-ownership
// cutover gate. Per-activation commit guards make this safe in the background.
if (
  (runtimeProcessReconciliation.unresolved ?? 0) === 0 &&
  (runtimeProcessReconciliation.foreign ?? 0) === 0
) {
  void restartDesiredRuntimeServicesOnStartup(db as any)
    .then((restartSummary) => {
      if (restartSummary.failed > 0) {
        logger.warn(restartSummary, "desired runtime-service startup reconciliation complete with failures");
      } else {
        logger.info(restartSummary, "desired runtime-service startup reconciliation complete");
      }
    })
    .catch((err) => {
      logger.error({ err }, "restartDesiredRuntimeServicesOnStartup failed");
    });
} else {
  logger.warn(
    runtimeProcessReconciliation,
    "skipped desired runtime-service restart while legacy or foreign process rows remain",
  );
}

if (config.heartbeatSchedulerEnabled) {
  const heartbeat = heartbeatService(db as any);
  const productivityReviews = productivityReviewService(db as any);
  const monitorScheduler = issueMonitorSchedulerService(db as any);
  const PRODUCTIVITY_REVIEW_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
  let monitorTickInFlight = false;
  let productivityReviewTickInFlight = false;

  const runProductivityReviewReconciliation = (now = new Date()) => {
    if (productivityReviewTickInFlight) return;
    productivityReviewTickInFlight = true;
    void db
      .select({ id: companies.id })
      .from(companies)
      .then((rows) => Promise.all(rows.map((row) => productivityReviews.reconcileCompany(row.id, { now }))))
      .catch((err) => {
        logger.error({ err }, "productivity review reconciliation tick failed");
      })
      .finally(() => {
        productivityReviewTickInFlight = false;
      });
  };

  // Subscribe heartbeat's scope-cancellation to budget-exhausted signals so
  // hard-stop breaches interrupt in-flight work, not just preflight-block.
  onBudgetExhausted(async (scope) => {
    const cancelled = await heartbeat.cancelBudgetScopeWork(scope);
    if (cancelled > 0) {
      logger.warn(
        { scope, cancelled },
        "cancelled in-flight runs due to budget hard-stop",
      );
    }
  });

  // Reap orphaned runs at startup (no threshold -- runningProcesses is empty)
  void heartbeat.reapOrphanedRuns().catch((err) => {
    logger.error({ err }, "startup reap of orphaned heartbeat runs failed");
  });

  // Periodic sweep: mark stale workspaces as cleanup-eligible based on project TTL.
  // Sweeper no-ops when the instance-level experimental flag is off.
  scheduleTtlSweeper(db as any);

  // Periodic reap: destroy warm (reuse_by_agent) E2B snapshots left idle past
  // the instance TTL (~30 min). No-ops when `enableWarmSandboxReaper` is off,
  // exactly like the TTL sweeper above.
  scheduleWarmSandboxReaper(db as any);

  // Retry filesystem cleanup for workspaces stuck in `cleanup_failed` (Windows
  // file-handle races). Runs every 60s; promotes to `archived` once rm succeeds.
  scheduleCleanupRetrySweeper(db as any);

  // Detect heartbeat runs that are still marked `running` but have produced no
  // output for >30 min. Records a watchdog decision and snoozes re-evaluation
  // for 1 hr to avoid duplicate decisions. Observe-only — no recovery actions.
  registerHeartbeatWatchdogSweeper(db as any);

  setInterval(() => {
    const now = new Date();

    void heartbeat
      .tickTimers(now)
      .then((result) => {
        if (result.enqueued > 0) {
          logger.info({ ...result }, "heartbeat timer tick enqueued runs");
        }
      })
      .catch((err) => {
        logger.error({ err }, "heartbeat timer tick failed");
      });

    // Periodically reap orphaned runs (5-min staleness threshold)
    void heartbeat
      .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
      .catch((err) => {
        logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
      });

    // Promote max-turn continuations once their bounded retry delay has elapsed.
    void heartbeat
      .promoteDueScheduledRetries(now)
      .catch((err) => {
        logger.error({ err }, "heartbeat scheduled retry promotion failed");
      });

    // Tick scheduled routine triggers
    void routineService(db as any)
      .tickScheduledTriggers(now)
      .catch((err) => {
        logger.error({ err }, "routine scheduled trigger tick failed");
      });

    if (!monitorTickInFlight) {
      monitorTickInFlight = true;
      void db
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => Promise.all(rows.map((row) => monitorScheduler.triggerDueMonitors(row.id, { now }))))
        .catch((err) => {
          logger.error({ err }, "issue monitor scheduler tick failed");
        })
        .finally(() => {
          monitorTickInFlight = false;
        });
    }
  }, config.heartbeatSchedulerIntervalMs);

  runProductivityReviewReconciliation();
  setInterval(runProductivityReviewReconciliation, PRODUCTIVITY_REVIEW_RECONCILIATION_INTERVAL_MS);
}

// Idempotent backfill: ensure Commander and the appropriate crew roster exist
// for all companies. Safe to run on every startup — the seeders use
// ON CONFLICT DO NOTHING. Pre-existing companies miss this because the seeders
// also run during company creation.
// T3.5 / P8d / Phase 4B: the marketplace gate skips only the CREW roster.
// Commander is seeded for every company regardless; Steward is now owned by
// the marketplace default-crew package (or by the gated legacy fallback).
void db
  .select({ id: companies.id })
  .from(companies)
  .then(async (rows) => {
    for (const row of rows) {
      // Wrap each company independently: a failure for one company must never
      // abort the backfill for the remaining companies.
      try {
        await ensureInfrastructureAgents(db as any, row.id);
        // T3.5: skip the legacy crew seeders if marketplace governs this crew.
        if (await isCrewMarketplaceManaged(db as any, row.id)) {
          logger.debug({ companyId: row.id }, "crew startup backfill: skipping crew roster — marketplace governs");
          continue;
        }
        await ensureCrewAgents(db as any, row.id);
      } catch (err: unknown) {
        logger.warn({ err, companyId: row.id }, "crew startup backfill failed for company");
      }
    }
  })
  .catch((err) => logger.warn({ err }, "crew startup backfill failed"));

// Idempotent backfill: migrate the vestigial goals.parentId column into the
// goal_parents join table (multi-parent DAG; Decision #20 superseded 2026-05-25).
// Safe on every startup — ON CONFLICT DO NOTHING on the composite PK.
void backfillGoalParents(db as any)
  .then((res) => {
    if (res.inserted > 0) {
      logger.info({ inserted: res.inserted }, "goal_parents backfill complete");
    }
  })
  .catch((err) => logger.warn({ err }, "goal_parents startup backfill failed"));

// Idempotent backfill: ensure older companies and existing department projects
// have the expanded company brain folder seed template used by new companies.
void backfillMemoryFolderSeeds(db as any)
  .then((res) => {
    if (res.companies > 0 || res.departments > 0) {
      logger.info(res, "memory folder seed backfill complete");
    }
  })
  .catch((err) => logger.warn({ err }, "memory folder seed startup backfill failed"));

// Idempotent backfill: stamp @legacy templateOrigin onto pre-marketplace crew
// agents (kind='aoa', templateOrigin IS NULL). Runs once per deploy; second run
// updates 0 rows. Required so boot-time ensure guards can skip companies already
// on marketplace (T3.5) and the crew-updater can exclude legacy rows (T3.4).
void backfillCrewTemplateOrigin(db as any).catch((err: unknown) =>
  logger.warn({ err }, "crew templateOrigin backfill failed"),
);

// P1-T9 — idempotent backfill: mirror each company's vision/mission/values into
// layer='identity' memory items (the single home for company identity; the
// `companies` columns stay as a temporary mirror). Runs every boot; second run
// inserts 0 rows. Best-effort — never blocks startup.
void backfillAllCompaniesIdentityMemory(db as any)
  .then((res) => {
    if (res.items > 0) {
      logger.info(res, "company identity memory backfill complete");
    }
  })
  .catch((err: unknown) => logger.warn({ err }, "company identity memory backfill failed"));

// Idempotent backfill: reconcile every founder's fine-grained permission grants.
// ensureRealOperator historically seeded a founder's role + owner membership
// WITHOUT principal_permission_grants; on cloud_auth (canUser reads grants,
// isInstanceAdmin is false) such founders — including every founder on an
// instance flipped from `authenticated` → `cloud_auth` — get 403'd on every
// canUser-gated route. Seeds the missing founder grants ON CONFLICT DO NOTHING;
// second boot inserts 0 rows. Best-effort — never blocks startup.
void backfillFounderGrants(db as any)
  .then((res) => {
    if (res.granted > 0) {
      logger.info(res, "founder grants backfill complete");
    }
  })
  .catch((err: unknown) => logger.warn({ err }, "founder grants backfill failed"));

// WS0b — idempotent backfill: stamp firstRunCompletedAt=now() onto every
// onboarding_progress row that is already SETUP_COMPLETE (currentState OR
// completedStates) but predates the flag. Runs every boot; second run
// updates 0 rows. Required so pre-existing SETUP_COMPLETE rows aren't stuck
// showing Home first-run forever (Codex P1).
void backfillFirstRunCompleted(db as any).catch((err: unknown) =>
  logger.warn({ err }, "first-run-completed backfill failed"),
);

// WS0c — idempotent startup normalization: founder onboarding_progress rows
// still mid-wizard at the now-removed DEPARTMENT_CREATED/AGENT_ASSIGNED
// states get normalized to currentState="COMMANDER_VERIFIED" (NOT
// SETUP_COMPLETE — that would collide with the backfillFirstRunCompleted
// backfill above and auto-skip these founders past the new Home first-run
// experience; see normalize-legacy-onboarding-state.ts). Runs every boot;
// second run updates 0 rows.
void normalizeLegacyOnboardingState(db as any).catch((err: unknown) =>
  logger.warn({ err }, "legacy onboarding state normalization failed"),
);

// Idempotent backfill: stamp origin_kind='crew_thread' onto thread-deliverable
// tasks that were created before this field was introduced (source_discussion_id
// IS NOT NULL AND origin_kind IS NULL). Required so the crew board can filter
// correctly. Safe on every boot — second run updates 0 rows. (Decision D10)
void backfillCrewOriginKind(db as any)
  .then((res) => {
    if (res.updated > 0) {
      logger.info({ updated: res.updated }, "crew origin_kind backfill complete");
    }
  })
  .catch((err: unknown) =>
    logger.warn({ err }, "crew origin_kind backfill failed"),
  );

// Idempotent reconciliation: clamp autonomy_level > 2 → 2 in discussions and
// internal_agent_config. Rows written before the 0/1/2 (Manual/Assist/Drive)
// remap may hold the old value 3 ("Auto"). Safe on every boot — second run
// updates 0 rows.
void reconcileAutonomyScale(db as any)
  .then((res) => {
    if (res.discussionsUpdated > 0 || res.configUpdated > 0 || res.crewConfigUpdated > 0) {
      logger.info(res, "autonomy scale reconciliation complete");
    }
  })
  .catch((err: unknown) =>
    logger.warn({ err }, "autonomy scale reconciliation failed"),
  );

// Phase 4 STRANGLER dual-write: idempotent backfill of provider_connections +
// provider_assignments from the two legacy credential systems (company
// `provider:*` secrets → api_key connections; verified personal_subscription
// bindings → personal_subscription connections). Best-effort — a failure must
// NEVER block boot. Inserts with ON CONFLICT DO NOTHING behind the identity/scope
// uniques, so every re-run is a no-op. See provider-connections-backfill.ts.
void runProviderConnectionsBackfill(db as any, (level, msg, meta) =>
  level === "warn" ? logger.warn(meta ?? {}, msg) : logger.info(meta ?? {}, msg),
)
  .then((res) => {
    if (res.inserted > 0 || res.errors > 0) {
      logger.info(res, "provider-connections backfill complete");
    }
  })
  .catch((err: unknown) =>
    logger.warn({ err }, "provider-connections backfill failed"),
  );

// T3.5 / T3.x: Check all marketplace-installed crew agents for catalog updates.
// auto policy + within window → apply immediately (silent).
// notify policy → record pending_update + send updateAvailable notification.
const CREW_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function reportMarketplaceMaintenanceResult(
  result: Awaited<ReturnType<typeof runMarketplaceCrewMaintenance>>,
): void {
  if (result.failures.length > 0) {
    logger.warn(
      { failures: result.failures },
      "marketplace crew maintenance completed with company failures",
    );
  }
  if (result.teamReconcile.membersAdded > 0) {
    logger.info(
      result.teamReconcile,
      "marketplace: team roster reconciliation added missing members",
    );
  }
}

async function runCrewUpdateCheck(): Promise<void> {
  try {
    const catalog = await loadCachedCatalog(db as any);
    if (!catalog) return;

    // Shared with POST /api/admin/marketplace/reconcile. Scheduled runs retain
    // the existing repair budget/cooldown and consume no network for catalog
    // discovery; the admin operation refreshes first and uses manual mode.
    const result = await runMarketplaceCrewMaintenance({
      db: db as any,
      catalogItems: catalog.items,
      mode: "scheduled",
    });
    reportMarketplaceMaintenanceResult(result);
  } catch (err) {
    logger.warn(
      { error: serializeSafeError(err) },
      "crew update check failed",
    );
  }
}

async function runInitialCrewUpdateCheck(): Promise<void> {
  try {
    const catalogService = getMarketplaceCatalogService();
    if (!catalogService) {
      logger.warn(
        "marketplace catalog service unavailable during startup maintenance",
      );
      return;
    }
    const result = await runStartupMarketplaceMaintenance({
      db: db as any,
      catalogService,
    });
    if (!result) {
      logger.warn(
        "marketplace startup maintenance skipped because the initial catalog refresh produced no catalog",
      );
      return;
    }
    reportMarketplaceMaintenanceResult(result);
  } catch (err) {
    logger.warn(
      { error: serializeSafeError(err) },
      "initial marketplace crew maintenance failed",
    );
  }
}

void runInitialCrewUpdateCheck();
setInterval(
  () =>
    void runCrewUpdateCheck().catch((err) =>
      logger.warn(
        { error: serializeSafeError(err) },
        "crew update check interval failed",
      ),
    ),
  CREW_UPDATE_CHECK_INTERVAL_MS,
);

// File import queue worker
void resetStuckJobs(db as any).catch((err) =>
  logger.warn({ err }, "resetStuckJobs on startup failed"),
);
let fileImportTickInFlight = false;
setInterval(() => {
  if (fileImportTickInFlight) return;
  fileImportTickInFlight = true;
  void processFileImportQueue(db as any, storageService)
    .catch((err) => logger.warn({ err }, "processFileImportQueue tick failed"))
    .finally(() => { fileImportTickInFlight = false; });
}, WORKER_INTERVAL_MS);
// No immediate first tick — the first interval fires at T+15s, which is acceptable
// since resetStuckJobs already ran synchronously above

// P1-2: Recover embedding_queue rows that were stuck in 'processing' by a
// previous worker crash. Rows that have been 'processing' for >5 minutes are
// reset to 'pending' so the next tick can pick them up. Best-effort — a
// failure here must NOT block server startup.
void resetStaleProcessing(db as any)
  .then((res) => {
    if (res.reset > 0) {
      logger.info({ reset: res.reset }, "startup: recovered stale processing embedding rows");
    }
  })
  .catch((err: unknown) =>
    logger.warn({ err }, "resetStaleProcessing on startup failed (non-fatal)"),
  );

// Idempotent backfill: stamp company_id onto pre-keyless embedding_queue rows
// so the per-company key resolver (Task 10) can look up the right key.
// Best-effort — a failure here must NOT block server startup.
void backfillQueueCompanyIds(db as any)
  .then((res) => {
    if (res.updated > 0) {
      logger.info({ updated: res.updated }, "embedding_queue company_id backfill complete");
    }
  })
  .catch((err: unknown) =>
    logger.warn({ err }, "embedding_queue company_id backfill failed"),
  );

// Periodic reconciliation sweep (Task W4, keyless-except-embeddings).
// Finds null-vector memory_items that were never enqueued (e.g. created before
// the write-path hook was wired) and enqueues them. Belt-and-suspenders.
// 10-minute cadence is frequent enough to catch stragglers without adding load.
// Best-effort — a failure here must NOT block any other functionality.
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const reconcileTimer = setInterval(() => {
  // P1-2: Reset any rows that got stuck in 'processing' since the last tick
  // (e.g. from a worker crash). Run before reconcileNullVectors so recovered
  // rows are immediately eligible for the upcoming enqueue sweep.
  void resetStaleProcessing(db as any)
    .then((res) => {
      if (res.reset > 0) {
        logger.info({ reset: res.reset }, "periodic sweep: recovered stale processing embedding rows");
      }
    })
    .catch((err: unknown) =>
      logger.warn({ err }, "resetStaleProcessing sweep failed (non-fatal)"),
    );
  void reconcileNullVectors(db as any)
    .then((res) => {
      if (res.enqueued > 0) {
        logger.info({ enqueued: res.enqueued }, "reconcileNullVectors: enqueued missing embeddings");
      }
    })
    .catch((err: unknown) =>
      logger.warn({ err }, "reconcileNullVectors sweep failed (non-fatal)"),
    );
}, RECONCILE_INTERVAL_MS);
process.once("SIGTERM", () => clearInterval(reconcileTimer));
process.once("SIGINT", () => clearInterval(reconcileTimer));

// Write-behind embedding queue worker (Task B1 + Task 10, Decision D2).
// Drains rows from `embedding_queue` and UPDATEs the target row's vector
// column. Per-company key resolution: each row's companyId is used to look
// up the company's `llm:openai` Settings secret, falling back to the env
// OPENAI_API_KEY. Rows with no resolvable key are left pending (not failed)
// until a key is configured. 2-second tick is fast enough to keep
// find-similar staleness to a few seconds for typical traffic.
const embeddingWorker = startEmbeddingWorker(db as any, {
  intervalMs: 2000,
  resolveCompanyKey: async (companyId: string | null): Promise<string | null> => {
    if (companyId) {
      try {
        return await getProviderApiKey(db as any, companyId, "openai");
      } catch {
        // No key in company_secrets — fall through to env fallback.
      }
    }
    return process.env.OPENAI_API_KEY ?? null;
  },
});
// Best-effort stop on SIGTERM/SIGINT — the shared shutdown handlers below
// already exit the process, but this lets the in-flight tick log cleanly.
process.once("SIGTERM", () => embeddingWorker.stop());
process.once("SIGINT", () => embeddingWorker.stop());

// Mention-outbox drain worker (PR #291 round-6 #3). Drains
// `discussion_mention_outbox` — the transactional summon rows enqueued in
// addEntry's tx — and runs processMentions exactly-once (FOR UPDATE SKIP LOCKED
// claim + mark-'done'). Replaces the route-level fire-and-forget summon that was
// lost on failure and skipped by a same-key replay.
const mentionOutboxWorker = startMentionOutboxWorker(db as any, { intervalMs: 2000 });
process.once("SIGTERM", () => mentionOutboxWorker.stop());
process.once("SIGINT", () => mentionOutboxWorker.stop());

// Comment-wakeup-outbox drain worker (PR #291 round-16). Drains
// `comment_wakeup_outbox` — the PER-TARGET comment agent-wakeup rows enqueued in
// addComment's tx — and dispatches each exactly-once (FOR UPDATE SKIP LOCKED
// claim + owner-guarded mark-'done'). Replaces the comment-wide wakeups_enqueued_at
// marker + CAS, closing the crash-loses-summon and partial-failure-double-wake
// residuals (per-target completion + worker retry).
const commentWakeupOutboxWorker = startCommentWakeupOutboxWorker(db as any, { intervalMs: 2000 });
process.once("SIGTERM", () => commentWakeupOutboxWorker.stop());
process.once("SIGINT", () => commentWakeupOutboxWorker.stop());

// Commander CLI-login reaper (Plan 3 / §6.2 Task 4, from PR #292). A detached
// `claude login` / `codex login` child can outlive a hard restart with no
// in-memory handle to kill it, so at boot we terminate any persisted `pending`
// challenge child by PID and clear its row. Runs unconditionally (independent of
// the heartbeat scheduler). On shutdown, the same reap terminates in-flight
// login children.
const commanderLoginReaper = buildCommanderLoginService(db as any);
void commanderLoginReaper.reapOrphans().catch((err) => {
  logger.error({ err }, "startup reap of orphaned Commander login challenges failed");
});
process.once("SIGTERM", () => void commanderLoginReaper.reapOrphans().catch(() => {}));
process.once("SIGINT", () => void commanderLoginReaper.reapOrphans().catch(() => {}));

// Notification delivery retry worker (Phase G2, T26).
// Sweeps `notifications` rows where `delivery_error IS NOT NULL AND
// delivered_at IS NULL AND delivery_attempts < MAX_DELIVERY_ATTEMPTS` on
// a 60-second cadence. Disabled by setting NOTIFICATION_RETRY_ENABLED="false".
const notificationRetryEnabled = process.env.NOTIFICATION_RETRY_ENABLED !== "false";
const notificationRetryTimer = notificationRetryEnabled
  ? scheduleNotificationRetryWorker(db as any)
  : null;
if (notificationRetryTimer) {
  process.once("SIGTERM", () => clearInterval(notificationRetryTimer));
  process.once("SIGINT", () => clearInterval(notificationRetryTimer));
}

// Thread event listener singleton (Task B2, T12, Decisions D5+D7).
// In-memory 30s debounce on human-authored discussion entries. When the
// debounce fires, inserts an Adjutant wakeup row guarded by A4's dedupKey
// partial unique index. discussions.addEntry imports getThreadEventListener()
// to push events here — the singleton MUST be initialized before the HTTP
// server starts accepting requests so the first addEntry call finds it.
const threadEventDebounceMs = Number(process.env.AOA_THREAD_EVENT_DEBOUNCE_MS);
const threadEventListener = initThreadEventListener(
  db as any,
  Number.isFinite(threadEventDebounceMs) && threadEventDebounceMs >= 0
    ? { debounceMs: threadEventDebounceMs }
    : undefined,
);
process.once("SIGTERM", () => threadEventListener.shutdown());
process.once("SIGINT", () => threadEventListener.shutdown());

// Reclaim orphaned per-run Claude config homes (`os.tmpdir()/aoa-claude-config-*`).
//
// 🚨 REGISTERED HERE, WITH CREW DISPATCH — deliberately NOT inside the
// `config.heartbeatSchedulerEnabled` block above. What mints these directories
// is a CREW run, and crew dispatch is the unconditional sweep below
// (`runExtractionSweep` → `runAoaDispatch`), not the heartbeat scheduler. Under
// HEARTBEAT_SCHEDULER_ENABLED=false a heartbeat-gated registration would leave
// crew runs still writing the operator's Claude credential into tmpdir with
// nothing ever reclaiming it — exactly the credentials-at-rest state this sweep
// exists to prevent. Keep its lifetime tied to whatever schedules crew dispatch.
//
// Sweeps once at boot (clearing whatever a crash or SIGKILL left behind while
// the server was down), then hourly. Best-effort — it cannot block or fail boot.
scheduleClaudeConfigDirSweeper();

// Sub-agent #1: durable discussion-extraction sweeper (primary trigger).
// Polls discussion_entries.extractionStatus='pending' (+ reclaims orphaned
// 'processing') and runs extraction via the consumer under a bounded limiter.
// Idempotency-safe alongside the reprocess path via the M2 atomic claim.
const EXTRACTION_SWEEP_INTERVAL_MS = 45_000;
let extractionSweepInFlight = false;
setInterval(() => {
  if (extractionSweepInFlight) return;
  extractionSweepInFlight = true;
  void runExtractionSweep(db as any, { limiterMax: 4, staleMs: 10 * 60 * 1000 })
    .catch((err) => logger.warn({ err }, "extraction sweep tick failed"))
    .finally(() => { extractionSweepInFlight = false; });
}, EXTRACTION_SWEEP_INTERVAL_MS);

// Sub-agent #2: periodic adjutant sweep — checks thread health, advances phases or nudges.
const ADJUTANT_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let adjutantSweepInFlight = false;
setInterval(() => {
  if (adjutantSweepInFlight) return;
  adjutantSweepInFlight = true;
  void runAdjutantSweep(db as any)
    .catch((err) => logger.warn({ err }, "adjutant sweep tick failed"))
    .finally(() => { adjutantSweepInFlight = false; });
}, ADJUTANT_SWEEP_INTERVAL_MS);

// Sub-agent #3: controller backstop sweep — drains controller-path threads whose
// inline drain (thread-events) crashed or was missed (pendingRun still true). The
// inline fire-and-forget runController call is the primary, immediate driver; this
// is the safety net. The atomic claim inside runController serializes the sweep
// against the inline drain — only one caller wins per thread, no double-execution.
const CONTROLLER_SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let controllerSweepInFlight = false;
setInterval(() => {
  if (controllerSweepInFlight) return;
  controllerSweepInFlight = true;
  void runControllerSweep(db as any)
    .catch((err) => logger.warn({ err }, "controller sweep tick failed"))
    .finally(() => { controllerSweepInFlight = false; });
}, CONTROLLER_SWEEP_INTERVAL_MS);

// Sub-agent #4: periodic Memory Keeper sweep (T1.4 part 1).
// 4hr cadence — eng-review D10's cost analysis showed naive 30-min sweeping
// scales to ~$240/day for a company with 50 active threads. 4hr is the cost-
// vs-freshness sweet spot for memory pattern detection: founders edit memory
// items once a week on average; missing a pattern by ≤4hr is fine. Event-
// driven entry.added wakeups (T1.4 part 2) will layer on top for faster
// reaction; this sweep is the safety floor that catches aging patterns on
// quiet threads. MK_SWEEP_DEBOUNCE_MS matches this cadence (4hr) so each
// active thread gets exactly one MK wakeup per cycle.
const MEMORY_KEEPER_SWEEP_INTERVAL_MS = MK_SWEEP_DEBOUNCE_MS; // 4 hours
let memoryKeeperSweepInFlight = false;
setInterval(() => {
  if (memoryKeeperSweepInFlight) return;
  memoryKeeperSweepInFlight = true;
  void runMemoryKeeperSweep(db as any)
    .catch((err) => logger.warn({ err }, "memory keeper sweep tick failed"))
    .finally(() => { memoryKeeperSweepInFlight = false; });
}, MEMORY_KEEPER_SWEEP_INTERVAL_MS);

// Sub-agent #5: inbox routing backstop sweep (Task 1.4).
// PRIMARY driver: fire-and-forget in inbox-producer.ts (immediate on insert).
// This sweep is the SAFETY NET: catches thread_inbox_items rows with
// routingStatus='pending_route' whose async route never ran (crash, restart,
// or transient import failure). Serialized by routeInboxItem's idempotency
// guard (Codex #9) — concurrent calls from the async trigger and the sweep
// cannot double-route the same item.
// Cadence: 2 minutes — mirrors the controller backstop sweep (same intent: catch
// items whose primary trigger missed). The sweep only touches pending_route rows
// so it's cheap even if empty; no in-flight guard needed (each routeInboxItem
// call atomically claims and transitions the row).
const INBOX_SWEEP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let inboxSweepInFlight = false;
setInterval(() => {
  if (inboxSweepInFlight) return;
  inboxSweepInFlight = true;
  void runInboxSweep(db as any)
    .catch((err) => logger.warn({ err }, "inbox routing sweep tick failed"))
    .finally(() => { inboxSweepInFlight = false; });
}, INBOX_SWEEP_INTERVAL_MS);

// Sub-agent #6: Steward curation backstop sweep.
// Deterministic hub curation is cheap and display-only; LLM wakeups are deduped
// per group via agentWakeupRequests.dedupKey so repeated ticks do not flood.
let stewardSweepInFlight = false;
setInterval(() => {
  if (stewardSweepInFlight) return;
  stewardSweepInFlight = true;
  void runStewardSweep(db as any)
    .catch((err) => logger.warn({ err }, "steward sweep tick failed"))
    .finally(() => { stewardSweepInFlight = false; });
}, STEWARD_SWEEP_INTERVAL_MS);

setInterval(() => {
  runChroniclerSweep(db as any).catch((err: unknown) =>
    logger.warn({ err }, "chronicler sweep error"),
  );
}, CHRONICLER_SWEEP_INTERVAL_MS);

const RUNTIME_DECISION_TIMEOUT_SWEEP_INTERVAL_MS = 30 * 1000;
const RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT = 100;
const RUNTIME_DECISION_TIMEOUT_SWEEP_MAX_BATCHES = 10; // <= 1000 rows/tick ceiling
let runtimeDecisionTimeoutSweepInFlight = false;
const runtimeDecisionTimeoutHeartbeat = heartbeatService(db as any);
setInterval(() => {
  if (runtimeDecisionTimeoutSweepInFlight) return;
  runtimeDecisionTimeoutSweepInFlight = true;
  void (async () => {
    const svc = agentRuntimeDecisionService(db as any, {
      runCanceller: async ({ runId }) => {
        await runtimeDecisionTimeoutHeartbeat.cancelRun(runId);
      },
    });
    for (let batch = 0; batch < RUNTIME_DECISION_TIMEOUT_SWEEP_MAX_BATCHES; batch++) {
      const { processed } = await svc.expireDuePrompts({ limit: RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT });
      if (processed < RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT) break;
    }
    // R2 stranded-answer sweep (P3-4): cancel + close answered/relay_failed
    // decisions whose run went terminal before the answer could be relayed —
    // invisible to expireDuePrompts (created/shown only).
    for (let batch = 0; batch < RUNTIME_DECISION_TIMEOUT_SWEEP_MAX_BATCHES; batch++) {
      const { processed } = await svc.sweepStrandedAnswers({ limit: RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT });
      if (processed < RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT) break;
    }
  })()
    .catch((err: unknown) => logger.warn({ err }, "runtime decision timeout sweep failed"))
    .finally(() => {
      runtimeDecisionTimeoutSweepInFlight = false;
    });
}, RUNTIME_DECISION_TIMEOUT_SWEEP_INTERVAL_MS);

// Operator break-glass sweeper (Phase 3, B3). Deletes the ORGANIZATION
// membership materialized for a grant once the grant is past expiry or revoked,
// then marks the grant swept. Authorization itself is TTL-checked live at each
// access (hasActiveBreakGlass); this sweep is the janitor that reclaims the
// standing tenant-access row afterward. Runs once at boot (clears anything a
// crash left behind) then every 60s. Best-effort — never blocks or fails boot.
// .unref() so it cannot keep the process alive on shutdown.
{
  const breakGlass = operatorBreakGlassService(db as any, realBreakGlassDeps(db as any));
  void breakGlass.sweepExpired().catch((err: unknown) =>
    logger.warn({ err }, "operator break-glass sweep (boot) failed"),
  );
  let breakGlassSweepInFlight = false;
  setInterval(() => {
    if (breakGlassSweepInFlight) return;
    breakGlassSweepInFlight = true;
    void breakGlass
      .sweepExpired()
      .catch((err: unknown) => logger.warn({ err }, "operator break-glass sweep tick failed"))
      .finally(() => {
        breakGlassSweepInFlight = false;
      });
  }, 60_000).unref();
}

if (config.databaseBackupEnabled) {
  const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
  let backupInFlight = false;

  const runScheduledBackup = async () => {
    if (backupInFlight) {
      logger.warn("Skipping scheduled database backup because a previous backup is still running");
      return;
    }

    backupInFlight = true;
    try {
      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retention: DEFAULT_BACKUP_RETENTION,
        filenamePrefix: "aoa",
      });
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
        },
        `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
    } finally {
      backupInFlight = false;
    }
  };

  logger.info(
    {
      intervalMinutes: config.databaseBackupIntervalMinutes,
      retention: DEFAULT_BACKUP_RETENTION,
      backupDir: config.databaseBackupDir,
    },
    "Automatic database backups enabled",
  );
  setInterval(() => {
    void runScheduledBackup();
  }, backupIntervalMs);
}

server.listen(listenPort, config.host, () => {
  logger.info(`Server listening on ${config.host}:${listenPort}`);
  if (process.env.AOA_OPEN_ON_LISTEN === "true") {
    const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const url = `http://${openHost}:${listenPort}`;
    void import("open")
      .then((mod) => mod.default(url))
      .then(() => {
        logger.info(`Opened browser at ${url}`);
      })
      .catch((err) => {
        logger.warn({ err, url }, "Failed to open browser on startup");
      });
  }
  printStartupBanner({
    host: config.host,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authReady,
    requestedPort: config.port,
    listenPort,
    uiMode,
    db: startupDbInfo,
    migrationSummary,
    hasVectorSupport: getDbCapabilities().hasVectorSupport,
    heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
    heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
    databaseBackupEnabled: config.databaseBackupEnabled,
    databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
    databaseBackupDir: config.databaseBackupDir,
  });

  // Bootstrap plugin subsystem after server is listening
  const pluginSys = (app as any).__pluginSubsystem;
  if (pluginSys) {
    pluginSys.jobScheduler.start();
    pluginSys.jobCoordinator.start();
    pluginSys.loader.loadAll().catch((err: unknown) => {
      logger.error({ err }, "Plugin loadAll failed at startup");
    });
    logger.info("Plugin subsystem initialized");
  }

  const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
  if (boardClaimUrl) {
    const red = "\x1b[41m\x1b[30m";
    const yellow = "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      [
        `${red}  BOARD CLAIM REQUIRED  ${reset}`,
        `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
        `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
        `${yellow}${boardClaimUrl}${reset}`,
        `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
      ].join("\n"),
    );
  }
});

const shutdown = createProcessShutdownHandler({
  getPluginSubsystem: () => (app as any).__pluginSubsystem,
  ownedEmbeddedPostgres:
    embeddedPostgres && embeddedPostgresStartedByThisProcess
      ? embeddedPostgres
      : null,
  logger,
  exit: (code) => process.exit(code),
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

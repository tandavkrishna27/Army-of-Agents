import express, { Router, type Request as ExpressRequest } from "express";
import helmet from "helmet";
import type { KeyObject } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@armyofagents/db";
import type {
  DeploymentExposure,
  DeploymentMode,
  PaperclipPluginManifestV1,
} from "@armyofagents/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { tenantContextMiddleware } from "./middleware/tenant-context.js";
import {
  setDeploymentMode,
  tenantIsolationEnforced,
} from "./config/deployment-mode.js";
import { stripHostedPluginWorkerMarker } from "./services/cloud-plugin-execution.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import {
  privateHostnameGuard,
  resolvePrivateHostnameAllowSet,
} from "./middleware/private-hostname-guard.js";
import { buildHelmetOptions } from "./services/helmet-options.js";
import { extractInlineScriptHashes } from "./services/csp-script-hashes.js";
import { healthRoutes } from "./routes/health.js";
import {
  readinessRoutes,
  readinessGate,
  alwaysReadyProbe,
  type ReadinessProbe,
} from "./routes/readiness.js";
import { onboardingJourneyRoutes } from "./routes/onboarding-journey.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { onboardingJoinRoutes } from "./routes/onboarding-join.js";
import {
  testSupportEnabled,
  testSupportRoutes,
} from "./routes/test-support.js";
import { onboardingEnvironmentRoutes } from "./routes/onboarding-environment.js";
import { commanderVerifyRoutes } from "./routes/commander-verify.js";
import { commanderKeyRoutes } from "./routes/commander-key.js";
import { commanderLoginRoutes } from "./routes/commander-login.js";
import { providerCredentialRoutes } from "./routes/provider-credentials.js";
import { providerConnectionRoutes } from "./routes/provider-connections.js";
import { resolveCliAuthTopology } from "./services/cli-auth-topology.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { operationsHealthRoutes } from "./routes/operations-health.js";
import { companyRoutes } from "./routes/companies.js";
import { organizationRoutes } from "./routes/organizations.js";
import { jobControlRoutes } from "./routes/job-control.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { goalRoutes } from "./routes/goals.js";
import { mcpConnectorRoutes } from "./routes/mcp-connectors.js";
import { braindumpRoutes } from "./routes/braindump.js";
import { hubItemRoutes } from "./routes/hub-items.js";
import { hubAutopilotRoutes } from "./routes/hub-autopilot.js";
import { agentRuntimeDecisionRoutes } from "./routes/agent-runtime-decisions.js";
import { workQuestionRoutes } from "./routes/work-questions.js";
import { teamsRoutes } from "./routes/teams.js";
import { teamImportsRoutes } from "./routes/team-imports.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { githubRoutes } from "./routes/github.js";
import { projectGitRoutes } from "./routes/project-git.js";
import { costRoutes } from "./routes/costs.js";
import { financeRoutes } from "./routes/finance.js";
import { quotaRoutes } from "./routes/quotas.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferencesRoutes } from "./routes/sidebar-preferences.js";
import { homeBoardLayoutRoutes } from "./routes/home-board-layout.js";
import { universeLayoutRoutes } from "./routes/universe-layout.js";
import { universeDraftsRoutes } from "./routes/universe-drafts.js";
import { universeAttentionRoutes } from "./routes/universe-attention.js";
import { universeCatchupRoutes } from "./routes/universe-catchup.js";
import { universeIntakeRoutes } from "./routes/universe-intake.js";
import { universePreferenceRoutes } from "./routes/universe-preferences.js";
import { viewerPreferencesRoutes } from "./routes/viewer-preferences.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { userEntityPinRoutes } from "./routes/user-entity-pins.js";
import { userNoteRoutes } from "./routes/user-notes.js";
import { cockpitRoutes } from "./routes/cockpit.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { memoryRoutes } from "./routes/memory.js";
import { memorySettingsRoutes } from "./routes/memory-settings.js";
import { searchRoutes } from "./routes/search.js";
import { debriefRoutes } from "./routes/debriefs.js";
import { briefRoutes } from "./routes/briefs.js";
import { routineRoutes } from "./routes/routines.js";
import { dependencyRoutes } from "./routes/dependencies.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { taskOutputRoutes } from "./routes/task-outputs.js";
import { outputDetectionRoutes } from "./routes/output-detection.js";
import { trustScoreRoutes } from "./routes/trust-scores.js";
import { transcriptionRoutes } from "./routes/transcription.js";
import { memoryFeedbackRoutes } from "./routes/memory-feedback.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { memoryLifecycleRoutes } from "./routes/memory-lifecycle.js";
import { memoryRetrievalsRoutes } from "./routes/memory-retrievals.js";
import { memoryStarterTemplatesRoutes } from "./routes/memory-starter-templates.js";
import { fileImportRoutes } from "./routes/file-import.js";
import { memoryFoldersRoutes } from "./routes/memory-folders.js";
import { memoryAssetsRoutes } from "./routes/memory-assets.js";
import { memoryAssetsUploadRoutes } from "./routes/memory-assets-upload.js";
import { memoryAssetRenderRoutes } from "./routes/memory-asset-render.js";
import { suggestionRoutes } from "./routes/suggestions.js";
import { contextPackagingRoutes } from "./routes/context-packaging.js";
import { mcpServerRoutes } from "./mcp/server.js";
import { teamRoutes } from "./routes/team.js";
import { discussionRoutes } from "./routes/discussions.js";
import { notificationPreferenceRoutes } from "./routes/notification-preferences.js";
import { notificationRoutes } from "./routes/notifications.js";
import { internalAgentRoutes } from "./routes/internal-agent.js";
import { internalSweepsDevRoutes } from "./routes/internal-sweeps-dev.js";
import { workflowTemplateRoutes } from "./routes/workflow-templates.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { cliAuthRoutes } from "./routes/cli-auth.js";
import { authProfileRoutes } from "./routes/auth-profile.js";
import { environmentRoutes } from "./routes/environments.js";
import { orgSpendRoutes } from "./routes/org-spend.js";
import { executionTargetRoutes } from "./routes/execution-targets.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { workspaceGitRoutes } from "./routes/workspace-git.js";
import { filesystemRoutes } from "./routes/filesystem.js";
import { companyWorkspaceFsRoutes } from "./routes/company-workspace-fs.js";
import { createPreviewRouter } from "./routes/preview.js";
import { runtimeHooksRoutes } from "./routes/runtime-hooks.js";
import { adapterRoutes } from "./routes/adapters.js";
import {
  pluginRoutes,
  pluginCompanySettingsRoutes,
  buildCloudPluginDenialLoader,
  buildCloudPluginDenialLifecycle,
} from "./routes/plugins.js";
import { companyPluginRoutes } from "./routes/company-plugins.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { createMarketplaceRouter } from "./routes/marketplace.js";
import { createAdminMarketplaceRouter } from "./routes/admin-marketplace.js";
import { createMarketplaceInstallRouter } from "./routes/marketplace-installs.js";
import { createMarketplaceCompanyRouter } from "./routes/marketplace-company.js";
import { providerRoutes } from "./routes/providers.js";
import {
  MarketplaceCatalogService,
  registerMarketplaceCatalogService,
} from "./services/aoa-marketplace.js";
import {
  inspectMarketplaceReconciliation,
  runMarketplaceReconciliation,
} from "./services/marketplace-reconcile.js";
import { pluginLoader } from "./services/plugin-loader.js";
import { pluginRollbackService } from "./services/plugin-rollback.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { createPluginStreamBus } from "./services/plugin-stream-bus.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { createPluginJobCoordinator } from "./services/plugin-job-coordinator.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { createPluginToolDispatcher } from "./services/plugin-tool-dispatcher.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { buildHostServices } from "./services/plugin-host-services.js";
import { createPluginHostServiceCleanup } from "./services/plugin-host-service-cleanup.js";
import { guardPluginHostHandlers } from "./services/plugin-availability.js";
import {
  SPA_FALLBACK_ROUTE,
  spaFallbackHandler,
} from "./services/spa-fallback.js";
import { createHostClientHandlers } from "@armyofagents/plugin-sdk";
import { resolveAoaInstanceId } from "./home-paths.js";
import {
  WORKER_CONTROL_BODY_LIMIT_BYTES,
  WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES,
  WORKER_CONTROL_EVENTS_PATH,
  WORKER_CONTROL_INFLATE,
  WORKER_CONTROL_PATH_PREFIX,
} from "./worker-control-body-limits.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
// JobReadyScheduler / JobControlMetrics are used ONLY as types (inline `import(...)`
// annotations below). Keeping them out of the static import list satisfies the
// flag-off import-graph guard (tenant-app-db-startup.test.ts) that forbids the E3
// job-control runtime graph from loading during flag-off bootstrap; the real load
// is the lazy `await import(...)` inside the flag-on branch.

// Host version reported to plugin workers during initialize. Read from
// server package.json at import time; falls back to "0.0.0" if unreadable.
const SERVER_VERSION = (() => {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Try dist location (server/dist/app.js -> server/package.json) and source
    // location (server/src/app.ts -> server/package.json)
    const candidates = [
      path.resolve(__dirname, "../package.json"),
      path.resolve(__dirname, "../../package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf-8")) as {
          version?: string;
        };
        if (pkg.version) return pkg.version;
      }
    }
  } catch {
    // ignore
  }
  return "0.0.0";
})();

type UiMode = "none" | "static" | "vite-dev";

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    storageService: StorageService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    companyWorkspaceBaseDir: string;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    trustProxy: boolean | number | string[];
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (
      req: ExpressRequest
    ) => Promise<BetterAuthSessionResult | null>;
    devLocalIdentity?: boolean;
    distributedExecutionEnabled?: boolean;
    tenantAppDb?: Db;
    operatorDb?: Db;
    jobReadyScheduler?: import("./services/job-ready-scheduler.js").JobReadyScheduler;
    jobControlMetrics?: import("./services/job-control-metrics.js").JobControlMetrics;
    workerSessionSigningKey?: string;
    /** DEP-012 Slice 4+5 — the control-plane ed25519 PRIVATE key that MINTS the inert
     * owned-labels capability in the sandbox-local resolve reply (threaded to
     * workerControlRoutes -> the secret broker). Absent ⇒ the reply carries no capability
     * (byte-identical to pre-DEP-011). Loaded + validated at the composition root. */
    controlPlaneSigningKey?: KeyObject;
    /** CLI-006 (2b) — after-commit projection of a distributed attempt's terminal
     * onto its canary-owned heartbeat run. Composed at the root BEFORE createApp
     * (2b-D1) because the ingest service is built here, three hops down. Absent
     * (the default) leaves ingest behaving exactly as it did pre-CLI-006. */
    onAttemptTerminal?: import("./services/job-events.js").JobEventIngestTerminalHook;
    // DEP-003 (E6 deployment harness): optional readiness contract. When omitted the
    // app is unchanged except the additive always-ready `/api/ready` + `/api/health/live`
    // routes; the 503 readiness gate is DORMANT. When provided with `gateEnabled:true`
    // the gate 503s tenant/app routes until the probe reports ready.
    readiness?: {
      probe: ReadinessProbe;
      gateEnabled: boolean;
    };
  }
) {
  // Pin the STATIC deployment-mode enforcement source once at boot, before any
  // router mounts. tenantIsolationEnforced() reads this — never req.tenant —
  // so authz/rbac/access fail closed even if per-request middleware is skipped.
  setDeploymentMode(opts.deploymentMode);

  const app = express();
  app.set("trust proxy", opts.trustProxy);

  // Resolve the UI dist directory up-front so CSP can extract inline-script
  // hashes from index.html before the helmet middleware mounts. We try the
  // published location first (server/ui-dist/, where the npm build ships
  // the SPA bundle) then the monorepo dev location (../../ui/dist).
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const uiDistCandidates = [
    path.resolve(__dirname, "../ui-dist"),
    path.resolve(__dirname, "../../ui/dist"),
  ];
  const uiDistDir =
    opts.uiMode === "static"
      ? uiDistCandidates.find((p) => fs.existsSync(path.join(p, "index.html")))
      : undefined;

  // Inline-script hashes for CSP `script-src 'sha256-...'`. Empty array in
  // vite-dev mode (CSP is skipped) and when the dist file is missing
  // (`extractInlineScriptHashes` returns [] with a warn log).
  const inlineScriptHashes = uiDistDir
    ? await extractInlineScriptHashes(path.join(uiDistDir, "index.html"))
    : [];

  // Capture raw request body bytes so plugin webhook handlers can verify HMAC
  // signatures against the exact bytes the provider signed. Without this,
  // (req as any).rawBody is undefined and signature verification breaks.
  const captureRawBody = (
    req: express.Request,
    _res: express.Response,
    buf: Buffer
  ) => {
    if (buf && buf.length > 0) {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    }
  };
  // Per-route body-size cap for company-bundle import. The global default
  // (100KB) is too small for legitimate bundles; 20MB sits above realistic
  // worst-case payloads (per the 10K cost-events warn threshold + the Zod
  // array caps in packages/shared/src/validators/company-portability.ts) and
  // below typical reverse-proxy / LB ceilings. Mounting before the global
  // express.json() ensures it wins on the matching paths.
  app.use(
    ["/api/companies/import", "/api/companies/import/preview"],
    express.json({ limit: "20mb", verify: captureRawBody })
  );
  app.use(httpLogger);
  // Strict CSP + tightened cross-origin policies in production deployment
  // modes. Vite-HMR dev (local_trusted + non-production node env) skips CSP
  // because HMR's runtime needs inline scripts + WebSocket + eval.
  // See `services/helmet-options.ts` for the full directive set.
  app.use(
    helmet(
      buildHelmetOptions({
        deploymentMode: opts.deploymentMode,
        uiMode: opts.uiMode,
        nodeEnv: process.env.NODE_ENV,
        inlineScriptHashes,
      })
    )
  );
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" &&
    opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    })
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      devLocalIdentity: opts.devLocalIdentity,
      resolveSession: opts.resolveSession,
    })
  );
  // Reserved per-request tenant hint (req.tenant). NOT the enforcement source —
  // isolation is driven by the static tenantIsolationEnforced(). Mounted after
  // actorMiddleware (needs the actor) and before boardMutationGuard.
  app.use(tenantContextMiddleware());
  // Runtime previews are a streaming proxy, not JSON API routes. Mount before
  // the global body parser so POST/PUT/uploads reach the upstream unchanged.
  app.use("/preview", createPreviewRouter(db));
  // BRW-003d-1 — worker-control body limits, DERIVED from the frozen
  // OPERATION_DESCRIPTORS. See ./worker-control-body-limits.ts for why the limit
  // must EXCEED the contract ceiling rather than equal it (a mount equal to the
  // ceiling leaves the handler's guard dead and only moves the wrong-shaped
  // refusal), and why `inflate` is off (a measured 1019.8:1 gzip amplification
  // on a surface whose authorization is checked inside the handler, after parse).
  //
  // Mounted BEFORE the global express.json() below so it wins on these paths.
  // The /events mount is registered before the prefix mount because express
  // matches in registration order and only event_upload needs the wide limit.
  //
  // Gated on the same flag as the routes: when distributed execution is off the
  // worker-control paths 404 at the catch-all, but middleware still runs first,
  // so an ungated mount would buffer megabytes for a path that answers 404.
  if (opts.distributedExecutionEnabled) {
    app.use(
      WORKER_CONTROL_EVENTS_PATH,
      express.json({
        limit: WORKER_CONTROL_EVENTS_BODY_LIMIT_BYTES,
        inflate: WORKER_CONTROL_INFLATE,
        verify: captureRawBody,
      })
    );
    app.use(
      WORKER_CONTROL_PATH_PREFIX,
      express.json({
        limit: WORKER_CONTROL_BODY_LIMIT_BYTES,
        inflate: WORKER_CONTROL_INFLATE,
        verify: captureRawBody,
      })
    );
  }
  // Mounted here rather than beside the company-import parser above: these
  // widen an UNAUTHENTICATED buffer, so helmet, the private-hostname guard and
  // the request logger all belong in front of them. Nothing between there and
  // here reads req.body -- the global parser sitting on the next line is the
  // proof -- and the worker-control paths do not overlap the /preview proxy, so
  // the position is behaviour-preserving for the fix.
  app.use(express.json({ verify: captureRawBody }));
  // Protect every board-session mutation, including the direct auth and
  // onboarding routers mounted before the main API router below.
  app.use("/api", boardMutationGuard());
  // DEP-003 (E6 deployment harness): readiness route (always answers) + the optional
  // 503 gate, mounted on `app` at /api BEFORE the ~13 pre-api DB routers below AND the
  // main `api` Router. Registering it here (not inside `api`, which mounts last) is
  // what makes the gate cover EVERY /api route — including the tenant-scoped
  // /api/companies/:id/provider-credentials and the onboarding routers — instead of
  // only the routes inside `api`. Health/liveness/readiness bypass so they always
  // answer (they resolve later in the `api` Router / here). Default (no `readiness`
  // opt) = always-ready probe + dormant gate, leaving flag-off startup unchanged
  // except the additive /api/ready route.
  const readinessProbe = opts.readiness?.probe ?? alwaysReadyProbe;
  app.use("/api", readinessRoutes(readinessProbe));
  if (opts.readiness?.gateEnabled) {
    app.use(
      "/api",
      readinessGate({
        probe: readinessProbe,
        bypass: (path) =>
          path === "/ready" ||
          path === "/health" ||
          path === "/health/live" ||
          path.startsWith("/health/"),
      })
    );
  }
  // Mount profile-aware auth routes (get-session with DB-loaded user, profile GET/PATCH)
  // before the betterAuthHandler catch-all so specific routes win.
  app.use("/api", authProfileRoutes(db));
  app.use("/api", onboardingJourneyRoutes(db));
  app.use("/api", onboardingRoutes(db));
  app.use("/api", onboardingJoinRoutes(db));
  // Test-only e2e support. Dedicated cloud-mode support is fail-closed at
  // startup; local_trusted retains its developer-identity escape hatch.
  if (testSupportEnabled(opts.deploymentMode)) {
    app.use(
      "/api",
      testSupportRoutes(db, { deploymentMode: opts.deploymentMode })
    );
  }
  app.use("/api", onboardingEnvironmentRoutes(db));
  app.use("/api", commanderVerifyRoutes(db));
  app.use("/api", commanderKeyRoutes(db));
  app.use("/api", commanderLoginRoutes(db));
  app.use("/api", providerCredentialRoutes(db));
  // Phase 4: founder REST for provider_connections. No CliAuthTopology instance is
  // in scope at this mount, so resolve it once from the same deployment axes the
  // rest of app.ts threads (mirrors how other routes consume opts.deploymentMode /
  // deploymentExposure). Reused by the connection service's cloud_auth gate.
  const cliAuthTopology = resolveCliAuthTopology({
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
  });
  app.use("/api", providerConnectionRoutes(db, cliAuthTopology));
  app.use("/api", userProfileRoutes(db));
  // Email/password auth is removed — Google is the only provider (see
  // buildBetterAuthConfig). The dedicated /sign-in/email, /sign-up/email and
  // /forget-password routes and their rate limiters are gone. better-auth
  // handles all remaining auth sub-paths (Google social start, callback,
  // get-session, sign-out) through the wildcard below.
  if (opts.betterAuthHandler) {
    app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      distributedExecutionEnabled: opts.distributedExecutionEnabled,
    })
  );
  api.use(
    operationsHealthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    })
  );
  // DEP-003: the readiness route + optional 503 gate are mounted on `app` at /api
  // ABOVE the pre-api DB routers (before the authProfileRoutes block) so they cover
  // EVERY /api route, not just the ones inside this `api` Router. The liveness/health
  // routes above (mounted inside `api`) still answer because the gate bypasses
  // /health, /health/live, /health/*, and /ready.
  api.use(
    "/companies",
    companyRoutes(db, { deploymentMode: opts.deploymentMode })
  );
  api.use("/organizations", organizationRoutes(db));
  if (opts.distributedExecutionEnabled) {
    if (!opts.tenantAppDb || !opts.operatorDb) {
      throw new Error(
        "Distributed worker control requires verified aoa_app and aoa_operator database pools; owner fallback is forbidden",
      );
    }
    if (!opts.workerSessionSigningKey || Buffer.byteLength(opts.workerSessionSigningKey) < 32) {
      throw new Error("Distributed worker control requires AOA_WORKER_SESSION_SIGNING_KEY with at least 32 bytes");
    }
    api.use(jobControlRoutes({ db, appDb: opts.tenantAppDb, operatorDb: opts.operatorDb }));
    // Imported here (not at module top) so a flag-off startup never loads the worker-control /
    // job-leasing / job-control-metrics graph. The same instance flows through from the composition
    // root, so telemetry is one shared surface across scheduler, outbox, and leasing.
    const { workerControlRoutes } = await import("./routes/worker-control.js");
    api.use(workerControlRoutes({
      db,
      appDb: opts.tenantAppDb,
      operatorDb: opts.operatorDb,
      jobReadyScheduler: opts.jobReadyScheduler,
      jobControlMetrics: opts.jobControlMetrics,
      sessionSigningKey: opts.workerSessionSigningKey,
      onAttemptTerminal: opts.onAttemptTerminal,
      // DEP-012 Slice 4+5 — a pre-resolved LOCAL (opts), never an inline process.env read
      // here (the rollout-rollback-liveness source-shape test negative-matches an env read
      // within 400 chars of this mount). Absent ⇒ the mint is omitted (inert).
      controlPlaneSigningKey: opts.controlPlaneSigningKey,
    }));
    // DSK-001 Lane D (D17) — the owner-scoped device listing. Mounted HERE, inside the
    // flag block, so DSK-00 clause (a) holds by construction: flag-off the router does
    // not exist and every path under it 404s. Contrast F27, where executionTargetRoutes
    // sits outside this block and needed an explicit desktop refusal instead.
    // Dynamically imported for the same reason as worker-control above: a flag-off
    // startup never loads the module graph.
    const { desktopDeviceRoutes } = await import("./routes/desktop-devices.js");
    api.use(desktopDeviceRoutes({ db }));
    // DEP-011 reaper Slice B (B1) — the control-plane READ-ONLY lease-truth endpoint the
    // adapter-manager PULLs to classify orphan sandboxes. Mounted HERE, inside the
    // distributed block, is HALF the B1-F1 double-gate; the route's own pre-handler 404s
    // unless AOA_ADAPTER_MANAGER_TRUTH_ROUTE_ENABLED="1" is the other half. Ships INERT:
    // with either flag off it 404s, and its only caller is the AM client (B2). Dynamically
    // imported like worker-control above so a flag-off startup never loads the module.
    const { adapterManagerControlRoutes } = await import("./routes/adapter-manager-control.js");
    api.use(adapterManagerControlRoutes({ appDb: opts.tenantAppDb }));
  }
  // Settings -> Providers. Path-mounted (mergeParams) so the provider endpoints
  // share one /companies/:companyId/providers prefix.
  api.use("/companies/:companyId/providers", providerRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(dependencyRoutes(db));
  api.use(goalRoutes(db));
  api.use(mcpConnectorRoutes(db));
  api.use(braindumpRoutes(db));
  api.use(hubItemRoutes(db));
  api.use(hubAutopilotRoutes(db));
  api.use(agentRuntimeDecisionRoutes(db));
  api.use(workQuestionRoutes(db));
  api.use(teamsRoutes(db));
  api.use(teamImportsRoutes(db));
  // Phase 6.0: memory-folders and memory-assets routes MUST mount before
  // memoryRoutes because the latter has /memory/:id which would otherwise
  // catch /memory/folders and /memory/assets (treating "folders"/"assets"
  // as a UUID and 500ing).
  api.use(memoryFoldersRoutes({ db }));
  api.use(memoryAssetsRoutes({ db, storageService: opts.storageService }));
  api.use(
    memoryAssetsUploadRoutes({ db, storageService: opts.storageService })
  );
  api.use(memoryAssetRenderRoutes({ db, storageService: opts.storageService }));
  api.use(memoryRoutes(db));
  api.use(memorySettingsRoutes(db));
  api.use(searchRoutes(db));
  api.use(debriefRoutes(db));
  api.use(briefRoutes(db));
  api.use(artifactRoutes(db));
  api.use(taskOutputRoutes(db));
  api.use(outputDetectionRoutes(db));
  api.use(trustScoreRoutes(db));
  api.use(transcriptionRoutes(db));
  api.use(memoryFeedbackRoutes(db));
  api.use(feedbackRoutes(db));
  api.use(memoryLifecycleRoutes(db));
  api.use(memoryRetrievalsRoutes(db));
  api.use(memoryStarterTemplatesRoutes(db));
  api.use(fileImportRoutes(db, opts.storageService));
  api.use(teamRoutes(db));
  api.use(suggestionRoutes(db));
  api.use(contextPackagingRoutes(db));
  api.use(discussionRoutes(db));
  api.use(notificationPreferenceRoutes(db));
  api.use(notificationRoutes(db));
  api.use(workflowTemplateRoutes(db));
  api.use(internalAgentRoutes(db, opts.storageService));
  // Dev-only manual sweep triggers (Adjutant 15-min, Memory Keeper 4-hr).
  // Mounted ONLY when uiMode='vite-dev' (i.e. AOA_UI_DEV_MIDDLEWARE=true).
  // Production never sets this env var, so the routes never load there.
  // Used by UAT to avoid waiting for the natural sweep cadence — see
  // routes/internal-sweeps-dev.ts header for the full rationale.
  if (opts.uiMode === "vite-dev") {
    api.use(internalSweepsDevRoutes(db));
  }
  api.use(mcpServerRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(githubRoutes(db));
  api.use(projectGitRoutes(db));
  api.use(costRoutes(db));
  api.use(financeRoutes(db));
  api.use(quotaRoutes(db));
  api.use(companySkillRoutes(db));
  api.use(routineRoutes(db));
  api.use(instanceSettingsRoutes(db));
  api.use(cliAuthRoutes(db));
  api.use(environmentRoutes({ db }));
  api.use(orgSpendRoutes({ db }));
  api.use(executionTargetRoutes({
    db,
    workerSession: opts.distributedExecutionEnabled && opts.tenantAppDb && opts.operatorDb && opts.workerSessionSigningKey
      ? {
          appDb: opts.tenantAppDb,
          operatorDb: opts.operatorDb,
          sessionSigningKey: opts.workerSessionSigningKey,
        }
      : undefined,
  }));
  api.use(executionWorkspaceRoutes(db));
  api.use(workspaceGitRoutes(db));
  api.use(filesystemRoutes());
  api.use(
    companyWorkspaceFsRoutes({
      db,
      deploymentMode: opts.deploymentMode,
      companyWorkspaceBaseDir: opts.companyWorkspaceBaseDir,
    })
  );
  api.use(adapterRoutes());
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(cockpitRoutes(db));
  api.use(sidebarPreferencesRoutes(db));
  api.use(homeBoardLayoutRoutes(db));
  api.use(universeLayoutRoutes(db));
  api.use(universeDraftsRoutes(db));
  api.use(universeAttentionRoutes(db));
  api.use(universeCatchupRoutes(db));
  api.use(universeIntakeRoutes(db, opts.storageService));
  api.use(universePreferenceRoutes(db));
  api.use(viewerPreferencesRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(userEntityPinRoutes(db));
  api.use(userNoteRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    })
  );

  // Plugin subsystem — PROCESS COMPOSITION boundary (FND-006 / Decision #103
  // cloud-enforcement amendment). On `cloud_auth` (`tenantIsolationEnforced()`)
  // the hosted control plane must NOT construct, start, or dispatch any plugin
  // worker process, so the effectful worker/lifecycle/loader machinery below —
  // and the effectful plugin routes + marketplace-install router that depend on
  // it — are composed ONLY off cloud. Cloud boot instead performs a
  // metadata-only reconciliation of stale rows (see `index.ts` →
  // `reconcileCloudBlockedPlugins`). Self-hosted composition is unchanged.
  const hostedPluginProcessDisabled = tenantIsolationEnforced();
  // Harden the hosted parent BEFORE any plugin composition: strip a spoofed
  // worker-child marker so it can never be mistaken for an isolated child
  // (no-op off cloud, where the self-hosted worker manager sets it per-child).
  stripHostedPluginWorkerMarker();

  // Loader + lifecycle are consumed below by the marketplace-install router;
  // they exist ONLY off cloud. Kept in outer scope so the guarded install-router
  // block can see them.
  let loaderInst: ReturnType<typeof pluginLoader> | undefined;
  let lifecycleMgr: ReturnType<typeof pluginLifecycleManager> | undefined;

  if (!hostedPluginProcessDisabled) {
    const hostServiceDisposers = new Map<string, () => void>();
    let hostServiceCleanup:
      | ReturnType<typeof createPluginHostServiceCleanup>
      | undefined;
    const workerMgr = createPluginWorkerManager({
      onWorkerEvent: (event) => hostServiceCleanup?.handleWorkerEvent(event),
    });
    const eventBus = createPluginEventBus();
    const streamBus = createPluginStreamBus();
    const jobStoreInst = pluginJobStore(db);
    const toolDispatcherInst = createPluginToolDispatcher({
      workerManager: workerMgr,
      db,
    });
    const jobSchedulerInst = createPluginJobScheduler({
      db,
      jobStore: jobStoreInst,
      workerManager: workerMgr,
    });
    lifecycleMgr = pluginLifecycleManager(db, {
      workerManager: workerMgr,
    });
    const lifecycleMgrLocal = lifecycleMgr;
    hostServiceCleanup = createPluginHostServiceCleanup(
      lifecycleMgrLocal,
      hostServiceDisposers
    );
    const jobCoordinatorInst = createPluginJobCoordinator({
      db,
      lifecycle: lifecycleMgrLocal,
      scheduler: jobSchedulerInst,
      jobStore: jobStoreInst,
    });
    // Compose PluginRuntimeServices from existing subsystems + host services
    // factory. Without this, pluginLoader.loadAll() throws at startup and no
    // plugins activate. The loader.loadAll() call happens in index.ts after
    // the server is listening.
    const pluginRuntimeServices = {
      workerManager: workerMgr,
      eventBus,
      jobScheduler: jobSchedulerInst,
      jobStore: jobStoreInst,
      toolDispatcher: toolDispatcherInst,
      streamBus,
      lifecycleManager: lifecycleMgrLocal,
      buildHostHandlers: (
        pluginId: string,
        manifest: PaperclipPluginManifestV1
      ) => {
        // A manual reload may create a fresh service bundle for the same row.
        // Dispose the previous generation before replacing its disposer.
        const services = buildHostServices(
          db,
          pluginId,
          manifest.id,
          eventBus,
          (method, params) =>
            workerMgr.getWorker(pluginId)?.notify(method, params)
        );
        hostServiceCleanup?.replace(pluginId, () => services.dispose());
        return guardPluginHostHandlers(
          db,
          pluginId,
          createHostClientHandlers({
            pluginId,
            capabilities: manifest.capabilities ?? [],
            services,
          })
        );
      },
      disposeHostServices: (pluginId: string) =>
        hostServiceCleanup?.disposePlugin(pluginId),
      disposeAllHostServices: () => hostServiceCleanup?.disposeAll(),
      instanceInfo: {
        instanceId: resolveAoaInstanceId(),
        hostVersion: SERVER_VERSION,
      },
    };
    loaderInst = pluginLoader(db, {}, pluginRuntimeServices);
    const loaderInstLocal = loaderInst;
    // The plugin loader and lifecycle manager depend on each other. Bind the
    // runtime-aware loader once composition is complete so every route and
    // marketplace path activates/deactivates the same workers, jobs, events,
    // and tools instead of using the lifecycle's construction-time fallback.
    lifecycleMgrLocal.bindLoader(loaderInstLocal);

    api.use(
      pluginRoutes(
        db,
        loaderInstLocal,
        {
          scheduler: jobSchedulerInst,
          jobStore: jobStoreInst,
        },
        {
          workerManager: workerMgr,
        },
        {
          toolDispatcher: toolDispatcherInst,
        },
        {
          workerManager: workerMgr,
          streamBus,
        },
        lifecycleMgrLocal
      )
    );
    api.use(pluginCompanySettingsRoutes(db, lifecycleMgrLocal));

    // Company-scoped plugin management (M.4)
    api.use(
      "/companies/:companyId/plugins",
      companyPluginRoutes(db, lifecycleMgrLocal, loaderInstLocal)
    );

    // Expose tool dispatcher globally so heartbeat can inject plugin tools into
    // agent context (undefined on cloud → consumers inject no plugin tools).
    (globalThis as any).__paperclipPluginToolDispatcher = toolDispatcherInst;

    // Expose plugin subsystem for startup/shutdown in index.ts. Absent on cloud
    // so index.ts starts no job scheduler/coordinator and calls no loadAll().
    (app as any).__pluginSubsystem = {
      workerManager: workerMgr,
      eventBus,
      streamBus,
      jobStore: jobStoreInst,
      toolDispatcher: toolDispatcherInst,
      jobScheduler: jobSchedulerInst,
      jobCoordinator: jobCoordinatorInst,
      lifecycle: lifecycleMgrLocal,
      loader: loaderInstLocal,
      hostServiceCleanup,
    };
  } else {
    // FND-008 (Decision #103 CP-003/CP-004): in `cloud_auth` the effectful
    // plugin worker/lifecycle/loader machinery is NOT composed above (FND-006).
    // But the plugin HTTP surfaces must still be REGISTERED so a client receives
    // the stable documented 503 denial envelope (Decision #103) — NOT a 404.
    // Mount the SAME routers with the effectful runtime deps ABSENT and inert
    // cloud-denial loader/lifecycle facades: every effectful route short-circuits
    // to 503 at its `rejectBlockedCloudExecution` / `blockActivationInCloud` gate
    // BEFORE touching any loader/lifecycle/worker effect, while metadata-only
    // reads use the real `db`/registry (persisted validated data, never
    // evaluating manifest JavaScript). No worker manager, event/stream bus, job
    // store/scheduler/coordinator, or tool dispatcher is constructed, and
    // `__pluginSubsystem` / `__paperclipPluginToolDispatcher` stay unset so
    // index.ts starts no plugin background work and heartbeat injects no plugin
    // tools. The marketplace INSTALL router stays unmounted here (its async
    // orchestrator already records the `errorCode`/`errorDocs` cloud contract
    // and is unreachable without the loader) — browse-only catalog routes below
    // remain available. Self-hosted composition (the `if` branch) is unchanged.
    const cloudDenialLoader = buildCloudPluginDenialLoader();
    const cloudDenialLifecycle = buildCloudPluginDenialLifecycle();
    api.use(
      pluginRoutes(
        db,
        cloudDenialLoader,
        undefined,
        undefined,
        undefined,
        undefined,
        cloudDenialLifecycle
      )
    );
    api.use(pluginCompanySettingsRoutes(db, cloudDenialLifecycle));
    api.use(
      "/companies/:companyId/plugins",
      companyPluginRoutes(db, cloudDenialLifecycle, cloudDenialLoader)
    );
  }

  // Marketplace catalog service + routes
  const marketplaceCatalogService = new MarketplaceCatalogService({
    db,
    cdnUrl: process.env.AOA_MARKETPLACE_CDN_URL || undefined,
    bundledSnapshotProvider: async () => {
      // Lazy import to avoid bundling issues.
      // The snapshot file is gitignored — fetched at build time by
      // `pnpm fetch-catalog` before the server boots. Path is held in a
      // string variable so TypeScript's static module resolver doesn't
      // try to find the file at typecheck time (which would fail across
      // packages — server's tsconfig finds it via the local types/
      // ambient declaration, but cli/'s tsconfig walks server source via
      // the workspace import without seeing server's types/ folder).
      try {
        const snapshotPath = "../../ui/src/aoa-marketplace-snapshot.json";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const snapshot = (await import(snapshotPath, {
          with: { type: "json" },
        })) as { default: unknown };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return snapshot.default as any;
      } catch {
        return null;
      }
    },
  });
  // Publish the instance so paths below the route layer can reach it — today
  // the company-create crew bootstrap (T2.3), which must be able to WAIT for a
  // catalog on a cold cache rather than race the fire-and-forget boot sync.
  registerMarketplaceCatalogService(marketplaceCatalogService);
  marketplaceCatalogService.startSyncLoop();
  api.use(
    "/marketplace",
    createMarketplaceRouter({ service: marketplaceCatalogService })
  );
  api.use(
    "/admin/marketplace",
    createAdminMarketplaceRouter({
      reconcile: (actor, operationId, retryOfOperationId) =>
        runMarketplaceReconciliation({
          db,
          catalogService: marketplaceCatalogService,
          actor,
          operationId,
          retryOfOperationId,
        }),
      inspect: (operationId, isActive) =>
        inspectMarketplaceReconciliation({ db, operationId, isActive }),
    })
  );

  // Marketplace install routes (per-company, M.2.G).
  // Mounted under /api/companies/:companyId/marketplace, matching the per-company
  // URL prefix pattern used by routes/teams.ts. Plugin installs require a live
  // pluginLoader/registry/lifecycle wired here at the route layer because the
  // loader instance is created in this scope (above) and not exported.
  //
  // The PluginLoaderLike adapter narrows the real loader/registry/lifecycle
  // surface to just what marketplace needs (PluginInstaller's contract), which
  // also handles the manifest type widening (PaperclipPluginManifestV1 ->
  // { id; [key: string]: unknown }) and the lifecycle.load return-value shrink
  // (PluginRecord -> void).
  // Marketplace INSTALL routes require the live loader/lifecycle, which are
  // composed only off cloud (FND-006). On cloud the hosted control plane runs no
  // plugin install/activation, so these routers are not mounted; browse-only
  // catalog routes (above) remain available.
  if (!hostedPluginProcessDisabled && loaderInst && lifecycleMgr) {
    const installLoader = loaderInst;
    const installLifecycle = lifecycleMgr;
    const marketplacePluginRegistry = pluginRegistryService(db);
    api.use(
      "/companies/:companyId/marketplace",
      createMarketplaceInstallRouter({
        db,
        catalogService: marketplaceCatalogService,
        pluginLoader: {
          installPlugin: async (opts) => {
            const discovered = await installLoader.installPlugin(opts);
            return {
              packagePath: discovered.packagePath,
              packageName: discovered.packageName,
              version: discovered.version,
              source: discovered.source,
              manifest: discovered.manifest as {
                id: string;
                [key: string]: unknown;
              } | null,
            };
          },
          registry: {
            getByKeyScoped: async (pluginKey, companyId) => {
              const row = await marketplacePluginRegistry.getByKeyScoped(
                pluginKey,
                companyId
              );
              return row ? { id: row.id, pluginKey: row.pluginKey } : null;
            },
          },
          lifecycle: {
            load: async (pluginId) => {
              await installLifecycle.load(pluginId);
            },
            blockActivationInCloud: async (pluginId, source) => {
              await installLifecycle.blockActivationInCloud(pluginId, source);
            },
          },
        },
      })
    );
    api.use(
      "/companies/:companyId/marketplace",
      createMarketplaceCompanyRouter({
        db,
        catalogService: marketplaceCatalogService,
        pluginLifecycle: installLifecycle,
        pluginLoader: {
          installPlugin: async (opts) => {
            await installLoader.installPlugin(opts);
          },
        },
        pluginRollback: pluginRollbackService(db),
      })
    );
  }

  // Catch-all 404 for unmatched /api/* routes. Without this, requests like
  // GET /api/foo fall through to express.static / Vite middleware, which
  // either serve index.html or throw -> 500 via errorHandler. Issue #116.
  api.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
  });

  app.use("/api", api);

  // W5b PreToolUse permission bridge (outside /api). The claude-local adapter's
  // hook POSTs here with a per-run bearer token. MUST mount AFTER express.json()
  // (body needed) and BEFORE the /_plugins static handler and the SPA/static
  // catch-all below — otherwise the SPA fallthrough (SPA_FALLBACK_ROUTE regex)
  // would swallow /internal/... and return index.html instead of JSON. The
  // router self-registers the full RUNTIME_HOOK_PATH, so mount at root.
  app.use(runtimeHooksRoutes(db));

  // Plugin UI static assets (outside /api prefix)
  const pluginDir = path.resolve(
    process.env.AOA_PLUGIN_DIR ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".aoa",
        "plugins"
      )
  );
  app.use("/_plugins", pluginUiStaticRoutes(db, { localPluginDir: pluginDir }));

  // NOTE: `__paperclipPluginToolDispatcher` and `__pluginSubsystem` are set
  // inside the off-cloud plugin composition block above (FND-006). On cloud
  // they remain unset, so heartbeat/context injects no plugin tools and index.ts
  // starts no plugin background workers.

  if (opts.uiMode === "static") {
    if (uiDistDir) {
      app.use(express.static(uiDistDir));
      // Catch-all SPA route, but NOT for /api/* (those 404 above, or matched by api router)
      // and NOT for /assets/* (a missing hashed bundle must 404 loudly). Issue #116, BUG-4.
      app.get(SPA_FALLBACK_ROUTE, spaFallbackHandler(uiDistDir));
    } else {
      console.warn("[aoa] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const { createServer: createViteServer } = await import("vite");
    const viteHmrPort = Number(process.env.AOA_VITE_HMR_PORT);
    const vite = await createViteServer({
      root: uiRoot,
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr:
          Number.isFinite(viteHmrPort) && viteHmrPort > 0
            ? { port: viteHmrPort }
            : undefined,
        allowedHosts: privateHostnameGateEnabled
          ? Array.from(privateHostnameAllowSet)
          : undefined,
      },
    });

    app.use(vite.middlewares);
    // Catch-all SPA route for Vite dev mode, but NOT for /api/* (those 404 above).
    // This prevents unmatched /api/foo from serving the SPA's index.html. Issue #116.
    app.get(SPA_FALLBACK_ROUTE, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  return app;
}

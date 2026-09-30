import { registerHooks } from "node:module";

const sentinelMode = process.env.AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL;
const trackedDatabaseUrlKeys = new Set([
  "AOA_APP_DATABASE_URL",
  "AOA_OPERATOR_DATABASE_URL",
]);
if (sentinelMode?.startsWith("bootstrap-")) {
  const nativeEnv = process.env;
  process.env = new Proxy(nativeEnv, {
    get(target, property, receiver) {
      if (typeof property === "string" && trackedDatabaseUrlKeys.has(property)) {
        process.stderr.write(`JOB_CONTROL_BOOTSTRAP_ENV_READ:${property}\n`);
        if (sentinelMode === "bootstrap-env-deny") {
          throw new Error(`JOB_CONTROL_BOOTSTRAP_ENV_DENIED:${property}`);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

const guardedModules = [
  "worker-control",
  "job-leasing",
  "job-control-metrics",
  "job-ready-scheduler",
  "job-outbox-worker",
];
registerHooks({
  resolve(specifier, context, nextResolve) {
    // Guarded modules are all server-side (server/src/services + server/src/routes). The
    // @armyofagents/db barrel eagerly loads its own repositories/operator/job-leasing.ts, whose
    // basename collides with the guarded server service services/job-leasing.ts. That db-package
    // repository is always loaded and is NOT part of the flag-gated server graph, so exclude any
    // db-package repository specifier before the loose basename match.
    //
    // ★ SECOND COLLISION, same shape (BRW-003d-1). `server/src/worker-control-body-limits.ts`
    // contains "worker-control" in its PATH, and app.ts imports it at the top level so the
    // body-limit constants are available before any flag is read. That file is deliberately
    // import-safe: it imports ONLY `@armyofagents/worker-protocol` and nothing from the
    // flag-gated graph — its own header says importing from routes/worker-control.js "would
    // defeat that lazy load". So a flag-off startup that loads it has NOT loaded
    // routes/worker-control.ts, and reporting it as such is a FALSE POSITIVE that turns a real
    // invariant into a red nobody can act on. Excluded by exact filename, not by loosening the
    // match: routes/worker-control.js must still be reported, and the flag-ON test proves it is.
    const normalized = specifier.replaceAll("\\", "/");
    const guarded = normalized.includes("/repositories/") || normalized.includes("worker-control-body-limits")
      ? undefined
      : guardedModules.find((name) => normalized.includes(name));
    if (guarded) {
      process.stderr.write(`JOB_CONTROL_MODULE_LOAD:${guarded}\n`);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const normalizedUrl = url.replaceAll("\\", "/");
    if (sentinelMode?.startsWith("bootstrap-") && loaded.format === "module" &&
      loaded.source !== undefined && loaded.source !== null &&
      normalizedUrl.includes("/packages/db/src/client.")) {
      let source = String(loaded.source);
      source = source.replace(
        /(\b(?:export\s+)?async\s+function\s+loadRequiredMigrationIdentity\s*\([^)]*\)\s*(?::\s*Promise<RequiredMigrationIdentity>\s*)?\{)/u,
        `$1
  process.stderr.write("JOB_CONTROL_BOOTSTRAP_LOADER_READ\\n");
  if (process.env.AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL === "bootstrap-loader-deny") {
    throw new Error("JOB_CONTROL_BOOTSTRAP_LOADER_DENIED");
  }`,
      );
      source = source.replace(
        /(\b(?:export\s+)?function\s+createTenantAppDbConnection\s*\([^)]*\)\s*(?::\s*NonOwnerDbConnection\s*)?\{)/u,
        `$1
  process.stderr.write("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_app\\n");
  if (process.env.AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL === "bootstrap-allocation-deny") {
    throw new Error("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION_DENIED:aoa_app");
  }`,
      );
      source = source.replace(
        /(\b(?:export\s+)?function\s+createOperatorDbConnection\s*\([^)]*\)\s*(?::\s*NonOwnerDbConnection\s*)?\{)/u,
        `$1
  process.stderr.write("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION:aoa_operator\\n");
  if (process.env.AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL === "bootstrap-allocation-deny") {
    throw new Error("JOB_CONTROL_BOOTSTRAP_POOL_ALLOCATION_DENIED:aoa_operator");
  }`,
      );
      return { ...loaded, source };
    }
    if (process.env.AOA_JOB_CONTROL_MODULE_LOAD_SENTINEL !== "identity" ||
      loaded.format !== "module" || loaded.source === undefined || loaded.source === null) {
      return loaded;
    }
    const moduleName = [
      ["job-control-metrics", "/server/src/services/job-control-metrics."],
      ["job-ready-scheduler", "/server/src/services/job-ready-scheduler."],
      ["job-outbox-worker", "/server/src/services/job-outbox-worker."],
      ["worker-control", "/server/src/routes/worker-control."],
      ["job-leasing", "/server/src/services/job-leasing."],
    ].find(([, path]) => normalizedUrl.includes(path))?.[0];
    if (!moduleName) return loaded;
    const functionByModule = {
      "job-control-metrics": "createPinoJobControlMetrics",
      "job-ready-scheduler": "createJobReadyScheduler",
      "job-outbox-worker": "createJobOutboxWorker",
      "worker-control": "workerControlRoutes",
      "job-leasing": "createJobLeasingService",
    };
    const factory = functionByModule[moduleName];
    const metricFactory = moduleName === "job-control-metrics";
    const instrumentation = metricFactory
      ? `
const __job003OriginalFactory = ${factory};
${factory} = (...args) => {
  const instance = __job003OriginalFactory(...args);
  globalThis[Symbol.for("aoa.job003.metrics.identity")] = instance;
  process.stderr.write("JOB_CONTROL_METRICS_IDENTITY:metrics\\n");
  return instance;
};`
      : `
const __job003OriginalFactory = ${factory};
${factory} = (input, ...rest) => {
  const marker = globalThis[Symbol.for("aoa.job003.metrics.identity")];
  const same = marker !== undefined && input?.${moduleName === "worker-control" ? "jobControlMetrics" : "metrics"} === marker;
  process.stderr.write("JOB_CONTROL_METRICS_IDENTITY:${moduleName}:" + (same ? "same" : "different") + "\\n");
  return __job003OriginalFactory(input, ...rest);
};`;
    return { ...loaded, source: `${String(loaded.source)}\n${instrumentation}\n` };
  },
});

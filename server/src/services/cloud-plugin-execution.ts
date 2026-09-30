import {
  PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
  type PluginStatusReasonCode,
} from "@armyofagents/shared";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { logger } from "../middleware/logger.js";

export const PLUGIN_WORKER_BLOCKED_IN_CLOUD =
  PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON satisfies PluginStatusReasonCode;

// RW5a (Wave 5 review, fixes U10-a's regression): U10 correctly lifted the
// cloud block for the WORKER FORK sink (a host-resident child process that
// never enters the tenant VM). But `isCloudPluginExecutionBlocked` is a
// single shared predicate gating SEVEN call sites that are not equivalent —
// U10-a made it unconditionally `false`, which also lifted the block on:
//   (1) `plugin-loader.ts`'s `loadManifestFromPath` — a direct in-process
//       `import()` of a tenant-authored manifest MODULE, executed in the
//       CONTROL PLANE (the multi-tenant Express process), with no
//       child-process isolation at all; and
//   (2) `plugin-ui-static.ts` — same-origin plugin UI JavaScript served to
//       the browser, a browser-trust boundary unrelated to VM/process
//       isolation.
// Both remain live cross-tenant/XSS-class risks on shared cloud infra and
// stay blocked below. This message text is preserved — past tense — because
// it is ALSO still surfaced for historical rows/records that captured a live
// block before the host-resident-worker model shipped (see
// `projectCloudPluginPolicyState`'s recoverable-row branch and the persisted
// `errorCode` envelope in `routes/marketplace-installs.ts`); it remains
// accurate for a *future* live block too, since the underlying reason code
// (`PLUGIN_WORKER_BLOCKED_IN_CLOUD`) is unchanged.
export const CLOUD_PLUGIN_BLOCK_MESSAGE =
  "Plugin execution was blocked on AoA Cloud until a host-resident worker was available";

export const CLOUD_PLUGIN_EXECUTION_DOC_PATH =
  "/docs/guides/cloud-plugin-execution";

export type PluginActivationSource =
  | "boot"
  | "lifecycle"
  | "marketplace"
  | "dependency"
  | "direct"
  | "restart"
  | "unknown";

/**
 * Every distinct place `assertCloudPluginExecutionAllowed` /
 * `isCloudPluginExecutionBlocked` gates. See `isCloudPluginExecutionBlocked`
 * below for the per-sink cloud decision.
 *
 *  - "worker-fork"    — `plugin-worker-manager.ts` `spawnProcess()`: the
 *                        actual `fork()` of the isolated worker child.
 *  - "worker-manager"  — `plugin-worker-manager.ts` `startWorker()`: the
 *                        entry to the fork pipeline above; no code runs
 *                        in-process before the fork.
 *  - "lifecycle"       — `plugin-lifecycle.ts` `blockActivationInCloud()`:
 *                        activate/restart/enable. Reads the manifest that
 *                        was already validated + persisted to
 *                        `plugins.manifest_json` at install time; never
 *                        re-imports the plugin module.
 *  - "loader"          — the install/upgrade/rollback ENTRY boundary
 *                        (`plugin-loader.ts` `installPlugin`/`upgradePlugin`,
 *                        `marketplace-install/plugin-installer.ts`): npm
 *                        download + file writes only (`--ignore-scripts`).
 *                        Every one of these paths still has to pass through
 *                        "loader-import" below before it executes any
 *                        tenant code.
 *  - "loader-import"   — `plugin-loader.ts` `loadManifestFromPath()`: the
 *                        literal `import()` of the tenant-authored manifest
 *                        module. The ONLY sink that actually executes
 *                        tenant code in-process.
 *  - "ui-static"       — `plugin-ui-static.ts`: serves the plugin's UI
 *                        bundle same-origin to the browser. Executable
 *                        tenant JS, browser-trust boundary.
 */
export type PluginCloudExecutionSink =
  | "worker-manager"
  | "worker-fork"
  | "lifecycle"
  | "loader"
  | "loader-import"
  | "ui-static";

export interface CloudPluginExecutionContext {
  pluginId: string;
  companyId?: string;
  source?: PluginActivationSource;
  sink: PluginCloudExecutionSink;
}

export interface CloudPluginExecutionBlockedEnvelope {
  error: string;
  code: typeof PLUGIN_WORKER_BLOCKED_IN_CLOUD;
  docs: string;
}

export function cloudPluginExecutionBlockedEnvelope(): CloudPluginExecutionBlockedEnvelope {
  return {
    error: CLOUD_PLUGIN_BLOCK_MESSAGE,
    code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  };
}

/** Typed policy denial shared by lifecycle and final process sinks. */
export class CloudPluginExecutionBlockedError extends Error {
  readonly code = PLUGIN_WORKER_BLOCKED_IN_CLOUD;
  readonly statusReasonCode = PLUGIN_WORKER_BLOCKED_IN_CLOUD;

  constructor() {
    super(CLOUD_PLUGIN_BLOCK_MESSAGE);
    this.name = "CloudPluginExecutionBlockedError";
  }
}

let blockedActivationCount = 0;
const blockedActivationCountBySource: Record<PluginActivationSource, number> = {
  boot: 0,
  lifecycle: 0,
  marketplace: 0,
  dependency: 0,
  direct: 0,
  restart: 0,
  unknown: 0,
};
const bootReconciledPluginIds = new Set<string>();
let bootReconciledCount = 0;

/**
 * Set to `"1"` ONLY inside a forked plugin worker CHILD process's own
 * environment — see `spawnProcess()` in `plugin-worker-manager.ts`, which
 * builds the child's env from scratch (it does NOT spread the parent's
 * `process.env`) and sets this marker there. It is never present in the
 * control-plane (host) process's own env, so reading it back is a reliable
 * signal that the CURRENT process IS the isolated worker child rather than
 * the multi-tenant control plane. Documented in
 * `docs/deploy/environment-variables.md`.
 */
export const PLUGIN_WORKER_PROCESS_ENV_VAR = "AOA_PLUGIN_WORKER_PROCESS";

function isRunningInsidePluginWorkerChild(): boolean {
  return process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] === "1";
}

/**
 * Sinks that never execute tenant-authored code in the CONTROL-PLANE
 * process, so they stay allowed on cloud even though
 * `tenantIsolationEnforced()` is true. See the `PluginCloudExecutionSink`
 * doc comment above for what each one guards.
 */
const CLOUD_SAFE_CONTROL_PLANE_SINKS: ReadonlySet<PluginCloudExecutionSink> =
  new Set(["worker-fork", "worker-manager", "lifecycle", "loader"]);

/**
 * Sink-aware, process-aware cloud plugin execution gate (RW5a).
 *
 * `sink` is optional for backward compatibility with general/legacy callers
 * (e.g. `projectCloudPluginPolicyState`'s read-projection) that ask "is cloud
 * plugin execution blocked" without reference to a specific call site — that
 * bare form preserves U10's "not blocked" answer so existing read paths and
 * metrics stay byte-identical. Every enforcement call site (every
 * `assertCloudPluginExecutionAllowed` caller and every direct
 * `isCloudPluginExecutionBlocked` gate) MUST pass its sink explicitly.
 */
export function isCloudPluginExecutionBlocked(
  sink?: PluginCloudExecutionSink
): boolean {
  if (!tenantIsolationEnforced()) return false;

  // Same-origin plugin UI JS served to the browser is a browser-trust
  // boundary, not a process-isolation one. It never runs inside the worker
  // child (it's an Express static-file route in the control plane) — but
  // even so, this check is unconditional and NOT overridable by the
  // worker-child marker below, so it can never be bypassed by that escape
  // hatch even if the call graph changes in the future.
  if (sink === "ui-static") return true;

  // Anything genuinely executing inside the isolated worker child is safe by
  // construction: minimal, explicitly-built env (no DATABASE_URL or other
  // host/control-plane secrets), never enters the tenant VM, and is only
  // reached through the broker's authz-gated, company-scoped dispatch.
  if (isRunningInsidePluginWorkerChild()) return false;

  // No sink (general/legacy callers) or a sink that never runs tenant code
  // in-process in the control plane: not blocked.
  if (sink === undefined || CLOUD_SAFE_CONTROL_PLANE_SINKS.has(sink)) {
    return false;
  }

  // Remaining case: "loader-import" — `plugin-loader.ts`'s
  // `loadManifestFromPath()` `import()` of the tenant-authored manifest
  // module, running in the CONTROL PLANE with no child-process isolation.
  // Fail closed. Any future/unrecognized sink also fails closed here by
  // construction (this function only ALLOWS a sink it explicitly recognizes
  // as safe above).
  return true;
}

/**
 * Project the static cloud policy into read responses immediately, including
 * during the short startup window before durable boot reconciliation finishes.
 */
export function projectCloudPluginPolicyState<
  T extends {
    status: string;
    statusReasonCode?: unknown;
    lastError?: unknown;
  },
>(plugin: T): T {
  if (!isCloudPluginExecutionBlocked()) {
    // A cloud -> self-hosted move can leave the durable reconciliation reason
    // on an error row. It is historical in a trusted runtime, not a live policy
    // denial: clear only the canonical policy metadata in read projections so
    // operators can use Retry/Enable. A successful lifecycle write clears the
    // durable reason.
    if (plugin.statusReasonCode !== PLUGIN_WORKER_BLOCKED_IN_CLOUD) {
      return plugin;
    }
    return {
      ...plugin,
      statusReasonCode: null,
      lastError:
        plugin.lastError === CLOUD_PLUGIN_BLOCK_MESSAGE ? null : plugin.lastError,
    } as T;
  }
  if (plugin.status === "uninstalled") {
    return plugin;
  }
  return {
    ...plugin,
    status: "error",
    statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
  } as T;
}

export function recordCloudPluginBlock(
  context: CloudPluginExecutionContext
): number {
  const activationSource = context.source ?? "unknown";
  blockedActivationCount += 1;
  blockedActivationCountBySource[activationSource] += 1;
  logger.warn(
    {
      service: "cloud-plugin-execution",
      event: "plugin.worker.cloud_blocked",
      pluginId: context.pluginId,
      companyId: context.companyId,
      activationSource,
      sink: context.sink,
      reasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      blockedActivationCount,
      blockedActivationSourceCount:
        blockedActivationCountBySource[activationSource],
    },
    "blocked cloud plugin execution"
  );
  return blockedActivationCount;
}

export function assertCloudPluginExecutionAllowed(
  context: CloudPluginExecutionContext
): void {
  if (!isCloudPluginExecutionBlocked(context.sink)) return;
  recordCloudPluginBlock(context);
  throw new CloudPluginExecutionBlockedError();
}

/** Test/diagnostic-only process counter; contains no tenant or config data. */
export function getCloudPluginBlockedActivationCount(): number {
  return blockedActivationCount;
}

export function getCloudPluginBlockMetrics() {
  return {
    total: blockedActivationCount,
    bySource: { ...blockedActivationCountBySource },
    byReason: {
      [PLUGIN_WORKER_BLOCKED_IN_CLOUD]: blockedActivationCount,
    },
    bootReconciledCount,
    bootReconciledGauge: bootReconciledPluginIds.size,
  };
}

export function beginCloudPluginBootReconciliation(): void {
  bootReconciledPluginIds.clear();
}

export function recordCloudPluginBootReconciled(
  context: Pick<CloudPluginExecutionContext, "pluginId" | "companyId">
): void {
  bootReconciledCount += 1;
  bootReconciledPluginIds.add(context.pluginId);
  logger.info(
    {
      service: "cloud-plugin-execution",
      event: "plugin.worker.cloud_boot_reconciled",
      pluginId: context.pluginId,
      companyId: context.companyId,
      reasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      bootReconciledCount,
      bootReconciledGauge: bootReconciledPluginIds.size,
    },
    "reconciled stale ready cloud plugin"
  );
}

import {
  PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
  type PluginStatusReasonCode,
} from "@armyofagents/shared";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { logger } from "../middleware/logger.js";

export const PLUGIN_WORKER_BLOCKED_IN_CLOUD =
  PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON satisfies PluginStatusReasonCode;

// FND-006 (Decision #103 cloud-enforcement amendment, 2026-08-03): the plugin
// worker model is NOT a tenant boundary, so `cloud_auth` must not construct,
// fork, start, resume, or dispatch ANY host-process plugin worker — including a
// plugin whose mutable trust tier is `core`. Every one of the six typed sinks
// (`worker-manager`, `worker-fork`, `lifecycle`, `loader`, `loader-import`,
// `ui-static`) FAILS CLOSED in the hosted parent, and there is no operator
// override. An earlier Wave-5 iteration (U10/U10-a) allowlisted the first four
// sinks on the "host-resident worker" theory; that allowlist is REMOVED here.
// The worker-child marker (`AOA_PLUGIN_WORKER_PROCESS`) is never consulted by
// the gate, so it can never grant the parent authority; `stripHostedPluginWorkerMarker`
// additionally strips a spoofed value from the hosted parent before composition.
// Self-hosted (`local_trusted` / single-tenant `authenticated`) is unchanged.
//
// The message text is contractual (persisted on reconciled rows, surfaced in the
// HTTP `errorCode` envelope, and matched by `projectCloudPluginPolicyState`'s
// recoverable-row branch); it is preserved verbatim across this change.
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
 * `process.env`) and sets this marker there. It is a CHILD-IDENTITY signal
 * for diagnostics/logging only; since FND-006 it is NEVER consulted by
 * `isCloudPluginExecutionBlocked`, so it can never grant the hosted parent
 * authority. On cloud (`tenantIsolationEnforced()`), no worker child is ever
 * launched, and `stripHostedPluginWorkerMarker()` removes any spoofed value
 * from the hosted parent's env before composition. Documented in
 * `docs/deploy/environment-variables.md`.
 */
export const PLUGIN_WORKER_PROCESS_ENV_VAR = "AOA_PLUGIN_WORKER_PROCESS";

/**
 * Cloud plugin execution gate (FND-006 / Decision #103 amendment).
 *
 * FAILS CLOSED for every typed sink and for the bare/legacy no-sink form
 * whenever tenant isolation is enforced (`cloud_auth`): the hosted parent may
 * not construct, fork, start, resume, or dispatch any plugin worker at any
 * sink or trust tier. The worker-child marker is deliberately NOT consulted,
 * so `AOA_PLUGIN_WORKER_PROCESS=1` can never bypass this in the parent. Off
 * cloud (`local_trusted` / single-tenant `authenticated`) nothing is blocked
 * — self-hosted worker lifecycle is unchanged.
 *
 * `sink` is retained for call-site clarity and metrics; the decision does not
 * depend on it (all sinks share one fail-closed answer). The bare form is used
 * by read projections (`projectCloudPluginPolicyState`) and now reports the
 * live block on cloud so stale `ready`/`installed` rows never appear runnable.
 */
export function isCloudPluginExecutionBlocked(
  _sink?: PluginCloudExecutionSink
): boolean {
  return tenantIsolationEnforced();
}

/**
 * Hosted-parent hardening (FND-006): a `cloud_auth` control-plane process must
 * never carry the worker-child marker. If a spoofed `AOA_PLUGIN_WORKER_PROCESS`
 * is present in the hosted parent's environment, strip it BEFORE any plugin
 * composition so no downstream reader can mistake the parent for an isolated
 * worker child. No-op off cloud, where the self-hosted worker manager
 * legitimately sets the marker in each child's own explicit minimal env.
 *
 * @returns `true` if a marker was stripped from the hosted parent, else `false`.
 */
export function stripHostedPluginWorkerMarker(): boolean {
  if (!tenantIsolationEnforced()) return false;
  if (process.env[PLUGIN_WORKER_PROCESS_ENV_VAR] === undefined) return false;
  delete process.env[PLUGIN_WORKER_PROCESS_ENV_VAR];
  logger.warn(
    {
      service: "cloud-plugin-execution",
      event: "plugin.worker.parent_marker_stripped",
      envVar: PLUGIN_WORKER_PROCESS_ENV_VAR,
      reasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    },
    "stripped spoofed plugin worker-child marker from the hosted parent"
  );
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

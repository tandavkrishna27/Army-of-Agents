import type { Db } from "@armyofagents/db";
import {
  pluginLogs,
  agentTaskSessions as agentTaskSessionsTable,
  plugins as pluginsTable,
  pluginCompanySettings,
} from "@armyofagents/db";
import { eq, and, like, desc } from "drizzle-orm";
import type {
  HostServices,
  Company,
  Agent,
  Project,
  Issue,
  Goal,
  PluginWorkspace,
  IssueComment,
} from "@armyofagents/plugin-sdk";
import { companyService } from "./companies.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { issueService } from "./issues.js";
import { goalService } from "./goals.js";
import { documentService } from "./documents.js";
import { heartbeatService } from "./heartbeat.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { randomUUID } from "node:crypto";
import { activityService } from "./activity.js";
import { costService } from "./costs.js";
import { assetService } from "./assets.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { createPluginSecretsHandler } from "./plugin-secrets-handler.js";
import { logActivity } from "./activity-log.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { logger } from "../middleware/logger.js";
import { transmitPluginTelemetry } from "./feedback-transmission.js";
import {
  validateAndResolveFetchUrl,
  executePinnedRequest,
  type ValidatedFetchTarget,
} from "./outbound-url-guard.js";

// ---------------------------------------------------------------------------
// SSRF protection for plugin HTTP fetch
// ---------------------------------------------------------------------------
//
// `validateAndResolveFetchUrl`, `isPrivateIP`, `ValidatedFetchTarget`,
// `buildPinnedRequestOptions`, and `executePinnedRequest` all live in
// `outbound-url-guard.ts` so the http adapter can share them. The plugin host
// wraps `executePinnedRequest` with a heavier body cap (200 MB) below since
// plugin RPC payloads are legitimately larger than what an adapter status-check
// would expect.

/** Maximum time (ms) a plugin fetch request may take before being aborted. */
const PLUGIN_FETCH_TIMEOUT_MS = 30_000;

/** Plugin RPC fetch responses can be substantially larger than the default cap. */
const PLUGIN_RESPONSE_BODY_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * Validation for plugin telemetry event names (F.D4 infra port, Task F.5).
 * Matches Paperclip parity: lowercase slug of letters, numbers, `_` or `-`,
 * leading char must be alphanumeric.
 */
const TELEMETRY_EVENT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;

async function executePinnedHttpRequest(
  target: ValidatedFetchTarget,
  init: RequestInit | undefined,
  signal: AbortSignal
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  return executePinnedRequest(target, init, signal, {
    maxBodyBytes: PLUGIN_RESPONSE_BODY_BYTES,
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (
    (PATH_LIKE_PATTERN.test(normalized) ||
      WINDOWS_DRIVE_PATH_PATTERN.test(normalized)) &&
    !UUID_PATTERN.test(normalized)
  );
}

function sanitizeWorkspaceText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function sanitizeWorkspacePath(cwd: string | null): string {
  if (!cwd) return "";
  return looksLikePath(cwd) ? cwd.trim() : "";
}

function sanitizeWorkspaceName(name: string, fallbackPath: string): string {
  const safeName = sanitizeWorkspaceText(name);
  if (safeName && !looksLikePath(safeName)) {
    return safeName;
  }
  const normalized = fallbackPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Workspace";
}

// ---------------------------------------------------------------------------
// Buffered plugin log writes
// ---------------------------------------------------------------------------

/** How many buffered log entries trigger an immediate flush. */
const LOG_BUFFER_FLUSH_SIZE = 100;

/** How often (ms) the buffer is flushed regardless of size. */
const LOG_BUFFER_FLUSH_INTERVAL_MS = 5_000;

/** Max length for a single plugin log message (bytes/chars). */
const MAX_LOG_MESSAGE_LENGTH = 10_000;

/** Max serialised JSON size for plugin log meta objects. */
const MAX_LOG_META_JSON_LENGTH = 50_000;

/** Max length for a metric name. */
const MAX_METRIC_NAME_LENGTH = 500;

/** Pino reserved field names that plugins must not overwrite. */
const PINO_RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "v",
]);

/** Truncate a string to `max` characters, appending a marker if truncated. */
function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...[truncated]";
}

/** Sanitise a plugin-supplied meta object: enforce size limit and strip reserved keys. */
function sanitiseMeta(
  meta: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (meta == null) return null;
  // Strip pino reserved keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PINO_RESERVED_KEYS.has(k)) {
      cleaned[k] = v;
    }
  }
  // Enforce total serialised size
  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _sanitised: true, _error: "meta was not JSON-serialisable" };
  }
  if (json.length > MAX_LOG_META_JSON_LENGTH) {
    return {
      _sanitised: true,
      _error: `meta exceeded ${MAX_LOG_META_JSON_LENGTH} chars`,
    };
  }
  return cleaned;
}

interface BufferedLogEntry {
  db: Db;
  pluginId: string;
  level: string;
  message: string;
  meta: Record<string, unknown> | null;
}

const _logBuffer: BufferedLogEntry[] = [];

/**
 * Flush all buffered log entries to the database in a single batch insert per
 * unique db instance. Errors are swallowed with a console.error fallback so
 * flushing never crashes the process.
 */
export async function flushPluginLogBuffer(): Promise<void> {
  if (_logBuffer.length === 0) return;

  // Drain the buffer atomically so concurrent flushes don't double-insert.
  const entries = _logBuffer.splice(0, _logBuffer.length);

  // Group entries by db identity so multi-db scenarios are handled correctly.
  const byDb = new Map<Db, BufferedLogEntry[]>();
  for (const entry of entries) {
    const group = byDb.get(entry.db);
    if (group) {
      group.push(entry);
    } else {
      byDb.set(entry.db, [entry]);
    }
  }

  for (const [dbInstance, group] of byDb) {
    const values = group.map((e) => ({
      pluginId: e.pluginId,
      level: e.level,
      message: e.message,
      meta: e.meta,
    }));
    try {
      await dbInstance.insert(pluginLogs).values(values);
    } catch (err) {
      try {
        logger.warn(
          { err, count: values.length },
          "Failed to batch-persist plugin logs to DB"
        );
      } catch {
        console.error("[plugin-host-services] Batch log flush failed:", err);
      }
    }
  }
}

/** Interval handle for the periodic log flush. */
const _logFlushInterval = setInterval(() => {
  flushPluginLogBuffer().catch((err) => {
    console.error("[plugin-host-services] Periodic log flush error:", err);
  });
}, LOG_BUFFER_FLUSH_INTERVAL_MS);

// Allow the interval to be unref'd so it doesn't keep the process alive in tests.
if (_logFlushInterval.unref) _logFlushInterval.unref();

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Paperclip domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param pluginKey - The unique identifier from the plugin manifest (e.g., "acme.linear").
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
/** Maximum time (ms) to keep a session event subscription alive before forcing cleanup. */
const SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes

export function buildHostServices(
  db: Db,
  pluginId: string,
  pluginKey: string,
  eventBus: PluginEventBus,
  notifyWorker?: (method: string, params: unknown) => void
): HostServices & { dispose(): void } {
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const secretsHandler = createPluginSecretsHandler({ db, pluginId });
  const companies = companyService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const documents = documentService(db);
  const goals = goalService(db);
  const activity = activityService(db);
  const costs = costService(db);
  const assets = assetService(db);
  const scopedBus = eventBus.forPlugin(pluginId, pluginKey);

  // Track active session event subscriptions for cleanup
  const activeSubscriptions = new Set<{
    unsubscribe: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  // Incremented whenever the worker lifecycle releases host-side resources.
  // A single HostServices instance is reused by the worker manager across an
  // automatic crash/restart, so disposal must cancel work from the previous
  // generation without permanently disabling future calls.
  let lifecycleGeneration = 0;

  const ensureCompanyId = (companyId?: string) => {
    if (!companyId) throw new Error("companyId is required for this operation");
    return companyId;
  };

  const parseWindowValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return null;
  };

  const applyWindow = <T>(
    rows: T[],
    params?: { limit?: unknown; offset?: unknown }
  ): T[] => {
    const offset = parseWindowValue(params?.offset) ?? 0;
    const limit = parseWindowValue(params?.limit);
    if (limit == null) return rows.slice(offset);
    return rows.slice(offset, offset + limit);
  };

  /**
   * Per-company availability gate (B-M5).
   *
   * The plugin WORKER supplies the `companyId` on every host-service call, so
   * without this gate one installed plugin could read/write any company's data
   * — including companies that toggled it `disabled`, or companies it does not
   * belong to at all.
   *
   * Enforcement:
   *
   * 1. Ownership / existence — the `plugins` table is per-company
   *    (`companyId` NOT NULL). We load the plugin row filtered by
   *    `(id = pluginId, companyId = companyId)`. If no row matches, the plugin
   *    either does not exist or belongs to a DIFFERENT company → reject.
   *
   * 2. Explicit disable — `plugin_company_settings` is **default-ENABLED**:
   *    no row => enabled, `enabled = false` => disabled, `enabled = true` =>
   *    enabled. We therefore honor ONLY an explicit disable. We must NOT
   *    fail-closed on a missing row, or every plugin without a settings row
   *    would be wrongly blocked.
   */
  /**
   * Resolve the plugin's OWNING company id from the `plugins` row (per-company,
   * `companyId` NOT NULL). Derived server-side from `pluginId` — never trust a
   * worker-supplied companyId. Used to scope `companies.list` so a single plugin
   * worker can no longer enumerate every tenant's companies.
   */
  const resolveOwningCompanyId = async (): Promise<string | null> => {
    const row = await db
      .select({ companyId: pluginsTable.companyId })
      .from(pluginsTable)
      .where(eq(pluginsTable.id, pluginId))
      .then((r) => r[0] ?? null);
    return row?.companyId ?? null;
  };

  const ensurePluginAvailableForCompany = async (companyId: string) => {
    // 1. Ownership / existence (plugins is per-company).
    const pluginRow = await db
      .select()
      .from(pluginsTable)
      .where(
        and(
          eq(pluginsTable.id, pluginId),
          eq(pluginsTable.companyId, companyId)
        )
      )
      .then((rows) => rows[0] ?? null);
    if (!pluginRow) {
      throw new Error("Plugin is not available for this company");
    }

    // 2. Honor an explicit disable; default-enabled when no row / enabled=true.
    const settingsRow = await db
      .select()
      .from(pluginCompanySettings)
      .where(
        and(
          eq(pluginCompanySettings.pluginId, pluginId),
          eq(pluginCompanySettings.companyId, companyId)
        )
      )
      .then((rows) => rows[0] ?? null);
    if (settingsRow && settingsRow.enabled === false) {
      throw new Error("Plugin is disabled for this company");
    }
  };

  const inCompany = <T extends { companyId: string | null | undefined }>(
    record: T | null | undefined,
    companyId: string
  ): record is T => Boolean(record && record.companyId === companyId);

  const requireInCompany = <T extends { companyId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    companyId: string
  ): T => {
    if (!inCompany(record, companyId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    state: {
      async get(params) {
        return stateStore.get(
          pluginId,
          params.scopeKind as any,
          params.stateKey,
          {
            scopeId: params.scopeId,
            namespace: params.namespace,
          }
        );
      },
      async set(params) {
        await stateStore.set(pluginId, {
          scopeKind: params.scopeKind as any,
          scopeId: params.scopeId,
          namespace: params.namespace,
          stateKey: params.stateKey,
          value: params.value,
        });
      },
      async delete(params) {
        await stateStore.delete(
          pluginId,
          params.scopeKind as any,
          params.stateKey,
          {
            scopeId: params.scopeId,
            namespace: params.namespace,
          }
        );
      },
    },

    entities: {
      async upsert(params) {
        return registry.upsertEntity(pluginId, params as any) as any;
      },
      async list(params) {
        return registry.listEntities(pluginId, params as any) as any;
      },
    },

    events: {
      async emit(params) {
        if (params.companyId) {
          await ensurePluginAvailableForCompany(params.companyId);
        }
        await scopedBus.emit(params.name, params.companyId, params.payload);
      },
      async subscribe(params: {
        eventPattern: string;
        filter?: Record<string, unknown> | null;
      }) {
        const owningCompanyId = await resolveOwningCompanyId();
        if (!owningCompanyId) {
          throw new Error("Plugin owning company could not be resolved");
        }
        const handler = async (
          event: import("@armyofagents/plugin-sdk").PluginEvent
        ) => {
          if (event.companyId !== owningCompanyId) return;
          // Ownership is derived above from the plugin row. Re-check only the
          // mutable company override at delivery time so mid-session disable
          // revokes an already-registered subscription.
          const settingsRow = await db
            .select({ enabled: pluginCompanySettings.enabled })
            .from(pluginCompanySettings)
            .where(
              and(
                eq(pluginCompanySettings.pluginId, pluginId),
                eq(pluginCompanySettings.companyId, owningCompanyId)
              )
            )
            .then((rows) => rows[0] ?? null);
          if (settingsRow?.enabled === false) return;
          if (notifyWorker) {
            notifyWorker("onEvent", { event });
          }
        };
        if (params.filter) {
          scopedBus.subscribe(
            params.eventPattern as any,
            params.filter as any,
            handler
          );
        } else {
          scopedBus.subscribe(params.eventPattern as any, handler);
        }
      },
    },

    http: {
      async fetch(params) {
        // SSRF protection: validate protocol whitelist + block private IPs.
        // Resolve once, then connect directly to that IP to prevent DNS rebinding.
        const target = await validateAndResolveFetchUrl(params.url);

        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          PLUGIN_FETCH_TIMEOUT_MS
        );

        try {
          const init = params.init as RequestInit | undefined;
          return await executePinnedHttpRequest(
            target,
            init,
            controller.signal
          );
        } finally {
          clearTimeout(timeout);
        }
      },
    },

    secrets: {
      async resolve(params) {
        return secretsHandler.resolve(params);
      },
    },

    activity: {
      async log(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: pluginId,
          action: params.message,
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: params.metadata,
        });
      },
    },

    metrics: {
      async write(params) {
        const safeName = truncStr(
          String(params.name ?? ""),
          MAX_METRIC_NAME_LENGTH
        );
        logger.debug(
          { pluginId, name: safeName, value: params.value, tags: params.tags },
          "Plugin metric write"
        );

        // Persist metrics to plugin_logs via the batch buffer (same path as
        // logger.log) so they benefit from batched writes and are flushed
        // reliably on shutdown. Using level "metric" makes them queryable
        // alongside regular logs via the same API (§26).
        _logBuffer.push({
          db,
          pluginId,
          level: "metric",
          message: safeName,
          meta: sanitiseMeta({
            value: params.value,
            tags: params.tags ?? null,
          }),
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error(
              "[plugin-host-services] Triggered metric flush failed:",
              err
            );
          });
        }
      },
    },

    telemetry: {
      async track(params) {
        const eventName = String(params.eventName ?? "").trim();
        if (!TELEMETRY_EVENT_NAME_REGEX.test(eventName)) {
          throw new Error(
            'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".'
          );
        }
        // Phase I.2 Task 11 (PF.2): hand off to the env-gated transmission
        // path. Fire-and-forget — if AOA_FEEDBACK_ENDPOINT is unset, this is
        // a no-op; if set, the POST runs in the background. The host always
        // logs at debug so operators can tail plugin telemetry locally
        // regardless of transmission config.
        await transmitPluginTelemetry(eventName, params.dimensions);
        logger.debug(
          { pluginId, pluginKey, eventName, dimensions: params.dimensions },
          "Plugin telemetry event (transmitted if AOA_FEEDBACK_ENDPOINT set)"
        );
      },
    },

    logger: {
      async log(params) {
        const { level, meta } = params;
        const safeMessage = truncStr(
          String(params.message ?? ""),
          MAX_LOG_MESSAGE_LENGTH
        );
        const safeMeta = sanitiseMeta(meta);
        const pluginLogger = logger.child({
          service: "plugin-worker",
          pluginId,
        });
        const logFields = {
          ...safeMeta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error")
          pluginLogger.error(logFields, `[plugin] ${safeMessage}`);
        else if (level === "warn")
          pluginLogger.warn(logFields, `[plugin] ${safeMessage}`);
        else if (level === "debug")
          pluginLogger.debug(logFields, `[plugin] ${safeMessage}`);
        else pluginLogger.info(logFields, `[plugin] ${safeMessage}`);

        // Persist to plugin_logs table via the module-level batch buffer (§26.1).
        // Fire-and-forget — logging should never block the worker.
        _logBuffer.push({
          db,
          pluginId,
          level: level ?? "info",
          message: safeMessage,
          meta: safeMeta,
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error(
              "[plugin-host-services] Triggered log flush failed:",
              err
            );
          });
        }
      },
    },

    companies: {
      async list(params) {
        // Scope to the plugin's owning company (derived server-side from pluginId).
        // companyService.list([id]) filters via inArray; [] degrades to none (safe).
        const owningCompanyId = await resolveOwningCompanyId();
        return applyWindow(
          (await companies.list(
            owningCompanyId ? [owningCompanyId] : []
          )) as Company[],
          params
        );
      },
      async get(params) {
        await ensurePluginAvailableForCompany(params.companyId);
        return (await companies.getById(params.companyId)) as Company;
      },
    },

    projects: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return applyWindow(
          (await projects.list(companyId)) as Project[],
          params
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        return (
          inCompany(project, companyId) ? project : null
        ) as Project | null;
      },
      async listWorkspaces(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return [];
        const rows = await projects.listWorkspaces(params.projectId);
        return rows.map((row) => {
          const path = sanitizeWorkspacePath(row.cwd);
          const name = sanitizeWorkspaceName(row.name, path);
          return {
            id: row.id,
            projectId: row.projectId,
            name,
            path,
            isPrimary: row.isPrimary,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        });
      },
      async getPrimaryWorkspace(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        if (!inCompany(project, companyId)) return null;
        const row = project.primaryWorkspace;
        // TODO: AoA does not have project.codebase — adapt when workspace paths are ported
        const path = sanitizeWorkspacePath(
          (project as any).codebase?.effectiveLocalFolder ?? ""
        );
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `${project.id}:managed`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },

      async getWorkspaceForIssue(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = await issues.getById(params.issueId);
        if (!inCompany(issue, companyId)) return null;
        const projectId = (issue as Record<string, unknown>).projectId as
          | string
          | null;
        if (!projectId) return null;
        const project = await projects.getById(projectId);
        if (!inCompany(project, companyId)) return null;
        const row = project.primaryWorkspace;
        // TODO: AoA does not have project.codebase — adapt when workspace paths are ported
        const path = sanitizeWorkspacePath(
          (project as any).codebase?.effectiveLocalFolder ?? ""
        );
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `${project.id}:managed`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },
    },

    issues: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return applyWindow(
          (await issues.list(companyId, params as any)) as Issue[],
          params
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const issue = await issues.getById(params.issueId);
        return (inCompany(issue, companyId) ? issue : null) as Issue | null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return (await issues.create(companyId, params as any)) as Issue;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        return (await issues.update(
          params.issueId,
          params.patch as any
        )) as Issue;
      },
      async listComments(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        if (!inCompany(await issues.getById(params.issueId), companyId))
          return [];
        return (await issues.listComments(params.issueId)) as IssueComment[];
      },
      async createComment(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        return (await issues.addComment(
          params.issueId,
          params.body,
          {}
        )) as IssueComment;
      },
    },

    issueDocuments: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        const rows = await documents.listIssueDocuments(params.issueId);
        return rows as any;
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        const doc = await documents.getIssueDocumentByKey(
          params.issueId,
          params.key
        );
        return (doc ?? null) as any;
      },
      async upsert(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        const result = await documents.upsertIssueDocument({
          issueId: params.issueId,
          key: params.key,
          body: params.body,
          title: params.title ?? null,
          format: params.format ?? "markdown",
          changeSummary: params.changeSummary ?? null,
        });
        return result.document as any;
      },
      async delete(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany(
          "Issue",
          await issues.getById(params.issueId),
          companyId
        );
        await documents.deleteIssueDocument(params.issueId, params.key);
      },
    },

    agents: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await agents.list(companyId);
        return applyWindow(
          rows.filter(
            (agent) => !params.status || agent.status === params.status
          ) as Agent[],
          params
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        return (inCompany(agent, companyId) ? agent : null) as Agent | null;
      },
      async pause(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.pause(params.agentId)) as Agent;
      },
      async resume(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        return (await agents.resume(params.agentId)) as Agent;
      },
      async invoke(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const run = await heartbeat.wakeup(params.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run)
          throw new Error("Agent wakeup was skipped by heartbeat policy");
        return { runId: run.id };
      },
    },

    goals: {
      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await goals.list(companyId);
        return applyWindow(
          rows.filter(
            (goal) =>
              (!params.level || goal.level === params.level) &&
              (!params.status || goal.status === params.status)
          ) as Goal[],
          params
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const goal = await goals.getById(params.goalId);
        return (inCompany(goal, companyId) ? goal : null) as Goal | null;
      },
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return (await goals.create(companyId, {
          title: params.title,
          description: params.description,
          level: params.level as any,
          status: params.status as any,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        })) as Goal;
      },
      async update(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        requireInCompany("Goal", await goals.getById(params.goalId), companyId);
        return (await goals.update(params.goalId, params.patch as any)) as Goal;
      },
    },

    agentSessions: {
      async create(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const agent = await agents.getById(params.agentId);
        requireInCompany("Agent", agent, companyId);
        const taskKey =
          params.taskKey ?? `plugin:${pluginKey}:session:${randomUUID()}`;

        const row = await db
          .insert(agentTaskSessionsTable)
          .values({
            companyId,
            agentId: params.agentId,
            adapterType: agent!.adapterType,
            taskKey,
            sessionParamsJson: null,
            sessionDisplayId: null,
            lastRunId: null,
            lastError: null,
          })
          .returning()
          .then((rows) => rows[0]);

        return {
          sessionId: row!.id,
          agentId: params.agentId,
          companyId,
          status: "active" as const,
          createdAt: row!.createdAt.toISOString(),
        };
      },

      async list(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const rows = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.agentId, params.agentId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(
                agentTaskSessionsTable.taskKey,
                `plugin:${pluginKey}:session:%`
              )
            )
          )
          .orderBy(desc(agentTaskSessionsTable.createdAt));

        return rows.map((row) => ({
          sessionId: row.id,
          agentId: row.agentId,
          companyId: row.companyId,
          status: "active" as const,
          createdAt: row.createdAt.toISOString(),
        }));
      },

      async sendMessage(params) {
        const callGeneration = lifecycleGeneration;

        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);

        // Verify session exists and belongs to this plugin
        const session = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(
                agentTaskSessionsTable.taskKey,
                `plugin:${pluginKey}:session:%`
              )
            )
          )
          .then((rows) => rows[0] ?? null);
        if (!session) throw new Error(`Session not found: ${params.sessionId}`);

        const run = await heartbeat.wakeup(session.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          contextSnapshot: {
            taskKey: session.taskKey,
            wakeSource: "automation",
            wakeTriggerDetail: "system",
          },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run)
          throw new Error("Agent wakeup was skipped by heartbeat policy");

        // The worker may have crashed or been stopped while heartbeat.wakeup()
        // was in flight. Return the already-created run, but do not attach a
        // listener that belongs to the now-ended worker generation.
        if (callGeneration !== lifecycleGeneration) {
          return { runId: run.id };
        }

        // Subscribe to live events and forward to the plugin worker as notifications.
        // Track the subscription so it can be cleaned up on dispose() if the run
        // never reaches a terminal status (hang, crash, network partition).
        if (notifyWorker) {
          const TERMINAL_STATUSES = new Set([
            "succeeded",
            "failed",
            "cancelled",
            "timed_out",
          ]);

          const cleanup = () => {
            unsubscribe();
            clearTimeout(timeoutTimer);
            activeSubscriptions.delete(entry);
          };

          const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
            const payload = event.payload as
              | Record<string, unknown>
              | undefined;
            if (!payload || payload.runId !== run.id) return;

            if (
              event.type === "heartbeat.run.log" ||
              event.type === "heartbeat.run.event"
            ) {
              notifyWorker("agents.sessions.event", {
                sessionId: params.sessionId,
                runId: run.id,
                seq: (payload.seq as number) ?? 0,
                eventType: "chunk",
                stream: (payload.stream as string) ?? null,
                message:
                  (payload.chunk as string) ??
                  (payload.message as string) ??
                  null,
                payload: payload,
              });
            } else if (event.type === "heartbeat.run.status") {
              const status = payload.status as string;
              if (TERMINAL_STATUSES.has(status)) {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: status === "succeeded" ? "done" : "error",
                  stream: "system",
                  message:
                    status === "succeeded" ? "Run completed" : `Run ${status}`,
                  payload: payload,
                });
                cleanup();
              } else {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: "status",
                  stream: "system",
                  message: `Run status: ${status}`,
                  payload: payload,
                });
              }
            }
          });

          // Safety-net timeout: if the run never reaches a terminal status,
          // force-cleanup the subscription to prevent unbounded leaks.
          const timeoutTimer = setTimeout(() => {
            logger.warn(
              { pluginId, pluginKey, runId: run.id },
              "session event subscription timed out — forcing cleanup"
            );
            cleanup();
          }, SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS);

          const entry = { unsubscribe, timer: timeoutTimer };
          activeSubscriptions.add(entry);
        }

        return { runId: run.id };
      },

      async close(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const deleted = await db
          .delete(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.companyId, companyId),
              like(
                agentTaskSessionsTable.taskKey,
                `plugin:${pluginKey}:session:%`
              )
            )
          )
          .returning()
          .then((rows) => rows.length);
        if (deleted === 0)
          throw new Error(`Session not found: ${params.sessionId}`);
      },
    },

    /**
     * Clean up all active session event subscriptions and flush any buffered
     * log entries. Must be called when the plugin worker is stopped, crashed,
     * or unloaded to prevent leaked listeners and lost log entries.
     */
    dispose() {
      lifecycleGeneration += 1;

      // Clear event bus subscriptions to prevent accumulation on worker restart.
      // Without this, each crash/restart cycle adds duplicate subscriptions.
      scopedBus.clear();

      // Snapshot to avoid iterator invalidation from concurrent sendMessage() calls
      const snapshot = Array.from(activeSubscriptions);
      activeSubscriptions.clear();

      for (const entry of snapshot) {
        clearTimeout(entry.timer);
        entry.unsubscribe();
      }

      // Flush any buffered log entries synchronously-as-possible on dispose.
      flushPluginLogBuffer().catch((err) => {
        console.error(
          "[plugin-host-services] dispose() log flush failed:",
          err
        );
      });
    },
  };
}

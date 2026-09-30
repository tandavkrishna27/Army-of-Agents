import type { Db } from "@armyofagents/db";
import type {
  Environment,
  EnvironmentLease,
  EnvironmentLeaseCleanupStatus,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
} from "@armyofagents/shared";
import { environmentService, type EnvironmentService } from "./environments.js";
import {
  sandboxProviderRuntime,
  type SandboxProviderExecuteResult,
  type SandboxProviderRuntime,
  type SandboxRuntimeProvider,
} from "./sandbox-provider-runtime.js";
import { runtimeProviderKeyService } from "./runtime-provider-keys.js";
import { WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT } from "./warm-sandbox-constants.js";
import { logger } from "../middleware/logger.js";

type PersistedExecutionWorkspaceRef = {
  id: string;
  mode: string;
};

export function buildEnvironmentLeaseContext(input: {
  persistedExecutionWorkspace: PersistedExecutionWorkspaceRef | null;
}) {
  return {
    executionWorkspaceId: input.persistedExecutionWorkspace?.id ?? null,
    executionWorkspaceMode: input.persistedExecutionWorkspace?.mode ?? null,
  };
}

export interface EnvironmentDriverAcquireInput {
  companyId: string;
  environment: Environment;
  issueId: string | null;
  heartbeatRunId: string | null;
  persistedExecutionWorkspace: PersistedExecutionWorkspaceRef | null;
  // Deployment-mode-aware sandbox hardening (P5 SSRF residual). When the run executes
  // on SHARED multi-tenant infra, the tenant-authored gVisor environment config must
  // not weaken the sandbox; on self-hosted it is honored. Resolved once by the
  // orchestrator; defaults to fail-closed hardening when absent.
  multiTenant?: boolean;
  /**
   * S4 — best-effort egress allowlist, threaded to `providerRuntime.acquireLease`
   * for provider-sandbox leases only (ignored by the local driver). U6.2
   * introduces the param wired end-to-end with an empty placeholder from the
   * orchestrator; U11 populates it with connector hosts + npm.
   */
  egressAllowlist?: string[];
  /**
   * U7.5 — warm-reuse preference for THIS run, resolved once by the org call
   * site via `resolveWarmSandboxPreference` (crew/Commander always pass false).
   * When true AND `agentId` is set, the acquire path first tries to RESUME this
   * agent's paused sandbox; otherwise it creates a fresh `reuse_by_agent` lease
   * so the next run can resume it. Absent/false ⇒ byte-identical ephemeral path.
   */
  warmPreference?: boolean;
  /** U7.5 — the org agent to hold/resume a warm lease for. Persisted on the
   *  lease (agent_id) so `findResumablePausedLease` can match it next run. */
  agentId?: string | null;
  /** W7.5c — Commander conversation warm key (Commander has no agentId). When
   *  set with warmPreference, the acquire path resumes/creates a
   *  conversation-keyed warm lease. */
  commanderConversationId?: string | null;
}

export interface EnvironmentDriverReleaseInput {
  environment: Environment;
  lease: EnvironmentLease;
  status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained">;
  /**
   * U7.6 — force-destroy. When true the release ALWAYS kills the sandbox,
   * ignoring `leasePolicy`: a reaped (idle-TTL) or evicted (over-cap) warm lease
   * must be killed, never re-paused. Mirror-image of U7.5's reuse pause branch —
   * it forces `reuseLease: false` into the provider config so the E2B provider
   * kills instead of pausing. Used by the warm-sandbox reaper / evict path.
   */
  forceDestroy?: boolean;
}

export interface EnvironmentDriverExecuteInput {
  environment: Environment;
  lease: EnvironmentLease;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  /** U7.5b — optional live-output callbacks, forwarded to the provider's
   *  execute (E2B commands.run). Omitted ⇒ buffered-only, byte-identical. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

// U6.2 — file-movement seam (mirrors EnvironmentDriverExecuteInput's shape:
// bind environment + lease, forward the provider-facing payload).
export interface EnvironmentDriverWriteFilesInput {
  environment: Environment;
  lease: EnvironmentLease;
  files: Array<{ path: string; content: Buffer }>;
}

export interface EnvironmentDriverReadFilesInput {
  environment: Environment;
  lease: EnvironmentLease;
  paths: string[];
}

export interface EnvironmentDriverResolveHostInput {
  environment: Environment;
  lease: EnvironmentLease;
  port: number;
}

export interface EnvironmentRuntimeLeaseRecord {
  environment: Environment;
  lease: EnvironmentLease;
  leaseContext: ReturnType<typeof buildEnvironmentLeaseContext>;
}

export interface EnvironmentRuntimeDriver {
  readonly driver: string;
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentLease>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : new Date(0).toISOString();
}

function toNullableIsoString(value: unknown): string | null {
  if (value == null) return null;
  return toIsoString(value);
}

function normalizeEnvironment(row: unknown): Environment {
  const record = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? ""),
    companyId: String(record.companyId ?? ""),
    name: String(record.name ?? ""),
    description: typeof record.description === "string" ? record.description : null,
    driver: (typeof record.driver === "string" ? record.driver : "local") as Environment["driver"],
    status: (typeof record.status === "string" ? record.status : "active") as Environment["status"],
    config: record.config && typeof record.config === "object" && !Array.isArray(record.config)
      ? record.config as Record<string, unknown>
      : {},
    metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : null,
    envVars: record.envVars && typeof record.envVars === "object" && !Array.isArray(record.envVars)
      ? record.envVars as Record<string, unknown>
      : {},
    connectionTarget: record.connectionTarget && typeof record.connectionTarget === "object" && !Array.isArray(record.connectionTarget)
      ? record.connectionTarget as Record<string, unknown>
      : null,
    target: record.target && typeof record.target === "object" && !Array.isArray(record.target)
      ? record.target as Record<string, unknown>
      : null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
  };
}

export function normalizeEnvironmentLease(row: unknown): EnvironmentLease {
  const record = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? ""),
    companyId: String(record.companyId ?? ""),
    environmentId: String(record.environmentId ?? ""),
    executionWorkspaceId: typeof record.executionWorkspaceId === "string" ? record.executionWorkspaceId : null,
    issueId: typeof record.issueId === "string" ? record.issueId : null,
    heartbeatRunId: typeof record.heartbeatRunId === "string" ? record.heartbeatRunId : null,
    agentId: typeof record.agentId === "string" ? record.agentId : null,
    status: (typeof record.status === "string" ? record.status : "active") as EnvironmentLeaseStatus,
    leasePolicy: (typeof record.leasePolicy === "string" ? record.leasePolicy : "ephemeral") as EnvironmentLeasePolicy,
    provider: typeof record.provider === "string" ? record.provider : null,
    providerLeaseId: typeof record.providerLeaseId === "string" ? record.providerLeaseId : null,
    acquiredAt: toIsoString(record.acquiredAt),
    lastUsedAt: toIsoString(record.lastUsedAt),
    expiresAt: toNullableIsoString(record.expiresAt),
    releasedAt: toNullableIsoString(record.releasedAt),
    pausedAt: toNullableIsoString(record.pausedAt),
    failureReason: typeof record.failureReason === "string" ? record.failureReason : null,
    cleanupStatus: (typeof record.cleanupStatus === "string" ? record.cleanupStatus : null) as EnvironmentLeaseCleanupStatus | null,
    metadata: record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : null,
    createdAt: toIsoString(record.createdAt),
    updatedAt: toIsoString(record.updatedAt),
  };
}

export interface EnvironmentRuntimeService {
  acquireRunLease(input: EnvironmentDriverAcquireInput): Promise<EnvironmentRuntimeLeaseRecord>;
  releaseRunLease(input: EnvironmentDriverReleaseInput): Promise<EnvironmentLease | null>;
  releaseRunLeases(heartbeatRunId: string): Promise<EnvironmentLease[]>;
  executeRunLeaseCommand(input: EnvironmentDriverExecuteInput): Promise<SandboxProviderExecuteResult>;
  // U6.2 — file-movement seam, mirrors executeRunLeaseCommand's provider-resolution
  // shape. Provider-sandbox leases only; docker/local leases throw (same posture
  // as executeRunLeaseCommand today).
  writeFiles(input: EnvironmentDriverWriteFilesInput): Promise<void>;
  readFiles(input: EnvironmentDriverReadFilesInput): Promise<Array<{ path: string; content: Buffer }>>;
  resolveHost(input: EnvironmentDriverResolveHostInput): Promise<string>;
}

function createLocalEnvironmentDriver(environmentsSvc: EnvironmentService): EnvironmentRuntimeDriver {
  return {
    driver: "local",

    async acquireRunLease(input) {
      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      return normalizeEnvironmentLease(await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: {
          driver: input.environment.driver,
          executionWorkspaceMode: leaseContext.executionWorkspaceMode,
        },
      }));
    },

    async releaseRunLease(input) {
      const released = await environmentsSvc.releaseLease(input.lease.id, input.status);
      return released ? normalizeEnvironmentLease(released) : null;
    },
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveDockerSandboxConfig(
  environment: Pick<Environment, "config">,
  opts: { multiTenant?: boolean } = {},
): Record<string, unknown> {
  const config = readObject(environment.config);
  const provider = readString(config.provider) ?? "sandbox-docker";
  if (provider === "gvisor") {
    // gVisor runs on the single-box sandbox-docker transport with a hardened,
    // opt-in isolation profile. Normalize via resolveGvisorSandboxTarget so the
    // lease metadata carries type/runtime/network/isolation/allowHostGateway for
    // the downstream exec-target -> buildDockerRunArgs path. The multiTenant flag
    // threads the deployment-mode-aware hardening (see resolveGvisorSandboxTarget).
    // Non-gvisor docker providers below are untouched (byte-identical legacy behavior).
    const target = resolveGvisorSandboxTarget(config, { multiTenant: opts.multiTenant });
    return { ...config, ...target, provider: "sandbox-docker" };
  }
  if (provider !== "sandbox-docker" && provider !== "docker" && provider !== "local-docker") {
    throw new Error(`Unsupported sandbox provider "${provider}"`);
  }
  const image = readString(config.image);
  if (!image) {
    throw new Error("Sandbox Docker environments require config.image.");
  }
  return {
    ...config,
    provider: "sandbox-docker",
    image,
  };
}

export function resolveGvisorSandboxTarget(
  config: Record<string, unknown>,
  // Whether this run executes on SHARED multi-tenant infra. gVisor ENVIRONMENTS are
  // always tenant-authored (company-scoped `environments.config`), so on shared infra
  // this config must NOT be able to weaken the sandbox (the SSRF residual: a tenant
  // gVisor config setting allowHostGateway:true / network:"bridge"|"host" / turning off
  // capDropAll/readOnlyRootfs/noNewPrivileges would reach buildDockerRunArgs). On the
  // founder's OWN box (self-hosted) the config is trusted and honored exactly.
  // Fail-closed default (`true`) hardens when a caller forgets to thread it.
  opts: { multiTenant?: boolean } = {},
): {
  type: "sandbox-docker";
  image: string;
  workdir: string;
  network: "none" | "bridge" | "host";
  runtime: "runsc";
  allowHostGateway: boolean;
  isolation: Record<string, unknown>;
} {
  const multiTenant = opts.multiTenant ?? true;
  const image = readString(config.image);
  if (!image) throw new Error("gVisor environments require config.image.");
  const iso = (config.isolation && typeof config.isolation === "object" && !Array.isArray(config.isolation)
    ? (config.isolation as Record<string, unknown>)
    : {});
  const networkRaw = readString(config.network) ?? "none";
  const requestedNetwork = networkRaw === "bridge" || networkRaw === "host" ? networkRaw : "none";
  const defaultTmpfs = ["/tmp:rw,noexec,nosuid,size=64m", "/home/agent:rw,nosuid,size=256m"];
  // SECURITY (P5 residual): on shared infra force the hardened profile regardless of
  // the tenant-authored config; on self-hosted honor config (byte-identical to pre-P5).
  return {
    type: "sandbox-docker",
    image,
    workdir: readString(config.workdir) ?? "/workspace",
    network: multiTenant ? "none" : requestedNetwork,
    runtime: "runsc",
    allowHostGateway: multiTenant ? false : config.allowHostGateway === true,
    isolation: {
      user: multiTenant ? "1000:1000" : (readString(iso.user) ?? "1000:1000"),
      capDropAll: multiTenant ? true : iso.capDropAll !== false,
      noNewPrivileges: multiTenant ? true : iso.noNewPrivileges !== false,
      seccompProfile: multiTenant ? null : readString(iso.seccompProfile),
      readOnlyRootfs: multiTenant ? true : iso.readOnlyRootfs !== false,
      tmpfs: multiTenant
        ? defaultTmpfs
        : (Array.isArray(iso.tmpfs) && iso.tmpfs.length > 0 ? iso.tmpfs : defaultTmpfs),
      memory: multiTenant ? "2g" : (readString(iso.memory) ?? "2g"),
      cpus: multiTenant ? "2" : (readString(iso.cpus) ?? "2"),
      pidsLimit: multiTenant ? 512 : (typeof iso.pidsLimit === "number" ? iso.pidsLimit : 512),
      ipcPrivate: multiTenant ? true : iso.ipcPrivate !== false,
    },
  };
}

function isDockerSandboxProvider(provider: string): boolean {
  return provider === "sandbox-docker" || provider === "docker" || provider === "local-docker" || provider === "gvisor";
}

type RuntimeProviderKeyResolver = Pick<ReturnType<typeof runtimeProviderKeyService>, "resolveCredential">;

export async function resolveRuntimeProviderConfig(input: {
  companyId: string;
  provider: string;
  config: Record<string, unknown>;
  runtimeProviderKeys: RuntimeProviderKeyResolver | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
}) {
  if (input.provider !== "e2b" || !input.runtimeProviderKeys) return input.config;
  let resolvedApiKey: string;
  try {
    resolvedApiKey = await input.runtimeProviderKeys.resolveCredential(
      input.companyId,
      "e2b",
      input.config,
      {
        consumerType: "system",
        consumerId: "runtime-provider-key:e2b",
        actorType: "system",
        configPath: "runtimeProviderKeys.e2b.default",
        issueId: input.issueId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
      },
    );
  } catch (err) {
    // Platform-default E2B environments (and any e2b env with no configured
    // default key) carry NO credentialSecretId/credentialRef, so resolveCredential
    // hits the "default" branch and throws notFound (HTTP 404) when no
    // runtime_provider_keys row exists. That is the DESIGNED case: the operator's
    // env.E2B_API_KEY is the default key, which the E2B provider's resolveE2bApiKey
    // reads from env at acquire time (platform-default-environment.ts:28-31). Return
    // the config UNCHANGED so that env fallback fires. Only a MISSING default key
    // (404) falls back — a bad credentialRef / inactive secret (badRequest 400) or a
    // decrypt failure still throws loudly, and a real credentialSecretId env is
    // unaffected (it never hits the default branch).
    if (err && typeof err === "object" && (err as { status?: number }).status === 404) {
      return input.config;
    }
    throw err;
  }
  const config: Record<string, unknown> = { ...input.config, resolvedApiKey };
  delete config.apiKey;
  return config;
}

function sanitizeProviderMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/^(apiKey|resolvedApiKey)$/i.test(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

/**
 * U7.7 — OAuth connector token re-resolution on warm resume (SECURITY invariant).
 *
 * A paused E2B snapshot's env can hold a STALE, bounded-TTL connector token (an
 * `AOA_MCP_*_TOKEN` minted per #317 OAuth broker) baked into a `metadata.env` /
 * `metadata.providerMetadata.env` map at pause time. On warm RESUME that stale
 * token must NEVER travel forward on the lease record the caller stages the run
 * with: the run's env is re-resolved + re-injected FRESH at EVERY stage-in —
 * including on warm `resume()` — by the connector token resolver
 * (`resolveAgentConnectors`, which runs on every org run regardless of
 * create-vs-resume; see heartbeat.ts) and never reads the lease's baked env.
 * Only the minted short-lived access token ever crosses into the VM; the
 * refresh token / signed bundle stay host-side (spec §7 + §9).
 *
 * This is DEFENSE-IN-DEPTH on the lease record itself: `reactivatePausedLease`
 * does an `UPDATE … RETURNING *`, so the returned row still carries whatever
 * `metadata` was persisted at create/pause time — potentially a stale token.
 * Strip any `env` off both the top-level `metadata` and the nested
 * `metadata.providerMetadata` before the lease reaches the caller, so a stale
 * token can never ride forward — even for a stage-in that (now or in future)
 * naively seeded env from the resumed snapshot's baked provider env. Surgical:
 * ONLY the env maps are removed; the provider identity + sandbox reconnect
 * handle the resume needs (provider, providerLeaseId, providerMetadata.remoteCwd,
 * reuseLease, …) are preserved untouched.
 */
export function stripStaleLeaseEnv(lease: EnvironmentLease): EnvironmentLease {
  const metadata = lease.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return lease;

  let mutated = false;
  const nextMetadata: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };

  if ("env" in nextMetadata) {
    delete nextMetadata.env;
    mutated = true;
  }

  const providerMetadata = nextMetadata.providerMetadata;
  if (
    providerMetadata &&
    typeof providerMetadata === "object" &&
    !Array.isArray(providerMetadata) &&
    "env" in (providerMetadata as Record<string, unknown>)
  ) {
    const nextProviderMetadata = { ...(providerMetadata as Record<string, unknown>) };
    delete nextProviderMetadata.env;
    nextMetadata.providerMetadata = nextProviderMetadata;
    mutated = true;
  }

  return mutated ? { ...lease, metadata: nextMetadata } : lease;
}

function createSandboxDockerEnvironmentDriver(
  db: Db,
  environmentsSvc: EnvironmentService,
  providerRuntime: SandboxProviderRuntime,
  runtimeProviderKeys: RuntimeProviderKeyResolver | null,
): EnvironmentRuntimeDriver {
  return {
    driver: "sandbox",

    async acquireRunLease(input) {
      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const rawConfig = readObject(input.environment.config);
      const provider = readString(rawConfig.provider) ?? "sandbox-docker";
      if (!isDockerSandboxProvider(provider)) {
        const providerConfig = await resolveRuntimeProviderConfig({
          companyId: input.companyId,
          provider,
          config: rawConfig,
          runtimeProviderKeys,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
        });

        // U7.5 / W7.5c — warm reuse for BOTH org agents (agentId) and Commander
        // (commanderConversationId). Only when the caller prefers warm AND names
        // exactly one warm key; crew/Commander-off pass warmPreference false (the
        // resolver already forces them ephemeral). The query methods are Partial
        // on the DI seam, so a test double without them falls straight through to
        // the ephemeral create path below.
        const warmByAgent = !!input.agentId
          && typeof environmentsSvc.findResumablePausedLease === "function";
        const warmByConversation = !!input.commanderConversationId
          && typeof environmentsSvc.findResumableCommanderPausedLease === "function";
        const warm = input.warmPreference === true && (warmByAgent || warmByConversation);

        // ── Warm resume: reconnect to the paused sandbox for this key, if any ──
        if (warm) {
          const paused = warmByAgent
            ? await environmentsSvc.findResumablePausedLease!({
                companyId: input.companyId,
                agentId: input.agentId!,
                environmentId: input.environment.id,
              })
            : await environmentsSvc.findResumableCommanderPausedLease!({
                companyId: input.companyId,
                conversationId: input.commanderConversationId!,
                environmentId: input.environment.id,
              });
          if (paused?.providerLeaseId) {
            const pausedProviderMetadata = readObject(readObject(paused.metadata).providerMetadata);
            let resume: Awaited<ReturnType<typeof providerRuntime.resumeLease>> | null = null;
            try {
              resume = await providerRuntime.resumeLease(provider, {
                providerLeaseId: paused.providerLeaseId,
                leaseMetadata: pausedProviderMetadata,
                config: providerConfig,
              });
            } catch (resumeErr) {
              // resumeLease is contractually no-throw (spec §8 "never error the
              // run"), but stay defensive: any throw is treated as a dead
              // snapshot → create-fresh below, never surfaced to the run.
              logger.warn(
                { err: resumeErr, provider, providerLeaseId: paused.providerLeaseId, environmentId: input.environment.id },
                "environment runtime: warm resume threw; falling back to create-fresh",
              );
              resume = null;
            }
            if (resume?.resumed && typeof environmentsSvc.reactivatePausedLease === "function") {
              const reactivated = await environmentsSvc.reactivatePausedLease(paused.id, {
                heartbeatRunId: input.heartbeatRunId,
                issueId: input.issueId,
                executionWorkspaceId: leaseContext.executionWorkspaceId,
              });
              // The `AND status='paused'` guard means a concurrent run may have
              // already claimed this lease (no row returned) — fall through to
              // create-fresh in that case rather than double-booking the VM.
              // U7.7 — strip any stale connector token baked into the resumed
              // lease's metadata (spec §7/§9): the run's env is re-resolved
              // FRESH at stage-in, so the paused snapshot's token must never
              // ride forward on the lease record.
              if (reactivated) return stripStaleLeaseEnv(normalizeEnvironmentLease(reactivated));
            } else {
              // Dead/GC'd snapshot (resumed:false): retire the stale paused row
              // so it is never resumed again. Best-effort — must never block
              // the create-fresh below.
              await environmentsSvc.releaseLease(paused.id, "expired", { cleanupStatus: "success" })
                .catch(() => undefined);
            }
          }
        }

        // U7.6 — per-company cap: before minting a fresh WARM sandbox, bound
        // accumulation of live+paused provider sandboxes. Over the cap, evict
        // the oldest PAUSED sandbox (never block the run; if all are active the
        // cap is a soft ceiling and we proceed anyway). Best-effort — a failure
        // here must never fail the acquire. `evictOldestPausedSandbox` is
        // dynamically imported to break the environment-runtime ↔ reaper cycle.
        if (warm && typeof environmentsSvc.listLiveAndPausedProviderLeasesForCompany === "function") {
          try {
            const live = await environmentsSvc.listLiveAndPausedProviderLeasesForCompany(input.companyId);
            if (live.length >= WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT) {
              const { evictOldestPausedSandbox } = await import("./warm-sandbox-reaper.js");
              await evictOldestPausedSandbox(db, input.companyId, { environments: environmentsSvc });
            }
          } catch (capErr) {
            logger.warn(
              { err: capErr, companyId: input.companyId, environmentId: input.environment.id },
              "environment runtime: warm per-company cap eviction failed (best-effort)",
            );
          }
        }

        // Create fresh. Warm ⇒ tell the provider to snapshot-on-release
        // (reuseLease) and tag the DB lease reuse_by_agent + agentId so the
        // NEXT run can resume it. Ephemeral ⇒ byte-identical to before U7.5.
        const createProviderConfig = warm ? { ...providerConfig, reuseLease: true } : providerConfig;
        const providerLease = await providerRuntime.acquireLease(provider, {
          companyId: input.companyId,
          environmentId: input.environment.id,
          issueId: input.issueId,
          heartbeatRunId: input.heartbeatRunId,
          config: createProviderConfig,
          workspaceMode: leaseContext.executionWorkspaceMode,
          // S4 — threaded straight through; undefined for callers that
          // haven't been updated yet (byte-identical acquire call for them).
          egressAllowlist: input.egressAllowlist,
        });
        try {
          return normalizeEnvironmentLease(await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: leaseContext.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            leasePolicy: warm ? "reuse_by_agent" : "ephemeral",
            // Tag the fresh warm lease with whichever key is populated — org
            // agents by agentId, Commander by commanderConversationId. The
            // reused `reuse_by_agent` policy literal keeps release + reaper
            // unchanged; the resume KEY is the populated column (W7.5c).
            ...(warm && input.agentId ? { agentId: input.agentId } : {}),
            ...(warm && input.commanderConversationId ? { commanderConversationId: input.commanderConversationId } : {}),
            provider,
            providerLeaseId: providerLease.providerLeaseId,
            expiresAt: providerLease.expiresAt ? new Date(providerLease.expiresAt) : null,
            metadata: {
              driver: input.environment.driver,
              executionWorkspaceMode: leaseContext.executionWorkspaceMode,
              provider,
              providerMetadata: sanitizeProviderMetadata(providerLease.metadata),
            },
          }));
        } catch (err) {
          await providerRuntime.releaseLease(provider, {
            providerLeaseId: providerLease.providerLeaseId,
            leaseMetadata: sanitizeProviderMetadata(providerLease.metadata),
            config: providerConfig,
          }).catch((releaseErr: unknown) => {
            logger.warn(
              {
                err: releaseErr,
                provider,
                providerLeaseId: providerLease.providerLeaseId,
                environmentId: input.environment.id,
                heartbeatRunId: input.heartbeatRunId,
              },
              "environment runtime: failed to release provider lease after DB acquire failure",
            );
          });
          throw err;
        }
      }

      const sandboxConfig = resolveDockerSandboxConfig(input.environment, { multiTenant: input.multiTenant });
      return normalizeEnvironmentLease(await environmentsSvc.acquireLease({
        companyId: input.companyId,
        environmentId: input.environment.id,
        executionWorkspaceId: leaseContext.executionWorkspaceId,
        issueId: input.issueId,
        heartbeatRunId: input.heartbeatRunId,
        leasePolicy: "ephemeral",
        provider: "sandbox-docker",
        metadata: {
          driver: input.environment.driver,
          executionWorkspaceMode: leaseContext.executionWorkspaceMode,
          ...sandboxConfig,
        },
      }));
    },

    async releaseRunLease(input) {
      const provider = readString(input.lease.provider);
      if (provider && provider !== "sandbox-docker" && !isDockerSandboxProvider(provider)) {
        try {
          const providerConfig = await resolveRuntimeProviderConfig({
            companyId: input.lease.companyId,
            provider,
            config: readObject(input.environment.config),
            runtimeProviderKeys,
            issueId: input.lease.issueId,
            heartbeatRunId: input.lease.heartbeatRunId,
          });

          // U7.5 — pause-not-kill for warm (`reuse_by_agent`) leases at run end.
          // CRITICAL: `providerConfig` is resolved FRESH from the environment
          // row (the ephemeral base template) and does NOT carry `reuseLease`;
          // the DB lease metadata nests it under `providerMetadata`, where
          // `configFromE2bLease` never looks — so without explicitly forcing
          // `reuseLease: true` here the E2B provider KILLS instead of pauses and
          // warm reuse is silently dead. (Mirror-image of the U7.6 forceDestroy
          // path, which forces `reuseLease: false`.)
          const isReuse =
            readString(input.lease.leasePolicy) === "reuse_by_agent" ||
            readObject(input.lease.metadata).reuseLease === true;
          // forceDestroy (U7.6) takes precedence: a reaped/evicted lease is
          // killed, never re-paused — so the pause branch is gated on it.
          if (isReuse && input.forceDestroy !== true && typeof environmentsSvc.markLeasePaused === "function") {
            const released = await providerRuntime.releaseLease(provider, {
              providerLeaseId: input.lease.providerLeaseId,
              leaseMetadata: input.lease.metadata,
              config: { ...providerConfig, reuseLease: true },
            });
            const row = await environmentsSvc.markLeasePaused(input.lease.id, {
              cleanupStatus: released.cleanupStatus,
            });
            return row ? normalizeEnvironmentLease(row) : null;
          }

          // Ephemeral kill, or forceDestroy kill of a warm lease. forceDestroy
          // explicitly forces reuseLease:false so a warm lease (whose metadata
          // carries reuseLease under providerMetadata) is killed, not paused.
          const released = await providerRuntime.releaseLease(provider, {
            providerLeaseId: input.lease.providerLeaseId,
            leaseMetadata: input.lease.metadata,
            config: input.forceDestroy === true ? { ...providerConfig, reuseLease: false } : providerConfig,
          });
          const row = await environmentsSvc.releaseLease(input.lease.id, input.status, {
            cleanupStatus: released.cleanupStatus,
          });
          return row ? normalizeEnvironmentLease(row) : null;
        } catch (err) {
          const row = await environmentsSvc.releaseLease(input.lease.id, "failed", {
            cleanupStatus: "failed",
            failureReason: `provider release failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return row ? normalizeEnvironmentLease(row) : null;
        }
      }

      const released = await environmentsSvc.releaseLease(input.lease.id, input.status);
      return released ? normalizeEnvironmentLease(released) : null;
    },
  };
}

export function environmentRuntimeService(
  db: Db,
  options: {
    environments?: Pick<EnvironmentService, "acquireLease" | "releaseLease" | "releaseLeasesForRun">
      & Partial<Pick<EnvironmentService,
        | "get"
        | "listActiveLeasesForRun"
        | "findResumablePausedLease"
        | "findResumableCommanderPausedLease"
        | "reactivatePausedLease"
        | "markLeasePaused"
        | "listLiveAndPausedProviderLeasesForCompany"
      >>;
    sandboxProviders?: SandboxRuntimeProvider[];
    runtimeProviderKeys?: RuntimeProviderKeyResolver;
  } = {},
): EnvironmentRuntimeService {
  const environmentsSvc = (options.environments ?? environmentService(db)) as EnvironmentService;
  const providerRuntime = sandboxProviderRuntime({ providers: options.sandboxProviders });
  const runtimeProviderKeys = options.runtimeProviderKeys ?? runtimeProviderKeyService(db);
  const localDriver = createLocalEnvironmentDriver(environmentsSvc);
  const sandboxDriver = createSandboxDockerEnvironmentDriver(
    db,
    environmentsSvc,
    providerRuntime,
    runtimeProviderKeys,
  );

  function getDriver(environment: Pick<Environment, "driver">): EnvironmentRuntimeDriver {
    if (environment.driver === "local") return localDriver;
    if (environment.driver === "sandbox") return sandboxDriver;
    throw new Error(`Unsupported environment driver "${environment.driver}"`);
  }

  return {
    async acquireRunLease(input) {
      const leaseContext = buildEnvironmentLeaseContext({
        persistedExecutionWorkspace: input.persistedExecutionWorkspace,
      });
      const lease = await getDriver(input.environment).acquireRunLease(input);
      return {
        environment: input.environment,
        lease,
        leaseContext,
      };
    },

    async releaseRunLease(input) {
      return await getDriver(input.environment).releaseRunLease(input);
    },

    async releaseRunLeases(heartbeatRunId) {
      if (typeof environmentsSvc.listActiveLeasesForRun !== "function" || typeof environmentsSvc.get !== "function") {
        return (await environmentsSvc.releaseLeasesForRun(heartbeatRunId)).map(normalizeEnvironmentLease);
      }

      const leases = (await environmentsSvc.listActiveLeasesForRun(heartbeatRunId)).map(normalizeEnvironmentLease);
      const released: EnvironmentLease[] = [];
      for (const lease of leases) {
        try {
          const environmentRow = await environmentsSvc.get(lease.companyId, lease.environmentId);
          if (!environmentRow) {
            const row = await environmentsSvc.releaseLease(lease.id, "failed", {
              cleanupStatus: "failed",
              failureReason: "environment missing during lease release",
            });
            if (row) released.push(normalizeEnvironmentLease(row));
            continue;
          }
          const environment = normalizeEnvironment(environmentRow);
          const row = await getDriver(environment).releaseRunLease({
            environment,
            lease,
            status: "released",
          });
          if (row) released.push(row);
        } catch (err) {
          logger.warn(
            { err, leaseId: lease.id, environmentId: lease.environmentId, heartbeatRunId },
            "environment runtime: failed to release run lease",
          );
        }
      }
      return released;
    },

    async executeRunLeaseCommand(input) {
      const provider = readString(input.lease.provider);
      if (!provider || isDockerSandboxProvider(provider)) {
        throw new Error(`Lease provider "${provider ?? "unknown"}" does not support provider execution.`);
      }
      const providerLeaseId = readString(input.lease.providerLeaseId);
      if (!providerLeaseId) {
        throw new Error(`Lease "${input.lease.id}" is missing providerLeaseId.`);
      }
      const metadata = readObject(input.lease.metadata);
      const providerMetadata = readObject(metadata.providerMetadata);
      const providerConfig = await resolveRuntimeProviderConfig({
        companyId: input.lease.companyId,
        provider,
        config: readObject(input.environment.config),
        runtimeProviderKeys,
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
      });
      return providerRuntime.execute(provider, {
        providerLeaseId,
        leaseMetadata: providerMetadata,
        config: providerConfig,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin,
        timeoutMs: input.timeoutSec > 0 ? input.timeoutSec * 1000 : null,
        // U7.5b — thread live-output callbacks to the provider execute seam.
        // Undefined ⇒ the provider leaves the E2B commands.run callback keys
        // unset (buffered-only, byte-identical to today).
        onStdout: input.onStdout,
        onStderr: input.onStderr,
      });
    },

    // U6.2 — file-movement seam. Same provider-resolution shape as
    // executeRunLeaseCommand above (left untouched to avoid any risk to its
    // existing test coverage); duplicated rather than factored out so this
    // addition is a pure addition, not a refactor of working code.
    async writeFiles(input) {
      const provider = readString(input.lease.provider);
      if (!provider || isDockerSandboxProvider(provider)) {
        throw new Error(`Lease provider "${provider ?? "unknown"}" does not support provider file writes.`);
      }
      const providerLeaseId = readString(input.lease.providerLeaseId);
      if (!providerLeaseId) {
        throw new Error(`Lease "${input.lease.id}" is missing providerLeaseId.`);
      }
      const metadata = readObject(input.lease.metadata);
      const providerMetadata = readObject(metadata.providerMetadata);
      const providerConfig = await resolveRuntimeProviderConfig({
        companyId: input.lease.companyId,
        provider,
        config: readObject(input.environment.config),
        runtimeProviderKeys,
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
      });
      await providerRuntime.writeFiles(provider, {
        providerLeaseId,
        leaseMetadata: providerMetadata,
        config: providerConfig,
        files: input.files,
      });
    },

    async readFiles(input) {
      const provider = readString(input.lease.provider);
      if (!provider || isDockerSandboxProvider(provider)) {
        throw new Error(`Lease provider "${provider ?? "unknown"}" does not support provider file reads.`);
      }
      const providerLeaseId = readString(input.lease.providerLeaseId);
      if (!providerLeaseId) {
        throw new Error(`Lease "${input.lease.id}" is missing providerLeaseId.`);
      }
      const metadata = readObject(input.lease.metadata);
      const providerMetadata = readObject(metadata.providerMetadata);
      const providerConfig = await resolveRuntimeProviderConfig({
        companyId: input.lease.companyId,
        provider,
        config: readObject(input.environment.config),
        runtimeProviderKeys,
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
      });
      return providerRuntime.readFiles(provider, {
        providerLeaseId,
        leaseMetadata: providerMetadata,
        config: providerConfig,
        paths: input.paths,
      });
    },

    async resolveHost(input) {
      const provider = readString(input.lease.provider);
      if (!provider || isDockerSandboxProvider(provider)) {
        throw new Error(`Lease provider "${provider ?? "unknown"}" does not support host resolution.`);
      }
      const providerLeaseId = readString(input.lease.providerLeaseId);
      if (!providerLeaseId) {
        throw new Error(`Lease "${input.lease.id}" is missing providerLeaseId.`);
      }
      const metadata = readObject(input.lease.metadata);
      const providerMetadata = readObject(metadata.providerMetadata);
      const providerConfig = await resolveRuntimeProviderConfig({
        companyId: input.lease.companyId,
        provider,
        config: readObject(input.environment.config),
        runtimeProviderKeys,
        issueId: input.lease.issueId,
        heartbeatRunId: input.lease.heartbeatRunId,
      });
      return providerRuntime.resolveHost(provider, {
        providerLeaseId,
        leaseMetadata: providerMetadata,
        config: providerConfig,
        port: input.port,
      });
    },
  };
}

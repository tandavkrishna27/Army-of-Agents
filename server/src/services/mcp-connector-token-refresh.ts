import { randomInt, randomUUID } from "node:crypto";
import {
  companyMcpConnectors,
  mcpConnectorOauthRefreshLeases,
  type Db,
} from "@armyofagents/db";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import {
  decodeOAuthBundle,
  encodeOAuthBundle,
  isBundleExpired,
  type OAuthBundleExpectedContext,
  type OAuthTokenBundle,
} from "./mcp-connector-oauth-bundle.js";
import { refreshOAuthToken as realRefresh } from "./mcp-connector-oauth.js";
import { insertActivity, publishActivity } from "./activity-log.js";
import { prepareMcpOAuthSecretVersion, secretService } from "./secrets.js";
import { requireOAuthProviderPolicy } from "./mcp-connector-oauth-policy.js";
import { isMcpConnectorBlocked } from "./mcp-connector-emergency-policy.js";

const MCP_OAUTH_MAINTENANCE_LOCK = "aoa:mcp-oauth-v2-maintenance";

export type OAuthRefreshFailureKind = "permanent" | "transient" | "policy";

export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    readonly kind: OAuthRefreshFailureKind,
    readonly reason: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "OAuthRefreshError";
  }
}

export interface OAuthRefreshContext extends OAuthBundleExpectedContext {
  bundleKey: Uint8Array;
  serverName: string;
}

export interface RefreshLease {
  secretId: string;
  companyId: string;
  ownerToken: string;
  fencingToken: number;
  expectedSecretVersion: number;
  phase: "acquired" | "request_started";
  leasedUntil: Date;
}

export type RefreshLeaseAcquisition =
  | { outcome: "acquired"; lease: RefreshLease }
  | { outcome: "busy"; lease: RefreshLease }
  | { outcome: "indeterminate"; lease: RefreshLease };

export interface RefreshLeaseStore {
  acquire(input: {
    secretId: string;
    companyId: string;
    expectedSecretVersion: number;
    ownerToken: string;
    now: Date;
    leaseMs: number;
  }): Promise<RefreshLeaseAcquisition>;
  heartbeat(
    lease: RefreshLease,
    now: Date,
    leaseMs: number
  ): Promise<RefreshLease | null>;
  markRequestStarted(
    lease: RefreshLease,
    now: Date,
    leaseMs: number
  ): Promise<RefreshLease | null>;
  inspect(secretId: string): Promise<RefreshLease | null>;
  release(lease: RefreshLease): Promise<void>;
}

export interface RefreshCommitInput {
  lease: RefreshLease;
  signedBundle: string;
  oldSecretVersion: number;
}

export interface RefreshDeps {
  secrets: {
    getByName(
      companyId: string,
      name: string
    ): Promise<{ id: string; latestVersion: number } | null>;
    resolveByName(companyId: string, name: string): Promise<string>;
  };
  leases: RefreshLeaseStore;
  /**
   * Must atomically re-check owner/fence/unexpired lease/expected secret version,
   * rotate the secret, and persist the token-safe oauth_refreshed activity.
   */
  commitRefresh(
    input: RefreshCommitInput
  ): Promise<{ committed: boolean; newVersion: number }>;
  /** Re-read connector status/identity before spending a rotating refresh token. */
  assertRefreshAllowed?: () => Promise<void>;
  refreshOAuthToken?: typeof realRefresh;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: () => number;
  leaseMs?: number;
  waitBeforeReacquireMs?: number;
}

/**
 * Builds the transaction required by `commitRefresh`. Provider encryption is
 * prepared before opening the transaction; lease/fence/version, secret
 * rotation, and the token-safe success activity are then committed together.
 */
export function createDbRefreshCommitter(
  db: Db,
  context: OAuthRefreshContext,
  now: () => number = Date.now
): RefreshDeps["commitRefresh"] {
  return async (input) => {
    const policy = requireOAuthProviderPolicy(
      context.catalogEntryId,
      context.oauthPolicyVersion
    );
    if (isMcpConnectorBlocked(context.serverName)) {
      throw new OAuthRefreshError(
        "OAuth refresh blocked by emergency policy",
        "policy",
        "oauth_policy_blocked"
      );
    }
    const nextVersion = input.oldSecretVersion + 1;
    const prepared = await prepareMcpOAuthSecretVersion({
      companyId: context.companyId,
      value: input.signedBundle,
      owner: {
        connectorId: context.connectorId,
        catalogEntryId: context.catalogEntryId,
        oauthPolicyVersion: context.oauthPolicyVersion,
      },
      expectedLatestVersion: input.oldSecretVersion,
    });
    const committed = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const committedAt = new Date(now());
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtext(${MCP_OAUTH_MAINTENANCE_LOCK}))`
      );
      // Policy, emergency state, immutable identity, connector status, and
      // broker-owned binding are rechecked inside the rotation transaction.
      // A deployment/policy/disable race therefore cannot commit fresh tokens.
      requireOAuthProviderPolicy(policy.entryId, policy.version);
      if (isMcpConnectorBlocked(context.serverName)) {
        throw new OAuthRefreshError(
          "OAuth refresh blocked by emergency policy",
          "policy",
          "oauth_policy_blocked"
        );
      }
      const currentConnector = await txDb
        .select({ id: companyMcpConnectors.id })
        .from(companyMcpConnectors)
        .where(
          and(
            eq(companyMcpConnectors.id, context.connectorId),
            eq(companyMcpConnectors.companyId, context.companyId),
            eq(companyMcpConnectors.source, "catalog"),
            eq(companyMcpConnectors.status, "active"),
            eq(companyMcpConnectors.catalogEntryId, policy.entryId),
            eq(companyMcpConnectors.oauthPolicyVersion, policy.version),
            eq(companyMcpConnectors.serverName, context.serverName),
            eq(companyMcpConnectors.secretRef, context.secretName)
          )
        )
        .limit(1)
        .for("update");
      if (!currentConnector[0]) {
        throw new OAuthRefreshError(
          "OAuth connector changed during refresh",
          "policy",
          "oauth_policy_blocked"
        );
      }
      const liveLease = await txDb
        .select({ secretId: mcpConnectorOauthRefreshLeases.secretId })
        .from(mcpConnectorOauthRefreshLeases)
        .where(
          and(
            eq(mcpConnectorOauthRefreshLeases.secretId, input.lease.secretId),
            eq(mcpConnectorOauthRefreshLeases.companyId, context.companyId),
            eq(
              mcpConnectorOauthRefreshLeases.ownerToken,
              input.lease.ownerToken
            ),
            eq(
              mcpConnectorOauthRefreshLeases.fencingToken,
              input.lease.fencingToken
            ),
            eq(
              mcpConnectorOauthRefreshLeases.expectedSecretVersion,
              input.oldSecretVersion
            ),
            eq(mcpConnectorOauthRefreshLeases.phase, "request_started"),
            gt(mcpConnectorOauthRefreshLeases.leasedUntil, committedAt)
          )
        )
        .limit(1);
      if (!liveLease[0]) return null;

      const secret = await secretService(txDb).commitPreparedMcpOAuthSecret(
        prepared
      );
      if (
        secret.id !== input.lease.secretId ||
        secret.latestVersion !== nextVersion
      ) {
        throw new Error("OAuth refresh secret changed while committing");
      }
      const activity = await insertActivity(txDb, {
        companyId: context.companyId,
        actorType: "system",
        actorId: "oauth-broker",
        action: "mcp_connector.oauth_refreshed",
        entityType: "mcp_connector",
        entityId: context.connectorId,
        details: {
          connectorId: context.connectorId,
          oldSecretVersion: input.oldSecretVersion,
          newSecretVersion: nextVersion,
        },
      });
      return { activity, newVersion: nextVersion };
    });
    if (!committed)
      return { committed: false, newVersion: input.oldSecretVersion };
    publishRefreshActivityBestEffort(committed.activity);
    return { committed: true, newVersion: committed.newVersion };
  };
}

export function publishRefreshActivityBestEffort(
  activity: Parameters<typeof publishActivity>[0],
  publish: typeof publishActivity = publishActivity
): void {
  try {
    publish(activity);
  } catch {
    // Durable rotation + activity already committed. Live delivery is a
    // best-effort poke; listener failure must not turn success into failure.
  }
}

const DEFAULT_LEASE_MS = 20_000;
const DEFAULT_REACQUIRE_MS = 12_000;
const HEARTBEAT_MS = 5_000;
const inFlight = new Map<string, Promise<string>>();

function rowToLease(
  row: typeof mcpConnectorOauthRefreshLeases.$inferSelect
): RefreshLease {
  return {
    secretId: row.secretId,
    companyId: row.companyId,
    ownerToken: row.ownerToken,
    fencingToken: row.fencingToken,
    expectedSecretVersion: row.expectedSecretVersion,
    phase: row.phase === "request_started" ? "request_started" : "acquired",
    leasedUntil: row.leasedUntil,
  };
}

/** DB-backed lease store. Separate instances/connections coordinate through the row. */
export function createDbRefreshLeaseStore(db: Db): RefreshLeaseStore {
  return {
    async acquire(input) {
      const leasedUntil = new Date(input.now.getTime() + input.leaseMs);
      const rows = await db
        .insert(mcpConnectorOauthRefreshLeases)
        .values({
          secretId: input.secretId,
          companyId: input.companyId,
          ownerToken: input.ownerToken,
          fencingToken: 1,
          expectedSecretVersion: input.expectedSecretVersion,
          phase: "acquired",
          requestStartedAt: null,
          leasedUntil,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: mcpConnectorOauthRefreshLeases.secretId,
          set: {
            companyId: input.companyId,
            ownerToken: input.ownerToken,
            fencingToken: sql`${mcpConnectorOauthRefreshLeases.fencingToken} + 1`,
            expectedSecretVersion: input.expectedSecretVersion,
            phase: "acquired",
            requestStartedAt: null,
            leasedUntil,
            updatedAt: input.now,
          },
          setWhere: and(
            lte(mcpConnectorOauthRefreshLeases.leasedUntil, input.now),
            eq(mcpConnectorOauthRefreshLeases.phase, "acquired")
          ),
        })
        .returning();
      if (rows[0]) return { outcome: "acquired", lease: rowToLease(rows[0]) };

      const current = await this.inspect(input.secretId);
      if (!current) return this.acquire(input);
      if (
        current.leasedUntil.getTime() <= input.now.getTime() &&
        current.phase === "request_started"
      ) {
        return { outcome: "indeterminate", lease: current };
      }
      return { outcome: "busy", lease: current };
    },

    async heartbeat(lease, now, leaseMs) {
      const rows = await db
        .update(mcpConnectorOauthRefreshLeases)
        .set({ leasedUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
        .where(
          and(
            eq(mcpConnectorOauthRefreshLeases.secretId, lease.secretId),
            eq(mcpConnectorOauthRefreshLeases.ownerToken, lease.ownerToken),
            eq(mcpConnectorOauthRefreshLeases.fencingToken, lease.fencingToken),
            eq(
              mcpConnectorOauthRefreshLeases.expectedSecretVersion,
              lease.expectedSecretVersion
            ),
            gt(mcpConnectorOauthRefreshLeases.leasedUntil, now)
          )
        )
        .returning();
      return rows[0] ? rowToLease(rows[0]) : null;
    },

    async markRequestStarted(lease, now, leaseMs) {
      const rows = await db
        .update(mcpConnectorOauthRefreshLeases)
        .set({
          phase: "request_started",
          requestStartedAt: now,
          leasedUntil: new Date(now.getTime() + leaseMs),
          updatedAt: now,
        })
        .where(
          and(
            eq(mcpConnectorOauthRefreshLeases.secretId, lease.secretId),
            eq(mcpConnectorOauthRefreshLeases.ownerToken, lease.ownerToken),
            eq(mcpConnectorOauthRefreshLeases.fencingToken, lease.fencingToken),
            eq(
              mcpConnectorOauthRefreshLeases.expectedSecretVersion,
              lease.expectedSecretVersion
            ),
            eq(mcpConnectorOauthRefreshLeases.phase, "acquired"),
            gt(mcpConnectorOauthRefreshLeases.leasedUntil, now)
          )
        )
        .returning();
      return rows[0] ? rowToLease(rows[0]) : null;
    },

    async inspect(secretId) {
      const rows = await db
        .select()
        .from(mcpConnectorOauthRefreshLeases)
        .where(eq(mcpConnectorOauthRefreshLeases.secretId, secretId))
        .limit(1);
      return rows[0] ? rowToLease(rows[0]) : null;
    },

    async release(lease) {
      await db
        .delete(mcpConnectorOauthRefreshLeases)
        .where(
          and(
            eq(mcpConnectorOauthRefreshLeases.secretId, lease.secretId),
            eq(mcpConnectorOauthRefreshLeases.ownerToken, lease.ownerToken),
            eq(mcpConnectorOauthRefreshLeases.fencingToken, lease.fencingToken)
          )
        );
    },
  };
}

function classifyRefreshFailure(error: unknown): OAuthRefreshError {
  if (error instanceof OAuthRefreshError) return error;
  const value = error as {
    kind?: unknown;
    code?: unknown;
    status?: unknown;
    oauthError?: unknown;
    message?: unknown;
  } | null;
  const kind = value?.kind;
  if (kind === "policy") {
    return new OAuthRefreshError(
      "OAuth refresh blocked by provider policy",
      "policy",
      "oauth_policy_blocked",
      error
    );
  }
  const status = typeof value?.status === "number" ? value.status : null;
  const text = `${String(value?.code ?? "")} ${String(
    value?.oauthError ?? ""
  )} ${String(value?.message ?? "")}`.toLowerCase();
  if (status === 429 || (status !== null && status >= 500)) {
    return new OAuthRefreshError(
      "OAuth refresh is temporarily unavailable",
      "transient",
      "oauth_refresh_retryable",
      error
    );
  }
  if (
    kind === "transient" ||
    kind === "invalid_response" ||
    /timeout|timed out|econn|network|fetch failed/.test(text)
  ) {
    return new OAuthRefreshError(
      "OAuth refresh outcome is indeterminate",
      "transient",
      "oauth_refresh_indeterminate",
      error
    );
  }
  if (
    /invalid_grant|invalid_client/.test(text) ||
    status === 400 ||
    status === 401
  ) {
    return new OAuthRefreshError(
      "OAuth credentials require reauthorization",
      "permanent",
      "oauth_reauthorization_required",
      error
    );
  }
  return new OAuthRefreshError(
    "OAuth refresh outcome is indeterminate",
    "transient",
    "oauth_refresh_indeterminate",
    error
  );
}

function permanent(
  reason: string,
  message: string,
  cause?: unknown
): OAuthRefreshError {
  return new OAuthRefreshError(message, "permanent", reason, cause);
}

function decode(raw: string, context: OAuthRefreshContext): OAuthTokenBundle {
  const bundle = decodeOAuthBundle(raw, context.bundleKey, context);
  if (!bundle)
    throw permanent(
      "oauth_bundle_invalid",
      "OAuth credentials require reauthorization"
    );
  return bundle;
}

async function assertCurrentRefreshPolicy(
  deps: RefreshDeps,
  context: OAuthRefreshContext
): Promise<ReturnType<typeof requireOAuthProviderPolicy>> {
  const policy = requireOAuthProviderPolicy(
    context.catalogEntryId,
    context.oauthPolicyVersion
  );
  if (isMcpConnectorBlocked(context.serverName)) {
    throw new OAuthRefreshError(
      "OAuth refresh blocked by emergency policy",
      "policy",
      "oauth_policy_blocked"
    );
  }
  await deps.assertRefreshAllowed?.();
  return policy;
}

async function reloadFreshToken(
  deps: RefreshDeps,
  context: OAuthRefreshContext,
  expectedVersion: number
): Promise<string | null> {
  const secret = await deps.secrets.getByName(
    context.companyId,
    context.secretName
  );
  if (!secret)
    throw permanent(
      "oauth_secret_missing",
      "OAuth secret vanished during refresh"
    );
  if (secret.latestVersion === expectedVersion) return null;
  const current = decode(
    await deps.secrets.resolveByName(context.companyId, context.secretName),
    context
  );
  if (isBundleExpired(current, (deps.now ?? Date.now)())) return null;
  return current.accessToken;
}

/**
 * Resolves a signed OAuth bundle to a live access token. Callers must invoke
 * this only for a connector whose immutable identity matches current policy.
 */
export async function resolveConnectorToken(
  deps: RefreshDeps,
  context: OAuthRefreshContext,
  resolvedValue: string
): Promise<string> {
  await assertCurrentRefreshPolicy(deps, context);
  const bundle = decode(resolvedValue, context);
  const now = (deps.now ?? Date.now)();
  if (!isBundleExpired(bundle, now)) return bundle.accessToken;

  const key = `${context.companyId}:${context.secretName}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const refresh = coordinateOAuthRefresh(deps, context, bundle).finally(() =>
    inFlight.delete(key)
  );
  inFlight.set(key, refresh);
  return refresh;
}

export async function coordinateOAuthRefresh(
  deps: RefreshDeps,
  context: OAuthRefreshContext,
  initialBundle: OAuthTokenBundle
): Promise<string> {
  if (!initialBundle.refreshToken) {
    throw permanent(
      "oauth_refresh_token_missing",
      "OAuth credentials require reauthorization"
    );
  }
  const secret = await deps.secrets.getByName(
    context.companyId,
    context.secretName
  );
  if (!secret)
    throw permanent(
      "oauth_secret_missing",
      "OAuth secret vanished during refresh"
    );

  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const waitBeforeReacquireMs =
    deps.waitBeforeReacquireMs ?? DEFAULT_REACQUIRE_MS;
  const sleep =
    deps.sleep ??
    ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const jitter = deps.jitterMs ?? (() => randomInt(100, 251));
  const ownerToken = randomUUID();
  const waitStartedAt = (deps.now ?? Date.now)();
  const initialSecretVersion = secret.latestVersion;

  while (true) {
    const nowMs = (deps.now ?? Date.now)();
    const currentSecret = await deps.secrets.getByName(
      context.companyId,
      context.secretName
    );
    if (!currentSecret)
      throw permanent(
        "oauth_secret_missing",
        "OAuth secret vanished during refresh"
      );
    if (currentSecret.latestVersion !== initialSecretVersion) {
      const fresh = await reloadFreshToken(deps, context, initialSecretVersion);
      if (fresh) return fresh;
      throw permanent(
        "oauth_refresh_fenced",
        "OAuth secret changed without a usable refreshed token"
      );
    }
    const acquisition = await deps.leases.acquire({
      secretId: currentSecret.id,
      companyId: context.companyId,
      expectedSecretVersion: currentSecret.latestVersion,
      ownerToken,
      now: new Date(nowMs),
      leaseMs,
    });
    if (acquisition.outcome === "indeterminate") {
      throw permanent(
        "oauth_refresh_indeterminate",
        "OAuth refresh outcome is indeterminate; reauthorization is required"
      );
    }
    if (acquisition.outcome === "acquired") {
      return refreshAsLeaseOwner(
        deps,
        context,
        initialBundle,
        acquisition.lease,
        leaseMs
      );
    }

    const fresh = await reloadFreshToken(deps, context, initialSecretVersion);
    if (fresh) return fresh;
    if (nowMs - waitStartedAt < waitBeforeReacquireMs) {
      await sleep(jitter());
      continue;
    }
    // After the bounded wait, acquisition itself decides whether an expired
    // acquired lease is safe to fence or a request_started lease is indeterminate.
    await sleep(jitter());
  }
}

async function refreshAsLeaseOwner(
  deps: RefreshDeps,
  context: OAuthRefreshContext,
  bundle: OAuthTokenBundle,
  originalLease: RefreshLease,
  leaseMs: number
): Promise<string> {
  let lease = originalLease;
  let ownershipLost = false;
  let heartbeatInFlight = false;
  let releaseLease = false;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight || ownershipLost) return;
    heartbeatInFlight = true;
    const now = new Date((deps.now ?? Date.now)());
    void deps.leases
      .heartbeat(lease, now, leaseMs)
      .then((renewed) => {
        if (!renewed) ownershipLost = true;
        else lease = renewed;
      })
      .catch(() => {
        ownershipLost = true;
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, Math.min(HEARTBEAT_MS, Math.max(1, Math.floor(leaseMs / 3))));

  try {
    const renewed = await deps.leases.heartbeat(
      lease,
      new Date((deps.now ?? Date.now)()),
      leaseMs
    );
    if (!renewed)
      throw permanent(
        "oauth_refresh_lease_lost",
        "OAuth refresh ownership was lost"
      );
    lease = renewed;
    const started = await deps.leases.markRequestStarted(
      lease,
      new Date((deps.now ?? Date.now)()),
      leaseMs
    );
    if (!started)
      throw permanent(
        "oauth_refresh_lease_lost",
        "OAuth refresh ownership was lost"
      );
    lease = started;
    if (ownershipLost)
      throw permanent(
        "oauth_refresh_lease_lost",
        "OAuth refresh ownership was lost"
      );

    const policy = await assertCurrentRefreshPolicy(deps, context);
    let token: Awaited<ReturnType<typeof realRefresh>>;
    try {
      token = await (deps.refreshOAuthToken ?? realRefresh)({
        tokenEndpoint: policy.tokenEndpoint,
        refreshToken: bundle.refreshToken!,
        clientId: bundle.clientId,
        resource: policy.resourceUrl,
      });
    } catch (error) {
      const classified = classifyRefreshFailure(error);
      // An explicit provider response or local policy rejection is safe to
      // retry/re-authorize. A timeout/network failure is indeterminate after
      // request_started, so retain the durable lease row; once expired it
      // prevents a second spend of a potentially rotated refresh token.
      releaseLease = classified.reason !== "oauth_refresh_indeterminate";
      throw classified;
    }
    if (ownershipLost)
      throw permanent(
        "oauth_refresh_lease_lost",
        "OAuth refresh ownership was lost"
      );

    const next: OAuthTokenBundle = {
      ...bundle,
      issuer: policy.issuer,
      tokenEndpoint: policy.tokenEndpoint,
      scopes: [...policy.scopes],
      resource: policy.resourceUrl,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? bundle.refreshToken,
      expiresAt: (deps.now ?? Date.now)() + token.expiresIn * 1000,
    };
    const committed = await deps.commitRefresh({
      lease,
      signedBundle: encodeOAuthBundle(next, context.bundleKey),
      oldSecretVersion: lease.expectedSecretVersion,
    });
    if (
      !committed.committed ||
      committed.newVersion !== lease.expectedSecretVersion + 1
    ) {
      const reused = await reloadFreshToken(
        deps,
        context,
        lease.expectedSecretVersion
      );
      if (reused) return reused;
      throw permanent(
        "oauth_refresh_fenced",
        "OAuth refresh result was fenced out"
      );
    }
    releaseLease = true;
    return next.accessToken;
  } finally {
    clearInterval(heartbeat);
    if (releaseLease) await deps.leases.release(lease).catch(() => {});
  }
}

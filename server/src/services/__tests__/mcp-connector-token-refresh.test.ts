import { describe, expect, it, vi } from "vitest";
import {
  coordinateOAuthRefresh,
  OAuthRefreshError,
  publishRefreshActivityBestEffort,
  resolveConnectorToken,
  type OAuthRefreshContext,
  type RefreshDeps,
  type RefreshLease,
  type RefreshLeaseStore,
} from "../mcp-connector-token-refresh.js";
import {
  decodeOAuthBundle,
  deriveOAuthBundleKey,
  encodeOAuthBundle,
  type OAuthTokenBundle,
} from "../mcp-connector-oauth-bundle.js";

const key = deriveOAuthBundleKey("unit-test-root");
const context: OAuthRefreshContext = {
  companyId: "company-1",
  connectorId: "connector-1",
  catalogEntryId: "notion-hosted",
  oauthPolicyVersion: 1,
  secretName: "mcp:oauth:connector-1",
  bundleKey: key,
  serverName: "notion",
};
const bundle = (over: Partial<OAuthTokenBundle> = {}): OAuthTokenBundle => ({
  companyId: context.companyId,
  connectorId: context.connectorId,
  catalogEntryId: context.catalogEntryId,
  oauthPolicyVersion: context.oauthPolicyVersion,
  secretName: context.secretName,
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: 1_000,
  issuer: "https://mcp.notion.com",
  tokenEndpoint: "https://mcp.notion.com/token",
  clientId: "client-1",
  redirectUri: "https://aoa.example/api/oauth/callback",
  scopes: ["default"],
  resource: "https://mcp.notion.com/mcp",
  ...over,
});

class MemoryLeaseStore implements RefreshLeaseStore {
  lease: RefreshLease | null = null;
  fence = 0;

  async acquire(input: Parameters<RefreshLeaseStore["acquire"]>[0]) {
    if (!this.lease) {
      this.lease = {
        secretId: input.secretId,
        companyId: input.companyId,
        ownerToken: input.ownerToken,
        fencingToken: ++this.fence,
        expectedSecretVersion: input.expectedSecretVersion,
        phase: "acquired" as const,
        leasedUntil: new Date(input.now.getTime() + input.leaseMs),
      };
      return { outcome: "acquired" as const, lease: this.lease };
    }
    if (this.lease.leasedUntil <= input.now && this.lease.phase === "request_started") {
      return { outcome: "indeterminate" as const, lease: this.lease };
    }
    return { outcome: "busy" as const, lease: this.lease };
  }

  async heartbeat(lease: RefreshLease, now: Date, leaseMs: number) {
    if (!this.lease || this.lease.ownerToken !== lease.ownerToken) return null;
    this.lease = { ...this.lease, leasedUntil: new Date(now.getTime() + leaseMs) };
    return this.lease;
  }

  async markRequestStarted(lease: RefreshLease, now: Date, leaseMs: number) {
    if (!this.lease || this.lease.ownerToken !== lease.ownerToken) return null;
    this.lease = { ...this.lease, phase: "request_started", leasedUntil: new Date(now.getTime() + leaseMs) };
    return this.lease;
  }

  async inspect() { return this.lease; }
  async release(lease: RefreshLease) {
    if (this.lease?.ownerToken === lease.ownerToken) this.lease = null;
  }
}

function harness(over: Partial<RefreshDeps> = {}) {
  let version = 1;
  let raw = encodeOAuthBundle(bundle(), key);
  const leases = new MemoryLeaseStore();
  const refreshOAuthToken = vi.fn().mockResolvedValue({
    accessToken: "at-2",
    refreshToken: "rt-2",
    expiresIn: 3600,
  });
  const deps: RefreshDeps = {
    secrets: {
      getByName: vi.fn(async () => ({ id: "secret-1", latestVersion: version })),
      resolveByName: vi.fn(async () => raw),
    },
    leases,
    refreshOAuthToken,
    now: () => 5_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))),
    jitterMs: () => 1,
    leaseMs: 20_000,
    waitBeforeReacquireMs: 12_000,
    commitRefresh: vi.fn(async ({ lease, signedBundle }) => {
      if (lease.expectedSecretVersion !== version || leases.lease?.ownerToken !== lease.ownerToken) {
        return { committed: false, newVersion: version };
      }
      raw = signedBundle;
      version += 1;
      return { committed: true, newVersion: version };
    }),
    ...over,
  };
  return { deps, leases, refreshOAuthToken, getRaw: () => raw, getVersion: () => version };
}

describe("OAuth connector token refresh", () => {
  it("returns a fresh signed bundle's access token without provider I/O", async () => {
    const h = harness();
    const raw = encodeOAuthBundle(bundle({ expiresAt: 1_000_000 }), key);
    await expect(resolveConnectorToken(h.deps, context, raw)).resolves.toBe("at-1");
    expect(h.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("refreshes, rotates exactly one version, and returns the new token", async () => {
    const h = harness();
    await expect(resolveConnectorToken(h.deps, context, h.getRaw())).resolves.toBe("at-2");
    expect(h.refreshOAuthToken).toHaveBeenCalledTimes(1);
    expect(h.getVersion()).toBe(2);
    expect(decodeOAuthBundle(h.getRaw(), key, context)?.refreshToken).toBe("rt-2");
  });

  it("uses current pinned policy authority instead of signed stored endpoints/resource/scopes", async () => {
    const h = harness();
    const poisoned = encodeOAuthBundle(bundle({
      issuer: "https://old.example",
      tokenEndpoint: "https://old.example/token",
      resource: "https://old.example/mcp",
      scopes: ["old-admin"],
    }), key);
    await expect(resolveConnectorToken(h.deps, context, poisoned)).resolves.toBe("at-2");
    expect(h.refreshOAuthToken).toHaveBeenCalledWith({
      tokenEndpoint: "https://mcp.notion.com/token",
      refreshToken: "rt-1",
      clientId: "client-1",
      resource: "https://mcp.notion.com/mcp",
    });
    expect(decodeOAuthBundle(h.getRaw(), key, context)).toMatchObject({
      issuer: "https://mcp.notion.com",
      tokenEndpoint: "https://mcp.notion.com/token",
      resource: "https://mcp.notion.com/mcp",
      scopes: ["default"],
    });
  });

  it("rechecks current connector policy before provider I/O", async () => {
    const assertRefreshAllowed = vi.fn().mockRejectedValue(
      new OAuthRefreshError("disabled", "policy", "oauth_policy_blocked"),
    );
    const h = harness({ assertRefreshAllowed });
    await expect(resolveConnectorToken(h.deps, context, h.getRaw())).rejects.toMatchObject({ kind: "policy" });
    expect(assertRefreshAllowed).toHaveBeenCalled();
    expect(h.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("swallows post-commit live publish failures", () => {
    expect(() => publishRefreshActivityBestEffort({} as never, () => { throw new Error("listener"); })).not.toThrow();
  });

  it("classifies 429/5xx/network failures as transient and preserves indeterminate leases", async () => {
    for (const error of [
      Object.assign(new Error("rate limited"), { status: 429 }),
      Object.assign(new Error("unavailable"), { status: 503 }),
    ]) {
      const h = harness({ refreshOAuthToken: vi.fn().mockRejectedValue(error) });
      await expect(resolveConnectorToken(h.deps, context, h.getRaw())).rejects.toMatchObject({
        kind: "transient",
        reason: "oauth_refresh_retryable",
      });
      expect(h.leases.lease).toBeNull();
    }
    const network = harness({ refreshOAuthToken: vi.fn().mockRejectedValue(new Error("network fetch failed")) });
    await expect(resolveConnectorToken(network.deps, context, network.getRaw())).rejects.toMatchObject({
      kind: "transient",
      reason: "oauth_refresh_indeterminate",
    });
    expect(network.leases.lease?.phase).toBe("request_started");
  });

  it("classifies invalid_grant and a missing refresh token as permanent", async () => {
    const invalidGrant = harness({
      refreshOAuthToken: vi.fn().mockRejectedValue(Object.assign(new Error("invalid_grant"), { status: 400 })),
    });
    await expect(resolveConnectorToken(invalidGrant.deps, context, invalidGrant.getRaw())).rejects.toMatchObject({
      kind: "permanent",
    });

    const missing = harness();
    const raw = encodeOAuthBundle(bundle({ refreshToken: null }), key);
    await expect(resolveConnectorToken(missing.deps, context, raw)).rejects.toMatchObject({
      kind: "permanent",
      reason: "oauth_refresh_token_missing",
    });
  });

  it("fails closed on an expired request_started lease without a second provider request", async () => {
    const h = harness({ now: () => 50_000 });
    h.leases.lease = {
      secretId: "secret-1",
      companyId: context.companyId,
      ownerToken: "00000000-0000-4000-8000-000000000001",
      fencingToken: 7,
      expectedSecretVersion: 1,
      phase: "request_started",
      leasedUntil: new Date(40_000),
    };
    await expect(resolveConnectorToken(h.deps, context, h.getRaw())).rejects.toMatchObject({
      kind: "permanent",
      reason: "oauth_refresh_indeterminate",
    });
    expect(h.refreshOAuthToken).not.toHaveBeenCalled();
  });

  it("coordinates process-equivalent workers so the contender reuses the rotated token", async () => {
    const h = harness();
    let releaseProvider!: () => void;
    h.refreshOAuthToken.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseProvider = resolve; });
      return { accessToken: "at-2", refreshToken: "rt-2", expiresIn: 3600 };
    });
    const original = decodeOAuthBundle(h.getRaw(), key, context)!;
    const workerOne = coordinateOAuthRefresh(h.deps, context, original);
    while (!releaseProvider) await new Promise((resolve) => setTimeout(resolve, 0));
    const workerTwo = coordinateOAuthRefresh(h.deps, context, original);
    releaseProvider();
    await expect(Promise.all([workerOne, workerTwo])).resolves.toEqual(["at-2", "at-2"]);
    expect(h.refreshOAuthToken).toHaveBeenCalledTimes(1);
    expect(h.getVersion()).toBe(2);
  });

  it("rejects malformed or context-transplanted bundles as permanent", async () => {
    const h = harness();
    await expect(resolveConnectorToken(h.deps, context, "not-a-bundle")).rejects.toBeInstanceOf(OAuthRefreshError);
    const wrong = encodeOAuthBundle(bundle({ companyId: "other-company" }), key);
    await expect(resolveConnectorToken(h.deps, context, wrong)).rejects.toMatchObject({
      kind: "permanent",
      reason: "oauth_bundle_invalid",
    });
  });
});

// server/src/__tests__/provider-connections-service.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../services/provider-credentials.js", () => ({
  removeScopedSubscriptionCredentialHome: vi.fn(async () => false),
}));

import { logActivity } from "../services/activity-log.js";
import { removeScopedSubscriptionCredentialHome } from "../services/provider-credentials.js";
import {
  assertSubscriptionAllowed,
  providerConnectionService,
} from "../services/provider-connections.js";

const baseConnection = {
  id: "connection-1",
  companyId: "company-1",
  provider: "anthropic",
  authMethod: "api_key",
  state: "pending",
  termsAttestedAt: new Date(),
  ownerUserId: null,
  executionTargetId: null,
};

function makeDb(input: {
  connection?: Record<string, unknown> | null;
  transitionRows?: Array<Record<string, unknown>>;
}) {
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  const connection = input.connection === undefined ? baseConnection : input.connection;
  const transitionRows = input.transitionRows ?? [{ ...baseConnection, state: "verified" }];
  let updateIndex = 0;
  const tx: any = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => connection ? [connection] : [] }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push({ patch });
        const current = updateIndex++;
        return {
          where: () => {
            const awaitedRows: unknown[] = [];
            return {
              returning: async () => current === 0 ? transitionRows : awaitedRows,
              then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve(awaitedRows).then(resolve, reject),
            };
          },
        };
      },
    }),
  };
  const db: any = {
    transaction: vi.fn(async (work: (handle: unknown) => unknown) => work(tx)),
  };
  return { db, tx, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BOOT INVARIANT: personal_subscription disabled in multi_tenant/cloud_auth", () => {
  it("throws for personal_subscription in multi_tenant / cloud_auth (create + verify + mint gate)", () => {
    expect(() =>
      assertSubscriptionAllowed("personal_subscription", {
        trustBoundary: "multi_tenant",
      } as never),
    ).toThrow(/subscription/i);
  });
  it("allows personal_subscription in single_tenant (self-hosted)", () => {
    expect(() =>
      assertSubscriptionAllowed("personal_subscription", { trustBoundary: "single_tenant" } as never),
    ).not.toThrow();
  });
  it("never blocks shareable methods, even in multi_tenant", () => {
    expect(() =>
      assertSubscriptionAllowed("api_key", { trustBoundary: "multi_tenant" } as never),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionAllowed("enterprise_gateway", { trustBoundary: "multi_tenant" } as never),
    ).not.toThrow();
  });
});

describe("provider connection lifecycle transitions", () => {
  const topology = { trustBoundary: "single_tenant" } as never;

  it("verifies pending state and writes its audit in the same transaction", async () => {
    const { db, tx, updates } = makeDb({});
    await providerConnectionService(db, topology).verify("company-1", "connection-1", "user-1");

    expect(updates[0]?.patch).toMatchObject({ state: "verified" });
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logActivity).mock.calls[0]?.[0]).toBe(tx);
  });

  it("keeps revoked and suspended connections out of the verify transition", async () => {
    for (const state of ["revoked", "suspended"] as const) {
      const { db, updates } = makeDb({ connection: { ...baseConnection, state } });
      await expect(
        providerConnectionService(db, topology).verify("company-1", "connection-1", "user-1"),
      ).rejects.toThrow(`Cannot verify a ${state}`);
      expect(updates).toHaveLength(0);
    }
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("fails closed when revoke wins the conditional-update race", async () => {
    const { db } = makeDb({ transitionRows: [] });
    await expect(
      providerConnectionService(db, topology).verify("company-1", "connection-1", "user-1"),
    ).rejects.toThrow(/changed while it was being verified/i);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("revokes the connection, disables assignments, and audits on one transaction handle", async () => {
    const revoked = { ...baseConnection, state: "revoked", revokedAt: new Date() };
    const { db, tx, updates } = makeDb({ transitionRows: [revoked] });
    const result = await providerConnectionService(db, topology).revoke(
      "company-1",
      "connection-1",
      "user-1",
    );

    expect(result).toMatchObject({ id: "connection-1", state: "revoked" });
    expect(updates.map((entry) => entry.patch.state)).toEqual(["revoked", "disabled"]);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logActivity).mock.calls[0]?.[0]).toBe(tx);
  });

  it("returns the idempotent revoked state when a concurrent revoke wins", async () => {
    const { db, updates } = makeDb({ transitionRows: [] });
    const result = await providerConnectionService(db, topology).revoke(
      "company-1",
      "connection-1",
      "user-1",
    );

    expect(result).toMatchObject({ id: "connection-1", state: "revoked" });
    expect(updates.map((entry) => entry.patch.state)).toEqual(["revoked", "disabled"]);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("repairs active assignments even when the connection was already revoked", async () => {
    const { db, updates } = makeDb({
      connection: { ...baseConnection, state: "revoked", revokedAt: new Date() },
    });
    const result = await providerConnectionService(db, topology).revoke(
      "company-1",
      "connection-1",
      "user-1",
    );

    expect(result).toMatchObject({ id: "connection-1", state: "revoked" });
    expect(updates.map((entry) => entry.patch.state)).toEqual(["disabled"]);
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("propagates subscription-home cleanup failure after the logical revoke commits", async () => {
    const connection = {
      ...baseConnection,
      authMethod: "personal_subscription",
      ownerUserId: "owner-1",
      executionTargetId: "target-1",
    };
    const revoked = { ...connection, state: "revoked", revokedAt: new Date() };
    const { db, tx, updates } = makeDb({ connection, transitionRows: [revoked] });
    vi.mocked(removeScopedSubscriptionCredentialHome).mockRejectedValueOnce(
      new Error("filesystem unavailable"),
    );

    await expect(
      providerConnectionService(db, topology).revoke("company-1", "connection-1", "user-1"),
    ).rejects.toThrow("filesystem unavailable");

    expect(updates.map((entry) => entry.patch.state)).toEqual(["revoked", "disabled"]);
    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logActivity).mock.calls[0]?.[0]).toBe(tx);
    expect(removeScopedSubscriptionCredentialHome).toHaveBeenCalledWith({
      companyId: "company-1",
      userId: "owner-1",
      provider: "anthropic",
      executionTargetId: "target-1",
    });
  });
});

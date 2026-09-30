import { describe, expect, it, vi } from "vitest";
import { activityLog, boardApiKeys, cliAuthChallenges } from "@armyofagents/db";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    id: "challenge-1",
    secretHash: hashBearerToken("secret"),
    requestedAccess: "board",
    requestedCompanyId: "company-1",
    pendingKeyName: "CLI key",
    pendingKeyHash: hashBearerToken("pending-key"),
    approvedByUserId: null,
    boardApiKeyId: null,
    approvedAt: null,
    cancelledAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

function transactionDb(row: any) {
  const events: string[] = [];
  const tx = {
    execute: vi.fn(async () => {
      events.push("lock");
    }),
    select: vi.fn(() => ({
      from: () => ({
        where: async () => {
          events.push("select");
          return [row];
        },
      }),
    })),
    insert: vi.fn(),
    update: vi.fn(),
  };
  const db = {
    transaction: vi.fn(async (callback: (inner: typeof tx) => unknown) =>
      callback(tx)
    ),
  };
  return { db, tx, events };
}

describe("board auth CLI challenge terminal transitions", () => {
  it("keeps an approved challenge approved after its polling TTL and preserves first approver", async () => {
    const original = challenge({
      expiresAt: new Date(Date.now() - 60_000),
      approvedAt: new Date(Date.now() - 120_000),
      approvedByUserId: "first-approver",
      boardApiKeyId: "board-key-1",
    });
    const { db, tx, events } = transactionDb(original);

    const result = await boardAuthService(db as any).approveCliAuthChallenge(
      "challenge-1",
      "secret",
      "second-approver",
      { canManageInstanceSettings: false }
    );

    expect(result).toMatchObject({
      status: "approved",
      newlyApproved: false,
      challenge: {
        approvedByUserId: "first-approver",
        boardApiKeyId: "board-key-1",
      },
    });
    expect(events).toEqual(["lock", "select"]);
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("locks before cancellation and cannot cancel a challenge that is already approved", async () => {
    const original = challenge({
      approvedAt: new Date(),
      approvedByUserId: "first-approver",
      boardApiKeyId: "board-key-1",
    });
    const { db, tx, events } = transactionDb(original);

    const result = await boardAuthService(db as any).cancelCliAuthChallenge(
      "challenge-1",
      "secret"
    );

    expect(result.status).toBe("approved");
    expect(events).toEqual(["lock", "select"]);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("rolls back key mint and challenge approval when the audit insert fails", async () => {
    const original = challenge();
    const committed = { challenge: original, key: null as any };
    const db = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        const draft = {
          challenge: { ...committed.challenge },
          key: committed.key,
        };
        const tx = {
          execute: vi.fn(),
          select: () => ({
            from: (table: unknown) => ({
              where: async () =>
                table === cliAuthChallenges ? [draft.challenge] : [],
            }),
          }),
          insert: (table: unknown) => ({
            values: (values: any) => {
              // insertActivityLog now calls .returning({ id }) — the audit-failure sim must
              // reject at .returning, not at .values (else "returning is not a function").
              if (table === activityLog)
                return { returning: () => Promise.reject(new Error("audit insert failed")) };
              if (table !== boardApiKeys) throw new Error("unexpected insert");
              draft.key = { id: "board-key-new", ...values };
              return { returning: async () => [draft.key] };
            },
          }),
          update: (table: unknown) => ({
            set: (values: any) => ({
              where: () => ({
                returning: async () => {
                  if (table !== cliAuthChallenges)
                    throw new Error("unexpected update");
                  draft.challenge = { ...draft.challenge, ...values };
                  return [draft.challenge];
                },
              }),
            }),
          }),
        };
        const result = await callback(tx);
        committed.challenge = draft.challenge;
        committed.key = draft.key;
        return result;
      },
    };

    await expect(
      boardAuthService(db as any).approveCliAuthChallenge(
        "challenge-1",
        "secret",
        "approver-1",
        { canManageInstanceSettings: false, activityCompanyIds: ["company-1"] }
      )
    ).rejects.toThrow("audit insert failed");
    expect(committed.key).toBeNull();
    expect(committed.challenge.approvedAt).toBeNull();
    expect(committed.challenge.boardApiKeyId).toBeNull();
  });

  it("rolls back key revocation when the audit insert fails", async () => {
    const originalKey = {
      id: "board-key-1",
      userId: "user-1",
      revokedAt: null,
      lastUsedAt: null,
    };
    const committed = { key: originalKey };
    const db = {
      transaction: async (callback: (tx: any) => Promise<unknown>) => {
        const draft = { key: { ...committed.key } };
        const tx = {
          execute: vi.fn(),
          select: () => ({
            from: (table: unknown) => ({
              where: async () => (table === boardApiKeys ? [draft.key] : []),
            }),
          }),
          insert: (table: unknown) => ({
            values: () =>
              table === activityLog
                // insertActivityLog now chains .returning({ id }); reject there.
                ? { returning: () => Promise.reject(new Error("audit insert failed")) }
                : Promise.resolve(),
          }),
          update: (table: unknown) => ({
            set: (values: any) => ({
              where: () => ({
                returning: async () => {
                  if (table !== boardApiKeys)
                    throw new Error("unexpected update");
                  draft.key = { ...draft.key, ...values };
                  return [draft.key];
                },
              }),
            }),
          }),
        };
        const result = await callback(tx);
        committed.key = draft.key;
        return result;
      },
    };

    await expect(
      boardAuthService(db as any).revokeCurrentBoardApiKey({
        keyId: "board-key-1",
        userId: "user-1",
        activityCompanyIds: ["company-1"],
      })
    ).rejects.toThrow("audit insert failed");
    expect(committed.key.revokedAt).toBeNull();
  });
});

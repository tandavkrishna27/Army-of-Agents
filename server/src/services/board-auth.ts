import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@armyofagents/db";
import { conflict, forbidden, notFound } from "../errors.js";
import {
  insertActivityLog,
  publishActivityLogged,
  type PersistedActivity,
} from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export const BOARD_API_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_AUTH_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type CliAuthChallengeStatus =
  | "pending"
  | "approved"
  | "cancelled"
  | "expired";

export function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenHashesMatch(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export function createBoardApiToken() {
  return `aoa_board_${randomBytes(24).toString("hex")}`;
}

export function createCliAuthSecret() {
  return `aoa_cli_auth_${randomBytes(24).toString("hex")}`;
}

export function boardApiKeyExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + BOARD_API_KEY_TTL_MS);
}

export function cliAuthChallengeExpiresAt(nowMs: number = Date.now()) {
  return new Date(nowMs + CLI_AUTH_CHALLENGE_TTL_MS);
}

function challengeStatusForRow(
  row: typeof cliAuthChallenges.$inferSelect
): CliAuthChallengeStatus {
  // Approval is terminal for the challenge. The challenge's short polling TTL
  // must not make an already-issued 30-day board key appear expired.
  if (row.approvedAt && row.boardApiKeyId) return "approved";
  if (row.cancelledAt) return "cancelled";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

export function boardAuthService(db: Db) {
  function publishCommittedActivities(activities: PersistedActivity[]) {
    for (const activity of activities) {
      try {
        publishActivityLogged(activity);
      } catch (error) {
        // The durable audit row is already committed. A realtime notification
        // failure must not turn a successful credential mutation into a 500.
        logger.warn(
          { error, companyId: activity.companyId, action: activity.action },
          "failed to publish committed board credential activity"
        );
      }
    }
  }

  async function resolveBoardAccessWith(queryDb: Db, userId: string) {
    const [user, memberships, adminRole] = await Promise.all([
      queryDb
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      queryDb
        .select({ companyId: companyMemberships.companyId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active")
          )
        )
        .then((rows) => rows.map((row) => row.companyId)),
      queryDb
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, userId),
            eq(instanceUserRoles.role, "instance_admin")
          )
        )
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      user,
      companyIds: memberships,
      isInstanceAdmin: Boolean(adminRole),
    };
  }

  async function resolveBoardAccess(userId: string) {
    return resolveBoardAccessWith(db, userId);
  }

  async function resolveBoardActivityCompanyIdsWith(
    queryDb: Db,
    input: {
      userId: string;
      requestedCompanyId?: string | null;
      boardApiKeyId?: string | null;
    }
  ) {
    const access = await resolveBoardAccessWith(queryDb, input.userId);
    const companyIds = new Set(access.companyIds);

    if (companyIds.size === 0 && input.requestedCompanyId?.trim()) {
      // TODO: this fallback adds requestedCompanyId to activity logging even if the approving
      // user has no membership in that company. The activity log will show board_api_key.created
      // for a company the user doesn't belong to. Consider verifying membership before adding.
      companyIds.add(input.requestedCompanyId.trim());
    }

    if (companyIds.size === 0 && input.boardApiKeyId?.trim()) {
      const challengeCompanyIds = await queryDb
        .select({ requestedCompanyId: cliAuthChallenges.requestedCompanyId })
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.boardApiKeyId, input.boardApiKeyId.trim()))
        .then((rows) =>
          rows
            .map((row) => row.requestedCompanyId?.trim() ?? null)
            .filter((value): value is string => Boolean(value))
        );
      for (const companyId of challengeCompanyIds) {
        companyIds.add(companyId);
      }
    }

    if (companyIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await queryDb
        .select({ id: companies.id })
        .from(companies)
        .then((rows) => rows.map((row) => row.id));
      for (const companyId of allCompanyIds) {
        companyIds.add(companyId);
      }
    }

    return Array.from(companyIds);
  }

  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    return resolveBoardActivityCompanyIdsWith(db, input);
  }

  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    const now = new Date();
    return db
      .select()
      .from(boardApiKeys)
      .where(
        and(eq(boardApiKeys.keyHash, tokenHash), isNull(boardApiKeys.revokedAt))
      )
      .then(
        (rows) =>
          rows.find(
            (row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()
          ) ?? null
      );
  }

  async function touchBoardApiKey(id: string) {
    await db
      .update(boardApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(boardApiKeys.id, id));
  }

  async function createCliAuthChallenge(input: {
    command: string;
    clientName?: string | null;
    requestedAccess: "board" | "instance_admin_required";
    requestedCompanyId?: string | null;
  }) {
    const challengeSecret = createCliAuthSecret();
    const pendingBoardToken = createBoardApiToken();
    const expiresAt = cliAuthChallengeExpiresAt();
    const labelBase = input.clientName?.trim() || "aoa cli";
    const pendingKeyName =
      input.requestedAccess === "instance_admin_required"
        ? `${labelBase} (instance admin)`
        : `${labelBase} (board)`;

    const created = await db
      .insert(cliAuthChallenges)
      .values({
        secretHash: hashBearerToken(challengeSecret),
        command: input.command.trim(),
        clientName: input.clientName?.trim() || null,
        requestedAccess: input.requestedAccess,
        requestedCompanyId: input.requestedCompanyId?.trim() || null,
        pendingKeyHash: hashBearerToken(pendingBoardToken),
        pendingKeyName,
        expiresAt,
      })
      .returning()
      .then((rows) => rows[0]);

    return {
      challenge: created,
      challengeSecret,
      pendingBoardToken,
    };
  }

  async function getCliAuthChallenge(id: string) {
    return db
      .select()
      .from(cliAuthChallenges)
      .where(eq(cliAuthChallenges.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getCliAuthChallengeBySecret(id: string, token: string) {
    const challenge = await getCliAuthChallenge(id);
    if (!challenge) return null;
    if (!tokenHashesMatch(challenge.secretHash, hashBearerToken(token)))
      return null;
    return challenge;
  }

  async function describeCliAuthChallenge(id: string, token: string) {
    const challenge = await getCliAuthChallengeBySecret(id, token);
    if (!challenge) return null;

    const [company, approvedBy] = await Promise.all([
      challenge.requestedCompanyId
        ? db
            .select({ id: companies.id, name: companies.name })
            .from(companies)
            .where(eq(companies.id, challenge.requestedCompanyId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      challenge.approvedByUserId
        ? db
            .select({
              id: authUsers.id,
              name: authUsers.name,
              email: authUsers.email,
            })
            .from(authUsers)
            .where(eq(authUsers.id, challenge.approvedByUserId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);

    return {
      id: challenge.id,
      status: challengeStatusForRow(challenge),
      command: challenge.command,
      clientName: challenge.clientName ?? null,
      requestedAccess: challenge.requestedAccess as
        | "board"
        | "instance_admin_required",
      requestedCompanyId: challenge.requestedCompanyId ?? null,
      requestedCompanyName: company?.name ?? null,
      approvedAt: challenge.approvedAt?.toISOString() ?? null,
      cancelledAt: challenge.cancelledAt?.toISOString() ?? null,
      expiresAt: challenge.expiresAt.toISOString(),
      approvedByUser: approvedBy
        ? {
            id: approvedBy.id,
            name: approvedBy.name,
            email: approvedBy.email,
          }
        : null,
    };
  }

  async function approveCliAuthChallenge(
    id: string,
    token: string,
    userId: string,
    approver: {
      canManageInstanceSettings: boolean;
      activityCompanyIds?: string[];
    }
  ) {
    const committed = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`
      );

      const challenge = await tx
        .select()
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id))
        .then((rows) => rows[0] ?? null);
      if (
        !challenge ||
        !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))
      ) {
        throw notFound("CLI auth challenge not found");
      }

      const status = challengeStatusForRow(challenge);
      if (status !== "pending") {
        return {
          result: { status, challenge, newlyApproved: false },
          activities: [] as PersistedActivity[],
        };
      }

      if (
        challenge.requestedAccess === "instance_admin_required" &&
        !approver.canManageInstanceSettings
      ) {
        throw forbidden("Instance admin required");
      }

      let boardKeyId = challenge.boardApiKeyId;
      if (!boardKeyId) {
        const createdKey = await tx
          .insert(boardApiKeys)
          .values({
            userId,
            name: challenge.pendingKeyName,
            keyHash: challenge.pendingKeyHash,
            expiresAt: boardApiKeyExpiresAt(),
          })
          .returning()
          .then((rows) => rows[0]);
        boardKeyId = createdKey.id;
      }

      const approvedAt = challenge.approvedAt ?? new Date();
      const updated = await tx
        .update(cliAuthChallenges)
        .set({
          approvedByUserId: userId,
          boardApiKeyId: boardKeyId,
          approvedAt,
          updatedAt: new Date(),
        })
        .where(eq(cliAuthChallenges.id, challenge.id))
        .returning()
        .then((rows) => rows[0] ?? challenge);

      const activityCompanyIds =
        approver.activityCompanyIds ??
        (await resolveBoardActivityCompanyIdsWith(txDb, {
          userId,
          requestedCompanyId: updated.requestedCompanyId,
          boardApiKeyId: updated.boardApiKeyId,
        }));
      const activities: PersistedActivity[] = [];
      for (const companyId of activityCompanyIds) {
        activities.push(
          await insertActivityLog(txDb, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: updated.boardApiKeyId,
              requestedAccess: updated.requestedAccess,
              requestedCompanyId: updated.requestedCompanyId,
              challengeId: updated.id,
            },
          })
        );
      }

      return {
        result: {
          status: "approved" as const,
          challenge: updated,
          newlyApproved: true,
        },
        activities,
      };
    });
    publishCommittedActivities(committed.activities);
    return committed.result;
  }

  async function revokeCurrentBoardApiKey(input: {
    keyId: string;
    userId: string;
    activityCompanyIds?: string[];
  }) {
    const committed = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select ${boardApiKeys.id} from ${boardApiKeys} where ${boardApiKeys.id} = ${input.keyId} for update`
      );
      const key = await tx
        .select()
        .from(boardApiKeys)
        .where(
          and(
            eq(boardApiKeys.id, input.keyId),
            eq(boardApiKeys.userId, input.userId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!key || key.revokedAt) throw notFound("Board API key not found");

      const now = new Date();
      const revoked = await tx
        .update(boardApiKeys)
        .set({ revokedAt: now, lastUsedAt: now })
        .where(and(eq(boardApiKeys.id, key.id), isNull(boardApiKeys.revokedAt)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!revoked) throw notFound("Board API key not found");

      const activityCompanyIds =
        input.activityCompanyIds ??
        (await resolveBoardActivityCompanyIdsWith(txDb, {
          userId: key.userId,
          boardApiKeyId: key.id,
        }));
      const activities: PersistedActivity[] = [];
      for (const companyId of activityCompanyIds) {
        activities.push(
          await insertActivityLog(txDb, {
            companyId,
            actorType: "user",
            actorId: key.userId,
            action: "board_api_key.revoked",
            entityType: "user",
            entityId: key.userId,
            details: {
              boardApiKeyId: key.id,
              revokedVia: "cli_auth_logout",
            },
          })
        );
      }
      return { key: revoked, activities };
    });
    publishCommittedActivities(committed.activities);
    return committed.key;
  }

  async function cancelCliAuthChallenge(id: string, token: string) {
    return db.transaction(async (tx) => {
      // Serialize cancellation with approval on the same challenge row so a
      // live key can never coexist with a later `cancelled` challenge state.
      await tx.execute(
        sql`select ${cliAuthChallenges.id} from ${cliAuthChallenges} where ${cliAuthChallenges.id} = ${id} for update`
      );

      const challenge = await tx
        .select()
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.id, id))
        .then((rows) => rows[0] ?? null);
      if (
        !challenge ||
        !tokenHashesMatch(challenge.secretHash, hashBearerToken(token))
      ) {
        throw notFound("CLI auth challenge not found");
      }

      const status = challengeStatusForRow(challenge);
      if (status !== "pending") return { status, challenge };

      const updated = await tx
        .update(cliAuthChallenges)
        .set({
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(cliAuthChallenges.id, challenge.id))
        .returning()
        .then((rows) => rows[0] ?? challenge);

      return { status: "cancelled" as const, challenge: updated };
    });
  }

  async function assertCurrentBoardKey(
    keyId: string | undefined,
    userId: string | undefined
  ) {
    if (!keyId || !userId) throw conflict("Board API key context is required");
    const key = await db
      .select()
      .from(boardApiKeys)
      .where(and(eq(boardApiKeys.id, keyId), eq(boardApiKeys.userId, userId)))
      .then((rows) => rows[0] ?? null);
    if (!key || key.revokedAt) throw notFound("Board API key not found");
    return key;
  }

  return {
    resolveBoardAccess,
    findBoardApiKeyByToken,
    touchBoardApiKey,
    revokeCurrentBoardApiKey,
    createCliAuthChallenge,
    getCliAuthChallengeBySecret,
    describeCliAuthChallenge,
    approveCliAuthChallenge,
    cancelCliAuthChallenge,
    assertCurrentBoardKey,
    resolveBoardActivityCompanyIds,
  };
}

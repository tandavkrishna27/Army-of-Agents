import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { hubCounterSnapshots } from "@armyofagents/db";
import type { UserRole } from "@armyofagents/shared";

export interface HubCounterSnapshotContext {
  companyId: string;
  userId: string;
  role?: UserRole;
}

interface HubCounterSnapshotOptions {
  liveCounts?: (ctx: HubCounterSnapshotContext) => Promise<{ open: number; unread: number }>;
}

function isValidSnapshot(snapshot: {
  computedAt: Date | null;
  invalidatedAt: Date | null;
}) {
  if (!snapshot.computedAt) return false;
  return !snapshot.invalidatedAt || snapshot.invalidatedAt.getTime() <= snapshot.computedAt.getTime();
}

export function hubCounterSnapshotsService(
  db: Db,
  options: HubCounterSnapshotOptions = {},
) {
  const liveCounts =
    options.liveCounts ??
    (() => {
      throw new Error("hubCounterSnapshotsService requires liveCounts for refresh operations");
    });

  async function find(companyId: string, userId: string) {
    return db
      .select()
      .from(hubCounterSnapshots)
      .where(
        and(
          eq(hubCounterSnapshots.companyId, companyId),
          eq(hubCounterSnapshots.userId, userId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function refresh(ctx: HubCounterSnapshotContext) {
    const counts = await liveCounts(ctx);
    const now = new Date();
    const [row] = await db
      .insert(hubCounterSnapshots)
      .values({
        companyId: ctx.companyId,
        userId: ctx.userId,
        openCount: counts.open,
        unreadCount: counts.unread,
        computedAt: now,
        invalidatedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [hubCounterSnapshots.companyId, hubCounterSnapshots.userId],
        set: {
          openCount: counts.open,
          unreadCount: counts.unread,
          computedAt: now,
          invalidatedAt: null,
          updatedAt: now,
        },
      })
      .returning({
        openCount: hubCounterSnapshots.openCount,
        unreadCount: hubCounterSnapshots.unreadCount,
      });

    return { open: row?.openCount ?? counts.open, unread: row?.unreadCount ?? counts.unread };
  }

  async function getOrRefresh(ctx: HubCounterSnapshotContext) {
    const snapshot = await find(ctx.companyId, ctx.userId);
    if (snapshot && isValidSnapshot(snapshot)) {
      return { open: snapshot.openCount, unread: snapshot.unreadCount };
    }
    try {
      return await refresh(ctx);
    } catch {
      return liveCounts(ctx);
    }
  }

  async function invalidateUser(companyId: string, userId: string) {
    const now = new Date();
    await db
      .update(hubCounterSnapshots)
      .set({ invalidatedAt: now, updatedAt: now })
      .where(
        and(
          eq(hubCounterSnapshots.companyId, companyId),
          eq(hubCounterSnapshots.userId, userId),
        ),
      );
  }

  async function invalidateCompany(companyId: string) {
    const now = new Date();
    await db
      .update(hubCounterSnapshots)
      .set({ invalidatedAt: now, updatedAt: now })
      .where(eq(hubCounterSnapshots.companyId, companyId));
  }

  return {
    getOrRefresh,
    refresh,
    invalidateUser,
    invalidateCompany,
  };
}

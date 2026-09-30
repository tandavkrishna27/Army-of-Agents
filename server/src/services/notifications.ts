/**
 * Notification creation + delivery-retry surface (Phase G2, T26).
 *
 * Single entry point for creating persistent notifications. New writes are
 * validated through the W2 notification registry and persisted through the hub
 * emit path. Callers that previously did `db.insert(notifications)` directly
 * should migrate to `createNotification`.
 *
 * The legacy `notificationService(db)` factory below is preserved as the
 * read/mark/dismiss surface used by routes; its `create` method now delegates
 * to `createNotification` so registry validation and hub emit semantics apply.
 */
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { notifications } from "@armyofagents/db";
import { notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { hubItemsService } from "./hub-items.js";
import { buildNotificationHubEmit } from "./notification-registry.js";

/**
 * Maximum number of delivery attempts before a notification is left for
 * manual triage. After this many failures the row stays in the table with
 * `deliveryError` populated and `deliveredAt` null, but the retry worker
 * stops touching it. `countPersistentlyFailingNotifications` surfaces the
 * cohort for the operator dashboard.
 */
const MAX_DELIVERY_ATTEMPTS = 3;

export interface NotificationInput {
  companyId: string;
  userId: string;
  type: string;
  title: string;
  message?: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  idempotencyKey?: string | null;
}

export interface NotificationRow {
  id: string;
  companyId: string;
  userId: string;
  type: string;
  title: string;
  message: string | null;
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  deliveryAttempts: number;
  deliveredAt: Date | null;
  deliveryError: string | null;
  createdAt: Date;
}

/**
 * Insert a validated, hub-backed persistent notification.
 *
 * New writes go through the W2 notification registry and hub emit path. The
 * retry worker below remains for historical rows that already carry a
 * deliveryError; createNotification no longer creates raw retry stubs for
 * invalid or failed writes.
 */
export async function createNotification(
  db: Db,
  params: NotificationInput,
): Promise<NotificationRow> {
  try {
    const row = await hubItemsService(db).emit(buildNotificationHubEmit(params));
    return row as NotificationRow;
  } catch (err) {
    logger.error(
      {
        err,
        companyId: params.companyId,
        userId: params.userId,
        type: params.type,
      },
      "notification.create failed",
    );
    throw err;
  }
}

export interface RetrySweepResult {
  scanned: number;
  delivered: number;
  failed: number;
  /** Rows that hit MAX_DELIVERY_ATTEMPTS on this sweep and were left for manual triage. */
  exhausted: number;
}

/**
 * Pick up to `batchSize` notifications with a recorded delivery error
 * (and < MAX_DELIVERY_ATTEMPTS attempts) and try to mark them delivered.
 *
 * The current implementation just clears the error flag; concrete delivery
 * channels (WS push, email) hook in via the `attempt` callback once those
 * land. This is the queue infrastructure, not the channel adapter.
 *
 * Counters returned:
 *   - `scanned`: total candidates picked up this sweep
 *   - `delivered`: rows where `attempt` succeeded
 *   - `failed`: rows where `attempt` threw but attempts < MAX
 *   - `exhausted`: rows where `attempt` threw and attempts hit MAX
 */
export async function retryFailedNotifications(
  db: Db,
  options: {
    batchSize?: number;
    attempt?: (row: NotificationRow) => Promise<void>;
  } = {},
): Promise<RetrySweepResult> {
  const batchSize = options.batchSize ?? 10;
  const attempt = options.attempt ?? (async () => { /* no-op delivery */ });

  const candidates = (await db
    .select()
    .from(notifications)
    .where(
      and(
        isNotNull(notifications.deliveryError),
        isNull(notifications.deliveredAt),
        lt(notifications.deliveryAttempts, MAX_DELIVERY_ATTEMPTS),
      ),
    )
    .limit(batchSize)) as NotificationRow[];

  let delivered = 0;
  let failed = 0;
  let exhausted = 0;

  for (const row of candidates) {
    try {
      await attempt(row);
      await db
        .update(notifications)
        .set({
          deliveredAt: new Date(),
          deliveryError: null,
        })
        .where(eq(notifications.id, row.id));
      delivered++;
    } catch (err) {
      const nextAttempts = row.deliveryAttempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(notifications)
        .set({
          deliveryAttempts: nextAttempts,
          deliveryError: message.slice(0, 1000),
        })
        .where(eq(notifications.id, row.id));
      if (nextAttempts >= MAX_DELIVERY_ATTEMPTS) exhausted++;
      else failed++;
    }
  }

  return {
    scanned: candidates.length,
    delivered,
    failed,
    exhausted,
  };
}

/**
 * Monitoring helper — returns the count of notifications that hit
 * MAX_DELIVERY_ATTEMPTS without delivery. Surfaces in operator dashboards
 * and CI smoke tests as a "is delivery still healthy" signal.
 *
 * Pass `companyId` to scope the count to a single tenant; omit for an
 * instance-wide aggregate.
 */
export async function countPersistentlyFailingNotifications(
  db: Db,
  companyId?: string,
): Promise<number> {
  const result = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(notifications)
    .where(
      and(
        sql`${notifications.deliveryAttempts} >= ${MAX_DELIVERY_ATTEMPTS}`,
        isNull(notifications.deliveredAt),
        companyId ? eq(notifications.companyId, companyId) : sql`true`,
      ),
    );
  return result[0]?.count ?? 0;
}

export { MAX_DELIVERY_ATTEMPTS };

// ── Legacy read/mark/dismiss surface ────────────────────────────────────────
//
// The original notificationService factory predates Phase G2. Routes still
// import it for list/markRead/dismiss/getUnreadCount and the original
// `create` shape. `create` now delegates to `createNotification` so registry
// validation and hub emit semantics are inherited by callers that have not yet
// migrated.

export function notificationService(db: Db) {
  async function syncHubPersonalState(args: {
    companyId: string;
    userId: string;
    id: string;
    state: { kind: "read" } | { kind: "dismiss" };
  }) {
    try {
      await hubItemsService(db).applyPersonalState({
        companyId: args.companyId,
        hubItemId: args.id,
        actorUserId: args.userId,
        state: args.state,
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403 || status === 404) {
        logger.warn(
          { err, companyId: args.companyId, userId: args.userId, id: args.id },
          "notification legacy route could not sync hub user state",
        );
        return;
      }
      throw err;
    }
  }

  return {
    /**
     * Create a notification for a user. Delegates to `createNotification`
     * so registry validation and hub emit semantics apply uniformly.
     */
    create: async (
      companyId: string,
      data: {
        userId: string;
        type: string;
        title: string;
        message?: string | null;
        relatedEntityType?: string | null;
        relatedEntityId?: string | null;
      },
    ) => {
      return createNotification(db, {
        companyId,
        userId: data.userId,
        type: data.type,
        title: data.title,
        message: data.message ?? null,
        relatedEntityType: data.relatedEntityType ?? null,
        relatedEntityId: data.relatedEntityId ?? null,
      });
    },

    /**
     * List notifications for a user, optionally filtering to unread only.
     */
    list: async (
      companyId: string,
      userId: string,
      filters?: { unreadOnly?: boolean },
    ) => {
      const conditions = [
        eq(notifications.companyId, companyId),
        eq(notifications.userId, userId),
        isNull(notifications.dismissedAt),
      ];

      if (filters?.unreadOnly) {
        conditions.push(isNull(notifications.readAt));
      }

      return db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt));
    },

    /**
     * Mark a notification as read.
     * Scoped by companyId + userId to prevent cross-user access.
     */
    markRead: async (companyId: string, userId: string, id: string) => {
      const [updated] = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.companyId, companyId),
            eq(notifications.userId, userId),
          ),
        )
        .returning();

      if (!updated) {
        throw notFound("Notification not found");
      }

      await syncHubPersonalState({
        companyId,
        userId,
        id,
        state: { kind: "read" },
      });

      return updated;
    },

    /**
     * Dismiss a notification (soft-delete).
     * Scoped by companyId + userId to prevent cross-user access.
     */
    dismiss: async (companyId: string, userId: string, id: string) => {
      const [updated] = await db
        .update(notifications)
        .set({ dismissedAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.companyId, companyId),
            eq(notifications.userId, userId),
          ),
        )
        .returning();

      if (!updated) {
        throw notFound("Notification not found");
      }

      await syncHubPersonalState({
        companyId,
        userId,
        id,
        state: { kind: "dismiss" },
      });

      return updated;
    },

    /**
     * Get unread count for badge display.
     */
    getUnreadCount: async (companyId: string, userId: string) => {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.companyId, companyId),
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
            isNull(notifications.dismissedAt),
          ),
        );

      return result[0]?.count ?? 0;
    },
  };
}

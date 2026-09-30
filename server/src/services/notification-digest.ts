import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { notificationDigestItems } from "@armyofagents/db";
import type { HubDigestChangedLivePayload, HubSemanticType, UserRole } from "@armyofagents/shared";
import type { HubListResponse } from "./hub-items.js";
import { publishLiveEvent } from "./live-events.js";

export function notificationDigestService(db: Db) {
  return {
    async queueForUser(args: {
      companyId: string;
      userId: string;
      hubItemId: string;
      semanticType: HubSemanticType;
      publish?: boolean;
    }): Promise<{ queued: boolean }> {
      const created = await db
        .insert(notificationDigestItems)
        .values({
          companyId: args.companyId,
          userId: args.userId,
          hubItemId: args.hubItemId,
          semanticType: args.semanticType,
        })
        .onConflictDoNothing()
        .returning({ id: notificationDigestItems.id });
      if (args.publish !== false && created.length > 0) {
        publishLiveEvent({
          companyId: args.companyId,
          type: "hub.digest.changed",
          payload: { reason: "queued" } satisfies HubDigestChangedLivePayload,
        });
      }
      return { queued: created.length > 0 };
    },

    async listForUser(args: {
      companyId: string;
      userId: string;
      role?: UserRole;
    }): Promise<{ items: HubListResponse["items"] }> {
      const rows = await db
        .select({ hubItemId: notificationDigestItems.hubItemId })
        .from(notificationDigestItems)
        .where(
          and(
            eq(notificationDigestItems.companyId, args.companyId),
            eq(notificationDigestItems.userId, args.userId),
            isNull(notificationDigestItems.ackedAt),
          ),
        );
      if (rows.length === 0) return { items: [] };

      const { hubItemsService } = await import("./hub-items.js");
      const hub = hubItemsService(db);
      const visible = await Promise.all(
        rows.map((row) =>
          hub.getVisible(args.companyId, {
            hubItemId: row.hubItemId,
            actorUserId: args.userId,
            role: args.role,
            status: "open",
          }),
        ),
      );
      return {
        items: visible.filter((item): item is HubListResponse["items"][number] => item !== null),
      };
    },

    async ackForUser(args: {
      companyId: string;
      userId: string;
    }): Promise<{ acked: number }> {
      const updated = await db
        .update(notificationDigestItems)
        .set({ ackedAt: new Date() })
        .where(
          and(
            eq(notificationDigestItems.companyId, args.companyId),
            eq(notificationDigestItems.userId, args.userId),
            isNull(notificationDigestItems.ackedAt),
          ),
        )
        .returning({ id: notificationDigestItems.id });
      if (updated.length > 0) {
        publishLiveEvent({
          companyId: args.companyId,
          type: "hub.digest.changed",
          payload: { reason: "acked" } satisfies HubDigestChangedLivePayload,
        });
      }
      return { acked: updated.length };
    },
  };
}

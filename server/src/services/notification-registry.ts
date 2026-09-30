import { randomUUID } from "node:crypto";
import { getPersistentNotificationRegistryEntry } from "@armyofagents/shared";
import { unprocessable } from "../errors.js";
import type { EmitArgs } from "./hub-items.js";
import type { NotificationInput } from "./notifications.js";

function activeEntryForWrite(type: string) {
  const entry = getPersistentNotificationRegistryEntry(type);
  if (!entry) {
    throw unprocessable(`Unknown notification type "${type}"`);
  }
  if (entry.status === "dead") {
    throw unprocessable(`Notification type "${type}" is deprecated: ${entry.reason}`);
  }
  if (entry.status === "alias") {
    throw unprocessable(`Notification type "${type}" is a persisted-only alias for "${entry.canonicalType}"`);
  }
  return entry;
}

export function buildNotificationHubEmit(input: NotificationInput): EmitArgs {
  const entry = activeEntryForWrite(input.type);
  const sourceType = input.relatedEntityType ?? entry.defaultSourceType;
  const eventId = input.idempotencyKey ?? randomUUID();
  const sourceId = input.relatedEntityId
    ? `${input.relatedEntityId}:${input.userId}:${input.type}:${eventId}`
    : `${input.type}:${input.userId}:${eventId}`;

  return {
    companyId: input.companyId,
    semanticType: entry.semanticType,
    legacyType: input.type,
    sourceType,
    sourceId,
    title: input.title,
    summary: input.message ?? null,
    message: input.message ?? null,
    ownerUserId: input.userId,
    relatedEntityType: input.relatedEntityType ?? null,
    relatedEntityId: input.relatedEntityId ?? null,
    deliveryAttempts: 0,
    deliveredAt: new Date(),
    deliveryError: null,
  };
}

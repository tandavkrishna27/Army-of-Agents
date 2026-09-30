import { describe, expect, it } from "vitest";
import { HUB_LANES, HUB_SEMANTIC_TYPES } from "../hub.js";
import { NOTIFICATION_TYPES } from "../constants.js";
import {
  ACTIVE_NOTIFICATION_TYPES,
  NOTIFICATION_REGISTRY,
  PERSISTED_NOTIFICATION_ALIASES,
  getPersistentNotificationRegistryEntry,
  mapPersistedNotificationType,
  notificationTypeToLane,
} from "../notification-registry.js";

describe("notification registry", () => {
  it("covers persistent notification constants plus documented aliases", () => {
    expect(Object.keys(NOTIFICATION_REGISTRY).sort()).toEqual(
      [...NOTIFICATION_TYPES, ...PERSISTED_NOTIFICATION_ALIASES].sort(),
    );
  });

  it("keeps active notification types derived from persistent constants", () => {
    expect(ACTIVE_NOTIFICATION_TYPES).toEqual(
      NOTIFICATION_TYPES.filter((type) => type !== "discussion.extraction_complete"),
    );
  });

  it("maps every registered persisted value to shipped hub semantics and lanes", () => {
    for (const type of Object.keys(NOTIFICATION_REGISTRY)) {
      const semanticType = mapPersistedNotificationType(type);
      expect(HUB_SEMANTIC_TYPES).toContain(semanticType);
      expect(HUB_LANES).toContain(notificationTypeToLane(type));
    }
  });

  it("maps unknown persisted rows into legacy_other", () => {
    expect(mapPersistedNotificationType("old.plugin.type")).toBe("legacy_other");
    expect(notificationTypeToLane("old.plugin.type")).toBe("notifications");
  });

  it("treats inherited object keys as unknown persisted rows", () => {
    expect(getPersistentNotificationRegistryEntry("toString")).toBeUndefined();
    expect(getPersistentNotificationRegistryEntry("constructor")).toBeUndefined();
    expect(mapPersistedNotificationType("toString")).toBe("legacy_other");
    expect(notificationTypeToLane("constructor")).toBe("notifications");
  });

  it("marks successful extraction as dead awareness noise", () => {
    expect(getPersistentNotificationRegistryEntry("discussion.extraction_complete")).toMatchObject({
      status: "dead",
      replacementSemanticType: "discussion_pending",
    });
  });

  it("keeps the old proactive underscore value as a persisted-only alias", () => {
    expect(PERSISTED_NOTIFICATION_ALIASES).toEqual(["internal_agent_proactive"]);
    expect(mapPersistedNotificationType("internal_agent_proactive")).toBe("proactive");
    expect(ACTIVE_NOTIFICATION_TYPES).not.toContain("internal_agent_proactive");
  });

  it("keeps thread mention active for new persistent writes", () => {
    expect(getPersistentNotificationRegistryEntry("thread.mention")).toMatchObject({
      status: "active",
      semanticType: "mention",
      defaultSourceType: "discussion",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { activityService } from "../services/activity.js";
import { logActivity } from "../services/activity-log.js";
import { ReservedActivityNamespaceError } from "../services/activity-namespace.js";

const baseEvent = {
  companyId: "11111111-1111-4111-8111-111111111111",
  actorType: "system" as const,
  actorId: "plugin:example",
  entityId: "22222222-2222-4222-8222-222222222222",
};

describe("reserved activity namespace", () => {
  it.each([
    {
      action: "marketplace.reconciliation_completed",
      entityType: "plugin",
    },
    {
      action: "plugin.message",
      entityType: "marketplace_reconciliation",
    },
  ])(
    "blocks reserved events at both untrusted activity writers",
    async ({ action, entityType }) => {
      const insert = vi.fn();
      const db = { insert } as any;
      const event = { ...baseEvent, action, entityType };

      await expect(logActivity(db, event)).rejects.toBeInstanceOf(
        ReservedActivityNamespaceError,
      );
      expect(() => activityService(db).create(event)).toThrow(
        ReservedActivityNamespaceError,
      );
      expect(insert).not.toHaveBeenCalled();
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { activityService } from "../services/activity.js";
import { logActivity } from "../services/activity-log.js";
import {
  ReservedActivityNamespaceError,
  assertUnreservedActivityNamespace,
} from "../services/activity-namespace.js";

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
    // DE-19 / E0-F013. A `security.denied.*` row is the durable evidence that a
    // security control REFUSED something. If any writer other than
    // `recordSecurityDenial` could mint one, "there is a denial record" would
    // stop implying "a control denied", and an operator reading the audit could
    // be reading forgery. The reservation is on the ACTION PREFIX only —
    // `entityType` names the REFUSED RESOURCE (`memory_item`), which is what
    // makes `activity_log_entity_type_id_idx` answer "what was refused on this".
    {
      action: "security.denied.memory_read",
      entityType: "memory_item",
    },
    {
      action: "security.denied.anything_at_all",
      entityType: "whatever",
    },
  ])(
    "blocks reserved events at both untrusted activity writers ($action / $entityType)",
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

  // The HTTP writer (`POST /companies/:cid/activity`) used to inline its own
  // copy of the marketplace rule. It now delegates to this predicate, so the
  // reservation cannot hold in one writer and lapse in another.
  it("the shared predicate is what the HTTP create-route enforces, and it is not vacuous", () => {
    expect(() =>
      assertUnreservedActivityNamespace({
        action: "security.denied.memory_read",
        entityType: "memory_item",
      }),
    ).toThrow(ReservedActivityNamespaceError);
    // POSITIVE CONTROL: an ordinary product activity event still passes. Without
    // this, a predicate that threw on everything would satisfy every case above.
    expect(() =>
      assertUnreservedActivityNamespace({ action: "issue.created", entityType: "issue" }),
    ).not.toThrow();
    // A near-miss must NOT be caught: the prefix is `security.denied.`, so a
    // legitimate `security.audit.*` or `security.denied_by_hand` namespace is
    // unaffected. An over-broad reservation would silently break real writers.
    expect(() =>
      assertUnreservedActivityNamespace({ action: "security.audit.reviewed", entityType: "issue" }),
    ).not.toThrow();
  });
});

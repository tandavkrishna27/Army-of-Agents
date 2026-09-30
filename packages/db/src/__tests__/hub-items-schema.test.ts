import { describe, it, expect } from "vitest";
import { hubItems, notifications } from "../schema/notifications.js";
import { hubPreferences } from "../schema/hub_preferences.js";
import { hubCounterSnapshots } from "../schema/hub_counter_snapshots.js";
import { notificationPreferences } from "../schema/notification_preferences.js";
import { notificationDigestItems } from "../schema/notification_digest_items.js";
import {
  agentRuntimeDecisions,
  agentRuntimeTrustRules,
  hubAudit,
  hubAutopilotPolicies,
} from "../schema/index.js";

describe("hubItems schema", () => {
  it("hubItems aliases the notifications table and exposes hub columns", () => {
    expect(hubItems).toBe(notifications);
    for (const col of [
      "semanticType",
      "status",
      "sourceUniqueKey",
      "summary",
      "version",
      "ownerUserId",
      "claimedByUserId",
      "claimedAt",
    ]) {
      expect(hubItems, col).toHaveProperty(col);
    }
  });

  it("hubPreferences exposes per-user company-scoped settings columns", () => {
    for (const col of [
      "userId",
      "companyId",
      "defaultLanding",
      "visibleLanes",
      "groupMode",
      "density",
      "showAutopilotEntry",
      "updatedAt",
    ]) {
      expect(hubPreferences, col).toHaveProperty(col);
    }
  });

  it("hubCounterSnapshots exposes bounded per-user counter columns", () => {
    for (const col of [
      "userId",
      "companyId",
      "openCount",
      "unreadCount",
      "invalidatedAt",
      "computedAt",
      "updatedAt",
    ]) {
      expect(hubCounterSnapshots, col).toHaveProperty(col);
    }
  });

  it("exports W2-L3 notification preference and digest tables", () => {
    for (const col of [
      "userId",
      "companyId",
      "rules",
      "quietHours",
      "digest",
      "updatedAt",
    ]) {
      expect(notificationPreferences, col).toHaveProperty(col);
    }
    for (const col of [
      "userId",
      "companyId",
      "hubItemId",
      "semanticType",
      "queuedAt",
      "ackedAt",
    ]) {
      expect(notificationDigestItems, col).toHaveProperty(col);
    }
  });

  it("exports W3 autopilot policy table and reversible audit metadata", () => {
    expect(hubAutopilotPolicies).toBeDefined();
    for (const col of ["companyId", "mode", "rules", "updatedAt"]) {
      expect(hubAutopilotPolicies, col).toHaveProperty(col);
    }
    expect(hubAudit).toHaveProperty("decisionContext");
  });

  it("exports W4 curation metadata columns on hubItems", () => {
    for (const col of [
      "curationGroupLabel",
      "curationGroupSummary",
      "curationReason",
      "curationPriorityReason",
      "curationRevision",
      "curatedAt",
      "curatedByAgentId",
    ]) {
      expect(hubItems, col).toHaveProperty(col);
    }
  });

  it("exports W5 runtime decision prompt table with relay integrity columns", () => {
    for (const col of [
      "companyId",
      "agentId",
      "runId",
      "adapterType",
      "adapterSessionId",
      "adapterSessionParams",
      "kind",
      "status",
      "nonce",
      "sourceRevision",
      "promptHash",
      "sourceUniqueKey",
      "title",
      "summary",
      "promptText",
      "toolName",
      "command",
      "commandHash",
      "cwd",
      "path",
      "networkTarget",
      "riskClass",
      "options",
      "expiresAt",
      "timeoutPolicy",
      "decision",
      "answerPayload",
      "answerIdempotencyKey",
      "answeredByUserId",
      "answeredAt",
      "relayedAt",
      "relayError",
    ]) {
      expect(agentRuntimeDecisions, col).toHaveProperty(col);
    }
  });

  it("exports W5 runtime trust rules with scoped allow-always columns", () => {
    for (const col of [
      "companyId",
      "agentId",
      "adapterType",
      "toolName",
      "commandHash",
      "pathScope",
      "networkScope",
      "riskClass",
      "enabled",
      "expiresAt",
      "createdByUserId",
      "lastUsedAt",
    ]) {
      expect(agentRuntimeTrustRules, col).toHaveProperty(col);
    }
  });
});

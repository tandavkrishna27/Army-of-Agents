import { describe, expect, it } from "vitest";
import {
  internalAgentConfig,
  internalAgentRuntimeApprovals,
  internalAgentToolTrustRules,
} from "@armyofagents/db";
import {
  COMMANDER_RUNTIME_APPROVAL_DECISIONS,
  COMMANDER_RUNTIME_APPROVAL_STATUSES,
  COMMANDER_TOOL_TRUST_SCOPES,
  updateInternalAgentConfigSchema,
} from "@armyofagents/shared";

function getColumnNames(table: unknown): string[] {
  expect(table, "table export is missing").toBeTruthy();
  const record = table as Record<string, unknown>;
  return Object.keys(table).filter(
    (key) =>
      typeof record[key] === "object" &&
      record[key] !== null &&
      "name" in (record[key] as Record<string, unknown>),
  );
}

describe("internalAgentRuntimeApprovals table", () => {
  it("has durable Commander runtime approval columns", () => {
    const cols = getColumnNames(internalAgentRuntimeApprovals);
    const required = [
      "id",
      "companyId",
      "conversationId",
      "runId",
      "userId",
      "toolName",
      "params",
      "paramsHash",
      "paramsHashVersion",
      "status",
      "expiresAt",
      "decidedByUserId",
      "decidedAt",
      "decision",
      "executedAt",
      "resultSummary",
      "resultError",
      "resultEntityType",
      "resultEntityId",
      "createdAt",
      "updatedAt",
    ];

    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });
});

describe("internalAgentToolTrustRules table", () => {
  it("has exact-match trusted repeated action columns", () => {
    const cols = getColumnNames(internalAgentToolTrustRules);
    const required = [
      "id",
      "companyId",
      "userId",
      "toolName",
      "paramsHash",
      "paramsHashVersion",
      "scope",
      "enabled",
      "createdByUserId",
      "lastUsedAt",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ];

    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });
});

describe("internalAgentConfig runtime approval settings", () => {
  it("has Commander runtime approval config toggles", () => {
    const cols = getColumnNames(internalAgentConfig);
    expect(cols).toContain("runtimeApprovalsEnabled");
    expect(cols).toContain("runtimeAllowAlwaysEnabled");
    expect(cols).toContain("vendorCliBypassEnabled");
  });

  it("accepts Commander runtime approval config toggles in the shared validator", () => {
    expect(() =>
      updateInternalAgentConfigSchema.parse({
        runtimeApprovalsEnabled: true,
        runtimeAllowAlwaysEnabled: false,
        vendorCliBypassEnabled: true,
      }),
    ).not.toThrow();
  });
});

describe("Commander runtime approval shared constants", () => {
  it("defines the durable runtime approval vocabulary", () => {
    expect(COMMANDER_RUNTIME_APPROVAL_STATUSES).toEqual([
      "pending",
      "executing",
      "approved",
      "denied",
      "expired",
      "failed",
      "cancelled",
    ]);
    expect(COMMANDER_RUNTIME_APPROVAL_DECISIONS).toEqual([
      "allow_once",
      "allow_always",
      "deny",
    ]);
    expect(COMMANDER_TOOL_TRUST_SCOPES).toEqual(["exact_params"]);
  });
});

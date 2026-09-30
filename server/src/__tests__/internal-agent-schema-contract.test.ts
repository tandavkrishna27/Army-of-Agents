import { describe, it, expect } from "vitest";
import {
  internalAgentConfig,
  internalAgentConversations,
  internalAgentMessages,
  internalAgentRuns,
  internalAgentReminders,
  workflowTemplates,
  notifications,
} from "@armyofagents/db";

/**
 * Internal Agent Schema Contract Tests
 *
 * Verifies all 7 tables have the required columns per the internal-agent schema
 * (tables 5-11): internal agent config, conversations, messages, runs, reminders,
 * workflow templates, and notifications.
 */

// Helper: get column names from a Drizzle table
function getColumnNames(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter(
    (key) =>
      typeof table[key] === "object" &&
      table[key] !== null &&
      "name" in (table[key] as Record<string, unknown>),
  );
}

describe("internalAgentConfig table", () => {
  const cols = getColumnNames(internalAgentConfig);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "executionMode",
      "provider",
      "model",
      "cliTool",
      "autonomyLevel",
      "enabledCapabilities",
      "notificationPreference",
      "contextTokenBudget",
      "budgetMonthlyCents",
      "spentMonthlyCents",
      "proactiveIntervalMinutes",
      "lastProactiveRunAt",
      "metadata",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("uses cents for budget fields (DA-25), not USD", () => {
    expect(cols).toContain("budgetMonthlyCents");
    expect(cols).toContain("spentMonthlyCents");
    // Must NOT have USD-based fields
    expect(cols).not.toContain("budgetMonthlyUsd");
    expect(cols).not.toContain("spentMonthlyUsd");
    expect(cols).not.toContain("budgetMonthly");
    expect(cols).not.toContain("spentMonthly");
  });

  it("has enabledCapabilities jsonb field", () => {
    expect(cols).toContain("enabledCapabilities");
  });

  it("has proactive scheduling fields", () => {
    expect(cols).toContain("proactiveIntervalMinutes");
    expect(cols).toContain("lastProactiveRunAt");
  });
});

describe("internalAgentConversations table", () => {
  const cols = getColumnNames(internalAgentConversations);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "userId",
      "status",
      "summarizedContext",
      "summarizedUpToMessageId",
      "messageCount",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("supports conversation summarization", () => {
    expect(cols).toContain("summarizedContext");
    expect(cols).toContain("summarizedUpToMessageId");
  });
});

describe("internalAgentMessages table", () => {
  const cols = getColumnNames(internalAgentMessages);

  it("has all required columns", () => {
    const required = [
      "id",
      "conversationId",
      "role",
      "content",
      "toolCalls",
      "toolResults",
      "pageContext",
      "departmentContext",
      "tokenCount",
      "runId",
      "createdAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has tool interaction fields", () => {
    expect(cols).toContain("toolCalls");
    expect(cols).toContain("toolResults");
  });

  it("has context fields for page and department awareness", () => {
    expect(cols).toContain("pageContext");
    expect(cols).toContain("departmentContext");
  });
});

describe("internalAgentRuns table", () => {
  const cols = getColumnNames(internalAgentRuns);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "triggerType",
      "triggerSource",
      "status",
      "errorMessage",
      "toolsCalled",
      "summary",
      "tokenUsage",
      "costCents",
      "durationMs",
      "departmentContext",
      "userId",
      "conversationMessageId",
      "relatedEntityType",
      "relatedEntityId",
      "provider",
      "model",
      "createdAt",
      "completedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("tracks cost in cents and token usage (DA-25, DA-27)", () => {
    expect(cols).toContain("costCents");
    expect(cols).toContain("tokenUsage");
    expect(cols).toContain("toolsCalled");
    // Must NOT have USD-based fields
    expect(cols).not.toContain("costUsd");
    expect(cols).not.toContain("costDollars");
  });

  it("has trigger classification fields (DA-27)", () => {
    expect(cols).toContain("triggerType");
    expect(cols).toContain("triggerSource");
  });

  it("has related entity tracking", () => {
    expect(cols).toContain("relatedEntityType");
    expect(cols).toContain("relatedEntityId");
  });

  it("has LLM provider info", () => {
    expect(cols).toContain("provider");
    expect(cols).toContain("model");
  });
});

describe("internalAgentReminders table", () => {
  const cols = getColumnNames(internalAgentReminders);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "userId",
      "content",
      "triggerAt",
      "status",
      "firedRunId",
      "relatedEntityType",
      "relatedEntityId",
      "createdAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has scheduling fields", () => {
    expect(cols).toContain("status");
    expect(cols).toContain("triggerAt");
  });
});

describe("workflowTemplates table", () => {
  const cols = getColumnNames(workflowTemplates);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "name",
      "description",
      "steps",
      "dependencies",
      "instantiationCount",
      "lastInstantiatedAt",
      "createdBy",
      "createdAt",
      "updatedAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has steps and dependencies as jsonb fields", () => {
    expect(cols).toContain("steps");
    expect(cols).toContain("dependencies");
  });

  it("has usage tracking", () => {
    expect(cols).toContain("instantiationCount");
    expect(cols).toContain("lastInstantiatedAt");
  });
});

describe("notifications table", () => {
  const cols = getColumnNames(notifications);

  it("has all required columns", () => {
    const required = [
      "id",
      "companyId",
      "userId",
      "type",
      "title",
      "message",
      "relatedEntityType",
      "relatedEntityId",
      "readAt",
      "dismissedAt",
      "createdAt",
    ];
    for (const col of required) {
      expect(cols, `missing column: ${col}`).toContain(col);
    }
  });

  it("has read/dismiss tracking", () => {
    expect(cols).toContain("readAt");
    expect(cols).toContain("dismissedAt");
  });

  it("has related entity fields for navigation", () => {
    expect(cols).toContain("relatedEntityType");
    expect(cols).toContain("relatedEntityId");
  });
});

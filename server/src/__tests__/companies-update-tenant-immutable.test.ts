import { describe, it, expect, vi } from "vitest";

// companies.ts imports these table names from @armyofagents/db. Vitest's named-
// export guard requires each accessed name to exist on the mock, so enumerate
// the full import list (hoisted so the vi.mock factory can read it).
const { DB_TABLES } = vi.hoisted(() => ({
  DB_TABLES: [
    "companies", "agents", "agentApiKeys", "agentConfigRevisions", "agentProjects",
    "agentRuntimeState", "agentTaskSessions", "agentWakeupRequests", "issues",
    "issueApprovals", "issueAttachments", "issueComments", "issueDocuments",
    "issueReadStates", "assets", "projects", "projectGoals", "projectWorkspaces",
    "executionWorkspaces", "goals", "heartbeatRuns", "heartbeatRunEvents",
    "heartbeatRunWatchdogDecisions", "costEvents", "financeEvents", "approvalComments",
    "approvals", "activityLog", "companySecrets", "companySkills", "documents",
    "documentRevisions", "feedbackExports", "feedbackVotes", "joinRequests", "invites",
    "notifications", "principalPermissionGrants", "companyMemberships", "mcpApiKeys",
    "mcpClientConnections", "workspaceOperations", "workspaceRuntimeServices",
  ] as string[],
}));

vi.mock("@armyofagents/db", () => {
  const stubs: Record<string, unknown> = {};
  for (const name of DB_TABLES) stubs[name] = { _tableName: name };
  return stubs;
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  count: (...a: unknown[]) => ({ count: a }),
  inArray: (...a: unknown[]) => ({ inArray: a }),
  isNull: (...a: unknown[]) => ({ isNull: a }),
  sql: (...a: unknown[]) => a,
}));

import { companyService } from "../services/companies.js";

function makeCaptureDb(captured: { payload?: Record<string, unknown> }) {
  return {
    update: (_table: unknown) => ({
      set: (payload: Record<string, unknown>) => {
        captured.payload = payload;
        return {
          where: (..._a: unknown[]) => ({
            returning: () => ({
              then: (resolve: (rows: unknown[]) => unknown) =>
                Promise.resolve(resolve([{ id: "co-1", name: "Renamed" }])),
            }),
          }),
        };
      },
    }),
  };
}

describe("companyService.update — tenant key immutability (Codex ①)", () => {
  it("strips organizationId out of the .set() payload (no cross-tenant reparent)", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const svc = companyService(makeCaptureDb(captured) as never);
    await svc.update("co-1", { name: "Renamed", organizationId: "other-tenant" } as never);
    expect(captured.payload).not.toHaveProperty("organizationId");
  });

  it("still writes the other mutable fields", async () => {
    const captured: { payload?: Record<string, unknown> } = {};
    const svc = companyService(makeCaptureDb(captured) as never);
    await svc.update("co-1", { name: "Renamed", vision: "V" } as never);
    expect(captured.payload).toMatchObject({ name: "Renamed", vision: "V" });
    expect(captured.payload).toHaveProperty("updatedAt");
  });
});

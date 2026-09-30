/**
 * Plan 3 Task 7 — in-flight cancellation reaches internal_agent_runs.
 *
 * Contract test: the crew cancellation helpers
 * must cancel internal_agent_runs records when invoked.
 *
 * The helpers live outside heartbeat.ts so this test does not import the full
 * heartbeat service graph.
 */
import { describe, it, expect, vi } from "vitest";

// ── Mocks (must be hoisted) ─────────────────────────────────────────────────
vi.mock("drizzle-orm", () => {
  const makeSql = () => {
    const s: any = function (..._args: any[]) { return s; };
    s.as = () => s;
    s.mapWith = () => s;
    return s;
  };
  const sql = makeSql();
  return {
    and: (...args: unknown[]) => ({ op: "and", args }),
    eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
    inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
    asc: (col: unknown) => ({ op: "asc", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    or: (...args: unknown[]) => ({ op: "or", args }),
    gt: (a: unknown, b: unknown) => ({ op: "gt", a, b }),
    lte: (a: unknown, b: unknown) => ({ op: "lte", a, b }),
    ne: (a: unknown, b: unknown) => ({ op: "ne", a, b }),
    sql,
    not: (x: unknown) => ({ op: "not", x }),
    count: () => sql,
    isNull: (a: unknown) => ({ op: "isNull", a }),
    notInArray: (col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
    lt: (a: unknown, b: unknown) => ({ op: "lt", a, b }),
    relations: () => ({}),
  };
});

vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    agentApiKeys: t("agentApiKeys"),
    agentConfigRevisions: t("agentConfigRevisions"),
    agentProjects: t("agentProjects"),
    agentRuntimeState: t("agentRuntimeState"),
    agentTaskSessions: t("agentTaskSessions"),
    agentWakeupRequests: t("agentWakeupRequests"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
    approvals: t("approvals"),
    approvalComments: t("approvalComments"),
    activityLog: t("activityLog"),
    artifacts: t("artifacts"),
    artifactVersions: t("artifactVersions"),
    assets: t("assets"),
    auth: t("auth"),
    boardApiKeys: t("boardApiKeys"),
    budgetIncidents: t("budgetIncidents"),
    budgetPolicies: t("budgetPolicies"),
    cliAuthChallenges: t("cliAuthChallenges"),
    companies: t("companies"),
    companyMemberships: t("companyMemberships"),
    companySecrets: t("companySecrets"),
    companySecretVersions: t("companySecretVersions"),
    companySkills: t("companySkills"),
    costEvents: t("costEvents"),
    discussionEntries: t("discussionEntries"),
    discussions: t("discussions"),
    discussionExtractedItems: t("discussionExtractedItems"),
    documents: t("documents"),
    documentRevisions: t("documentRevisions"),
    embeddingQueue: t("embeddingQueue"),
    environments: t("environments"),
    executionWorkspaces: t("executionWorkspaces"),
    feedbackExports: t("feedbackExports"),
    feedbackVotes: t("feedbackVotes"),
    fileImportJobs: t("fileImportJobs"),
    financeEvents: t("financeEvents"),
    goals: t("goals"),
    heartbeatRunEvents: t("heartbeatRunEvents"),
    heartbeatRuns: t("heartbeatRuns"),
    heartbeatRunWatchdogDecisions: t("heartbeatRunWatchdogDecisions"),
    inboxDismissals: t("inboxDismissals"),
    instanceUserRoles: t("instanceUserRoles"),
    internalAgentConfig: t("internalAgentConfig"),
    internalAgentConversations: t("internalAgentConversations"),
    internalAgentMessages: t("internalAgentMessages"),
    internalAgentReminders: t("internalAgentReminders"),
    internalAgentRuns: t("internalAgentRuns"),
    invites: t("invites"),
    issueApprovals: t("issueApprovals"),
    issueAttachments: t("issueAttachments"),
    issueComments: t("issueComments"),
    issueDocuments: t("issueDocuments"),
    issueLabels: t("issueLabels"),
    issueReadStates: t("issueReadStates"),
    issues: t("issues"),
    joinRequests: t("joinRequests"),
    labels: t("labels"),
    marketplaceCatalogCache: t("marketplaceCatalogCache"),
    marketplaceCompanySettings: t("marketplaceCompanySettings"),
    marketplaceInstallOperations: t("marketplaceInstallOperations"),
    marketplacePendingUpdates: t("marketplacePendingUpdates"),
    mcpApiKeys: t("mcpApiKeys"),
    mcpClientConnections: t("mcpClientConnections"),
    memoryAssets: t("memoryAssets"),
    memoryExtractionBatches: t("memoryExtractionBatches"),
    memoryExtractions: t("memoryExtractions"),
    memoryFeedbackPatterns: t("memoryFeedbackPatterns"),
    memoryFolders: t("memoryFolders"),
    memoryItemVersions: t("memoryItemVersions"),
    memoryItems: t("memoryItems"),
    memoryRelations: t("memoryRelations"),
    memoryRetrievals: t("memoryRetrievals"),
    notifications: t("notifications"),
    pluginCompanySettings: t("pluginCompanySettings"),
    pluginConfig: t("pluginConfig"),
    pluginEntities: t("pluginEntities"),
    pluginJobs: t("pluginJobs"),
    pluginLogs: t("pluginLogs"),
    plugins: t("plugins"),
    pluginState: t("pluginState"),
    pluginVersionSnapshots: t("pluginVersionSnapshots"),
    pluginWebhooks: t("pluginWebhooks"),
    principalPermissionGrants: t("principalPermissionGrants"),
    projectGoals: t("projectGoals"),
    projects: t("projects"),
    projectWorkspaces: t("projectWorkspaces"),
    providerQuotaWindows: t("providerQuotaWindows"),
    routines: t("routines"),
    sidebarPreferences: t("sidebarPreferences"),
    suggestions: t("suggestions"),
    taskDependencies: t("taskDependencies"),
    teamCoordinations: t("teamCoordinations"),
    teamMembers: t("teamMembers"),
    teams: t("teams"),
    userRoles: t("userRoles"),
    workflowTemplates: t("workflowTemplates"),
    workspaceOperations: t("workspaceOperations"),
    workspaceRuntimeServices: t("workspaceRuntimeServices"),
  };
});

// Mock heavy service dependencies that heartbeat.ts imports
vi.mock("../services/secrets.js", () => ({ secretService: () => ({}) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({}) }));
vi.mock("../services/output-detection.js", () => ({ outputDetectionService: () => ({}) }));
vi.mock("../services/workspace.js", () => ({
  executionWorkspaceService: () => ({}),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({}) }));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb() {
  const capturedSets: Array<Record<string, unknown>> = [];
  const db: any = {
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        capturedSets.push(vals);
        return { where: () => Promise.resolve([]) };
      },
    }),
    _capturedSets: capturedSets,
  };
  return db;
}

describe("cancelCrewRunsForAgent", () => {
  it("cancels internal_agent_runs for the given agentId", async () => {
    const { cancelCrewRunsForAgent } = await import("../services/crew-cancellation.js");
    const db = makeDb();
    await cancelCrewRunsForAgent(db, "agent-abc");
    expect(db._capturedSets.length).toBeGreaterThan(0);
    expect(db._capturedSets.some((s: any) => s.status === "cancelled")).toBe(true);
  });
});

describe("cancelCrewRunsForCompany", () => {
  it("cancels internal_agent_runs for the given companyId", async () => {
    const { cancelCrewRunsForCompany } = await import("../services/crew-cancellation.js");
    const db = makeDb();
    await cancelCrewRunsForCompany(db, "co-xyz");
    expect(db._capturedSets.length).toBeGreaterThan(0);
    expect(db._capturedSets.some((s: any) => s.status === "cancelled")).toBe(true);
  });
});

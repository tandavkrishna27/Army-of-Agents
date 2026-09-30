export const queryKeys = {
  companies: {
    all: ["companies"] as const,
    detail: (id: string) => ["companies", id] as const,
    stats: ["companies", "stats"] as const,
  },
  organizations: {
    list: ["organizations"] as const,
  },
  agents: {
    list: (companyId: string) => ["agents", companyId] as const,
    detail: (id: string) => ["agents", "detail", id] as const,
    runtimeState: (id: string) => ["agents", "runtime-state", id] as const,
    taskSessions: (id: string) => ["agents", "task-sessions", id] as const,
    keys: (agentId: string) => ["agents", "keys", agentId] as const,
    configRevisions: (agentId: string) => ["agents", "config-revisions", agentId] as const,
    adapterModels: (companyId: string, adapterType: string) =>
      ["agents", companyId, "adapter-models", adapterType] as const,
    instructionsBundle: (id: string) => ["agents", "instructions-bundle", id] as const,
    instructionsFile: (id: string, relativePath: string) =>
      ["agents", "instructions-bundle", id, "file", relativePath] as const,
  },
  issues: {
    list: (companyId: string) => ["issues", companyId] as const,
    search: (companyId: string, q: string, projectId?: string) =>
      ["issues", companyId, "search", q, projectId ?? "__all-projects__"] as const,
    listAssignedToMe: (companyId: string) => ["issues", companyId, "assigned-to-me"] as const,
    listTouchedByMe: (companyId: string) => ["issues", companyId, "touched-by-me"] as const,
    listUnreadTouchedByMe: (companyId: string) => ["issues", companyId, "unread-touched-by-me"] as const,
    labels: (companyId: string) => ["issues", companyId, "labels"] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["issues", companyId, "project", projectId] as const,
    detail: (id: string) => ["issues", "detail", id] as const,
    comments: (issueId: string) => ["issues", "comments", issueId] as const,
    attachments: (issueId: string) => ["issues", "attachments", issueId] as const,
    activity: (issueId: string) => ["issues", "activity", issueId] as const,
    runs: (issueId: string) => ["issues", "runs", issueId] as const,
    approvals: (issueId: string) => ["issues", "approvals", issueId] as const,
    liveRuns: (issueId: string) => ["issues", "live-runs", issueId] as const,
    activeRun: (issueId: string) => ["issues", "active-run", issueId] as const,
    dependencies: (issueId: string) => ["issues", "dependencies", issueId] as const,
    documents: (issueId: string) => ["issues", "documents", issueId] as const,
  },
  projects: {
    list: (companyId: string) => ["projects", companyId] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    agents: (projectId: string) => ["projects", "agents", projectId] as const,
    budget: (projectId: string) => ["projects", "budget", projectId] as const,
    env: (projectId: string) => ["projects", "env", projectId] as const,
  },
  goals: {
    list: (companyId: string) => ["goals", companyId] as const,
    tree: (companyId: string) => ["goals", "tree", companyId] as const,
    listByProject: (companyId: string, projectId: string) =>
      ["goals", companyId, "project", projectId] as const,
    detail: (id: string) => ["goals", "detail", id] as const,
  },
  routines: {
    list: (companyId: string) => ["routines", companyId] as const,
    detail: (id: string) => ["routines", "detail", id] as const,
    runs: (id: string) => ["routines", id, "runs"] as const,
    activity: (companyId: string, id: string) => ["routines", companyId, id, "activity"] as const,
    revisions: (routineId: string) => ["routineRevisions", routineId] as const,
  },
  approvals: {
    list: (companyId: string, status?: string) =>
      ["approvals", companyId, status] as const,
    detail: (approvalId: string) => ["approvals", "detail", approvalId] as const,
    comments: (approvalId: string) => ["approvals", "comments", approvalId] as const,
    issues: (approvalId: string) => ["approvals", "issues", approvalId] as const,
  },
  trustScores: {
    list: (companyId: string) => ["trust-scores", companyId] as const,
    detail: (companyId: string, agentId: string) => ["trust-scores", companyId, agentId] as const,
  },
  access: {
    joinRequests: (companyId: string, status: string = "pending_approval") =>
      ["access", "join-requests", companyId, status] as const,
    invite: (token: string) => ["access", "invite", token] as const,
    adminUsers: (query: string) => ["access", "admin-users", query] as const,
    userCompanyAccess: (userId: string) =>
      ["access", "user-company-access", userId] as const,
  },
  team: {
    summary: (companyId: string) => ["team", companyId] as const,
    humanSearch: (companyId: string, input: { q: string; role?: string; departmentId?: string | null; limit?: number }) =>
      ["team", companyId, "humans", "search", input] as const,
    member: (companyId: string, userId: string) => ["team", companyId, "member", userId] as const,
    dependencies: (companyId: string, userId: string) => ["team", companyId, "dependencies", userId] as const,
    workload: (companyId: string, userId: string) => ["team", companyId, "member", userId, "workload"] as const,
    capabilities: (companyId: string, userId: string) => ["team", companyId, "member", userId, "capabilities"] as const,
  },
  teams: {
    list: (companyId: string) => ["teams", companyId] as const,
    detail: (companyId: string, teamId: string) => ["teams", companyId, teamId] as const,
    detailBySlug: (companyId: string, slug: string) => ["teams", companyId, "by-slug", slug] as const,
    members: (companyId: string, teamId: string) => ["teams", companyId, teamId, "members"] as const,
    member: (teamId: string, agentId: string) => ["teams", teamId, "members", agentId] as const,
    coordination: (companyId: string, teamId: string) => ["teams", companyId, teamId, "coordination"] as const,
  },
  auth: {
    session: ["auth", "session"] as const,
    profile: ["auth", "profile"] as const,
  },
  adapters: {
    all: ["adapters"] as const,
  },
  health: ["health"] as const,
  companyHealth: (companyId: string) => ["health", "company", companyId] as const,
  instanceHealth: ["health", "instance"] as const,
  secrets: {
    list: (companyId: string) => ["secrets", companyId] as const,
    providers: (companyId: string) => ["secret-providers", companyId] as const,
    providerConfigs: (companyId: string) => ["secret-provider-configs", companyId] as const,
    runtimeProviderKeys: (companyId: string) => ["runtime-provider-keys", companyId] as const,
    bindings: (secretId: string) => ["secret-bindings", secretId] as const,
    accessEvents: (secretId: string) => ["secret-access-events", secretId] as const,
  },
  github: {
    patStatus: (companyId: string) => ["github", "patStatus", companyId] as const,
  },
  providers: {
    list: (companyId: string) => ["providers", companyId] as const,
  },
  dashboard: (companyId: string) => ["dashboard", companyId] as const,
  home: (companyId: string) => ["home", companyId] as const,
  sidebarBadges: (companyId: string) => ["sidebar-badges", companyId] as const,
  hubItems: {
    list: (
      companyId: string,
      opts?: {
        lane?: string;
        status?: string;
        includeDismissed?: boolean;
        includeSnoozed?: boolean;
        q?: string;
        cursor?: string;
        groupMode?: string;
        limit?: number;
      },
    ) => ["hub-items", companyId, opts ?? {}] as const,
    counts: (companyId: string) => ["hub-items", companyId, "counts"] as const,
    hiddenCount: (companyId: string, lane: string) =>
      ["hub-items", companyId, "hidden-count", lane] as const,
    // "Needs you most" Home preview: a small waiting-lane page fetched when no
    // lane is active. Distinct key from the lane infinite-query so the two caches
    // never collide; sits under the ["hub-items", cid] prefix for live refresh.
    homePreview: (companyId: string) =>
      ["hub-items", companyId, "home-preview"] as const,
    audit: (companyId: string, itemId: string) =>
      ["hub-items", companyId, itemId, "audit"] as const,
    preferences: (companyId: string) => ["hub-items", companyId, "preferences"] as const,
    autopilotPolicy: (companyId: string) =>
      ["hub-items", companyId, "autopilot-policy"] as const,
    autopilotActions: (companyId: string) =>
      ["hub-items", companyId, "autopilot-actions"] as const,
  },
  agentRuntimeDecisions: {
    detail: (companyId: string, decisionId: string) =>
      ["agent-runtime-decisions", companyId, decisionId] as const,
    trustRules: (companyId: string) =>
      ["agent-runtime-decisions", companyId, "trust-rules"] as const,
  },
  workQuestions: {
    all: (companyId: string) => ["work-questions", companyId] as const,
    detail: (companyId: string, questionId: string) =>
      ["work-questions", companyId, questionId] as const,
  },
  sidebarPreferences: (companyId: string) => ["sidebar-preferences", companyId] as const,
  homeBoardLayout: (companyId: string) => ["home-board-layout", companyId] as const,
  viewerPreferences: (companyId: string) => ["viewer-preferences", companyId] as const,
  inboxDismissals: (companyId: string) => ["inbox-dismissals", companyId] as const,
  activity: (companyId: string) => ["activity", companyId] as const,
  costs: (companyId: string, from?: string, to?: string) =>
    ["costs", companyId, from, to] as const,
  heartbeats: (companyId: string, agentId?: string) =>
    ["heartbeats", companyId, agentId] as const,
  liveRuns: (companyId: string) => ["live-runs", companyId] as const,
  runIssues: (runId: string) => ["run-issues", runId] as const,
  org: Object.assign(
    (companyId: string) => ["org", companyId] as const,
    { tree: (companyId: string) => ["org", companyId, "tree"] as const },
  ),
  memory: {
    list: (companyId: string) => ["memory", companyId] as const,
    pending: (companyId: string) => ["memory", companyId, "pending"] as const,
    detail: (companyId: string, id: string) => ["memory", companyId, id] as const,
      neighbors: (companyId: string, id: string) =>
        ["memory", companyId, id, "neighbors"] as const,
      companyGraph: (companyId: string, optionsKey = "default") =>
        ["memory", companyId, "company-graph", optionsKey] as const,
      usage: (companyId: string, id: string) =>
        ["memory", companyId, id, "usage"] as const,
    versions: (companyId: string, id: string) => ["memory", companyId, id, "versions"] as const,
    semanticSearch: (companyId: string, q: string) => ["memory", companyId, "semantic-search", q] as const,
    // Memory retrieval audit rows.
    retrievalsForIssue: (companyId: string, issueId: string) =>
      ["memory", companyId, "retrievals", "issue", issueId] as const,
    // Phase 7: Commander Memory cockpit card
    retrievalsForConversation: (companyId: string, conversationId: string) =>
      ["memory", companyId, "retrievals", "conversation", conversationId] as const,
    // Memory starter templates.
    starterTemplates: (companyId: string) =>
      ["memory", companyId, "starter-templates"] as const,
    importJob: (companyId: string, jobId: string) =>
      ["memory", companyId, "import-job", jobId] as const,
    folders: {
      list: (companyId: string, departmentId?: string) =>
        ["memory", "folders", companyId, departmentId ?? "_all"] as const,
    },
    assets: {
      list: (
        companyId: string,
        params?: {
          departmentId?: string;
          folderPath?: string;
          mimeType?: string;
        },
      ) =>
        [
          "memory",
          "assets",
          companyId,
          params?.departmentId ?? "_all",
          params?.folderPath ?? "_all",
          params?.mimeType ?? "_all",
        ] as const,
      detail: (companyId: string, id: string) =>
        ["memory", "assets", companyId, "detail", id] as const,
    },
  },
  search: {
    global: (companyId: string, query: string, includeArchived = false) =>
      ["search", companyId, query, includeArchived ? "archived" : "default"] as const,
  },
  suggestions: {
    pending: (companyId: string) => ["suggestions", companyId, "pending"] as const,
  },
  debriefs: {
    list: (companyId: string) => ["debriefs", companyId] as const,
    detail: (companyId: string, id: string) => ["debriefs", companyId, id] as const,
  },
  discussions: {
    list: (companyId: string) => ["discussions", companyId] as const,
    detail: (companyId: string, id: string) => ["discussions", companyId, id] as const,
  },
  threads: {
    list: (companyId: string) => ["threads", companyId, "list"] as const,
    detail: (companyId: string, id: string) => ["threads", companyId, id] as const,
    inbox: (companyId: string) => ["threads-inbox", companyId] as const,
  },
  agentGreeting: (companyId: string) => ["agent-greeting", companyId] as const,
  agentConversation: (companyId: string) => ["agent-conversation", companyId] as const,
  agentConfig: (companyId: string) => ["agent-config", companyId] as const,
  commanderSkills: (companyId: string) => ["commander-skills", companyId] as const,
  agentRuns: (companyId: string) => ["agent-runs", companyId] as const,
  agentReminders: (companyId: string) => ["agent-reminders", companyId] as const,
  notifications: {
    list: (companyId: string) => ["notifications", companyId] as const,
    preferences: (companyId: string) => ["notifications", companyId, "preferences"] as const,
    digest: (companyId: string) => ["notifications", companyId, "digest"] as const,
  },
  workflowTemplates: {
    list: (companyId: string) => ["workflow-templates", companyId] as const,
    detail: (companyId: string, id: string) => ["workflow-templates", companyId, id] as const,
  },
  artifacts: {
    byIssue: (issueId: string) => ["artifacts", "issue", issueId] as const,
    detail: (id: string) => ["artifacts", "detail", id] as const,
  },
  taskOutputs: {
    byIssue: (issueId: string) => ["task-outputs", "issue", issueId] as const,
    detail: (id: string) => ["task-outputs", "detail", id] as const,
  },
  mcp: {
    status: (companyId: string) => ["mcp", companyId, "status"] as const,
    keys: (companyId: string) => ["mcp", companyId, "keys"] as const,
    clients: (companyId: string) => ["mcp", companyId, "clients"] as const,
  },
  mcpConnectors: {
    list: (companyId: string) => ["mcp-connectors", companyId] as const,
    catalog: (companyId: string) => ["mcp-connectors", companyId, "catalog"] as const,
  },
  detectedOutputs: {
    byIssue: (issueId: string) => ["detected-outputs", "issue", issueId] as const,
    byRun: (runId: string) => ["detected-outputs", "run", runId] as const,
  },
  companySkills: {
    list: (companyId: string) => ["company-skills", companyId] as const,
    detail: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId] as const,
    updateStatus: (companyId: string, skillId: string) =>
      ["company-skills", companyId, skillId, "update-status"] as const,
    file: (companyId: string, skillId: string, relativePath: string) =>
      ["company-skills", companyId, skillId, "file", relativePath] as const,
  },
  instanceSettings: {
    general: ["instance-settings", "general"] as const,
    experimental: ["instance-settings", "experimental"] as const,
    schedulerHeartbeats: ["instance-settings", "scheduler-heartbeats"] as const,
  },
  feedback: {
    exports: (limit: number) => ["feedback", "exports", limit] as const,
  },
  executionWorkspaces: {
    list: (companyId: string) => ["executionWorkspaces", companyId] as const,
    listForProject: (companyId: string, projectId: string) =>
      ["executionWorkspaces", companyId, projectId] as const,
    detail: (id: string) => ["executionWorkspaces", "detail", id] as const,
    runtimeServices: (id: string) =>
      ["executionWorkspaces", "detail", id, "runtime-services"] as const,
  },
  environments: {
    list: (companyId: string) => ["environments", companyId] as const,
    detail: (companyId: string, id: string) => ["environments", companyId, id] as const,
  },
  executionTargets: {
    list: (organizationId: string) => ["executionTargets", organizationId] as const,
  },
  cockpit: (companyId: string) => ["cockpit", companyId] as const,
  cockpitCounts: (companyId: string) => ["cockpit", companyId, "counts"] as const,
  plugins: {
    all: ["plugins"] as const,
    list: ["plugins", "list"] as const,
    detail: (id: string) => ["plugins", "detail", id] as const,
    config: (id: string) => ["plugins", "config", id] as const,
    uiContributions: (companyId: string) =>
      ["plugins", "ui-contributions", companyId] as const,
    health: (id: string) => ["plugins", "health", id] as const,
    dashboard: (id: string) => ["plugins", "dashboard", id] as const,
    logs: (id: string) => ["plugins", "logs", id] as const,
    examples: ["plugins", "examples"] as const,
    companyList: (companyId: string) => ["plugins", "company-list", companyId] as const,
    companySettings: (companyId: string) => ["plugins", "company-settings", companyId] as const,
  },
};

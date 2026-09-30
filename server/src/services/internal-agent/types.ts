// server/src/services/internal-agent/types.ts
import type { Db } from "@armyofagents/db";
import type { CommanderToolPermissions } from "@armyofagents/shared";
import type { HumanQuestionRuntimeCapabilities } from "@armyofagents/adapter-utils";
import type { NormalizedCommanderContextScope } from "./context-scope.js";
import type { issueService } from "../issues.js";
import type { goalService } from "../goals.js";
import type { agentService } from "../agents.js";
import type { projectService } from "../projects.js";
import type { memoryService } from "../memory.js";
import type { costService } from "../costs.js";
import type { activityService } from "../activity.js";
import type { heartbeatService } from "../heartbeat.js";
import type { suggestionService } from "../suggestions.js";
import type { artifactService } from "../artifacts.js";
import type { dependencyService } from "../dependencies.js";
import type { secretService } from "../secrets.js";
import type { notificationService } from "../notifications.js";
import type { discussionService } from "../discussions.js";
import type { threadService } from "../threads.js";
import type { taskOutputService } from "../task-outputs.js";
import type { EmbeddingService } from "../embeddings.js";
import type { approvalService } from "../approvals.js";
import type { issueApprovalService } from "../issue-approvals.js";
import type { humanContextService } from "../human-context.js";
import type { humanDiscoveryService } from "../human-discovery.js";
import type { teamService } from "../team.js";

// JSON Schema type for tool parameter definitions
export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export type ToolCategory =
  | "discussion"
  | "query"
  | "action"
  | "memory"
  | "workflow"
  | "file"
  | "coordination"
  | "analysis";

export interface ToolResult {
  success: boolean;
  data: unknown;
  summary: string;
  error?: string;
}

export interface ToolContext {
  companyId: string;
  userId: string;
  userRole: string;
  enabledCapabilities: readonly string[];   // from internal_agent_config
  /** D2: kind of the calling agent. AoA and org runtimes require an allowlist. */
  agentKind?: string;
  /** D2: explicit model-runtime tool allowlist. Absent/empty = default-deny. */
  toolAllowlist?: readonly string[];
  /**
   * Actor type driving the tool-call gate:
   *  - "commander" → Commander policy layer (permissions + runtime approval)
   *  - "agent"     → crew ('aoa') or org run; base allowlist/role/capability gate
   *  - "board"     → the bridge default when no actor is set (loopback board)
   * Only "commander" receives resolveCommanderToolPolicy; all others use the
   * base authorizeToolInvocation gate (see mcp-bridge.ts + tool-registry.ts).
   */
  actorType?: string;
  /** Calling agent's ID — exported as AOA_AGENT_ID by the runner. Absent in Commander runs. */
  agentId?: string;
  /** Resolved effective autonomy level (0/1/2). Absent → treat as 0 (fail-closed). */
  effectiveAutonomy?: number | null;
  /** Current Commander conversation id, when available. */
  conversationId?: string | null;
  /** Current internal agent run id, when available. */
  runId?: string | null;
  /** Trusted tool-boundary identity. Never accepted from model tool arguments. */
  producerInvocationId?: string | null;
  /** Trusted adapter capability; absent or invalid means ask-and-park. */
  humanQuestionCapabilities?: HumanQuestionRuntimeCapabilities;
  /** Discussion controller runs queue visible side effects until freshness commit. */
  discussionRunMode?: "direct" | "controller_action_gate" | null;
  /** Thread freshness snapshot captured when the controller/participation run started. */
  threadFreshness?: {
    startEpoch?: number;
    latestHumanSeq?: number;
    entrySeq?: number;
    latestScopeVersionId?: string | null;
    latestScopeVersionStatus?: string | null;
  } | null;
  /** Current structured Commander UI/runtime scope, when available. */
  contextScope?: NormalizedCommanderContextScope | null;
  /** Commander per-tool policy overrides from internal_agent_config. */
  commanderToolPermissions?: CommanderToolPermissions | null;
  /** Company-level switch for AoA runtime approval prompts. */
  runtimeApprovalsEnabled?: boolean;
  db: Db;
  services: ServiceContainer;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  category: ToolCategory;
  /** When set, the caller's role must be at least this level. Absent = open to all roles. */
  requiredRole?: "founder" | "team_lead" | "team_member";
  requiresConfirmation: boolean;
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ServiceContainer {
  issues: ReturnType<typeof issueService>;
  goals: ReturnType<typeof goalService>;
  agents: ReturnType<typeof agentService>;
  projects: ReturnType<typeof projectService>;
  memory: ReturnType<typeof memoryService>;
  costs: ReturnType<typeof costService>;
  activity: ReturnType<typeof activityService>;
  heartbeat: ReturnType<typeof heartbeatService>;
  suggestions: ReturnType<typeof suggestionService>;
  artifacts: ReturnType<typeof artifactService>;
  dependencies: ReturnType<typeof dependencyService>;
  secrets: ReturnType<typeof secretService>;
  notifications: ReturnType<typeof notificationService>;
  discussions: ReturnType<typeof discussionService>;
  threads: ReturnType<typeof threadService>;
  /**
   * Unified task-level product index (artifacts, detected files, preview URLs,
   * runtime services, branches, PRs). Crew result-write tools (attach_task_artifact)
   * record a row here via upsertForIssue. Company-scoped per call.
   */
  taskOutputs: ReturnType<typeof taskOutputService>;
  /** Approval workflow service — powers Commander's approval oversight tools (B2 port). */
  approvals: ReturnType<typeof approvalService>;
  /** Issue↔approval linkage — resolves which tasks an approval blocks. */
  issueApprovals: ReturnType<typeof issueApprovalService>;
  humanContext: ReturnType<typeof humanContextService>;
  humanDiscovery: ReturnType<typeof humanDiscoveryService>;
  team: ReturnType<typeof teamService>;
  companies: {
    get: (id: string) => Promise<{ name: string | null; vision: string | null; mission: string | null; issuePrefix: string | null; stage: string | null } | null>;
    update: (id: string, data: Partial<{ vision: string; mission: string }>) => Promise<{ id: string; name: string | null; vision: string | null; mission: string | null }>;
  };
  workflows: null; // Placeholder — workflow service not yet implemented
  /**
   * Optional embedding service — present when the embedding worker has been
   * started (see `startEmbeddingWorker` in embeddings-worker.ts). Tools that
   * need synchronous embedding (e.g. find_similar_threads) should check for
   * presence and fall back gracefully when absent (e.g. in tests or when the
   * worker has not been wired up yet).
   */
  embeddings?: EmbeddingService;
}

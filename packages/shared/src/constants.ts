export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/** Shared composer attachment contract. Keep UI and server validation aligned. */
export const COMPOSER_MAX_ATTACHMENTS = 5;
export const COMPOSER_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const COMPOSER_ATTACHMENT_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
] as const;

// cloud_auth = network-private controlled-beta multi-tenant cloud (Phase 1, Decision 2).
// Self-hosted local_trusted / authenticated behavior is unchanged.
export const DEPLOYMENT_MODES = ["local_trusted", "authenticated", "cloud_auth"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const AUTH_BASE_URL_MODES = ["auto", "explicit"] as const;
export type AuthBaseUrlMode = (typeof AUTH_BASE_URL_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_ADAPTER_TYPES = [
  "process",
  "http",
  "claude_local",
  "acpx_local",
  "codex_local",
  "opencode_local",
  "cursor",
  "cursor_cloud",
  "grok_local",
  "pi_local",
  "openclaw",
  "openclaw_gateway",
  "hermes_local",
  "gemini_local",
] as const;
export type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number];

// 3-tier model:
//   - cxo:     apex executive. Apex CXO (no agent parent) is the de-facto
//              "Chief of Staff" — computed live in the org-tree UI, not
//              stored. CXO agents bypass the canCreateAgents permission
//              gate and load the 4-file `cxo/` onboarding bundle.
//   - lead:    manages a team or function. Loads the 4-file `lead/`
//              onboarding bundle. Permission gate still enforced.
//   - general: individual contributor. Loads the single `default/AGENTS.md`.
//
// Constraint: a `cxo` agent can only report to a user or root (enforced
// in `services/agents.ts`). Mid-tier executives that real companies would
// call CTO/CMO/CFO map to `lead` in this model.
export const AGENT_ROLES = ["cxo", "lead", "general"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<string, string> = {
  cxo: "Executive",
  lead: "Lead",
  general: "General",
} as const;

export function displayAgentRole(role: string): string {
  return AGENT_ROLE_LABELS[role] ?? role.toUpperCase();
}

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_WORK_MODES = ["standard", "planning"] as const;
export type IssueWorkMode = (typeof ISSUE_WORK_MODES)[number];

export const ISSUE_SOURCES = ["manual", "brief", "agent_proposal", "mcp"] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];

export const AGENT_COMPLETION_POLICIES = ["review_required", "agent_can_complete"] as const;
export type AgentCompletionPolicy = (typeof AGENT_COMPLETION_POLICIES)[number];

export const AGENT_COMPLETION_POLICY_SOURCES = [
  "company",
  "department",
  "project",
  "routine",
  "workflow_template",
  "task",
  "legacy_backfill",
] as const;
export type AgentCompletionPolicySource = (typeof AGENT_COMPLETION_POLICY_SOURCES)[number];

export const ISSUE_REVIEWER_SOURCES = [
  "explicit",
  "responsible",
  "scope_lead",
  "founder",
] as const;
export type IssueReviewerSource = (typeof ISSUE_REVIEWER_SOURCES)[number];

export const GOAL_LEVELS = ["company", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "at_risk", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const PROJECT_TYPES = ["department", "project"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export const APPROVAL_TYPES = ["hire_agent", "approve_ceo_strategy", "budget_override_required", "crew_dispatch", "install_mcp_connector"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

// Types an external caller (HTTP route / MCP create-approval) may CREATE or RESUBMIT.
// `crew_dispatch` and `install_mcp_connector` are SYSTEM-INTERNAL — only their own
// service creates them (thread-agent-actions.ts for crew_dispatch; the connector
// create/install path via createConnector for install_mcp_connector), directly via
// approvalService.create() with a system-controlled payload. They must NOT be
// externally creatable/resubmittable: their approve() side-effects act on
// company-scoped ids, so a caller-controlled payload would let a scoped actor act
// out of scope. Both stay in APPROVAL_TYPES for read/list/filter (so the Approval
// contract + MCP list-approvals can represent them).
export const CREATABLE_APPROVAL_TYPES = ["hire_agent", "approve_ceo_strategy", "budget_override_required"] as const;
export type CreatableApprovalType = (typeof CREATABLE_APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const SECRET_PROVIDER_CONFIG_STATUSES = [
  "ready",
  "warning",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigStatus = (typeof SECRET_PROVIDER_CONFIG_STATUSES)[number];

export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = [
  "ready",
  "warning",
  "error",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigHealthStatus =
  (typeof SECRET_PROVIDER_CONFIG_HEALTH_STATUSES)[number];

export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export const SECRET_MANAGED_MODES = ["aoa_managed", "external_reference"] as const;
export type SecretManagedMode = (typeof SECRET_MANAGED_MODES)[number];

export const SECRET_VERSION_STATUSES = ["current", "previous", "disabled", "destroyed"] as const;
export type SecretVersionStatus = (typeof SECRET_VERSION_STATUSES)[number];

export const SECRET_BINDING_TARGET_TYPES = [
  "agent",
  "project",
  "environment",
  "routine",
  "system",
  "plugin",
  "issue",
  "run",
] as const;
export type SecretBindingTargetType = (typeof SECRET_BINDING_TARGET_TYPES)[number];

export const SECRET_ACCESS_OUTCOMES = ["success", "failure"] as const;
export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];

export const RUNTIME_PROVIDER_KEY_PROVIDERS = ["e2b"] as const;
export type RuntimeProviderKeyProvider = (typeof RUNTIME_PROVIDER_KEY_PROVIDERS)[number];

export const RUNTIME_PROVIDER_KEY_STATUSES = ["active", "disabled"] as const;
export type RuntimeProviderKeyStatus = (typeof RUNTIME_PROVIDER_KEY_STATUSES)[number];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
] as const;
export type HeartbeatInvocationSource = (typeof HEARTBEAT_INVOCATION_SOURCES)[number];

export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system"] as const;
export type WakeupTriggerDetail = (typeof WAKEUP_TRIGGER_DETAILS)[number];

export const WAKEUP_REQUEST_STATUSES = [
  "queued",
  "scheduled_retry",
  "deferred_issue_execution",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WakeupRequestStatus = (typeof WAKEUP_REQUEST_STATUSES)[number];

export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "heartbeat.run.outputs_detected",
  "agent.status",
  "activity.logged",
  // Thread chat experience Phase 5 (Task 5.6): a task's status changed —
  // company-broadcast (NOT a thread.* envelope event) so the kanban/Crew Board
  // can move the card live when a crew agent (or the founder) moves it.
  "issue.status_changed",
  // Discussions
  "discussion.entry.created",
  "discussion.extraction.completed",
  "discussion.extraction.failed",
  // Internal Agent
  "internal_agent.greeting",
  "internal_agent.reminder",
  "internal_agent.notification",
  "internal_agent.message",
  "internal_agent.run.status",
  // Budget
  "budget.policy_created",
  "budget.policy_updated",
  "budget.incident_created",
  "budget.incident_resolved",
  // Phase 6: Memory page real-time updates
  "memory.item.created",
  "memory.item.updated",
  "memory.item.moved",
  "memory.item.deleted",
  "memory.item.layer-changed",
  "memory.asset.created",
  "memory.asset.updated",
  "memory.asset.deleted",
  "memory.folder.created",
  "memory.folder.updated",
  "memory.folder.deleted",
  "memory.import.progress",
  // Marketplace install (M.2)
  "marketplace.install.started",
  "marketplace.install.completed",
  "marketplace.install.failed",
  "marketplace.install_requested",
  // Marketplace update (M.4)
  "marketplace.update.completed",
  "marketplace.update.failed",
  // Threads lifecycle
  "thread.phase.changed",
  "thread.summary.updated",
  "thread.participant.changed",
  "thread.scope.changed",
  // Threads v1 Plan 7: real-time foundations
  "thread.entry.created",
  "thread.link.created",
  "thread.presence",
  // W2 Layer 3: Inbox Hub realtime notifications
  "hub.item.changed",
  "hub.counts.changed",
  "hub.digest.changed",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const ORGANIZATION_STATUSES = ["active", "suspended", "archived"] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const ORGANIZATION_ROLES = ["owner", "admin", "member", "billing"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ORGANIZATION_INVITATION_STATUSES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export type OrganizationInvitationStatus =
  (typeof ORGANIZATION_INVITATION_STATUSES)[number];

// Sentinel Organization that owns every company on self-hosted single-tenant
// installs and every pre-existing company after the Phase 1 backfill.
export const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_ORGANIZATION_SLUG = "default";

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_ceo"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

/** How a join-request approval happened: "founder" (manual board approval) |
 *  "invite_email_match" (auto-admit — the invitation carried the approval). */
export const JOIN_REQUEST_APPROVAL_SOURCES = ["founder", "invite_email_match"] as const;
export type JoinRequestApprovalSource = (typeof JOIN_REQUEST_APPROVAL_SOURCES)[number];

export const ENVIRONMENT_DRIVERS = ["local", "ssh", "sandbox", "plugin"] as const;
export type EnvironmentDriver = (typeof ENVIRONMENT_DRIVERS)[number];

export const EXECUTION_TARGET_KINDS = [
  "pooled_gvisor",
  "dedicated_worker",
  "e2b",
  "local_host",
  "desktop",
] as const;
export type ExecutionTargetKind = (typeof EXECUTION_TARGET_KINDS)[number];

export const EXECUTION_TARGET_TRUST_CLASSES = [
  "shared_multitenant",
  "dedicated_tenant",
  "local_trusted",
] as const;
export type ExecutionTargetTrustClass = (typeof EXECUTION_TARGET_TRUST_CLASSES)[number];

export const EXECUTION_TARGET_STATUSES = ["active", "draining", "offline", "disabled"] as const;
export type ExecutionTargetStatus = (typeof EXECUTION_TARGET_STATUSES)[number];

// Per-Organization concurrency clamp — mirrors HEARTBEAT_MAX_CONCURRENT_RUNS_*.
export const ORG_MAX_CONCURRENT_RUNS_DEFAULT = 8;
export const ORG_MAX_CONCURRENT_RUNS_MAX = 200;

export const ENVIRONMENT_STATUSES = ["active", "archived"] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

// "paused" (Wave 6 / U7.1) = an E2B snapshot held for warm resume. `releasedAt`
// stays NULL while paused so the warm lookup + idle reaper (keyed off status)
// can still find the row — distinct from the pre-existing `retained`, which is
// a terminal "don't reap" marker, not a resumable snapshot.
export const ENVIRONMENT_LEASE_STATUSES = ["active", "released", "expired", "failed", "retained", "paused"] as const;
export type EnvironmentLeaseStatus = (typeof ENVIRONMENT_LEASE_STATUSES)[number];

export const ENVIRONMENT_LEASE_POLICIES = [
  "ephemeral",
  "reuse_by_workspace",
  "reuse_by_environment",
  "reuse_by_agent",
] as const;
export type EnvironmentLeasePolicy = (typeof ENVIRONMENT_LEASE_POLICIES)[number];

export const ENVIRONMENT_LEASE_CLEANUP_STATUSES = ["pending", "success", "failed"] as const;
export type EnvironmentLeaseCleanupStatus = (typeof ENVIRONMENT_LEASE_CLEANUP_STATUSES)[number];

export const MEMORY_ITEM_CATEGORIES = [
  "decision",
  "reference",
  "context",
  "insight",
  "preference",
  "procedure",
  "policy",
] as const;
export type MemoryItemCategory = (typeof MEMORY_ITEM_CATEGORIES)[number];

// Relations between memory items (graph edges).
export const MEMORY_RELATION_KINDS = [
  "supersedes",
  "related_to",
  "applies_to",
  "conflicts_with",
  "derived_from",
] as const;
export type MemoryRelationKind = (typeof MEMORY_RELATION_KINDS)[number];

export const COMPANY_BRAIN_NODE_TYPES = [
  "company",
  "department",
  "project",
  "team",
  "human",
  "agent",
  "goal",
  "task",
  "discussion",
  "discussion_entry",
  "memory_item",
  "memory_folder",
  "memory_asset",
  "artifact",
] as const;
export type CompanyBrainNodeType = (typeof COMPANY_BRAIN_NODE_TYPES)[number];

export const COMPANY_BRAIN_EDGE_KINDS = [
  "belongs_to",
  "member_of",
  "participates_in",
  "owns",
  "owned_by",
  "created_by",
  "assigned_to",
  "blocks",
  "mentioned_in",
  "extracted_from",
  "derived_from",
  "retrieved_by",
  "used_by",
  "applies_to",
  "related_to",
  "supports",
  "conflicts_with",
  "supersedes",
  "duplicate_of",
] as const;
export type CompanyBrainEdgeKind = (typeof COMPANY_BRAIN_EDGE_KINDS)[number];

export const COMPANY_BRAIN_EDGE_SOURCE_CLASSES = [
  "derived",
  "aggregated",
  "semantic",
] as const;
export type CompanyBrainEdgeSourceClass = (typeof COMPANY_BRAIN_EDGE_SOURCE_CLASSES)[number];

export const COMPANY_BRAIN_EDGE_EDITABILITY = [
  "source_row_only",
  "append_only",
  "editable",
] as const;
export type CompanyBrainEdgeEditability = (typeof COMPANY_BRAIN_EDGE_EDITABILITY)[number];

export const COMPANY_BRAIN_DERIVED_EDGE_KINDS = [
  "belongs_to",
  "member_of",
  "participates_in",
  "owns",
  "owned_by",
  "created_by",
  "assigned_to",
  "blocks",
] as const satisfies readonly CompanyBrainEdgeKind[];

export const COMPANY_BRAIN_APPEND_ONLY_EDGE_KINDS = [
  "mentioned_in",
  "extracted_from",
  "derived_from",
  "retrieved_by",
  "used_by",
] as const satisfies readonly CompanyBrainEdgeKind[];

export const COMPANY_BRAIN_EDITABLE_EDGE_KINDS = [
  "applies_to",
  "related_to",
  "supports",
  "conflicts_with",
  "supersedes",
  "duplicate_of",
] as const satisfies readonly CompanyBrainEdgeKind[];

export const COMPANY_BRAIN_EDGE_EDITABILITY_BY_KIND = {
  belongs_to: "source_row_only",
  member_of: "source_row_only",
  participates_in: "source_row_only",
  owns: "source_row_only",
  owned_by: "source_row_only",
  created_by: "source_row_only",
  assigned_to: "source_row_only",
  blocks: "source_row_only",
  mentioned_in: "append_only",
  extracted_from: "append_only",
  derived_from: "append_only",
  retrieved_by: "append_only",
  used_by: "append_only",
  applies_to: "editable",
  related_to: "editable",
  supports: "editable",
  conflicts_with: "editable",
  supersedes: "editable",
  duplicate_of: "editable",
} as const satisfies Record<CompanyBrainEdgeKind, CompanyBrainEdgeEditability>;

// Per-call retrieval audit triggers.
export const MEMORY_RETRIEVAL_TRIGGERS = [
  "auto",                  // pre-run injection at heartbeat start
  "agent_search",          // worker agent called memory.search
  "agent_get",             // worker agent called memory.get
  "skill_materialize",     // pinned-item skill synthesis
  "commander_query",       // commander tool query
  "commander_context",     // automatic Commander prompt recall
] as const;
export type MemoryRetrievalTrigger = (typeof MEMORY_RETRIEVAL_TRIGGERS)[number];

// Extraction pipeline input types.
export const MEMORY_EXTRACTION_INPUT_TYPES = [
  "text",
  "pdf",
  "docx",
  "url",
  "audio",
  "image",
  "video",
] as const;
export type MemoryExtractionInputType = (typeof MEMORY_EXTRACTION_INPUT_TYPES)[number];

// Extraction job status.
export const MEMORY_EXTRACTION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type MemoryExtractionStatus = (typeof MEMORY_EXTRACTION_STATUSES)[number];

// Extraction batch status (groups multi-file uploads).
export const MEMORY_EXTRACTION_BATCH_STATUSES = [
  "queued",
  "running",
  "completed",
  "cancelled",
] as const;
export type MemoryExtractionBatchStatus = (typeof MEMORY_EXTRACTION_BATCH_STATUSES)[number];

// MCP actor types: controls which tools an actor can call.
//   "board"     — founder session (existing)
//   "agent"     — worker agent CLI subprocess (new)
//   "commander" — internal-agent + sub-agents (new, when commander goes CLI)
//   "mcp"       — external MCP API key (existing)
export const MCP_ACTOR_TYPES = ["board", "agent", "commander", "mcp"] as const;
export type McpActorType = (typeof MCP_ACTOR_TYPES)[number];

// Per-agent memory profile: controls scope filtering and skill materialization.
// Stored under agent.runtimeConfig.memoryProfile. See memoryProfileSchema in validators/memory.ts.
export const MEMORY_RECALL_BUDGETS = ["low", "mid", "high"] as const;
export type MemoryRecallBudget = (typeof MEMORY_RECALL_BUDGETS)[number];

export const MEMORY_RECALL_BUDGET_LIMITS: Record<MemoryRecallBudget, number> = {
  low: 3,
  mid: 10,
  high: 25,
};

export const MEMORY_SCOPE_FILTERS = ["self", "department", "all"] as const;
export type MemoryScopeFilter = (typeof MEMORY_SCOPE_FILTERS)[number];

// Future-reserved write capability scopes (curator-class agents).
export const MEMORY_WRITE_SCOPES = ["department", "task_chain", "active_context"] as const;
export type MemoryWriteScope = (typeof MEMORY_WRITE_SCOPES)[number];

export const MEMORY_ITEM_SOURCES = [
  "brief",
  "founder",
  "agent",
  "commander",
  "mcp",
  "document",
] as const;
export type MemoryItemSource = (typeof MEMORY_ITEM_SOURCES)[number];

export const MEMORY_ITEM_STATUSES = [
  "draft",
  "pending",
  "approved",
  "archived",
  "rejected",
] as const;
export type MemoryItemStatus = (typeof MEMORY_ITEM_STATUSES)[number];

export const MEMORY_ITEM_LAYERS = [
  "identity",
  "domain",
  "active_context",
  "working",
] as const;
export type MemoryItemLayer = (typeof MEMORY_ITEM_LAYERS)[number];

export const MEMORY_ITEM_VISIBILITY = ["scoped", "shared"] as const;
export type MemoryItemVisibility = (typeof MEMORY_ITEM_VISIBILITY)[number];

export const DEBRIEF_INPUT_TYPES = ["paste", "write", "mcp", "voice"] as const;
export type DebriefInputType = (typeof DEBRIEF_INPUT_TYPES)[number];

export const DEBRIEF_STATUSES = [
  "processing",
  "processing_failed",
  "ready",
  "archived",
] as const;
export type DebriefStatus = (typeof DEBRIEF_STATUSES)[number];

export const BRIEF_STATUSES = [
  "draft",
  "ready",
  "reviewed",
  "approved",
  "rejected",
  "partially_approved",
] as const;
export type BriefStatus = (typeof BRIEF_STATUSES)[number];

export const BRIEF_ITEM_TYPES = [
  "decision",
  "task",
  "insight",
  "context",
  "reference",
  "preference",
  "artifact",
  "spin_off_thread",
] as const;
export type BriefItemType = (typeof BRIEF_ITEM_TYPES)[number];

export const BRIEF_ITEM_STATUSES = ["pending", "approved", "rejected", "edited"] as const;
export type BriefItemStatus = (typeof BRIEF_ITEM_STATUSES)[number];

export const BRIEF_DEDUP_ACTIONS = [
  "update_existing",
  "create_separate",
  "replace",
] as const;
export type BriefDedupAction = (typeof BRIEF_DEDUP_ACTIONS)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:assign_scope",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// ── RBAC ───────────────────────────────────────────────────────────

export const USER_ROLES = ["founder", "team_lead", "team_member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Single source of truth for role rank comparisons.
// founder > team_lead > team_member. Unknown roles map to 0 (below team_member).
export const ROLE_RANK: Record<string, number> = {
  founder: 3,
  team_lead: 2,
  team_member: 1,
};

export function roleAtLeast(userRole: string, required: string): boolean {
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

// ── Artifacts ──────────────────────────────────────────────────────

export const ARTIFACT_TYPES = [
  "document",
  "presentation",
  "code",
  "design",
  "report",
  "other",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = ["draft", "active", "archived"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const ARTIFACT_VERSION_SOURCES = [
  "agent",
  "founder",
  "mcp",
  "teammate",
  "external",
] as const;
export type ArtifactVersionSource = (typeof ARTIFACT_VERSION_SOURCES)[number];

export const ARTIFACT_STORAGE_KINDS = ["inline", "asset"] as const;
export type ArtifactStorageKind = (typeof ARTIFACT_STORAGE_KINDS)[number];

// ── Suggestions ────────────────────────────────────────────────────

export const SUGGESTION_CATEGORIES = [
  "goal_gap",
  "pipeline_bottleneck",
  "memory_gap",
  "pattern_detected",
  "budget_optimization",
  "recurring_work",
  "risk_flag",
  "workload_balance",
  "agent_proposal",
] as const;
export type SuggestionCategory = (typeof SUGGESTION_CATEGORIES)[number];

export const SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "dismissed",
  "expired",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const SUGGESTION_ACTION_TYPES = [
  "create_task",
  "flag_risk",
  "suggest_memory",
  "archive_memory",
  "merge_memory",
  "adjust_budget",
  "rebalance_workload",
  "create_goal",
] as const;
export type SuggestionActionType = (typeof SUGGESTION_ACTION_TYPES)[number];

// ── Memory Feedback Patterns ────────────────────────────────────────

export const MEMORY_FEEDBACK_PATTERN_TYPES = [
  "tone_correction",
  "format_change",
  "content_addition",
  "content_removal",
  "structure_change",
  "terminology_change",
] as const;
export type MemoryFeedbackPatternType = (typeof MEMORY_FEEDBACK_PATTERN_TYPES)[number];

export const MEMORY_FEEDBACK_PATTERN_STATUSES = [
  "detected",
  "suggested",
  "accepted",
  "dismissed",
] as const;
export type MemoryFeedbackPatternStatus = (typeof MEMORY_FEEDBACK_PATTERN_STATUSES)[number];

// ── Detected Output Statuses ────────────────────────────────────────

export const DETECTED_OUTPUT_STATUSES = ["pending", "confirmed", "dismissed"] as const;
export type DetectedOutputStatus = (typeof DETECTED_OUTPUT_STATUSES)[number];

export const DETECTED_OUTPUT_SOURCES = ["diff", "hint", "both"] as const;
export type DetectedOutputSource = (typeof DETECTED_OUTPUT_SOURCES)[number];

// ── Memory Item Versions ────────────────────────────────────────────

export const MEMORY_ITEM_VERSION_STATUSES = [
  "draft",
  "pending",
  "approved",
  "archived",
  "rejected",
] as const;
export type MemoryItemVersionStatus = (typeof MEMORY_ITEM_VERSION_STATUSES)[number];

export const SEARCH_ENTITY_TYPES = [
  "tasks",
  "goals",
  "agents",
  "memory",
] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

// ── Discussions ─────────────────────────────────────────────────

export const DISCUSSION_STATUSES = ["active", "archived"] as const;
export type DiscussionStatus = (typeof DISCUSSION_STATUSES)[number];

export const DISCUSSION_SCOPE_TYPES = ["department", "project", "goal"] as const;
export type DiscussionScopeType = (typeof DISCUSSION_SCOPE_TYPES)[number];

// "write" kept for backward compat with existing entries — UI now uses "paste" for both paste and write.
// Phase 1 (Task A3): added "scope_proposal" (Adjutant posts a structured proposal
// entry with a JSON payload of summary + proposedTasks; UI renders a special
// card with CTAs) and "system" (used for crew/agent failure messages with retry
// affordances; UI renders with a warning icon). The previously aliased
// DISCUSSION_ENTRY_INPUT_TYPES_V2 export in packages/shared/src/api/threads-contract.ts
// was dropped in this task — consumers should import this canonical constant.
export const DISCUSSION_ENTRY_INPUT_TYPES = [
  "paste",
  "write",
  "voice",
  "mcp",
  "transcript",
  "document",
  "routine",
  "webhook",
  "integration",
  "agent",
  // Phase 1 additions:
  "scope_proposal",
  "system",
] as const;
export type DiscussionEntryInputType = (typeof DISCUSSION_ENTRY_INPUT_TYPES)[number];

export const EXTRACTION_STATUSES = ["pending", "processing", "completed", "failed", "skipped"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_ITEM_TYPES = ["decision", "task", "insight", "context", "reference", "preference", "artifact", "spin_off_thread"] as const;
export type ExtractionItemType = (typeof EXTRACTION_ITEM_TYPES)[number];

export const EXTRACTION_ITEM_STATUSES = ["pending", "approved", "rejected", "edited"] as const;
export type ExtractionItemStatus = (typeof EXTRACTION_ITEM_STATUSES)[number];

// ── Threads (extends Discussions) ───────────────────────────────────────

export const THREAD_ORIGIN_SOURCES = ["human", "agent", "external", "system"] as const;
export type ThreadOriginSource = (typeof THREAD_ORIGIN_SOURCES)[number];

export const THREAD_ORIGIN_MEDIA = ["text", "voice", "transcription", "file", "api", "scheduled", "integration"] as const;
export type ThreadOriginMedium = (typeof THREAD_ORIGIN_MEDIA)[number];

export const THREAD_INTENTS = ["planning", "review", "decision", "research", "problem", "alignment", "feedback", "retrospective"] as const;
export type ThreadIntent = (typeof THREAD_INTENTS)[number];

export const THREAD_PHASES = ["discuss", "scope", "assign", "done"] as const;
export type ThreadPhase = (typeof THREAD_PHASES)[number];

export const THREAD_SCOPE_VERSION_STATUSES = [
  "draft",
  "accepted",
  "superseded",
  "completed",
  "rejected",
] as const;
export type ThreadScopeVersionStatus = (typeof THREAD_SCOPE_VERSION_STATUSES)[number];

export const THREAD_SCOPE_ITEM_KINDS = [
  "task_proposal",
  "task_change",
  "memory_candidate",
  "artifact_link",
  "decision",
  "assumption",
  "open_question",
  "source_signal",
] as const;
export type ThreadScopeItemKind = (typeof THREAD_SCOPE_ITEM_KINDS)[number];

export const THREAD_SCOPE_ITEM_STATUSES = ["draft", "accepted", "applied", "rejected"] as const;
export type ThreadScopeItemStatus = (typeof THREAD_SCOPE_ITEM_STATUSES)[number];

export const THREAD_AGENT_ACTION_TYPES = [
  "post_reply",
  "create_scope_draft",
  "update_scope_draft",
  "add_scope_item",
  "create_scope_output",
  "convene_agent",
  "create_artifact_candidate",
  "advance_phase",
  "request_thread_workspace",
] as const;
export type ThreadAgentActionType = (typeof THREAD_AGENT_ACTION_TYPES)[number];

export const THREAD_AGENT_ACTION_STATUSES = [
  "proposed", // produced mid-run, NOT yet committable (Decision #99 producer gate)
  "ready", // sealed: the producing run SUCCEEDED — the relay drains only this status
  "committing", // a committer won the fenced CAS claim and is applying the side-effect
  "committed", // side-effect applied
  "suppressed_stale", // the world moved between propose and commit (freshness gate)
  "blocked_policy", // terminal: a failed/orphaned producer's row can never commit
  "failed", // post-gate retryable failure (bounded by attempt_count)
] as const;
export type ThreadAgentActionStatus = (typeof THREAD_AGENT_ACTION_STATUSES)[number];

export const THREAD_DERIVED_STAGES = [
  "live",
  "discussing",
  "scoping",
  "scoped",
  "assigned",
  "complete",
  "archived",
] as const;
export type ThreadDerivedStage = (typeof THREAD_DERIVED_STAGES)[number];

// Phase 1 (Task A2): canonicalized from legacy ["open", "private"] to the
// 3-tier model used across the new thread coordination contract. Existing
// rows defaulting to "open" are migrated to "company" (open ≈ everyone with
// scope access, which is what the new "company" tier expresses). The
// previously aliased THREAD_VISIBILITIES_V2 / ThreadVisibilityV2 exports in
// packages/shared/src/api/threads-contract.ts were dropped as redundant.
export const THREAD_VISIBILITIES = ["private", "department", "company"] as const;
export type ThreadVisibility = (typeof THREAD_VISIBILITIES)[number];

export const THREAD_SUBTYPES = ["normal", "live"] as const;
export type ThreadSubtype = (typeof THREAD_SUBTYPES)[number];

export const THREAD_PARTICIPANT_PRINCIPAL_TYPES = ["user", "agent"] as const;
export type ThreadParticipantPrincipalType = (typeof THREAD_PARTICIPANT_PRINCIPAL_TYPES)[number];

export const THREAD_PARTICIPANT_ROLES = ["owner", "co_owner", "collaborator", "viewer", "worker"] as const;
export type ThreadParticipantRole = (typeof THREAD_PARTICIPANT_ROLES)[number];

export const THREAD_LINK_KINDS = ["link", "spinoff", "fork", "merge", "goal_cluster", "spawned_from_task"] as const;
export type ThreadLinkKind = (typeof THREAD_LINK_KINDS)[number];

export const THREAD_ROUTER_DECISIONS = ["auto_attach", "suggest", "human"] as const;
export type ThreadRouterDecision = (typeof THREAD_ROUTER_DECISIONS)[number];

export const THREAD_INBOX_STATUSES = ["pending", "attached", "dismissed"] as const;
export type ThreadInboxStatus = (typeof THREAD_INBOX_STATUSES)[number];

// ── Internal Agent ──────────────────────────────────────────────

export const AGENT_CAPABILITIES = [
  "discussion_processing",
  "proactive_suggestions",
  "organizational_queries",
  "system_actions",
  "context_briefing",
  "memory_management",
  "conflict_detection",
  "budget_awareness",
  "workflow_coaching",
  "workflow_discovery",
  "cross_department_coordination",
  "department_personas",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const AGENT_EXECUTION_MODES = ["api", "cli"] as const;
export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

// NOTE: opencode is a first-class crew provider (resolveCrewAdapterFor handles it).
// AGENT_MODELS_BY_PROVIDER below is dead/unused (no live consumer) — do not extend it.
export const AGENT_PROVIDERS = ["anthropic", "openai", "google", "opencode"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_MODELS_BY_PROVIDER: Partial<Record<AgentProvider, { value: string; label: string }[]>> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o" },
    { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  ],
  google: [
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

export const CLI_TOOLS = [
  { value: "claude_cli", label: "Claude CLI" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
] as const;

export const NOTIFICATION_PREFERENCES = ["silent", "digest", "realtime"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export const NOTIFICATION_DIGEST_CADENCES = ["daily"] as const;
export type NotificationDigestCadence = (typeof NOTIFICATION_DIGEST_CADENCES)[number];

export const TRIGGER_TYPES = ["conversation", "proactive", "event", "sub_agent"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const TRIGGER_SOURCES = [
  "user_message",
  "discussion_entry",
  "proactive_scan",
  "event_hook",
  "reminder_fire",
  "sub_agent_dispatch",
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const IA_RUN_STATUSES = ["running", "completed", "failed"] as const;
export type IaRunStatus = (typeof IA_RUN_STATUSES)[number];

export const IA_MESSAGE_ROLES = ["user", "assistant", "system", "tool_call", "tool_result"] as const;
export type IaMessageRole = (typeof IA_MESSAGE_ROLES)[number];

export const IA_CONVERSATION_STATUSES = ["active", "archived"] as const;
export type IaConversationStatus = (typeof IA_CONVERSATION_STATUSES)[number];

export const REMINDER_STATUSES = ["pending", "fired", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

// ── Commander Tool Permissions ─────────────────────────────────────

export interface CommanderToolPermission {
  enabled: boolean;            // whether the tool is available to Commander at all
  requireConfirmation: boolean; // force confirmation even if tool.requiresConfirmation is false
  minimumRole: "founder" | "team_lead" | "team_member"; // minimum human role needed to trigger via Commander
}

export type CommanderToolPermissions = Record<string, CommanderToolPermission>;

export const COMMANDER_TOOL_PERMISSION_DEFAULT: CommanderToolPermission = {
  enabled: true,
  requireConfirmation: false,
  minimumRole: "team_member",
};

export const COMMANDER_RUNTIME_APPROVAL_STATUSES = [
  "pending",
  "executing",
  "approved",
  "denied",
  "expired",
  "failed",
  "cancelled",
] as const;
export type CommanderRuntimeApprovalStatus =
  (typeof COMMANDER_RUNTIME_APPROVAL_STATUSES)[number];

export const COMMANDER_RUNTIME_APPROVAL_DECISIONS = [
  "allow_once",
  "allow_always",
  "deny",
] as const;
export type CommanderRuntimeApprovalDecision =
  (typeof COMMANDER_RUNTIME_APPROVAL_DECISIONS)[number];

export const COMMANDER_TOOL_TRUST_SCOPES = ["exact_params"] as const;
export type CommanderToolTrustScope = (typeof COMMANDER_TOOL_TRUST_SCOPES)[number];

export const NOTIFICATION_TYPES = [
  "discussion.extraction_complete",
  "discussion.extraction_failed",
  "internal_agent.reminder",
  "internal_agent.proactive",
  "internal_agent.action_result",
  // U13.6 (cloud execution isolation) — raised by agent-loop.ts when
  // Commander's post-turn history compaction (`summarizeViaCli`) throws on
  // `cloud_auth`. Compaction stays best-effort (never fails the turn); this
  // is the founder-visible signal that was previously silently dropped (R3).
  "internal_agent.compaction_failed",
  "marketplace.install_completed",
  "marketplace.install_failed",
  "marketplace.install_requested",
  "marketplace.update_available",
  "marketplace.update_completed",
  "marketplace.update_failed",
  "thread.mention",
  // Phase 1 Phase E batch 3 (T23): new thread-coordination notifications
  // surfaced in Inbox. Backing payload still lives on the existing
  // notifications row shape (title/message/relatedEntityType/relatedEntityId).
  // NOTE: thread.scope_proposal_posted + thread.human_input_needed were REMOVED
  // (Task 10, 2026-07-04) alongside their pruned hub semantic types — both had
  // zero writers; the events never fired. Do NOT re-add without a real producer.
  "thread.artifact_needs_review",
  "thread.crew_failed",
  "thread.spinoff_suggested",
  "work_question.sla_breached",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// ── Company skills ────────────────────────────────────────────────────

/**
 * Machine-readable code on the 409 returned when installing/updating a skill
 * would discard founder edits (`company_skills.customized`). Shared by the
 * catalog apply path and the github/url install path so clients only have to
 * recognise one value.
 */
export const SKILL_CUSTOMIZED_ERROR_CODE = "SKILL_CUSTOMIZED";

/**
 * Machine-readable code on the 409 returned when creating a company skill
 * whose canonical key is already claimed. This is intentionally distinct from
 * `SKILL_CUSTOMIZED`: the caller chose a taken name, rather than attempting an
 * upstream update that would discard edits.
 */
export const SKILL_NAME_TAKEN_ERROR_CODE = "SKILL_NAME_TAKEN";

// ── Routines ──────────────────────────────────────────────────────────

export const RUN_LIVENESS_STATES = ["unknown", "advanced", "completed", "blocked", "needs_followup", "stalled"] as const;
export type RunLivenessState = (typeof RUN_LIVENESS_STATES)[number];

export const ISSUE_MONITOR_STATUSES = ["scheduled", "triggered", "cleared", "cancelled"] as const;
export type IssueMonitorStatus = (typeof ISSUE_MONITOR_STATUSES)[number];

export const ISSUE_MONITOR_CLEAR_REASONS = [
  "manual",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;
export type IssueMonitorClearReason = (typeof ISSUE_MONITOR_CLEAR_REASONS)[number];

export const ISSUE_ORIGIN_KINDS = [
  "routine_execution",
  "issue_productivity_review",
  "issue_continuation",
  "successful_run_handoff",
] as const;
export type IssueOriginKind = (typeof ISSUE_ORIGIN_KINDS)[number];

export const RECOVERY_ORIGIN_KINDS = {
  issueProductivityReview: "issue_productivity_review",
  issueContinuation: "issue_continuation",
  successfulRunHandoff: "successful_run_handoff",
} as const satisfies Record<string, IssueOriginKind>;

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const ROUTINE_CONCURRENCY_POLICIES = [
  "coalesce_if_active",
  "always_enqueue",
  "skip_if_active",
] as const;
export type RoutineConcurrencyPolicy = (typeof ROUTINE_CONCURRENCY_POLICIES)[number];

export const ROUTINE_CATCH_UP_POLICIES = [
  "skip_missed",
  "enqueue_missed_with_cap",
] as const;
export type RoutineCatchUpPolicy = (typeof ROUTINE_CATCH_UP_POLICIES)[number];

export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256"] as const;
export type RoutineTriggerSigningMode = (typeof ROUTINE_TRIGGER_SIGNING_MODES)[number];

export const ROUTINE_RUN_STATUSES = [
  "received",
  "issue_created",
  "coalesced",
  "skipped",
  "completed",
  "failed",
] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
export type RoutineRunSource = (typeof ROUTINE_RUN_SOURCES)[number];

export const ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select"] as const;
export type RoutineVariableType = (typeof ROUTINE_VARIABLE_TYPES)[number];

// ---------------------------------------------------------------------------
// Plugin system constants
// ---------------------------------------------------------------------------

export const PLUGIN_API_VERSION = 1 as const;

export const PLUGIN_STATUSES = [
  "installed",
  "ready",
  "disabled",
  "error",
  "upgrade_pending",
  "uninstalled",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** Stable, machine-readable reasons for a plugin lifecycle status. */
export const PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON =
  "PLUGIN_WORKER_BLOCKED_IN_CLOUD" as const;
export const PLUGIN_STATUS_REASON_CODES = [
  PLUGIN_WORKER_BLOCKED_IN_CLOUD_REASON,
] as const;
export type PluginStatusReasonCode =
  (typeof PLUGIN_STATUS_REASON_CODES)[number];

export const PLUGIN_CATEGORIES = [
  "connector",
  "ui",
  "automation",
  "workspace",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

export const PLUGIN_CAPABILITIES = [
  // Data read
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "issues.read",
  "issue.comments.read",
  "issue.documents.read",
  "agents.read",
  "goals.read",
  "activity.read",
  "costs.read",
  // Data write
  "issues.create",
  "issues.update",
  "issue.comments.create",
  "issue.documents.write",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  // Plugin state
  "plugin.state.read",
  "plugin.state.write",
  // Integration
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "http.outbound",
  "secrets.read-ref",
  // Agent tools
  "agent.tools.register",
  // Agent control
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  // Goals
  "goals.create",
  "goals.update",
  // UI
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.commentAnnotation.register",
  "ui.action.register",
  // Instance
  "instance.settings.register",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_TRUST_TIERS = ["untrusted", "verified", "core"] as const;
export type PluginTrustTier = (typeof PLUGIN_TRUST_TIERS)[number];

export const CAPABILITY_DESCRIPTIONS: Record<PluginCapability, string> = {
  // Data read
  "companies.read":             "Read your organization's company profile",
  "projects.read":              "Read departments and projects",
  "project.workspaces.read":    "Read workspace data for software projects",
  "issues.read":                "Read tasks and issues",
  "issue.comments.read":        "Read comments on tasks",
  "issue.documents.read":       "Read documents and attachments on tasks",
  "agents.read":                "Read agent profiles and configuration",
  "goals.read":                 "Read goals and their status",
  "activity.read":              "Read the activity history log",
  "costs.read":                 "Read budget and cost records",
  // Data write
  "issues.create":              "Create new tasks on your behalf",
  "issues.update":              "Update existing tasks on your behalf",
  "issue.comments.create":      "Post comments on tasks",
  "issue.documents.write":      "Write documents and attachments to tasks",
  "activity.log.write":         "Write entries to the activity log",
  "metrics.write":              "Record custom performance metrics",
  "telemetry.track":            "Send anonymous usage events to the plugin developer",
  // Plugin state
  "plugin.state.read":          "Read this plugin's private persistent data",
  "plugin.state.write":         "Write to this plugin's private persistent data",
  // Integration
  "events.subscribe":           "Listen to system events (task updates, agent completions, etc.)",
  "events.emit":                "Broadcast custom events to other installed plugins",
  "jobs.schedule":              "Schedule recurring background jobs",
  "webhooks.receive":           "Receive inbound webhooks from external services",
  "http.outbound":              "Make outbound HTTP requests to external URLs",
  "secrets.read-ref":           "Read references to secrets stored in the vault (values never exposed)",
  // Agent tools
  "agent.tools.register":       "Register custom tools that your agents can call",
  // Agent control
  "agents.pause":               "Pause running agents",
  "agents.resume":              "Resume paused agents",
  "agents.invoke":              "Invoke agents programmatically",
  "agent.sessions.create":      "Create new agent chat sessions",
  "agent.sessions.list":        "List existing agent sessions",
  "agent.sessions.send":        "Send messages into agent sessions",
  "agent.sessions.close":       "Close agent sessions",
  // Goals
  "goals.create":               "Create new goals",
  "goals.update":               "Update existing goals",
  // UI
  "ui.sidebar.register":        "Add navigation items to the sidebar",
  "ui.page.register":           "Register custom full-page views in the app",
  "ui.detailTab.register":      "Add tabs to task or entity detail panels",
  "ui.dashboardWidget.register":"Add widgets to the Home dashboard",
  "ui.commentAnnotation.register":"Add inline annotations inside comments",
  "ui.action.register":         "Register contextual action buttons",
  // Instance
  "instance.settings.register": "Add configuration panels to Instance Settings",
};

export const PLUGIN_UI_SLOT_TYPES = [
  "sidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
] as const;
export type PluginUiSlotType = (typeof PLUGIN_UI_SLOT_TYPES)[number];

export const PLUGIN_UI_SLOT_ENTITY_TYPES = [
  "project",
  "issue",
  "comment",
] as const;
export type PluginUiSlotEntityType = (typeof PLUGIN_UI_SLOT_ENTITY_TYPES)[number];

export const PLUGIN_STATE_SCOPE_KINDS = [
  "instance",
  "company",
  "project",
  "issue",
] as const;
export type PluginStateScopeKind = (typeof PLUGIN_STATE_SCOPE_KINDS)[number];

export const PLUGIN_LAUNCHER_PLACEMENT_ZONES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
] as const;
export type PluginLauncherPlacementZone = (typeof PLUGIN_LAUNCHER_PLACEMENT_ZONES)[number];

export const PLUGIN_LAUNCHER_ACTIONS = [
  "navigate",
  "deepLink",
  "performAction",
  "openModal",
  "openDrawer",
  "openPopover",
] as const;
export type PluginLauncherAction = (typeof PLUGIN_LAUNCHER_ACTIONS)[number];

export const PLUGIN_LAUNCHER_BOUNDS = [
  "default",
  "compact",
  "wide",
  "full",
  "inline",
] as const;
export type PluginLauncherBounds = (typeof PLUGIN_LAUNCHER_BOUNDS)[number];

export const PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS = [
  "hostOverlay",
  "iframe",
] as const;
export type PluginLauncherRenderEnvironment = (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number];

export const PLUGIN_EVENT_TYPES = [
  "issue.created",
  "issue.updated",
  "issue.deleted",
  "project.created",
  "project.updated",
  "project.deleted",
  "agent.created",
  "agent.updated",
  "agent.run.started",
  "agent.run.completed",
  "goal.created",
  "goal.updated",
  "goal.deleted",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

export const PLUGIN_JOB_STATUSES = ["active", "paused", "failed"] as const;
export type PluginJobStatus = (typeof PLUGIN_JOB_STATUSES)[number];

export const PLUGIN_JOB_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PluginJobRunStatus = (typeof PLUGIN_JOB_RUN_STATUSES)[number];

export const PLUGIN_JOB_RUN_TRIGGERS = ["schedule", "manual", "retry"] as const;
export type PluginJobRunTrigger = (typeof PLUGIN_JOB_RUN_TRIGGERS)[number];

export const PLUGIN_WEBHOOK_DELIVERY_STATUSES = ["pending", "success", "failed"] as const;
export type PluginWebhookDeliveryStatus = (typeof PLUGIN_WEBHOOK_DELIVERY_STATUSES)[number];

export const PLUGIN_BRIDGE_ERROR_CODES = [
  "WORKER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "TIMEOUT",
  "WORKER_ERROR",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "UNKNOWN",
] as const;
export type PluginBridgeErrorCode = (typeof PLUGIN_BRIDGE_ERROR_CODES)[number];

/**
 * Department function types — the single source of truth consumed by both the
 * onboarding "First department" step and NewProjectDialog (Stage C / C9).
 * `software_development` is the workspace-tooling gate value. Adds `sales`;
 * `support` is labeled "Customer Support".
 */
export const DEPARTMENT_FUNCTION_TYPES = [
  { value: "software_development", label: "Product (Software)", icon: "💻" },
  { value: "marketing", label: "Marketing", icon: "📢" },
  { value: "sales", label: "Sales", icon: "🤝" },
  { value: "support", label: "Customer Support", icon: "🎧" },
  { value: "finance", label: "Finance", icon: "💰" },
  { value: "hr", label: "HR", icon: "👥" },
  { value: "legal", label: "Legal", icon: "⚖️" },
  { value: "research", label: "Research", icon: "🔬" },
  { value: "operations", label: "Operations", icon: "📊" },
  { value: "general", label: "General", icon: "📋" },
  { value: "custom", label: "Custom", icon: "⚙️" },
] as const;
export type DepartmentFunctionType = (typeof DEPARTMENT_FUNCTION_TYPES)[number]["value"];
